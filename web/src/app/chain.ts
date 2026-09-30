import {
  createPublicClient,
  createWalletClient,
  custom,
  formatEther,
  http,
  type Address,
  type Chain,
  type EIP1193Provider,
  type Hash,
  type WalletClient,
} from 'viem';
import { foundry, mainnet, sepolia } from 'viem/chains';

export type Config = {
  chainId: number;
  credits: Address;
  factory: Address;
  sweeper: Address | null;
  ratings: Address | null;
  /// FWA's marketplace on mainnet, a Buy Credits source.
  fwaMarket?: Address | null;
};

const CHAINS: Record<number, Chain> = { 1: mainnet, 11155111: sepolia, 31337: foundry };

export let config: Config;
export let chain: Chain;
export let pub: ReturnType<typeof makePublic>;

const makePublic = (c: Chain) =>
  // One retry, a second later: a busy moment passes, and a rate limit isn't hit four times in a row.
  createPublicClient({ chain: c, transport: http('/rpc', { batch: { wait: 16, batchSize: 40 }, retryCount: 1, retryDelay: 1_000 }) });

export async function loadConfig() {
  // Written into the page by the Worker (#config); pages the asset layer serves on its own ask for it.
  const inline = document.getElementById('config')?.textContent;
  config = inline ? JSON.parse(inline) : await (await fetch('/config.json')).json();
  chain = CHAINS[config.chainId] ?? { ...foundry, id: config.chainId };
  pub = makePublic(chain);
}

// ---------------------------------------------------------------- wallets (EIP-6963)

type Announced = { info: { uuid: string; name: string; icon: string; rdns: string }; provider: EIP1193Provider };
export const wallets: Announced[] = [];
window.addEventListener('eip6963:announceProvider', (e: Event) => {
  const d = (e as CustomEvent<Announced>).detail;
  if (!wallets.some((w) => w.info.uuid === d.info.uuid)) wallets.push(d);
});
window.dispatchEvent(new Event('eip6963:requestProvider'));

export const session: { account?: Address; wallet?: WalletClient; provider?: EIP1193Provider; rdns?: string } = {};
const listeners = new Set<() => void>();
export const onSession = (f: () => void) => listeners.add(f);
const emit = () => listeners.forEach((f) => f());

export async function connect(w?: Announced) {
  const provider = w?.provider ?? (window as unknown as { ethereum?: EIP1193Provider }).ethereum;
  if (!provider) throw new Error('No wallet found. Install a browser wallet such as Rainbow or MetaMask.');
  const [account] = (await provider.request({ method: 'eth_requestAccounts' })) as Address[];
  session.provider = provider;
  session.account = account;
  session.rdns = w?.info.rdns;
  session.wallet = createWalletClient({ account, chain, transport: custom(provider) });
  try {
    localStorage.setItem('cu-wallet', w?.info.rdns ?? 'injected');
  } catch {}
  provider.on?.('accountsChanged', (accs: Address[]) => {
    session.account = accs[0];
    session.wallet = accs[0] ? createWalletClient({ account: accs[0], chain, transport: custom(provider) }) : undefined;
    emit();
  });
  emit();
}

export function disconnect() {
  session.account = session.wallet = session.provider = undefined;
  try {
    localStorage.removeItem('cu-wallet');
    localStorage.removeItem('eighty-wallet');
  } catch {}
  emit();
}

/// Reconnect silently if the user connected before and the wallet still exposes the account.
export async function restore() {
  let saved: string | null = null;
  try {
    saved = localStorage.getItem('cu-wallet') ?? localStorage.getItem('eighty-wallet'); // the old key, from before the rename
  } catch {}
  if (!saved) return;
  await new Promise((r) => setTimeout(r, 50)); // let EIP-6963 wallets announce
  const w = wallets.find((x) => x.info.rdns === saved);
  const provider = w?.provider ?? (window as unknown as { ethereum?: EIP1193Provider }).ethereum;
  if (!provider) return;
  const accs = (await provider.request({ method: 'eth_accounts' })) as Address[];
  if (accs.length) await connect(w);
}

export async function ensureChain() {
  const p = session.provider!;
  const current = Number(await p.request({ method: 'eth_chainId' }));
  if (current === chain.id) return;
  try {
    await p.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: `0x${chain.id.toString(16)}` }] });
  } catch {
    throw new Error(`Switch your wallet to ${chain.name}.`);
  }
}

/// Run after each transaction we send settles (landed, reverted or refused), so cached reads start over.
const txDone = new Set<() => void>();
/// A transaction of ours that moved Credits (a buy, a deposit): tell the market book at once, so everyone else's
/// Buy list drops them within seconds. The Worker reads the receipt itself; this only says which to read.
const CREDIT_TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
function reportMoves(receipts: readonly { transactionHash: string; logs: readonly { address: string; topics: readonly string[] }[] }[]) {
  for (const r of receipts)
    if (r.logs.some((l) => l.address.toLowerCase() === config.credits.toLowerCase() && l.topics[0] === CREDIT_TRANSFER))
      void fetch('/market/moved', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tx: r.transactionHash }) }).catch(() => {});
}
export const onTx = (f: () => void) => txDone.add(f);
const settled = () => txDone.forEach((f) => f());

/// Simulate, send, wait. Simulation surfaces the contract's revert reason before the wallet opens.
export async function send(
  req: { address: Address; abi: readonly unknown[]; functionName: string; args?: readonly unknown[]; value?: bigint; gas?: bigint },
  onHash?: (h: Hash) => void,
) {
  if (!session.wallet || !session.account) throw new Error('Connect a wallet first.');
  await ensureChain();
  // Short of ETH, the node's simulation only says "Transaction creation failed." Say what's missing instead.
  if (req.value) {
    const have = BigInt((await session.provider!.request({ method: 'eth_getBalance', params: [session.account, 'latest'] })) as string);
    if (have < req.value) throw new Error(`Not enough ETH. This needs ${short(req.value)} plus gas; your wallet has ${short(have)}.`);
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { request } = await pub.simulateContract({ ...(req as any), account: session.account });
  try {
    const hash = await session.wallet.writeContract({ ...request, chain } as never);
    onHash?.(hash);
    // No time limit while the network can see it: a slow transaction is still pending, and calling it failed would
    // invite a second one. A speed-up in the wallet lands as this one; a cancel, or another transaction on its
    // nonce, doesn't. A hash the network never sees stops the wait instead, so the page isn't stuck on it.
    let replaced = '';
    let over = false;
    const landing = pub.waitForTransactionReceipt({ hash, timeout: 0, onReplaced: (r) => void (replaced = r.reason) });
    landing.finally(() => (over = true)).catch(() => {});
    const receipt = await Promise.race([landing, unseen(hash, () => over)]).catch((e) => {
      landing.then(settled, () => {}); // if it lands after all, reads still refresh
      throw e;
    });
    if (replaced === 'cancelled') throw new Error('Cancelled in wallet.');
    if (replaced === 'replaced') throw new Error('Replaced by another transaction in your wallet.');
    if (receipt.status !== 'success') throw new Error('Transaction reverted.');
    reportMoves([receipt]);
    return receipt;
  } finally {
    settled();
  }
}

const short = (wei: bigint) => `${Number(formatEther(wei)).toFixed(4)} ETH`;

/// Rejects once the network has gone UNSEEN_MS without seeing `hash`, pending or mined: the wallet signed it
/// but never sent it, or it was dropped. Rabby then keeps it as pending and fails every retry's simulation.
const UNSEEN_MS = 2 * 60_000;
async function unseen(hash: Hash, landed: () => boolean): Promise<never> {
  let since = Date.now();
  for (;;) {
    await new Promise((r) => setTimeout(r, 15_000));
    if (landed()) return new Promise<never>(() => {}); // the race is already over
    const seen = await pub.getTransaction({ hash }).then(
      () => true,
      (e: { name?: string }) => e?.name !== 'TransactionNotFoundError', // an RPC hiccup isn't evidence
    );
    if (seen) since = Date.now();
    else if (Date.now() - since >= UNSEEN_MS)
      throw new Error('Your wallet signed this but it never reached the network. Clear or cancel the pending transaction in your wallet, then try again.');
  }
}

/// Can the wallet run several calls as one atomic step on this chain (EIP-5792)? False on any doubt: an error,
/// no answer within a few seconds, or no atomic capability. Cached per account and chain.
const batchable = new Map<string, Promise<boolean>>();
export function canBatch(): Promise<boolean> {
  const { wallet, account } = session;
  if (!wallet || !account) return Promise.resolve(false);
  const key = `${account.toLowerCase()}:${chain.id}`;
  let p = batchable.get(key);
  if (!p) {
    p = Promise.race([
      wallet.getCapabilities({ account }).then((caps) => {
        const all = caps as Record<number, { atomic?: { status?: string }; atomicBatch?: { supported?: boolean } } | undefined>;
        const c = all[chain.id] ?? all[0];
        const s = c?.atomic?.status;
        return s === 'supported' || s === 'ready' || c?.atomicBatch?.supported === true;
      }),
      new Promise<boolean>((r) => setTimeout(() => r(false), 4000)),
    ]).catch(() => false);
    batchable.set(key, p);
  }
  return p;
}

type Call = { address: Address; abi: readonly unknown[]; functionName: string; args?: readonly unknown[] };

/// Several calls as one wallet step, all or nothing (EIP-5792 `wallet_sendCalls`), then wait for them to land.
/// Only the first call is simulated: the rest depend on it (an approval, then what it allows), and the RPC
/// proxy doesn't run multi-call simulations. The wallet estimates the batch itself before you sign.
export async function sendBatch(calls: Call[], onSubmit?: (id: string) => void) {
  if (!session.wallet || !session.account) throw new Error('Connect a wallet first.');
  await ensureChain();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await pub.simulateContract({ ...(calls[0] as any), account: session.account });
  const { id } = await session.wallet.sendCalls({
    account: session.account,
    chain,
    forceAtomic: true,
    calls: calls.map((c) => ({ to: c.address, abi: c.abi, functionName: c.functionName, args: c.args })) as never,
  });
  onSubmit?.(id);
  try {
    const res = await session.wallet.waitForCallsStatus({ id, timeout: 15 * 60_000 });
    if (res.status !== 'success' || res.receipts?.some((r) => r.status !== 'success')) throw new Error('Transaction reverted.');
    reportMoves(res.receipts ?? []);
    return res.receipts ?? [];
  } finally {
    settled();
  }
}

export const explorer = (kind: 'tx' | 'address', v: string) =>
  chain.blockExplorers?.default ? `${chain.blockExplorers.default.url}/${kind}/${v}` : null;
