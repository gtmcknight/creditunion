import { config, session } from '../chain';
import { listBatches, notice, readNotice, scores, type Listed, type Summary, hasLayout, layoutSlot, placeOnLayout } from '../data';
import { placedKeys } from '../slots';
import { hydrate, who } from '../ens';
import { fitByBatch } from '../fit';
import { editionArt, examples, fillGhosts, hasPlan, planGhosts, registerDeposits, registerFilter } from '../ghosts';
import type { Address } from 'viem';
import { clock, eth, esc, openModal, pageHead, same, sheet, startsAt, statementArt, timeLeft, toast, until } from '../ui';
import { TRAIT_KINDS, parseTrait, type TraitValue } from '../../shared/trait';
import { creditsOf, takes } from './trait';
import { drawStill, primeInks, showStill, warmInks } from '../directions';
import { outbidNow } from '../outbid';
import { whale } from './whale';
import { DIRECTIONS, type Direction } from '../../shared/statement';

/// Last deposit per union, from the activity feed (filled in after the first draw).

export function status(s: Summary) {
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
  if (s.phase === 'Waiting') return notice ? `Burning starts ${startsAt(notice.at)}` : 'Waiting for Jack to launch Statements';
  if (s.phase === 'Countdown' && now < s.lockAt) return `Locks in ${clock(s.lockAt)}`;
  if ((s.phase === 'Countdown' || s.phase === 'Burnable') && now < s.deadline) return 'Ready to burn';
  return 'Unlocked';
}

/// A clock the auctions page ticks every second (`data-ends`): red inside the last 15 minutes, when a bid extends an
/// auction to 15 minutes from then.
const LATE = 15 * 60;
const ends = (at: number) => `<span class="ends${at - Date.now() / 1000 < LATE ? ' late' : ''}" data-ends="${at}">${timeLeft(at)}</span>`;

/// A card's line for a union at auction: the bid and its clock, or what opens it, or the winning bid once time's up.
function auctionLine(s: Summary) {
  if (!s.highBid) return `No bids yet · from ${eth(s.minBid)}`;
  if (Date.now() / 1000 >= s.auctionEnd) return `Won at ${eth(s.highBid)}`;
  return `High bid ${eth(s.highBid)} · ${ends(s.auctionEnd)}`;
}

/// A full union's card line: its lock clock once it counts down, then Ready to burn.
function fullLine(s: Summary) {
  const now = Date.now() / 1000;
  if (s.phase === 'Countdown' && now < s.lockAt) return `Locks in ${ends(s.lockAt)}`;
  if ((s.phase === 'Countdown' || s.phase === 'Burnable') && now < s.deadline) return 'Ready to burn';
  return '80/80 Full';
}

/// Auctions you led when last drawn and someone has since outbid (this visit).
const outbid = new Set<string>();

const SORTS = [
  ['fullest', 'Fullest'],
  ['emptiest', 'Emptiest'],
  ['new', 'Newest'],
  ['old', 'Oldest'],
  ['members', 'Most members'],
  ['rating', 'Top rated'],
] as const;
type SortKey = (typeof SORTS)[number][0];

function sortKey(): SortKey {
  try {
    const v = localStorage.getItem('cu-sort');
    if (SORTS.some(([k]) => k === v)) return v as SortKey;
  } catch {}
  return 'fullest';
}

const STAGE: Record<string, number> = { Open: 0, Full: 1, Auction: 2, Settled: 3, Expired: 4 };

/// Each list's arrival order (newest first), kept apart from `list` itself, which sorting rearranges.
const ages = new WeakMap<Listed[], Map<Address, number>>();

/// Live batches first, always; the chosen sort orders within each stage. `list` arrives newest first.
function sortList(list: Listed[], k: SortKey) {
  let age = ages.get(list);
  if (!age) ages.set(list, (age = new Map(list.map((x, i) => [x.s.address, i]))));
  list.sort(
    (a, b) =>
      STAGE[a.s.state] - STAGE[b.s.state] ||
      (k === 'new' ? age.get(a.s.address)! - age.get(b.s.address)!
      : k === 'old' ? age.get(b.s.address)! - age.get(a.s.address)!
      : k === 'emptiest' ? a.s.count - b.s.count
      : k === 'members' ? membersOf(b) - membersOf(a)
      : k === 'rating' ? (totalOf(b) ?? -1) - (totalOf(a) ?? -1)
      : b.s.count - a.s.count),
  );
}

const membersOf = (b: Pick<Listed, 'depositors'>) => new Set(b.depositors.map((d) => d.toLowerCase())).size;

/// Auctions: each tab its own orders, Live opening on the soonest to end.
const AUCTION_SORTS = [
  ['ending', 'Ending soon', 'live'],
  ['high', 'Highest bid', 'live'],
  ['low', 'Lowest bid', 'live'],
  ['new', 'Newest', 'live'],
  ['number', 'Statement number', 'live'],
  ['recent', 'Recently sold', 'sold'],
  ['top', 'Highest price', 'sold'],
  ['bottom', 'Lowest price', 'sold'],
  ['number', 'Statement number', 'sold'],
] as const;
type AuctionSort = (typeof AUCTION_SORTS)[number][0];
function auctionSort(stage: string): AuctionSort {
  const ok = AUCTION_SORTS.filter((x) => x[2] === stage);
  try {
    const v = localStorage.getItem(`cu-auction-sort-${stage}`);
    if (ok.some(([k]) => k === v)) return v as AuctionSort;
  } catch {}
  return ok[0]?.[0] ?? 'ending';
}
const desc = (x: bigint, y: bigint) => (x === y ? 0 : x > y ? -1 : 1);
function sortAuctions(items: Listed[], k: AuctionSort) {
  const ended = (s: Summary) => s.auctionEnd || s.assembledAt;
  return items.sort((a, b) => {
    const x = a.s, y = b.s;
    if (x.state === 'Full' || y.state === 'Full') return (x.lockAt || Infinity) - (y.lockAt || Infinity) || y.filledAt - x.filledAt; // the next to lock first
    switch (k) {
      case 'ending': // running clocks first, the soonest to end first; then those still waiting for a first bid
        return Number(!x.highBid) - Number(!y.highBid) || (x.highBid ? x.auctionEnd - y.auctionEnd : y.assembledAt - x.assembledAt);
      case 'number': // #1 first
        return x.statementId < y.statementId ? -1 : x.statementId > y.statementId ? 1 : 0;
      case 'high':
      case 'top':
        return desc(x.highBid, y.highBid) || x.auctionEnd - y.auctionEnd;
      case 'low':
        return desc(y.highBid || y.minBid, x.highBid || x.minBid) || x.auctionEnd - y.auctionEnd;
      case 'bottom':
        return desc(y.highBid, x.highBid) || ended(y) - ended(x);
      case 'recent':
        return ended(y) - ended(x);
      default:
        return y.assembledAt - x.assembledAt;
    }
  });
}

/// Each union's total rating (the sum of its Credits' scores), read only once someone sorts by rating.
const totals = new Map<string, number>(); // by address:count, so a new deposit re-totals
const totalOf = (b: Listed) => (b.ids.length ? totals.get(placeKey(b)) : 0);
async function totalCards(list: Listed[]) {
  const todo = list.filter((b) => totalOf(b) === undefined);
  if (!todo.length) return false;
  const got = await scores(todo.flatMap((b) => b.ids));
  for (const b of todo) totals.set(placeKey(b), Math.round(b.ids.reduce((a, id) => a + (got.get(id.toString()) ?? 0), 0)));
  return true;
}

/// Layout batches before the burn: each Credit in the slot it will burn into, as the union page shows it.
const placements = new Map<string, (bigint | null)[]>(); // by address:count, so a new deposit re-places
const placeKey = (b: { s: { address: Address }; ids: readonly bigint[] }) => `${b.s.address.toLowerCase()}:${b.ids.length}`;
const placing = new Map<string, Promise<Map<string, number> | null>>();
export async function placeCards(list: Listed[]) {
  const todo = list.filter((b) => b.ids.length && hasLayout(b.s.filter) && (b.s.state === 'Open' || b.s.state === 'Full') && !placements.has(placeKey(b)));
  await Promise.all(
    todo.map(async (b) => {
      // A page drawn twice at once (a wallet reconnecting as it loads) shares the read in flight.
      const k = placeKey(b);
      let read = placing.get(k);
      if (!read) placing.set(k, (read = placedKeys(b.s.address, b.ids).catch(() => null).finally(() => placing.delete(k))));
      const keys = await read;
      if (!keys) return;
      const slots = Array.from({ length: 80 }, (_, i) => layoutSlot(b.s.filter, i));
      placements.set(placeKey(b), placeOnLayout(slots, b.ids, (id) => keys.get(id.toString()) ?? 0));
    }),
  );
  return todo.some((b) => placements.has(placeKey(b)));
}

/// Picture unions: the Credit picked for each slot when it was made (saved with its picture), drawn in its open
/// slots so the card shows the picture, and "Picture" where a painted one says "Painted".
const PICS = 'cu-pictures';
const pictures = new Set<Address>(((): Address[] => {
  try {
    return JSON.parse(localStorage.getItem(PICS) ?? '[]');
  } catch {
    return [];
  }
})()); // known from an earlier visit too, so their cards show their last drawing straight away
const savePictures = () => {
  try {
    localStorage.setItem(PICS, JSON.stringify([...pictures]));
  } catch {}
};
/// Addresses whose saved picture has been read this visit (its planned Credits registered).
const pictureRead = new Set<Address>();
/// Picture reads in flight, shared by a page drawn twice at once.
const pictureReading = new Map<Address, Promise<{ ids?: (number | null)[]; inks?: Record<string, [string, number, number]>; look?: Direction } | null>>();
/// A picture matched in another format than Consolidated (its saved `look`), per union: its card draws in it.
const looks = new Map<string, Direction>();
export async function pictureCards(list: Listed[]) {
  const todo = list.filter((b) => (b.s.state === 'Open' || b.s.state === 'Full') && hasLayout(b.s.filter) && !Number(b.s.filter.layoutTrait ?? 0) && !pictureRead.has(b.s.address));
  const found = await Promise.all(
    todo.map(async (b) => {
      let read = pictureReading.get(b.s.address);
      if (!read)
        pictureReading.set(
          b.s.address,
          (read = fetch(`/pictures/${b.s.address}`)
            .then((r) => (r.ok ? (r.json() as Promise<{ ids?: (number | null)[]; inks?: Record<string, [string, number, number]>; look?: Direction }>) : null))
            .catch(() => null)
            .finally(() => pictureReading.delete(b.s.address))),
        );
      const d = await read;
      pictureRead.add(b.s.address);
      if (!d) {
        if (pictures.delete(b.s.address)) savePictures();
        return false;
      }
      primeInks(d.inks);
      warmInks(b.ids); // what's in already (the planned Credits' ink came with the picture)
      if (d.look) looks.set(b.s.address.toLowerCase(), d.look);
      if (!pictures.has(b.s.address)) (pictures.add(b.s.address), savePictures());
      if (d.ids) planGhosts(b.s.address, d.ids);
      return true;
    }),
  );
  return found.some(Boolean);
}

/// Cards under `root` (only those in `fresh`, when given) that draw a format over their sheet (card's data-draw): a
/// full union in the format it burns in, a picture still filling in Consolidated, as Now (what's in at full ink, the
/// rest faded). Each draws as soon as its own Credits are placed.
export function drawPictures(root: ParentNode, fresh?: Set<Element>) {
  root.querySelectorAll<HTMLElement>('.card-art[data-draw]').forEach((h) => {
    if (fresh && !fresh.has(h.closest('.card')!)) return;
    showStill(h);
    if (h.dataset.ready) void fillGhosts(h).then(() => drawStill(h, h.dataset.draw as Direction));
  });
}

/// Ids in this batch deposited by `by` (the connected wallet by default).
export function mineIn(b: Listed, by = session.account) {
  return new Set(b.ids.filter((_, i) => same(b.depositors[i], by)).map(String));
}

/// The payout at a glance, beside the creator: five level bars for Equal, five stepping down for Early bird.
/// The payout rule as a word, its meaning on hover.
const payWord = (early: boolean) =>
  `<span class="pay-word" title="${early ? 'First in get 1.5×, last in 0.5×' : 'Every Credit gets 1/80'}">${early ? 'Early bird' : 'Equal split'}</span>`;

/// A picture card can draw once its Credits are placed and, while open, its plan is known; until then it shows its
/// last drawing (or its grid).
const pictureReady = (b: Listed) => (!b.ids.length || placements.has(placeKey(b))) && (b.s.state !== 'Open' || hasPlan(b.s.address));

/// `whose`: who the fit count is about ("yours" for the connected wallet, "theirs" on someone else's page).
/// What each card on screen was drawn from. A redraw keeps the cards whose markup didn't change (their art, names and
/// pictures already filled in) and swaps in only the rest; returns the cards that are new on screen.
const drawnFrom = new WeakMap<Element, string>();
function morph(el: HTMLElement, html: string): Set<Element> {
  const t = document.createElement('template');
  t.innerHTML = html;
  const was = new Map<string, Element>();
  el.querySelectorAll('.grid > a.card[href]').forEach((c) => was.set(c.getAttribute('href')!, c));
  const fresh = new Set<Element>();
  t.content.querySelectorAll('.grid > a.card[href]').forEach((c) => {
    const src = c.outerHTML, old = was.get(c.getAttribute('href')!);
    if (old && drawnFrom.get(old) === src) return c.replaceWith(old);
    drawnFrom.set(c, src);
    fresh.add(c);
  });
  el.replaceChildren(t.content);
  return fresh;
}

/// `rating`: the union's total rating, shown as a fourth line (while sorting by it).
export function card({ s, ids, depositors, format }: Listed, fit?: bigint[], whose = 'yours', rating?: number) {
  const mine = mineIn({ s, ids, depositors });
  const room = 80 - s.count;
  const picture = pictures.has(s.address);
  // A Picture union takes only Credits bought for it (where the site can buy), so yours never "fit" one.
  if (picture && config.sweeper) fit = [];
  const canJoin = fit?.length ? Math.min(fit.length, room) : 0;
  const burned = s.state === 'Auction' || s.state === 'Settled';
  const live = s.state === 'Auction' && !(s.highBid && Date.now() / 1000 >= s.auctionEnd);
  // What the art draws over its sheet: a full union the format it burns in (its creator's pick, else Consolidated for a
  // picture and Issued, the sheet itself, for the rest); a picture still filling Consolidated. A burned one shows its
  // Statement instead.
  const burnsIn: Direction = (s.state === 'Full' && format != null && DIRECTIONS[format]) || (picture ? (looks.get(s.address.toLowerCase()) ?? 'Consolidated') : 'Issued');
  const draw = !burned && burnsIn !== 'Issued' ? burnsIn : null;
  const ready = picture ? pictureReady({ s, ids, depositors }) : ids.length === 80;
  // The art carries no text. Under it, three lines: the name; who started it and how many are in; where it stands and
  // what of yours is in or fits.
  const won = s.state === 'Auction' && !live; // the clock ran out: anyone can settle it
  const cta = s.state === 'Open' && !mine.size ? 'Join' : live ? 'Bid' : won ? 'Settle' : '';
  const members = membersOf({ depositors });
  const people = `${members} ${members === 1 ? 'member' : 'members'}`;
  const where =
    s.state === 'Open' ? `${s.count}/80 Credits`
    : s.state === 'Full' ? fullLine(s)
    : s.state === 'Auction' ? auctionLine(s)
    : esc(status(s));
  const you = session.account;
  const lead = live && !!you && !!s.highBid && same(s.highBidder, you);
  const standing = lead ? ' · <span class="meta-win">You’re winning</span>' : live && outbid.has(s.address.toLowerCase()) ? ' · <span class="meta-outbid">Outbid</span>' : '';
  const more = s.state === 'Open' && whose === 'yours' ? canJoin : 0;
  const theirs = whose === 'yours' ? 'yours' : whose;
  const yoursText = mine.size ? `${mine.size} of ${theirs} in${more ? ` · ${more} more fit` : ''}` : more ? `${more} of ${theirs} fit` : '';
  registerFilter(s.address, s.filter);
  registerDeposits(ids, depositors, s.split === 1);
  return `<a class="card${canJoin ? ' can-join' : ''}" href="/union/${s.address}">
    <div class="card-art${picture ? ' picture' : ''}${draw ? ' dir-host' : ''}${burned ? ' statement-host' : ''}"${draw ? ` data-draw="${draw}" data-portrait="${s.address.toLowerCase()}:${ids.length}:${ids.length ? ids[ids.length - 1] : ''}:${draw}"${ready ? ' data-ready="1"' : ''}` : ''}>${sheet(ids, { size: 'sm', mine, placed: placements.get(placeKey({ s, ids })), batch: s.state === 'Open' ? s.address : undefined, painted: true })}${burned ? statementArt(s.statementId) : ''}</div>
    <div class="card-meta">
      <div class="meta-text">
        <strong>${esc(s.name || 'Untitled')}${burned ? ` <span class="stmt-no num">#${s.statementId}</span>` : ''}</strong>
        <span class="meta-line num"><span class="meta-line-text meta-byline">${who(s.creator, 'sm', 'nested')}<span class="meta-where">&nbsp;·&nbsp;${people}&nbsp;·&nbsp;${payWord(s.split === 1)}</span></span></span>
        <span class="meta-line num"><span class="meta-line-text">${where}${standing}${yoursText ? ` · <span class="meta-yours">${yoursText}</span>` : ''}</span></span>
        ${rating === undefined ? '' : `<span class="meta-line num">Rating ${rating.toLocaleString()}</span>`}
      </div>
      ${cta ? `<span class="btn sm primary cta">${cta}</span>` : ''}
    </div>
  </a>`;
}

const PARTY_STATES = new Set(['Open', 'Full', 'Expired']);
const STAGES = [['live', 'Live'], ['upcoming', 'Upcoming'], ['sold', 'Sold'], ['multibid', 'Multibid']] as const;
type Stage = (typeof STAGES)[number][0];
/// Live is what you can bid on now; an auction whose clock ran out is sold, waiting for anyone to settle it.
const stageOf = (b: Listed): Stage =>
  b.s.state === 'Full' ? 'upcoming' : b.s.state === 'Settled' || (b.s.highBid && Date.now() / 1000 >= b.s.auctionEnd) ? 'sold' : 'live';
export type HomeTab = 'parties' | 'auctions';


/// Two pages over one list: Credit Unions still pooling (Open, Can join, Joined, Full), and Statements at or past
/// auction (by stage).
/// A page drawn twice at once (a wallet reconnecting as it loads) runs lists() twice over the same buttons; only the
/// latest run wires them, or a sort would redraw from the first run's state (before the wallet: no Can join, no Joined).
let listsRun = 0;
export async function lists(app: HTMLElement, tab: HomeTab = 'parties') {
  const run = ++listsRun;
  const head =
    tab === 'parties'
      ? ['Unions', 'Each Credit Union pools Credits toward 80. Join with ones that fit, and leave anytime before it fills.']
      : ['Auctions', 'Every Statement a Credit Union makes is sold here. 24 hours from the first bid, split among its members.'];
  // One small menu, not a second row of tabs: a sort glyph and the current order; the choices drop down under it.
  const cur = sortKey();
  const items =
    tab === 'parties'
      ? SORTS.map(([k, l]) => `<li role="option" tabindex="-1" data-sort="${k}" aria-selected="${k === cur}">${l}</li>`)
      : AUCTION_SORTS.map(([k, l, st]) => `<li role="option" tabindex="-1" data-sort="${k}" data-stage="${st}" aria-selected="false"${st === 'live' ? '' : ' hidden'}>${l}</li>`);
  const sort = `<div class="sort-pick"><button type="button" class="sort-btn" aria-haspopup="listbox" aria-expanded="false" aria-label="Sort"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 3v10M1.5 10.5 4 13l2.5-2.5M12 13V3M9.5 5.5 12 3l2.5 2.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg><span class="sort-label">${tab === 'parties' ? (SORTS.find(([k]) => k === cur)?.[1] ?? '') : ''}</span></button><ul class="sort-menu" role="listbox" aria-label="Sort" hidden>${items.join('')}</ul></div>`;
  app.innerHTML = `
  <section class="home">
    ${pageHead({
      title: head[0],
      lede: head[1],
      tabs:
        tab === 'parties'
          ? [{ label: 'Open <span class="num muted" id="n-all"></span>', attrs: 'data-view="all"' }, { label: 'Can join <span class="num muted" id="n-invited"></span>', attrs: 'data-view="invited"' }, { label: 'Joined <span class="num muted" id="n-yours"></span>', attrs: 'data-view="yours"' }, { label: 'Full <span class="num muted" id="n-filled"></span>', attrs: 'data-view="filled"' }]
          : STAGES.map(([k, l]) => ({ label: k === 'multibid' ? l : `${l} <span class="num muted" id="n-${k}"></span>`, attrs: `data-stage-tab="${k}"` })),
      tools: sort,
      action: tab === 'parties' ? '<a class="btn primary" href="/create">Start a Credit Union</a>' : '<button type="button" class="btn" id="how-auctions">How it works</button>',
      label: 'Show',
    })}
    <div id="batches"><p class="muted">Loading…</p></div>
  </section>`;
  document.getElementById('how-auctions')?.addEventListener('click', howAuctions);

  try {
    // The notice (burn day's countdown) waits at most a moment: the lists don't hang on it.
    const [all] = await Promise.all([listBatches(), Promise.race([readNotice(), new Promise((r) => setTimeout(r, 2500))])]);
    const el = document.getElementById('batches');
    if (!el || run !== listsRun) return; // navigated away, or drawn again since
    const parties = all.filter((b) => PARTY_STATES.has(b.s.state));
    // Auctions: full ones waiting to burn (Upcoming), at auction (Live), and sold.
    const auctions = all.filter((b) => b.s.state !== 'Open' && b.s.state !== 'Expired');
    // ?eights=3 (or palette, print, weight): only the open Credit Unions that take those Credits.
    const want = tab === 'parties' ? filterFromQuery() : null;
    const list = want ? parties.filter((b) => b.s.state === 'Open' && want.test(b)) : tab === 'parties' ? parties : auctions;
    if (want) {
      app.querySelector('.page-head')?.insertAdjacentHTML('beforeend', `<p class="filter-line">Open to ${esc(want.label)} · <a href="/unions">Show all</a></p>`);
    }
    const bar = app.querySelector<HTMLElement>('.page-bar');
    // Open / Can join / Joined / Full (views all, invited, yours, filled): opens on Open until someone picks. Open is
    // the ones still taking Credits; Can join, open ones your Credits fit that you haven't joined; Joined, ones
    // you're in or started; Full, full ones until their auction starts.
    type View = 'all' | 'invited' | 'yours' | 'filled';
    // The tab lives in the path (/unions/join, /auctions/sold), so Back from a union returns to it. Old
    // ?tab= links (?tab=invited, ?tab=yours, ?tab=full) still land and are rewritten to the path.
    const base = tab === 'parties' ? '/unions' : '/auctions';
    const SLUGS: Record<View, string> = { all: '', invited: 'join', yours: 'joined', filled: 'full' };
    const OLD: Record<string, View> = { all: 'all', invited: 'invited', yours: 'yours', full: 'filled' };
    const query = new URLSearchParams(location.search);
    const slug = location.pathname.split('/')[2] || query.get('tab') || '';
    const VIEWS = Object.keys(SLUGS) as View[];
    let view: View | null = VIEWS.find((v) => SLUGS[v] && SLUGS[v] === slug) ?? OLD[slug] ?? null;
    let stage: Stage | null = STAGES.some(([k]) => k === slug) ? (slug as Stage) : null;
    const remember = (t: string | null) => {
      const u = new URL(location.href);
      u.searchParams.delete('tab');
      u.pathname = t ? `${base}/${t}` : base;
      history.replaceState(history.state, '', u.pathname + u.search + u.hash);
    };
    if (query.has('tab') || location.pathname.split('/').length > 3) remember(tab === 'parties' ? (view ? SLUGS[view] || null : null) : stage);
    let fit = new Map<Address, bigint[]>();
    let showEmpty = false; // All tabs its empty (0/80) unions behind a button: they're mostly abandoned
    let shownStage: Stage = 'live'; // the auctions tab showing, whose order the menu sets
    const grid = (items: Listed[]) => {
      const rated = tab === 'parties' && sortFor(view) === 'rating';
      return `<div class="grid">${items.map((b) => card(b, fit.get(b.s.address), 'yours', rated ? totalOf(b) : undefined)).join('')}</div>`;
    };
    let totaling = false;
    const shownGrid = (v: string, items: Listed[]) => {
      if (v !== 'all' || showEmpty) return grid(items);
      const live = items.filter((b) => b.s.count > 0), gone = items.length - live.length;
      return (live.length ? grid(live) : '') + (gone ? `<button type="button" class="btn show-empty" id="show-empty">Show ${gone} empty ${gone === 1 ? 'union' : 'unions'}</button>` : '');
    };
    // Full unions are all 80 of 80: Fullest and Emptiest can't order them, so Full hides those two and uses Newest.
    const sortFor = (v: View | null) => {
      const k = sortKey();
      return v === 'filled' && (k === 'fullest' || k === 'emptiest') ? 'new' : k;
    };
    const showSorts = (v: View | null) => {
      const k = sortFor(v);
      app.querySelectorAll<HTMLElement>('.sort-menu [data-sort]').forEach((o) => {
        o.hidden = v === 'filled' && (o.dataset.sort === 'fullest' || o.dataset.sort === 'emptiest');
        o.setAttribute('aria-selected', String(o.dataset.sort === k));
      });
      const label = app.querySelector('.sort-label');
      if (label) label.textContent = SORTS.find(([x]) => x === k)?.[1] ?? '';
    };
    const draw = () => {
      if (tab === 'parties') showSorts(view);
      sortList(list, tab === 'parties' ? sortFor(view) : 'new');
      if (tab === 'parties' && sortFor(view) === 'rating' && !totaling && list.some((b) => totalOf(b) === undefined)) {
        totaling = true;
        totalCards(list)
          .then((got) => got && document.getElementById('batches') === el && draw())
          .catch(() => {})
          .finally(() => (totaling = false));
      }
      if (tab === 'parties') {
        // Can join and Joined always show; signed out they ask to connect.
        const v = view ?? 'all';
        app.querySelectorAll<HTMLElement>('[data-view]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.view === v)));
        const acct = session.account;
        const isYours = (b: Listed) => !!acct && (mineIn(b).size > 0 || same(b.s.creator, acct));
        const views: Record<View, Listed[]> = {
          all: list.filter((b) => b.s.state !== 'Full'),
          invited: list.filter((b) => b.s.state === 'Open' && fit.has(b.s.address) && !isYours(b)),
          yours: list.filter(isYours),
          filled: list.filter((b) => b.s.state === 'Full'),
        };
        for (const k of Object.keys(views) as View[]) {
          const n = document.getElementById(`n-${k}`);
          if (n) n.textContent = (k === 'invited' || k === 'yours') && !acct ? '' : String(views[k].length);
        }
        const empty: Record<View, string> = {
          all: 'No Credit Union is taking Credits right now.',
          invited: 'None of your Credits fit an open Credit Union right now.',
          yours: 'You haven’t joined or started a Credit Union yet.',
          filled: 'None full right now. A Credit Union stays here from 80/80 until its auction starts.',
        };
        const fresh = morph(
          el,
          !list.length
            ? `<div class="empty-state"><p>No Credit Unions yet.</p><a class="btn primary" href="/create">Start a Credit Union</a></div>`
            : (v === 'invited' || v === 'yours') && !acct
              ? `<div class="empty-state"><p>Connect to see the Credit Unions ${v === 'invited' ? 'your Credits qualify for' : 'you’re in'}.</p><button class="btn primary" data-connect>Connect wallet</button></div>`
              : (views[v].length ? shownGrid(v, views[v]) : `<p class="muted">${empty[v]}</p>`),
        );
        el.querySelector('#show-empty')?.addEventListener('click', () => ((showEmpty = true), draw()));
        hydrate(el);
        // A full union's card shows the format it burns in, a picture still filling Consolidated, as Now: what's in at
        // full ink, the rest faded. Each card draws as soon as its own Credits are in, not after every card's examples.
        // A card kept from the last drawing already shows it.
        drawPictures(el, fresh);
        void fillGhosts(el);
        return;
      }
      const staged = STAGES.map(([k]) => [k, list.filter((b) => stageOf(b) === k)] as const);
      for (const [k, items] of staged) {
        const n = document.getElementById(`n-${k}`);
        if (n) n.textContent = String(items.length);
      }
      // Until someone picks, open on Live when there is any, else the first stage that has any, else Live.
      const pick = stage ?? (staged.find(([k, items]) => k === 'live' && items.length) ?? staged.find(([k, items]) => k !== 'multibid' && items.length) ?? staged[0])[0];
      app.querySelectorAll<HTMLElement>('[data-stage-tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.stageTab === pick)));
      // Multibid keeps itself current (its picks and amounts survive the reads), so it's drawn once.
      // Multibid sorts from its own column names, so the menu steps aside (keeping its place, so the tabs don't move).
      if (pick === 'multibid') {
        shownStage = pick;
        app.querySelector<HTMLElement>('.sort-pick')?.classList.add('idle');
        if (!el.querySelector('#whale-body')) void whale(el);
        return;
      }
      // This tab's orders in the menu (Upcoming has one: the next to lock first).
      const order = auctionSort(pick);
      const shown = sortAuctions([...staged.find(([k]) => k === pick)![1]], order);
      shownStage = pick;
      app.querySelectorAll<HTMLElement>('.sort-menu [data-sort]').forEach((o) => {
        o.hidden = o.dataset.stage !== pick;
        o.setAttribute('aria-selected', String(o.dataset.stage === pick && o.dataset.sort === order));
      });
      const label = app.querySelector('.sort-label');
      if (label) label.textContent = AUCTION_SORTS.find(([k, , st]) => k === order && st === pick)?.[1] ?? '';
      // A tab with nothing to order keeps the menu's place, so the tabs don't move.
      app.querySelector<HTMLElement>('.sort-pick')?.classList.toggle('idle', pick === 'upcoming');
      const fresh = morph(
        el,
        !list.length
          ? `<div class="grid"><div class="card placeholder" id="auction-placeholder">${sheet([], { size: 'sm' })}<div class="card-body"><strong>No auctions yet</strong><span class="muted small">When a Credit Union burns its 80, its Statement is auctioned here.</span></div></div></div>`
          : shown.length
            ? grid(shown)
            : `<p class="muted">${pick === 'upcoming' ? 'No Credit Union is full right now.' : pick === 'live' ? 'Nothing at auction right now.' : 'Nothing sold yet.'}</p>`,
      );
      hydrate(el);
      // Unions waiting to burn show the format they burn in here too, as on /unions (a kept card already does).
      drawPictures(el, fresh);
      fillGhosts(el);
      // Empty Auctions: a greyed Statement of real edition Credits stands in for the first one.
      const ph = document.getElementById('auction-placeholder');
      if (ph)
        examples({ palettes: 0, prints: 0, weights: 0, eights: 0, idFrom: 0n, idTo: 0n, minScore: 0, maxScore: 0 } as Summary['filter']).then((ids) => {
          ph.querySelector('.sheet')!.outerHTML = sheet([], { size: 'sm', ghosts: ids.slice(0, 80).map((id) => ({ id: BigInt(id), src: editionArt(id) })) });
        });
    };
    app.querySelectorAll<HTMLElement>('[data-stage-tab]').forEach((b) =>
      b.addEventListener('click', () => {
        stage = b.dataset.stageTab as Stage;
        remember(stage);
        draw();
      }),
    );
    app.querySelectorAll<HTMLElement>('[data-view]').forEach((b) =>
      b.addEventListener('click', () => {
        view = b.dataset.view as View;
        remember(SLUGS[view] || null);
        draw();
      }),
    );
    draw();
    // The clocks tick between reads. One that runs out redraws: its auction moves to Sold, a lock to Ready to burn.
    const tick = setInterval(() => {
      if (document.getElementById('batches') !== el) return clearInterval(tick);
      const now = Date.now() / 1000;
      let out = false;
      el.querySelectorAll<HTMLElement>('[data-ends]').forEach((n) => {
        const at = Number(n.dataset.ends);
        if (now >= at) out = true;
        n.textContent = timeLeft(at);
        n.classList.toggle('late', at - now < LATE);
      });
      if (out) draw();
    }, 1000);
    // Live: read the list again every 20 seconds (10 on Auctions) while the page is showing, and redraw only when a union changed
    // (a deposit, a withdrawal, a new one, a state change).
    // Burn day's notice is part of it: cards of full unions say when burning starts.
    const sig = (xs: Listed[]) => `${notice?.at ?? ''}|` + xs.map((b) => `${b.s.address}:${b.ids.length}:${b.s.state}:${b.s.phase}:${b.s.highBid}`).join('|');
    let seen = sig(all);
    const poll = setInterval(async () => {
      if (document.getElementById('batches') !== el) return clearInterval(poll);
      if (document.visibilityState !== 'visible') return;
      const [next] = await Promise.all([listBatches().catch(() => null), readNotice()]);
      // A layout union whose placement failed earlier (a busy RPC) is tried again, then drawn.
      if (next && sig(next) === seen) {
        if (await placeCards(list)) draw();
        return;
      }
      if (!next || document.getElementById('batches') !== el) return;
      seen = sig(next);
      const was = new Map(list.map((b) => [b.s.address, b.s]));
      const nextParties = next.filter((b) => PARTY_STATES.has(b.s.state));
      const nextList = want ? nextParties.filter((b) => b.s.state === 'Open' && want.test(b)) : tab === 'parties' ? nextParties : next.filter((b) => b.s.state !== 'Open' && b.s.state !== 'Expired');
      list.splice(0, list.length, ...nextList);
      parties.splice(0, parties.length, ...nextParties);
      await Promise.all([placeCards(list), pictureCards(list)]);
      if (document.getElementById('batches') !== el) return;
      // A new bid: its card flashes. If it took the lead from you, it says Outbid until you lead again.
      const me = session.account, bumped: Address[] = [];
      for (const b of list) {
        const before = was.get(b.s.address);
        if (!before || b.s.state !== 'Auction' || b.s.highBid === before.highBid) continue;
        bumped.push(b.s.address);
        const key = b.s.address.toLowerCase();
        if (me && same(b.s.highBidder, me)) outbid.delete(key);
        else if (me && same(before.highBidder, me) && !outbid.has(key)) {
          outbid.add(key);
          outbidNow(b); // the site's one outbid alert (linked, told once)
        }
      }
      draw();
      for (const a of bumped) el.querySelector(`a.card[href="/union/${a}"]`)?.classList.add('bumped');
    }, tab === 'auctions' ? 10_000 : 20_000);
    Promise.all([placeCards(list), pictureCards(list)]).then((got) => {
      if (got.some(Boolean) && document.getElementById('batches') === el) draw();
    });
    if (session.account && tab === 'parties') {
      fitByBatch(parties).then((m) => {
        fit = m;
        if (document.getElementById('batches') === el) draw();
      });
    }
    // Bound once: a page drawn twice at once (a wallet reconnecting as it loads) would otherwise wire the one button
    // twice, and a click would open the menu and close it again.
    const pick = app.querySelector<HTMLElement>('.sort-pick:not([data-bound])');
    if (pick) {
      pick.dataset.bound = '';
      const btn = pick.querySelector<HTMLButtonElement>('.sort-btn')!, menu = pick.querySelector<HTMLElement>('.sort-menu')!;
      const opts = [...menu.querySelectorAll<HTMLElement>('[data-sort]')];
      const open = (on: boolean) => {
        menu.hidden = !on;
        btn.setAttribute('aria-expanded', String(on));
        if (on) (opts.find((o) => !o.hidden && o.getAttribute('aria-selected') === 'true') ?? opts.find((o) => !o.hidden)!).focus();
      };
      const choose = (o: HTMLElement) => {
        opts.forEach((x) => x.setAttribute('aria-selected', String(x === o)));
        pick.querySelector('.sort-label')!.textContent = o.textContent;
        try {
          localStorage.setItem(tab === 'parties' ? 'cu-sort' : `cu-auction-sort-${shownStage}`, o.dataset.sort!);
        } catch {}
        open(false);
        btn.focus();
        draw();
      };
      btn.addEventListener('click', () => open(menu.hidden === true));
      menu.addEventListener('click', (e) => {
        const o = (e.target as HTMLElement).closest<HTMLElement>('[data-sort]');
        if (o) choose(o);
      });
      menu.addEventListener('keydown', (e) => {
        const shown = opts.filter((o) => !o.hidden); // the Full tab hides two
        const i = shown.indexOf(document.activeElement as HTMLElement);
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          shown[(i + (e.key === 'ArrowDown' ? 1 : shown.length - 1)) % shown.length].focus();
        } else if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          if (i >= 0) choose(shown[i]);
        } else if (e.key === 'Escape' || e.key === 'Tab') {
          open(false);
          if (e.key === 'Escape') btn.focus();
        }
      });
      // A click anywhere else closes it.
      document.addEventListener('pointerdown', (e) => {
        if (!menu.hidden && !pick.contains(e.target as Node)) open(false);
      });
    }
  } catch (e) {
    const el = document.getElementById('batches');
    if (el && run === listsRun) {
      el.innerHTML = `<p class="error">Couldn't load the Credit Unions. ${esc((e as Error).message)}</p><button type="button" class="btn" id="lists-retry">Try again</button>`;
      document.getElementById('lists-retry')?.addEventListener('click', () => void lists(app, tab));
    }
  }
}

/// What a /unions link narrows to, from a trait or range page: a trait (?palette=C, ?eights=3, ?print=slip,
/// ?weight=sparse), or a range (?minScore=&maxScore= in tenths, ?bitsFrom=&bitsTo=, ?paidFrom=&paidTo= in unix
/// seconds). A Credit Union counts when its own rule on that thing is absent or overlaps.
function filterFromQuery(): { label: string; test: (b: Listed) => boolean } | null {
  const q = new URLSearchParams(location.search);
  for (const k of TRAIT_KINDS) {
    const v = q.get(k);
    const t = v ? parseTrait(k, v) : null;
    if (t) return { label: creditsOf(t), test: (b) => takes(b, t) };
  }
  const num = (k: string) => (q.has(k) && /^\d{1,10}$/.test(q.get(k)!) ? Number(q.get(k)) : null);
  const overlap = (from = 0, to = 0, lo: number, hi: number) => (!from && !to) || (from <= hi && (to || Infinity) >= lo);
  const sLo = num('minScore'), sHi = num('maxScore');
  if (sLo !== null && sHi !== null)
    return { label: `Credits rated ${(sLo / 10).toFixed(1)} to ${(sHi / 10).toFixed(1)}`, test: ({ s: { filter: f } }) => overlap(f.minScore, f.maxScore, sLo, sHi) };
  const bLo = num('bitsFrom'), bHi = num('bitsTo');
  if (bLo !== null && bHi !== null) return { label: `Credits with ${bLo} to ${bHi} Bits`, test: ({ s: { filter: f } }) => overlap(f.bitsFrom, f.bitsTo, bLo, bHi) };
  const pLo = num('paidFrom'), pHi = num('paidTo');
  if (pLo !== null && pHi !== null) {
    const d = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    return { label: `Credits paid ${d.format(pLo * 1000)} to ${d.format(pHi * 1000)}`, test: ({ s: { filter: f } }) => overlap(f.paidFrom, f.paidTo, pLo, pHi) };
  }
  return null;
}

/// Auctions → How it works: burn day in order, then the auction and the split. Same steps as the launch thread.
const HOW_STEPS: [string, string][] = [
  ['Oct 1: Jack publishes the Statement contract', 'From then on, 80 Credits can burn into one Statement.'],
  ['We build our burn contract', 'It lets Credit Unions use Jack’s contract. We test it first.'],
  ['We launch it: 35 minute warning', 'Full unions (80/80) lock in 35 minutes. Until then, anyone can leave.'],
  ['Full unions (80/80) lock for an hour', 'Withdrawals close. Anyone can press Convert Union to Statement to burn the 80 Credits.'],
  ['The auction starts', 'No reserve. The 24 hour clock starts at the first bid.'],
  ['The auction ends', 'The Statement goes to the winner. The ETH goes to every member.'],
];
function howAuctions() {
  const d = document.createElement('dialog');
  d.className = 'how';
  d.innerHTML = `<h3>How auctions work</h3>
    <ol class="how-steps">${HOW_STEPS.map(([a, b]) => `<li><b>${a}</b><span class="muted">${b}</span></li>`).join('')}</ol>
    <h4>Bidding</h4>
    <ul class="how-rules">
      <li>Anyone can bid, members too.</li>
      <li>Every bid beats the last by at least 5%.</li>
      <li>A bid in the last 15 minutes adds 15 minutes.</li>
      <li>Outbid? Your ETH comes back in the same transaction.</li>
    </ul>
    <h4>The split</h4>
    <p class="muted">2% fee, then the rest goes to the 80 Credits that made it: 1/80 each, or 1.5× for the first in down to 0.5× for the last on Early bird. Every member is paid when the auction settles.</p>
    <p class="small muted">Hits 80/80 after launch? It gets 5 minutes to leave from that moment, then locks. <a href="/docs#how">How it works</a></p>`;
  document.body.append(d);
  d.addEventListener('close', () => d.remove());
  openModal(d);
}
