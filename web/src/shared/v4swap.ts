/// Uniswap v4 swaps of one token against ETH through Uniswap's Universal Router: exact input, one pool, with our fee
/// taken as a slice of what comes out (TAKE_PORTION) and the rest, at least `minOut`, to the sender (TAKE_ALL).
/// Pure encoding and addresses: the page (app/swap.ts) and the fork rehearsal (scripts/swap-fork.mjs) both use it.
import { encodeAbiParameters, encodePacked, type Address, type Hex } from 'viem';

/// Uniswap's mainnet deployments (also present on a local copy of mainnet).
export const UNIVERSAL_ROUTER: Address = '0x66a9893cc07d91d95644aedd05d03f95e1dba8af';
export const PERMIT2: Address = '0x000000000022D473030F116dDEE9F6B43aC78BA3';
export const V4_QUOTER: Address = '0x52f0e24d1c21c8a0cb1e5a5dd6198556bd9e1203';
export const ETH: Address = '0x0000000000000000000000000000000000000000';
/// v4's one PoolManager: every pool's tokens sit here, so to a token it's one holding address.
export const POOL_MANAGER: Address = '0x000000000004444c5dc75cB358380D2e3dE08A90';
/// Ours, on the end of the swap box's Uniswap calls, the site's Statement buys and its redeems, so Activity can tell
/// them from everyone else's: an ERC-8021 attribution tag (the code "creditunion", its length, schema 0, the marker).
/// Contracts ignore trailing calldata.
export const SITE_TAG: Hex = '0x637265646974756e696f6e0b0080218021802180218021802180218021';

export type PoolKey = { currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address };
/// The pool's settings beyond its two currencies, as the launch picks them.
export type PoolSettings = { fee: number; tickSpacing: number; hooks: Address };

/// ETH against `token`: native ETH (address zero) always sorts first.
export const ethPool = (token: Address, p: PoolSettings): PoolKey => ({ currency0: ETH, currency1: token, fee: p.fee, tickSpacing: p.tickSpacing, hooks: p.hooks });

const V4_SWAP = 0x10; // Universal Router command
const SWAP_EXACT_IN_SINGLE = 0x06; // v4-periphery Actions
const SETTLE_ALL = 0x0c;
const TAKE_ALL = 0x0f;
const TAKE_PORTION = 0x10;

const KEY = [
  { name: 'currency0', type: 'address' },
  { name: 'currency1', type: 'address' },
  { name: 'fee', type: 'uint24' },
  { name: 'tickSpacing', type: 'int24' },
  { name: 'hooks', type: 'address' },
] as const;
/// ExactInputSingleParams as the deployed router reads them (v4-periphery 1.0, no per-hop price field).
const EXACT_IN_SINGLE = [
  {
    type: 'tuple',
    components: [
      { name: 'poolKey', type: 'tuple', components: KEY },
      { name: 'zeroForOne', type: 'bool' },
      { name: 'amountIn', type: 'uint128' },
      { name: 'amountOutMinimum', type: 'uint128' },
      { name: 'hookData', type: 'bytes' },
    ],
  },
] as const;

export const routerAbi = [
  { type: 'function', name: 'execute', stateMutability: 'payable', inputs: [{ name: 'commands', type: 'bytes' }, { name: 'inputs', type: 'bytes[]' }, { name: 'deadline', type: 'uint256' }], outputs: [] },
  // A failed command comes back wrapped; under a quote's minimum it's V4TooLittleReceived inside.
  { type: 'error', name: 'ExecutionFailed', inputs: [{ name: 'commandIndex', type: 'uint256' }, { name: 'message', type: 'bytes' }] },
  { type: 'error', name: 'V4TooLittleReceived', inputs: [{ name: 'minAmountOutReceived', type: 'uint256' }, { name: 'amountReceived', type: 'uint256' }] },
] as const;

export const quoterAbi = [
  {
    type: 'function',
    name: 'quoteExactInputSingle',
    stateMutability: 'nonpayable',
    inputs: [
      {
        name: 'params',
        type: 'tuple',
        components: [
          { name: 'poolKey', type: 'tuple', components: KEY },
          { name: 'zeroForOne', type: 'bool' },
          { name: 'exactAmount', type: 'uint128' },
          { name: 'hookData', type: 'bytes' },
        ],
      },
    ],
    outputs: [{ name: 'amountOut', type: 'uint256' }, { name: 'gasEstimate', type: 'uint256' }],
  },
] as const;

export const permit2Abi = [
  {
    type: 'function',
    name: 'allowance',
    stateMutability: 'view',
    inputs: [{ name: 'owner', type: 'address' }, { name: 'token', type: 'address' }, { name: 'spender', type: 'address' }],
    outputs: [{ name: 'amount', type: 'uint160' }, { name: 'expiration', type: 'uint48' }, { name: 'nonce', type: 'uint48' }],
  },
  {
    type: 'function',
    name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'token', type: 'address' }, { name: 'spender', type: 'address' }, { name: 'amount', type: 'uint160' }, { name: 'expiration', type: 'uint48' }],
    outputs: [],
  },
] as const;

/// What reaches the sender out of `out` once our slice (`feeBps` of it, rounded down, as TAKE_PORTION does) is taken.
export const afterFee = (out: bigint, feeBps: number) => out - (out * BigInt(feeBps)) / 10_000n;

/// `execute` arguments for an exact-input swap of `amountIn` through `key`: buy is ETH in and the token out, sell the
/// other way. `feeBps` of the output goes to `feeTo`; the sender gets the rest and the swap reverts under `minOut`.
export function swapArgs(o: { key: PoolKey; buy: boolean; amountIn: bigint; minOut: bigint; feeBps: number; feeTo: Address | null; deadline: bigint }) {
  const zeroForOne = o.buy; // currency0 is ETH
  const tokenIn = o.buy ? o.key.currency0 : o.key.currency1;
  const tokenOut = o.buy ? o.key.currency1 : o.key.currency0;
  const fee = !!o.feeTo && o.feeBps > 0;
  // The pool has to give enough that the sender still gets minOut after our slice.
  const poolMin = fee ? (o.minOut * 10_000n) / BigInt(10_000 - o.feeBps) : o.minOut;
  const actions = fee ? [SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE_PORTION, TAKE_ALL] : [SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE_ALL];
  const params: Hex[] = [
    encodeAbiParameters(EXACT_IN_SINGLE, [{ poolKey: o.key, zeroForOne, amountIn: o.amountIn, amountOutMinimum: poolMin, hookData: '0x' }]),
    encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [tokenIn, o.amountIn]),
    ...(fee ? [encodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'uint256' }], [tokenOut, o.feeTo!, BigInt(o.feeBps)])] : []),
    encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [tokenOut, o.minOut]),
  ];
  const packed = `0x${actions.map((a) => a.toString(16).padStart(2, '0')).join('')}` as Hex;
  const input = encodeAbiParameters([{ type: 'bytes' }, { type: 'bytes[]' }], [packed, params]);
  return [encodePacked(['uint8'], [V4_SWAP]), [input], o.deadline] as const;
}
