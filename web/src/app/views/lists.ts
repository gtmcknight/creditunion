import { session } from '../chain';
import { ARRANGEMENTS, listBatches, type Listed, type Summary, hasLayout, layoutSlot } from '../data';
import { hydrate, pct, who } from '../ens';
import { fitByBatch } from '../fit';
import { editionArt, examples, fillGhosts, registerDeposits, registerFilter } from '../ghosts';
import type { Address } from 'viem';
import { describeFilter } from '../traits';
import { clock, eth, esc, same, sheet, until } from '../ui';

function status(s: Summary) {
  switch (s.state) {
    case 'Open':
      return `${80 - s.count} to go`;
    case 'Full':
      return fullStatus(s);
    case 'Expired':
      return 'Expired · Credits returnable';
    case 'Auction':
      return s.highBid ? `Bid ${eth(s.highBid)} · ${until(s.auctionEnd)}` : 'Statement made · awaiting first bid';
    case 'Settled':
      return `Sold ${eth(s.highBid)}`;
  }
}

/// A full party by where it stands in the lock cycle, read against the clock so a stale list still reads right.
export function fullStatus(s: Summary) {
  const now = Date.now() / 1000;
  if (s.phase === 'Waiting') return 'Waiting for Jack to launch Statements';
  if (s.phase === 'Countdown' && now < s.lockAt) return `Locks in ${clock(s.lockAt)}`;
  if ((s.phase === 'Countdown' || s.phase === 'Burnable') && now < s.deadline) return 'Ready to burn';
  return 'Unlocked';
}

const SORTS = [
  ['fullest', 'Fullest'],
  ['emptiest', 'Emptiest'],
  ['new', 'Newest'],
  ['old', 'Oldest'],
] as const;
type SortKey = (typeof SORTS)[number][0];

function sortKey(): SortKey {
  try {
    const v = localStorage.getItem('eighty-sort');
    if (SORTS.some(([k]) => k === v)) return v as SortKey;
  } catch {}
  return 'fullest';
}

const STAGE: Record<string, number> = { Open: 0, Full: 1, Auction: 2, Settled: 3, Expired: 4 };

/// Live batches first, always; the chosen sort orders within each stage. `list` arrives newest first.
function sortList(list: Listed[], k: SortKey) {
  const age = new Map(list.map((x, i) => [x.s.address, i]));
  list.sort(
    (a, b) =>
      STAGE[a.s.state] - STAGE[b.s.state] ||
      (k === 'new' ? age.get(a.s.address)! - age.get(b.s.address)!
      : k === 'old' ? age.get(b.s.address)! - age.get(a.s.address)!
      : k === 'emptiest' ? a.s.count - b.s.count
      : b.s.count - a.s.count),
  );
}


/// Ids in this batch deposited by `by` (the connected wallet by default).
export function mineIn(b: Listed, by = session.account) {
  return new Set(b.ids.filter((_, i) => same(b.depositors[i], by)).map(String));
}

export function card({ s, ids, depositors }: Listed, fit?: bigint[]) {
  const f = describeFilter(s.filter, s.allowlistSize);
  const mine = mineIn({ s, ids, depositors });
  const room = 80 - s.count;
  const canJoin = fit?.length ? Math.min(fit.length, room) : 0;
  const rule = [f || 'Any Credit', s.arrangement ? ARRANGEMENTS[s.arrangement] : '', s.split === 1 ? 'Early bird payout' : 'Equal payout', s.creatorFeeBps ? `${pct(s.creatorFeeBps)} creator fee` : ''].filter(Boolean).join(' · ');
  const live = s.state === 'Auction' && !(s.highBid && Date.now() / 1000 >= s.auctionEnd);
  const cta = s.state === 'Open' ? 'Join' : live ? 'Bid' : '';
  const fits = fit?.length ?? 0;
  const fitText =
    s.state !== 'Open' ? '' : mine.size ? `You’re in · ${mine.size}` : !session.account ? '' : fits ? `${fits} of yours fit` : '';
  const state = s.state === 'Open' ? '' : `<span class="tag state ${s.state.toLowerCase()}">${s.state}</span>`;
  registerFilter(s.address, s.filter);
  registerDeposits(ids, depositors, s.split === 1);
  return `<a class="card${canJoin ? ' can-join' : ''}" href="/union/${s.address}">
    <div class="card-art">${sheet(ids, { size: 'sm', mine, batch: s.state === 'Open' ? s.address : undefined })}<span class="count num">${s.count}/80</span>${state}</div>
    <div class="card-meta">
      <div class="meta-text">
        <strong>${esc(s.name || 'Untitled')}</strong>
        <span class="meta-by">${who(s.creator, 'sm', 'nested')}</span>
        <span class="meta-rule" title="${esc(rule)}">${esc(rule)}</span>
        ${fitText ? `<span class="${fits || mine.size ? 'fit' : ''}">${fitText}</span>` : s.state !== 'Open' ? `<span>${esc(status(s))}</span>` : ''}
      </div>
      ${cta ? (s.state === 'Open' && mine.size ? `<span class="btn sm cta joined">Joined</span>` : `<span class="btn sm primary cta">${cta}</span>`) : ''}
    </div>
  </a>`;
}

const PARTY_STATES = new Set(['Open', 'Full', 'Expired']);
export type HomeTab = 'parties' | 'auctions';


/// Two tabs over one list: parties still pooling, and Statements at or past auction. Each leads with
/// "For you" (what you're in, can join, or are bidding on), then everything else.
export async function lists(app: HTMLElement, tab: HomeTab = 'parties') {
  const head =
    tab === 'parties'
      ? ['Credit Unions', 'Each credit union pools Credits toward 80. Join with ones that fit, and leave anytime before it fills.']
      : ['Auctions', 'Every Statement a credit union makes is sold here. 24 hours from the first bid, split among its members.'];
  app.innerHTML = `
  <header class="create-head"><h1>${head[0]}</h1><p class="create-lede">${head[1]}</p></header>
  <section class="home">
    <div class="list-tools" id="sort-row" hidden>
      <div class="seg sm" role="radiogroup" aria-label="Sort">${SORTS.map(([k, l]) => `<label><input type="radio" name="sort" value="${k}" ${k === sortKey() ? 'checked' : ''}><span>${l}</span></label>`).join('')}</div>
    </div>
    <div id="batches"><p class="muted">Loading from chain…</p></div>
  </section>`;

  try {
    const all = await listBatches();
    const el = document.getElementById('batches');
    if (!el) return; // navigated away
    const parties = all.filter((b) => PARTY_STATES.has(b.s.state));
    const auctions = all.filter((b) => !PARTY_STATES.has(b.s.state));
    const list = tab === 'parties' ? parties : auctions;
    document.getElementById('sort-row')!.hidden = tab !== 'parties' || list.length < 4;
    let fit = new Map<Address, bigint[]>();
    const forYou = (b: Listed) =>
      !!session.account &&
      (mineIn(b).size > 0 || same(b.s.creator, session.account) || fit.has(b.s.address) || (tab === 'auctions' && same(b.s.highBidder, session.account)));
    const grid = (items: Listed[]) => `<div class="grid">${items.map((b) => card(b, fit.get(b.s.address))).join('')}</div>`;
    const draw = () => {
      sortList(list, tab === 'parties' ? sortKey() : 'new');
      const mine = list.filter(forYou);
      const rest = list.filter((b) => !forYou(b));
      const titled = (title: string, items: Listed[]) => (items.length ? `<h2 class="group-title">${title} <span class="num">${items.length}</span></h2>${grid(items)}` : '');
      const others =
        tab === 'auctions'
          ? titled('Live', rest.filter((b) => b.s.state !== 'Settled')) + titled('Completed', rest.filter((b) => b.s.state === 'Settled'))
          : rest.length ? `${mine.length ? `<h2 class="group-title">All credit unions <span class="num">${rest.length}</span></h2>` : ''}${grid(rest)}` : '';
      el.innerHTML = !list.length
        ? tab === 'parties'
          ? `<div class="empty-state"><p>No credit unions yet.</p><a class="btn primary" href="/create">Start a credit union</a></div>`
          : `<div class="grid"><div class="card placeholder" id="auction-placeholder">${sheet([], { size: 'sm' })}<div class="card-body"><strong>No auctions yet</strong><span class="muted small">When a credit union burns its 80, its Statement is auctioned here.</span></div></div></div>`
        : titled('For you', mine) + others;
      hydrate(el);
      fillGhosts(el);
      // Empty Auctions: a greyed Statement of real edition Credits stands in for the first one.
      const ph = document.getElementById('auction-placeholder');
      if (ph)
        examples({ palettes: 0, prints: 0, weights: 0, eights: 0, idFrom: 0n, idTo: 0n, minScore: 0, maxScore: 0 } as Summary['filter']).then((ids) => {
          ph.querySelector('.sheet')!.outerHTML = sheet([], { size: 'sm', ghosts: ids.slice(0, 80).map((id) => ({ id: BigInt(id), src: editionArt(id) })) });
        });
    };
    draw();
    if (session.account && tab === 'parties') {
      fitByBatch(parties).then((m) => {
        fit = m;
        if (document.getElementById('batches') === el) draw();
      });
    }
    document.querySelectorAll<HTMLInputElement>('input[name=sort]').forEach((r) =>
      r.addEventListener('change', () => {
        try {
          localStorage.setItem('eighty-sort', r.value);
        } catch {}
        draw();
      }),
    );
  } catch (e) {
    const el = document.getElementById('batches');
    if (el) el.innerHTML = `<p class="error">Couldn't read credit unions from chain. ${esc((e as Error).message)}</p>`;
  }
}
