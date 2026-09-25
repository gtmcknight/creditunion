import { session } from '../chain';
import { ARRANGEMENTS, listBatches, type Listed, type Summary, hasLayout, layoutSlot } from '../data';
import { hydrate, pct, who } from '../ens';
import { fitByBatch } from '../fit';
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
  return `<a class="card${canJoin ? ' can-join' : ''}" href="#/b/${s.address}">
    ${sheet(ids, { size: 'sm', mine, layout: hasLayout(s.filter) ? Array.from({ length: 80 }, (_, i) => layoutSlot(s.filter, i)) : undefined })}
    <div class="card-body">
      <div class="row"><strong>${esc(s.name || 'Untitled')}</strong><span class="tags">${s.split === 1 ? '<span class="tag early">Early bird</span>' : ''}${canJoin ? `<span class="tag join">Join · ${canJoin} fit</span>` : ''}${mine.size ? `<span class="tag you">You · ${mine.size}</span>` : ''}<span class="tag ${s.state.toLowerCase()}">${s.state}</span></span></div>
      <div class="row creator">${who(s.creator)}${fee(s)}</div>
      <div class="bar"><i style="width:${(s.count / 80) * 100}%"></i></div>
      <div class="row muted small"><span class="num">${s.count}/80</span><span>${status(s)}</span></div>
      ${f || s.arrangement ? `<div class="small filter">${[f, s.arrangement ? `Order · ${ARRANGEMENTS[s.arrangement]}` : ''].filter(Boolean).map(esc).join(' · ')}</div>` : ''}
    </div>
  </a>`;
}

/// Hero data: the open batches nearest 80, and totals across every batch.
function drawHero(list: Listed[]) {
  const closest = [...list]
    .filter((b) => b.s.state === 'Open')
    .sort((a, b) => b.s.count - a.s.count)
    .slice(0, 3);
  const el = document.getElementById('closest');
  if (el) {
    el.innerHTML = closest.length
      ? `<h2 class="eyebrow">Closest to 80</h2>${closest
          .map(
            (b) => `<a class="near" href="#/b/${b.s.address}">
          <span class="near-body">
            <span class="row"><strong>${esc(b.s.name || 'Untitled')}${mineIn(b).size ? ` <span class="tag you">You · ${mineIn(b).size}</span>` : ''}</strong><span class="num">${b.s.count}/80</span></span>
            <span class="bar"><i style="width:${(b.s.count / 80) * 100}%"></i></span>
            <span class="row muted small">${who(b.s.creator)}${fee(b.s)}</span>
          </span>
        </a>`,
          )
          .join('')}`
      : `<h2 class="eyebrow">Closest to 80</h2><p class="muted">No open batches. <a href="#/new">Open the first →</a></p>`;
    hydrate(el);
  }
  const stats = document.getElementById('stats');
  if (stats) {
    const pooled = list.filter((b) => b.s.state === 'Open' || b.s.state === 'Full').reduce((n, b) => n + b.s.count, 0);
    const made = list.filter((b) => b.s.statement !== '0x0000000000000000000000000000000000000000').length;
    const sold = list.filter((b) => b.s.state === 'Settled').reduce((a, b) => a + b.s.highBid, 0n);
    const vals = [String(list.filter((b) => b.s.state === 'Open').length), String(pooled), String(made), sold ? eth(sold, 2) : '0'];
    stats.querySelectorAll('dd').forEach((dd, i) => (dd.textContent = vals[i]));
    // "0 Statements · 0 sold" reads as a dead product; those two appear once there is something to count.
    stats.querySelectorAll<HTMLElement>('div').forEach((d, i) => (d.hidden = i >= 2 && made === 0));
    const seg = document.getElementById('sort-seg');
    if (seg) seg.hidden = list.length < 4;
  }
}

export async function home(app: HTMLElement) {
  app.innerHTML = `
  <section class="hero">
    <div class="hero-text">
      <h1>Eighty Credits make a Statement.</h1>
      <p class="lede">Pool yours with others. At 80 it burns into a Statement, sold onchain, split 80 ways.</p>
      <div class="actions"><a class="btn primary" href="#/new">Design a batch</a><a class="btn" href="#/docs">How it works</a></div>
    </div>
    <div class="closest" id="closest" aria-live="polite"></div>
    <dl class="stats hero-stats" id="stats">
      ${[
        ['Open batches', 'Open'],
        ['Credits pooled', 'Pooled'],
        ['Statements made', 'Statements'],
        ['Sold', 'Sold'],
      ]
        .map(([long, short]) => `<div><dt><span class="long">${long}</span><span class="short">${short}</span></dt><dd class="num">–</dd></div>`)
        .join('')}
    </dl>
  </section>
  <section>
    <div class="section-head"><h2>Batches</h2><span class="muted" id="batch-count"></span>
      <div class="seg sm" role="radiogroup" aria-label="Sort" id="sort-seg" hidden>${SORTS.map(([k, l]) => `<label><input type="radio" name="sort" value="${k}" ${k === sortKey() ? 'checked' : ''}><span>${l}</span></label>`).join('')}</div>
    </div>
    <div class="notice" id="fit-bar">${
      session.account
        ? `<span>Checking which batches take your Credits…</span>`
        : `<span>Connect to see which batches you can join, based on what you hold.</span><button class="btn sm primary" data-connect>Connect</button>`
    }</div>
    <div class="grid" id="batches"><p class="muted">Loading from chain…</p></div>
  </section>`;

  try {
    const list = await listBatches();
    const el = document.getElementById('batches');
    if (!el) return; // navigated away
    document.getElementById('batch-count')!.textContent = list.length ? `${list.length}` : '';
    drawHero(list);
    let fit = new Map<Address, bigint[]>();
    let onlyMine = false;
    const draw = () => {
      sortList(list, sortKey());
      const shown = onlyMine ? list.filter((b) => fit.has(b.s.address)) : list;
      el.innerHTML = shown.length
        ? shown.map((b) => card(b, fit.get(b.s.address))).join('')
        : list.length
          ? `<div class="empty-state"><p>None of the open batches take your Credits right now.</p><a class="btn primary" href="#/new">Design one that does</a></div>`
          : `<div class="empty-state"><p>No batches yet.</p><a class="btn primary" href="#/new">Open the first one</a></div>`;
      hydrate(el);
    };
    draw();
    if (session.account) {
      fitByBatch(list).then((m) => {
        fit = m;
        const bar = document.getElementById('fit-bar');
        if (!bar) return;
        const open = list.filter((b) => b.s.state === 'Open').length;
        bar.innerHTML = fit.size
          ? `<span><strong>${fit.size}</strong> of ${open} open batch${open === 1 ? '' : 'es'} take your Credits.</span><button type="button" class="btn sm" id="only-mine" aria-pressed="false">Only those</button>`
          : `<span>${open ? 'None of the open batches take your Credits right now.' : 'No open batches yet.'}</span><a class="btn sm" href="#/new">Design one</a>`;
        document.getElementById('only-mine')?.addEventListener('click', (e) => {
          const b = e.currentTarget as HTMLButtonElement;
          onlyMine = !onlyMine;
          b.setAttribute('aria-pressed', String(onlyMine));
          b.classList.toggle('primary', onlyMine);
          draw();
        });
        draw();
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
    if (el) el.innerHTML = `<p class="error">Couldn't read batches from chain. ${esc((e as Error).message)}</p>`;
  }
}
