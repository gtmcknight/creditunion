import { session } from '../chain';
import { listBatches, type Listed, type Summary } from '../data';
import { hydrate, pct, who } from '../ens';
import { describeFilter } from '../traits';
import { eth, esc, same, sheet, until } from '../ui';

function status(s: Summary) {
  switch (s.state) {
    case 'Open':
      return `${80 - s.count} to go · ${until(s.deadline)} left`;
    case 'Full':
      return 'Full · ready to burn';
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
  ['fee', 'Lowest fee'],
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
      (k === 'fee' ? a.s.creatorFeeBps - b.s.creatorFeeBps : 0) ||
      (k === 'new' ? age.get(a.s.address)! - age.get(b.s.address)! : b.s.count - a.s.count),
  );
}

const fee = (s: Summary) =>
  `<span class="fee${s.creatorFeeBps ? '' : ' none'}">${s.creatorFeeBps ? `${pct(s.creatorFeeBps)} fee` : 'No fee'}</span>`;

/// Ids in this batch deposited by the connected wallet.
export function mineIn(b: Listed) {
  return new Set(b.ids.filter((_, i) => same(b.depositors[i], session.account)).map(String));
}

export function card({ s, ids, depositors }: Listed) {
  const f = describeFilter(s.filter);
  const mine = mineIn({ s, ids, depositors });
  return `<a class="card" href="#/b/${s.address}">
    ${sheet(ids, { size: 'sm', mine })}
    <div class="card-body">
      <div class="row"><strong>${esc(s.name || 'Untitled')}</strong><span class="tags">${mine.size ? `<span class="tag you">You · ${mine.size}</span>` : ''}<span class="tag ${s.state.toLowerCase()}">${s.state}</span></span></div>
      <div class="row creator">${who(s.creator)}${fee(s)}</div>
      <div class="bar"><i style="width:${(s.count / 80) * 100}%"></i></div>
      <div class="row muted small"><span class="num">${s.count}/80</span><span>${status(s)}</span></div>
      ${f ? `<div class="small filter">${esc(f)}</div>` : ''}
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
  }
}

export async function home(app: HTMLElement) {
  app.innerHTML = `
  <section class="hero">
    <div class="hero-text">
      <h1>Eighty Credits make a Statement.</h1>
      <p class="lede">Pool yours with others. At 80 it burns into a Statement, sold onchain, split 80 ways.</p>
      <div class="actions"><a class="btn primary" href="#/new">Open a batch</a><a class="btn" href="#/how">How it works</a></div>
    </div>
    <div class="closest" id="closest" aria-live="polite"></div>
    <dl class="stats hero-stats" id="stats">
      ${['Open batches', 'Credits pooled', 'Statements made', 'Sold'].map((k) => `<div><dt>${k}</dt><dd class="num">–</dd></div>`).join('')}
    </dl>
  </section>
  <section>
    <div class="section-head"><h2>Batches</h2><span class="muted" id="batch-count"></span>
      <div class="seg sm" role="radiogroup" aria-label="Sort">${SORTS.map(([k, l]) => `<label><input type="radio" name="sort" value="${k}" ${k === sortKey() ? 'checked' : ''}><span>${l}</span></label>`).join('')}</div>
    </div>
    <div class="grid" id="batches"><p class="muted">Loading from chain…</p></div>
  </section>`;

  try {
    const list = await listBatches();
    const el = document.getElementById('batches');
    if (!el) return; // navigated away
    document.getElementById('batch-count')!.textContent = list.length ? `${list.length}` : '';
    drawHero(list);
    const draw = () => {
      sortList(list, sortKey());
      el.innerHTML = list.length
        ? list.map(card).join('')
        : `<div class="empty-state"><p>No batches yet.</p><a class="btn primary" href="#/new">Open the first one</a></div>`;
      hydrate(el);
    };
    draw();
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

export function how(app: HTMLElement) {
  const rows: [string, string][] = [
    ['Open', 'Anyone holding at least 10 Credits opens a batch with them. The opener names it, may restrict it to one trait value (Colors, Print, Weight or Eights, read from Jack’s own art contract), sets an optional reserve and a deadline of 3–90 days.'],
    ['Deposit', 'Approve the Eighty factory once, then add any number of Credits. Or send a single Credit straight to the batch with safeTransferFrom; no approval needed. Order of deposit is the order on the Statement.'],
    ['Withdraw', 'Until the batch holds 80, every depositor can take their Credits back at any time. No fee, no penalty.'],
    ['Lock', 'The 80th deposit locks the batch. Nobody can withdraw or add. The deadline moves to at least 7 days out.'],
    ['Burn', 'Anyone can call assemble(). The batch burns the 80 through Jack’s Statement contract and holds the Statement. The contract checks every Credit is gone and the Statement arrived, or the whole thing reverts.'],
    ['Expire', 'If the deadline passes before the burn (never filled, or Statements sold out), every depositor withdraws their Credits.'],
    ['Auction', 'The 24-hour clock starts with the first bid. Each bid must beat the last by 5% (at least 0.01 ETH). A bid in the last 15 minutes extends to 15 minutes after it. Outbid ETH is returned in the same transaction. A reserve, if set, lapses after 7 days without bids.'],
    ['Split', 'Anyone settles when the clock runs out: the Statement goes to the winner, 1% to Eighty, and each deposited Credit claims 1/80 of the rest.'],
    ['Trust', 'No owner, no admin keys, no upgrades, no server state. The factory can only move Credits from the person calling it into one of its own batches. Contracts and this site are open source.'],
  ];
  app.innerHTML = `
  <section class="prose">
    <h1>How it works</h1>
    <p class="lede">Jack Butcher’s <a href="https://jack.art/credits" target="_blank" rel="noopener">Credits</a> burn 80 at a time into a Statement, at most 1,526 of them. The burn needs all 80 in one wallet. Eighty is that wallet: a contract per batch that nobody controls.</p>
    <dl class="rules">${rows.map(([k, v], i) => `<div style="--i:${i}"><dt><span class="n">0${i + 1}</span>${k}</dt><dd>${v}</dd></div>`).join('')}</dl>
  </section>`;
}
