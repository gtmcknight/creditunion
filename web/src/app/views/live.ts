import type { Address, Hex } from 'viem';
import { explorer, session } from '../chain';
import { hydrate, who } from '../ens';
import { art, esc, eth, pageHead, same } from '../ui';

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
      return here ? 'burned the 80 into a Statement' : `burned ${u} into a Statement`;
    case 'bid':
      return here ? `bid ${e}` : `bid ${e} on ${u}`;
    case 'won':
      return here ? `won the Statement for ${e}` : `won ${u} for ${e}`;
    case 'claimed':
      return here ? `claimed ${e}` : `claimed ${e} from ${u}`;
  }
}

/// /activity.json's rows (the Worker's newest 200 across the site, cached 15 s), read once per page view: /activity polls
/// it, and the Activity folds on union and member pages take their own rows from it.
let recent: { at: number; p: Promise<Item[]> } | null = null;
function readActivity(fresh = false): Promise<Item[]> {
  if (!fresh && recent && Date.now() - recent.at < 15_000) return recent.p;
  const p = fetch('/activity.json').then(async (r) => {
    const j = (await r.json()) as { items?: Item[]; error?: string };
    if (!r.ok || j.error) throw new Error(j.error ?? 'unavailable');
    return j.items ?? [];
  });
  const entry = (recent = { at: Date.now(), p });
  p.catch(() => recent === entry && (recent = null));
  return p;
}

/// A union's rows (`union`) or a wallet's (`member`), newest first; null when the feed can't be read.
export async function activityOf(o: { union?: Address; member?: Address }): Promise<Item[] | null> {
  const items = await readActivity().catch(() => null);
  return items && items.filter((x) => (o.union ? !!x.union && same(x.union, o.union) : o.member ? same(x.who, o.member) : false));
}
/// Those rows as list items: on a union's page the union goes without saying; on a member's page, who does.
export const activityItems = (rows: Item[] | null, o: { union?: boolean; member?: boolean }) =>
  !rows
    ? '<li class="muted live-empty">Couldn’t load activity. Try again in a minute.</li>'
    : rows.length
      ? rows.map((x) => row(x, { here: o.union, who: !o.member })).join('')
      : '<li class="muted live-empty">Nothing yet.</li>';

/// The Activity fold on a union's page: the page draws <details id="activity"> with #activity-count and
/// #activity-list inside.
export async function activityFold(union: Address) {
  const list = document.getElementById('activity-list');
  if (!list) return;
  const rows = await activityOf({ union });
  if (!list.isConnected) return;
  const count = document.getElementById('activity-count');
  if (count) count.textContent = rows?.length ? String(rows.length) : '';
  list.innerHTML = activityItems(rows, { union: true });
  hydrate(list);
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
  const tx = explorer('tx', x.tx);
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
  app.innerHTML = `<section class="home">
    ${pageHead({ title: 'Activity', lede: 'Everything wallets do on Credit Union, as it happens.' })}
    <ol class="live-list" id="live-list"><li class="muted live-empty">Loading…</li></ol>
  </section>`;
  const list = app.querySelector<HTMLOListElement>('#live-list')!;
  const seen = new Set<string>();

  const load = async (first: boolean) => {
    let items: Item[];
    try {
      items = await readActivity(!first);
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
