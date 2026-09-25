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
      ${f || s.arrangement ? `<div class="small filter">${[f, s.arrangement ? `Order · ${ARRANGEMENTS[s.arrangement]}` : ''].filter(Boolean).map(esc).join(' · ')}</div>` : ''}
    </div>
  </a>`;
}

export async function home(app: HTMLElement) {
  // App-style bar: filter tabs on the left, sort and the one primary action on the right.
  app.innerHTML = `
  <section>
    <div class="subnav">
      <div class="subtabs" role="tablist">
        <button type="button" role="tab" data-view="all" aria-selected="true">All <span class="num" id="batch-count"></span></button>
        <button type="button" role="tab" data-view="fit" aria-selected="false" id="fit-tab" hidden>Fits yours <span class="num" id="fit-count"></span></button>
      </div>
      <div class="subnav-end">
        <div class="seg sm" role="radiogroup" aria-label="Sort" id="sort-seg" hidden>${SORTS.map(([k, l]) => `<label><input type="radio" name="sort" value="${k}" ${k === sortKey() ? 'checked' : ''}><span>${l}</span></label>`).join('')}</div>
        <a class="btn primary sm" href="#/new">New batch</a>
      </div>
    </div>
    <div class="grid" id="batches"><p class="muted">Loading from chain…</p></div>
  </section>`;

  try {
    const list = await listBatches();
    const el = document.getElementById('batches');
    if (!el) return; // navigated away
    document.getElementById('batch-count')!.textContent = list.length ? `${list.length}` : '';
    document.getElementById('sort-seg')!.hidden = list.length < 4;
    let fit = new Map<Address, bigint[]>();
    let onlyMine = false;
    const draw = () => {
      sortList(list, sortKey());
      const shown = onlyMine ? list.filter((b) => fit.has(b.s.address)) : list;
      el.innerHTML = shown.length
        ? shown.map((b) => card(b, fit.get(b.s.address))).join('')
        : `<div class="empty-state"><p>No batches yet.</p><a class="btn primary" href="#/new">Open the first one</a></div>`;
      hydrate(el);
      fillGhosts(el);
    };
    draw();
    if (session.account) {
      fitByBatch(list).then((m) => {
        fit = m;
        const tab = document.getElementById('fit-tab');
        if (!tab || !fit.size) return;
        document.getElementById('fit-count')!.textContent = String(fit.size);
        tab.hidden = false;
        draw();
      });
    }
    document.querySelectorAll<HTMLButtonElement>('.subtabs [data-view]').forEach((t) =>
      t.addEventListener('click', () => {
        onlyMine = t.dataset.view === 'fit';
        document.querySelectorAll('.subtabs [data-view]').forEach((x) => x.setAttribute('aria-selected', String(x === t)));
        draw();
      }),
    );
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
    if (el) el.innerHTML = `<p class="error">Couldn't read batches from chain. ${esc((e as Error).message)}</p>`;
  }
}
