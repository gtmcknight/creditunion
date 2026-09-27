import type { Address } from 'viem';
import { batchAbi } from '../abi';
import { config, pub, send, session } from '../chain';
import { listBatches, myCredits, type Listed } from '../data';
import { hydrate, who } from '../ens';
import { fillGhosts } from '../ghosts';
import { art, errText, esc, eth, pageHead, same, toast } from '../ui';
import { card, mineIn } from './lists';
import { fitByBatch } from '../fit';

type Due = { b: Listed; claim: bigint; owed: bigint };
const TABS = ['Joined', 'Started', 'Can join', 'Credits'] as const;
type Tab = (typeof TABS)[number];
/// One plain line under each tab saying what it lists, for your own page or someone else's.
const NOTES: Record<Tab, (own: boolean) => string> = {
  Joined: (own) => `Credit Unions ${own ? 'you have' : 'they have'} deposited Credits into.`,
  Started: (own) => `Credit Unions ${own ? 'you' : 'they'} started.`,
  'Can join': (own) => `Open Credit Unions that ${own ? 'your' : 'their'} Credits fit, and how many of ${own ? 'yours' : 'theirs'} each can take.`,
  Credits: (own) => `Every Credit ${own ? 'you hold' : 'they hold'}: in ${own ? 'your' : 'their'} wallet, and deposited in Credit Unions.`,
};

/// Your Credits, the batches you're in or opened, and anything you can collect. With `member`, anyone's page:
/// their Credit Unions and Credits, read-only (your own address shows your own page).
export async function profile(app: HTMLElement, rerender: () => void, member?: Address) {
  const own = !member || same(member, session.account);
  const account = own ? session.account : member;
  if (!account) {
    app.innerHTML = `<section class="profile">${pageHead({ title: 'Your Credits', lede: 'Connect to see your Credits and Credit Unions.' })}<button class="btn primary" data-connect>Connect wallet</button></section>`;
    return;
  }

  const [owned, list] = await Promise.all([myCredits(account), listBatches()]);
  const mine = list.filter((b) => mineIn(b, account).size > 0 || same(b.s.creator, account));
  const deposited = mine.reduce((n, b) => n + mineIn(b, account).size, 0);

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
      tabs: TABS.map((t) => ({ label: `${t} <span class="num muted" id="n-${t.replace(' ', '-')}"></span>`, attrs: `data-tab="${t}"` })),
    })}
    ${dueBox}
    <div id="tab-body"></div>
  </section>`;

  // Tabs: Credit Unions they started, joined, and could join with Credits they hold; then their Credits, in the
  // wallet and deposited. "Can join" needs every Credit's traits, so its count fills in when ready.
  const started = list.filter((b) => same(b.s.creator, account));
  const joined = list.filter((b) => mineIn(b, account).size > 0);
  const inUnions = joined.flatMap((b) => [...mineIn(b, account)].map((id) => ({ id: BigInt(id), b })));
  let canJoin: Listed[] | null = null;
  let fits = new Map<string, bigint[]>();
  const count: Record<Tab, () => number | null> = {
    Started: () => started.length,
    Joined: () => joined.length,
    'Can join': () => canJoin?.length ?? null,
    Credits: () => owned.length + inUnions.length,
  };
  const grid = (bs: Listed[], empty: string) => (bs.length ? `<div class="grid">${bs.map((b) => card(b)).join('')}</div>` : `<p class="muted">${empty}</p>`);
  const tiles = (xs: { id: bigint; b?: Listed }[]) =>
    `<div class="picker lg static wallet-grid">${xs
      .map(({ id, b }) => {
        const t = `Credit #${id}${b ? ` · in ${esc(b.s.name || 'Untitled')}` : ''}`;
        const img = `<img src="${art(id)}" alt="Credit #${id}" loading="lazy">`;
        return `<a class="pick" href="/credit/${id}" title="${t}">${img}</a>`;
      })
      .join('')}</div>`;
  const body: Record<Tab, () => string> = {
    Started: () => grid(started, own ? 'You haven’t started a Credit Union yet. <a href="/create">Start one</a>' : 'Hasn’t started a Credit Union yet.'),
    Joined: () => grid(joined, own ? 'You’re not in any Credit Union yet. <a href="/unions">Browse Credit Unions</a>' : 'Not in any Credit Union yet.'),
    'Can join': () =>
      canJoin === null
        ? '<p class="muted">Checking which Credits fit…</p>'
        : canJoin.length
          ? `<div class="grid">${canJoin.map((b) => card(b, fits.get(b.s.address), own ? 'yours' : 'theirs')).join('')}</div>`
          : '<p class="muted">No open Credit Union takes these Credits right now.</p>',
    Credits: () =>
      `<div class="section-head"><h3>In wallet</h3><span class="muted num">${owned.length || ''}</span></div>${
        owned.length ? tiles([...owned].reverse().map((id) => ({ id }))) : `<p class="muted">None.${own && config.chainId !== 1 ? ' <a href="/mint">Mint test Credits →</a>' : ''}</p>`
      }<div class="section-head"><h3>Deposited</h3><span class="muted num">${inUnions.length || ''}</span></div>${inUnions.length ? tiles(inUnions) : '<p class="muted">None.</p>'}`,
  };
  const at = document.getElementById('tab-body')!;
  let tab: Tab = joined.length ? 'Joined' : started.length ? 'Started' : 'Credits';
  const draw = () => {
    for (const t of TABS) {
      const n = count[t]();
      const el = document.getElementById(`n-${t.replace(' ', '-')}`);
      if (el) el.textContent = n === null ? '' : String(n);
      app.querySelector(`[data-tab="${t}"]`)?.setAttribute('aria-selected', String(t === tab));
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
  fitByBatch(list.filter((b) => b.s.state === 'Open' && !mineIn(b, account).size), account).then((m) => {
    if (!at.isConnected) return;
    canJoin = list.filter((b) => m.has(b.s.address));
    fits = m as Map<string, bigint[]>;
    draw();
  });

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
