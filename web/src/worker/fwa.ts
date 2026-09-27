/// FWA (fwa.fun) on Ethereum mainnet, read-only:
///   - FWAMarketplace: fixed-price Credits listings, a second Buy Credits source next to OpenSea.
///   - An FWA pool (FWAClone): pay a price, a Chainlink VRF draw sends one random NFT from the pool.
/// Nothing here signs or sends. Self-contained (viem only) so it can be exercised from a plain node script.
import { decodeEventLog, encodeFunctionData, parseAbi, type Address, type Hash, type PublicClient } from 'viem';

export const fwaMarketAbi = parseAbi([
  'function listingCount(address collection) view returns (uint256)',
  'struct Listing { address seller; uint64 createdBlock; address collection; uint96 price; uint256 tokenId; address royaltyRecipient; uint96 royaltyAmount; }',
  'function getListing(uint256 listingId) view returns (Listing)',
  'function nextListingId() view returns (uint64)',
]);

/// The parts of FWAClone the Spin page reads, plus the two calls a buyer makes.
export const fwaPoolAbi = parseAbi([
  'function activeListingCount() view returns (uint256)',
  'function totalWeight() view returns (uint256)',
  'function inventoryVersion() view returns (uint256)',
  'function purchasesResumeAt() view returns (uint256)',
  'function retired() view returns (bool)',
  'function localPurchasesEnabled() view returns (bool)',
  'function FACTORY() view returns (address)',
  'function slotToListing(uint256 slot) view returns (uint256)',
  'function listings(uint256 listingId) view returns (address collection, address depositor, address purchaser, uint256 tokenId, uint256 weight, uint256 price, uint256 slot, uint8 status)',
  'function acquisitions(uint256 requestId) view returns (address purchaser, uint256 requestBlock, uint256 priceEscrowed, uint256 listingId, uint8 status)',
  'function acquisitionMeta(uint256 requestId) view returns (uint64 sequence, uint64 wordDeadlineBlock, uint64 rewardEpoch, uint16 maxPositiveSlippageBps, uint16 maxNegativeSlippageBps, uint256 randomWord)',
  'function acquisitionRefundCredit(address purchaser) view returns (uint256)',
  'function quoteAcquisitionPrice(uint256 count) view returns (uint256 fee, uint256 vrf, uint256 total)',
  'function vrfServiceFee() view returns (uint256)',
  'function acquire(address purchaser, uint256 maxAcquisitionFee, uint256 minWeightedValue, uint256 maxNegativeSlippageBps, uint256 expectedInventoryVersion, uint256 deadline) payable returns (uint256 requestId)',
  'function acquireBatch(address purchaser, uint256 count, uint256 maxAcquisitionFee, uint256 minWeightedValue, uint256 maxNegativeSlippageBps, uint256 expectedInventoryVersion, uint256 deadline) payable returns (uint256[] requestIds)',
  'function processAcquisitions(uint256 maxCount) returns (uint256 processed)',
  'function withdrawAcquisitionRefund() returns (uint256 amount)',
  'event AcquisitionRequested(uint256 indexed requestId, address indexed purchaser, uint256 acquisitionFee, uint256 totalWeight)',
]);
const factoryAbi = parseAbi([
  'function globalPurchasesEnabled() view returns (bool)',
  'function globalWithdrawOnly() view returns (bool)',
  'function vrfRequestsPaused() view returns (bool)',
  'function consumerReady(address pool) view returns (bool)',
]);
const nameAbi = parseAbi(['function name() view returns (string)']);

/// A small key/value store over the Cache API (or a Map in tests).
export type Store = { get<T>(key: string): Promise<T | null>; put(key: string, value: unknown, ttl: number): Promise<void> };

export function cacheStore(origin: string): Store {
  const k = (key: string) => new Request(`${origin}/fwa-cache/${key}`);
  return {
    async get<T>(key: string) {
      const hit = await caches.default.match(k(key));
      return hit ? ((await hit.json()) as T) : null;
    },
    async put(key, value, ttl) {
      await caches.default.put(k(key), Response.json(value, { headers: { 'cache-control': `public, max-age=${ttl}` } }));
    },
  };
}

// ---------------------------------------------------------------- marketplace

export type FwaListing = { id: string; price: string; listingId: string };

const ID_CHUNK = 500; // getListing reads per multicall

/// Live FWA listings of `collection`, cheapest first. The market can't enumerate a collection's book, but listing
/// ids are sequential and never reused (a reprice issues a new one), so each id only needs reading once to know
/// whether it is ours: the scan remembers how far it has read and which of our ids were live, then reads only ids
/// minted since and re-confirms the live ones (a bought, cancelled or repriced id reads empty). No event logs: free
/// RPCs refuse historical getLogs. When listingCount says the book is empty (today, for Credits) nothing else is read.
export async function marketListings(c: PublicClient, o: { market: Address; collection: Address; store: Store }): Promise<FwaListing[]> {
  const [count, next] = await Promise.all([
    c.readContract({ address: o.market, abi: fwaMarketAbi, functionName: 'listingCount', args: [o.collection] }),
    c.readContract({ address: o.market, abi: fwaMarketAbi, functionName: 'nextListingId' }),
  ]);
  if (count === 0n) return [];
  const key = `ids/${o.market.toLowerCase()}/${o.collection.toLowerCase()}`;
  const cursor = (await o.store.get<{ next: string; ids: string[] }>(key)) ?? { next: '1', ids: [] };
  const want = [...cursor.ids];
  for (let id = BigInt(cursor.next); id < next; id++) want.push(String(id));
  const live: FwaListing[] = [];
  for (let i = 0; i < want.length; i += ID_CHUNK) {
    const slice = want.slice(i, i + ID_CHUNK);
    const reads = await c.multicall({
      contracts: slice.map((id) => ({ address: o.market, abi: fwaMarketAbi, functionName: 'getListing', args: [BigInt(id)] }) as const),
      allowFailure: false,
    });
    reads.forEach((l, j) => {
      if (/^0x0+$/.test(l.seller) || l.collection.toLowerCase() !== o.collection.toLowerCase()) return;
      live.push({ id: String(l.tokenId), price: String(l.price), listingId: slice[j] });
    });
  }
  await o.store.put(key, { next: String(next), ids: live.map((l) => l.listingId) }, 86_400);
  live.sort((a, b) => (BigInt(a.price) < BigInt(b.price) ? -1 : BigInt(a.price) > BigInt(b.price) ? 1 : 0));
  return live;
}

/// One listing, read now: still there, at this price, for this Credit.
export async function confirmListing(c: PublicClient, market: Address, collection: Address, l: FwaListing): Promise<boolean> {
  const got = await c.readContract({ address: market, abi: fwaMarketAbi, functionName: 'getListing', args: [BigInt(l.listingId)] });
  return !/^0x0+$/.test(got.seller) && got.collection.toLowerCase() === collection.toLowerCase() && String(got.tokenId) === l.id && String(got.price) === l.price;
}

// ---------------------------------------------------------------- pool

export type Pool = {
  pool: Address;
  total: number; // NFTs in the draw
  credits: number; // of them, Credits
  odds: number; // chance one spin lands a Credit, 0..1 (by the pool's weights, not the count)
  collections: number;
  sample: { id: string; price: string }[]; // Credits in the pool, most likely first
  fee: string; // pool price per spin, wei
  vrfGas: string; // VRF fee = vrfGas * tx.gasprice + vrfFlat
  vrfFlat: string;
  gasPrice: string; // now
  price: string; // one spin at today's gas: fee + VRF fee
  inventoryVersion: string;
  open: boolean;
  closed: string | null; // why a spin can't go through right now
  resumesAt: number; // unix seconds; after an owner change, spins wait out a cooldown
};

const SLOT_CHUNK = 256;
const SLOT_CEILING = 16_384;

/// Everything the Spin page shows. The NFTs in the draw come from the pool's slot tree (slots are reused, so the
/// highest one sits past the count; walk until every active listing is found). A listing's chance is its weight
/// over the total weight, and weight is 1/price, so cheap listings come up more often than their count suggests.
export async function readPool(c: PublicClient, pool: Address, credits: Address, store: Store): Promise<Pool> {
  const read = <F extends string>(functionName: F) => ({ address: pool, abi: fwaPoolAbi, functionName }) as never;
  const [active, totalWeight, version, resumeAt, retired, enabled, factory] = (await c.multicall({
    contracts: [read('activeListingCount'), read('totalWeight'), read('inventoryVersion'), read('purchasesResumeAt'), read('retired'), read('localPurchasesEnabled'), read('FACTORY')],
    allowFailure: false,
  })) as [bigint, bigint, bigint, bigint, boolean, boolean, Address];

  // The draw's contents change only with the inventory version or a delivered spin (the count drops).
  const key = `pool/${pool.toLowerCase()}/${version}/${active}/${totalWeight}`;
  let inv = await store.get<{ credits: number; creditWeight: string; collections: number; sample: { id: string; price: string }[] }>(key);
  if (!inv) {
    const ids: bigint[] = [];
    for (let s = 0; s < SLOT_CEILING && ids.length < Number(active); s += SLOT_CHUNK) {
      const got = await c.multicall({
        contracts: Array.from({ length: SLOT_CHUNK }, (_, i) => ({ address: pool, abi: fwaPoolAbi, functionName: 'slotToListing', args: [BigInt(s + i)] }) as const),
        allowFailure: false,
      });
      for (const id of got) if (id > 0n) ids.push(id);
    }
    const rows = await c.multicall({
      contracts: ids.map((id) => ({ address: pool, abi: fwaPoolAbi, functionName: 'listings', args: [id] }) as const),
      allowFailure: false,
    });
    let creditWeight = 0n;
    const cs: { id: string; price: bigint }[] = [];
    const collections = new Set<string>();
    for (const [collection, , , tokenId, weight, price, , status] of rows) {
      if (status !== 1) continue; // Active
      collections.add(collection.toLowerCase());
      if (collection.toLowerCase() !== credits.toLowerCase()) continue;
      creditWeight += weight;
      cs.push({ id: String(tokenId), price });
    }
    cs.sort((a, b) => (a.price < b.price ? -1 : a.price > b.price ? 1 : Number(a.id) - Number(b.id)));
    inv = { credits: cs.length, creditWeight: String(creditWeight), collections: collections.size, sample: cs.slice(0, 24).map((x) => ({ id: x.id, price: String(x.price) })) };
    await store.put(key, inv, 300);
  }

  const [quote, gasPrice, vrf, flags] = await Promise.all([
    c.readContract({ address: pool, abi: fwaPoolAbi, functionName: 'quoteAcquisitionPrice', args: [1n] }),
    c.getGasPrice(),
    vrfLine(c, pool),
    c
      .multicall({
        contracts: [
          { address: factory, abi: factoryAbi, functionName: 'globalPurchasesEnabled' },
          { address: factory, abi: factoryAbi, functionName: 'globalWithdrawOnly' },
          { address: factory, abi: factoryAbi, functionName: 'vrfRequestsPaused' },
          { address: factory, abi: factoryAbi, functionName: 'consumerReady', args: [pool] },
        ],
        allowFailure: false,
      })
      .catch(() => null),
  ]);
  const fee = quote[0];
  const now = Math.floor(Date.now() / 1000);
  const closed = retired
    ? 'This pool is closed.'
    : !enabled
      ? 'This pool isn’t open for spins yet.'
      : active === 0n
        ? 'This pool is empty.'
        : flags && (!flags[0] || flags[1] || flags[2] || !flags[3])
          ? 'FWA has spins paused right now.'
          : null;
  return {
    pool,
    total: Number(active),
    credits: inv.credits,
    odds: totalWeight > 0n ? Number((BigInt(inv.creditWeight) * 1_000_000n) / totalWeight) / 1_000_000 : 0,
    collections: inv.collections,
    sample: inv.sample,
    fee: String(fee),
    vrfGas: String(vrf.perGas),
    vrfFlat: String(vrf.flat),
    gasPrice: String(gasPrice),
    price: String(fee + vrf.perGas * gasPrice + vrf.flat),
    inventoryVersion: String(version),
    open: !closed,
    closed,
    resumesAt: Number(resumeAt) > now ? Number(resumeAt) : 0,
  };
}

/// The VRF fee is priced off the spin transaction's own gas price (tx.gasprice), so an eth_call has to set one.
/// Two points give the line: fee = perGas * gasPrice + flat. Both prices sit above any base fee, which an eth_call
/// with a gas price must clear. Some load-balanced public RPC nodes ignore the call's gas price and answer 0, so a
/// zero is retried and never trusted.
async function vrfLine(c: PublicClient, pool: Address) {
  const at = async (gasPrice: bigint) => {
    for (let i = 0; i < 3; i++) {
      const r = await c.call({ to: pool, data: encodeFunctionData({ abi: fwaPoolAbi, functionName: 'vrfServiceFee' }), gasPrice });
      const v = r.data ? BigInt(r.data) : 0n;
      if (v > 0n) return v;
    }
    throw new Error('Couldn’t price the randomness fee.');
  };
  const g1 = 100_000_000_000n; // 100 gwei
  const g2 = 200_000_000_000n;
  const [f1, f2] = await Promise.all([at(g1), at(g2)]);
  const perGas = (f2 - f1) / (g2 - g1);
  const flat = f1 - perGas * g1;
  if (perGas <= 0n || flat < 0n) throw new Error('Couldn’t price the randomness fee.');
  return { perGas, flat };
}

// ---------------------------------------------------------------- one spin

/// FWAClone.AcquisitionStatus, by number.
const STATUS = ['none', 'waiting', 'won', 'expired', 'refunded', 'drawn', 'late', 'delivering', 'refunded'] as const;

export type Spin = {
  state: 'pending' | 'reverted' | 'mined';
  block?: number;
  head?: number;
  spins: {
    requestId: string;
    status: (typeof STATUS)[number];
    wordDeadline: number;
    nft: { collection: Address; id: string; name: string | null; credit: boolean } | null;
  }[];
  refund?: string; // the buyer's withdrawable refund credit on this pool, wei
};

/// Where one spin transaction stands: not mined, reverted, or each draw it asked for with its outcome. Only
/// transactions sent to `pool` count.
export async function readSpin(c: PublicClient, pool: Address, credits: Address, tx: Hash): Promise<Spin> {
  const receipt = await c.getTransactionReceipt({ hash: tx }).catch(() => null);
  if (!receipt) return { state: 'pending', spins: [] };
  if (receipt.to?.toLowerCase() !== pool.toLowerCase()) throw new Error('Not a spin on this pool.');
  if (receipt.status !== 'success') return { state: 'reverted', spins: [] };
  const requested: { requestId: bigint; purchaser: Address }[] = [];
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== pool.toLowerCase()) continue;
    try {
      const ev = decodeEventLog({ abi: fwaPoolAbi, data: log.data, topics: log.topics });
      if (ev.eventName === 'AcquisitionRequested') requested.push({ requestId: ev.args.requestId, purchaser: ev.args.purchaser });
    } catch {}
  }
  const [head, rows] = await Promise.all([
    c.getBlockNumber(),
    c.multicall({
      contracts: requested.flatMap((r) => [
        { address: pool, abi: fwaPoolAbi, functionName: 'acquisitions', args: [r.requestId] } as const,
        { address: pool, abi: fwaPoolAbi, functionName: 'acquisitionMeta', args: [r.requestId] } as const,
      ]),
      allowFailure: false,
    }),
  ]);
  const spins: Spin['spins'] = [];
  for (let i = 0; i < requested.length; i++) {
    const [, , , listingId, status] = rows[2 * i] as readonly [Address, bigint, bigint, bigint, number];
    const meta = rows[2 * i + 1] as readonly [bigint, bigint, bigint, number, number, bigint];
    let nft: Spin['spins'][number]['nft'] = null;
    if (listingId > 0n) {
      const [collection, , , tokenId] = await c.readContract({ address: pool, abi: fwaPoolAbi, functionName: 'listings', args: [listingId] });
      const credit = collection.toLowerCase() === credits.toLowerCase();
      const name = credit ? 'Credits' : await c.readContract({ address: collection, abi: nameAbi, functionName: 'name' }).catch(() => null);
      nft = { collection, id: String(tokenId), name: name ? [...name].slice(0, 48).join('') : null, credit };
    }
    spins.push({ requestId: String(requested[i].requestId), status: STATUS[status] ?? 'none', wordDeadline: Number(meta[1]), nft });
  }
  const buyer = requested[0]?.purchaser;
  const refund = buyer ? await c.readContract({ address: pool, abi: fwaPoolAbi, functionName: 'acquisitionRefundCredit', args: [buyer] }) : 0n;
  return { state: 'mined', block: Number(receipt.blockNumber), head: Number(head), spins, refund: String(refund) };
}
