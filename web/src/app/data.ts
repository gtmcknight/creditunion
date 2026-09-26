import type { Address } from 'viem';
import { batchAbi, creditsAbi, factoryAbi } from './abi';
import { config, pub } from './chain';

export const STATES = ['Open', 'Full', 'Expired', 'Auction', 'Settled'] as const;
export type StateName = (typeof STATES)[number];

export const ARRANGEMENTS = ['Deposit order', 'Mint time', 'Credit number', 'Creator’s order', 'Painted'] as const;
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

export type Rated = {
  id: string;
  paidAt: number;
  score: number;
  rank: number;
  traits: { palette: string; activeBits: number; occupied: number; eights: number; registration: string };
  tails: number[];
};

export async function ratings(ids: readonly bigint[]): Promise<{ n: number; version: string; ratings: Record<string, Rated> }> {
  const r = await fetch('/ratings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids: ids.map(String) }) });
  if (!r.ok) throw new Error('Ratings unavailable.');
  return r.json();
}

export type Summary = {
  address: Address;
  state: StateName;
  arrangement: number;
  split: number;
  canAssemble: boolean;
  exitWindow: boolean;
  exitWindowUntil: number;
  name: string;
  creator: Address;
  count: number;
  deadline: number;
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
    count: Number(s.count),
    deadline: Number(s.deadline),
    filledAt: Number(s.filledAt),
    assembledAt: Number(s.assembledAt),
    auctionEnd: Number(s.auctionEnd),
    exitWindowUntil: Number(s.exitWindowUntil),
    arrangement: Number(s.arrangement),
    split: Number(s.split),
    allowlistSize: Number(s.allowlistSize),
    filter: { ...(s.filter as Summary['filter']), paidFrom: Number((s.filter as { paidFrom: bigint }).paidFrom), paidTo: Number((s.filter as { paidTo: bigint }).paidTo) },
    creatorFeeBps: Number(s.creatorFeeBps),
    protocolFeeBps: Number(s.protocolFeeBps),
  };
}

export type Listed = { s: Summary; ids: readonly bigint[]; depositors: readonly Address[] };

export async function listBatches(limit = 60): Promise<Listed[]> {
  const addrs = await pub.readContract({
    address: config.factory,
    abi: factoryAbi,
    functionName: 'batches',
    args: [0n, BigInt(limit)],
  });
  return Promise.all(
    addrs.map(async (a) => {
      const [s, slots] = await Promise.all([
        pub.readContract({ address: a, abi: batchAbi, functionName: 'summary' }),
        pub.readContract({ address: a, abi: batchAbi, functionName: 'slots' }),
      ]);
      return { s: toSummary(a, s as Record<string, unknown>), ids: slots[0], depositors: slots[1] };
    }),
  );
}

export async function getBatch(a: Address) {
  const [s, slots] = await Promise.all([
    pub.readContract({ address: a, abi: batchAbi, functionName: 'summary' }),
    pub.readContract({ address: a, abi: batchAbi, functionName: 'slots' }),
  ]);
  return { s: toSummary(a, s as Record<string, unknown>), ids: slots[0], depositors: slots[1] };
}

export async function me(batch: Address, account: Address) {
  const [shares, claimable, owed, approved, owned] = await Promise.all([
    pub.readContract({ address: batch, abi: batchAbi, functionName: 'sharesOf', args: [account] }),
    pub.readContract({ address: batch, abi: batchAbi, functionName: 'claimable', args: [account] }),
    pub.readContract({ address: batch, abi: batchAbi, functionName: 'owed', args: [account] }),
    isApproved(account),
    myCredits(account),
  ]);
  return { shares: Number(shares), claimable, owed, approved, owned };
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

/// Which of `ids` pass a batch's filter, asked of the batch itself (it reads Jack's art contract).
export async function eligible(batch: Address, ids: readonly bigint[]) {
  const ok = await Promise.all(
    ids.map((id) => pub.readContract({ address: batch, abi: batchAbi, functionName: 'passes', args: [id] })),
  );
  return ids.filter((_, i) => ok[i]);
}

export async function minOpen() {
  return Number(await pub.readContract({ address: config.factory, abi: factoryAbi, functionName: 'minOpen' }));
}

export async function protocolFeeBps() {
  return Number(await pub.readContract({ address: config.factory, abi: factoryAbi, functionName: 'protocolFeeBps' }));
}

/// The creator share every batch opened now receives; set on the factory, not per batch.
export async function creatorFeeBps() {
  return Number(await pub.readContract({ address: config.factory, abi: factoryAbi, functionName: 'creatorFeeBps' }));
}
