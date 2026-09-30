import type { Address } from 'viem';
import { batchAbi, creditsAbi, factoryAbi } from './abi';
import { config, onTx, pub } from './chain';
import { fromJson } from '../shared/json';

export const STATES = ['Open', 'Full', 'Expired', 'Auction', 'Settled'] as const;
export type StateName = (typeof STATES)[number];

/// Batch.Phase, the lock cycle. Waiting: 80 in, no burn adapter yet. Countdown: 5 minutes to lockAt, leaving
/// still allowed. Burnable: locked for an hour, anyone can burn. Expired: nobody burned, open to leave again.
export const PHASES = ['Open', 'Waiting', 'Countdown', 'Burnable', 'Expired', 'Assembled'] as const;
export type PhaseName = (typeof PHASES)[number];

/// Indexed by the contract's burn order. Mint time (1) and Creator's order (3) are retired: only old parties show them.
export const ARRANGEMENTS = ['Order joined', 'Mint time', 'Credit number, low to high', 'Creator’s order', 'Painted', 'Credit number, high to low'] as const;
/// Palette wanted at layout slot i (0 = any), from the packed Filter fields.
export const layoutSlot = (f: { layout0: bigint; layout1: bigint }, i: number) =>
  Number(i < 64 ? (f.layout0 >> BigInt(4 * i)) & 15n : (f.layout1 >> BigInt(4 * (i - 64))) & 15n);
export const hasLayout = (f: { layout0: bigint; layout1: bigint }) => f.layout0 !== 0n || f.layout1 !== 0n;

/// Where each deposited Credit sits on a layout sheet before the burn, mirroring Batch.layoutOrder: painted
/// slots take the earliest deposit of their palette, open slots the rest, in deposit order. Nulls are empty.
export function placeOnLayout(slots: number[], ids: readonly bigint[], paletteOf: (id: bigint) => number): (bigint | null)[] {
  const placed: (bigint | null)[] = new Array(80).fill(null);
  const used = new Set<number>();
  for (let i = 0; i < 80; i++) {
    if (!slots[i]) continue;
    const j = ids.findIndex((id, k) => !used.has(k) && paletteOf(id) === slots[i]);
    if (j >= 0) {
      used.add(j);
      placed[i] = ids[j];
    }
  }
  let k = 0;
  for (let i = 0; i < 80; i++) {
    if (slots[i]) continue;
    while (k < ids.length && used.has(k)) k++;
    if (k >= ids.length) break;
    used.add(k);
    placed[i] = ids[k];
  }
  return placed;
}
export const SPLITS = ['Equal', 'Early bird'] as const;
/// Early-bird weight of a 0-based position, in shares (1.5 at the first slot, 0.5 at the last).
export const earlyWeight = (i: number) => (237 - 2 * i) / 158;
/// Early bird: the share of the depositors' payout the Credit at deposit position i (0-based) gets. Weights 237 down to 79, total 12,640.
export const earlyShare = (i: number) => (237 - 2 * i) / 12640;
export const sharePct = (x: number) => `${(x * 100).toFixed(2).replace(/0$/, '')}%`;

export type Rated = {
  id: string;
  /// The 21-byte seed as text (latin1), for drawing the Credit's ink.
  seed: string;
  paidAt: number;
  score: number;
  rank: number;
  traits: { palette: string; activeBits: number; occupied: number; eights: number; registration: string };
  tails: number[];
};

/// A Credit's rating never changes (its seed and payment time are fixed): each is asked for once per visit, so a page
/// drawn again (a live refresh) asks only for Credits it hasn't seen.
const rated = new Map<string, Rated>();
let ratedOf: { n: number; version: string } | null = null;
export async function ratings(ids: readonly bigint[]): Promise<{ n: number; version: string; ratings: Record<string, Rated> }> {
  const all = [...new Set(ids.map(String))];
  const want = all.filter((id) => !rated.has(id));
  if (want.length || !ratedOf) {
    const r = await fetch('/ratings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids: want.length ? want : all }) });
    if (!r.ok) throw new Error('Ratings unavailable.');
    const j = (await r.json()) as { n: number; version: string; ratings: Record<string, Rated> };
    ratedOf = { n: j.n, version: j.version };
    for (const [id, v] of Object.entries(j.ratings ?? {})) rated.set(id, v);
  }
  return { ...ratedOf!, ratings: Object.fromEntries(all.flatMap((id) => (rated.has(id) ? [[id, rated.get(id)!]] : []))) };
}

export type Summary = {
  address: Address;
  state: StateName;
  arrangement: number;
  split: number;
  canAssemble: boolean;
  phase: PhaseName;
  lockAt: number; // when a full party locks and becomes burnable; 0 unless the adapter is live and it has 80
  name: string;
  creator: Address;
  count: number;
  deadline: number; // when the burn window closes and it unlocks: lockAt + 1 hour, 0 when lockAt is 0
  filledAt: number;
  assembledAt: number;
  auctionEnd: number;
  reserve: bigint;
  minBid: bigint;
  creatorFeeBps: number;
  protocolFeeBps: number;
  filter: {
    palettes: number; // sets: one bit per accepted value, 0 = any (see Batch.Filter)
    prints: number;
    weights: number;
    eights: number;
    paidFrom: number;
    paidTo: number;
    idFrom: bigint;
    idTo: bigint;
    minScore: number; // official rating ×10, 0 = any
    maxScore: number;
    layout0: bigint; // 4 bits per sheet slot, 0 = any palette, 1–15 = CMYK mask (see Batch.Filter)
    layout1: bigint;
    bitsFrom: number; // Jack's Bits (marks) range, 0 = unbounded
    bitsTo: number;
    layoutTrait: number; // which trait the layout paints (see shared/layout.ts)
  };
  allowlistSize: number;
  statement: Address;
  statementId: bigint;
  highBidder: Address;
  highBid: bigint;
  payoutPerShare: bigint;
};

function toSummary(address: Address, s: Record<string, unknown>): Summary {
  return {
    ...(s as unknown as Summary),
    address,
    state: STATES[Number(s.state)],
    phase: PHASES[Number(s.phase)],
    lockAt: Number(s.lockAt),
    count: Number(s.count),
    deadline: Number(s.deadline),
    filledAt: Number(s.filledAt),
    assembledAt: Number(s.assembledAt),
    auctionEnd: Number(s.auctionEnd),
    arrangement: Number(s.arrangement),
    split: Number(s.split),
    allowlistSize: Number(s.allowlistSize),
    filter: { ...(s.filter as Summary['filter']), paidFrom: Number((s.filter as { paidFrom: bigint }).paidFrom), paidTo: Number((s.filter as { paidTo: bigint }).paidTo) },
    creatorFeeBps: Number(s.creatorFeeBps),
    protocolFeeBps: Number(s.protocolFeeBps),
  };
}

export type Listed = { s: Summary; ids: readonly bigint[]; depositors: readonly Address[] };

/// Every Credit Union, newest first, from the Worker's union index (/unions.json: read once for the whole site,
/// preloaded by list pages). Most pages read it, so one read serves every page for a few seconds. Forgotten after
/// any transaction of ours (the next read then asks the Worker for a read made after it) and whenever a page sees a
/// Credit Union change.
const LIST_MS = 10_000;
let listed: { at: number; p: Promise<Listed[]>; value?: Listed[] } | null = null;
let fresh = false;
export function listBatches(): Promise<Listed[]> {
  if (listed && Date.now() - listed.at < LIST_MS) return listed.p;
  const p = readBatches(fresh);
  fresh = false;
  const entry: NonNullable<typeof listed> = (listed = { at: Date.now(), p });
  p.then((v) => (entry.value = v)).catch(() => listed === entry && (listed = null)); // a failed read is retried next time, not remembered
  return p;
}

/// One Credit Union as the index had it when a page read it in the last minute (a list page, say), with how old
/// that read is; null when there's none. Being in the index is being one of our factory's. Forgotten, like the
/// index, after any transaction of ours.
export function indexedBatch(a: Address): { b: Listed; age: number } | null {
  const v = listed?.value;
  if (!listed || !v || Date.now() - listed.at > 60_000) return null;
  const b = v.find((x) => x.s.address.toLowerCase() === a.toLowerCase());
  return b ? { b, age: Date.now() - listed.at } : null;
}
export const forgetBatches = () => {
  listed = null;
  fresh = true;
};
onTx(forgetBatches);
/// Someone else changed a union (a page saw it): the next list read goes to the index again, without `fresh`,
/// which is for this wallet's own transactions.
export const staleBatches = () => {
  listed = null;
};
/// When this wallet last sent a transaction: for a while after, a page reads the chain rather than the index, which
/// can be a block behind what the wallet just did.
let txAt = 0;
onTx(() => (txAt = Date.now()));
export const sinceTx = () => Date.now() - txAt;

type Indexed = { address: Address; summary: Record<string, unknown>; ids: number[]; depositors: Address[] };
async function readBatches(fresh: boolean): Promise<Listed[]> {
  const r = await fetch(fresh ? `/unions.json?fresh=${Date.now()}` : '/unions.json');
  if (!r.ok) throw new Error('Credit Unions are unavailable right now.');
  const { unions } = fromJson(await r.text()) as { unions: Indexed[] };
  return unions.map((u) => ({ s: toSummary(u.address, u.summary), ids: u.ids.map(BigInt), depositors: u.depositors }));
}

/// Just the summary: a cheap read for spotting changes.
export const getSummary = async (a: Address) => toSummary(a, (await pub.readContract({ address: a, abi: batchAbi, functionName: 'summary' })) as Record<string, unknown>);

/// One union from the Worker's index (read once for the whole site, a few seconds old at most), for a page that
/// watches it: no chain read per viewer. Null when the index doesn't have it (a plan's union still filling, one made
/// in the last seconds) or can't be read: then read the chain with getBatch.
/// `at`: when the Worker's read began (unix seconds), to tell an older answer from a newer one.
export async function indexedOne(a: Address): Promise<(Listed & { at: number }) | null> {
  try {
    const r = await fetch(`/unions.json?union=${a.toLowerCase()}`);
    if (!r.ok) return null;
    const { at, union: u } = fromJson(await r.text()) as { at: number; union: Indexed | null };
    return u ? { s: toSummary(u.address, u.summary), ids: u.ids.map(BigInt), depositors: u.depositors, at } : null;
  } catch {
    return null;
  }
}

export async function getBatch(a: Address) {
  const [s, slots] = await Promise.all([
    pub.readContract({ address: a, abi: batchAbi, functionName: 'summary' }),
    pub.readContract({ address: a, abi: batchAbi, functionName: 'slots' }),
  ]);
  return { s: toSummary(a, s as Record<string, unknown>), ids: slots[0], depositors: slots[1] };
}

/// Your side of a Credit Union, kept 20 s (forgotten after any transaction of ours), so a page you open, or are about
/// to (a link under the pointer reads ahead), has it waiting.
const MINE_MS = 20_000;
const mine = new Map<string, { at: number; p: ReturnType<typeof readMine> }>();
onTx(() => mine.clear());
export function me(batch: Address, account: Address) {
  const k = `${batch}:${account}`.toLowerCase();
  const hit = mine.get(k);
  if (hit && Date.now() - hit.at < MINE_MS) return hit.p;
  const p = readMine(batch, account);
  mine.set(k, { at: Date.now(), p });
  p.catch(() => mine.get(k)?.p === p && mine.delete(k));
  return p;
}

async function readMine(batch: Address, account: Address) {
  const [shares, claimable, owed, [approved, owned]] = await Promise.all([
    pub.readContract({ address: batch, abi: batchAbi, functionName: 'sharesOf', args: [account] }),
    pub.readContract({ address: batch, abi: batchAbi, functionName: 'claimable', args: [account] }),
    pub.readContract({ address: batch, abi: batchAbi, functionName: 'owed', args: [account] }),
    walletReads(account),
  ]);
  return { shares: Number(shares), claimable, owed, approved, owned };
}

/// The wallet's own side (its Credits, and whether the factory may move them), the same for every union: read once
/// for all of them for MINE_MS, and again after any transaction of ours.
const wallets = new Map<string, { at: number; p: Promise<[boolean, readonly bigint[]]> }>();
onTx(() => wallets.clear());
function walletReads(account: Address) {
  const k = account.toLowerCase();
  const hit = wallets.get(k);
  if (hit && Date.now() - hit.at < MINE_MS) return hit.p;
  const p = Promise.all([isApproved(account), myCredits(account)]) as Promise<[boolean, readonly bigint[]]>;
  wallets.set(k, { at: Date.now(), p });
  p.catch(() => wallets.get(k)?.p === p && wallets.delete(k));
  return p;
}

export const isApproved = (account: Address) =>
  pub.readContract({
    address: config.credits,
    abi: creditsAbi,
    functionName: 'isApprovedForAll',
    args: [account, config.factory],
  });

export const myCredits = (account: Address) =>
  pub.readContract({ address: config.credits, abi: creditsAbi, functionName: 'tokensOf', args: [account] });

/// Which of `ids` pass a batch's filter, asked of the batch itself (it reads Jack's art contract). More than a few
/// go through the Worker's one multicall (/passes): a holder of hundreds costs one request, not a call per Credit.
export async function eligible(batch: Address, ids: readonly bigint[]) {
  const ok = ids.length <= 4 ? await Promise.all(ids.map((id) => pub.readContract({ address: batch, abi: batchAbi, functionName: 'passes', args: [id] }))) : await passesOf(batch, ids);
  return ids.filter((_, i) => ok[i]);
}
/// One /passes answer per Credit Union and set of Credits for a few seconds, so a page drawn twice (a wallet
/// reconnecting) asks once. Forgotten after any transaction of ours.
const passMemo = new Map<string, { at: number; p: Promise<boolean[]> }>();
onTx(() => passMemo.clear());
function passesOf(batch: Address, ids: readonly bigint[]) {
  const key = `${batch.toLowerCase()}:${ids.join(',')}`;
  const hit = passMemo.get(key);
  if (hit && Date.now() - hit.at < LIST_MS) return hit.p;
  const p = (async () => {
    const r = await fetch('/passes', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ batch, ids: ids.map(String) }) });
    const d = (await r.json().catch(() => ({}))) as { ok?: boolean[]; error?: string };
    if (!r.ok || !d.ok) throw new Error(d.error ?? 'Couldn’t check your Credits right now.');
    return d.ok;
  })();
  passMemo.set(key, { at: Date.now(), p });
  p.catch(() => passMemo.delete(key));
  return p;
}

export async function minOpen() {
  return Number(await pub.readContract({ address: config.factory, abi: factoryAbi, functionName: 'minOpen' }));
}

export async function protocolFeeBps() {
  return Number(await pub.readContract({ address: config.factory, abi: factoryAbi, functionName: 'protocolFeeBps' }));
}

/// The score table batches opened now use (zero address if none); create() reverts if it changed.
export async function factoryRatings() {
  return (await pub.readContract({ address: config.factory, abi: factoryAbi, functionName: 'ratings' })) as Address;
}

/// The creator share every batch opened now receives; set on the factory, not per batch.
export async function creatorFeeBps() {
  return Number(await pub.readContract({ address: config.factory, abi: factoryAbi, functionName: 'creatorFeeBps' }));
}
