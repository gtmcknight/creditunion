import { dice, printGlyph, swatch, weightGlyph } from '../glyphs';
import { drawForSale } from '../forsale';
import facts from 'virtual:credits-facts';
import { loadTimes, mintSpan, paidAtOrAfter, PAL32, printsFor, tile, type Mint, type Prints, WALL_BLOCK } from '../wall';
import { creditsHead, pct } from './trait';

const SUPPLY = 122_154;
const PRINTS = ['Registered', 'Nudge', 'Slip', 'Skew', 'Drift', 'Loose'];
const WEIGHTS = ['even', 'lean', 'sparse', 'extreme'];
const n = (x: number) => x.toLocaleString();

/// Everything the tiles show, counted at build from the edition files (scripts/bins.mjs; the same table
/// /edition/match reads), so the tiles draw with the page and read no data file.
export type Facts = {
  n: number; // Credits in the edition
  palette: [string, number][]; // mask letters, count
  eights: number[]; // Credits with 0..5 eights
  print: number[];
  weight: number[];
  perHour: number[];
  hours: number;
  busiest: number; // payments in the busiest minute
  rating: number[]; // per ten points, 80..800
  top1: number; // tenths: the lowest rating in the top 1%
  ratingCurve: number[]; // tenths: the rating at each 0.5% of rank, lowest first (201 points)
  bitsByInks: number[]; // the median Bits of 1-, 2-, 3- and 4-ink Credits
  bits: number[]; // per Bit, lo..hi
  bitsLo: number;
  bitsHi: number;
};

/// Rating as a ruler from the lowest to the highest: ratings spread evenly by rank, so the story is where the marks
/// fall. Ticks at the middle Credit, the top 10% and the top 1%, the stretch above the top 1% in full ink.
function ratingCurve(f: Facts) {
  const c = f.ratingCurve, lo = c[0], hi = c[c.length - 1];
  const at = (v: number) => (((v - lo) / Math.max(1, hi - lo)) * 100).toFixed(2);
  const marks: [number, string][] = [
    [c[100], 'Middle'],
    [c[180], 'Top 10%'],
    [c[198], 'Top 1%'],
  ];
  return `<div class="cr-ruler">
    <i class="cr-ruler-track"></i><i class="cr-ruler-top" style="left:${at(c[198])}%"></i>
    ${marks.map(([v, l], i) => `<span class="cr-ruler-mark${i === marks.length - 1 ? ' last' : ''}" style="left:${at(v)}%"><b class="num">${(v / 10).toFixed(0)}</b>${l}</span>`).join('')}
    <span class="cr-ruler-end num" style="left:0">${(lo / 10).toFixed(0)}</span><span class="cr-ruler-end num" style="left:100%">${(hi / 10).toFixed(0)}</span>
  </div>`;
}

/// Bits as a histogram with each hump named by its ink count (1 ink, 2 inks…), under its peak.
function bitsHumps(f: Facts) {
  const N = f.bits.length;
  const labels = f.bitsByInks
    .map((b, i) => `<span class="cr-hump" style="left:${(((b - f.bitsLo + 0.5) / N) * 100).toFixed(2)}%">${i + 1} ink${i ? 's' : ''}</span>`)
    .join('');
  return `<div class="cr-humps">${bars(f.bits)}${labels}</div>`;
}

/// A histogram as one SVG path, drawn in the text color; `hot(i)` bars in full ink, the rest faint.
function bars(counts: ArrayLike<number>, hot: (i: number) => boolean = () => true, sqrt = false) {
  const N = counts.length, H = 64;
  let peak = 1;
  for (let i = 0; i < N; i++) peak = Math.max(peak, counts[i]);
  const gap = N <= 40 ? 0.25 : 0;
  const path = (want: boolean) => {
    let d = '';
    for (let i = 0; i < N; i++) {
      if (!counts[i] || hot(i) !== want) continue;
      const f = counts[i] / peak;
      const h = Math.max(0.8, (sqrt ? Math.sqrt(f) : f) * H);
      d += `M${i} ${H}h${1 - gap}v${-h.toFixed(2)}h${-(1 - gap)}z`;
    }
    return d;
  };
  return `<svg class="cr-hist" viewBox="0 0 ${N} ${H}" preserveAspectRatio="none" aria-hidden="true"><path class="cold" d="${path(false)}"/><path d="${path(true)}"/></svg>`;
}

/// Each value as a column: its share, a bar to scale, and its glyph under it.
const columns = (vals: { glyph: string; count: number; cls?: string }[], total: number, labels = true) => {
  const peak = Math.max(1, ...vals.map((v) => v.count));
  return `<div class="cr-cols${labels ? '' : ' bare'}">${vals
    .map(
      (v) => `<div class="cr-col">${labels ? `<span class="num">${pct((v.count / total) * SUPPLY)}</span>` : ''}<i class="cr-bar" style="--f:${(v.count / peak).toFixed(4)}"></i>${v.glyph ? `<span class="cr-glyph ${v.cls ?? ''}">${v.glyph}</span>` : ''}</div>`,
    )
    .join('')}</div>`;
};

type Tile = { kind: string; name: string; wide?: boolean; half?: boolean; draw: (f: Facts, total: number) => [string, string] };
const TILES: Tile[] = [
  {
    kind: 'palette',
    name: 'Palette',
    wide: true,
    draw: (f, total) => {
      const shares = f.palette.map(([, c]) => c / total);
      const avg = shares.reduce((s, x) => s + x, 0) / shares.length;
      // The 15 palettes split almost evenly, so every bar is the same height; each one's count is in its tooltip.
      const cols = `<div class="cr-cols bare palette">${f.palette
        .map(([p, c]) => `<div class="cr-col" title="${p} · ${n(c)}"><i class="cr-bar swatch" style="--f:1">${swatch(p)}</i><span class="cr-letters">${p}</span></div>`)
        .join('')}</div>`;
      return [cols, `${f.palette.length} palettes, about ${(avg * 100).toFixed(1)}% each`];
    },
  },
  {
    kind: 'eights',
    name: 'Eights',
    draw: (f, total) => {
      const top = f.eights.reduce((m, c, i) => (c ? i : m), 0);
      const most = f.eights[top];
      return [
        columns(f.eights.map((c, i) => ({ glyph: dice(i), count: c, cls: 'die' })), total),
        `${Math.round((f.eights[0] / total) * 100)}% have no eights · ${most === 1 ? 'one Credit has' : `${n(most)} Credits have`} ${top}×8`,
      ];
    },
  },
  {
    kind: 'print',
    name: 'Print',
    half: true,
    draw: (f, total) => [
      columns(f.print.map((c, i) => ({ glyph: printGlyph(PRINTS[i]), count: c })), total),
      `${Math.round((f.print[0] / total) * 100)}% Registered · ${n(f.print[5])} Loose`,
    ],
  },
  {
    kind: 'weight',
    name: 'Weight',
    half: true,
    draw: (f, total) => [
      columns(f.weight.map((c, i) => ({ glyph: weightGlyph(WEIGHTS[i]), count: c })), total),
      `${Math.round((f.weight[0] / total) * 100)}% Even · ${n(f.weight[3])} Extreme`,
    ],
  },
  {
    kind: 'rating',
    name: 'Rating',
    half: true,
    draw: (f) => [ratingCurve(f), `Top 1% from ${(f.top1 / 10).toFixed(1)}`],
  },
  {
    kind: 'bits',
    name: 'Bits',
    half: true,
    draw: (f) => [bitsHumps(f), `${f.bitsLo} to ${f.bitsHi} Bits · each hump is an ink count`],
  },
];

/// /credits: the whole edition at a glance. The mint drifting past as one strip, then a tile per trait, each
/// with its distribution and one fact, linking to that trait's index.
export async function creditsPage(app: HTMLElement) {
  app.innerHTML = `
  <section class="trait-page credits-page jb">
    ${creditsHead('credits')}
    <section class="cr-buy cr-box" id="for-sale">
      <div class="jb-controls static"><h2 class="jb-buy">Buy Credits</h2><div class="jb-sweep"><span class="skel-bar" style="width:220px"></span></div></div>
      <div class="trait-grid">${'<div class="cc skel"><span class="cc-art"></span><span class="cc-cap"><span class="skel-bar"></span></span></div>'.repeat(8)}</div>
      <p class="jb-line"><span class="skel-bar" style="width:260px"></span></p>
    </section>
    <div class="cr-box cr-strip-box">
      <div class="cr-strip-head">
        <h2><a href="/time">Time</a></h2>
        <span class="cr-now small muted num"></span>
        <button type="button" class="cr-play" aria-label="Pause" aria-pressed="true"><svg viewBox="0 0 16 16" aria-hidden="true"><path class="pause" d="M4 3h3v10H4zM9 3h3v10H9z"/><path class="play" d="M5 3l8 5-8 5z"/></svg></button>
      </div>
      <div class="cr-strip">
        <canvas aria-hidden="true"></canvas>
        <svg class="cr-mint" viewBox="0 0 1 1" preserveAspectRatio="none" aria-hidden="true"></svg>
        <div class="cr-scrub" aria-label="The whole mint. Tap or drag to jump."><i class="cr-head-line"></i></div>
      </div>
    </div>
    <div class="cr-tiles" id="cr-tiles">${TILES.map(
      (t) => `<a class="cr-tile${t.wide ? ' wide' : ''}${t.half ? ' half' : ''}" href="/${t.kind}" data-kind="${t.kind}">
        <h2>${t.name}</h2>
        <div class="cr-pic"></div>
        <p class="muted small cr-fact">&nbsp;</p>
      </a>`,
    ).join('')}</div>
  </section>`;

  void drawForSale(app.querySelector<HTMLElement>('#for-sale')!);
  for (const t of TILES) {
    const el = app.querySelector<HTMLElement>(`.cr-tile[data-kind="${t.kind}"]`)!;
    const [pic, fact] = t.draw(facts, facts.n);
    el.querySelector('.cr-pic')!.innerHTML = pic;
    el.querySelector('.cr-fact')!.textContent = fact;
  }

  // The strip after the tiles are up: payment times, then only the prints of the stretch it shows.
  await new Promise((r) => requestAnimationFrame(() => setTimeout(r)));
  const e = await loadTimes().catch(() => null);
  const strip = app.querySelector<HTMLElement>('.cr-strip');
  if (e && strip?.isConnected) drift(strip, e, printsFor(e.n));
}

/// The mint replayed across the strip: each second a column, its Credits stacked as they landed, each on its own
/// white square over a see-through ground; it drifts on at four mint seconds a second. Along the bottom, the whole
/// mint's payments per minute with a line where the strip is. Still under reduced motion; rests off screen.
function drift(host: HTMLElement, e: Mint, prints: Prints) {
  const cv = host.querySelector('canvas')!;
  const box = host.closest<HTMLElement>('.cr-strip-box')!;
  const nowEl = box.querySelector<HTMLElement>('.cr-now')!;
  const play = box.querySelector<HTMLButtonElement>('.cr-play')!;
  const line = host.querySelector<HTMLElement>('.cr-head-line')!;
  const span = mintSpan(e);
  const SPAN = Math.max(1, span.end - span.start);

  // The whole mint along the bottom: payments per minute, as one path.
  const M = Math.ceil(SPAN / 60) + 1;
  const perMin = new Uint16Array(M);
  for (let i = span.first; i < e.n; i++) perMin[Math.floor((e.times[i] - span.start) / 60)]++;
  // Drawn as one smooth area: a moving average over a quarter hour either side, so it reads as a shape, not bars.
  const R = 15;
  const smooth = new Float64Array(M);
  let run = 0;
  for (let m = 0; m < Math.min(M, R); m++) run += perMin[m];
  for (let m = 0; m < M; m++) {
    if (m + R < M) run += perMin[m + R];
    if (m - R - 1 >= 0) run -= perMin[m - R - 1];
    smooth[m] = run / (Math.min(M - 1, m + R) - Math.max(0, m - R) + 1);
  }
  const peak = Math.max(1e-9, ...smooth);
  const mint = host.querySelector('svg')!;
  mint.setAttribute('viewBox', `0 0 ${M} 1`);
  let d = `M0 1`;
  for (let m = 0; m < M; m++) d += `L${m + 0.5} ${(1 - Math.sqrt(smooth[m] / peak)).toFixed(4)}`;
  mint.innerHTML = `<path d="${d}L${M} 1Z"/>`;

  let img: ImageData | null = null, px: Uint32Array | null = null, W = 1, H = 1, dpr = 1;
  const size = () => {
    dpr = Math.min(2, devicePixelRatio);
    W = cv.width = Math.max(1, Math.round(cv.clientWidth * dpr));
    H = cv.height = Math.max(1, Math.round(cv.clientHeight * dpr));
    img = new ImageData(W, H);
    px = new Uint32Array(img.data.buffer);
  };
  const sec = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit' });
  let clock = span.start, shown = -1, loading = false;
  const frame = () => {
    if (!px) return;
    px.fill(0);
    const k = Math.max(1, Math.round(3 * dpr)); // device pixels per cell: a Credit about 24 CSS pixels
    const s = 8 * k, gap = Math.max(1, Math.round(dpr)), pitch = s + gap;
    const perSec = pitch + gap;
    const from = clock - W / perSec;
    const i0 = paidAtOrAfter(e, Math.floor(from));
    // The prints on screen, and half a block more before the strip gets there. Redraws once they land (a still
    // strip too); a failed read isn't retried every frame.
    const i1 = Math.min(e.n, paidAtOrAfter(e, Math.floor(clock) + 1) + WALL_BLOCK / 2);
    if (!loading && (!prints.has(i0) || !prints.has(i1 - 1))) {
      loading = true;
      prints.need(i0, i1).then(() => {
        loading = false;
        frame();
      }, () => {});
    }
    let col = -1, stack = 0;
    for (let i = i0; i < e.n && e.times[i] <= clock; i++) {
      const t = e.times[i];
      if (t !== col) (col = t), (stack = 0);
      const x = Math.round(W - (clock - t) * perSec) - s;
      const y = H - (stack + 1) * pitch + gap;
      stack++;
      // Off the left or right edge: skip. (A negative end index would make fill() paint from the far end of
      // the buffer, which flashed the whole strip white.)
      if (y < -s || x + s <= 0 || x >= W || !prints.has(i)) continue;
      for (let dy = 0; dy < s; dy++) if (y + dy >= 0 && y + dy < H) px.fill(PAL32[0], (y + dy) * W + Math.max(0, x), (y + dy) * W + Math.min(W, x + s));
      tile(px, W, H, prints.cells, i, x, y, k);
    }
    cv.getContext('2d')!.putImageData(img!, 0, 0);
    line.style.left = `${((clock - span.start) / SPAN) * 100}%`;
    const whole = Math.floor(clock);
    if (whole !== shown) {
      shown = whole;
      nowEl.textContent = sec.format(new Date(whole * 1000));
    }
  };

  // Open at this time of day in the mint: now's clock time (local), counted from the mint's first day.
  const dayOf = (t: number) => {
    const d = new Date(t * 1000);
    return d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds();
  };
  clock = span.start + ((dayOf(Date.now() / 1000) - dayOf(span.start) + 86400) % 86400);
  if (clock > span.end) clock = span.start;
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let visible = true, last = 0, playing = !still;
  const setPlaying = (on: boolean) => {
    playing = on;
    play.setAttribute('aria-pressed', String(on));
    play.setAttribute('aria-label', on ? 'Pause' : 'Play');
  };
  setPlaying(playing);
  play.addEventListener('click', () => setPlaying(!playing));
  // The band along the bottom scrubs: press or drag to jump the strip to that moment; it plays on from there.
  const scrub = box.querySelector<HTMLElement>('.cr-scrub')!;
  const seek = (ev: PointerEvent) => {
    const r = scrub.getBoundingClientRect();
    clock = span.start + Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width)) * SPAN;
    frame();
  };
  scrub.addEventListener('pointerdown', (ev) => {
    scrub.setPointerCapture(ev.pointerId);
    seek(ev);
  });
  scrub.addEventListener('pointermove', (ev) => scrub.hasPointerCapture(ev.pointerId) && seek(ev));
  const tick = (now: number) => {
    if (!cv.isConnected) return;
    if (visible && last && playing) {
      clock += Math.min(0.1, (now - last) / 1000) * 4;
      if (clock > span.end + 30) clock = span.start;
      frame();
    }
    last = now;
    requestAnimationFrame(tick);
  };
  size();
  frame();
  requestAnimationFrame(tick);
  new IntersectionObserver(([x]) => (visible = x.isIntersecting)).observe(cv);
  new ResizeObserver(() => {
    if (!cv.isConnected) return;
    size();
    frame();
  }).observe(cv);
}
