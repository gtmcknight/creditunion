import { parseAbi, parseEther, type Address } from 'viem';
import { batchAbi, creditsAbi, factoryAbi, sweeperAbi, unionFormatsAbi } from '../abi';
import { adapterAbi } from '../adapter-abi';
import { canBatch, config, explorer, pub, send, sendBatch, session } from '../chain';
import { ARRANGEMENTS, burnAdapter, ratingTotal, getSummary, spotsSaved, type PhaseName, earlyShare, earlyWeight, sharePct, eligible, getBatch, hasLayout, indexedBatch, indexedOne, keepPick, keptSpots, layoutSlot, me, notice, pickOf, placeOnLayout, readNotice, ratings, sinceTx, staleBatches, type Rated, burnsAt } from '../data';
import { filterRules, maskInks, maskLabel, paletteBit, type Rule } from '../traits';
import { ens, hydrate, identicon, pct, who } from '../ens';
import { creditCard, examples, fillGhosts, planGhosts, registerDeposits, registerFilter } from '../ghosts';
import { gapOf, Guide, inOrder, landing, planOf, sliceBase, unpackPicture, type Plan, type Stored, OWN_GOOD, runOf } from '../picture';
import { Room, books, keysOf, noRoomReason, placedKeys, type Books } from '../slots';
import { MAX_SWEEP, buying, checkQuote, listedById, connectToBuy, live as keepLive, minEth, priceTag, relist, sweepControls, sweepRow, type Listed, type Quote, type Sale, type Source } from '../forsale';
import { creditCell, creditSkel } from './trait';
import { shareButton } from '../share';
import { directionCanvas, directions, mountDirections, pickedDirection, primeInks, sheetInks, showDirection, viewerPicked, warmInks } from '../directions';
import { markOutbidSeen, offerAlerts } from '../outbid';
import { onReturn } from '../visible';
import { activityFold, ago } from './live';
import { $$, art, clock, errText, dayAndTime, esc, eth, localTime, openModal, same, setRange, sheet, short, startsAt, statementArt, timeLeft, toast, until } from '../ui';
import { stamp } from '../../shared/stamp';
import { slotName } from '../../shared/layout';
import { compose, DIRECTIONS, paint as paintMarks, PAGE, SHOWN, type Direction } from '../../shared/statement';
import { go as navigate } from '../main';

const CHUNK = 40; // Credits per transaction; keeps each one well under the block gas limit
// One Credit sent straight to the party: the Batch records the sender as depositor, no approval needed.
// The Batch errors ride along so a revert in its receive hook reads plainly.
const directAbi = [
  ...parseAbi(['function safeTransferFrom(address from, address to, uint256 tokenId)']),
  ...batchAbi.filter((x) => x.type === 'error'),
] as const;
const RATING_URL = 'https://jack.art/credits/rating';
/// The burn button's label, word for word wherever the page tells people to press it.
const CONVERT = 'Convert Union to Statement';
/// After a full union's 5 minutes to leave: an hour in which anyone may press it. Nobody is paid to, and nothing
/// presses it for them.
const THEN_CONVERT = `Then anyone has an hour to press ${CONVERT}.`;
const fmtScore = (s: number) => (Math.floor(s * 100) / 100).toFixed(2);

/// Hovering one of your Credits in a picker: the same card as the sheet's cells (ghosts.ts): its number and rating,
/// where it sits (`pos`, when it's already in), and that it's yours. Ratings are read once, the first time you hover.
let pickTip: HTMLElement | null = null;
function pickTips(el: HTMLElement, ids: bigint[], pos?: Map<string, number>, earlyOf?: () => boolean) {
  let rated: Record<string, Rated> | null = null, n = 0, loading: Promise<void> | null = null;
  const load = () => (loading ??= ratings(ids).then((r) => { rated = r.ratings; n = r.n; }).catch(() => {}));
  const tip = (pickTip ??= Object.assign(document.createElement('div'), { className: 'slot-tip pick-tip' }));
  if (!tip.isConnected) document.body.append(tip);
  const body = (id: string) => {
    const r = rated?.[id];
    return creditCard(id, { rating: r ? fmtScore(r.score) : undefined, pos: pos?.get(id), early: pos?.has(id) ? earlyOf?.() : false });
  };
  let shown: string | null = null;
  const place = (b: HTMLElement) => {
    const r = b.getBoundingClientRect(), w = tip.offsetWidth, h = tip.offsetHeight;
    const x = Math.min(Math.max(8, r.left + r.width / 2 - w / 2), innerWidth - w - 8);
    const y = r.top - h - 10 > 8 ? r.top - h - 10 : r.bottom + 10;
    tip.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  };
  el.addEventListener('pointerover', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('.pick');
    if (!b || e.pointerType === 'touch') return;
    shown = b.dataset.id!;
    tip.innerHTML = body(shown);
    tip.classList.add('in');
    place(b);
    void load().then(() => {
      if (shown === b.dataset.id && tip.classList.contains('in')) { tip.innerHTML = body(shown); place(b); }
    });
  });
  el.addEventListener('pointerout', (e) => {
    const to = (e.relatedTarget as HTMLElement | null)?.closest('.pick');
    if (to && el.contains(to)) return;
    shown = null;
    tip.classList.remove('in');
  });
}

type Ctx = Awaited<ReturnType<typeof getBatch>>;
type Mine = Awaited<ReturnType<typeof me>> | null;

/// The party's link, stamped with where it stands, so X, Telegram and the rest fetch a fresh card for it
/// instead of showing the one they cached for an earlier state.
const shareUrl = (s: Ctx['s']) => `${location.origin}/union/${s.address}?s=${stamp(s.state, s.count, s.highBid)}`;

let picks = new Set<string>();

// ---------------------------------------------------------------- picture unions
const plansOf = new Map<string, Promise<Plan | null>>();
/// Unions known (from their saved picture) to be Picture unions.
const isPictureUnion = new Set<string>();
/// Unions whose live plan has placed its Credits: the saved picture's quick draw must not overwrite them.
const livePlanned = new Set<string>();
/// The same plan again without some listings (sold since the market was read), per union.
const replans = new Map<string, (gone: ReadonlySet<number>) => Promise<Plan | null>>();
/// The picture against every Credit that could draw it, per union and viewer (reading them is the slow part).
const guides = new Map<string, Promise<Guide | null>>();
/// `held`: the viewer's Credits, whose Colors are read as this union reads them (Batch._keyOf).
/// `gone`: planned listings no longer for sale.
async function planPicture(b: Ctx, slots: number[], placed: (bigint | null)[] | undefined, account: Address | undefined, held: readonly bigint[] = [], gone: ReadonlySet<number> = new Set()) {
  const key = `${b.s.address.toLowerCase()}:${account?.toLowerCase() ?? ''}`;
  let g = guides.get(key);
  if (!g) {
    g = fetch(`/pictures/${b.s.address}`)
      .then((r) => (r.ok ? (r.json() as Promise<Stored>) : null))
      .then(async (d) => {
        if (!d) return null;
        const keys = held.length ? await keysOf(0, held).catch(() => new Map<string, number>()) : new Map<string, number>();
        if (d.look) looks.set(b.s.address.toLowerCase(), d.look);
        // Only the listings of its Colors at the plan's price, and yours, not the whole edition and market (sliceBase).
        const base = sliceBase(slots, account ? held : []);
        return Guide.of(unpackPicture(d.px), { wallets: account ? [account] : [], held: account ? held : undefined, colours: (id) => keys.get(id.toString()) ?? 0, detail: d.detail, own: config.sweeper ? OWN_GOOD : 1, look: d.look, base }); // testnets can't buy: there yours lead
      });
    guides.set(key, g);
    g.catch(() => guides.delete(key));
  }
  const guide = await g;
  if (!guide) return null;
  const rec = guide.fillYoursFirst(slots, placed ? placed.map((x) => (x === null ? null : Number(x))) : slots.map(() => null), gone);
  planGhosts(b.s.address, rec.map((c) => c?.id ?? null));
  livePlanned.add(b.s.address.toLowerCase());
  return planOf(rec, slots, placed, guide.twins(slots));
}
/// A picture union: the Credits picked to deposit or buy show at full ink in their spots on the sheet, so each shows
/// where it goes before it's in. `from`: which pick changed (the Deposit tab's or the Buy tab's; both stay lit).
const chosenSpots = { mine: new Set<string>(), buy: new Set<string>() };
function chooseSpots(from: 'mine' | 'buy', ids: Iterable<string>) {
  chosenSpots[from] = new Set(ids);
  const art = document.querySelector<HTMLElement>('.batch-art');
  if (!art) return;
  const on = new Set([...chosenSpots.mine, ...chosenSpots.buy]);
  let changed = false;
  art.querySelectorAll<HTMLElement>('.sheet > .cell').forEach((c) => {
    const lit = !c.dataset.id && !!c.dataset.ghost && on.has(c.dataset.ghost);
    if (c.classList.contains('chosen') !== lit) (c.classList.toggle('chosen', lit), (changed = true));
  });
  if (changed) art.dispatchEvent(new CustomEvent('ghosts', { bubbles: true }));
}
/// A Picture union's buy locks (worker/locks.ts): Colors someone is buying right now can't be bought by anyone else
/// until their transaction lands, so no Credit lands a slot late. A lock gives a minute to confirm in the wallet; then
/// the transaction it sent holds it, said again every 20 s until it's released (every 5 s while the Worker hasn't seen
/// the transaction yet). Null answers mean locks are off (testnets, local).
type LockOp = { op: 'acquire'; id: string; account: string; colours: number[] } | { op: 'hold'; id: string; tx: string } | { op: 'release'; id: string };
const holding = new Map<string, number>();
const released = new Set<string>();
async function locks(batch: string, body?: LockOp) {
  if (body && body.op !== 'acquire') clearTimeout(holding.get(body.id));
  if (body?.op === 'release') released.add(body.id);
  const r = await fetch(`/locks/${batch}`, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}).catch(() => null);
  if (body?.op === 'hold' && (r?.status === 204 || r?.status === 202) && !released.has(body.id)) holding.set(body.id, setTimeout(() => void locks(batch, body), r.status === 202 ? 5_000 : 20_000));
  if (!r?.ok || r.status === 204 || r.status === 202) return null;
  return r.json() as Promise<{ held?: number[]; ok?: boolean; busy?: number[]; until?: number }>;
}
/// Listings (or Credits) in the order the picture wants them: its recommended ones by slot, then the rest as they were.
const byPlan = <T extends { id: string }>(list: T[], plan: Plan | null | undefined) =>
  !plan ? list : [...inOrder(plan, list.filter((l) => plan.slot.has(l.id)).map((l) => l.id)).map((id) => list.find((l) => l.id === id)!), ...list.filter((l) => !plan.slot.has(l.id))];
/// A Credit to preselect once its picker draws (the ?pick= link).
let pickAsk: { at: string; id: string } | null = null;
/// Which Add Credits tab is open, per Credit Union, so a live refresh doesn't flip it back.
let addTab: { at: string; tab: string } | null = null;
/// /union/0x…?burn: the union whose page shows Convert Union to Statement before burns open (our own first burn on burn day).
/// Read before the query string is cleared from the address bar, and kept for the visit.
let burnAsk: string | null = null;
/// /union/0x…?convert (a card's or the site bar's Convert): the union whose Convert button is brought into view.
let convertAsk: string | null = null;
/// Transactions in flight on this page: live refreshes wait while one is.
let busy = 0;
/// Drawings of a union page started, so a late redraw knows when a newer one has replaced it.
let draws = 0;
/// The live-refresh timer for the Credit Union on screen (one at a time).
let live: ReturnType<typeof setInterval> | null = null;
const LIVE_MS = 8_000; // under a block: the index it reads is kept for everyone, so a poll costs no chain read
/// An auction's page looks more often, a quarter of a block apart: being outbid is a race. It reads the same index
/// (the site reads every union once a block), so watching costs no chain read; a bid checks the chain itself.
const AUCTION_MS = 3_000;
/// A bid that lost the race to someone else's: the page redraws with the new minimum filled in (`bidAgain`).
class Outbid extends Error {}
const bidAgain = new Set<string>();
/// A bid typed signed out, kept for the drawing after the wallet connects.
let typedBid: { at: string; v: string } | null = null;
/// How long after this wallet's own transaction the page reads the chain rather than the index.
const TX_MS = 30_000;

/// `got`: the union as a live refresh just read it, drawn without reading it again. `kept`: your side of it from the
/// drawing before, when nothing that changed could have moved it.
export async function party(app: HTMLElement, address: Address, rerender: () => void, got?: Ctx & { at?: number }, kept?: Mine) {
  let b: Ctx;
  let at = got?.at ?? 0;
  const account = session.account;
  // Your side of it (shares, what you're owed, your Credits), read alongside the Credit Union, not after it.
  const mine = account ? (kept ? Promise.resolve(kept) : me(address, account)) : null;
  // From the Credit Union index when a page read it in the last minute (being in it is being ours): the page shows at
  // once, and is checked against the chain right after. Otherwise from the Worker's index of it (a few seconds old,
  // no chain read), unless this wallet just sent a transaction the index may not have yet. Otherwise only parties our
  // factory made: any contract can answer summary() with a made-up party. A read that fails (the network, a rate
  // limit) says so, rather than that the Credit Union doesn't exist.
  const indexed = got ? null : indexedBatch(address);
  const one = got || indexed || sinceTx() < TX_MS ? null : await indexedOne(address);
  if (got) b = got;
  else if (indexed) b = indexed.b;
  else if (one) {
    b = one;
    at = one.at;
  } else {
    const [ours, got] = await Promise.all([
      pub.readContract({ address: config.factory, abi: factoryAbi, functionName: 'isBatch', args: [address] }).catch(() => null),
      getBatch(address).catch(() => null),
    ]);
    if (!ours || !got) {
      mine?.catch(() => {});
      app.innerHTML = `<section class="prose"><h1>${ours === false ? 'Credit Union not found' : 'Couldn’t load this Credit Union'}</h1><p>${ours === false ? '' : 'Refresh to try again. '}<a href="/unions">← Credit Unions</a></p></section>`;
      return;
    }
    b = got;
  }
  // /union/0x…?pick=123 (from a Credit's page): open on Your Credits with that one picked, if it fits.
  const want = new URLSearchParams(location.search).get('pick');
  if (want && /^\d{1,6}$/.test(want)) {
    pickAsk = { at: address.toLowerCase(), id: want };
    addTab = { at: address, tab: 'mine' };
  }
  if (new URLSearchParams(location.search).has('burn')) burnAsk = address.toLowerCase();
  if (new URLSearchParams(location.search).has('convert')) convertAsk = address.toLowerCase();
  // Burn day's notice: a full union waiting on it says when burning starts (read already for the bar, kept a minute).
  if (b.s.state === 'Full' && b.s.phase === 'Waiting') await readNotice();
  if (location.search) history.replaceState(history.state, '', location.pathname);
  const s = b.s;
  const burned = s.state === 'Auction' || s.state === 'Settled';
  // Once it's a Statement, the union lives under Auctions.
  document.querySelectorAll<HTMLAnchorElement>('[data-nav="parties"], [data-nav="auctions"]').forEach((a) => a.toggleAttribute('aria-current', a.dataset.nav === (burned ? 'auctions' : 'parties')));
  // On a layout batch the sheet shows every Credit in the slot it will burn into, not in deposit order.
  const slots = hasLayout(s.filter) ? Array.from({ length: 80 }, (_, i) => layoutSlot(s.filter, i)) : null;
  // The value of the painted trait each Credit in was booked under (Batch.keyOf), read alongside the wallet's
  // own reads rather than after them.
  const keysRead = slots && !burned ? placedKeys(s.address, b.ids).catch(() => null) : null;
  // A picture's spots as the burn contract keeps them, once it's on: after a leave only that spot is open.
  const spotsRead = slots?.every((v) => v) && !Number(s.filter.layoutTrait ?? 0) && !burned && b.ids.length ? keptSpots(s.address) : null;
  // Your side, if it's back within a moment. Otherwise the page draws without it (as for a visitor) and draws again,
  // in place, when it lands: a slow wallet read never holds the whole page blank.
  const drawing = ++draws;
  const LATE = Symbol();
  const quick = mine ? await Promise.race([mine.catch(() => null), new Promise<typeof LATE>((r) => setTimeout(() => r(LATE), 150))]) : null;
  const m: Mine = quick === LATE ? null : quick;
  if (quick === LATE)
    void mine!.then((got) => {
      if (drawing === draws && app.isConnected && location.pathname.toLowerCase().endsWith(address.toLowerCase()) && same(session.account, account))
        void party(app, address, rerender, { ...b, at }, got);
    }, () => {});
  const myIds = new Set(b.ids.filter((_, i) => same(b.depositors[i], account)).map(String));
  // A color layout's rows already name every mix that fits, so its Palette row would only repeat them.
  const rules = filterRules(s.filter, s.allowlistSize, (i) => layoutSlot(s.filter, i)).filter((r, _, all) => !(r.label === 'Palette' && all.some((x) => x.swatch)));
  const depositors = new Set(b.depositors.map((d) => d.toLowerCase())).size;
  // The only member of a picture union can still leave: with nobody else in, nothing of theirs shifts. All at once,
  // so the picture restarts from an empty union rather than a gap.
  const solo = myIds.size > 0 && depositors === 1;
  const soloOut = () => {
    document.getElementById('w-picker')?.setAttribute('hidden', '');
    document.getElementById('w-clear')?.setAttribute('hidden', '');
  };
  // Faces beside the member count: the 8 who put in the most Credits (avatars and names fill in by hydrate).
  const byCredits = new Map<string, { a: Address; n: number }>();
  for (const d of b.depositors) {
    const r = byCredits.get(d.toLowerCase()) ?? { a: d, n: 0 };
    r.n++;
    byCredits.set(d.toLowerCase(), r);
  }
  // The 16 who put in the most are candidates; four show, members with an avatar first (rankFaces, once ENS answers),
  // and you, if you're in, as the fourth: the last face, drawn on top, beside "You and 38 others".
  const youIn = !!account && byCredits.has(account.toLowerCase());
  const face = (a: Address, you = false) => `<span class="face"${you ? ' data-you' : ''} data-ens="${esc(a)}"><img src="${identicon(a)}" alt=""><span class="who-name" hidden></span></span>`;
  const others = [...byCredits.values()].filter((r) => !same(r.a, account)).sort((x, y) => y.n - x.n).slice(0, 15).map((r) => face(r.a));
  if (youIn) others.splice(Math.min(3, others.length), 0, face(account!, true));
  const faces = others.join('');

  // Cells added since this browser last saw the batch drop in, in deposit order.
  const seenKey = `cu-seen-${address}`;
  let seen = s.count;
  try {
    seen = Number(sessionStorage.getItem(seenKey) ?? s.count);
    sessionStorage.setItem(seenKey, String(s.count));
  } catch {}

  let placed: (bigint | null)[] | undefined;
  // The keys place the Credits in, and tell the picker what room is left. Null when unread (the picker then
  // falls back to the rules alone).
  const keyed: Map<string, number> | null = keysRead ? await keysRead : null;
  if (slots && keyed) {
    try {
      placed = b.ids.length ? placeOnLayout(slots, b.ids, (id) => keyed.get(id.toString()) ?? 0) : undefined;
    } catch {}
  }
  const spots = spotsRead ? await spotsRead : null;
  if (spots) placed = spots;
  // Keys unread even after retrying: the sheet can't show where the Credits go, so it says so instead of drawing them
  // in deposit order.
  const unplaced = !!slots && !burned && b.ids.length > 0 && !placed;
  // Slot rows: while open (and where each Credit sits is known), the spaces left; otherwise how many slots.
  const counting = s.state === 'Open' && (!!placed || b.ids.length === 0);
  for (const r of rules)
    if (r.slots) {
      const left = r.slots.filter((i) => placed?.[i] == null).length;
      r.label = r.swatch ? maskLabel(r.swatch) : r.label.replace(/ slots$/, ''); // the contract's own names: MYK, CMYK
      r.value = counting ? (left ? `${left} left` : 'Full') : `${r.slots.length} ${r.slots.length === 1 ? 'slot' : 'slots'}`;
      if (counting && !left) r.full = true;
    }
  registerFilter(s.address, s.filter);
  registerDeposits(b.ids, b.depositors, b.s.split === 1);
  // A choice that no longer applies (the union filled, or your Credits left) falls back to Now.
  const artHtml = burned
    ? `<figure class="statement"><div class="statement-host">${sheet(b.ids, { closed: true })}${statementArt(s.statementId)}</div>${directionCanvas}<figcaption class="legend muted small">${directions(s.address, false, true)}<div class="legend-end"><span>Statement #${s.statementId}</span>${shareButton()}</div></figcaption></figure>`
    : `${sheet(b.ids, { mine: myIds, fresh: placed ? undefined : seen < s.count ? seen : undefined, closing: s.state === 'Full', placed, batch: s.state === 'Open' ? s.address : undefined })}${unplaced ? '' : directionCanvas}
       <div class="legend muted small">${unplaced ? '<span>Couldn’t read which slot each Credit fills. Refresh to try again.</span>' : `<div class="legend-end"><span class="burns-in" hidden></span>${shareButton()}</div>${directions(s.address, false, true)}`}</div>
       ${unplaced ? '' : formatBox}`;

  app.innerHTML = `
  
  <section class="batch">
    <div class="batch-art dir-host" data-show="now" data-name="${esc(s.name || 'Untitled')}">${artHtml}</div>
    <div class="batch-side">
      <header>
        ${burned ? `<h3 class="side-label">Statement #${s.statementId}</h3>` : ''}
        <h1>${esc(s.name || 'Untitled')}</h1>
      </header>
      <dl class="kv">
        <div><dt>Creator</dt><dd>${who(s.creator, 'sm', true)}${s.creatorFeeBps ? ` <span class="muted">· ${pct(s.creatorFeeBps)} fee</span>` : ''}</dd></div>
        <div><dt>Members</dt><dd>${
          depositors
            ? `<button type="button" class="link members-btn" id="depositors-btn"><span class="faces" aria-hidden="true">${faces}</span>${
              youIn ? (depositors === 1 ? 'You joined' : `You and ${depositors - 1} ${depositors === 2 ? 'other' : 'others'} joined`) : `${depositors} joined`
            }</button>`
            : '<span>None yet</span>'
        } <span class="muted">· ${s.split === 1 ? 'early bird' : 'split equally'}</span></dd></div>
        ${s.state === 'Open' || s.state === 'Full' || s.state === 'Expired' ? `<div><dt>Credits</dt><dd>${s.count} <span class="muted">of 80 in</span>${
            s.state === 'Open' && s.count < 80 ? ` <span class="muted">·</span> <span class="hover-show" data-hover-show="finished">see it finished</span>` : ''
          }${myIds.size ? ` <span class="muted">·</span> <span class="hover-show" data-hover-show="yours">${myIds.size} ${myIds.size === 1 ? 'is' : 'are'} yours</span>` : ''}</dd></div>` : ''}
        ${s.count ? fact('Rating', `<span id="rating" class="muted">…</span>`) : ''}
        <div class="takes"><dt>Rules</dt><dd>${rules.length ? rules.map(rule).join('') : 'Any Credit'}</dd></div>
      </dl>
      <details class="kv-more">
        <summary><span class="when-closed">More details</span><span class="when-open">Fewer details</span></summary>
        <dl class="kv">
          ${fact('Layout', `<span class="layout-name">${ARRANGEMENTS[s.arrangement] ?? 'Order joined'}</span>`)}
          ${s.reserve && (s.state === 'Open' || s.state === 'Full' || (s.state === 'Auction' && s.minBid === s.reserve && !s.highBid)) ? fact('Reserve', `${minEth(s.reserve)} ETH`) : ''}
          ${fact('Split', split(s))}
          ${s.split === 1 ? fact('Early bird', `1st ${sharePct(earlyShare(0))} <span class="muted">→</span> 80th ${sharePct(earlyShare(79))}`) : ''}
          ${fact('Contract', link(s.address))}
        </dl>
      </details>
      <div id="panel">${panel(b, m, myIds, quick === LATE)}</div>
      <div class="folds">
      ${s.state === 'Settled' ? `<details class="more" id="unclaimed" hidden>
        <summary><span>Unclaimed</span><span class="muted small num" id="unclaimed-total"></span></summary>
        <div class="dues" id="unclaimed-list"></div>
        <p class="small muted">Anyone can send a member their share. It goes to them, you pay the gas.</p>
      </details>` : ''}
      <section class="activity-block" id="activity">
        <h3>Activity</h3>
        <ol class="live-list fold-list short" id="activity-list"><li class="muted live-empty">Loading…</li></ol>
        <button type="button" class="link small activity-all" id="activity-all" hidden></button>
      </section>
      </div>
    </div>
  </section>`;
  hydrate(app);
  void rankFaces(app);
  document.getElementById('depositors-btn')?.addEventListener('click', () => openDepositors(b, account ?? null));
  app.querySelector('.rule[data-picked]')?.addEventListener('click', () => void openPicked(b));
  void activityFold(s.address, s.state === 'Auction' ? { who: s.highBidder, wei: s.highBid } : undefined);
  // Chrome keeps a focus ring on <summary> after a mouse click; drop it for pointer use only.
  app.querySelectorAll<HTMLElement>('.more summary').forEach((el) => el.addEventListener('pointerup', () => setTimeout(() => el.blur(), 0)));
  fillGhosts(app);
  // What burns is what shows: a layout painted in colors with every slot painted burns in Consolidated unless its
  // creator picks another format (StatementAdapter.formatOf), so its sheet opens in Consolidated too.
  const picture = !!slots?.every((v) => v) && !Number(s.filter.layoutTrait ?? 0);
  if (!burned && picture && !pickedDirection(s.address)) showDirection(app.querySelector<HTMLElement>('.batch-art .dirs'), opensIn(s.address, 'Consolidated'));
  if (!burned) void burnFormat(app, s, picture);
  else void realFormat(app, s);
  // A Picture union once it's full (until the burn): still a picture, drawn in Consolidated.
  if ((s.state === 'Full' || s.state === 'Expired') && slots && !Number(s.filter.layoutTrait ?? 0)) {
    const host = app.querySelector<HTMLElement>('.batch-art');
    void fetch(`/pictures/${s.address}`).then(async (r) => {
      const saved = r.ok ? ((await r.json().catch(() => null)) as { look?: Direction } | null) : null;
      if (!saved || !host?.isConnected) return; // null: not a picture
      isPictureUnion.add(s.address.toLowerCase());
      // Matched in another format: the sheet opens in it (unless you've switched it yourself).
      if (saved.look) (looks.set(s.address.toLowerCase(), saved.look), !viewerPicked(s.address) && showDirection(host.querySelector<HTMLElement>('.dirs'), opensIn(s.address, 'Consolidated')));
      app.querySelectorAll('.layout-name').forEach((e) => (e.textContent = 'Picture'));
      const takes = app.querySelector('.takes');
      if (takes) takes.innerHTML = '<dt>Rules</dt><dd>Only the Credits that draw its picture</dd>';
      if (!pickedDirection(s.address)) showDirection(host.querySelector<HTMLElement>('.dirs'), opensIn(s.address, 'Consolidated'));
      if (solo) soloOut();
    }, () => {});
  }
  // A Picture union: its open slots show the Credits that draw it best, and Buy and Deposit lead with them.
  if (s.state === 'Open' && slots && !Number(s.filter.layoutTrait ?? 0)) {
    const host = app.querySelector<HTMLElement>('.batch-art');
    // The plan counts the viewer's own Credits beside the listings: one of yours takes a spot when it draws it about as
    // well as the best for sale (OWN_GOOD), and goes in from the Deposit tab.
    const who = account ?? undefined, held = m?.owned ?? [];
    // Known to be a picture as soon as its saved picture answers (the plan itself takes seconds): say so, and on
    // mainnet drop Deposit at once, so nobody sees a Painted union's Deposit tab in the meantime.
    void fetch(`/pictures/${s.address}`).then(async (r) => {
      const saved = r.ok ? ((await r.json().catch(() => null)) as { ids?: (number | null)[]; inks?: Record<string, [string, number, number]>; look?: Direction } | null) : null;
      if (!saved || !host?.isConnected) return; // null: not a picture
      isPictureUnion.add(s.address.toLowerCase());
      // Matched in another format: the sheet opens in it (unless you've switched it yourself).
      if (saved.look) (looks.set(s.address.toLowerCase(), saved.look), !viewerPicked(s.address) && showDirection(host.querySelector<HTMLElement>('.dirs'), opensIn(s.address, 'Consolidated')));
      // Made to burn in a format (its creator's pick, set as it opened): it opens in that one.
      void pickOf(s.address).then((f) => {
        if (f == null || f >= DIRECTIONS.length || !host.isConnected) return;
        picked.set(s.address.toLowerCase(), DIRECTIONS[f]);
        if (!viewerPicked(s.address)) showDirection(host.querySelector<HTMLElement>('.dirs'), DIRECTIONS[f]);
      });
      warmInks(b.ids); // the Credits already in: read while the picture's own answer is parsed
      // Draw the picture now from the Credits saved with it (their ink comes along); the live plan, seconds later,
      // swaps in a replacement wherever a saved one has sold.
      if (saved.ids && !livePlanned.has(s.address.toLowerCase())) {
        primeInks(saved.inks);
        planGhosts(s.address, saved.ids);
        await fillGhosts(app);
        if (!host.isConnected) return;
        if (!pickedDirection(s.address)) showDirection(host.querySelector<HTMLElement>('.dirs'), opensIn(s.address, 'Consolidated'));
      }
      app.querySelectorAll('.layout-name').forEach((e) => (e.textContent = 'Picture'));
      // Who can join: a picture union takes exactly the Credits that draw it, so the Colors chips say nothing useful.
      const takes = app.querySelector('.takes');
      if (takes) takes.innerHTML = '<dt>Rules</dt><dd>Only the Credits that draw its picture</dd>';
      // The only member can always leave, all at once; anyone else's leave opens only their spots (see unsavedSpots).
      const leave = document.querySelector('.pane-note .leave-note');
      if (solo) soloOut();
      if (leave) leave.textContent = solo ? 'You can leave while you’re the only member.' : 'Leave anytime until it locks: your spot opens and the rest of the picture stays put.';
    }, () => {});
    const plan = planPicture(b, slots, placed, who, held).catch(() => null);
    plansOf.set(s.address.toLowerCase(), plan);
    replans.set(s.address.toLowerCase(), (gone) => planPicture(b, slots, placed, who, held, gone).catch(() => null));
    void plan.then(async (p) => {
      if (!p || !host?.isConnected) return;
      // …and in Consolidated, the direction a picture is matched in, unless you picked another.
      await fillGhosts(app); // the planned Credits into the sheet first, so the direction draws them
      if (!pickedDirection(s.address)) showDirection(host.querySelector<HTMLElement>('.dirs'), opensIn(s.address, 'Consolidated'));
      fillGhosts(app);
    });
  }
  // A Credit on the sheet opens its own page.
  app.querySelector('.batch-art')?.addEventListener('click', (e) => {
    const c = (e.target as HTMLElement).closest<HTMLElement>('.cell[data-id]');
    if (!c) return;
    if ((e as MouseEvent).metaKey || (e as MouseEvent).ctrlKey) window.open(`/credit/${c.dataset.id}`, '_blank');
    else navigate(`/credit/${c.dataset.id}`);
  });
  const art = app.querySelector<HTMLElement>('.batch-art');
  // "see it finished" and "5 are yours": hovering one shows the sheet (in whichever format) complete, or with only
  // your Credits in ink; leaving it goes back to how it stands.
  app.querySelectorAll<HTMLElement>('[data-hover-show]').forEach((el) => {
    if (!art) return;
    const set = (v: string) => {
      art.dataset.show = v;
      art.dispatchEvent(new CustomEvent('ghosts', { bubbles: true }));
    };
    el.addEventListener('pointerenter', () => set(el.dataset.hoverShow!));
    el.addEventListener('pointerleave', () => set('now'));
  });
  app.querySelectorAll<HTMLElement>('.rule[data-slots]').forEach((row) => {
    row.addEventListener('pointerenter', () => {
      const cells = [...(art?.querySelector('.sheet')?.children ?? [])];
      const on = row.dataset.slots === 'all' ? null : new Set(row.dataset.slots!.split(',').map(Number));
      cells.forEach((c, i) => c.classList.toggle('lit', !on || on.has(i)));
      art?.classList.add('lighting');
    });
    row.addEventListener('pointerleave', () => {
      art?.classList.remove('lighting');
      art?.querySelectorAll('.cell.lit').forEach((c) => c.classList.remove('lit'));
    });
  });
  bind(b, m, myIds, rerender, keyed);
  watchLive(app, address, b, rerender, !!indexed, at, m);
  // Just made on the create page: congratulate once. The flag goes as soon as it's read, so a refresh won't reshow it.
  try {
    if (sessionStorage.getItem('cu-created')?.toLowerCase() === address.toLowerCase()) {
      sessionStorage.removeItem('cu-created');
      openCreated(b, placed);
    }
    // Just deposited here: the same card, as "You're in", with how many went in.
    const [joinedAt, n] = (sessionStorage.getItem('cu-joined') ?? '').split(':');
    if (joinedAt?.toLowerCase() === address.toLowerCase()) {
      sessionStorage.removeItem('cu-joined');
      openCreated(b, placed, Number(n) || 1);
    }
  } catch {}
}

/// Keep the page current while someone sits on it: every block or so, read the union and redraw when it changed
/// (someone deposited, withdrew, bid, or it locked). Which Credits are in and whose they are count too, so a deposit
/// and a withdrawal in the same block, which leave the count where it was, still show. Waits while the tab is hidden, a
/// transaction is in flight or a dialog is open. New Credits drop in with the usual animation. `now`: look once
/// straight away too (the page was drawn from the index, which can be a few seconds old). Reads the Worker's index
/// of the union (one read for everyone watching), or the chain for a while after this wallet's own transaction;
/// `at` is how new the page's read is, so an older index answer never takes the page back.
function watchLive(app: HTMLElement, address: Address, b: Ctx, rerender: () => void, now = false, at = 0, m: Mine = null) {
  if (live) clearInterval(live);
  const mark = ({ s, ids, depositors }: Ctx) => `${stamp(s.state, s.count, s.highBid)}:${s.lockAt}:${s.state}:${ids.join()}:${depositors.join().toLowerCase()}:${notice?.at ?? ''}`;
  const was = mark(b);
  const path = location.pathname;
  let looking = false; // one look at a time: a tick and a return to the tab can land together
  const look = async () => {
    if (location.pathname !== path || !app.isConnected) {
      clearInterval(live!);
      live = null;
      return;
    }
    if (looking || document.hidden || busy || document.querySelector('dialog[open]')) return;
    looking = true;
    try {
      const one = sinceTx() < TX_MS ? null : await indexedOne(address);
      if (one && one.at < at) return; // an older read than the page's
      const n: Ctx & { at?: number } = one ?? (b.s.state === 'Auction' ? { ...b, s: await getSummary(address) } : await getBatch(address));
      if (n.s.state === 'Full') await readNotice();
      if (location.pathname !== path || busy) return;
      if (mark(n) !== was) {
        clearInterval(live!);
        live = null;
        staleBatches(); // the lists should show it changed too
        // Someone else's deposit or bid leaves your side as it was (your shares, your Credits): it's read again only
        // when the union moves to another state (a settle makes a payout claimable) or your bid was just topped.
        const you = session.account;
        const topped = !!you && same(b.s.highBidder, you) && !same(n.s.highBidder, you);
        if (topped && n.s.state === 'Auction') {
          bidAgain.add(address.toLowerCase());
          markOutbidSeen(address, n.s.highBid);
          toast(`You’ve been outbid: the high bid is now ${eth(n.s.highBid)}. ${minEth(n.s.minBid)} ETH takes it back.`, 'info', 8000);
        }
        await party(app, address, rerender, n, n.s.state === b.s.state && !topped ? m : undefined);
      }
    } catch {
    } finally {
      looking = false;
    }
  };
  const timer = (live = setInterval(look, b.s.state === 'Auction' ? AUCTION_MS : LIVE_MS));
  onReturn(look, () => live === timer);
  if (now) void look();
}

/// Remember a deposit that just landed, so the rerendered page opens the "You're in" card once.
function justJoined(address: string, n: number) {
  try {
    sessionStorage.setItem('cu-joined', `${address}:${n}`);
  } catch {}
}

/// Congrats on a new Credit Union, or on joining one (`joined` = Credits just deposited), with its link and
/// ways to pass it on.
function openCreated(b: Ctx, placed?: (bigint | null)[], joined?: number) {
  const s = b.s;
  const url = shareUrl(s);
  const name = s.name || 'Untitled';
  const left = 80 - s.count;
  const text = joined
    ? `I joined ${name}, a Credit Union pooling 80 Credits into a Statement.${left > 0 ? ` ${left} to go.` : ''}`
    : `Join my Credit Union: ${name}. 80 Credits make a Statement.`;
  const x = `https://x.com/intent/post?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`;
  const d = document.createElement('dialog');
  d.className = 'created';
  d.innerHTML = `<form method="dialog">
    <div class="created-art">${sheet(b.ids, { size: 'sm', placed })}</div>
    <div class="created-head"><h3>${joined ? 'You’re in' : 'Your Credit Union is live'}</h3><p class="muted">${joined ? `${joined} ${joined === 1 ? 'Credit' : 'Credits'} in ${esc(name)} · ${left > 0 ? `${left} to go` : 'full'}` : esc(name)}</p>
      <p class="muted">At 80, withdrawals close after 5 minutes. ${THEN_CONVERT}</p></div>
    <input class="created-link" type="text" readonly value="${esc(url)}" aria-label="Credit Union link">
    <div class="created-actions">
      <a class="btn primary" href="${esc(x)}" target="_blank" rel="noopener">Share on X</a>
      <button type="button" class="btn" id="created-copy">Copy link</button>
    </div>
  </form>`;
  document.body.append(d);
  const link = d.querySelector<HTMLInputElement>('.created-link')!;
  link.addEventListener('focus', () => link.select());
  d.querySelector('#created-copy')!.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(url);
      toast('Link copied', 'ok', 2500);
    } catch {
      link.select();
    }
  });
  d.addEventListener('close', () => d.remove());
  openModal(d);
  // Focus the ×, not the link (focusing it selects the text), and without a ring: nobody tabbed here.
  (d.querySelector('.dialog-x') as HTMLElement).focus({ focusVisible: false } as FocusOptions);
}

/// "1% protocol · 5% creator · 94% to depositors"
function split(s: Ctx['s']) {
  const rest = 10_000 - s.protocolFeeBps - s.creatorFeeBps;
  return [`${pct(rest)} members`, s.creatorFeeBps ? `${pct(s.creatorFeeBps)} creator` : '', `${pct(s.protocolFeeBps)} protocol`]
    .filter(Boolean)
    .join(' · ');
}

const fact = (k: string, v: string) => `<div><dt>${k}</dt><dd>${v}</dd></div>`;
/// A rule inline in the Rules line: its inks and name (a slot colour: MYK), or its name and value (Palette Y, MYK).
/// Hovering it lights the slots it governs on the sheet (every slot unless it's a layout row); one with a trait page
/// links to it.
const rule = (r: Rule) => {
  const tag = r.href ? 'a' : r.picked ? 'button' : 'span';
  const inks = r.swatch ? `<span class="swatches">${maskInks(r.swatch).map((c) => `<i style="background:${c}"></i>`).join('')}</span>` : '';
  // A slot colour shows what's left only while the union is open ("12 left"); once it's filled the sheet says it.
  const text = r.slots ? `${esc(r.label)}${/left$/.test(r.value) ? ` <span class="muted">${esc(r.value)}</span>` : ''}` : `${esc(r.label)} ${esc(r.value)}`;
  return `<${tag} class="rule${r.full ? ' full' : ''}"${r.href ? ` href="${esc(r.href)}"` : ''}${r.picked ? ' type="button" data-picked' : ''} data-slots="${r.slots ? r.slots.join(',') : 'all'}">${inks}${text}</${tag}>`;
};
const link = (a: string) => {
  const u = explorer('address', a);
  return u ? `<a href="${u}" target="_blank" rel="noopener" class="mono">${short(a)} ↗</a>` : `<span class="mono">${short(a)}</span>`;
};
/// Where a full party stands right now: the summary's phase, moved on by the clock, since it reads the chain only on load.
/// The creator's box under the sheet: what it burns in, and a button to choose (the window below).
const formatBox = `<div class="box format-box" hidden>
  <div class="format-row">
    <div><h3>Pick the format it burns in</h3><p class="small muted"><span id="format-now"></span> You created this union, so it’s yours to choose.</p></div>
    <button type="button" class="btn" id="format-open">Choose format</button>
  </div>
</div>`;

/// The window: this union in all eight formats. Click one, then Set format. Resolves with the pick once it's set.
async function chooseFormat(host: HTMLElement, union: Address, burnsIn: Direction, at: Address, until: string): Promise<Direction | null> {
  const { list, ghosts } = await sheetInks(host);
  const d = document.createElement('dialog');
  d.className = 'formats-pick';
  d.innerHTML = `<form method="dialog">
    <h3>Pick the format it burns in</h3>
    <div class="fp-grid">${SHOWN.map((f) => `<button type="button" class="fp-tile" data-format="${f}" aria-pressed="${f === burnsIn}"><canvas aria-hidden="true"></canvas><span>${f}${f === burnsIn ? ' <em>now</em>' : ''}</span></button>`).join('')}</div>
    <p class="small muted">You can change it ${until}. After the sale, the winner can switch formats anytime.</p>
    <button type="button" class="btn primary block" id="fp-set" disabled>Set format</button>
  </form>`;
  document.body.append(d);
  openModal(d);
  d.querySelectorAll<HTMLButtonElement>('.fp-tile').forEach((t) => {
    const c = t.querySelector('canvas')!, W = Math.round((c.clientWidth || 160) * Math.min(3, devicePixelRatio || 1));
    c.width = W;
    c.height = Math.round((W * PAGE.h) / PAGE.w);
    paintMarks(c.getContext('2d')!, W, compose(t.dataset.format as Direction, list, ghosts));
  });
  const set = d.querySelector<HTMLButtonElement>('#fp-set')!;
  let choice = burnsIn;
  d.querySelector('.fp-grid')!.addEventListener('click', (e) => {
    const t = (e.target as Element).closest<HTMLButtonElement>('.fp-tile');
    if (!t) return;
    choice = t.dataset.format as Direction;
    d.querySelectorAll('.fp-tile').forEach((x) => x.setAttribute('aria-pressed', String(x === t)));
    set.disabled = choice === burnsIn;
    set.textContent = choice === burnsIn ? 'Set format' : `Set to ${choice}`;
  });
  return new Promise((done) => {
    let result: Direction | null = null;
    d.addEventListener('close', () => (d.remove(), done(result)));
    set.addEventListener('click', async () => {
      set.disabled = true;
      set.textContent = 'Confirm in your wallet…';
      try {
        await send({ address: at, abi: unionFormatsAbi, functionName: 'pick', args: [union, DIRECTIONS.indexOf(choice)] });
        result = choice;
        d.close();
      } catch (e) {
        toast(errText(e), 'err');
        set.disabled = false;
        set.textContent = `Set to ${choice}`;
      }
    });
  });
}

/// The format each union's creator picked, once read: the view its sheet opens in instead of the default.
const picked = new Map<string, Direction>();
const opensIn = (union: string, fallback: Direction) => picked.get(union.toLowerCase()) ?? (fallback === 'Consolidated' ? (looks.get(union.toLowerCase()) ?? fallback) : fallback);
/// A picture matched in another format than Consolidated (its saved picture's `look`), per union.
const looks = new Map<string, Direction>();

/// A burned union opens on its real Statement, its format checked under it. Any other format shows that preview in
/// the Statement's place, and its own format brings the Statement back.
async function realFormat(app: HTMLElement, s: Ctx['s']) {
  const g = app.querySelector<HTMLElement>('.batch-art .dirs');
  const host = app.querySelector<HTMLElement>('.batch-art .statement-host');
  if (!g || !host) return;
  let real: Direction | null = null, touched = false;
  g.addEventListener('direction', (e) => ((touched = true), host.classList.toggle('previewing', (e as CustomEvent<Direction>).detail !== real)));
  const i = await pub
    .readContract({ address: s.statement, abi: parseAbi(['function formatOf(uint256) view returns (uint8)']), functionName: 'formatOf', args: [s.statementId] })
    .catch(() => null);
  real = i == null ? null : (DIRECTIONS[i] ?? null);
  if (!real || !g.isConnected) return;
  if (!touched) showDirection(g, real);
  else host.classList.toggle('previewing', g.querySelector<HTMLElement>('[aria-checked="true"]')?.dataset.dir !== real);
}

/// "Burns in …" under the sheet: its creator's pick (UnionFormats), else Consolidated for a picture and Issued for the
/// rest, as the burn contract decides. The sheet opens in a pick. While every member can still leave, the creator
/// gets one button to make the format they're looking at the one it burns in.
/// When the creator's button shows: full, before its countdown, or after a burn hour lapses unused.
const PICK_PHASES: PhaseName[] = ['Waiting', 'Expired'];
async function burnFormat(app: HTMLElement, s: Ctx['s'], picture: boolean) {
  if (s.state !== 'Full') return; // the format and its button are for full unions only
  const k = s.address.toLowerCase(), read = await pickOf(s.address);
  if (!app.querySelector('.burns-in')?.isConnected) return;
  // A pick made on this page since the read began wins over the read.
  const f = picked.has(k) ? DIRECTIONS.indexOf(picked.get(k)!) : read;
  let burnsIn: Direction = f != null && f >= 0 && f < DIRECTIONS.length ? DIRECTIONS[f] : picture ? 'Consolidated' : 'Issued'; // a pick the contract lacks burns the default
  const show = () => {
    const line = app.querySelector<HTMLElement>('.burns-in'); // the page may have redrawn since
    if (line) (line.textContent = `Set to ${burnsIn}`), (line.hidden = false);
    const now = app.querySelector<HTMLElement>('#format-now');
    if (now) now.textContent = `Set to ${burnsIn}.`;
  };
  show();
  if (f != null && burnsIn === DIRECTIONS[f]) {
    picked.set(k, burnsIn);
    if (!viewerPicked(s.address)) showDirection(app.querySelector<HTMLElement>('.batch-art .dirs'), burnsIn);
  }
  const at = config.formats, you = session.account;
  const box = app.querySelector<HTMLElement>('.format-box'), open = app.querySelector<HTMLButtonElement>('#format-open');
  // Two draws of the page can both get here after their reads; only one wires the button.
  if (!at || !you || !same(you, s.creator) || !PICK_PHASES.includes(livePhase(s)) || !box || !open || open.dataset.wired) return;
  open.dataset.wired = '1';
  box.hidden = false;
  open.addEventListener('click', async () => {
    const host = app.querySelector<HTMLElement>('.batch-art');
    if (!host) return;
    // Until when, in the viewer's own time: burning switching on starts a full union's countdown, as does someone
    // restarting it after an unused burn hour.
    const on = burnsAt(await readNotice());
    const until = livePhase(s) === 'Expired' ? 'until someone restarts the countdown' : on * 1000 > Date.now() ? `until ${dayAndTime(on)}` : 'until burning starts, any minute now';
    const d = await chooseFormat(host, s.address, burnsIn, at, until);
    if (!d) return;
    burnsIn = d;
    picked.set(k, d);
    keepPick(s.address, DIRECTIONS.indexOf(d));
    show();
    showDirection(app.querySelector<HTMLElement>('.batch-art .dirs'), d);
    toast(`Set to ${d}.`, 'ok');
  });
}

function livePhase(s: Ctx['s']): PhaseName {
  const now = Date.now() / 1000;
  if ((s.phase === 'Countdown' || s.phase === 'Burnable') && now >= s.deadline) return 'Expired';
  if (s.phase === 'Countdown' && now >= s.lockAt) return 'Burnable';
  return s.phase;
}

/// Factory deposits revert with the batch's own errors (Excluded, NoSlot…); include them so they decode.
const depositAbi = [...factoryAbi, ...batchAbi.filter((x) => x.type === 'error')];
/// The Credit a NoSlot revert names, or null for any other error.
function noSlotId(err: unknown): bigint | null {
  for (let c = err as { data?: { errorName?: string; args?: readonly unknown[] }; cause?: unknown } | undefined; c; c = c.cause as typeof c) {
    if (c.data?.errorName === 'NoSlot') return BigInt(String(c.data.args?.[0]));
  }
  return null;
}

/// Members beside the count: those with an ENS avatar move ahead (in Credit order), so the four showing are faces
/// where there are any, not generated patterns.
async function rankFaces(root: ParentNode) {
  const box = root.querySelector<HTMLElement>('.faces');
  if (!box) return;
  const you = box.querySelector<HTMLElement>('.face[data-you]');
  const all = [...box.querySelectorAll<HTMLElement>('.face:not([data-you])')];
  const has = await Promise.all(all.map((f) => ens(f.dataset.ens as Address).then((r) => !!r.avatar && /^(https:\/\/|\/avatar\/)/.test(r.avatar), () => false)));
  if (!box.isConnected) return;
  const order = [...all.filter((_, i) => has[i]), ...all.filter((_, i) => !has[i])];
  if (you) order.splice(Math.min(3, order.length), 0, you);
  box.append(...order);
}

const plural = (n: number) => `${n} Credit${n === 1 ? '' : 's'}`;
/// The withdraw button: all of yours when none are picked ("Withdraw your Credit" when it's one), else the picked.
const withdrawLabel = (picked: number, all: number, save = false) =>
  save ? 'Save spots and withdraw' : picked ? `Withdraw ${plural(picked)}` : all === 1 ? 'Withdraw your Credit' : `Withdraw all ${plural(all)}`;
/// Picture unions whose spots weren't all saved when the page read them: their leave saves them first.
const unsaved = new Set<string>();
/// The burn contract, when a leave from this union must save its spots first: a picture (by the contract's own
/// reckoning: orderOf answers), more than one member, and spots not saved as they stand. A leave then opens only the
/// leaver's spots; unsaved, Credits that joined since the last save would slide into them.
async function needsSave(union: Address, b: Ctx): Promise<Address | null> {
  if (new Set(b.depositors.map((d) => d.toLowerCase())).size < 2) return null;
  const adapter = await burnAdapter();
  if (!adapter || !(await keptSpots(union)) || (await spotsSaved(union))) return null;
  return adapter;
}

/// `pending`: a wallet is connected but its side isn't read yet: say so rather than offer to connect it.
function panel(b: Ctx, m: Mine, myIds: Set<string>, pending = false) {
  const s = b.s;
  const connect = pending ? `<p class="small muted">Checking your wallet…</p>` : `<button class="btn primary block" data-connect>Connect wallet</button>`;
  if (pending && s.state === 'Open') return `<div class="box add"><div class="box-head"><h3>Join</h3></div>${connect}</div>`;
  // Your Credits in this party as tiles: pick some to withdraw just those, or leave none picked to take all.
  const withdraw = (primary = false) =>
    myIds.size
      ? `<div class="yours-in"><p class="small fit-row"><span>You have <strong class="num">${plural(myIds.size)}</strong> in this Credit Union.</span><span id="w-actions"><button type="button" class="link small" id="w-clear" hidden>Clear</button></span></p>
        <div class="picker captioned" id="w-picker">${[...myIds].map((id) => `<button type="button" class="pick" data-id="${id}" aria-pressed="false" aria-label="Credit #${id}"><img src="${art(BigInt(id))}" alt="" loading="lazy"><span class="pick-id num">#${Number(id).toLocaleString()}</span></button>`).join('')}</div>
        <button class="btn block${primary ? ' primary' : ''}" id="withdraw">${withdrawLabel(0, myIds.size)}</button></div>`
      : '';

  if (s.state === 'Open') {
    // One box, three tabs: add your own Credits, buy ones that fit, or take yours back. Buy leads when you hold
    // none; Withdraw only exists once you have Credits in.
    const remembered = addTab?.at === s.address && (addTab.tab !== 'withdraw' || myIds.size) ? addTab.tab : null;
    const start = remembered ?? (!m || !m.owned.length ? 'buy' : 'mine');
    return `<div class="box add">
      <div class="box-head join-head"><h3>Join</h3><div class="subtabs" role="tablist">
        <button type="button" role="tab" data-add="mine" aria-selected="${start === 'mine'}">Deposit <span class="num" id="n-mine"></span></button>
        <button type="button" role="tab" data-add="buy" aria-selected="${start === 'buy'}">Buy</button>
        ${myIds.size ? `<button type="button" role="tab" data-add="withdraw" aria-selected="${start === 'withdraw'}">Withdraw <span class="num">${myIds.size}</span></button>` : ''}
      </div><span class="muted small num" id="pick-count"></span></div>
      <div data-pane="mine"${start === 'mine' ? '' : ' hidden'}>
        ${
          m
            ? `<p class="small" id="fit-line">Checking your Credits…</p>
        <div class="picker" id="picker"></div>
        <div class="stack" id="deposit-actions"></div>`
            : `<p class="muted small">Connect to see which of your Credits fit.</p>${connect}`
        }
      </div>
      <div data-pane="buy"${start === 'buy' ? '' : ' hidden'}>${buyPane(!!m)}</div>
      ${myIds.size ? `<div data-pane="withdraw"${start === 'withdraw' ? '' : ' hidden'}>${withdraw()}</div>` : ''}
      <p class="muted small pane-note"><span id="buy-line">Finding the cheapest listings that fit… </span><span class="buy-how">One transaction buys your picks and deposits them in your name. </span><span class="leave-note">${!isPictureUnion.has(s.address.toLowerCase()) || !config.sweeper ? 'Leave anytime until it locks.' : myIds.size && new Set(b.depositors.map((d) => d.toLowerCase())).size === 1 ? 'You can leave while you’re the only member.' : 'Leave anytime until it locks: your spot opens and the rest of the picture stays put.'}</span> Unofficial, use at your own risk. <a href="/docs" target="_blank" rel="noopener">How it works</a></p>
    </div>`;
  }

  if (s.state === 'Full') {
    const mine = m ? withdraw(true) || '<p class="small muted">You have no Credits here.</p>' : connect;
    switch (livePhase(s)) {
      case 'Waiting':
        return `<div class="box">
          <h3>Waiting for Statements</h3>
          <p class="muted">${notice ? `Becomes a Statement ${startsAt(notice.at + 5 * 60)}.` : 'Becomes a Statement when Statements launch.'}</p>
          ${myIds.size ? withdraw() : ''}
        </div>`;
      case 'Countdown':
        return `<div class="box">
          <h3>Withdrawals close in <span class="num" data-clock="${s.lockAt}">${clock(s.lockAt)}</span></h3>
          <p class="muted">${THEN_CONVERT}</p>
          ${mine}
        </div>`;
      case 'Burnable':
        // The hour to convert: nobody is paid to press it and nothing presses it for you. Unpressed, it unlocks.
        return `<div class="box">
          <h3><span class="num" data-clock="${s.deadline}" data-left>${timeLeft(s.deadline)}</span> left to convert</h3>
          <p class="muted">If nobody converts it by ${localTime(s.deadline)}, it unlocks and members can withdraw again.</p>
          <div id="assemble-slot"><div class="stack">${session.account ? `<button class="btn primary block" disabled>${CONVERT}</button>` : `<button class="btn primary block" data-connect>Connect to convert</button>`}<p class="small muted center">Anyone can press it. You pay the gas.</p></div></div>
        </div>`;
      default:
        return `<div class="box">
          <h3>Unlocked</h3>
          <p class="muted">Nobody converted it in time. ${myIds.size ? 'Withdraw your Credits, or restart the countdown.' : 'Anyone can restart the countdown.'}</p>
          ${myIds.size ? withdraw(true) : ''}
          ${m ? `<button class="btn block" id="restart">Restart countdown</button>` : connect}
        </div>`;
    }
  }

  if (s.state === 'Expired') {
    return `<div class="box">
      <h3>Expired</h3>
      <p class="muted">Not burned in time. Credits can be withdrawn.</p>
      ${myIds.size ? withdraw(true) : m ? '<p class="small muted">You have no Credits here.</p>' : connect}
    </div>`;
  }

  // Auction or Settled
  const ended = s.highBid > 0n && Date.now() / 1000 >= s.auctionEnd;
  const per = s.payoutPerShare;
  const owed = m && m.owed > 0n ? `<button class="btn block" id="owed">Collect ${eth(m.owed)} refund</button>` : '';

  if (s.state === 'Settled') {
    // Your cut, as Batch.unitsOf × payoutPerUnit: shares when Equal, position weights (237 - 2i) when Early bird,
    // where payoutPerShare is 158 units.
    const units = s.split === 1 ? b.ids.reduce((n, id, i) => (myIds.has(String(id)) ? n + 237n - 2n * BigInt(i) : n), 0n) : BigInt(m?.shares ?? 0);
    const got = s.split === 1 ? (units * per) / 158n : units * per;
    const each = `${eth(per, 4)} ${s.split === 1 ? "avg " : ""}per Credit`;
    const right = m?.shares
      ? `<div><span>${m.claimable > 0n ? 'Yours to claim' : 'You got'}</span><strong class="num">${eth(m.claimable > 0n ? m.claimable : got)}</strong><em class="sub num">${each}</em></div>`
      : `<div><span>${s.split === 1 ? 'Avg per Credit' : 'Per Credit'}</span><strong class="num">${eth(per, 4)}</strong></div>`;
    const mine = m?.shares && m.claimable > 0n ? `<button class="btn primary block" id="claim">Claim ${eth(m.claimable)}</button>` : '';
    return `<div class="box">
      <div class="bid-now"><div><span>Sold</span><strong class="num">${eth(s.highBid)}</strong><em class="sub">To ${who(s.highBidder, 'sm', true)}</em></div>${right}</div>
      ${mine}${owed}
    </div>`;
  }

  const hasMin = s.highBid > 0n || s.minBid > 1n;
  const again = bidAgain.delete(s.address.toLowerCase()) && hasMin ? ` value="${minEth(s.minBid)}"` : '';
  // What settling now would pay you, as Batch.settle splits it: the bid less the protocol and creator fees, over
  // 80 shares (Equal) or 12,640 units (Early bird, where your positions weigh 237 - 2i units each).
  const early = s.split === 1;
  const myUnits = early ? b.ids.reduce((n, id, i) => (myIds.has(String(id)) ? n + 237n - 2n * BigInt(i) : n), 0n) : BigInt(m?.shares ?? 0);
  const perUnit = (s.highBid - (s.highBid * BigInt(s.protocolFeeBps)) / 10_000n - (s.highBid * BigInt(s.creatorFeeBps)) / 10_000n) / (early ? 12_640n : 80n);
  const myShare = early ? sharePct(Number(myUnits) / 12_640) : `${m?.shares ?? 0}/80`;
  // Signed out, the same box with the next bid in it, and Connect to bid where Bid goes: what it takes shows before
  // connecting, as on Multibid.
  const bidBox = (button: string) => `<form class="bid-form" id="bid-form"><label class="field"><input id="bid" inputmode="decimal" autocomplete="off" placeholder="${hasMin ? minEth(s.minBid) : '0.1'}"${again} aria-label="Bid in ETH"><span>ETH</span></label>${button}</form>
             <p class="small muted">${hasMin ? `<button type="button" class="link bid-min" data-fill="${minEth(s.minBid)}">Min ${minEth(s.minBid)}</button>` : ''}<span class="bid-wallet" hidden></span>${hasMin ? '. ' : ''}Outbid ETH returns instantly. Credit Union is unofficial and experimental, so use it at your own risk.</p>`;
  // No bids yet: the least the first may be (Batch.minBid). There's no reserve, so it's the opening bid.
  const opening = s.reserve > 0n && s.minBid === s.reserve ? 'Reserve' : 'Opening bid';
  return `<div class="box">
    <div class="bid-now">
      <div><span>${s.highBid ? (ended ? 'Winning bid' : 'Current bid') : opening}</span><strong class="num">${s.highBid ? eth(s.highBid) : hasMin ? `${minEth(s.minBid)} ETH` : 'Any'}</strong><em class="sub">${s.highBid ? `by ${who(s.highBidder, 'sm', true)}` : 'The clock starts at the first bid.'}</em></div>
      <div><span>${ended ? 'Ended' : 'Ends in'}</span><strong class="num"${s.highBid && !ended ? ` data-countdown="${s.auctionEnd}"` : ''}>${!s.highBid ? '24h' : ended ? ago(s.auctionEnd) : until(s.auctionEnd)}</strong>${!ended ? '<em class="sub">Late bids add 15 min</em>' : ''}</div>
    </div>
    ${
      ended
        ? `<div class="stack"><button class="btn primary block" id="settle">Settle auction</button><p class="small muted center">Sends the Statement to the winner and pays every member.</p></div>`
        : pending && !m
          ? connect
          : bidBox(session.account ? '<button class="btn primary">Bid</button>' : '<button type="button" class="btn primary" data-connect>Connect to bid</button>')
    }
    ${m?.shares ? `<p class="small">Your share <strong class="num">${myShare}</strong>${s.highBid ? ` · <span class="num">≈${eth(perUnit * myUnits)}</span> now` : ''}</p>` : ''}
    ${owed}
  </div>`;
}

function buyPane(connected: boolean) {
  // As on /credits: how many and what it comes to, then the Credits to pick from; then the button, as on the
  // Deposit tab.
  return `<div class="buy-row" id="buy-act">${sweepRow('sale', 0, MAX_SWEEP, 0)}</div>
    <div class="trait-grid listings" id="listings">${creditSkel.repeat(MAX_SWEEP)}</div>
    ${connected || !config.sweeper ? `<button class="btn primary block" id="buy-go" disabled>Buy &amp; deposit</button>` : connectToBuy(true)}
`;
}


function bind(b: Ctx, m: Mine, myIds: Set<string>, rerender: () => void, keyed: Map<string, number> | null) {
  const s = b.s;
  const run = async (btn: HTMLElement | null, label: string, fn: () => Promise<unknown>, ok: string) => {
    if (btn) {
      btn.setAttribute('disabled', '');
      btn.dataset.label = btn.textContent ?? '';
      btn.textContent = label;
    }
    busy++;
    try {
      await fn();
      busy--;
      if (ok) toast(ok, 'ok');
      rerender();
    } catch (e) {
      busy--;
      toast(e instanceof Outbid ? e.message : errText(e), 'err', 8000);
      if (e instanceof Outbid) return rerender();
      if (btn) {
        btn.removeAttribute('disabled');
        btn.textContent = btn.dataset.label ?? '';
      }
    }
  };
  const txNote = (h: string) => {
    const u = explorer('tx', h);
    toast(u ? 'Submitted. Waiting for confirmation…' : 'Submitted…', 'info');
  };

  const wPicker = document.getElementById('w-picker');
  const wPicks = new Set<string>();
  const wDraw = () => {
    wPicker?.querySelectorAll<HTMLElement>('.pick').forEach((p) => p.setAttribute('aria-pressed', String(wPicks.has(p.dataset.id!))));
    const btn = document.getElementById('withdraw');
    if (btn && !btn.dataset.busy) btn.textContent = withdrawLabel(wPicks.size, myIds.size, unsaved.has(s.address.toLowerCase()));
    const clr = document.getElementById('w-clear');
    if (clr) clr.hidden = !wPicks.size;
  };
  if (wPicker) {
    pickTips(wPicker, [...myIds].map(BigInt), new Map(b.ids.map((id, i) => [id.toString(), i + 1])), () => s.split === 1);
    wPicker.addEventListener('click', (e) => {
      const t = (e.target as HTMLElement).closest<HTMLElement>('.pick');
      if (!t) return;
      const id = t.dataset.id!;
      wPicks.has(id) ? wPicks.delete(id) : wPicks.add(id);
      wDraw();
    });
    document.getElementById('w-clear')?.addEventListener('click', () => { wPicks.clear(); wDraw(); });
  }
  if (myIds.size && (s.state === 'Open' || s.state === 'Full' || s.state === 'Expired'))
    void needsSave(s.address, b).then((a) => {
      if (!a) return;
      unsaved.add(s.address.toLowerCase());
      const btn = document.getElementById('withdraw');
      if (btn && !btn.dataset.busy) btn.textContent = withdrawLabel(wPicks.size, myIds.size, true);
    });
  document.getElementById('withdraw')?.addEventListener('click', (e) => {
    const btn = e.currentTarget as HTMLElement;
    const soloPicture = isPictureUnion.has(s.address.toLowerCase()) && new Set(b.depositors.map((d) => d.toLowerCase())).size === 1;
    return run(btn, 'Withdrawing…', async () => {
      const ids = [...(wPicks.size && !soloPicture ? wPicks : myIds)].map(BigInt);
      const leaves = [];
      for (let i = 0; i < ids.length; i += CHUNK) leaves.push({ address: s.address, abi: batchAbi, functionName: 'withdraw', args: [ids.slice(i, i + CHUNK)] } as const);
      // A picture's spots must be saved before a leave, or every later Credit of the leaver's Colors slides up a spot.
      // A wallet that batches saves and leaves in one transaction, so nobody can join in between. Otherwise save, then
      // check again just before leaving (someone may have joined meanwhile), which narrows that gap to about a block.
      const adapter = await needsSave(s.address, b);
      if (adapter) {
        const save = { address: adapter, abi: adapterAbi, functionName: 'record', args: [s.address] } as const;
        if (await canBatch()) {
          // A wallet that says it batches but then won't (as opposed to you cancelling, or a batch it sent) falls back
          // to one transaction at a time below.
          let sent = false;
          try {
            await sendBatch([save, ...leaves], () => (sent = true));
            unsaved.delete(s.address.toLowerCase());
            return;
          } catch (err) {
            if (sent || /rejected|denied/i.test(String((err as Error)?.message ?? err))) throw err;
          }
        }
        for (let tries = 0; tries < 3 && !(await spotsSaved(s.address)); tries++) await send(save, txNote);
      }
      unsaved.delete(s.address.toLowerCase());
      for (const call of leaves) await send(call, txNote);
    }, 'Credits returned to your wallet.');
  });

  // Convert Union to Statement opens at an exact time, counted down on the page: the burns-open time we set on burn
  // day. ?burn skips it, for our own first burn.
  const slot = document.getElementById('assemble-slot');
  if (slot) {
    let tick: ReturnType<typeof setInterval> | undefined;
    const wait = (at: number, note: string) => {
      slot.innerHTML = `<div class="stack"><button class="btn primary block" disabled>Opens in <span class="num">${clock(at)}</span></button>
        <p class="small muted center">${esc(`${startsAt(at).replace(/^at /, 'At ')}.${note ? ` ${note}` : ''}`)}</p></div>`;
      const n = slot.querySelector('.num')!;
      clearInterval(tick);
      tick = setInterval(() => {
        if (!slot.isConnected) return clearInterval(tick);
        n.textContent = clock(at);
        if (Date.now() / 1000 >= at + 1) {
          clearInterval(tick);
          void show();
        }
      }, 1000);
    };
    const show = async (): Promise<void> => {
      if (!slot.isConnected) return;
      if (burnAsk !== s.address.toLowerCase()) {
        const b = await fetch('/burns').then((r) => r.json() as Promise<{ open?: boolean; at?: number | null }>).catch(() => ({}) as { open?: boolean; at?: number | null });
        if (!b.open) {
          if (b.at && b.at > Date.now() / 1000) return wait(b.at, '');
          if (b.at) setTimeout(() => void show(), 5000); // its time has come; the flag is a few seconds behind
          return;
        }
      }
      if (!slot.isConnected) return;
      clearInterval(tick);
      // Converting takes a wallet, not a share: anyone signed in can press it, while their side is still being read too.
      slot.innerHTML = `<div class="stack">${session.account ? `<button class="btn primary block" id="assemble">${CONVERT}</button>` : `<button class="btn primary block" data-connect>Connect to convert</button>`}
        <p class="small muted center">Anyone can press it. You pay the gas.</p></div>`;
      // From a card's or the bar's Convert: the button in view, focused.
      if (convertAsk === s.address.toLowerCase()) {
        convertAsk = null;
        const btn = slot.querySelector<HTMLElement>('button');
        btn?.scrollIntoView({ block: 'center' });
        btn?.focus({ preventScroll: true });
      }
      document.getElementById('assemble')?.addEventListener('click', (e) =>
        run(e.currentTarget as HTMLElement, 'Converting…', () =>
          send({ address: s.address, abi: batchAbi, functionName: 'assemble', gas: 16_000_000n }, txNote),
        'The Statement exists. Auction is open.'),
      );
    };
    void show();
  }

  document.getElementById('settle')?.addEventListener('click', (e) =>
    run(e.currentTarget as HTMLElement, 'Settling…', () =>
      send({ address: s.address, abi: batchAbi, functionName: 'settle' }, txNote),
    'Settled. Every member is paid.'),
  );

  document.getElementById('claim')?.addEventListener('click', (e) =>
    run(e.currentTarget as HTMLElement, 'Claiming…', () =>
      send({ address: s.address, abi: batchAbi, functionName: 'claim', args: [session.account!] }, txNote),
    'Claimed.'),
  );

  if (s.state === 'Settled') void drawUnclaimed(b, run, txNote);

  document.getElementById('owed')?.addEventListener('click', (e) =>
    run(e.currentTarget as HTMLElement, 'Collecting…', () =>
      send({ address: s.address, abi: batchAbi, functionName: 'withdrawOwed' }, txNote),
    'Refund collected.'),
  );

  // The minimum fills the box; beside it, what your wallet holds.
  document.querySelector<HTMLElement>('.bid-min')?.addEventListener('click', (e) => {
    const input = document.getElementById('bid') as HTMLInputElement | null;
    if (input) (input.value = (e.currentTarget as HTMLElement).dataset.fill ?? ''), input.focus(), input.dispatchEvent(new Event('input'));
  });
  // A bid typed before connecting is still in the box when the page draws again with the wallet.
  const bidIn = document.getElementById('bid') as HTMLInputElement | null;
  if (bidIn && !session.account) bidIn.addEventListener('input', () => (typedBid = { at: s.address.toLowerCase(), v: bidIn.value.trim() }));
  else if (bidIn && typedBid?.at === s.address.toLowerCase()) (bidIn.value ||= typedBid.v), (typedBid = null);
  const wallet = document.querySelector<HTMLElement>('.bid-wallet');
  if (wallet && session.account)
    void pub.getBalance({ address: session.account }).then((bal) => {
      const min = !!document.querySelector('.bid-min');
      wallet.textContent = min ? ` · You have ${eth(bal)}` : `You have ${eth(bal)}. `;
      wallet.hidden = false;
    }, () => {});

  document.getElementById('bid-form')?.addEventListener('submit', (e) => {
    e.preventDefault();
    // Signed out, Enter asks to connect, as the button beside the box does.
    if (!session.account) return void (e.currentTarget as HTMLElement).querySelector<HTMLElement>('[data-connect]')?.click();
    const input = document.getElementById('bid') as HTMLInputElement;
    let value: bigint;
    try {
      value = parseEther(input.value.trim() || '0');
    } catch {
      return toast('Enter an amount in ETH.', 'err');
    }
    if (value <= 0n) return toast('Enter an amount in ETH.', 'err');
    // Someone may have bid since the page last read the chain: check before the wallet opens, and again if the bid
    // fails, so a lost race says so and the box comes back with the new minimum.
    const check = async () => {
      const now = await getBatch(s.address).catch(() => null);
      if (!now || now.s.state !== 'Auction' || value >= now.s.minBid) return;
      if (now.s.highBid === s.highBid) throw new Error(`The minimum bid is ${minEth(now.s.minBid)} ETH.`);
      bidAgain.add(s.address.toLowerCase());
      throw new Outbid(`Someone bid ${eth(now.s.highBid)} first. The minimum is now ${minEth(now.s.minBid)} ETH.`);
    };
    run((e.currentTarget as HTMLElement).querySelector('button'), 'Bidding…', async () => {
      await check();
      try {
        await send({ address: s.address, abi: batchAbi, functionName: 'bid', value }, txNote);
        offerAlerts();
      } catch (err) {
        await check();
        throw err;
      }
    }, 'You’re the high bidder.');
  });

  mountDirections();

  // A full batch's sheet closes its gaps: 80 become one image.
  const closing = document.querySelector('.sheet.closing');
  if (closing) requestAnimationFrame(() => requestAnimationFrame(() => closing.classList.add('closed')));

  document.getElementById('restart')?.addEventListener('click', (e) =>
    run(e.currentTarget as HTMLElement, 'Restarting…', () =>
      send({ address: s.address, abi: batchAbi, functionName: 'restartCountdown' }, txNote),
    'Countdown restarted. Five minutes to leave.'),
  );

  // Lock countdowns tick in place. When one runs out the phase has moved on: read the party again, a few
  // seconds late so the chain has a block past the boundary, and spread over a few more so everyone watching doesn't
  // read it in the same second.
  const clocks = $$('[data-clock]');
  if (clocks.length) {
    const late = 3 + Math.random() * 5;
    const t = setInterval(() => {
      if (!clocks[0].isConnected) return clearInterval(t);
      for (const el of clocks) el.textContent = ('left' in el.dataset ? timeLeft : clock)(Number(el.dataset.clock));
      if (clocks.some((el) => Date.now() / 1000 >= Number(el.dataset.clock) + late)) {
        clearInterval(t);
        rerender();
      }
    }, 1000);
  }

  // The auction's countdown. When it runs out the page draws again, with Settle in place of the bid form: a few
  // seconds late (a last-second bid adds time, and the live refresh brings it) and spread like the lock clocks.
  const cd = document.querySelector<HTMLElement>('[data-countdown]');
  if (cd) {
    const end = Number(cd.dataset.countdown), late = 2 + Math.random() * 6;
    const t = setInterval(() => {
      if (!cd.isConnected) return clearInterval(t);
      cd.textContent = until(end);
      if (Date.now() / 1000 >= end + late && !busy && !document.querySelector('dialog[open]')) {
        clearInterval(t);
        rerender();
      }
    }, 1000);
  }

  if (s.state === 'Open' && m) drawPicker(b, m, keyed, run, txNote);
  if (b.ids.length) loadRatings(b, run, txNote);
  if (s.state === 'Open') {
    // The Buy tab asks OpenSea for listings only once it's open.
    let buying = false;
    const buy = () => {
      if (buying) return;
      buying = true;
      void bindBuy(b, !!m, run, txNote);
    };
    document.querySelectorAll<HTMLButtonElement>('[data-add]').forEach((t) =>
      t.addEventListener('click', () => {
        document.querySelectorAll('[data-add]').forEach((x) => x.setAttribute('aria-selected', String(x === t)));
        document.querySelectorAll<HTMLElement>('[data-pane]').forEach((p) => (p.hidden = p.dataset.pane !== t.dataset.add));
        addTab = { at: s.address, tab: t.dataset.add! };
        if (t.dataset.add === 'buy') buy();
      }),
    );
    if (document.querySelector('[data-add="buy"][aria-selected="true"]')) buy();
  }
}


async function drawPicker(
  b: Ctx,
  m: NonNullable<Mine>,
  keyed: Map<string, number> | null,
  run: (btn: HTMLElement | null, label: string, fn: () => Promise<unknown>, ok: string) => Promise<void>,
  txNote: (h: string) => void,
) {
  const s = b.s;
  const el = document.getElementById('picker');
  if (!el) return;
  const room = 80 - s.count;
  const passing = await eligible(s.address, m.owned).catch(() => null);
  if (!passing) {
    if (el.isConnected) el.innerHTML = `<p class="muted small">Couldn’t check your Credits against this Credit Union right now. Refresh to try again.</p>`;
    return;
  }
  // A painted sheet takes a Credit only while a slot of its value (or an open slot) is free: read each Credit's
  // value as the batch will (Batch._keyOf) and the slot books as they stand. Unreadable: the rules alone, and
  // the deposit's test run below still drops any Credit without a slot.
  let bk: Books | null = null;
  let keys = new Map<string, number>();
  if (hasLayout(s.filter) && keyed) {
    try {
      keys = await keysOf(s.filter.layoutTrait ?? 0, passing);
      bk = books(s.filter, keyed.values());
    } catch {}
  }
  if (!el.isConnected) return;
  const keyOf = (id: bigint | string) => keys.get(String(id)) ?? 0;
  // Fits: passes the rules and has room as the sheet stands. Most: how many go in together; filling greedily
  // gets there, since a Credit only spills into an open slot once its own value's slots are taken.
  const base = new Room(bk, room);
  // A picture union takes only the Credits that draw its next slots: yours that are next in their Colors.
  const plan = await (plansOf.get(s.address.toLowerCase()) ?? Promise.resolve(null));
  if (!el.isConnected) return;
  const roomy = passing.filter((id) => base.fits(keyOf(id)));
  const fits = plan ? roomy.filter((id) => plan.mine.has(id.toString())) : roomy;
  const most = (() => {
    const r = new Room(bk, room);
    return fits.filter((id) => r.take(keyOf(id)));
  })();
  {
    // Picks carried over from before a redraw: keep the ones that still land, in the order they were picked.
    const r = new Room(bk, room);
    picks = new Set([...picks].filter((p) => fits.some((f) => f.toString() === p) && r.take(keyOf(p))));
    if (pickAsk?.at === s.address.toLowerCase()) {
      const id = pickAsk.id;
      pickAsk = null;
      if (fits.some((f) => f.toString() === id) && r.take(keyOf(id))) picks.add(id);
    }
  }

  // The rest of your Credits, folded underneath with why they don't fit.
  const inRules = new Set(passing.map(String));
  const off = new Map<string, bigint[]>();
  for (const id of passing) if (!base.fits(keyOf(id))) {
    const why = bk ? noRoomReason(bk, keyOf(id)) : 'No room left';
    off.set(why, [...(off.get(why) ?? []), id]);
  }
  // A picture's: yours that draw a spot well but go in after Credits for sale in their Colors (come back once those
  // are in), and the rest of yours of its Colors, which don't draw any open spot closely enough.
  const later = plan ? roomy.filter((id) => !plan.mine.has(id.toString()) && plan.slot.has(id.toString())) : [];
  const loose = plan ? roomy.filter((id) => !plan.slot.has(id.toString())) : [];
  if (later.length) off.set('Fit spots that open later, once the Credits ahead of them are in', later);
  if (loose.length) off.set('Not a close match for any open spot in the picture', loose);
  const outside = m.owned.filter((id) => !inRules.has(id.toString()));
  if (outside.length) off.set('Outside this Credit Union’s rules', outside);
  const offCount = [...off.values()].reduce((n, x) => n + x.length, 0);
  const offTile = (id: bigint) => `<button type="button" class="pick off" data-id="${id}" aria-disabled="true" aria-label="Credit #${id}"><img src="${art(id)}" alt="" loading="lazy"></button>`;
  const fold = (summary: string) =>
    `<details class="picker-off" id="picker-off-wrap">${summary}${[...off]
      .map(([why, ids]) => `<p class="small off-why" data-why>${esc(why)} <span class="muted num">${ids.length}</span></p><div class="picker" data-off>${ids.map(offTile).join('')}</div>`)
      .join('')}</details>`;

  const line = document.getElementById('fit-line');
  const mineCount = document.getElementById('n-mine');
  if (mineCount) mineCount.textContent = most.length ? String(most.length) : '';
  // Nothing of yours fits: lead with buying.
  if (!fits.length) document.querySelector<HTMLButtonElement>('[data-add="buy"]:not([aria-selected="true"])')?.click();
  if (!fits.length) {
    // Nothing to deposit (Buy is the tab beside): one line, which opens on why each of yours doesn't fit.
    const mint = config.chainId !== 1 ? ' <a href="/mint">Mint test Credits</a>' : '';
    if (line)
      line.outerHTML = offCount
        ? fold(`<summary class="small" id="fit-none"><strong class="num">0</strong> of your ${m.owned.length} Credits fit this Credit Union.</summary>`) + (mint && `<p class="small">${mint}</p>`)
        : `<p class="small" id="fit-none">You don’t hold any Credits yet.${mint}</p>`;
    const foldEl = document.getElementById('picker-off-wrap');
    if (foldEl) pickTips(foldEl, [...off.values()].flat());
    el.remove();
    return;
  }
  if (line) line.innerHTML = `<span><strong class="num">${most.length}</strong> of your ${m.owned.length} Credits fit this Credit Union.</span><span class="fit-actions" id="fit-actions"></span>`;

  // A picture union: yours in the order they go in.
  const shown = byPlan(fits.map((id) => ({ id: id.toString() })), plan).map((x) => BigInt(x.id));
  el.innerHTML = shown
    .map((id) => `<button type="button" class="pick" data-id="${id}" aria-pressed="${picks.has(id.toString())}" aria-label="Credit #${id}"><img src="${art(id)}" alt="" loading="lazy"></button>`)
    .join('');
  if (offCount) el.insertAdjacentHTML('afterend', fold(`<summary class="muted small">${offCount} of yours ${offCount === 1 ? 'doesn’t' : 'don’t'} fit</summary>`));
  pickTips(el, fits);
  const foldEl = document.getElementById('picker-off-wrap');
  if (foldEl) pickTips(foldEl, [...off.values()].flat());

  const actions = document.getElementById('deposit-actions')!;
  const count = document.getElementById('pick-count')!;
  // Not approved yet: a wallet that batches runs approve + deposit as one step, so no separate Approve.
  let batchable = false;
  if (!m.approved)
    void canBatch().then((ok) => {
      batchable = ok;
      if (ok && actions.isConnected) draw();
    });
  const draw = () => {
    const n = picks.size;
    count.textContent = n ? `${n} of ${room}` : `${room} open`;
    const over = n > room;
    const txs = Math.ceil(n / CHUNK);
    // Which way a deposit goes: already approved, one Credit sent directly, or approve + deposit batched.
    const way = m.approved ? 'deposit' : n === 1 ? 'direct' : batchable ? 'batch' : null;
    // Select all / Clear sit on the "N of your Credits fit" line, right-aligned; the button stands alone below.
    const links = document.getElementById('fit-actions');
    if (links) links.innerHTML = n ? '<button type="button" class="link small" id="pick-none">Clear</button>' : `<button type="button" class="link small" id="pick-all">Select ${most.length === fits.length ? 'all' : most.length}</button>`;
    actions.innerHTML = `
      ${
        // Always one button: nothing picked yet says so; approval only shows when a pick needs it.
        !n
          ? `<button class="btn primary block" disabled>Select Credits to deposit</button>`
          : !way
            ? `<button class="btn primary block" id="approve">Approve Credit Union · once</button>`
            : `<button class="btn primary block" id="deposit" ${over ? 'disabled' : ''}>${over ? `Only ${room} open` : `Deposit ${plural(n)}${way === 'deposit' && txs > 1 ? ` · ${txs} transactions` : ''}`}</button>`
      }`;
    document.getElementById('pick-all')?.addEventListener('click', () => {
      picks = new Set(most.map(String));
      sync();
    });
    document.getElementById('pick-none')?.addEventListener('click', () => {
      picks.clear();
      sync();
    });
    document.getElementById('approve')?.addEventListener('click', (e) =>
      run(e.currentTarget as HTMLElement, 'Approving…', () =>
        send({ address: config.credits, abi: creditsAbi, functionName: 'setApprovalForAll', args: [config.factory, true] }, txNote),
      'Approved. Pick and deposit.'),
    );
    document.getElementById('deposit')?.addEventListener('click', (e) =>
      run(e.currentTarget as HTMLElement, 'Depositing…', async () => {
        // A picture union's recommended Credits go in slot order, so each lands where it draws.
        const ids = byPlan([...picks].map((id) => ({ id })), plan).map((x) => BigInt(x.id));
        // …with their Colors locked first, so nobody's buy lands in their slots meanwhile (as a picture's buys do).
        const lockId = Array.from(crypto.getRandomValues(new Uint8Array(16)), (x) => x.toString(16).padStart(2, '0')).join('');
        let locked = false;
        if (plan) {
          const colours = [...new Set(ids.flatMap((id) => plan.colour.get(id.toString()) ?? []))];
          const lk = await locks(s.address, { op: 'acquire', id: lockId, account: session.account!, colours });
          if (lk && lk.ok === false) throw new Error(`Someone is buying ${(lk.busy ?? []).map((c) => slotName(0, c)).join(', ')} for this picture right now. Try again in a minute.`);
          locked = !!lk;
        }
        const sent = (h: string) => (txNote(h), locked && void locks(s.address, { op: 'hold', id: lockId, tx: h }));
        try {
          const chunks = Array.from({ length: Math.ceil(ids.length / CHUNK) }, (_, i) => ids.slice(i * CHUNK, (i + 1) * CHUNK));
          const deposit = (chunk: bigint[]) => ({ address: config.factory, abi: depositAbi, functionName: 'deposit', args: [s.address, chunk] });
          // A painted sheet takes each Credit only while a slot of its kind (or an open slot) is free, which the
          // plain rule check can't see. When already approved, test-run the deposit and drop any Credit the sheet
          // has no room for, so the rest still go in.
          if (way === 'deposit' && hasLayout(s.filter)) {
            const skipped: bigint[] = [];
            for (let tries = 0; tries < ids.length; tries++) {
              try {
                await pub.simulateContract({ ...(deposit(ids) as object), account: session.account! } as never);
                break;
              } catch (err) {
                const id = noSlotId(err);
                if (id === null) throw err;
                skipped.push(id);
                ids.splice(ids.findIndex((x) => x === id), 1);
                if (!ids.length) throw new Error(`No room left on this sheet for ${skipped.length === 1 ? `#${skipped[0]}` : 'those Credits'}: their slots are full.`);
              }
            }
            if (skipped.length && ids.length) toast(`Skipping ${skipped.map((x) => `#${x}`).join(', ')}: no slot left on this sheet for ${skipped.length === 1 ? 'it' : 'them'}.`, 'info', 5000);
            chunks.splice(0, chunks.length, ...Array.from({ length: Math.ceil(ids.length / CHUNK) }, (_, i) => ids.slice(i * CHUNK, (i + 1) * CHUNK)));
          }
          if (way === 'direct')
            await send({ address: config.credits, abi: directAbi, functionName: 'safeTransferFrom', args: [session.account!, s.address, ids[0]] }, sent);
          else if (way === 'batch')
            await sendBatch(
              [{ address: config.credits, abi: creditsAbi, functionName: 'setApprovalForAll', args: [config.factory, true] }, ...chunks.map(deposit)],
              // A wallet's batch has no transaction hash until it lands, so nothing holds its lock past the minute.
              () => toast('Submitted. Waiting for confirmation…', 'info'),
            );
          else for (const chunk of chunks) await send(deposit(chunk), sent);
          picks.clear();
          if (plan) chooseSpots('mine', []);
          justJoined(s.address, ids.length);
        } finally {
          if (locked) void locks(s.address, { op: 'release', id: lockId }); // landed, failed or cancelled: the Colors are free
        }
      }, ''),
    );
  };
  // Each pick uses up a slot for its value (or an open one): once none is left, the rest of that value grey out.
  const sync = () => {
    const r = new Room(bk, room);
    for (const p of picks) r.take(keyOf(p));
    $$<HTMLButtonElement>('.pick', el).forEach((p) => {
      const id = p.dataset.id!;
      const on = picks.has(id);
      const blocked = !on && !r.fits(keyOf(id));
      p.setAttribute('aria-pressed', String(on));
      p.classList.toggle('off', blocked);
      if (blocked) p.setAttribute('aria-disabled', 'true');
      else p.removeAttribute('aria-disabled');
      p.title = blocked ? (r.n >= room ? `All ${room} open places are picked` : bk ? noRoomReason(bk, keyOf(id), true) : '') : '';
    });
    if (plan) chooseSpots('mine', picks);
    draw();
  };
  // Scroll the picker (not the page) to the first pick, so a preselected Credit is in view.
  const first = el.querySelector<HTMLElement>('.pick[aria-pressed="true"]');
  if (first) el.scrollTop += first.getBoundingClientRect().top - el.getBoundingClientRect().top - 6;
  el.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('.pick');
    if (!btn || btn.classList.contains('off')) return;
    const id = btn.dataset.id!;
    // A picture union: yours of one Colors go in from its first open slot, so picking one picks those ahead of it,
    // and dropping one drops those behind it.
    const along = plan ? runOf(plan, id, plan.mine, picks) : null;
    if (picks.has(id)) [id, ...(along?.behind ?? [])].forEach((x) => picks.delete(x));
    else [id, ...(along?.ahead ?? [])].forEach((x) => picks.add(x));
    sync();
  });
  sync();
}

const quotedCount = (q: Quote) => q.ids.length + (q.fwa?.length ?? 0) + (q.strategy?.length ?? 0);
/// What a quote charges for each Credit in it, by id: OpenSea's orders, FWA's listings and CreditStrategy's.
const quotedPrices = (q: Quote) =>
  new Map<string, bigint>([
    ...q.ids.map((id, i) => [id, BigInt(q.prices[i])] as const),
    ...(q.fwa ?? []).map((f) => [f.id, BigInt(f.price)] as const),
    ...(q.strategy ?? []).map((f) => [f.id, BigInt(f.price)] as const),
  ]);

/// The Buy grid shows one row. Picking further down (the slider takes the cheapest in order) opens it to the last
/// picked row.
function fitRows(grid: HTMLElement) {
  const cells = [...grid.children] as HTMLElement[];
  if (!cells.length) return;
  const top = grid.getBoundingClientRect().top - grid.scrollTop;
  const rows = [...new Set(cells.map((c) => Math.round(c.getBoundingClientRect().top - top)))].sort((x, y) => x - y);
  if (rows.length < 2) return void (grid.style.maxHeight = '');
  const picked = cells.reduce((at, c, i) => (c.classList.contains('sel') ? i : at), -1);
  const upTo = picked < 0 ? 0 : rows.indexOf(Math.round(cells[picked].getBoundingClientRect().top - top));
  const next = rows[upTo + 1];
  const css = getComputedStyle(grid);
  const exact = next === undefined ? 0 : cells.find((c) => Math.round(c.getBoundingClientRect().top - top) === next)!.getBoundingClientRect().top - top;
  const cut = exact - (parseFloat(css.rowGap) || 0) + (parseFloat(css.paddingBottom) || 0); // the row's bottom, plus the grid's own padding
  const h = next === undefined ? 'none' : `${cut}px`;
  if (grid.style.maxHeight) return void (grid.style.maxHeight = h);
  // The first fit (tiles just replaced the skeleton): snap, no shrink from the stylesheet's height.
  grid.style.transition = 'none';
  grid.style.maxHeight = h;
  void grid.offsetHeight;
  grid.style.transition = '';
}

/// The Buy tab, as on /credits: the cheapest Credits that fit, as many as one buy takes. Drag for the cheapest that
/// many, or tap Credits to pick them, up to what's left to fill. One click gets a signed price for exactly those and
/// opens the wallet. Where buy-in is off (testnets), it previews edition Credits, disabled.
async function bindBuy(
  b: Ctx,
  connected: boolean,
  run: (btn: HTMLElement | null, label: string, fn: () => Promise<unknown>, ok: string) => Promise<void>,
  txNote: (h: string) => void,
) {
  const batch = b.s.address;
  const line = document.getElementById('buy-line');
  const grid = document.getElementById('listings');
  const host = document.getElementById('buy-act');
  const go = document.getElementById('buy-go') as HTMLButtonElement | null;
  if (!line || !grid || !host) return;

  let listings: Listed[] = [];
  let sources: Source[] = [];
  // preview: no OpenSea key here, so edition Credits stand in. mainnetOnly: real mainnet listings and prices,
  // but this party is on a testnet and can't take them.
  let preview = false;
  let mainnetOnly = false;
  try {
    const r = await fetch(`/opensea/listings?batch=${batch}`);
    if (r.status === 501) preview = true;
    else {
      const d = (await r.json()) as { listings?: typeof listings; preview?: boolean; sources?: Source[]; error?: string };
      if (!r.ok || d.error) throw new Error(d.error ?? 'OpenSea is unavailable right now.');
      listings = d.listings ?? [];
      sources = d.sources ?? [];
      mainnetOnly = !!d.preview;
    }
  } catch (e) {
    // A picture union sells its planned Credits, read one by one: it goes on without the usual listings.
    if (!plansOf.has(batch.toLowerCase())) {
      line.textContent = "Couldn’t load OpenSea listings right now. "; console.warn("[buy] listings", e);
      return;
    }
  }
  if (!grid.isConnected) return;

  if (preview) {
    // Nothing priced to pick from: Credits that fit, to show what's here.
    grid.classList.add('preview');
    grid.innerHTML = (await examples(b.s.filter)).slice(0, MAX_SWEEP).map((id) => creditCell(Number(id))).join('');
    const range = host.querySelector<HTMLInputElement>('#sale-n');
    if (range) setRange(range, 0, 0);
    line.hidden = true;
    return;
  }
  // Every listing that fits, and what shows: the cheapest that many from the marketplaces shown, and any picked.
  let all = listings;
  const plan = plansOf.get(batch.toLowerCase());
  let order: Plan | null = null;
  let held = new Set<number>(); // Colors someone else is buying right now: they sit out until that buy lands
  // A picture union sells only its planned Credits, read one by one (the union's usual listings are the cheapest
  // that fit, which the picture's may not be). The market read can be minutes old: one no longer for sale leaves the
  // plan, and its slot takes the next best, so nothing waits on a Credit that can't be bought.
  const gone = new Set<number>();
  // A rate limit throws (listedById strict): the live refresh keeps what it has and tries again next time, rather than
  // replanning around Credits that are only unread.
  const pictureListings = async (p: Plan) => {
    for (let tries = 0; tries < 5; tries++) {
      const want = byPlan([...p.buy].map((id) => ({ id })), p).slice(0, MAX_SWEEP).map((x) => x.id);
      const ls = await listedById(want, true);
      const sold = want.filter((id) => !ls.some((l) => l.id === id));
      if (!sold.length) return { p, ls };
      sold.forEach((id) => gone.add(Number(id)));
      p = (await replans.get(batch.toLowerCase())?.(gone)) ?? p;
    }
    return { p, ls: await listedById(byPlan([...p.buy].map((id) => ({ id })), p).slice(0, MAX_SWEEP).map((x) => x.id), true) };
  };
  const repicture = async (p: Plan) => {
    const [got, lk] = await Promise.all([pictureListings(p), locks(batch)]);
    if (!grid.isConnected) return;
    order = got.p;
    all = got.ls;
    held = new Set(lk?.held ?? []);
    reshow();
  };
  // A picture union: nothing is offered until its plan is worked out, then only its planned Credits.
  if (plan) {
    // Most painted unions have no picture and say so at once: only a real wait says what it's doing.
    const slow = setTimeout(() => ((line.textContent = 'Finding the Credits that draw the picture’s next slots… '), (line.hidden = false)), 300);
    const p = await plan;
    clearTimeout(slow);
    if (!grid.isConnected) return;
    if (p) {
      const [got, lk] = await Promise.all([pictureListings(p).catch(() => ({ p, ls: [] as Listed[] })), locks(batch)]);
      if (!grid.isConnected) return;
      order = got.p;
      all = got.ls;
      held = new Set(lk?.held ?? []);
    }
  }
  // A picture's, in the order they go in; any other union's, cheapest first.
  const pictureLine = (n: number) =>
    (n ? 'Tap one to see its spot. ' : 'Nothing for sale draws the picture’s next spots right now. ') +
    (held.size ? `Someone is buying ${[...held].map((m) => slotName(0, m)).join(', ')} right now; those are back in a moment. ` : '');
  const showing = (picked: Set<string>) => byPlan(order ? all.filter((l) => order!.buy.has(l.id) && !held.has(order!.colour.get(l.id)!)) : all, order).filter((l, i) => i < MAX_SWEEP || picked.has(l.id));
  const shown = showing(new Set());
  const sale: Sale = { ls: [...shown], preview: mainnetOnly, byId: new Map(shown.map((l) => [l.id, l])), all: shown, mine: new Set() };
  // Credits whose price went up at the last click: their new price shows in red until the next.
  const rose = new Set<string>();
  const tile = (l: Listed) => creditCell(Number(l.id), priceTag(l, rose.has(l.id)));
  const tiles = () => {
    grid.innerHTML = sale.ls.map(tile).join('');
    fitRows(grid);
  };
  tiles();
  // Testnet: the banner already says it's a preview.
  line.textContent = order ? pictureLine(shown.length) : shown.length || mainnetOnly ? '' : 'No listings fit right now. ';
  line.hidden = !line.textContent;
  let chosen: () => Listed[] = () => [];
  const label = () => {
    fitRows(grid);
    if (!go) return;
    const n = chosen().length;
    go.disabled = mainnetOnly || !n || !connected;
    go.textContent = n ? `Buy & deposit ${n}` : 'Buy & deposit';
  };
  // A picture's Credits of one Colors go in from its first open slot: picking one brings those ahead of it.
  const along = (id: string, picking: boolean) => {
    if (!order) return [];
    const r = runOf(order, id, new Set(sale.ls.map((l) => l.id)), chosen().map((l) => l.id));
    return picking ? r.ahead : r.behind;
  };
  const ctl = sweepControls(host, sale, grid, { button: false, cap: 80 - b.s.count, onPick: () => (label(), order && chooseSpots('buy', chosen().map((l) => l.id))), along });
  chosen = ctl.chosen;
  label();
  // Live: the listings that fit, read again every 20 s (the Worker scans the market for them at most once a minute,
  // and drops what sold in between). The cheapest that many show, and any you picked stay while they're listed.
  keepLive(
    grid,
    async () => {
      if (order) return repicture(order);
      const r = await fetch(`/opensea/listings?batch=${batch}`);
      const d = r.ok ? ((await r.json()) as { listings?: Listed[]; sources?: Source[]; error?: string }) : null;
      if (!d?.listings || d.error || !grid.isConnected) return;
      all = d.listings;
      sources = d.sources ?? sources;
      reshow();
    },
    order ? 10_000 : undefined, // a picture's Buy list: many buyers at once, each read comes from the market book
  );
  const reshow = () => {
    relist(grid, sale, showing(new Set(ctl.chosen().map((l) => l.id))), tile, ctl);
    line.textContent = order ? pictureLine(sale.ls.length) : sale.ls.length || mainnetOnly ? '' : 'No listings fit right now. ';
    line.hidden = !line.textContent;
  };
  if (!go || !connected || mainnetOnly) return;

  // One click: a fresh signed price for exactly these (OpenSea's is good for ~90 s), then the wallet. Listings
  // sold since drop out; the wallet shows the total, the Sweeper's fee included.
  go.addEventListener('click', async () => {
    const picked = ctl.chosen();
    if (!picked.length) return;
    // A picture union: each Colors' Credits go in from its first open slot, so none may be skipped over.
    const gap = order && gapOf(order, picked.map((l) => l.id));
    if (gap) return toast(`Add #${gap} too: it goes in before the ones you picked.`, 'info', 5000);
    let repriced = false;
    let newFee = ctl.fee();
    buying.n++;
    // A picture union: lock the Colors being bought first, so nobody else's buy lands in these slots meanwhile.
    const lockId = Array.from(crypto.getRandomValues(new Uint8Array(16)), (x) => x.toString(16).padStart(2, '0')).join('');
    let locked = false;
    await run(go, 'Buying…', async () => {
      if (order) {
        const colours = [...new Set(picked.map((l) => order!.colour.get(l.id)!))];
        const lk = await locks(batch, { op: 'acquire', id: lockId, account: session.account!, colours });
        if (lk && lk.ok === false) {
          held = new Set([...held, ...(lk.busy ?? [])]);
          reshow();
          throw new Error(`Someone is buying ${(lk.busy ?? []).map((m) => slotName(0, m)).join(', ')} for this picture right now. Try again in a minute, or buy other Colors.`);
        }
        locked = !!lk;
      }
      // A picture union's Credits are priced one by one (they needn't be among the cheapest that fit).
      const r = order
        ? await fetch('/opensea/buyquote', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ listings: picked }) })
        : await fetch(`/opensea/quote?batch=${batch}&ids=${picked.map((l) => l.id).join(',')}`);
      const q = (await r.json()) as Quote;
      if (!r.ok || q.error) throw new Error(q.error ?? 'No price right now. Try again.');
      checkQuote(q);
      // All of them or none: one missing would shift the rest of its Colors a slot early.
      if (order) {
        const have = new Set([...q.ids, ...(q.fwa ?? []).map((f) => f.id), ...(q.strategy ?? []).map((f) => f.id)]);
        const sold = picked.map((l) => l.id).filter((id) => !have.has(id));
        if (sold.length) {
          sold.forEach((id) => gone.add(Number(id)));
          const next = await replans.get(batch.toLowerCase())?.(gone);
          if (next) void repicture(next);
          throw new Error(`${sold.map((id) => `#${id}`).join(', ')} just sold. The picture picked another for ${sold.length === 1 ? 'its slot' : 'their slots'}: check and buy again.`);
        }
      }
      // A picture union: OpenSea's Credits deposit in the order sent, so send them in slot order.
      if (order) {
        const land = landing(order, [...picked.map((l) => l.id)]);
        const at = (i: number) => land.get(q.ids[i]) ?? 99;
        const idx = q.ids.map((_, i) => i).sort((x, y) => at(x) - at(y));
        [q.orders, q.ids, q.prices] = [idx.map((i) => q.orders[i]), idx.map((i) => q.ids[i]), idx.map((i) => q.prices[i])];
      }
      const [value, fee] = (await Promise.all([
        pub.readContract({ address: config.sweeper!, abi: sweeperAbi, functionName: 'quote', args: [BigInt(q.total)] }),
        pub.readContract({ address: config.sweeper!, abi: sweeperAbi, functionName: 'feeBps' }),
      ])) as [bigint, bigint];
      // Never ask the wallet for more than the page shows. A Credit relisted higher since the page loaded (or a
      // raised fee) stops here: the tiles and total take the new prices, and the next click pays what they show.
      const now = quotedPrices(q);
      const was = new Map(picked.map((l) => [l.id, BigInt(l.price)]));
      const sub = [...now.keys()].reduce((a, id) => a + (was.get(id) ?? 0n), 0n);
      const up = [...now].filter(([id, p]) => !was.has(id) || p > was.get(id)!).map(([id]) => id);
      if (up.length || value > sub + (sub * ctl.fee()) / 10_000n) {
        // Relisted higher: the new price, in red. Sold since: off the grid, and out of the picks.
        for (const l of picked) {
          const p = now.get(l.id);
          if (p !== undefined) l.price = String(p);
          else {
            sale.byId.delete(l.id);
            const i = sale.ls.indexOf(l);
            if (i >= 0) sale.ls.splice(i, 1);
          }
        }
        rose.clear();
        up.forEach((id) => rose.add(id));
        newFee = fee;
        repriced = true;
        throw new Error('Prices went up since this page loaded. Check the new total, then buy.');
      }
      const least = order ? BigInt(quotedCount(q)) : 1n; // a picture's: all or none
      const fwa = (q.fwa ?? []).map((f) => ({ listingId: BigInt(f.listingId), price: BigInt(f.price) }));
      const strategy = (q.strategy ?? []).map((f) => ({ tokenId: BigInt(f.id), price: BigInt(f.price) }));
      await send(
        fwa.length || strategy.length
          ? { address: config.sweeper!, abi: sweeperAbi, functionName: 'sweepAll', args: [batch, q.orders, fwa, strategy, least, fee], value }
          : { address: config.sweeper!, abi: sweeperAbi, functionName: 'sweep', args: [batch, q.orders, least, fee], value },
        (h) => {
          txNote(h);
          if (locked) void locks(batch, { op: 'hold', id: lockId, tx: h }); // sent: keep the Colors while it's pending
        },
      );
      const n = quotedCount(q);
      if (n < picked.length) toast(`${picked.length - n} sold before you got to them.`, 'info', 8000);
      justJoined(batch, n);
    }, '');
    if (locked) void locks(batch, { op: 'release', id: lockId }); // landed, failed or cancelled: the Colors are free
    buying.n--;
    // After run() puts the button back, so it takes the new count.
    if (repriced) {
      tiles();
      ctl.setFee(newFee);
    }
  });
}

/// Official ratings for the sheet: the facts row, cell tooltips, and the creator's arranger presets.
/// Settled: members who haven't claimed their share yet. `claim` pays the member whoever sends it, so any wallet
/// can push a share out; the connected member's own share is the Claim button above, not listed here.
async function drawUnclaimed(
  b: Ctx,
  run: (btn: HTMLElement | null, label: string, fn: () => Promise<unknown>, ok: string) => Promise<void>,
  txNote: (h: string) => void,
) {
  const el = document.getElementById('unclaimed');
  if (!el) return;
  const account = session.account;
  const members = [...new Map(b.depositors.map((d) => [d.toLowerCase(), d])).values()].filter((d) => !same(d, account));
  const owed = (
    await Promise.all(
      members.map(async (addr) => ({
        addr,
        amount: (await pub.readContract({ address: b.s.address, abi: batchAbi, functionName: 'claimable', args: [addr] })) as bigint,
      })),
    )
  ).filter((r) => r.amount > 0n);
  if (!owed.length || !el.isConnected) return;
  const total = owed.reduce((n, r) => n + r.amount, 0n);
  document.getElementById('unclaimed-total')!.textContent = `${eth(total)} · ${owed.length} member${owed.length === 1 ? '' : 's'}`;
  const list = document.getElementById('unclaimed-list')!;
  list.innerHTML = owed
    .sort((x, y) => (y.amount > x.amount ? 1 : y.amount < x.amount ? -1 : 0))
    .map(
      (r) => `<div class="due">${who(r.addr, 'sm', true)}<span class="num muted">${eth(r.amount)}</span>${
        account ? `<button class="btn sm" data-claim-for="${r.addr}">Claim for them</button>` : '<button class="btn sm" data-connect>Connect to claim</button>'
      }</div>`,
    )
    .join('');
  hydrate(list);
  el.hidden = false;
  list.querySelectorAll<HTMLButtonElement>('[data-claim-for]').forEach((btn) =>
    btn.addEventListener('click', () =>
      run(btn, 'Claiming…', () => send({ address: b.s.address, abi: batchAbi, functionName: 'claim', args: [btn.dataset.claimFor as Address] }, txNote), 'Sent to them.'),
    ),
  );
}

async function loadRatings(
  b: Ctx,
  run: (btn: HTMLElement | null, label: string, fn: () => Promise<unknown>, ok: string) => Promise<void>,
  txNote: (h: string) => void,
) {
  let rated: Record<string, Rated>;
  try {
    rated = (await ratings(b.ids)).ratings;
  } catch {
    document.getElementById('rating')?.replaceChildren('unavailable');
    return;
  }
  const el = document.getElementById('rating');
  if (!el) return;
  const scores = b.ids.map((id) => rated[id.toString()]?.score).filter((x): x is number => typeof x === 'number');
  if (scores.length) {
    // The Statement's own metadata carries a "Credit rating": the total over its 80. Show that total, so far.
    el.classList.remove('muted');
    el.innerHTML = `<span class="num">${ratingTotal(scores).toLocaleString()}</span>${scores.length < 80 ? ` <span class="muted small num">from ${scores.length} ${scores.length === 1 ? 'Credit' : 'Credits'}</span>` : ''} <a href="${RATING_URL}" target="_blank" rel="noopener" class="muted small" title="Each Credit’s score as Jack Butcher’s Statements contract computes it, added up as a Statement’s Credit Rating">↗</a>`;
  }
  document.querySelectorAll<HTMLElement>('.batch-art .cell[data-id]').forEach((c) => {
    const r = rated[c.dataset.id!];
    if (r) c.dataset.rating = fmtScore(r.score); // shown in the slot tooltip (no native title: it would cover the tooltip)
  });

  document.querySelector<HTMLElement>('.batch-art .sheet')?.classList.remove('closing');
}


/// Who is in: every depositor, most Credits first, with their share of the sale and a few of their Credits.
/// Hovering a row lights their cells on the sheet.
function openDepositors(b: Ctx, account: string | null) {
  const s = b.s;
  const rows = new Map<string, { addr: Address; ids: bigint[]; shares: number }>();
  b.ids.forEach((id, i) => {
    const addr = b.depositors[i];
    const key = addr.toLowerCase();
    const r = rows.get(key) ?? { addr, ids: [], shares: 0 };
    r.ids.push(id);
    r.shares += s.split === 1 ? earlyWeight(i) : 1;
    rows.set(key, r);
  });
  const list = [...rows.values()].sort((x, y) => y.shares - x.shares || y.ids.length - x.ids.length);
  // Shares are of all 80 positions (early-bird weights also add up to 80): the sale is split only once it's full.
  const total = 80;
  const d = document.createElement('dialog');
  d.className = 'people';
  d.innerHTML = `<form method="dialog">
    <header class="row"><h3>Members <span class="muted num">${list.length}</span></h3></header>
    <ol class="people-list">${list
      .map(
        (r) => `<li class="person" data-owner="${esc(r.addr.toLowerCase())}">
          <div class="person-top">${who(r.addr, 'sm', true)}${same(r.addr, s.creator) ? '<span class="tag">Creator</span>' : ''}${account && same(r.addr, account) ? '<span class="tag you">You</span>' : ''}</div>
          <div class="person-art">${r.ids.slice(0, 5).map((id) => `<img src="${art(id)}" alt="" title="Credit #${id}" loading="lazy">`).join('')}${r.ids.length > 5 ? `<span class="muted small num">+${r.ids.length - 5}</span>` : ''}</div>
          <span class="muted small num person-share">${r.ids.length} Credit${r.ids.length === 1 ? '' : 's'} · ${s.split === 1 ? `${r.shares.toFixed(2)} shares · ` : ''}${sharePct(r.shares / total)}</span>
        </li>`,
      )
      .join('')}</ol>
  </form>`;
  document.body.append(d);
  hydrate(d);
  const cells = [...document.querySelectorAll<HTMLElement>('.batch-art .cell[data-id]')];
  const owner = new Map(b.ids.map((id, i) => [id.toString(), b.depositors[i].toLowerCase()]));
  d.querySelectorAll<HTMLElement>('.person').forEach((li) => {
    const lit = () => cells.forEach((c) => c.classList.toggle('lit', owner.get(c.dataset.id!) === li.dataset.owner));
    li.addEventListener('pointerenter', lit);
    li.addEventListener('focusin', lit);
    li.addEventListener('pointerleave', () => cells.forEach((c) => c.classList.remove('lit')));
  });
  d.addEventListener('close', () => {
    cells.forEach((c) => c.classList.remove('lit'));
    d.remove();
  });
  openModal(d);
}

/// The union's own list of Credits (picked when it was made): only these can join. Which are in, and which are for
/// sale now with their price, cheapest first.
async function openPicked(b: Ctx) {
  const d = document.createElement('dialog');
  d.className = 'people picked-list';
  d.innerHTML = `<form method="dialog">
    <header class="row"><h3>Picked Credits <span class="muted num">${b.s.allowlistSize}</span></h3></header>
    <p class="muted small picked-note">Only these can join.</p>
    <div class="trait-grid">${creditSkel.repeat(Math.min(b.s.allowlistSize, 20))}</div>
  </form>`;
  document.body.append(d);
  d.addEventListener('close', () => d.remove());
  openModal(d);
  const grid = d.querySelector<HTMLElement>('.trait-grid')!, note = d.querySelector<HTMLElement>('.picked-note')!;
  const r = (await fetch(`/allowlist/${b.s.address}`)
    .then((x) => (x.ok ? x.json() : null))
    .catch(() => null)) as { ids?: number[] } | null;
  if (!d.isConnected) return;
  if (!r?.ids?.length) {
    note.textContent = 'Couldn’t read the list right now. Try again in a minute.';
    grid.innerHTML = '';
    return;
  }
  const inside = new Set(b.ids.map(String));
  const out = r.ids.filter((id) => !inside.has(String(id)));
  const sale = new Map((await listedById(out.map(String)).catch(() => [] as Listed[])).map((l) => [l.id, l]));
  if (!d.isConnected) return;
  const price = (id: number) => sale.get(String(id))?.price;
  const order = [...out.filter((id) => price(id)).sort((x, y) => (BigInt(price(x)!) < BigInt(price(y)!) ? -1 : 1)), ...out.filter((id) => !price(id)), ...r.ids.filter((id) => inside.has(String(id)))];
  grid.innerHTML = order.map((id) => creditCell(id, sale.has(String(id)) ? priceTag(sale.get(String(id))!) : inside.has(String(id)) ? '<span class="muted">In</span>' : '')).join('');
  note.textContent = `Only these can join. ${inside.size} in · ${sale.size} for sale.`;
}

