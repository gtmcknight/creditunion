/// One Balance (/balances/5): the artwork BALANCE mints a wallet the first time it receives any, as its contract draws
/// it, beside who holds it (a member, or one of our batches holding its members' BALANCE until payout) and its numbers
/// as its contract states them.
import { formatUnits, type Address } from 'viem';
import { tokenAdapterAbi } from '../abi';
import { config, pub, session } from '../chain';
import { tokenBatches, type Listed } from '../data';
import { hydrate, who } from '../ens';
import { balanceSrc, converted, type BalanceArt } from '../tokens';
import { launchGate } from '../swap';
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

/// What a converted batch pays each member (their share of the rating put in, after our fee) and our fee, and whether
/// each is paid yet; newest member reads come back together.
async function payoutsOf(union: Address) {
  const at = config.tokenAdapter!;
  const read = <T,>(functionName: string, args: readonly unknown[]) => pub.readContract({ address: at, abi: tokenAdapterAbi, functionName, args } as never) as Promise<T>;
  const [members, c] = await Promise.all([read<readonly Address[]>('membersOf', [union]), read<readonly [bigint, bigint, bigint, bigint, bigint, boolean, boolean]>('conversionOf', [union])]);
  const [net, fee] = [c[2], c[3]];
  const rows = await Promise.all(
    members.map(async (m) => {
      const [[put, total], paid] = await Promise.all([read<readonly [bigint, bigint]>('ratingOf', [union, m]), read<boolean>('claimed', [union, m])]);
      return { m, amount: total ? (net * put) / total : 0n, paid };
    }),
  );
  return { rows: rows.sort((x, y) => (y.amount > x.amount ? 1 : y.amount < x.amount ? -1 : 0)), fee, feePaid: c[5] };
}
const bal = (v: bigint) => Number(formatUnits(v, 18)).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

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
    fact('Owner', batch ? `<a href="/balance">${esc(batch.b.s.name || 'A batch')}</a> <span class="muted">· a batch, until payout</span>` : `<span class="bn-who">${who(nft.owner, 'sm', true)}${mine ? '<span class="tag you">You</span>' : ''}</span>`),
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
      ${batch ? '<section class="bn-pay" id="payouts"><div class="section-head"><h3>Payouts</h3></div><p class="muted small">Reading…</p></section>' : ''}
    </div>
  </section>`;
  hydrate(app);
  if (!batch) return;
  // Who this batch pays, and when: each member's share by the rating they put in, then our fee.
  const el = app.querySelector<HTMLElement>('#payouts')!;
  try {
    const token = config.balance?.token ?? null;
    const [{ rows, fee, feePaid }, gate] = await Promise.all([payoutsOf(batch.b.s.address), token ? launchGate(token).catch(() => null) : Promise.resolve(null)]);
    const opensAt = gate?.opensAt != null ? Date.now() + Number(gate.opensAt - gate.block) * 12_000 : null;
    const open = !!gate && (gate.opensAt === null || gate.block >= gate.opensAt);
    const when = opensAt ? new Date(opensAt).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' }).replace(/^(\w+)\s/, '$1\u00a0').replace(/\s([AP]M)$/, '\u202f$1') : ''; // held together, so a wrap never splits it
    const status = (paid: boolean) => (paid ? 'Paid' : open ? 'Ready to claim' : when ? `Pays ${when}` : 'Pays when trading opens');
    const you = session.account;
    // Before anyone's paid, every row would say the same: the time goes in the heading once instead.
    const waiting = !open && !feePaid && rows.every((x) => !x.paid);
    const value = (v: bigint, paid: boolean) => `<span class="num">${bal(v)}</span>${waiting ? '' : ` <span class="muted">· ${status(paid)}</span>`}`;
    el.innerHTML = `<div class="section-head"><h3>Payouts</h3><span class="muted num">${rows.length} member${rows.length === 1 ? '' : 's'}${waiting ? ` · ${when ? `pays ${when}` : 'pays when trading opens'}` : ''}</span></div>
      <dl class="facts">${rows
        .map((x) => fact(`<span class="bn-who">${who(x.m, 'sm', true)}${you && same(x.m, you) ? '<span class="tag you">You</span>' : ''}</span>`, value(x.amount, x.paid)))
        .join('')}${fee ? fact('<span class="muted">Credit Union’s 6%</span>', value(fee, feePaid)) : ''}</dl>`;
    hydrate(el);
  } catch {
    el.innerHTML = '<div class="section-head"><h3>Payouts</h3></div><p class="muted small">Couldn’t read the payouts. Refresh to try again.</p>';
  }
}
