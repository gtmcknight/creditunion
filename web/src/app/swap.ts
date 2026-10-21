/// Buy and Sell BALANCE in its Uniswap pool from /tokens. Quotes come from Uniswap's V4Quoter; the swap runs through
/// Uniswap's Universal Router (encoding in shared/v4swap.ts) with our fee taken as a slice of what comes out. Selling
/// pulls BALANCE through Permit2, approved once. Off until the Worker names the token (BALANCE_TOKEN), and greyed until
/// the token's transfer lock opens (its transfersOpenBlock).
import { erc20Abi, maxUint160, maxUint256, type Address } from 'viem';
import { PERMIT2, POOL_MANAGER, UNIVERSAL_ROUTER, V4_QUOTER, afterFee, ethPool, permit2Abi, quoterAbi, routerAbi, swapArgs, type PoolKey } from '../shared/v4swap';
import { config, pub } from './chain';

export type Market = { token: Address; key: PoolKey; decimals: number; symbol: string; feeBps: number; feeTo: Address | null; opensAt: bigint | null };

/// Most a quote may slip before the swap reverts: 1% on a buy, 3% on a sell. A launch-day pool falls fast while
/// holders sell, and a sell held to 1% mostly reverts, leaving the member holding as the price drops.
export const SLIPPAGE_BPS = 100n;
export const SELL_SLIPPAGE_BPS = 300n;
const APPROVAL_DAYS = 30;

const inkAbi = [{ type: 'function', name: 'inkOf', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256[4]' }] }] as const;
const lockAbi = [{ type: 'function', name: 'transfersOpenBlock', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint64' }] }] as const;

/// The token and its pool, or null while the Worker names none.
export async function market(): Promise<Market | null> {
  const b = config.balance;
  if (!b) return null;
  const [decimals, symbol, opensAt] = await Promise.all([
    pub.readContract({ address: b.token, abi: erc20Abi, functionName: 'decimals' }).catch(() => 18),
    pub.readContract({ address: b.token, abi: erc20Abi, functionName: 'symbol' }).catch(() => 'BALANCE'),
    // A token without a transfer lock is open from the start.
    pub.readContract({ address: b.token, abi: lockAbi, functionName: 'transfersOpenBlock' }).then(BigInt).catch(() => null),
  ]);
  // A token answering nonsense for decimals would otherwise freeze the page formatting its amounts.
  const d = Number(decimals);
  return { token: b.token, key: ethPool(b.token, b.pool), decimals: Number.isInteger(d) && d >= 0 && d <= 36 ? d : 18, symbol: String(symbol).slice(0, 16), feeBps: b.feeTo ? b.feeBps : 0, feeTo: b.feeTo, opensAt };
}

const gateAbi = [
  { type: 'function', name: 'ready', stateMutability: 'view', inputs: [], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'launchRetirement', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'totalRetired', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
] as const;

/// BALANCE as its launch stands: whether it takes anyone's Statement yet (its renderer registered with Statements and
/// its creator's launch supply retired; until both, a conversion or a redeem reverts, though its quote answers), and
/// the block its transfers open at (null: no lock). A read that fails counts as not yet.
export async function launchGate(token: Address): Promise<{ takes: boolean; opensAt: bigint | null; block: bigint }> {
  const read = <T,>(functionName: 'ready' | 'launchRetirement' | 'totalRetired') => pub.readContract({ address: token, abi: gateAbi, functionName }) as Promise<T>;
  const [ready, retire, retired, opensAt, block] = await Promise.all([
    read<boolean>('ready').catch(() => false),
    read<bigint>('launchRetirement').catch(() => null),
    read<bigint>('totalRetired').catch(() => null),
    pub.readContract({ address: token, abi: lockAbi, functionName: 'transfersOpenBlock' }).then(BigInt).catch(() => null),
    pub.getBlockNumber(),
  ]);
  return { takes: ready && retire !== null && retired !== null && retired >= retire, opensAt, block };
}

/// Whether the token can move yet, and the block it opens at.
export async function opened(m: Market): Promise<{ open: boolean; block: bigint }> {
  const block = await pub.getBlockNumber();
  return { open: m.opensAt === null || block >= m.opensAt, block };
}

/// What `amountIn` gets from the pool (buy: ETH in, sell: the token in), before and after our slice. Null when the pool
/// can't say (none yet, or not that deep).
export async function quote(m: Market, buy: boolean, amountIn: bigint): Promise<{ out: bigint; net: bigint } | null> {
  if (amountIn <= 0n) return null;
  try {
    const { result } = await pub.simulateContract({ address: V4_QUOTER, abi: quoterAbi, functionName: 'quoteExactInputSingle', args: [{ poolKey: m.key, zeroForOne: buy, exactAmount: amountIn, hookData: '0x' }] });
    return { out: result[0], net: afterFee(result[0], m.feeBps) };
  } catch {
    return null;
  }
}

/// 20 minutes from the chain's latest block (not this computer's clock, which can be off, as a fork's is).
const deadline = async () => (await pub.getBlock()).timestamp + 20n * 60n;
const floor = (net: bigint, bps = SLIPPAGE_BPS) => (net * (10_000n - bps)) / 10_000n;

/// The router call for a buy of `ethIn`, reverting under the quote less slippage.
export const buyCall = async (m: Market, ethIn: bigint, net: bigint) =>
  ({ address: UNIVERSAL_ROUTER, abi: routerAbi, functionName: 'execute', args: swapArgs({ key: m.key, buy: true, amountIn: ethIn, minOut: floor(net), feeBps: m.feeBps, feeTo: m.feeTo, deadline: await deadline() }), value: ethIn }) as const;

/// The calls a sell of `amountIn` needs, in order: the token's approval to Permit2 and Permit2's to the router when
/// either is short (once), then the swap.
export async function sellCalls(m: Market, owner: Address, amountIn: bigint, net: bigint) {
  const [erc, [allowed, expires]] = await Promise.all([
    pub.readContract({ address: m.token, abi: erc20Abi, functionName: 'allowance', args: [owner, PERMIT2] }) as Promise<bigint>,
    pub.readContract({ address: PERMIT2, abi: permit2Abi, functionName: 'allowance', args: [owner, m.token, UNIVERSAL_ROUTER] }) as Promise<readonly [bigint, number, number]>,
  ]);
  const now = Math.floor(Date.now() / 1000);
  const calls: { address: Address; abi: readonly unknown[]; functionName: string; args: readonly unknown[] }[] = [];
  if (erc < amountIn) calls.push({ address: m.token, abi: erc20Abi, functionName: 'approve', args: [PERMIT2, maxUint256] } as const);
  if (allowed < amountIn || Number(expires) < now + 60) calls.push({ address: PERMIT2, abi: permit2Abi, functionName: 'approve', args: [m.token, UNIVERSAL_ROUTER, maxUint160, now + APPROVAL_DAYS * 86_400] } as const);
  calls.push({ address: UNIVERSAL_ROUTER, abi: routerAbi, functionName: 'execute', args: swapArgs({ key: m.key, buy: false, amountIn, minOut: floor(net, SELL_SLIPPAGE_BPS), feeBps: m.feeBps, feeTo: m.feeTo, deadline: await deadline() }) } as const);
  return calls;
}

/// The colors BALANCE bought from the pool carries: the pool's own mix. The token keeps one per holding address, and all
/// of Uniswap v4 is one address (its PoolManager). Null for a token that keeps no colors.
export const poolPalette = (m: Market) => inkPalette(m, POOL_MANAGER);

/// An address's colors as shares of its ink (C, M, Y, K), or null when it has none or the token keeps no colors.
export async function inkPalette(m: Market, who: Address): Promise<[number, number, number, number] | null> {
  try {
    const ink = (await pub.readContract({ address: m.token, abi: inkAbi, functionName: 'inkOf', args: [who] })) as readonly bigint[];
    const sum = ink.reduce((a, b) => a + b, 0n);
    return sum ? (ink.map((v) => Number((v * 10_000n) / sum) / 10_000) as [number, number, number, number]) : null;
  } catch {
    return null;
  }
}
