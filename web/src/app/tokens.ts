/// Token unions: unions from the second factory, whose burn puts the Statement in the vault and pays each member
/// tokens (contracts/src/TokenAdapter.sol). Nothing here runs until config.tokenAdapter is set.
import { erc20Abi, formatUnits, type Address } from 'viem';
import { factoryAbi, tokenAdapterAbi } from './abi';
import { config, pub, send, session } from './chain';
import { same } from './ui';

/// Token unions can be made: the factory and its adapter are deployed.
export const tokensOn = () => !!config.tokenFactory && !!config.tokenAdapter;

/// A burned union whose receipt came from TokenAdapter: it converted instead of auctioning.
export const converted = (statement?: string) => !!config.tokenAdapter && same(statement, config.tokenAdapter);

const known = new Map<string, Promise<boolean>>();
/// Whether a union (burned or not) is a token union, read once per page.
export const isTokenUnion = (union: Address) =>
  known.get(union.toLowerCase()) ??
  (known.set(
    union.toLowerCase(),
    config.tokenFactory
      ? (pub.readContract({ address: config.tokenFactory, abi: factoryAbi, functionName: 'isBatch', args: [union] }) as Promise<boolean>).catch(() => false)
      : Promise.resolve(false),
  ),
  known.get(union.toLowerCase())!);

/// Whether a token union's current 80 are rated (TokenAdapter.rate), which its burn needs.
export const isRated = (union: Address) => pub.readContract({ address: config.tokenAdapter!, abi: tokenAdapterAbi, functionName: 'rated', args: [union] }) as Promise<boolean>;

let meta: Promise<{ token: Address; symbol: string; decimals: number }> | null = null;
const tokenMeta = () =>
  (meta ??= (async () => {
    const token = (await pub.readContract({ address: config.tokenAdapter!, abi: tokenAdapterAbi, functionName: 'token' })) as Address;
    const [symbol, decimals] = await Promise.all([
      pub.readContract({ address: token, abi: erc20Abi, functionName: 'symbol' }).catch(() => 'tokens'),
      pub.readContract({ address: token, abi: erc20Abi, functionName: 'decimals' }).catch(() => 18),
    ]);
    return { token, symbol: String(symbol), decimals: Number(decimals) };
  })());

const amount = (v: bigint, decimals: number) => Number(formatUnits(v, decimals)).toLocaleString('en-US', { maximumFractionDigits: 2 });

/// The box a converted union shows instead of its auction: what the Statement paid, per Credit, yours, and the one
/// button that pays everyone (or just you, when everyone else is paid).
export async function mountTokens(el: HTMLElement, union: Address, run: (btn: HTMLElement | null, label: string, fn: () => Promise<unknown>, ok: string) => Promise<unknown>, rerender: () => void) {
  el.innerHTML = '<div class="box"><p class="muted">Reading tokens…</p></div>';
  try {
    const [{ symbol, decimals }, c] = await Promise.all([
      tokenMeta(),
      pub.readContract({ address: config.tokenAdapter!, abi: tokenAdapterAbi, functionName: 'conversionOf', args: [union] }) as Promise<readonly [bigint, bigint, bigint, bigint, bigint, boolean, boolean]>,
    ]);
    const [, total, , protocolFee, creatorFee] = c;
    const you = session.account;
    const [mine, [put, all]] = you
      ? await Promise.all([
          pub.readContract({ address: config.tokenAdapter!, abi: tokenAdapterAbi, functionName: 'claimable', args: [union, you] }) as Promise<bigint>,
          pub.readContract({ address: config.tokenAdapter!, abi: tokenAdapterAbi, functionName: 'ratingOf', args: [union, you] }) as Promise<readonly [bigint, bigint]>,
        ])
      : [0n, [0n, 0n] as const];
    const net = total - protocolFee - creatorFee;
    const yours = all > 0n ? (net * put) / all : 0n; // by the rating you put in

    const fees = !c[5] || !c[6];
    el.innerHTML = `<div class="box">
      <div class="bid-now"><div><span>Converted</span><strong class="num">${amount(total, decimals)}</strong><em class="sub">${symbol}</em></div><div><span>Yours</span><strong class="num">${amount(yours, decimals)}</strong><em class="sub">${put ? `${((Number(put) / Number(all)) * 100).toFixed(1)}% of the rating` : symbol}</em></div></div>
      ${mine > 0n || fees ? `<div class="stack"><button class="btn primary block" id="token-pay">${mine > 0n ? `Pay out · ${amount(mine, decimals)} ${symbol} are yours` : 'Pay out'}</button><p class="small muted center">Sends every member their tokens. Anyone can press it.</p></div>` : '<p class="small muted">Every member is paid.</p>'}
    </div>`;
    el.querySelector('#token-pay')?.addEventListener('click', (e) =>
      run(e.currentTarget as HTMLElement, 'Paying out…', () => send({ address: config.tokenAdapter!, abi: tokenAdapterAbi, functionName: 'distribute', args: [union] }), 'Paid out.').then(rerender),
    );
  } catch {
    el.innerHTML = '<div class="box"><p class="muted">Couldn’t read the tokens. Try again in a moment.</p></div>';
  }
}
