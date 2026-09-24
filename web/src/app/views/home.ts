import { listBatches, type Summary } from '../data';
import { describeFilter } from '../traits';
import { eth, esc, sheet, until } from '../ui';

const STEPS = [
  ['Pool', '10+ Credits opens one. Anyone fills it.'],
  ['Withdraw', 'Take yours back any time before 80.'],
  ['Burn', 'At 80 it locks. Anyone burns it.'],
  ['Auction', 'Sold onchain. 99% split 80 ways.'],
];

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

export async function home(app: HTMLElement) {
  app.innerHTML = `
  <section class="hero">
    <div class="hero-text">
      <h1>Eighty Credits make a Statement.</h1>
      <p class="lede">Most holders have one. Eighty pools them: 80 in, one Statement out, sale split 80 ways.</p>
      <div class="actions"><a class="btn primary" href="#/new">Open a batch</a><a class="btn" href="#/how">How it works</a></div>
    </div>
    <a class="hero-art" id="hero-art" aria-hidden="true" tabindex="-1"></a>
    <ol class="steps">${STEPS.map(([h, t], i) => `<li style="--i:${i}"><span class="n">0${i + 1}</span><strong>${h}</strong><span>${t}</span></li>`).join('')}</ol>
  </section>
  <section>
    <div class="section-head"><h2>Batches</h2><span class="muted" id="batch-count"></span></div>
    <div class="grid" id="batches"><p class="muted">Loading from chain…</p></div>
  </section>`;

  try {
    const list = await listBatches();
    const el = document.getElementById('batches');
    if (!el) return; // navigated away
    document.getElementById('batch-count')!.textContent = list.length ? `${list.length}` : '';
    const order: Record<string, number> = { Open: 0, Full: 1, Auction: 2, Settled: 3, Expired: 4 };
    list.sort((a, b) => order[a.s.state] - order[b.s.state] || b.s.count - a.s.count);
    const lead = list.find((x) => x.s.state === 'Open') ?? list[0];
    const hero = document.getElementById('hero-art') as HTMLAnchorElement | null;
    if (hero && lead) {
      hero.href = `#/b/${lead.s.address}`;
      hero.innerHTML = `${sheet(lead.ids)}<span class="legend muted small"><span>${esc(lead.s.name || 'Untitled')}</span><span class="num">${lead.s.count}/80</span></span>`;
      hero.classList.add('in');
    }
    el.innerHTML = list.length
      ? list
          .map(({ s, ids }, i) => {
            const f = describeFilter(s.filter);
            return `<a class="card" href="#/b/${s.address}" style="--i:${i}">
              ${sheet(ids, { size: 'sm' })}
              <div class="card-body">
                <div class="row"><strong>${esc(s.name || 'Untitled')}</strong><span class="tag ${s.state.toLowerCase()}">${s.state}</span></div>
                <div class="bar"><i style="width:${(s.count / 80) * 100}%"></i></div>
                <div class="row muted small"><span class="num">${s.count}/80</span><span>${status(s)}</span></div>
                ${f ? `<div class="small filter">${esc(f)}</div>` : ''}
              </div>
            </a>`;
          })
          .join('')
      : `<div class="empty-state"><p>No batches yet.</p><a class="btn primary" href="#/new">Open the first one</a></div>`;
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
