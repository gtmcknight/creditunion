/// The keeper (a Cron Trigger, every 5 minutes): presses the buttons nobody is paid to press. It never burns: every
/// burn is a person pressing Convert Union to Statement (contracts/ADAPTER.md). Each run sends up to five transactions, most urgent
/// first, each only if it would land:
///   1. factory.activateAssembler(), once the 30-minute notice has run;
///   2. settle() on an auction that has ended;
///   3. claim(member) for a member whose payout failed at settle (anyone may send it for them), for three days;
///   4. record(union) on the adapter for a picture whose Credits moved since its spots were last written, so a leave
///      opens only the leaver's spot (contracts/ADAPTER.md). From the adapter's proposal on.
/// Every call is simulated first; nothing is sent while the keeper's last transactions are pending, or while
/// gas is over its cap. The key (secret KEEPER_KEY) holds no role in any contract: all it can lose is its gas money.
/// Without it, the keeper does nothing.
import { createPublicClient, createWalletClient, type Address, type Hex, type Transport } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { mainnet, sepolia } from 'viem/chains';
import { batchAbi, factoryAbi } from '../app/abi';
import { adapterAbi } from '../app/adapter-abi';

/// What the keeper reads of each Credit Union (Batch.summary and slots).
export type Kept = {
  address: Address;
  summary: { state: number; phase: number; highBid: bigint; auctionEnd: bigint };
  depositors: readonly Address[];
};

const ZERO = '0x0000000000000000000000000000000000000000';
const AUCTION = 3, SETTLED = 4; // Batch.State
const PAY_FOR = 3n * 86_400n; // how long after an auction ends a failed payout is retried
/// Up to this many a run, 5 minutes apart.
const PER_RUN = 5;

type Job = { what: string; address: Address; abi: typeof batchAbi | typeof factoryAbi | typeof adapterAbi; functionName: string; args?: readonly unknown[] };

export async function keep(o: { key: string; chainId: number; factory: Address; maxGwei: number; transport: Transport; unions: () => Promise<Kept[]> }) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(o.key)) return console.error('[keeper] KEEPER_KEY is not a private key');
  const chain = o.chainId === 1 ? mainnet : o.chainId === 11_155_111 ? sepolia : { ...mainnet, id: o.chainId };
  const account = privateKeyToAccount(o.key as Hex);
  const c = createPublicClient({ chain, transport: o.transport });

  // A run at a time: while its last transactions are pending, new ones would only race them.
  const [landed, nonce, block] = await Promise.all([
    c.getTransactionCount({ address: account.address, blockTag: 'latest' }),
    c.getTransactionCount({ address: account.address, blockTag: 'pending' }),
    c.getBlock(),
  ]);
  if (nonce > landed) return console.log('[keeper] waiting for its last transactions');
  if ((block.baseFeePerGas ?? 0n) > BigInt(Math.round(o.maxGwei * 1e9))) return console.warn(`[keeper] gas at ${block.baseFeePerGas} wei, over the ${o.maxGwei} gwei cap`);
  const now = block.timestamp;

  const jobs: Job[] = [];
  const read = (functionName: 'assembler' | 'pendingAssembler' | 'pendingUntil') => c.readContract({ address: o.factory, abi: factoryAbi, functionName });
  const [active, next, until] = await Promise.all([read('assembler'), read('pendingAssembler'), read('pendingUntil')]);
  if (active === ZERO && next !== ZERO && now >= BigInt(until)) jobs.push({ what: 'turn burning on', address: o.factory, abi: factoryAbi, functionName: 'activateAssembler' });

  const unions = await o.unions();
  for (const u of unions)
    if (u.summary.state === AUCTION && u.summary.highBid > 0n && now >= u.summary.auctionEnd) jobs.push({ what: `settle ${u.address}`, address: u.address, abi: batchAbi, functionName: 'settle' });
  for (const u of unions) {
    if (u.summary.state !== SETTLED || now >= u.summary.auctionEnd + PAY_FOR) continue;
    const members = [...new Set(u.depositors.map((d) => d.toLowerCase() as Address))];
    const owed = await Promise.all(members.map((m) => c.readContract({ address: u.address, abi: batchAbi, functionName: 'claimable', args: [m] }).catch(() => 0n)));
    members.forEach((m, i) => owed[i] > 0n && jobs.push({ what: `pay ${m} from ${u.address}`, address: u.address, abi: batchAbi, functionName: 'claim', args: [m] }));
  }
  // Spots, for unions that can still change hands. orderOf reverts for anything but a picture.
  const adapter = (active !== ZERO ? active : next) as Address;
  const live = adapter === ZERO ? [] : unions.filter((u) => u.summary.state < AUCTION);
  for (let i = 0; i < live.length; i += 20) {
    const part = live.slice(i, i + 20);
    const res = await c.multicall({
      contracts: part.flatMap((u) => [
        { address: adapter, abi: adapterAbi, functionName: 'orderOf', args: [u.address] } as const,
        { address: adapter, abi: adapterAbi, functionName: 'spotsOf', args: [u.address] } as const,
      ]),
      allowFailure: true,
    });
    part.forEach((u, k) => {
      const [order, kept] = [res[2 * k], res[2 * k + 1]];
      if (order.status !== 'success' || kept.status !== 'success') return;
      if (order.result.some((id, s) => id !== kept.result[s])) jobs.push({ what: `record ${u.address}'s spots`, address: adapter, abi: adapterAbi, functionName: 'record', args: [u.address] });
    });
  }
  if (!jobs.length) return;

  const w = createWalletClient({ account, chain, transport: o.transport });
  let sent = 0;
  for (const j of jobs) {
    if (sent >= PER_RUN) break;
    try {
      const { request } = await c.simulateContract({ address: j.address, abi: j.abi, functionName: j.functionName, args: j.args, account } as never);
      // Nonces counted here, not re-read from a node that may not have seen the last one yet.
      const hash = await w.writeContract({ ...(request as object), nonce: nonce + sent } as never);
      sent++;
      console.log(`[keeper] ${j.what}: ${hash}`);
    } catch (e) {
      const why = String((e as { shortMessage?: string; message?: string }).shortMessage ?? (e as Error).message ?? e).split('\n')[0];
      console.warn(`[keeper] can't ${j.what}: ${why}`);
    }
  }
}
