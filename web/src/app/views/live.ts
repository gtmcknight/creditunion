import type { Address, Hex } from 'viem';
import { explorer, session } from '../chain';
import { hydrate, who } from '../ens';
import { art, esc, eth, pageHead, same } from '../ui';
import { listBatches } from '../data';

/// /activity.json's rows (worker/activity.ts).
type Item = {
  kind: 'started' | 'deposited' | 'withdrew' | 'burned' | 'bid' | 'won' | 'claimed' | 'bought';
  who: Address;
  union?: Address;
  name?: string;
  ids?: number[];
  count?: number;
  eth?: string;
  intoUnion?: boolean;
  time: number;
  tx: Hex;
  i: number;
};

const POLL = 20_000;
/// Rows shown on /activity before Show more.
const PAGE = 100;
/// Credits shown per row; the rest are counted in the words.
const THUMBS = 6;

const keyOf = (x: Item) => `${x.tx}:${x.i}:${x.kind}`;
const credits = (n: number) => `${n} ${n === 1 ? 'Credit' : 'Credits'}`;

function ago(t: number) {
  const d = Math.max(0, Math.floor(Date.now() / 1000 - t));
  return d < 60 ? 'just now' : d < 3600 ? `${Math.floor(d / 60)}m ago` : d < 86400 ? `${Math.floor(d / 3600)}h ago` : `${Math.floor(d / 86400)}d ago`;
}

/// What they did, in plain words, with the union linked. On the union's own page (`here`) it goes without saying.
function what(x: Item, here = false) {
  const u = x.union ? `<a href="/union/${esc(x.union)}">${esc(x.name || 'a Credit Union')}</a>` : '';
  const n = x.count ?? x.ids?.length ?? 0;
  const e = x.eth ? eth(BigInt(x.eth)) : '';
  switch (x.kind) {
    case 'started':
      return here ? 'started this Credit Union' : `started ${u}`;
    case 'deposited':
      return here ? `deposited ${credits(n)}` : `deposited ${credits(n)} into ${u}`;
    case 'withdrew':
      return here ? `withdrew ${credits(n)}` : `withdrew ${credits(n)} from ${u}`;
    case 'bought':
      return x.intoUnion && !here ? `bought ${credits(n)} into ${u} for ${e}` : `bought ${credits(n)} for ${e}`;
    case 'burned':
      return here ? 'burned 80 Credits into a Statement' : `burned ${u} into a Statement`;
    case 'bid':
      return here ? `bid ${e}` : `bid ${e} on ${u}`;
    case 'won':
      return here ? `won the Statement for ${e}` : `won ${u} for ${e}`;
    case 'claimed':
      return here ? `got ${e}` : `got ${e} from ${u}`; // settling pays members; a claim only follows a failed send
  }
}

/// /activity.json slices (the Worker cuts them from its full list, cached 15 s). Each query is read at most once
/// per 15 seconds per page view, unless `fresh`.
type Slice = { items: Item[]; more: boolean };
const reads = new Map<string, { at: number; p: Promise<Slice> }>();
function readActivity(query: string, fresh = false): Promise<Slice> {
  const hit = reads.get(query);
  if (!fresh && hit && Date.now() - hit.at < 15_000) return hit.p;
  const p = fetch(`/activity.json?${query}`, { cache: 'no-cache' }).then(async (r) => {
    const j = (await r.json()) as { items?: Item[]; more?: boolean; error?: string };
    if (!r.ok || j.error) throw new Error(j.error ?? 'unavailable');
    return { items: j.items ?? [], more: !!j.more };
  });
  const entry = { at: Date.now(), p };
  reads.set(query, entry);
  p.catch(() => reads.get(query) === entry && reads.delete(query));
  return p;
}

/// A union's rows (`union`) or a wallet's (`member`), newest first, all of them; null when the feed can't be read.
export async function activityOf(o: { union?: Address; member?: Address }, fresh = false): Promise<Item[] | null> {
  const q = o.union ? `union=${o.union}` : o.member ? `member=${o.member}` : '';
  if (!q) return [];
  const got = await readActivity(`${q}&limit=1000`, fresh).catch(() => null);
  return got && got.items.filter((x) => (o.union ? !!x.union && same(x.union, o.union) : same(x.who, o.member!)));
}
/// Those rows as list items: on a union's page the union goes without saying; on a member's page, who does.
export const activityItems = (rows: Item[] | null, o: { union?: boolean; member?: boolean }) =>
  !rows
    ? '<li class="muted live-empty">Couldn’t load activity. Try again in a minute.</li>'
    : rows.length
      ? rows.map((x) => row(x, { here: o.union, who: !o.member })).join('')
      : '<li class="muted live-empty">Nothing yet.</li>';

/// A union's Activity: the page draws #activity-list (and #activity-all, its Show all) inside #activity. `bid` is the
/// union's high bid as read onchain: the feed runs a few seconds behind the chain, so until it has that bid, the bid
/// shows at the top anyway and the list reads again.
export async function activityFold(union: Address, bid?: { who: Address; wei: bigint }, tries = 0) {
  const list = document.getElementById('activity-list');
  if (!list) return;
  let rows = await activityOf({ union }, tries > 0);
  if (!list.isConnected) return;
  if (rows && bid && bid.wei > 0n && !rows.some((x) => x.kind === 'bid' && same(x.who, bid.who) && x.eth === String(bid.wei))) {
    rows = [{ kind: 'bid', who: bid.who, union, eth: String(bid.wei), time: Math.floor(Date.now() / 1000), tx: '0x', i: 0 }, ...rows];
    if (tries < 6) setTimeout(() => list.isConnected && void activityFold(union, bid, tries + 1), 10_000);
  }
  const count = document.getElementById('activity-count');
  if (count) count.textContent = rows?.length ? String(rows.length) : '';
  list.innerHTML = activityItems(rows, { union: true });
  // A short list shows the latest three, and a link to the rest.
  const all = document.getElementById('activity-all');
  if (all && list.classList.contains('short')) {
    const n = rows?.length ?? 0;
    all.hidden = n <= 3;
    all.textContent = 'Show all';
    all.onclick = () => {
      list.classList.remove('short');
      all.hidden = true;
      hydrate(list);
    };
  }
  // Its names are looked up once someone opens it, not for every row of a fold nobody opened.
  const fold = list.closest('details');
  if (fold && !fold.open) fold.addEventListener('toggle', () => fold.open && hydrate(list), { once: true });
  else hydrate(list);
}

function row(x: Item, o: { here?: boolean; who?: boolean } = {}) {
  const me = session.account && same(x.who, session.account) ? '<span class="tag you">You</span>' : '';
  const ids = x.ids ?? [];
  const thumbs = ids.length
    ? `<span class="live-art">${ids
        .slice(0, THUMBS)
        .map((id) => `<a href="/credit/${id}" title="Credit #${id}"><img src="${art(id)}" alt="" loading="lazy" decoding="async"></a>`)
        .join('')}${ids.length > THUMBS ? `<span class="muted small num">+${ids.length - THUMBS}</span>` : ''}</span>`
    : '<span class="live-art"></span>'; // an empty cell keeps the time column lined up
  const tx = x.tx !== '0x' ? explorer('tx', x.tx) : null; // 0x: a bid read onchain the feed hasn't caught yet
  const when = `<span class="num" data-time="${x.time}">${x.time ? ago(x.time) : ''}</span>`;
  return `<li class="live-row" data-key="${esc(keyOf(x))}">
    ${o.who === false ? '' : `<span class="live-who">${who(x.who, 'sm', true)}${me}</span>`}
    <span class="live-what">${what(x, o.here)}</span>
    ${thumbs}
    ${tx ? `<a class="muted small live-when" href="${tx}" target="_blank" rel="noopener" title="View transaction">${when} ↗</a>` : `<span class="muted small live-when">${when}</span>`}
  </li>`;
}

/// /activity: every deposit, withdrawal, buy, new union, burn, bid, sale and claim, newest first. New rows slide in at
/// the top every 20 seconds; if you've scrolled down, the page holds still under you.
export async function live(app: HTMLElement) {
  const board = new URLSearchParams(location.search).get('tab') === 'leaderboard';
  app.innerHTML = `<section class="home">
    ${pageHead({
      title: 'Activity',
      lede: 'Everything wallets do on Credit Union, as it happens.',
      tabs: [
        { label: 'Activity', attrs: 'data-tab="activity"', current: !board },
        { label: 'Leaderboard', attrs: 'data-tab="leaderboard"', current: board },
      ],
      label: 'Show',
    })}
    <ol class="live-list" id="live-list"${board ? ' hidden' : ''}><li class="muted live-empty">Loading…</li></ol>
    <div id="leaderboard"${board ? '' : ' hidden'}><p class="muted">Loading…</p></div>
  </section>`;
  const list = app.querySelector<HTMLOListElement>('#live-list')!;
  const seen = new Set<string>();
  // 100 rows at a time; Show more asks the Worker for the next 100.
  const more = document.createElement('button');
  more.type = 'button';
  more.className = 'btn live-more';
  more.textContent = 'Show more';
  more.hidden = true;
  list.after(more);
  let hasMore = false;
  const page = () => (more.hidden = list.hidden || !hasMore);
  more.addEventListener('click', async () => {
    const last = list.querySelector<HTMLElement>('.live-row:last-child')?.dataset.key;
    if (!last) return;
    more.disabled = true;
    try {
      const got = await readActivity(`limit=${PAGE}&after=${encodeURIComponent(last)}`);
      const rows = got.items.filter((x) => !seen.has(keyOf(x)));
      rows.forEach((x) => seen.add(keyOf(x)));
      list.insertAdjacentHTML('beforeend', rows.map((x) => row(x)).join(''));
      hydrate(list);
      hasMore = got.more;
    } catch {
      /* the button stays; try again */
    }
    more.disabled = false;
    page();
  });
  const boardEl = app.querySelector<HTMLElement>('#leaderboard')!;
  let boardDrawn = false;
  const show = (tab: string) => {
    app.querySelectorAll<HTMLElement>('[data-tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
    list.hidden = tab !== 'activity';
    boardEl.hidden = tab !== 'leaderboard';
    page();
    history.replaceState(null, '', tab === 'leaderboard' ? '/activity?tab=leaderboard' : '/activity');
    if (tab === 'leaderboard' && !boardDrawn) (boardDrawn = true), void leaderboard(boardEl);
  };
  app.querySelectorAll<HTMLElement>('[data-tab]').forEach((b) => b.addEventListener('click', () => show(b.dataset.tab!)));
  if (board) (boardDrawn = true), void leaderboard(boardEl);
  const load = async (first: boolean) => {
    let items: Item[];
    try {
      const got = await readActivity(`limit=${PAGE}`, !first);
      items = got.items;
      if (first) hasMore = got.more;
    } catch {
      if (first) list.innerHTML = '<li class="muted live-empty">Couldn’t load activity. Try again in a minute.</li>';
      return;
    }
    if (!list.isConnected) return;
    if (first) list.innerHTML = '';
    const fresh = items.filter((x) => !seen.has(keyOf(x)));
    fresh.forEach((x) => seen.add(keyOf(x)));
    if (!fresh.length) {
      if (first) list.innerHTML = '<li class="muted live-empty">Nothing yet.</li>';
    } else {
      // Rows arrive above what you're reading: move the page by exactly what was added, so nothing jumps.
      const top = list.getBoundingClientRect().top;
      const before = list.offsetHeight;
      list.querySelector('.live-empty')?.remove();
      list.insertAdjacentHTML('afterbegin', fresh.map((x) => row(x)).join(''));
      page();
      if (!first) {
        const added = list.offsetHeight - before;
        if (top < 0) window.scrollBy(0, added);
        list.querySelectorAll<HTMLElement>('.live-row').forEach((li, k) => k < fresh.length && li.classList.add('new'));
      }
      hydrate(list);
    }
    list.querySelectorAll<HTMLElement>('[data-time]').forEach((t) => {
      const s = Number(t.dataset.time);
      if (s) t.textContent = ago(s);
    });
  };

  await load(true);
  const timer = setInterval(() => {
    if (!list.isConnected) return clearInterval(timer);
    if (document.visibilityState === 'visible') void load(false);
  }, POLL);
}

/// Leaderboard: who has the most Credits in Credit Unions right now, across every union (from the union index:
/// a Credit counts for whoever deposited it, until they take it out).
async function leaderboard(el: HTMLElement) {
  let unions;
  try {
    unions = await listBatches();
  } catch {
    el.innerHTML = '<p class="muted">Couldn’t load the leaderboard. Try again in a minute.</p>';
    return;
  }
  const by = new Map<string, { who: Address; credits: number; unions: Set<string> }>();
  for (const u of unions)
    for (const d of u.depositors) {
      const k = d.toLowerCase();
      const r = by.get(k) ?? { who: d, credits: 0, unions: new Set<string>() };
      r.credits++;
      r.unions.add(u.s.address.toLowerCase());
      by.set(k, r);
    }
  const rows = [...by.values()].sort((a, b) => b.credits - a.credits || b.unions.size - a.unions.size);
  if (!el.isConnected) return;
  if (!rows.length) return void (el.innerHTML = '<p class="muted">Nothing yet.</p>');
  const mine = session.account ? rows.findIndex((r) => same(r.who, session.account!)) : -1;
  const line = (r: (typeof rows)[number], i: number) => `<li class="board-row${i === mine ? ' mine' : ''}">
      <span class="board-rank num">${i + 1}</span>
      <span class="board-who">${who(r.who, 'sm', true)}${i === mine ? '<span class="tag you">You</span>' : ''}</span>
      <span class="board-n num">${r.credits} ${r.credits === 1 ? 'Credit' : 'Credits'}</span>
      <span class="board-u num muted">${r.unions.size} ${r.unions.size === 1 ? 'union' : 'unions'}</span>
    </li>`;
  const TOP = 50;
  el.innerHTML = `<ol class="board">${rows.slice(0, TOP).map(line).join('')}${mine >= TOP ? line(rows[mine], mine) : ''}</ol>
    <p class="small muted board-note">${rows.length} depositors · Credits in Credit Unions now, across every union</p>`;
  hydrate(el);
}

/// The ticker's markup (homepage under the hero, /unions under the lede); activityTicker fills it.
export const tickerHtml = (id: string, kind = '') =>
  `<div class="home-ticker empty${kind ? ` ${kind}` : ''}" id="${id}"><span class="tick-dot" aria-label="Live"></span><span class="tick-line" aria-live="off"></span><a class="tick-all" href="/activity">Activity →</a></div>`;

/// The ticker: the newest event, one line. Checked every 20 seconds; a new one fades in, and its "ago" keeps
/// counting in between. It always holds its line (no layout shift); while the feed can't be read, the line is blank.
export async function activityTicker(el: HTMLElement) {
  const line = el.querySelector<HTMLElement>('.tick-line')!;
  let shown = '';
  let time = 0;
  const load = async (fresh: boolean) => {
    const x = (await readActivity('limit=1', fresh).catch(() => null))?.items[0];
    if (!el.isConnected) return;
    if (!x) return void el.classList.toggle('empty', !shown);
    el.classList.remove('empty');
    time = x.time;
    if (keyOf(x) === shown) return;
    shown = keyOf(x);
    line.classList.remove('in');
    line.innerHTML = `<span class="tick-who">${who(x.who, 'sm', true)}</span><span class="tick-what">${what(x)}</span><span class="muted tick-when">${x.time ? ago(x.time) : ''}</span>`;
    hydrate(line);
    requestAnimationFrame(() => line.classList.add('in'));
    setTimeout(() => line.classList.add('in'), 60); // a withheld frame mustn't hide it
  };
  await load(false);
  // Shown again after a page that hides it: catch up at once rather than at the next tick.
  el.addEventListener('refresh', () => void load(true));
  const timer = setInterval(() => {
    if (!el.isConnected) return clearInterval(timer);
    if (document.visibilityState !== 'visible' || el.closest('[hidden]')) return; // nobody sees it: don't read it
    void load(true);
    const when = line.querySelector('.tick-when');
    if (when && time) when.textContent = ago(time);
  }, POLL);
}

/// When each union last took a Credit (a deposit or a buy into it), unix seconds by lowercased address: the
/// Worker's ?last summary, a few KB for the whole list page.
export async function lastJoined(): Promise<Map<string, number>> {
  const r = await fetch('/activity.json?last', { cache: 'no-cache' }).catch(() => null);
  const j = r?.ok ? ((await r.json().catch(() => null)) as { last?: Record<string, number> } | null) : null;
  return new Map(Object.entries(j?.last ?? {}));
}
export { ago };
