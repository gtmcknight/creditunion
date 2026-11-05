/// Bars: edition reads and BarRouter math the swap box and the melt keeper share (the router's ABI is barRouterAbi in
/// app/abi.ts). Pure encoding and math; the page and the scripts bring their own client. Every Bar keeps its $BALANCE in
/// its own vault and melts back into all of it (the deposit plus anything sent there), so a Bar listed below that
/// $BALANCE's value in the pool is a buy-melt-sell that pays.
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

/// Every live Bar and the $BALANCE deposited at its mint, from the edition's Minted and Melted logs (any order). What it
/// melts for can be more: the worker reads each vault (barHoldings).
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

export type BarsConfig = { edition: Address; router: Address; buyer?: Address | null; fromBlock: bigint } | null;

/// Code 128 bar and space widths for each symbol value, then Start B (104) and Stop.
const C128 = '212222 222122 222221 121223 121322 131222 122213 122312 132212 221213 221312 231212 112232 122132 122231 113222 123122 123221 223211 221132 221231 213212 223112 312131 311222 321122 321221 312212 322112 322211 212123 212321 232121 111323 131123 131321 112313 132113 132311 211313 231113 231311 112133 112331 132131 113123 113321 133121 313121 211331 231131 213113 213311 213131 311123 311321 331121 312113 312311 332111 314111 221411 431111 111224 111422 121124 121421 141122 141221 112214 112412 122114 122411 142112 142211 241211 221114 413111 241112 134111 111242 121142 121241 114212 124112 124211 411212 421112 421211 212141 214121 412121 111143 111341 131141 114113 114311 411113 411311 113141 114131 311141 411131 211412 211214 211232'.split(' ');
const STOP = '2331112';

/// `text` as Code 128 (set B): the module widths, bar first, start to stop with the checksum. A Bar's art is the barcode
/// of its number, so the box draws a Bar as one too.
export function code128(text: string): number[] {
  const vals = [...text].map((ch) => ch.charCodeAt(0) - 32);
  const check = (104 + vals.reduce((s, v, i) => s + v * (i + 1), 0)) % 103;
  return [C128[104], ...vals.map((v) => C128[v]), C128[check], STOP].join('').split('').map(Number);
}

/// A Bar as a picture: white paper, the barcode of `text` across the middle two thirds, as a data URL for an <img>.
export function barArtSrc(text: string): string {
  const w = code128(text), m = w.reduce((a, b) => a + b, 0);
  const n = Math.round(m / 0.66), rows = Math.round((n * 24) / 135);
  let x = (n - m) / 2;
  const rects: string[] = [];
  w.forEach((v, i) => {
    if (i % 2 === 0) rects.push(`<rect x="${x}" y="${(n - rows) / 2}" width="${v}" height="${rows}"/>`);
    x += v;
  });
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" shape-rendering="crispEdges"><rect width="${n}" height="${n}" fill="#fff"/>${rects.join('')}</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}
