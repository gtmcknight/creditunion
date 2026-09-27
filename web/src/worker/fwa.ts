/// FWA (fwa.fun) on Ethereum mainnet, read-only: FWAMarketplace's fixed-price Credits listings, a Buy Credits
/// source next to OpenSea.
/// Nothing here signs or sends. Self-contained (viem only) so it can be exercised from a plain node script.
import { parseAbi, type Address, type PublicClient } from 'viem';

export const fwaMarketAbi = parseAbi([
  'function listingCount(address collection) view returns (uint256)',
  'struct Listing { address seller; uint64 createdBlock; address collection; uint96 price; uint256 tokenId; address royaltyRecipient; uint96 royaltyAmount; }',
  'function getListing(uint256 listingId) view returns (Listing)',
  'function nextListingId() view returns (uint64)',
]);

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
