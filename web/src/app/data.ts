import type { Address } from 'viem';
import { batchAbi, creditsAbi, factoryAbi } from './abi';
import { config, pub } from './chain';

export const STATES = ['Open', 'Full', 'Expired', 'Auction', 'Settled'] as const;
export type StateName = (typeof STATES)[number];

export const ARRANGEMENTS = ['Deposit order', 'Mint time', 'Credit number', 'Creator’s order'] as const;

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
  filter: { colors: `0x${string}`; print: `0x${string}`; weight: `0x${string}`; eights: `0x${string}` };
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
