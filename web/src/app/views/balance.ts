import { eth, toast, rangeHtml, setRange } from '../ui';
import { MAX_SWEEP, listedPager, sweepFee, sweepToWallet, type Listed } from '../forsale';
import { ratingTotal, scores } from '../data';
import { buyListed, listings, type ForSale } from './statements';
import { session } from '../chain';

/// When Balance opens and a Statement converts.
const OPENS = 'Oct 20';
/// Every Credit's rating, so every BALANCE there could ever be (Jack's supply count, 2026-10-02).
const BALANCE_EVER = 53_752_386;
/// Where the Credits slider starts, and how many listings the page ranks to pick from.
const DEFAULT_N = 10;
const POOL = 240;

type Money = 'eth' | 'usd';
type Point = [number, number | null, number | null]; // unix seconds, ETH per BALANCE via a Statement, via 80 Credits

/// /balance before it opens: three boxes, each a way to hold BALANCE before it opens (the pool, greyed; a Statement
/// for sale; Credits for sale, a slider's worth), as pay/receive pairs with the Buy that does it, then a chart of the price
/// over time. The real page replaces this under the same path.
export function balance(app: HTMLElement) {
  const buy = (id: string, label: string) => (session.account ? `<button type="button" class="btn primary block" id="${id}">${label}</button>` : `<button type="button" class="btn primary block" data-connect>Connect to buy</button>`);
  app.innerHTML = `
  <section class="tokens">
    <header class="create-head">
      <h1>Balance opens ${OPENS}.</h1>
      <p class="create-lede">Every Statement redeems for its rating in $BALANCE. Buy the Credits to make one, or a Statement outright.</p>
    </header>
    <section class="bal-price">
      <div class="bal-tiles">
        <div class="bal-tile">
          <h4>Credits <span class="tag" id="bp-cred-best" hidden>Cheapest</span></h4>
          <div class="bal-io"><span class="muted small">You pay</span><strong class="num" id="bp-cred-pay">…</strong><span class="muted small num" id="bp-cred-pay-sub"></span></div>
          <div class="bal-io"><span class="muted small">Worth on ${OPENS}</span><strong class="num" id="bp-cred-get">…</strong><span class="muted small num" id="bp-cred-each"></span></div>
          <div class="bal-pick">${rangeHtml('bal-n', 1, MAX_SWEEP, DEFAULT_N)}${buy('bp-cred-buy', `Buy ${DEFAULT_N}`)}</div>
          <span class="muted small bal-note" id="bp-cred-sub">Reading listings…</span>
        </div>
        <div class="bal-tile">
          <h4>Statement <span class="tag" id="bp-stmt-best" hidden>Cheapest</span></h4>
          <div class="bal-io"><span class="muted small">You pay</span><strong class="num" id="bp-stmt-pay">…</strong><span class="muted small num" id="bp-stmt-pay-sub"></span></div>
          <div class="bal-io"><span class="muted small">You receive on ${OPENS}</span><strong class="num" id="bp-stmt-get">…</strong><span class="muted small num" id="bp-stmt-each"></span></div>
          ${buy('bp-stmt-buy', 'Buy')}
          <span class="muted small bal-note" id="bp-stmt-sub">Reading listings…</span>
        </div>
        <div class="bal-tile bal-off">
          <h4>Pool</h4>
          <div class="bal-io"><span class="muted small">You pay</span><strong>ETH</strong><span class="muted small">Any amount</span></div>
          <div class="bal-io"><span class="muted small">You receive</span><strong>$BALANCE</strong><span class="muted small">At the pool price</span></div>
          <button type="button" class="btn primary block" disabled>Opens ${OPENS}</button>
          <span class="muted small bal-note"></span>
        </div>
      </div>
      <div class="bal-chart" id="bal-chart"></div>
    </section>
  </section>`;
  void priceBoard(app);
}

/// The board: prices read live (the cheapest Statement for sale per rating point, bought on OpenSea with no fee;
/// the 80 listed Credits with the most rating per ETH, what the Sweeper takes, fee in), in USD (Coinbase spot, through the
/// worker). The Buys run here.
async function priceBoard(app: HTMLElement) {
  const q = <T extends HTMLElement>(id: string) => app.querySelector<T>(`#${id}`);
  let usd: number | null = null; // ETH in USD, read once; a BALANCE is cents, so dollars read at a glance (ETH until the rate is in)
  const money = (): Money => (usd === null ? 'eth' : 'usd');
  const vals: Record<'stmt' | 'cred', number | null> = { stmt: null, cred: null }; // ETH per BALANCE
  const deal: Record<'stmt' | 'cred', { cost: bigint; get: number; what: string } | null> = { stmt: null, cred: null };
  const costLine = (k: 'stmt' | 'cred') => {
    const d = deal[k];
    if (!d) return;
    const inUsd = usd === null ? '' : `$${Math.round((Number(d.cost) / 1e18) * usd).toLocaleString('en-US')}`;
    q(`bp-${k}-pay`)!.textContent = eth(d.cost);
    q(`bp-${k}-pay-sub`)!.textContent = inUsd;
    q(`bp-${k}-get`)!.textContent = `${d.get.toLocaleString('en-US')} $BALANCE`;
    q(`bp-${k}-sub`)!.textContent = d.what;
  };
  const fmt = (ethPer: number, big = false) => {
    if (money() === 'usd') {
      const v = ethPer * usd!;
      return big ? `$${v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : Math.round(v).toLocaleString('en-US')}` : `$${v < 1 ? v.toFixed(3) : v.toFixed(2)}`;
    }
    return big ? `${Math.round(ethPer).toLocaleString('en-US')} ETH` : `${ethPer.toFixed(6)} ETH`;
  };
  let draw: (() => void) | null = null;
  const paint = () => {
    for (const k of ['stmt', 'cred'] as const) {
      const v = vals[k];
      if (v === null) continue;
      const each = q(`bp-${k}-each`)!;
      each.textContent = `${fmt(v)} each`;
      each.title = `At this price all ${(BALANCE_EVER / 1e6).toFixed(2)}M BALANCE is worth ${fmt(v * BALANCE_EVER, true)}`;
      costLine(k);
    }
    if (vals.stmt !== null && vals.cred !== null) {
      q('bp-stmt-best')!.hidden = vals.stmt > vals.cred;
      q('bp-cred-best')!.hidden = vals.cred >= vals.stmt;
    }
    draw?.();
  };
  const rate = (async () => {
    try {
      const r = (await (await fetch('/market/eth-usd.json')).json()) as { usd?: number };
      usd = r.usd && r.usd > 0 ? r.usd : null;
    } catch {}
    paint();
  })();

  const viaStatement = (async () => {
    const ls = (await listings()).filter((x) => x.rating);
    const btn = q<HTMLButtonElement>('bp-stmt-buy');
    if (!ls.length) {
      q('bp-stmt-sub')!.textContent = 'No Statement for sale';
      if (btn) btn.disabled = true;
      return;
    }
    const best = ls.reduce((a, b) => (Number(BigInt(b.price)) / b.rating! < Number(BigInt(a.price)) / a.rating! ? b : a));
    vals.stmt = Number(BigInt(best.price)) / 1e18 / best.rating!;
    deal.stmt = { cost: BigInt(best.price), get: best.rating!, what: `Statement #${best.id}, listed on OpenSea` };
    if (btn) {
      btn.textContent = `Buy Statement #${best.id}`;
      btn.addEventListener('click', () => void buyListed(btn, best as ForSale, () => void viaStatementAgain()));
    }
    paint();
  })();
  const viaStatementAgain = async () => {
    const ls = (await listings()).filter((x) => x.rating);
    const btn = q<HTMLButtonElement>('bp-stmt-buy');
    if (!ls.length || !btn) return;
    const best = ls.reduce((a, b) => (Number(BigInt(b.price)) / b.rating! < Number(BigInt(a.price)) / a.rating! ? b : a));
    vals.stmt = Number(BigInt(best.price)) / 1e18 / best.rating!;
    deal.stmt = { cost: BigInt(best.price), get: best.rating!, what: `Statement #${best.id}, listed on OpenSea` };
    const next = btn.cloneNode(true) as HTMLButtonElement;
    delete next.dataset.armed;
    next.disabled = false;
    next.textContent = `Buy Statement #${best.id}`;
    next.addEventListener('click', () => void buyListed(next, best as ForSale, () => void viaStatementAgain()));
    btn.replaceWith(next);
    paint();
  };

  /// The Credits tile: a slider picks how many of the best (most rating per ETH) listed Credits, 1 to MAX_SWEEP; the
  /// price is the average per BALANCE for that many, fee in, and the Buy sweeps exactly those to the wallet.
  const viaCredits = (async () => {
    // The worker's value order (rating per ETH) needs its market book; read a few pages and rank here too, so a
    // cold book (by price) still gives the best first, and the average per BALANCE rises as the slider goes right.
    const pager = listedPager({ order: 'value' });
    await pager.fill(POOL, 4);
    const range = q<HTMLInputElement>('bal-n')!;
    const btn = q<HTMLButtonElement>('bp-cred-buy');
    if (!pager.items.length) {
      q('bp-cred-sub')!.textContent = 'No Credits for sale';
      range.disabled = true;
      if (btn) btn.disabled = true;
      return;
    }
    const [sc, bps] = await Promise.all([scores(pager.items.map((l) => BigInt(l.id))), sweepFee()]);
    const perEth = (l: Listed) => (sc.get(l.id) ?? 0) / (Number(BigInt(l.price)) / 1e18);
    const items = pager.items
      .filter((l) => (sc.get(l.id) ?? 0) > 0)
      .sort((a, b) => perEth(b) - perEth(a))
      .slice(0, MAX_SWEEP);
    setRange(range, Math.min(DEFAULT_N, items.length), items.length);
    const pick = () => {
      const n = Number(range.value);
      const picked = items.slice(0, n);
      const rating = ratingTotal(picked.map((l) => sc.get(l.id) ?? 0));
      const sum = picked.reduce((t, l) => t + BigInt(l.price), 0n);
      const cost = sum + (sum * bps) / 10_000n;
      vals.cred = rating ? Number(cost) / 1e18 / rating : null;
      deal.cred = { cost, get: rating, what: `Best rating per ETH first, ${Number(bps) / 100}% fee in. 80 make a Statement.` };
      if (btn) btn.textContent = `Buy ${n} Credit${n === 1 ? '' : 's'}`;
      paint();
      return picked;
    };
    range.addEventListener('input', () => {
      setRange(range);
      pick();
    });
    if (btn) btn.addEventListener('click', () => void buyCredits(btn, pick()));
    pick();
  })();
  /// One sweep of what the slider picked, to the wallet.
  const buyCredits = async (btn: HTMLButtonElement, picked: Listed[]) => {
    const label = btn.textContent;
    const ids = await sweepToWallet(picked, btn);
    btn.disabled = false;
    btn.textContent = label;
    if (ids?.length) toast(`${ids.length} Credit${ids.length === 1 ? ' is' : 's are'} in your wallet. Pool them into a Statement from Make.`, 'ok', 8000);
  };

  const history = (async () => {
    const r = await fetch('/market/balance.json');
    const d = (await r.json()) as { points?: Point[] };
    draw = () => chart(q('bal-chart')!, d.points ?? [], vals.stmt, (v) => fmt(v));
    paint();
  })();
  await Promise.allSettled([rate, viaStatement, viaCredits, history]);
}

/// Price over time: the hourly record of the cheapest way in, as a line from the day the board went up, and
/// now. One axis, no numbers on every point: the latest is labelled, the rest on hover. Nothing until two points.
function chart(host: HTMLElement, points: Point[], now: number | null, fmt: (ethPer: number) => string) {
  const line = points.filter((p): p is [number, number, number | null] => p[1] !== null).map((p) => [p[0], p[1]] as [number, number]);
  if (now !== null) line.push([Math.floor(Date.now() / 1000), now]);
  const all = line;
  if (all.length < 2) {
    host.innerHTML = '';
    return;
  }
  const W = 1200, H = 240, L = 8, R = 8, T = 16, B = 28;
  const t0 = Math.min(...all.map((p) => p[0])), t1 = Math.max(...all.map((p) => p[0]));
  const v1 = Math.max(...all.map((p) => p[1])) * 1.1;
  const x = (t: number) => L + ((t - t0) / Math.max(1, t1 - t0)) * (W - L - R);
  const y = (v: number) => T + (1 - v / v1) * (H - T - B);
  const day = (t: number) => new Date(t * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const path = line.length > 1 ? `<path class="bal-line" d="${line.map((p, i) => `${i ? 'L' : 'M'}${x(p[0]).toFixed(1)} ${y(p[1]).toFixed(1)}`).join(' ')}"/>` : '';
  const grid = [0.5, 1].map((k) => `<line class="bal-grid" x1="${L}" x2="${W - R}" y1="${y((v1 * k) / 1.1).toFixed(1)}" y2="${y((v1 * k) / 1.1).toFixed(1)}"/><text class="bal-axis" x="${L}" y="${(y((v1 * k) / 1.1) - 6).toFixed(1)}">${fmt((v1 * k) / 1.1)}</text>`).join('');
  const marks = line.map((p) => `<circle class="bal-hit" cx="${x(p[0]).toFixed(1)}" cy="${y(p[1]).toFixed(1)}" r="8"><title>${day(p[0])} · ${fmt(p[1])}</title></circle>`).join('');
  const latest = line[line.length - 1];
  const nowMark = latest ? `<circle class="bal-now" cx="${x(latest[0]).toFixed(1)}" cy="${y(latest[1]).toFixed(1)}" r="4"/><text class="bal-label" x="${(x(latest[0]) - 8).toFixed(1)}" y="${(y(latest[1]) - 10).toFixed(1)}" text-anchor="end">${fmt(latest[1])} now</text>` : '';
  host.innerHTML = `
    <div class="bal-chart-head"><span class="muted small">Price over time</span><span class="muted small">The cheapest way in, every hour</span></div>
    <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Price over time">${grid}${path}${marks}${nowMark}
      <text class="bal-axis" x="${L}" y="${H - 8}">${day(t0)}</text><text class="bal-axis" x="${W - R}" y="${H - 8}" text-anchor="end">${day(t1)}</text>
    </svg>`;
}
