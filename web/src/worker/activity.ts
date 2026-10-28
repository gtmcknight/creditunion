/// /activity.json: everything wallets have done on Credit Union, newest first, from the chain's event logs. Unions
/// started (factory), deposits, withdrawals, burns into a Statement, bids, sales and claims (each union), and
/// Credits bought through the Sweeper. Scanned forward from where the last scan stopped, so a refresh reads only
/// the new blocks; the scan state lives in the colo cache and a cold one rescans from the factory's deploy block.
/// Swaps made in the swap box come from their own scan (readSwapActivity).
import { getAddress, parseAbi, type Address, type Hex, type PublicClient } from 'viem';
import { POOL_MANAGER, SITE_TAG, UNIVERSAL_ROUTER } from '../shared/v4swap';

export type Activity = {
  kind: 'started' | 'deposited' | 'withdrew' | 'burned' | 'converted' | 'bid' | 'won' | 'claimed' | 'bought' | 'swapped';
  who: Address;
  union?: Address;
  name?: string;
  ids?: number[]; // Credits moved (deposits, withdrawals, buys)
  count?: number;
  eth?: string; // wei
  intoUnion?: boolean; // a buy that went straight into a union (Sweeper.Swept)
  side?: 'buy' | 'sell'; // a swap: bought $BALANCE with ETH, or sold it for ETH
  balance?: string; // a swap's $BALANCE, wei
  block: number;
  time: number;
  tx: Hex;
  i: number; // log index, for a stable order within a block
};

/// v2: keeps every row (v1 kept 200); a v1 state is rescanned so older history comes back.
type State = { v: 2; last: number; unions: Record<string, string>; items: Activity[] };

const FACTORY_EVENTS = parseAbi(['event BatchCreated(address indexed batch, address indexed creator, string name, uint256 index)']);
const BATCH_EVENTS = parseAbi([
  'event Deposited(address indexed from, uint256 indexed id, uint256 count)',
  'event Withdrawn(address indexed to, uint256 indexed id, uint256 count)',
  'event Assembled(address indexed caller, address statement, uint256 statementId, uint256[] order)',
  'event Bid(address indexed bidder, uint256 amount, uint64 auctionEnd)',
  'event Settled(address indexed winner, uint256 amount, uint256 protocolFee, uint256 creatorFee, uint256 payoutPerShare)',
  'event Claimed(address indexed depositor, uint256 amount)',
]);
const SWEEPER_EVENTS = parseAbi([
  'event Bought(address indexed buyer, uint256 bought, uint256 spent, uint256 fee)',
  'event Swept(address indexed buyer, address indexed batch, uint256 bought, uint256 spent, uint256 fee)',
]);
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

/// Public RPCs cap a getLogs range; this fits the ones the site falls back to.
const WINDOW = 45_000n;
/// Every row since the factory's deploy is kept (the scan state grows with history; /activity.json serves slices of
/// it). A cold scan can find thousands of rows; only the newest this many get an RPC call each (block time, buy
/// receipt), so one request stays well inside the Worker's subrequest limit. Older rows get a time estimated from
/// the block number (12-second slots) and a buy's count without its ids.
const EXACT = 200;
const SLOT = 12;

export async function readActivity(
  c: PublicClient,
  cache: Cache,
  stateKey: string,
  cfg: { factory: Address; sweeper: Address | null; credits: Address; from: bigint },
): Promise<Activity[]> {
  const hit = await cache.match(stateKey);
  let st: State = hit ? ((await hit.json()) as State) : { v: 2, last: Number(cfg.from) - 1, unions: {}, items: [] };
  if (st.v !== 2) st = { v: 2, last: Number(cfg.from) - 1, unions: {}, items: [] };
  const head = await c.getBlockNumber();
  const fresh: Omit<Activity, 'time'>[] = [];
  // Swept buys land in a union: Batch emits the Deposited rows, the Sweeper says who paid. Keyed by tx + union.
  const swept = new Map<string, { eth: bigint }>();
  const boughtTx: { tx: Hex; who: Address; count: number; eth: bigint; block: number; i: number }[] = [];

  for (let f = BigInt(st.last + 1); f <= head; f += WINDOW) {
    const t = f + WINDOW - 1n > head ? head : f + WINDOW - 1n;
    const created = await c.getLogs({ address: cfg.factory, events: FACTORY_EVENTS, fromBlock: f, toBlock: t });
    for (const l of created) {
      const a = l.args as { batch: Address; creator: Address; name: string };
      st.unions[a.batch.toLowerCase()] = [...a.name].slice(0, 64).join('');
      fresh.push({ kind: 'started', who: a.creator, union: a.batch, block: Number(l.blockNumber), tx: l.transactionHash!, i: l.logIndex! });
    }
    const unions = Object.keys(st.unions) as Address[];
    const [logs, sweeps] = await Promise.all([
      unions.length ? c.getLogs({ address: unions, events: BATCH_EVENTS, fromBlock: f, toBlock: t }) : Promise.resolve([]),
      cfg.sweeper ? c.getLogs({ address: cfg.sweeper, events: SWEEPER_EVENTS, fromBlock: f, toBlock: t }) : Promise.resolve([]),
    ]);
    for (const l of sweeps) {
      const a = l.args as { buyer: Address; batch?: Address; bought: bigint; spent: bigint; fee: bigint };
      if (l.eventName === 'Swept') swept.set(`${l.transactionHash}:${a.batch!.toLowerCase()}`, { eth: a.spent + a.fee });
      else boughtTx.push({ tx: l.transactionHash!, who: a.buyer, count: Number(a.bought), eth: a.spent + a.fee, block: Number(l.blockNumber), i: l.logIndex! });
    }
    // Deposits and withdrawals are one event per Credit: one row per wallet, union and transaction.
    const grouped = new Map<string, Omit<Activity, 'time'>>();
    for (const l of logs) {
      const union = l.address as Address, block = Number(l.blockNumber), tx = l.transactionHash!, i = l.logIndex!;
      const a = l.args as Record<string, unknown>;
      switch (l.eventName) {
        case 'Deposited':
        case 'Withdrawn': {
          const who = (l.eventName === 'Deposited' ? a.from : a.to) as Address;
          const kind = l.eventName === 'Deposited' ? 'deposited' : 'withdrew';
          const key = `${kind}:${tx}:${union.toLowerCase()}:${who.toLowerCase()}`;
          const row = grouped.get(key) ?? { kind, who, union, ids: [], block, tx, i };
          row.ids!.push(Number(a.id));
          grouped.set(key, row);
          break;
        }
        case 'Assembled':
          fresh.push({ kind: 'burned', who: a.caller as Address, union, block, tx, i });
          break;
        case 'Bid':
          fresh.push({ kind: 'bid', who: a.bidder as Address, union, eth: String(a.amount), block, tx, i });
          break;
        case 'Settled':
          fresh.push({ kind: 'won', who: a.winner as Address, union, eth: String(a.amount), block, tx, i });
          break;
        case 'Claimed':
          fresh.push({ kind: 'claimed', who: a.depositor as Address, union, eth: String(a.amount), block, tx, i });
          break;
      }
    }
    for (const row of grouped.values()) {
      row.count = row.ids!.length;
      const sw = row.kind === 'deposited' ? swept.get(`${row.tx}:${row.union!.toLowerCase()}`) : undefined;
      if (sw) Object.assign(row, { kind: 'bought', intoUnion: true, eth: String(sw.eth) });
      fresh.push(row);
    }
  }

  // Buys to a wallet: which Credits, from the Credits contract's transfers to the buyer in that transaction.
  const exact = boughtTx.length - EXACT;
  const receipts = await Promise.all(boughtTx.map((b, k) => (k >= exact ? c.getTransactionReceipt({ hash: b.tx }).catch(() => null) : null)));
  boughtTx.forEach((b, k) => {
    const r = receipts[k];
    const me = b.who.toLowerCase();
    const ids = r
      ? r.logs
          .filter((l) => l.address.toLowerCase() === cfg.credits.toLowerCase() && l.topics[0] === TRANSFER && l.topics.length === 4 && `0x${l.topics[2]!.slice(26)}` === me)
          .map((l) => Number(BigInt(l.topics[3]!)))
      : [];
    fresh.push({ kind: 'bought', who: b.who, ids, count: ids.length || b.count, eth: String(b.eth), block: b.block, tx: b.tx, i: b.i });
  });

  const newest = fresh.sort((a, b) => b.block - a.block || b.i - a.i);
  const blocks = [...new Set(newest.map((x) => x.block))];
  const times = new Map<number, number>();
  await Promise.all(blocks.slice(0, EXACT).map(async (n) => times.set(n, Number((await c.getBlock({ blockNumber: BigInt(n) })).timestamp))));
  if (blocks.length > EXACT) {
    const top = blocks[0], topTime = times.get(top)!;
    for (const n of blocks.slice(EXACT)) times.set(n, topTime - (top - n) * SLOT);
  }
  const items = [...newest.map((x) => ({ ...x, time: times.get(x.block) ?? 0 })), ...st.items];
  for (const x of items) if (x.union) x.name = st.unions[x.union.toLowerCase()] ?? x.name;

  st = { v: 2, last: Number(head), unions: st.unions, items };
  await cache.put(stateKey, Response.json(st, { headers: { 'cache-control': 'public, max-age=86400' } }));
  return items;
}

const SWAP_EVENTS = parseAbi(['event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)']);
const TAG = SITE_TAG.slice(2).toLowerCase();
/// ERC-4337 EntryPoints (v0.6, v0.7, v0.8): a smart wallet's transaction comes from a bundler, so who swapped is read
/// from the token's transfers instead.
const ENTRY_POINTS = new Set(['0x5ff137d4b0fdcd49dca30c7cf57e578a026d2789', '0x0000000071727de22e5e9d8baf0edac6f37da032', '0x4337084d9e255ff0702461cf8895ce9e3b5ff108']);
/// Transactions read per scan, one each (most are other people's Uniswap swaps); the rest wait for the next scan.
const SWAP_READS = 100;
type SwapState = { v: 1; last: number; items: Activity[] };

/// Swaps made in the swap box, newest first: Uniswap's Swap events on the pool through the Universal Router, kept
/// when the transaction carries SITE_TAG. Who swapped is the sender (or, for a smart wallet, the address the pool
/// paid or was paid by); amounts are theirs, after our fee. Scanned forward like readActivity.
export async function readSwapActivity(
  c: PublicClient,
  cache: Cache,
  stateKey: string,
  cfg: { poolId: Hex; token: Address; feeBps: number; from: bigint },
): Promise<Activity[]> {
  const hit = await cache.match(stateKey);
  let st: SwapState = hit ? ((await hit.json()) as SwapState) : { v: 1, last: Number(cfg.from) - 1, items: [] };
  if (st.v !== 1) st = { v: 1, last: Number(cfg.from) - 1, items: [] };
  const head = await c.getBlockNumber();
  let logs: { tx: Hex; block: number; i: number; amount0: bigint; amount1: bigint }[] = [];
  for (let f = BigInt(st.last + 1); f <= head; f += WINDOW) {
    const t = f + WINDOW - 1n > head ? head : f + WINDOW - 1n;
    const got = await c.getLogs({ address: POOL_MANAGER, event: SWAP_EVENTS[0], args: { id: cfg.poolId, sender: UNIVERSAL_ROUTER }, fromBlock: f, toBlock: t });
    for (const l of got) {
      const a = l.args as { amount0: bigint; amount1: bigint };
      logs.push({ tx: l.transactionHash!, block: Number(l.blockNumber), i: l.logIndex!, amount0: a.amount0, amount1: a.amount1 });
    }
  }
  // Oldest first, SWAP_READS transactions at most: past that, the scan ends before that block and goes on from it next time.
  logs.sort((a, b) => a.block - b.block || a.i - b.i);
  let last = Number(head);
  const txs = [...new Set(logs.map((l) => l.tx))];
  if (txs.length > SWAP_READS) {
    const stop = logs.find((l) => l.tx === txs[SWAP_READS])!.block;
    if (stop > st.last + 1) {
      logs = logs.filter((l) => l.block < stop);
      last = stop - 1;
    }
  }
  const read = await Promise.all([...new Set(logs.map((l) => l.tx))].map(async (hash) => [hash, await c.getTransaction({ hash }).catch(() => null)] as const));
  const ours = new Map(read.filter(([, tx]) => tx && tx.input.toLowerCase().includes(TAG)));
  const token = cfg.token.toLowerCase(), pm = POOL_MANAGER.toLowerCase();
  const fresh: Omit<Activity, 'time'>[] = [];
  for (const l of logs) {
    const tx = ours.get(l.tx);
    if (!tx) continue;
    let who = tx.from;
    if (tx.to && ENTRY_POINTS.has(tx.to.toLowerCase())) {
      // The biggest $BALANCE transfer to or from the pool in that transaction: the rest is our fee.
      const r = await c.getTransactionReceipt({ hash: l.tx }).catch(() => null);
      let most = 0n;
      for (const x of r?.logs ?? []) {
        if (x.address.toLowerCase() !== token || x.topics[0] !== TRANSFER || x.topics.length !== 3) continue;
        const from = `0x${x.topics[1]!.slice(26)}`, to = `0x${x.topics[2]!.slice(26)}`, v = BigInt(x.data);
        if ((from === pm || to === pm) && v > most) [most, who] = [v, (from === pm ? to : from) as Address];
      }
    }
    // The wallet's side of the pool: negative is what it paid in. ETH is currency0, $BALANCE currency1; our fee is a
    // slice of what came out.
    const buy = l.amount0 < 0n;
    const net = (x: bigint) => x - (x * BigInt(cfg.feeBps)) / 10_000n;
    const eth = buy ? -l.amount0 : net(l.amount0);
    const balance = buy ? net(l.amount1) : -l.amount1;
    fresh.push({ kind: 'swapped', who: getAddress(who), side: buy ? 'buy' : 'sell', eth: String(eth), balance: String(balance), block: l.block, tx: l.tx, i: l.i });
  }

  const newest = fresh.sort((a, b) => b.block - a.block || b.i - a.i);
  const times = new Map<number, number>();
  await Promise.all([...new Set(newest.map((x) => x.block))].map(async (n) => times.set(n, Number((await c.getBlock({ blockNumber: BigInt(n) })).timestamp))));
  const items = [...newest.map((x) => ({ ...x, time: times.get(x.block) ?? 0 })), ...st.items];
  st = { v: 1, last, items };
  await cache.put(stateKey, Response.json(st, { headers: { 'cache-control': 'public, max-age=86400' } }));
  return items;
}
