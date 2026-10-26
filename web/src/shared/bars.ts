/// Bars: edition reads and BarRouter math the swap box and the melt keeper share (the router's ABI is barRouterAbi in
/// app/abi.ts). Pure encoding and math; the page and the scripts bring their own client. Every Bar holds the $BALANCE
/// deposited at its mint and melts back into it, so a Bar listed below that $BALANCE's value in the pool is a
/// buy-melt-sell that pays.
import type { Address, Log } from 'viem';
import { decodeEventLog } from 'viem';
import type { PoolKey } from './v4swap';

/// The edition's events as far as a scan needs them: what each Bar holds, and which are gone.
export const barsAbi = [
  { type: 'event', name: 'Minted', inputs: [{ name: 'id', type: 'uint256', indexed: true }, { name: 'to', type: 'address', indexed: true }, { name: 'vault', type: 'address', indexed: false }, { name: 'amount', type: 'uint256', indexed: false }] },
  { type: 'event', name: 'Melted', inputs: [{ name: 'id', type: 'uint256', indexed: true }, { name: 'owner', type: 'address', indexed: true }, { name: 'amount', type: 'uint256', indexed: false }] },
  { type: 'function', name: 'isOpen', stateMutability: 'view', inputs: [], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'mintEnd', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint64' }] },
] as const;

/// Uniswap's v4 quoter, exact output: what ETH buys exactly `amount` $BALANCE (a mint's swap).
export const quoterExactOutAbi = [
  {
    type: 'function',
    name: 'quoteExactOutputSingle',
    stateMutability: 'nonpayable',
    inputs: [
      {
        name: 'params',
        type: 'tuple',
        components: [
          { name: 'poolKey', type: 'tuple', components: [{ name: 'currency0', type: 'address' }, { name: 'currency1', type: 'address' }, { name: 'fee', type: 'uint24' }, { name: 'tickSpacing', type: 'int24' }, { name: 'hooks', type: 'address' }] },
          { name: 'zeroForOne', type: 'bool' },
          { name: 'exactAmount', type: 'uint128' },
          { name: 'hookData', type: 'bytes' },
        ],
      },
    ],
    outputs: [{ name: 'amountIn', type: 'uint256' }, { name: 'gasEstimate', type: 'uint256' }],
  },
] as const;

/// The quoter arguments for a mint holding `amount`: ETH (currency0) in, exactly `amount` $BALANCE out.
export const mintQuoteArgs = (key: PoolKey, amount: bigint) => [{ poolKey: key, zeroForOne: true, exactAmount: amount, hookData: '0x' as const }] as const;

/// What to send for a mint whose swap was quoted at `ethIn`: the swap, our fee on it, and `slipBps` of room for the
/// pool to move before it lands. The router returns whatever isn't used.
export const mintValue = (ethIn: bigint, feeBps: number, slipBps: number) => {
  const withSlip = ethIn + (ethIn * BigInt(slipBps)) / 10_000n;
  return withSlip + (withSlip * BigInt(feeBps)) / 10_000n;
};

/// Every live Bar and the $BALANCE it holds, from the edition's Minted and Melted logs (any order).
export function holdings(logs: Log[]): Map<bigint, bigint> {
  const minted = new Map<bigint, bigint>();
  const melted = new Set<bigint>();
  for (const l of logs) {
    const e = decodeEventLog({ abi: barsAbi, data: l.data, topics: l.topics, strict: false });
    if (e.eventName === 'Minted' && e.args.id != null && e.args.amount != null) minted.set(e.args.id, e.args.amount);
    if (e.eventName === 'Melted' && e.args.id != null) melted.add(e.args.id);
  }
  for (const id of melted) minted.delete(id);
  return minted;
}

/// One Bar for sale, priced in wei, and what it holds.
export type BarListing = { id: bigint; price: bigint; holds: bigint };
/// A pick: the listings to buy together, what they cost, what they hold, and what selling that $BALANCE should bring.
export type MeltPick = { listings: BarListing[]; cost: bigint; holds: bigint; ethOut: bigint; profit: bigint };

/// The melt keeper's choice: the listings whose $BALANCE sells for more than they cost, best edge first, kept while
/// the whole set still clears `minProfit` once sold together. `sellQuote` prices selling a total in the pool (one
/// swap, so the set's price impact counts); `gasWei` is the call's cost and comes off the profit.
export async function meltPick(
  listings: BarListing[],
  sellQuote: (balance: bigint) => Promise<bigint>,
  o: { gasWei: bigint; minProfit: bigint; max?: number },
): Promise<MeltPick | null> {
  // Edge per listing at the pool's price for its own size: a first cut that drops anything above its backing.
  const edged: { l: BarListing; edge: bigint }[] = [];
  for (const l of listings) {
    if (l.holds === 0n) continue;
    const edge = (await sellQuote(l.holds)) - l.price;
    if (edge > 0n) edged.push({ l, edge });
  }
  edged.sort((a, b) => (b.edge > a.edge ? 1 : b.edge < a.edge ? -1 : 0));

  // Add listings while the set, sold as one swap, still makes more than without the last one.
  let best: MeltPick | null = null;
  const set: BarListing[] = [];
  for (const { l } of edged.slice(0, o.max ?? 20)) {
    set.push(l);
    const cost = set.reduce((s, x) => s + x.price, 0n);
    const holds = set.reduce((s, x) => s + x.holds, 0n);
    const ethOut = await sellQuote(holds);
    const profit = ethOut - cost - o.gasWei;
    if (best && profit <= best.profit) {
      set.pop();
      continue;
    }
    best = { listings: [...set], cost, holds, ethOut, profit };
  }
  return best && best.profit >= o.minProfit ? best : null;
}

/// What a `meltForBalance` buyer gets per ETH, fee included, against what the pool gives: the swap box shows the
/// cheaper of the two as the $BALANCE route.
export const balancePerEth = (holds: bigint, cost: bigint, feeBps: number) =>
  cost === 0n ? 0n : (holds * 10n ** 18n) / (cost + (cost * BigInt(feeBps)) / 10_000n);

/// `meltForEth`'s `minProfit` for a pick: half the quoted edge, so a pool that moves a little still lands and one that
/// moves a lot reverts instead of losing.
export const minProfitFor = (p: MeltPick) => (p.profit > 0n ? p.profit / 2n : 0n);

export type BarsConfig = { edition: Address; router: Address; fromBlock: bigint } | null;
