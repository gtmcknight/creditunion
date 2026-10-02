import type { Listed } from '../data';
import { listBatches } from '../data';
import { bin } from '../bins';
import { rangeStrip, stripHTML } from './range';
import { buyGrid, buyRow, creditsHead, pct, unionsLink } from './trait';

const PAGE = 120; // Credits per Show more
const n = (x: number) => x.toLocaleString();
const plural = (x: number) => `${n(x)} ${x === 1 ? 'Credit' : 'Credits'}`;

/// A page over one number every Credit has (/rating, /bits): its histogram with two handles, Min and Max typed,
/// a few quick picks, and below, the open Credit Unions whose rule overlaps the window and the Credits in it.
/// Values are whole units 0..M-1 of the page's scale; `val[id - 1]` is each Credit's.
type Spec = {
  kind: 'rating' | 'bits';
  title: string;
  step: string; // the inputs' step
  val: Uint16Array; // unit per Credit, index id - 1
  M: number;
  big: number; // units per Shift+arrow
  bars: number;
  best: 'high' | 'id'; // Credits tab order: highest value first, or Credit number
  show: (u: number) => string; // a unit as typed ("443.1", "96")
  read: (s: string) => number | null; // typed back to a unit
  readout: (a: number, b: number, count: number) => string;
  picks: [string, string, () => [number, number]][];
  pick0: string; // the default window, by pick key
  href: (a: number, b: number) => string; // the Start button
  note: string;
  overlaps: (l: Listed, a: number, b: number) => boolean;
  rules: (a: number, b: number) => Record<string, number>; // the window as edition rules, for its listings
  unionsQuery: (a: number, b: number) => string; // /unions?… for the Credit Unions that take it
  buy: (a: number, b: number) => string; // the Buy heading
  line: (id: number) => string; // the third line under each Credit: its value on this page
};

async function scalePage(app: HTMLElement, s: Spec) {
  const { M, val } = s;
  const counts = new Uint32Array(M);
  for (const u of val) counts[u]++;
  // Credits in the order the Credits tab lists them; with `high`, a window is one run of this list.
  const order = Uint32Array.from({ length: val.length }, (_, i) => i + 1);
  if (s.best === 'high') order.sort((x, y) => val[y - 1] - val[x - 1] || x - y);
  const above = new Uint32Array(M + 1); // above[u]: Credits with a value over u - 1
  for (let u = M - 1; u >= 0; u--) above[u] = above[u + 1] + counts[u];
  const count = (a: number, b: number) => above[a] - above[b + 1];

  const PICKS = Object.fromEntries(s.picks.map(([k, , f]) => [k, f()]));
  let [a, b] = PICKS[s.pick0];
  const q = new URLSearchParams(location.search);
  const qa = q.has('min') ? s.read(q.get('min')!) : null, qb = q.has('max') ? s.read(q.get('max')!) : null;
  if (qa !== null || qb !== null) [a, b] = [qa ?? 0, qb ?? M - 1].sort((x, y) => x - y);
  const clamp = (u: number) => Math.max(0, Math.min(M - 1, u));
  a = clamp(a);
  b = clamp(b);

  app.innerHTML = `
  <section class="trait-page time-page scale-page jb">
    ${creditsHead(s.kind)}
    <p class="jb-line num"><b id="scale-readout">&nbsp;</b><a class="jb-link" id="scale-start" href="/create">Start a Credit Union for them</a><a class="jb-link" id="jb-unions" hidden></a></p>
    ${stripHTML('Min', 'Max')}
    <div class="time-controls">
      <div class="win-inputs scale-inputs"><label><span>Min</span><input type="number" inputmode="decimal" id="scale-min" step="${s.step}" min="${s.show(0)}" max="${s.show(M - 1)}"></label><label><span>Max</span><input type="number" inputmode="decimal" id="scale-max" step="${s.step}" min="${s.show(0)}" max="${s.show(M - 1)}"></label></div>
      <div class="win-presets">${s.picks.map(([k, l]) => `<button type="button" data-pick="${k}">${l}</button>`).join('')}</div>
    </div>
    ${buyRow('Buy these Credits')}
  </section>`;

  const readout = document.getElementById('scale-readout')!;
  const start = document.getElementById('scale-start') as HTMLAnchorElement;
  const minIn = document.getElementById('scale-min') as HTMLInputElement;
  const maxIn = document.getElementById('scale-max') as HTMLInputElement;
  const picks = app.querySelector<HTMLElement>('.win-presets')!;

  const strip = rangeStrip(app.querySelector<HTMLElement>('.time-strip')!, {
    counts,
    a,
    b,
    big: s.big,
    bars: s.bars,
    text: (u) => s.show(u),
    onChange: (na, nb) => {
      a = na;
      b = nb;
      update();
    },
  });
  minIn.addEventListener('change', () => {
    const u = s.read(minIn.value);
    if (u !== null) {
      a = clamp(u);
      if (a > b) b = a;
    }
    update(true);
  });
  maxIn.addEventListener('change', () => {
    const u = s.read(maxIn.value);
    if (u !== null) {
      b = clamp(u);
      if (b < a) a = b;
    }
    update(true);
  });
  picks.addEventListener('click', (ev) => {
    const btn = (ev.target as HTMLElement).closest<HTMLButtonElement>('[data-pick]');
    if (!btn) return;
    [a, b] = PICKS[btn.dataset.pick!];
    update(true);
  });

  // ---- the Credits in the window, PAGE at a time
  const unions = listBatches();
  unions.catch(() => {});
  // The Credits in the window: listed ones first, cheapest first, then the rest (highest first for Rating).
  let ids: Uint32Array = new Uint32Array(0);
  const grid = buyGrid(app, {}, async (page) => ({ ids: Array.from(ids.subarray(page * PAGE, (page + 1) * PAGE)), total: ids.length }), s.line);
  const settle = () => {
    if (!app.isConnected) return;
    history.replaceState(null, '', `/${s.kind}?min=${s.show(a)}&max=${s.show(b)}`);
    void unionsLink(app, (l) => s.overlaps(l, a, b), unions, s.unionsQuery(a, b));
    if (s.best === 'high') ids = order.slice(above[b + 1], above[a]);
    else {
      const out: number[] = [];
      for (let i = 0; i < val.length; i++) if (val[i] >= a && val[i] <= b) out.push(i + 1);
      ids = Uint32Array.from(out);
    }
    app.querySelector('.jb-buy')!.textContent = s.buy(a, b);
    void grid.start({ rules: s.rules(a, b) });
  };
  let timer = 0;
  function update(now = false) {
    strip.set(a, b);
    const c = count(a, b);
    readout.innerHTML = s.readout(a, b, c);
    start.href = s.href(a, b);
    if (document.activeElement !== minIn) minIn.value = s.show(a);
    if (document.activeElement !== maxIn) maxIn.value = s.show(b);
    picks.querySelectorAll<HTMLButtonElement>('[data-pick]').forEach((p) => {
      const [pa, pb] = PICKS[p.dataset.pick!];
      p.setAttribute('aria-pressed', String(pa === a && pb === b));
    });
    clearTimeout(timer);
    if (now) settle();
    else timer = window.setTimeout(settle, 250);
  }
  update(true);
  const host = app.querySelector<HTMLElement>('.time-strip')!;
  new ResizeObserver(() => host.isConnected && strip.resize()).observe(host);
}


const failed = (app: HTMLElement, title: string) => {
  app.innerHTML = `<section class="prose"><h1>${title}</h1><p class="error">Couldn’t load the edition.</p></section>`;
};

/// Distinct ratings in the edition, low to high: the exact score (for display, as Credit pages show it), how many
/// Credits share it, and its rank. From public/credit-score.bin (the Statements contract's scores), as
/// worker/ratings.ts reads it; `unit` is its tenths above 80.0, rounded down.
type Levels = { score: Float64Array; cnt: Uint32Array; rank: Uint32Array; unit: Uint16Array };
function levelsOf(buf: ArrayBuffer): Levels {
  const all = new Uint32Array(buf).slice().sort();
  const N = all.length;
  const at: number[] = [];
  for (let i = 0; i < N; i++) if (i === 0 || all[i] !== all[i - 1]) at.push(i);
  const k = at.length;
  const score = new Float64Array(k), cnt = new Uint32Array(k), rank = new Uint32Array(k), unit = new Uint16Array(k);
  for (let j = 0; j < k; j++) {
    cnt[j] = (j + 1 < k ? at[j + 1] : N) - at[j];
    score[j] = all[at[j]] / 10_000;
    rank[j] = N - at[j] - cnt[j] + 1;
    unit[j] = Math.floor(all[at[j]] / 1000) - 800;
  }
  return { score, cnt, rank, unit };
}
const fmtScore = (x: number) => (Math.floor(x * 100) / 100).toFixed(2); // as Credit pages show it

/// /rating?min=&max=: Jack's rating, 80 to 800, as the Statements contract scores it. Units are tenths of a point,
/// rounded down, as LiveRatings hands them to a Credit Union's Rating rule.
export async function ratingPage(app: HTMLElement) {
  app.innerHTML = `<section class="trait-page time-page jb">${creditsHead('rating')}<p class="muted">Loading…</p></section>`;
  let raw: ArrayBuffer, ed: ArrayBuffer;
  try {
    [raw, ed] = await Promise.all([bin('scores-live.bin'), bin('credit-score.bin')]);
  } catch {
    return failed(app, 'Rating');
  }
  if (!app.isConnected) return;
  const tenths = new Uint16Array(raw);
  const val = Uint16Array.from(tenths, (t) => Math.max(0, t - 800));
  const L = levelsOf(ed);
  const exact = new Uint32Array(ed);
  const M = 7201; // 80.0 … 800.0
  const top = (k: number): [number, number] => {
    const sorted = Uint16Array.from(val).sort();
    return [sorted[Math.max(0, sorted.length - k)], M - 1];
  };
  const first = (u: number) => {
    let lo = 0, hi = L.unit.length;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (L.unit[m] < u) lo = m + 1;
      else hi = m;
    }
    return lo;
  };
  const SUPPLY = val.length;
  await scalePage(app, {
    kind: 'rating',
    title: 'Rating',
    step: '0.1',
    val,
    M,
    big: 100,
    bars: 180,
    best: 'high',
    show: (u) => ((u + 800) / 10).toFixed(1),
    read: (x) => (x.trim() && Number.isFinite(Number(x)) ? Math.round(Number(x) * 10) - 800 : null),
    readout: (a, b, c) => {
      if (!c) return `No Credit rated ${((a + 800) / 10).toFixed(1)} to ${((b + 800) / 10).toFixed(1)}`;
      const lo = first(a), hi = first(b + 1) - 1; // the lowest and highest ratings in the window
      if (lo === hi) return `<strong>${plural(c)}</strong> rated ${fmtScore(L.score[lo])} · ${pct(c)} · rank ${n(L.rank[lo])}`;
      return `<strong>${plural(c)}</strong> rated ${fmtScore(L.score[lo])} to ${fmtScore(L.score[hi])} · ${pct(c)} · ranks ${n(L.rank[hi])} to ${n(L.rank[lo])}`;
    },
    picks: [
      ['100', 'Top 100', () => top(100)],
      ['1', 'Top 1%', () => top(Math.round(SUPPLY / 100))],
      ['10', 'Top 10%', () => top(Math.round(SUPPLY / 10))],
    ],
    pick0: '1',
    href: (a, b) => `/create?minRating=${((a + 800) / 10).toFixed(1)}&maxRating=${((b + 800) / 10).toFixed(1)}`,
    note: 'Any without a Rating rule, or with one that overlaps this range.',
    overlaps: ({ s: { filter: f } }, a, b) => (!f.minScore && !f.maxScore) || ((f.minScore || 0) <= b + 800 && (f.maxScore || Infinity) >= a + 800),
    rules: (a, b) => ({ minScore: a + 800, maxScore: b + 800 }),
    buy: (a, b) => `Buy Credits rated ${((a + 800) / 10).toFixed(1)} to ${((b + 800) / 10).toFixed(1)}`,
    unionsQuery: (a, b) => `minScore=${a + 800}&maxScore=${b + 800}`,
    line: (id) => (exact[id - 1] ? `Rating ${fmtScore(exact[id - 1] / 10_000)}` : ''),
  });
}

/// /bits?min=&max=: how many marks a Credit's active plates set (Jack's Bits), as the Bits rule counts them.
export async function bitsPage(app: HTMLElement) {
  app.innerHTML = `<section class="trait-page time-page jb">${creditsHead('bits')}<p class="muted">Loading…</p></section>`;
  let raw: ArrayBuffer;
  try {
    raw = await bin('bits.bin');
  } catch {
    return failed(app, 'Bits');
  }
  if (!app.isConnected) return;
  const bits = new Uint16Array(raw);
  let lo = 256, hi = 0;
  for (const x of bits) (lo = Math.min(lo, x)), (hi = Math.max(hi, x));
  const val = Uint16Array.from(bits, (x) => x - lo);
  const M = hi - lo + 1;
  const sorted = Uint16Array.from(val).sort();
  const k = Math.round(val.length / 100);
  await scalePage(app, {
    kind: 'bits',
    title: 'Bits',
    step: '1',
    val,
    M,
    big: 10,
    bars: M,
    best: 'id',
    show: (u) => String(u + lo),
    read: (x) => (x.trim() && Number.isFinite(Number(x)) ? Math.round(Number(x)) - lo : null),
    readout: (a, b, c) => {
      if (!c) return `No Credit with ${a + lo} to ${b + lo} Bits`;
      return a === b ? `<strong>${plural(c)}</strong> with ${a + lo} Bits · ${pct(c)}` : `<strong>${plural(c)}</strong> with ${a + lo} to ${b + lo} Bits · ${pct(c)}`;
    },
    picks: [
      ['fewest', 'Fewest', () => [0, sorted[k - 1]]],
      ['most', 'Most', () => [sorted[sorted.length - k], M - 1]],
    ],
    pick0: 'fewest',
    href: (a, b) => `/create?minBits=${a + lo}&maxBits=${b + lo}`,
    line: (id) => `Bits ${val[id - 1] + lo}`,
    note: 'Any without a Bits rule, or with one that overlaps this range.',
    overlaps: ({ s: { filter: f } }, a, b) => {
      const from = f.bitsFrom || 0, to = f.bitsTo || 0;
      return (!from && !to) || (from <= b + lo && (to || Infinity) >= a + lo);
    },
    rules: (a, b) => ({ bitsFrom: a + lo, bitsTo: b + lo }),
    buy: (a, b) => `Buy Credits with ${a + lo} to ${b + lo} Bits`,
    unionsQuery: (a, b) => `bitsFrom=${a + lo}&bitsTo=${b + lo}`,
  });
}
