import { parseAbi, parseEther, type Address } from 'viem';
import { batchAbi, creditsAbi, factoryAbi, sweeperAbi } from '../abi';
import { canBatch, config, explorer, pub, send, sendBatch, session } from '../chain';
import { ARRANGEMENTS, type PhaseName, earlyShare, earlyWeight, sharePct, eligible, forgetBatches, getBatch, hasLayout, indexedBatch, layoutSlot, me, placeOnLayout, ratings, type Rated } from '../data';
import { filterRules, maskInks, maskLabel, paletteBit, type Rule } from '../traits';
import { hydrate, pct, who } from '../ens';
import { examples, fillGhosts, registerDeposits, registerFilter } from '../ghosts';
import { Room, books, depositedKeys, keysOf, noRoomReason, type Books } from '../slots';
import { MAX_SWEEP, buying, checkQuote, connectToBuy, live as keepLive, minEth, onSources, priceTag, relist, sourceMarks, sourceShown, sweepControls, sweepRow, type Listed, type Quote, type Sale, type Source } from '../forsale';
import { creditCell, creditSkel } from './trait';
import { directionCanvas, directions, mountDirections } from '../directions';
import { activityFold } from './live';
import { $$, art, clock, errText, esc, eth, openModal, same, setRange, sheet, short, toast, until } from '../ui';
import { stamp } from '../../shared/stamp';
import { go as navigate } from '../main';

const CHUNK = 40; // Credits per transaction; keeps each one well under the block gas limit
// One Credit sent straight to the party: the Batch records the sender as depositor, no approval needed.
// The Batch errors ride along so a revert in its receive hook reads plainly.
const directAbi = [
  ...parseAbi(['function safeTransferFrom(address from, address to, uint256 tokenId)']),
  ...batchAbi.filter((x) => x.type === 'error'),
] as const;
const RATING_URL = 'https://jack.art/credits/rating';
const fmtScore = (s: number) => (Math.floor(s * 100) / 100).toFixed(2);

/// Hovering one of your Credits in the picker: its number, rating and rank, and its traits. Ratings are read once
/// for the whole picker, the first time you hover.
let pickTip: HTMLElement | null = null;
function pickTips(el: HTMLElement, ids: bigint[]) {
  let rated: Record<string, Rated> | null = null, n = 0, loading: Promise<void> | null = null;
  const load = () => (loading ??= ratings(ids).then((r) => { rated = r.ratings; n = r.n; }).catch(() => {}));
  const tip = (pickTip ??= Object.assign(document.createElement('div'), { className: 'slot-tip pick-tip' }));
  if (!tip.isConnected) document.body.append(tip);
  const body = (id: string) => {
    const r = rated?.[id];
    const traits = r ? [r.traits.palette, `${r.traits.eights} ${r.traits.eights === 1 ? 'eight' : 'eights'}`, r.traits.registration].filter(Boolean).join(' · ') : '';
    return `<div class="filled"><img src="${art(BigInt(id))}" alt="">
      <div><p class="takes">#${Number(id).toLocaleString()}${r ? ` <span class="muted">· rating ${fmtScore(r.score)}</span>` : ''}</p>
      <p class="muted small">${r ? `Rank ${r.rank.toLocaleString()} of ${n.toLocaleString()}` : 'Loading rating…'}</p>
      ${traits ? `<p class="small">${esc(traits)}</p>` : ''}</div></div>`;
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
/// A Credit to preselect once its picker draws (the ?pick= link).
let pickAsk: { at: string; id: string } | null = null;
/// Which Add Credits tab is open, per Credit Union, so a live refresh doesn't flip it back.
let addTab: { at: string; tab: string } | null = null;
/// Transactions in flight on this page: live refreshes wait while one is.
let busy = 0;
/// The live-refresh timer for the Credit Union on screen (one at a time).
let live: ReturnType<typeof setInterval> | null = null;
const LIVE_MS = 12_000; // about one block

/// What each union's sheet is showing, for the visit: the page re-renders as Credits come in.
const shown = new Map<string, string>();

/// Now · Finished · Yours over a union's sheet: as it stands (examples faded in the empty slots), as it will look
/// at 80, or only your Credits in ink. Finished only while there are empty slots; Yours only with Credits in.
function showSwitch(count: number, mine: number, on: string) {
  const opts: [string, string][] = [['now', 'Now']];
  if (count < 80) opts.push(['finished', 'Finished']);
  if (mine) opts.push(['yours', `Yours <span class="num">${mine}</span>`]);
  if (opts.length < 2) return '<span></span>';
  return `<div class="show" role="radiogroup" aria-label="Show">${opts
    .map(([v, label]) => `<button type="button" role="radio" data-show="${v}" aria-checked="${v === on}">${label}</button>`)
    .join('')}</div>`;
}

export async function party(app: HTMLElement, address: Address, rerender: () => void) {
  let b: Ctx;
  const account = session.account;
  // Your side of it (shares, what you're owed, your Credits), read alongside the Credit Union, not after it.
  const mine = account ? me(address, account) : null;
  // From the Credit Union index when a page read it in the last minute (being in it is being ours): the page shows at
  // once, and is checked against the chain right after. Otherwise only parties our factory made: any contract can
  // answer summary() with a made-up party. A read that fails (the network, a rate limit) says so, rather than that
  // the Credit Union doesn't exist.
  const indexed = indexedBatch(address);
  if (indexed) b = indexed.b;
  else {
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
  if (location.search) history.replaceState(history.state, '', location.pathname);
  const s = b.s;
  const burned = s.state === 'Auction' || s.state === 'Settled';
  // On a layout batch the sheet shows every Credit in the slot it will burn into, not in deposit order.
  const slots = hasLayout(s.filter) ? Array.from({ length: 80 }, (_, i) => layoutSlot(s.filter, i)) : null;
  // The value of the painted trait each Credit in was booked under (Batch.keyOf), read alongside the wallet's
  // own reads rather than after them.
  const keysRead = slots && !burned ? depositedKeys(s.address, b.ids).catch(() => null) : null;
  const m: Mine = mine ? await mine : null;
  const myIds = new Set(b.ids.filter((_, i) => same(b.depositors[i], account)).map(String));
  const rules = filterRules(s.filter, s.allowlistSize, (i) => layoutSlot(s.filter, i));
  const depositors = new Set(b.depositors.map((d) => d.toLowerCase())).size;

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
  // Painted slot chips count the spaces left, not what the sheet was painted with.
  if (placed && s.state === 'Open')
    for (const r of rules) if (r.slots) r.value = String(r.slots.filter((i) => placed![i] == null).length);
  registerFilter(s.address, s.filter);
  registerDeposits(b.ids, b.depositors, b.s.split === 1);
  // A choice that no longer applies (the union filled, or your Credits left) falls back to Now.
  const picked = shown.get(s.address.toLowerCase()) ?? 'now';
  const show = (picked === 'finished' && s.count < 80) || (picked === 'yours' && myIds.size) ? picked : 'now';
  const artHtml = burned
    ? `<figure class="statement">${sheet(b.ids, { closed: true })}<figcaption class="legend muted small"><span>Statement #${s.statementId}</span></figcaption></figure>`
    : `${sheet(b.ids, { mine: myIds, fresh: placed ? undefined : seen < s.count ? seen : undefined, closing: s.state === 'Full', placed, batch: s.state === 'Open' ? s.address : undefined })}${directionCanvas}
       <div class="legend muted small">${showSwitch(s.count, myIds.size, show)}${directions(s.address)}</div>`;

  app.innerHTML = `
  
  <section class="batch">
    <div class="batch-art dir-host" data-show="${show}">${artHtml}</div>
    <div class="batch-side">
      <header>
        <div class="row"><span class="tag ${s.state.toLowerCase()}">${s.state}</span><button type="button" class="link small" id="share">Share</button></div>
        <h1>${esc(s.name || 'Untitled')}</h1>
        <div class="byline">${who(s.creator, 'lg', true)}${s.creatorFeeBps ? `<span class="fee">${pct(s.creatorFeeBps)} creator fee</span>` : ''}</div>
      </header>
      ${
        s.state === 'Open' || s.state === 'Full' || s.state === 'Expired'
          ? `<div class="progress">
          <div class="slots" aria-hidden="true">${Array.from({ length: 80 }, (_, i) => `<i${i < s.count ? ' class="in"' : ''}></i>`).join('')}</div>
          <div class="row small"><span class="num">${s.count} of 80 Credits in${depositors ? ` · <button type="button" class="link" id="depositors-btn">${depositors} ${depositors === 1 ? 'member' : 'members'}</button>` : ''}</span><span class="muted num" id="to-go">${s.state === 'Open' ? `${80 - s.count} to go` : s.state === 'Full' ? stage(s) : 'Expired'}</span></div>
        </div>`
          : ''
      }
      <div class="takes"><h3>Who can join</h3><div class="rule-chips">${rules.length ? rules.map(rule).join('') : '<span class="rule-chip">Any Credit</span>'}</div></div>
      <div id="panel">${panel(b, m, myIds)}</div>
      <div class="folds">
      ${s.state === 'Settled' ? `<details class="more" id="unclaimed" hidden>
        <summary><span>Unclaimed</span><span class="muted small num" id="unclaimed-total"></span></summary>
        <div class="dues" id="unclaimed-list"></div>
        <p class="small muted">Anyone can send a member their share. It goes to them, you pay the gas.</p>
      </details>` : ''}
      ${s.state === 'Auction' || s.state === 'Settled' ? `<details class="more" id="bids" open>
        <summary><span>Bids</span><span class="muted small" id="bids-count">…</span></summary>
        <ol class="bid-list" id="bid-list"><li class="muted small">Loading…</li></ol>
      </details>` : ''}
      <details class="more" id="activity">
        <summary><span>Activity</span><span class="muted small num" id="activity-count"></span></summary>
        <ol class="live-list fold-list" id="activity-list"><li class="muted live-empty">Loading…</li></ol>
      </details>
      <details class="more">
        <summary><span>Details</span><span class="muted small">${ARRANGEMENTS[s.arrangement] ?? 'Deposit order'} · ${s.split === 1 ? 'Early bird' : 'Equal'} payout</span></summary>
        <dl class="facts">
          ${fact('Layout', ARRANGEMENTS[s.arrangement] ?? 'Deposit order')}
          ${fact('Payout', payout(b, myIds))}
          ${s.state === 'Auction' || s.state === 'Settled' ? fact('Members', `<button type="button" class="link num" id="depositors-btn">${depositors}</button>`) : ''}
          ${s.count ? fact('Credit rating', `<span id="rating" class="muted">…</span>`) : ''}
          ${s.reserve && (s.state === 'Open' || s.state === 'Full' || (s.state === 'Auction' && s.minBid === s.reserve && !s.highBid)) ? fact('Reserve', eth(s.reserve)) : ''}
          ${fact('Sale split', split(s))}
          ${fact('Contract', link(s.address))}
        </dl>
      </details>
      </div>
    </div>
  </section>`;

  hydrate(app);
  document.getElementById('depositors-btn')?.addEventListener('click', () => openDepositors(b, account ?? null));
  loadBids(s.address, account ?? null);
  void activityFold(s.address);
  // Chrome keeps a focus ring on <summary> after a mouse click; drop it for pointer use only.
  app.querySelectorAll<HTMLElement>('.more summary').forEach((el) => el.addEventListener('pointerup', () => setTimeout(() => el.blur(), 0)));
  fillGhosts(app);
  // A Credit on the sheet opens its own page.
  app.querySelector('.batch-art')?.addEventListener('click', (e) => {
    const c = (e.target as HTMLElement).closest<HTMLElement>('.cell[data-id]');
    if (!c) return;
    if ((e as MouseEvent).metaKey || (e as MouseEvent).ctrlKey) window.open(`/credit/${c.dataset.id}`, '_blank');
    else navigate(`/credit/${c.dataset.id}`);
  });
  document.getElementById('share')?.addEventListener('click', async () => {
    const url = shareUrl(s);
    try {
      if (navigator.share && matchMedia('(pointer: coarse)').matches) await navigator.share({ title: s.name || 'A Credit Union on creditunion.fun', url });
      else {
        await navigator.clipboard.writeText(url);
        toast('Link copied', 'ok', 2500);
      }
    } catch {}
  });
  const art = app.querySelector<HTMLElement>('.batch-art');
  app.querySelectorAll<HTMLElement>('.rule-chip[data-slots]').forEach((row) => {
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
  watchLive(app, address, b, rerender, !!indexed);
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
/// straight away too (the page was drawn from the index, which can be a few seconds old).
function watchLive(app: HTMLElement, address: Address, b: Ctx, rerender: () => void, now = false) {
  if (live) clearInterval(live);
  const mark = ({ s, ids, depositors }: Ctx) => `${stamp(s.state, s.count, s.highBid)}:${s.lockAt}:${s.state}:${ids.join()}:${depositors.join().toLowerCase()}`;
  const was = mark(b);
  const path = location.pathname;
  const look = async () => {
    if (location.pathname !== path || !app.isConnected) {
      clearInterval(live!);
      live = null;
      return;
    }
    if (document.hidden || busy || document.querySelector('dialog[open]')) return;
    try {
      const n = await getBatch(address);
      if (location.pathname !== path || busy) return;
      if (mark(n) !== was) {
        clearInterval(live!);
        live = null;
        forgetBatches(); // the lists should show it changed too
        await party(app, address, rerender);
      }
    } catch {}
  };
  live = setInterval(look, LIVE_MS);
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
    <div class="created-head"><h3>${joined ? 'You’re in' : 'Your Credit Union is live'}</h3><p class="muted">${joined ? `${joined} ${joined === 1 ? 'Credit' : 'Credits'} in ${esc(name)} · ${left > 0 ? `${left} to go` : 'full'}` : esc(name)}</p></div>
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

/// "Early bird · 1st 1.88% → 80th 0.63%" of the depositors' payout, plus the connected wallet's own positions and what they add up to.
function payout(b: Ctx, myIds: Set<string>) {
  if (b.s.split !== 1) return 'Equal · 1/80 each';
  const mine = b.ids.map((id, i) => [String(id), i] as const).filter(([id]) => myIds.has(id));
  const shares = mine.reduce((n, [, i]) => n + earlyShare(i), 0);
  const yours = mine.length
    ? ` <span class="muted">· yours ${mine.map(([, i]) => `#${i + 1}`).slice(0, 4).join(' ')}${mine.length > 4 ? '…' : ''} = ${sharePct(shares)}</span>`
    : '';
  return `Early bird · <span class="num">1st ${sharePct(earlyShare(0))} → 80th ${sharePct(earlyShare(79))}</span>${yours}`;
}

/// "1% protocol · 5% creator · 94% to depositors"
function split(s: Ctx['s']) {
  const rest = 10_000 - s.protocolFeeBps - s.creatorFeeBps;
  return [`${pct(s.protocolFeeBps)} protocol`, s.creatorFeeBps ? `${pct(s.creatorFeeBps)} creator` : '', `${pct(rest)} members`]
    .filter(Boolean)
    .join(' · ');
}

const fact = (k: string, v: string) => `<div><dt>${k}</dt><dd>${v}</dd></div>`;
/// A rule row; hovering it lights the slots it governs on the sheet (every slot unless it's a layout row).
/// A row with a trait page is a link to it.
const rule = (r: Rule) => {
  const tag = r.href ? 'a' : 'span';
  return `<${tag} class="rule-chip"${r.href ? ` href="${esc(r.href)}"` : ''} data-slots="${r.slots ? r.slots.join(',') : 'all'}">${r.swatch ? `<span class="swatches">${maskInks(r.swatch).map((c) => `<i style="background:${c}"></i>`).join('')}</span>` : ''}${esc(r.label)} <span class="num">${esc(r.value)}</span></${tag}>`;
};
const link = (a: string) => {
  const u = explorer('address', a);
  return u ? `<a href="${u}" target="_blank" rel="noopener" class="mono">${short(a)} ↗</a>` : `<span class="mono">${short(a)}</span>`;
};
/// Where a full party stands right now: the summary's phase, moved on by the clock, since it reads the chain only on load.
function livePhase(s: Ctx['s']): PhaseName {
  const now = Date.now() / 1000;
  if ((s.phase === 'Countdown' || s.phase === 'Burnable') && now >= s.deadline) return 'Expired';
  if (s.phase === 'Countdown' && now >= s.lockAt) return 'Burnable';
  return s.phase;
}

/// The progress row's note for a full party.
function stage(s: Ctx['s']) {
  switch (livePhase(s)) {
    case 'Waiting':
      return 'Waiting for Jack to launch Statements';
    case 'Countdown':
      return `Locks in <span data-clock="${s.lockAt}">${clock(s.lockAt)}</span>`;
    case 'Burnable':
      return `Locked · <span data-clock="${s.deadline}">${clock(s.deadline)}</span>`;
    default:
      return 'Unlocked';
  }
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

const plural = (n: number) => `${n} Credit${n === 1 ? '' : 's'}`;

function panel(b: Ctx, m: Mine, myIds: Set<string>) {
  const s = b.s;
  const connect = `<button class="btn primary block" data-connect>Connect wallet</button>`;
  // Your Credits in this party as tiles: pick some to withdraw just those, or leave none picked to take all.
  const withdraw = (primary = false) =>
    myIds.size
      ? `<div class="yours-in"><p class="small fit-row"><span><strong class="num">${myIds.size}</strong> of your Credits ${myIds.size === 1 ? 'is' : 'are'} in this Credit Union.</span><span id="w-actions"><button type="button" class="link small" id="w-clear" hidden>Clear</button></span></p>
        <div class="picker" id="w-picker">${[...myIds].map((id) => `<button type="button" class="pick" data-id="${id}" aria-pressed="false" aria-label="Credit #${id}"><img src="${art(BigInt(id))}" alt="" loading="lazy"></button>`).join('')}</div>
        <button class="btn block${primary ? ' primary' : ''}" id="withdraw">Withdraw all ${plural(myIds.size)}</button></div>`
      : '';

  if (s.state === 'Open') {
    // One box, three tabs: add your own Credits, buy ones that fit, or take yours back. Buy leads when you hold
    // none; Withdraw only exists once you have Credits in.
    const remembered = addTab?.at === s.address && (addTab.tab !== 'withdraw' || myIds.size) ? addTab.tab : null;
    const start = remembered ?? (!m || !m.owned.length ? 'buy' : 'mine');
    return `<div class="box add">
      <div class="box-head"><h3>Credits<span class="src-toggles" id="buy-sources"${start === 'buy' ? '' : ' hidden'}></span></h3><span class="muted small num" id="pick-count"></span></div>
      <div class="subtabs" role="tablist">
        <button type="button" role="tab" data-add="mine" aria-selected="${start === 'mine'}">Deposit <span class="num" id="n-mine"></span></button>
        <button type="button" role="tab" data-add="buy" aria-selected="${start === 'buy'}">Buy</button>
        ${myIds.size ? `<button type="button" role="tab" data-add="withdraw" aria-selected="${start === 'withdraw'}">Withdraw <span class="num">${myIds.size}</span></button>` : ''}
      </div>
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
      <p class="muted small pane-note"><span id="buy-line">Finding the cheapest listings that fit… </span>Leave anytime until it locks. Credit Union is unofficial and experimental, so use it at your own risk. <a href="/faq">Questions?</a></p>
    </div>`;
  }

  if (s.state === 'Full') {
    const mine = m ? withdraw(true) || '<p class="small muted">You have no Credits here.</p>' : connect;
    switch (livePhase(s)) {
      case 'Waiting':
        return `<div class="box">
          <h3>Full</h3>
          <p class="muted">Waiting for Jack to launch Statements. You can still leave anytime.</p>
          ${myIds.size ? withdraw() : ''}
        </div>`;
      case 'Countdown':
        return `<div class="box">
          <h3>Locks in <span class="num" data-clock="${s.lockAt}">${clock(s.lockAt)}</span></h3>
          <p class="muted">Last chance to leave. After that it’s locked for an hour so anyone can burn it.</p>
          ${mine}
        </div>`;
      case 'Burnable':
        return `<div class="box">
          <h3>Ready to burn</h3>
          <p class="muted">Burn within <span class="num" data-clock="${s.deadline}">${clock(s.deadline)}</span> or it unlocks.</p>
          ${m ? `<button class="btn primary block" id="assemble">Make Statement</button>` : connect}
          <p class="small muted">Anyone can press it and pays the gas. Nobody can leave during this hour.</p>
        </div>`;
      default:
        return `<div class="box">
          <h3>Unlocked</h3>
          <p class="muted">Nobody burned in time. Leave, or restart the countdown.</p>
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
    const mine = m?.shares
      ? m.claimable > 0n
        ? `<div class="stack"><button class="btn primary block" id="claim">Claim ${eth(m.claimable)}</button><p class="small muted center num">${m.shares} of 80</p></div>`
        : `<p class="small muted num">Claimed · ${m.shares} of 80</p>`
      : '';
    return `<div class="box">
      <div class="bid-now"><div><span>Sold</span><strong class="num">${eth(s.highBid)}</strong></div><div><span>${s.split === 1 ? "Avg per Credit" : "Per Credit"}</span><strong class="num">${eth(per)}</strong></div></div>
      <p class="small muted sold-to">To ${who(s.highBidder, 'sm', true)}</p>
      ${mine}${owed}
    </div>`;
  }

  const hasMin = s.highBid > 0n || s.minBid > 1n;
  // What settling now would pay you, as Batch.settle splits it: the bid less the protocol and creator fees, over
  // 80 shares (Equal) or 12,640 units (Early bird, where your positions weigh 237 - 2i units each).
  const early = s.split === 1;
  const myUnits = early ? b.ids.reduce((n, id, i) => (myIds.has(String(id)) ? n + 237n - 2n * BigInt(i) : n), 0n) : BigInt(m?.shares ?? 0);
  const perUnit = (s.highBid - (s.highBid * BigInt(s.protocolFeeBps)) / 10_000n - (s.highBid * BigInt(s.creatorFeeBps)) / 10_000n) / (early ? 12_640n : 80n);
  const myShare = early ? sharePct(Number(myUnits) / 12_640) : `${m?.shares ?? 0}/80`;
  return `<div class="box">
    <div class="bid-now">
      <div><span>${s.highBid ? 'Current bid' : hasMin ? 'Reserve' : 'Opening bid'}</span><strong class="num">${s.highBid ? eth(s.highBid) : hasMin ? eth(s.minBid) : 'Any'}</strong><em class="sub">${s.highBid ? `by ${who(s.highBidder, 'sm', true)}` : 'The clock starts at the first bid.'}</em></div>
      <div><span>${ended ? 'Ended' : 'Ends in'}</span><strong class="num"${s.highBid && !ended ? ` data-countdown="${s.auctionEnd}"` : ''}>${!s.highBid ? '24h' : ended ? '—' : until(s.auctionEnd)}</strong>${!ended ? '<em class="sub">Late bids add 15 min</em>' : ''}</div>
    </div>
    ${
      ended
        ? `<button class="btn primary block" id="settle">Settle</button>`
        : m
          ? `<form class="bid-form" id="bid-form"><label class="field"><input id="bid" inputmode="decimal" autocomplete="off" placeholder="${hasMin ? minEth(s.minBid) : '0.1'}" aria-label="Bid in ETH"><span>ETH</span></label><button class="btn primary">Bid</button></form>
             <p class="small muted">${hasMin ? `Min ${minEth(s.minBid)}. ` : ''}Outbid ETH returns instantly. Credit Union is unofficial and experimental, so use it at your own risk.</p>`
          : connect
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
    <p class="muted small buy-source">One transaction buys the Credits you pick (OpenSea, FWA, CreditStrategy) and deposits them here in your name.</p>
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
      toast(errText(e), 'err', 8000);
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
    if (btn && !btn.dataset.busy) btn.textContent = wPicks.size ? `Withdraw ${plural(wPicks.size)}` : `Withdraw all ${plural(myIds.size)}`;
    const clr = document.getElementById('w-clear');
    if (clr) clr.hidden = !wPicks.size;
  };
  if (wPicker) {
    pickTips(wPicker, [...myIds].map(BigInt));
    wPicker.addEventListener('click', (e) => {
      const t = (e.target as HTMLElement).closest<HTMLElement>('.pick');
      if (!t) return;
      const id = t.dataset.id!;
      wPicks.has(id) ? wPicks.delete(id) : wPicks.add(id);
      wDraw();
    });
    document.getElementById('w-clear')?.addEventListener('click', () => { wPicks.clear(); wDraw(); });
  }
  document.getElementById('withdraw')?.addEventListener('click', (e) =>
    run(e.currentTarget as HTMLElement, 'Withdrawing…', async () => {
      const ids = [...(wPicks.size ? wPicks : myIds)].map(BigInt);
      for (let i = 0; i < ids.length; i += CHUNK)
        await send({ address: s.address, abi: batchAbi, functionName: 'withdraw', args: [ids.slice(i, i + CHUNK)] }, txNote);
    }, 'Credits returned to your wallet.'),
  );

  document.getElementById('assemble')?.addEventListener('click', (e) =>
    run(e.currentTarget as HTMLElement, 'Burning…', () =>
      send({ address: s.address, abi: batchAbi, functionName: 'assemble', gas: 12_000_000n }, txNote),
    'The Statement exists. Auction is open.'),
  );

  document.getElementById('settle')?.addEventListener('click', (e) =>
    run(e.currentTarget as HTMLElement, 'Settling…', () =>
      send({ address: s.address, abi: batchAbi, functionName: 'settle' }, txNote),
    'Settled. Members can claim.'),
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

  document.getElementById('bid-form')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const input = document.getElementById('bid') as HTMLInputElement;
    let value: bigint;
    try {
      value = parseEther(input.value.trim() || '0');
    } catch {
      return toast('Enter an amount in ETH.', 'err');
    }
    if (value <= 0n) return toast('Enter an amount in ETH.', 'err');
    run((e.currentTarget as HTMLElement).querySelector('button'), 'Bidding…', () =>
      send({ address: s.address, abi: batchAbi, functionName: 'bid', value }, txNote),
    'You’re the high bidder.');
  });

  mountDirections();

  // Now · Finished · Yours: what the sheet and its directions show.
  document.querySelector('.show')?.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-show]');
    const host = btn?.closest<HTMLElement>('.dir-host');
    if (!btn || !host) return;
    host.dataset.show = btn.dataset.show;
    shown.set(s.address.toLowerCase(), btn.dataset.show!);
    btn.parentElement!.querySelectorAll('[data-show]').forEach((b) => b.setAttribute('aria-checked', String(b === btn)));
    host.dispatchEvent(new CustomEvent('ghosts', { bubbles: true }));
  });

  // A full batch's sheet closes its gaps: 80 become one image.
  const closing = document.querySelector('.sheet.closing');
  if (closing) requestAnimationFrame(() => requestAnimationFrame(() => closing.classList.add('closed')));

  document.getElementById('restart')?.addEventListener('click', (e) =>
    run(e.currentTarget as HTMLElement, 'Restarting…', () =>
      send({ address: s.address, abi: batchAbi, functionName: 'restartCountdown' }, txNote),
    'Countdown restarted. Five minutes to leave.'),
  );

  // Lock countdowns tick in place. When one runs out the phase has moved on: read the party again, a few
  // seconds late so the chain has a block past the boundary.
  const clocks = $$('[data-clock]');
  if (clocks.length) {
    const t = setInterval(() => {
      if (!clocks[0].isConnected) return clearInterval(t);
      for (const el of clocks) el.textContent = clock(Number(el.dataset.clock));
      if (clocks.some((el) => Date.now() / 1000 >= Number(el.dataset.clock) + 3)) {
        clearInterval(t);
        rerender();
      }
    }, 1000);
  }

  // Live countdown
  const cd = document.querySelector<HTMLElement>('[data-countdown]');
  if (cd) {
    const t = setInterval(() => {
      if (!cd.isConnected) return clearInterval(t);
      cd.textContent = until(Number(cd.dataset.countdown));
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
        document.getElementById('buy-sources')?.toggleAttribute('hidden', t.dataset.add !== 'buy');
        addTab = { at: s.address, tab: t.dataset.add! };
        if (t.dataset.add === 'buy') buy();
      }),
    );
    if (document.querySelector('[data-add="buy"][aria-selected="true"]')) buy();
    drawToGo(s);
  }
}

/// "72 to go · Buy now": Buy now opens the Buy tab with its slider at the most one buy takes; the rest takes as many
/// buys as it needs. Where buying isn't on (testnets), just what's left.
function drawToGo(s: Ctx['s']) {
  const el = document.getElementById('to-go');
  if (!el || s.state !== 'Open') return;
  const room = 80 - s.count;
  if (!config.sweeper || room <= 0) return void (el.textContent = `${room} to go`);
  el.innerHTML = `${room} to go · <button type="button" class="link" id="finish">Buy now</button>`;
  el.querySelector('#finish')!.addEventListener('click', () => {
    const tab = document.querySelector<HTMLButtonElement>('[data-add="buy"]');
    if (tab?.getAttribute('aria-selected') !== 'true') tab?.click();
    const range = document.querySelector<HTMLInputElement>('#buy-act #sale-n');
    if (range && !document.querySelector('#listings .skel')) {
      range.value = range.max;
      range.dispatchEvent(new Event('input', { bubbles: true }));
    } else buyMost = true; // still loading: taken up when the listings land
    document.querySelector('[data-pane="buy"]')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  });
}
/// Buy now, clicked while the Buy tab's listings load: its slider goes to the most once they're in.
let buyMost = false;

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
  const fits = passing.filter((id) => base.fits(keyOf(id)));
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

  el.innerHTML = fits
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
        const ids = [...picks].map(BigInt);
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
          await send({ address: config.credits, abi: directAbi, functionName: 'safeTransferFrom', args: [session.account!, s.address, ids[0]] }, txNote);
        else if (way === 'batch')
          await sendBatch(
            [{ address: config.credits, abi: creditsAbi, functionName: 'setApprovalForAll', args: [config.factory, true] }, ...chunks.map(deposit)],
            () => toast('Submitted. Waiting for confirmation…', 'info'),
          );
        else for (const chunk of chunks) await send(deposit(chunk), txNote);
        picks.clear();
        justJoined(s.address, ids.length);
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
    draw();
  };
  // Scroll the picker (not the page) to the first pick, so a preselected Credit is in view.
  const first = el.querySelector<HTMLElement>('.pick[aria-pressed="true"]');
  if (first) el.scrollTop += first.getBoundingClientRect().top - el.getBoundingClientRect().top - 6;
  el.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('.pick');
    if (!btn || btn.classList.contains('off')) return;
    const id = btn.dataset.id!;
    picks.has(id) ? picks.delete(id) : picks.add(id);
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
    line.textContent = "Couldn’t load OpenSea listings right now. "; console.warn("[buy] listings", e);
    return;
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
  const marks = document.getElementById('buy-sources');
  if (marks) sourceMarks(marks, [...sources, ...all.map((l) => l.source)]);
  const showing = (picked: Set<string>) => all.filter(sourceShown).filter((l, i) => i < MAX_SWEEP || picked.has(l.id));
  const shown = showing(new Set());
  const sale: Sale = { ls: [...shown], preview: mainnetOnly, byId: new Map(shown.map((l) => [l.id, l])), all: shown, mine: new Set() };
  // Credits whose price went up at the last click: their new price shows in red until the next.
  const rose = new Set<string>();
  const tile = (l: Listed) => creditCell(Number(l.id), priceTag(l, rose.has(l.id)));
  const tiles = () => {
    grid.innerHTML = sale.ls.map(tile).join('');
  };
  tiles();
  // Testnet: the banner already says it's a preview.
  line.textContent = shown.length || mainnetOnly ? '' : 'No listings fit right now. ';
  line.hidden = !line.textContent;
  let chosen: () => Listed[] = () => [];
  const label = () => {
    if (!go) return;
    const n = chosen().length;
    go.disabled = mainnetOnly || !n || !connected;
    go.textContent = n ? `Buy & deposit ${n}` : 'Buy & deposit';
  };
  const ctl = sweepControls(host, sale, grid, { button: false, cap: 80 - b.s.count, onPick: label });
  chosen = ctl.chosen;
  label();
  const range = host.querySelector<HTMLInputElement>('#sale-n');
  if (buyMost && range) {
    range.value = range.max;
    range.dispatchEvent(new Event('input', { bubbles: true }));
  }
  buyMost = false;
  // Live: the listings that fit, read again every 20 s (the worker's scan of them is cached 30 s). The cheapest that
  // many show, and any you picked stay while they're listed.
  keepLive(grid, async () => {
    const r = await fetch(`/opensea/listings?batch=${batch}`);
    const d = r.ok ? ((await r.json()) as { listings?: Listed[]; sources?: Source[]; error?: string }) : null;
    if (!d?.listings || d.error || !grid.isConnected) return;
    all = d.listings;
    sources = d.sources ?? sources;
    reshow();
  });
  const reshow = () => {
    relist(grid, sale, showing(new Set(ctl.chosen().map((l) => l.id))), tile, ctl);
    if (marks) sourceMarks(marks, [...sources, ...all.map((l) => l.source)]);
    line.textContent = sale.ls.length || mainnetOnly ? '' : 'No listings fit right now. ';
    line.hidden = !line.textContent;
  };
  // A marketplace hidden or shown: its listings leave or slide in.
  onSources(grid, reshow);
  if (!go || !connected || mainnetOnly) return;

  // One click: a fresh signed price for exactly these (OpenSea's is good for ~90 s), then the wallet. Listings
  // sold since drop out; the wallet shows the total, the Sweeper's fee included.
  go.addEventListener('click', async () => {
    const picked = ctl.chosen();
    if (!picked.length) return;
    let repriced = false;
    let newFee = ctl.fee();
    buying.n++;
    await run(go, 'Buying…', async () => {
      const r = await fetch(`/opensea/quote?batch=${batch}&ids=${picked.map((l) => l.id).join(',')}`);
      const q = (await r.json()) as Quote;
      if (!r.ok || q.error) throw new Error(q.error ?? 'No price right now. Try again.');
      checkQuote(q);
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
      const fwa = (q.fwa ?? []).map((f) => ({ listingId: BigInt(f.listingId), price: BigInt(f.price) }));
      const strategy = (q.strategy ?? []).map((f) => ({ tokenId: BigInt(f.id), price: BigInt(f.price) }));
      await send(
        fwa.length || strategy.length
          ? { address: config.sweeper!, abi: sweeperAbi, functionName: 'sweepAll', args: [batch, q.orders, fwa, strategy, 1n, fee], value }
          : { address: config.sweeper!, abi: sweeperAbi, functionName: 'sweep', args: [batch, q.orders, 1n, fee], value },
        txNote,
      );
      const n = quotedCount(q);
      if (n < picked.length) toast(`${picked.length - n} sold before you got to them.`, 'info', 8000);
      justJoined(batch, n);
    }, '');
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
  let n = 0;
  let version = '';
  try {
    const r = await ratings(b.ids);
    rated = r.ratings;
    n = r.n;
    version = r.version;
  } catch {
    document.getElementById('rating')?.replaceChildren('unavailable');
    return;
  }
  const el = document.getElementById('rating');
  if (!el) return;
  const scores = b.ids.map((id) => rated[id.toString()]?.score).filter((x): x is number => typeof x === 'number');
  if (scores.length) {
    // The Statement's own metadata carries a "Credit rating": the total over its 80. Show that total, so far.
    const total = scores.reduce((a, x) => a + x, 0);
    el.classList.remove('muted');
    el.innerHTML = `<span class="num">${Math.round(total).toLocaleString()}</span>${scores.length < 80 ? ` <span class="muted small num">from ${scores.length} of 80</span>` : ''} <a href="${RATING_URL}" target="_blank" rel="noopener" class="muted small" title="The total of Jack Butcher’s rating (v${version}, over all ${n.toLocaleString()} Credits) across this Credit Union’s Credits">v${version} ↗</a>`;
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
          <div class="row">${who(r.addr, 'sm', true)}<span class="tags">${same(r.addr, s.creator) ? '<span class="tag">Creator</span>' : ''}${account && same(r.addr, account) ? '<span class="tag you">You</span>' : ''}</span></div>
          <div class="row muted small"><span class="num">${r.ids.length} Credit${r.ids.length === 1 ? '' : 's'}</span><span class="num">${s.split === 1 ? `${r.shares.toFixed(2)} shares · ` : ''}${sharePct(r.shares / total)} of the sale</span></div>
          <div class="person-art">${r.ids.slice(0, 8).map((id) => `<img src="${art(id)}" alt="" title="Credit #${id}" loading="lazy">`).join('')}${r.ids.length > 8 ? `<span class="muted small num">+${r.ids.length - 8}</span>` : ''}</div>
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


/// The auction's bids, newest first: amount, who, when, and the transaction.
async function loadBids(address: Address, account: string | null) {
  const list = document.getElementById('bid-list');
  const count = document.getElementById('bids-count');
  if (!list || !count) return;
  type Row = { bidder: Address; amount: string; end: number; block: number; tx: string; time: number };
  let rows: Row[] = [];
  try {
    const r = await fetch(`/bids/${address}`);
    const j = (await r.json()) as { bids?: Row[]; error?: string };
    if (!r.ok || j.error) throw new Error(j.error ?? 'No bids');
    rows = j.bids ?? [];
  } catch {
    count.textContent = 'unavailable';
    list.innerHTML = '';
    return;
  }
  count.textContent = rows.length ? `${rows.length} bid${rows.length === 1 ? '' : 's'}` : 'None yet';
  const ago = (t: number) => {
    const d = Math.max(0, Math.floor(Date.now() / 1000 - t));
    return d < 60 ? 'just now' : d < 3600 ? `${Math.floor(d / 60)}m ago` : d < 86400 ? `${Math.floor(d / 3600)}h ago` : `${Math.floor(d / 86400)}d ago`;
  };
  list.innerHTML = rows.length
    ? rows
        .map(
          (r, i) => `<li class="bid${i === 0 ? ' high' : ''}">
            <span class="num bid-amt">${eth(BigInt(r.amount))}</span>
            <span class="bid-who">${who(r.bidder, 'sm', true)}${account && same(r.bidder, account) ? '<span class="tag you">You</span>' : ''}</span>
            ${explorer('tx', r.tx)
              ? `<a class="muted small num bid-when" href="${explorer('tx', r.tx)}" target="_blank" rel="noopener" title="View transaction">${r.time ? ago(r.time) : 'tx'} ↗</a>`
              : `<span class="muted small num bid-when">${r.time ? ago(r.time) : ''}</span>`}
          </li>`,
        )
        .join('')
    : '';
  hydrate(list);
}
