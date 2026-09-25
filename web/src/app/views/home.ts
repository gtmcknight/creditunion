import { session } from '../chain';
import { ARRANGEMENTS, listBatches, type Listed, type Summary, hasLayout, layoutSlot } from '../data';
import { hydrate, pct, who } from '../ens';
import { fitByBatch } from '../fit';
import { fillGhosts, registerFilter } from '../ghosts';
import type { Address } from 'viem';
import { describeFilter } from '../traits';
import { eth, esc, same, sheet, until } from '../ui';

function status(s: Summary) {
  switch (s.state) {
    case 'Open':
      return `${80 - s.count} to go · ${until(s.deadline)} left`;
    case 'Full':
      return s.exitWindow ? 'Full · exit window open' : s.canAssemble ? 'Full · ready to burn' : 'Full · waiting for Jack';
    case 'Expired':
      return 'Expired · Credits returnable';
    case 'Auction':
      return s.highBid ? `Bid ${eth(s.highBid)} · ${until(s.auctionEnd)}` : 'Statement made · awaiting first bid';
    case 'Settled':
      return `Sold ${eth(s.highBid)}`;
  }
}

const SORTS = [
  ['fullest', 'Fullest'],
  ['new', 'Newest'],
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
      (k === 'new' ? age.get(a.s.address)! - age.get(b.s.address)! : b.s.count - a.s.count),
  );
}

/// Shown only when the batch carries a creator fee (a factory-level setting, 0 at launch).
const fee = (s: Summary) => (s.creatorFeeBps ? `<span class="fee">${pct(s.creatorFeeBps)} creator fee</span>` : '');

/// Ids in this batch deposited by the connected wallet.
export function mineIn(b: Listed) {
  return new Set(b.ids.filter((_, i) => same(b.depositors[i], session.account)).map(String));
}

export function card({ s, ids, depositors }: Listed, fit?: bigint[]) {
  const f = describeFilter(s.filter, s.allowlistSize);
  const mine = mineIn({ s, ids, depositors });
  const room = 80 - s.count;
  const canJoin = fit?.length ? Math.min(fit.length, room) : 0;
  registerFilter(s.address, s.filter);
  return `<a class="card${canJoin ? ' can-join' : ''}" href="#/b/${s.address}">
    ${sheet(ids, { size: 'sm', mine, batch: s.state === 'Open' ? s.address : undefined })}
    <div class="card-body">
      <div class="row"><strong>${esc(s.name || 'Untitled')}</strong><span class="tags">${s.split === 1 ? '<span class="tag early">Early bird</span>' : ''}${canJoin ? `<span class="tag join">Join · ${canJoin} fit</span>` : ''}${mine.size ? `<span class="tag you">You · ${mine.size}</span>` : ''}<span class="tag ${s.state.toLowerCase()}">${s.state}</span></span></div>
      <div class="row creator">${who(s.creator)}${fee(s)}</div>
      <div class="bar"><i style="width:${(s.count / 80) * 100}%"></i></div>
      <div class="row muted small"><span class="num">${s.count}/80</span><span>${status(s)}</span></div>
      ${f || s.arrangement ? `<div class="small filter">${[f, s.arrangement ? ARRANGEMENTS[s.arrangement] : ''].filter(Boolean).map(esc).join(' · ')}</div>` : ''}
    </div>
  </a>`;
}

const PARTY_STATES = new Set(['Open', 'Full', 'Expired']);
export type HomeTab = 'parties' | 'auctions';

/// Two tabs over one list: parties still pooling, and Statements at or past auction. Each leads with
/// "For you" (what you're in, can join, or are bidding on), then everything else.
export async function home(app: HTMLElement, tab: HomeTab = 'parties') {
  app.innerHTML = `
  <section>
    <div class="subnav">
      <div class="subtabs" role="tablist">
        <a role="tab" href="#/" aria-selected="${tab === 'parties'}">Parties <span class="num" id="n-parties"></span></a>
        <a role="tab" href="#/auctions" aria-selected="${tab === 'auctions'}">Auctions <span class="num" id="n-auctions"></span></a>
      </div>
      <div class="subnav-end">
        <div class="seg sm" role="radiogroup" aria-label="Sort" id="sort-seg" hidden>${SORTS.map(([k, l]) => `<label><input type="radio" name="sort" value="${k}" ${k === sortKey() ? 'checked' : ''}><span>${l}</span></label>`).join('')}</div>
        <a class="btn primary sm" href="#/new">Make Statement Party</a>
      </div>
    </div>
    <div id="batches"><p class="muted">Loading from chain…</p></div>
  </section>`;

  try {
    const all = await listBatches();
    const el = document.getElementById('batches');
    if (!el) return; // navigated away
    const parties = all.filter((b) => PARTY_STATES.has(b.s.state));
    const auctions = all.filter((b) => !PARTY_STATES.has(b.s.state));
    document.getElementById('n-parties')!.textContent = parties.length ? String(parties.length) : '';
    document.getElementById('n-auctions')!.textContent = auctions.length ? String(auctions.length) : '';
    const list = tab === 'parties' ? parties : auctions;
    document.getElementById('sort-seg')!.hidden = tab !== 'parties' || list.length < 4;
    let fit = new Map<Address, bigint[]>();
    const forYou = (b: Listed) =>
      !!session.account &&
      (mineIn(b).size > 0 || same(b.s.creator, session.account) || fit.has(b.s.address) || (tab === 'auctions' && same(b.s.highBidder, session.account)));
    const grid = (items: Listed[]) => `<div class="grid">${items.map((b) => card(b, fit.get(b.s.address))).join('')}</div>`;
    const draw = () => {
      sortList(list, tab === 'parties' ? sortKey() : 'new');
      const mine = list.filter(forYou);
      const rest = list.filter((b) => !forYou(b));
      el.innerHTML = !list.length
        ? tab === 'parties'
          ? `<div class="empty-state"><p>No parties yet.</p><a class="btn primary" href="#/new">Make Statement Party</a></div>`
          : `<div class="empty-state"><p>No auctions yet. When a party burns its 80, the Statement is auctioned here.</p><a class="btn" href="#/">See parties</a></div>`
        : (mine.length ? `<h2 class="group-title">For you <span class="num">${mine.length}</span></h2>${grid(mine)}` : '') +
          (rest.length ? `${mine.length ? `<h2 class="group-title">All ${tab} <span class="num">${rest.length}</span></h2>` : ''}${grid(rest)}` : '');
      hydrate(el);
      fillGhosts(el);
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
    if (el) el.innerHTML = `<p class="error">Couldn't read parties from chain. ${esc((e as Error).message)}</p>`;
  }
}
