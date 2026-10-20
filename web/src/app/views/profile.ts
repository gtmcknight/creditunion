import { erc20Abi, formatUnits, type Address } from 'viem';
import { fmtScore } from '../../shared/credits';
import { batchAbi, tokenAdapterAbi } from '../abi';
import { bin } from '../bins';
import { config, pub, send, session } from '../chain';
import { listBatches, myCredits, ratingTotal, tokenBatches, type Listed } from '../data';
import { hydrate, who } from '../ens';
import { fillGhosts } from '../ghosts';
import { market, opened } from '../swap';
import { balanceArt, balanceHref, balanceSrc, converted, type BalanceArt } from '../tokens';
import { INK } from '../traits';
import { art, errText, esc, eth, pageHead, same, toast } from '../ui';
import { fullStatus, mineIn, status } from './lists';
import { creditCell } from './trait';
import { activityItems, activityOf } from './live';

type Due = { b: Listed; claim: bigint; owed: bigint };
const TOKEN = '$BALANCE';
/// What a wallet holds here, and what it has done. `key` is the ?tab= the account menu links to.
export const PROFILE_TABS = [
  { key: 'credits', label: 'Credits' },
  { key: 'statements', label: 'Statements' },
  { key: 'balance', label: 'Balance' },
  { key: 'activity', label: 'Activity' },
] as const;
type Tab = (typeof PROFILE_TABS)[number]['key'];
/// One plain line under each tab saying what it lists, for your own page or someone else's.
const NOTES: Record<Tab, (own: boolean) => string> = {
  credits: (own) => `Credits ${own ? 'you hold' : 'they hold'}: in ${own ? 'your' : 'their'} wallet, and deposited where ${own ? 'you' : 'they'} can still take them back.`,
  statements: (own) => `Statements in ${own ? 'your' : 'their'} wallet. Each one redeems for its rating in ${TOKEN}.`,
  balance: (own) => `${TOKEN} ${own ? 'you hold' : 'they hold'}, and ${TOKEN} coming from ${own ? 'your' : 'their'} Credits in batches.`,
  activity: (own) => `What ${own ? 'you have' : 'they have'} done on Credit Union, newest first.`,
};

/// A wallet's Credits, Statements and $BALANCE, and anything it can collect. With `member`, anyone's page, read-only
/// (your own address shows your own page). Credit Unions whose Statement is made (at auction, sold, or converted into
/// $BALANCE) aren't listed: what they paid shows as ETH to collect or as $BALANCE, and the Activity tab keeps the story.
export async function profile(app: HTMLElement, rerender: () => void, member?: Address) {
  const own = !member || same(member, session.account);
  const account = own ? session.account : member;
  if (!account) {
    app.innerHTML = `<section class="profile">${pageHead({ title: 'Your Credits', lede: 'Connect to see your Credits, Statements and $BALANCE.' })}<button class="btn primary" data-connect>Connect wallet</button></section>`;
    return;
  }

  // Each Credit's rating, from the edition's score table (the Credits tab's tiles), and what a token batch pays for
  // it (its own table, as /balance reckons it): asked for first, so they land while the chain is read (the browser
  // keeps them for a year). The Credits tab says "Loading…" until the first does, and shows the Credits alone if it never does.
  let scoreOf: Uint32Array | undefined;
  let paysOf: Uint16Array | undefined;
  const scoring = bin('credit-score.bin').then((b) => (scoreOf = new Uint32Array(b)), () => (scoreOf = new Uint32Array(0)));
  const paying = bin('scores-live.bin').then((b) => (paysOf = new Uint16Array(b)), () => (paysOf = new Uint16Array(0)));
  // Auction unions from the index, and token batches ($BALANCE) from their own factory.
  const [owned, list] = await Promise.all([myCredits(account), Promise.all([listBatches(), tokenBatches().catch(() => [] as Listed[])]).then(([a, b]) => [...a, ...b])]);
  const mine = list.filter((b) => mineIn(b, account).size > 0 || same(b.s.creator, account));

  // What's collectable: sale shares on settled batches, and refunds whose automatic send failed.
  const dues: Due[] = (
    await Promise.all(
      (own ? mine : []).map(async (b): Promise<Due> => {
        const [claim, owed] = await Promise.all([
          b.s.state === 'Settled'
            ? pub.readContract({ address: b.s.address, abi: batchAbi, functionName: 'claimable', args: [account] })
            : 0n,
          pub.readContract({ address: b.s.address, abi: batchAbi, functionName: 'owed', args: [account] }),
        ]);
        return { b, claim: claim as bigint, owed: owed as bigint };
      }),
    )
  ).filter((d) => d.claim > 0n || d.owed > 0n);

  const dueBox = dues.length
    ? `<section class="box dues-box">
    <h3>Ready to collect</h3>
    <div class="dues">${dues
      .map(
        (d) => `<div class="due">
        <a href="/union/${d.b.s.address}">${esc(d.b.s.name || 'Untitled')}</a>
        <span class="num muted">${d.claim ? `${eth(d.claim)} share` : ''}${d.claim && d.owed ? ' · ' : ''}${d.owed ? `${eth(d.owed)} refund` : ''}</span>
        <button class="btn sm primary" data-collect="${d.b.s.address}" data-claim="${d.claim > 0n}" data-owed="${d.owed > 0n}">Collect</button>
      </div>`,
      )
      .join('')}</div>
  </section>`
    : '';

  app.innerHTML = `
  <section class="profile">
    ${pageHead({
      title: who(account, 'lg'),
      lede: `<span class="mono profile-addr">${account}</span>`,
      label: 'Member',
      tabs: PROFILE_TABS.map((t) => ({ label: `${t.label} <span class="num muted" id="n-${t.key}"></span>`, attrs: `data-tab="${t.key}"` })),
    })}
    ${dueBox}
    <div id="tab-body"></div>
  </section>`;

  // Credits still in a batch: one filling, full, or expired with Credits to take back. Once a batch's Statement is
  // made its Credits are gone (at auction, sold, or converted), so it's no longer theirs to show.
  const holding = (b: Listed) => (b.s.state === 'Open' || b.s.state === 'Full' || b.s.state === 'Expired') && !converted(b.s.statement);
  const inBatches = list.filter((b) => holding(b) && mineIn(b, account).size);
  const deposited = inBatches.flatMap((b) => [...mineIn(b, account)].map((id) => BigInt(id)));
  const score = (id: bigint) => (scoreOf?.[Number(id) - 1] ?? 0) / 10_000;
  // A section's count, and the rating of all its Credits together, as a Statement of them would state it.
  const headN = (ids: readonly bigint[]) => (ids.length ? `${ids.length}${scoreOf?.length ? ` · Rating ${ratingTotal(ids.map(score)).toLocaleString('en-US')}` : ''}` : '');
  // The explorer's tile, as every grid of Credits: art, number, rating.
  const tiles = (ids: bigint[]) =>
    `<div class="trait-grid">${ids.map((id) => creditCell(Number(id), '', { title: `Credit #${id}`, line: score(id) ? `Rating ${fmtScore(score(id))}` : '' })).join('')}</div>`;
  // Where a batch stands: how full it is, or what's become of it once full.
  const standing = (b: Listed) =>
    b.s.state === 'Open' ? `${b.s.count} of 80` : b.s.state === 'Full' ? (b.s.phase === 'Waiting' ? 'Full' : `Full · ${fullStatus(b.s)}`) : status(b.s);
  // Deposited Credits in one grid like the wallet's, closest-to-full batch first (expired last), each tile's rating and
  // then how full its batch is and which (a long name ends in an ellipsis, the count first so it always shows).
  const byBatch = [...inBatches].sort((x, y) => (x.s.state === 'Expired' ? 1 : 0) - (y.s.state === 'Expired' ? 1 : 0) || y.s.count - x.s.count);
  const depositTiles = () =>
    `<div class="trait-grid">${byBatch
      .flatMap((b) =>
        [...mineIn(b, account)]
          .map((id) => BigInt(id))
          .sort((x, y) => score(y) - score(x))
          .map((id) =>
            creditCell(Number(id), '', {
              title: `Credit #${id} · in ${b.s.name || 'a batch'}`,
              line: [score(id) ? `Rating ${fmtScore(score(id))}` : '', `${b.s.state === 'Open' ? `${b.s.count}/80` : b.s.state === 'Full' ? 'Full' : esc(status(b.s))} · <a href="/union/${b.s.address}">${esc(b.s.name || 'Untitled')}</a>`],
            }),
          ),
      )
      .join('')}</div>`;
  // The way to the Balance page from each tab of your own page: what you hold, turned into $BALANCE there.
  const feeBps = list.find((b) => b.token && b.s.state === 'Open')?.s.protocolFeeBps ?? 600;
  const convertsTo = (ids: readonly bigint[]) => Math.floor((ids.reduce((n, id) => n + (paysOf?.[Number(id) - 1] ?? 0), 0) / 10) * (1 - feeBps / 10_000));
  const cta = (label: string, primary = true) => (own ? `<a class="btn sm${primary ? ' primary' : ''} section-cta" href="/balance">${label}</a>` : '');

  // Statements in the wallet, each with its rating (read by the Worker over every Statement).
  let stmts: { id: string; rating: number }[] | undefined;

  // $BALANCE: in the wallet once the token is named, owed by batches already converted, and expected from Credits in
  // token batches (their rating after the fee each batch opened with, as /balance reckons it).
  let held = 0n;
  let owed: { b: Listed; amount: bigint }[] = [];
  let open = false;
  // The wallet's Balance (its BALANCE artwork), once read: it stands for what's in the wallet.
  let mineArt: BalanceArt | null = null;
  const whole = (v: bigint) => Number(formatUnits(v, 18)).toLocaleString('en-US', { maximumFractionDigits: 0 });
  const expectedOf = (b: Listed) => Math.floor(([...mineIn(b, account)].reduce((n, id) => n + (paysOf?.[Number(id) - 1] ?? 0), 0) / 10) * (1 - b.s.protocolFeeBps / 10_000));
  const coming = () => inBatches.filter((b) => b.token);
  const balanceTotal = () => Number(formatUnits(held + owed.reduce((a, o) => a + o.amount, 0n), 18)) + (paysOf ? coming().reduce((n, b) => n + expectedOf(b), 0) : 0);
  // One shape for every row, as /balance's Yours panel: a small picture, a bold line, grey lines under it, one action.
  const chip = `<span class="tk-yart"><span class="sw-ink">${INK.map((c) => `<i style="background:${c}"></i>`).join('')}</span></span>`;
  const fan = (ids: readonly bigint[]) => `<span class="tk-yart tk-fan">${ids.slice(0, 3).map((id) => `<img src="${art(id)}" alt="" loading="lazy">`).join('')}</span>`;
  const row = (pic: string, title: string, sub: string[], action = '') =>
    `<div class="tk-yrow">${pic}<div class="tk-ytext"><b>${title}</b>${sub.filter(Boolean).map((l) => `<span class="muted small">${l}</span>`).join('')}</div>${action}</div>`;
  const plural = (n: number) => `${n} Credit${n === 1 ? '' : 's'}`;
  const balanceHtml = () => {
    const ins = mineArt
      ? `<div class="made-row"><a class="made" href="${balanceHref(mineArt)}"><img src="${balanceSrc(mineArt)}" alt="Balance #${mineArt.id}" decoding="async"><span class="small">Balance #${mineArt.id}</span></a></div>`
      : held > 0n
        ? row(chip, `${whole(held)} ${TOKEN}`, [own ? 'In your wallet' : 'In their wallet'])
        : '';
    const rows = [
      ...owed.map((o) =>
        row(
          chip,
          `${whole(o.amount)} ${TOKEN}`,
          [`Converted in ${esc(o.b.s.name || 'a batch')}`, open ? 'Ready to claim' : 'Lands in the wallet when trading opens'],
          open && own ? '<a class="tk-yact go" href="/balance">Claim</a>' : '',
        ),
      ),
      ...coming().map((b) => {
        const ids = [...mineIn(b, account)].map((id) => BigInt(id));
        return row(fan(ids), paysOf?.length ? `${expectedOf(b).toLocaleString('en-US')} ${TOKEN} expected` : TOKEN, [`${plural(ids.length)} in <a href="/union/${b.s.address}">${esc(b.s.name || 'a batch')}</a>`, standing(b)]);
      }),
    ];
    const more = cta(owned.length && paysOf?.length ? `Convert ${plural(owned.length)} for ≈ ${convertsTo(owned).toLocaleString('en-US')} ${TOKEN}` : `Get more ${TOKEN}`);
    if (!ins && !rows.length) return `<p class="muted">No ${TOKEN} yet.</p>${own ? `<p>${cta(owned.length && paysOf?.length ? `Convert ${plural(owned.length)} for ≈ ${convertsTo(owned).toLocaleString('en-US')} ${TOKEN}` : `Get ${TOKEN}`)}</p>` : ''}`;
    return `${ins ? `<div class="section-head"><h3>In wallet</h3>${more}</div><div>${ins}</div>` : ''}${rows.length ? `<div class="section-head"><h3>Coming</h3>${ins ? '' : more}</div><div>${rows.join('')}</div>` : ''}`;
  };

  // What they've done, from the site-wide feed; the tab's count fills in when it's read (undefined while it is,
  // null if it couldn't be).
  let activity: Awaited<ReturnType<typeof activityOf>> | undefined;
  const count: Record<Tab, () => string> = {
    credits: () => String(owned.length + deposited.length),
    statements: () => (stmts ? String(stmts.length) : ''),
    balance: () => {
      const n = balanceTotal();
      return n ? Math.floor(n).toLocaleString('en-US') : '';
    },
    activity: () => (activity ? String(activity.length) : ''),
  };
  const body: Record<Tab, () => string> = {
    credits: () =>
      owned.length + deposited.length && !scoreOf
        ? '<p class="muted">Loading…</p>'
        : `<div class="section-head"><h3>In wallet</h3><span class="muted num">${headN(owned)}</span>${
            owned.length ? cta(paysOf?.length ? `Convert for ≈ ${convertsTo(owned).toLocaleString('en-US')} ${TOKEN}` : `Convert to ${TOKEN}`) : cta(`Get ${TOKEN}`)
          }</div>${
            owned.length ? tiles([...owned].reverse()) : `<p class="muted">None.${own && config.chainId !== 1 ? ' <a href="/mint">Mint test Credits →</a>' : ''}</p>`
          }${deposited.length ? `<div class="section-head"><h3>Deposited</h3><span class="muted num">${headN(deposited)}</span></div>${depositTiles()}` : ''}`,
    statements: () =>
      stmts === undefined
        ? '<p class="muted">Loading…</p>'
        : stmts.length
          ? `<div class="section-head"><h3>In wallet</h3><span class="muted num">${stmts.length} · Rating ${stmts.reduce((n, x) => n + x.rating, 0).toLocaleString('en-US')}</span>${cta(`Redeem for ${TOKEN}`, false)}</div><div class="made-row">${stmts
              .map((x) => `<a class="made" href="/statement/${x.id}"><img src="/statement/${x.id}.svg" alt="Statement #${x.id}" loading="lazy" decoding="async"><span class="small">#${x.id}<span class="muted num"> · Rating ${x.rating.toLocaleString('en-US')}</span></span></a>`)
              .join('')}</div>`
          : `<p class="muted">${own ? 'No Statements yet. <a href="/statements">Browse Statements</a>' : 'No Statements yet.'}</p>`,
    balance: () => (!paysOf && coming().length ? '<p class="muted">Loading…</p>' : balanceHtml()),
    activity: () => (activity === undefined ? '<p class="muted">Loading…</p>' : `<ol class="live-list fold-list">${activityItems(activity, { member: true })}</ol>`),
  };
  const at = document.getElementById('tab-body')!;
  // ?tab= (the account menu's links) opens that tab; otherwise Credits, or $BALANCE for a wallet whose Credits are
  // all on their way to it.
  const asked = PROFILE_TABS.find((t) => t.key === new URLSearchParams(location.search).get('tab'))?.key;
  let tab: Tab = asked ?? (!owned.length && coming().length && coming().length === inBatches.length ? 'balance' : 'credits');
  const draw = () => {
    for (const t of PROFILE_TABS) {
      const el = document.getElementById(`n-${t.key}`);
      if (el) el.textContent = count[t.key]();
      app.querySelector(`[data-tab="${t.key}"]`)?.setAttribute('aria-selected', String(t.key === tab));
    }
    at.innerHTML = `<p class="muted tab-note">${NOTES[tab](own)}</p>${body[tab]()}`;
    hydrate(at);
    fillGhosts(at);
  };
  app.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach((b) =>
    b.addEventListener('click', () => {
      tab = b.dataset.tab as Tab;
      draw();
    }),
  );
  draw();
  const redraw = () => {
    if (at.isConnected) draw();
  };
  void activityOf({ member: account }).then((rows) => {
    activity = rows;
    redraw();
  });
  void scoring.then(redraw);
  void paying.then(redraw);
  void fetch(`/statements/owned/${account}.json`)
    .then((r) => r.json() as Promise<{ items?: { id: string; rating: number }[] }>)
    .then((j) => (stmts = j.items ?? []), () => (stmts = []))
    .then(redraw);
  void balanceArt(account).then((a) => {
    mineArt = a;
    if (a) redraw();
  });
  // $BALANCE held and owed: only once the token and the adapter are named (the launch); before that there's none.
  void (async () => {
    const token = config.balance?.token ?? null;
    const done = list.filter((b) => b.token && converted(b.s.statement));
    const [h, o, m] = await Promise.all([
      token ? (pub.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [account] }) as Promise<bigint>).catch(() => 0n) : Promise.resolve(0n),
      config.tokenAdapter
        ? Promise.all(
            done.map(async (b) => ({
              b,
              amount: (await pub.readContract({ address: config.tokenAdapter!, abi: tokenAdapterAbi, functionName: 'claimable', args: [b.s.address, account] }).catch(() => 0n)) as bigint,
            })),
          )
        : Promise.resolve([]),
      market().catch(() => null),
    ]);
    held = h;
    owed = o.filter((x) => x.amount > 0n);
    open = m ? (await opened(m).catch(() => ({ open: false }))).open : false;
    redraw();
  })();

  hydrate(app);

  app.querySelectorAll<HTMLButtonElement>('[data-collect]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      const batch = btn.dataset.collect as Address;
      btn.disabled = true;
      btn.textContent = 'Collecting…';
      try {
        if (btn.dataset.claim === 'true')
          await send({ address: batch, abi: batchAbi, functionName: 'claim', args: [account] });
        if (btn.dataset.owed === 'true') await send({ address: batch, abi: batchAbi, functionName: 'withdrawOwed' });
        toast('Collected.', 'ok');
        rerender();
      } catch (e) {
        toast(errText(e), 'err', 8000);
        btn.disabled = false;
        btn.textContent = 'Collect';
      }
    }),
  );
}
