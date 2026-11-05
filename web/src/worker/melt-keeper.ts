/// The melt keeper (the cron, every 5 minutes, once MELT_KEEPER_KEY is set): when Bars are listed for less than the
/// $BALANCE inside them sells for, it buys them, melts them and sells the $BALANCE in one BarRouter.meltForEth call,
/// which reverts unless the wallet ends with more ETH than it sent. So a run either makes money or costs only the gas
/// of a call that never lands: every call is simulated first, and nothing is sent while its last one is pending or
/// gas is over its cap. The key is its own wallet (not KEEPER_KEY's): it fronts the listings' ETH and keeps the profit.
import { createPublicClient, createWalletClient, parseAbi, type Address, type Hex, type Transport } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { mainnet } from 'viem/chains';
import { barRouterAbi } from '../app/abi';
import { meltPick, minProfitFor, type BarListing } from '../shared/bars';
import { quoterAbi, V4_QUOTER, type PoolKey } from '../shared/v4swap';

/// A listed Bar as the keeper sees it: its id, price and $BALANCE inside, and how to fill it.
export type MeltListing = { id: string; price: string; holds: string; hash: string; protocol: string };

/// Gas for one meltForEth: the swap and call around it, then each Bar's Seaport fill and melt (measured on a fork at
/// about 0.45M for one Bar and 0.2M for each more; kept above that).
const GAS_BASE = 400_000n, GAS_PER_BAR = 250_000n;

export async function meltKeep(o: {
  key: string;
  chainId: number;
  transport: Transport;
  router: Address;
  /// The edition: nothing melts until its mint window closes.
  edition: Address;
  pool: PoolKey;
  maxGwei: number;
  /// Least profit worth a transaction, after gas.
  minProfit: bigint;
  listings: () => Promise<MeltListing[]>;
  /// The listing's signed Seaport order, filled for the router.
  fill: (l: MeltListing) => Promise<{ order: unknown; value: bigint } | null>;
}) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(o.key)) return console.error('[melt] MELT_KEEPER_KEY is not a private key');
  const chain = o.chainId === 1 ? mainnet : { ...mainnet, id: o.chainId };
  const account = privateKeyToAccount(o.key as Hex);
  const c = createPublicClient({ chain, transport: o.transport });
  const [landed, nonce, block, have] = await Promise.all([
    c.getTransactionCount({ address: account.address, blockTag: 'latest' }),
    c.getTransactionCount({ address: account.address, blockTag: 'pending' }),
    c.getBlock(),
    c.getBalance({ address: account.address }),
  ]);
  if (nonce > landed) return console.log('[melt] waiting for its last transaction');
  if (!(await c.readContract({ address: o.edition, abi: parseAbi(['function isMeltOpen() view returns (bool)']), functionName: 'isMeltOpen' }).catch(() => false))) return;
  const base = block.baseFeePerGas ?? 0n;
  if (base > BigInt(Math.round(o.maxGwei * 1e9))) return console.warn(`[melt] gas at ${base} wei, over the ${o.maxGwei} gwei cap`);

  const listed = await o.listings();
  if (!listed.length) return;
  // What selling `balance` in the pool brings, with the pool's own fee: the router sells there with no slice of ours.
  const sellQuote = async (balance: bigint) => {
    try {
      const { result } = await c.simulateContract({ address: V4_QUOTER, abi: quoterAbi, functionName: 'quoteExactInputSingle', args: [{ poolKey: o.pool, zeroForOne: false, exactAmount: balance, hookData: '0x' }] });
      return result[0];
    } catch {
      return 0n;
    }
  };
  const asBars: BarListing[] = listed.map((l) => ({ id: BigInt(l.id), price: BigInt(l.price), holds: BigInt(l.holds) }));
  const tip = base / 5n + 1_000_000_000n;
  // Gas counted for the most a pick might take; the pick itself only adds a Bar while the set makes more.
  const pick = await meltPick(asBars, sellQuote, { gasWei: (GAS_BASE + GAS_PER_BAR * BigInt(Math.min(asBars.length, 10))) * (base + tip), minProfit: o.minProfit, max: 10 });
  if (!pick) return;
  if (pick.cost > have) return console.warn(`[melt] ${pick.listings.length} Bars would pay ${pick.profit} wei, but the wallet holds ${have} of the ${pick.cost} they cost`);

  const chosen = pick.listings.map((b) => listed.find((l) => l.id === String(b.id))!);
  const fills = (await Promise.all(chosen.map((l) => o.fill(l).catch(() => null)))).filter((f): f is NonNullable<typeof f> => !!f);
  if (fills.length < chosen.length) return console.log('[melt] some of those Bars sold before the fill; next run');
  const value = fills.reduce((a, f) => a + f.value, 0n);
  try {
    const { request } = await c.simulateContract({
      address: o.router,
      abi: barRouterAbi,
      functionName: 'meltForEth',
      args: [fills.map((f) => f.order) as never, BigInt(fills.length), minProfitFor(pick)],
      value,
      account,
    });
    const hash = await createWalletClient({ account, chain, transport: o.transport }).writeContract({ ...request, nonce, maxPriorityFeePerGas: tip } as never);
    console.log(`[melt] ${fills.length} Bars for ${value} wei, about ${pick.profit} wei over: ${hash}`);
    return hash;
  } catch (e) {
    console.warn(`[melt] skipped: ${String((e as { shortMessage?: string }).shortMessage ?? e).split('\n')[0]}`);
  }
}
