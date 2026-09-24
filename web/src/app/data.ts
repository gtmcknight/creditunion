import type { Address } from 'viem';
import { batchAbi, creditsAbi, factoryAbi } from './abi';
import { config, pub } from './chain';

export const STATES = ['Open', 'Full', 'Expired', 'Auction', 'Settled'] as const;
export type StateName = (typeof STATES)[number];

export type Summary = {
  address: Address;
  state: StateName;
  name: string;
  creator: Address;
  count: number;
  deadline: number;
  filledAt: number;
  assembledAt: number;
  auctionEnd: number;
  reserve: bigint;
  minBid: bigint;
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
  };
}

export async function listBatches(limit = 60): Promise<{ s: Summary; ids: readonly bigint[] }[]> {
  const addrs = await pub.readContract({
    address: config.factory,
    abi: factoryAbi,
    functionName: 'batches',
    args: [0n, BigInt(limit)],
  });
  return Promise.all(
    addrs.map(async (a) => {
      const [s, ids] = await Promise.all([
        pub.readContract({ address: a, abi: batchAbi, functionName: 'summary' }),
        pub.readContract({ address: a, abi: batchAbi, functionName: 'ids' }),
      ]);
      return { s: toSummary(a, s as Record<string, unknown>), ids };
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
