/// One Balance (/balances/5): the artwork BALANCE mints a wallet the first time it receives any, as its contract draws
/// it, beside who holds it (a member, or one of our batches holding its members' BALANCE until payout) and its numbers
/// as its contract states them.
import { type Address } from 'viem';
import { tokenAdapterAbi } from '../abi';
import { config, pub, session } from '../chain';
import { tokenBatches, type Listed } from '../data';
import { hydrate, who } from '../ens';
import { balanceSrc, converted, type BalanceArt } from '../tokens';
import { INK } from '../traits';
import { esc, same } from '../ui';
import { creditsHead } from './trait';

type Nft = BalanceArt & { owner: Address; attributes: { trait_type: string; value: string | number }[] };
const fact = (k: string, v: string) => `<div><dt>${k}</dt><dd>${v}</dd></div>`;

/// The converted batch whose pocket (its own wallet) holds this Balance, and the Statement it converted.
async function batchOf(owner: Address): Promise<{ b: Listed; statementId: bigint } | null> {
  const at = config.tokenAdapter;
  if (!at) return null;
  const done = (await tokenBatches()).filter((b) => converted(b.s.statement));
  const pockets = await Promise.all(done.map((b) => (pub.readContract({ address: at, abi: tokenAdapterAbi, functionName: 'pocketOf', args: [b.s.address] }) as Promise<Address>).catch(() => null)));
  const i = pockets.findIndex((p) => !!p && same(p, owner));
  if (i < 0) return null;
  const c = (await pub.readContract({ address: at, abi: tokenAdapterAbi, functionName: 'conversionOf', args: [done[i].s.address] })) as readonly bigint[];
  return { b: done[i], statementId: c[0] };
}

export async function balanceNft(app: HTMLElement, raw: string) {
  const n = /^\d{1,7}$/.test(raw) ? Number(raw) : 0;
  const title = `Balance #${n.toLocaleString('en-US')}`;
  const r = n ? await fetch(`/balance-art/${n}.json`).catch(() => null) : null;
  const nft = r?.ok ? ((await r.json()) as Nft) : null;
  if (!nft?.id) {
    const why = r?.status === 404 ? 'Not made yet. A wallet gets its Balance the first time it receives $BALANCE.' : 'Couldn’t read it. Try again in a moment.';
    app.innerHTML = `<div class="jb">${creditsHead('balances', `#${n}`)}</div><section class="prose"><h1>${title}</h1><p class="muted">${why}</p></section>`;
    return;
  }
  const batch = await batchOf(nft.owner).catch(() => null);
  const trait = (k: string) => nft.attributes.find((a) => a.trait_type === k)?.value;
  const num = (v: unknown) => (typeof v === 'number' ? v : Number(String(v ?? '').replace(/,/g, '')));
  const amount = num(trait('Balance'));
  const inks = ['Cyan %', 'Magenta %', 'Yellow %', 'Black %'].map((k) => num(trait(k)));
  const first = num(trait('First received'));
  const made = num(trait('Statements converted'));
  const mine = !!session.account && same(nft.owner, session.account);

  const facts = [
    fact('Owner', batch ? `<a href="/balance">${esc(batch.b.s.name || 'A batch')}</a> <span class="muted">· a batch, until payout</span>` : `${who(nft.owner, 'sm', true)}${mine ? ' <span class="tag you">You</span>' : ''}`),
    Number.isFinite(amount) ? fact('Balance', `<span class="num">${amount.toLocaleString('en-US', { maximumFractionDigits: 2 })}</span> $BALANCE`) : '',
    inks.every(Number.isFinite) ? fact('Colors', `<span class="num bn-inks">${inks.map((p, i) => `<span><span class="sw-ink"><i style="background:${INK[i]}"></i></span>${p.toFixed(1)}%</span>`).join('')}</span>`) : '',
    batch ? fact('From', `<a href="/statement/${batch.statementId}">Statement #${batch.statementId}</a>`) : made > 0 ? fact('Converted', `<span class="num">${made}</span> Statement${made === 1 ? '' : 's'}`) : '',
    first > 0 ? fact('Since', new Date(first * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })) : '',
  ].join('');

  app.innerHTML = `
  <div class="jb">${creditsHead('balances', `#${n}`)}</div>
  <section class="batch credit-page">
    <div class="st-col">
      <div class="credit-art st-page-art"><img class="statement-art" src="${balanceSrc(nft)}" alt="${title}" decoding="async"></div>
    </div>
    <div class="batch-side">
      <header><h1>${title}</h1></header>
      <dl class="facts">${facts}</dl>
    </div>
  </section>`;
  hydrate(app);
}
