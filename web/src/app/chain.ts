import {
  createPublicClient,
  createWalletClient,
  custom,
  http,
  type Address,
  type Chain,
  type EIP1193Provider,
  type Hash,
  type WalletClient,
} from 'viem';
import { foundry, mainnet, sepolia } from 'viem/chains';

export type Config = { chainId: number; credits: Address; factory: Address; sweeper: Address | null };

const CHAINS: Record<number, Chain> = { 1: mainnet, 11155111: sepolia, 31337: foundry };

export let config: Config;
export let chain: Chain;
export let pub: ReturnType<typeof makePublic>;

const makePublic = (c: Chain) =>
  createPublicClient({ chain: c, transport: http('/rpc', { batch: { wait: 16, batchSize: 40 } }) });

export async function loadConfig() {
  config = await (await fetch('/config.json')).json();
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
    localStorage.setItem('eighty-wallet', w?.info.rdns ?? 'injected');
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
    localStorage.removeItem('eighty-wallet');
  } catch {}
  emit();
}

/// Reconnect silently if the user connected before and the wallet still exposes the account.
export async function restore() {
  let saved: string | null = null;
  try {
    saved = localStorage.getItem('eighty-wallet');
  } catch {}
  if (!saved) return;
  await new Promise((r) => setTimeout(r, 50)); // let EIP-6963 wallets announce
  const w = wallets.find((x) => x.info.rdns === saved);
  const provider = w?.provider ?? (window as unknown as { ethereum?: EIP1193Provider }).ethereum;
  if (!provider) return;
  const accs = (await provider.request({ method: 'eth_accounts' })) as Address[];
  if (accs.length) await connect(w);
}

async function ensureChain() {
  const p = session.provider!;
  const current = Number(await p.request({ method: 'eth_chainId' }));
  if (current === chain.id) return;
  try {
    await p.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: `0x${chain.id.toString(16)}` }] });
  } catch {
    throw new Error(`Switch your wallet to ${chain.name}.`);
  }
}

/// Simulate, send, wait. Simulation surfaces the contract's revert reason before the wallet opens.
export async function send(
  req: { address: Address; abi: readonly unknown[]; functionName: string; args?: readonly unknown[]; value?: bigint; gas?: bigint },
  onHash?: (h: Hash) => void,
) {
  if (!session.wallet || !session.account) throw new Error('Connect a wallet first.');
  await ensureChain();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { request } = await pub.simulateContract({ ...(req as any), account: session.account });
  const hash = await session.wallet.writeContract({ ...request, chain } as never);
  onHash?.(hash);
  const receipt = await pub.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error('Transaction reverted.');
  return receipt;
}

export const explorer = (kind: 'tx' | 'address', v: string) =>
  chain.blockExplorers?.default ? `${chain.blockExplorers.default.url}/${kind}/${v}` : null;
