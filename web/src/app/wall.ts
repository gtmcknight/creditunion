/// The whole edition as one picture: every Credit's 8×8 print. Five views:
///   Time     payment order. Credits paid in the same second share inks (the second picks the plates,
///            cycling every 15 seconds), so the wall comes out striped.
///   Color    grouped by their inks (Jack's Colors trait), then by payment.
///   Density  from fewest marks to most (Jack's Bits trait).
///   Stream   the mint replayed: each second of payments a column, stacked as they landed.
///   One by one  one Credit at a time, large, with its number, second, inks and bits.
/// A living band on the About page; Expand grows whatever view is on to the full window.
/// Data: public/wall.bin (scripts/wall.ts: 32 bytes per Credit, a 4-bit CMYK mask per cell) and times.bin, plus
/// edition-traits.bin (palette) and bits.bin (scripts/wall.ts), read only once a view or caption needs them.
import { bin, fetchBin } from './bins';

/// Subtractive mixes as the contract's SVG draws them, indexed by the 4-bit CMYK mask (0 = paper).
const PALETTE = ['#ffffff', '#00b5e2', '#e4007c', '#00006e', '#ffd100', '#009400', '#e40000', '#000000', '#111111', '#000c0f', '#0f0008', '#000007', '#110e00', '#000a00', '#0f0000', '#000000'];
// RGBA packed little-endian for a Uint32 view of ImageData.
export const PAL32 = PALETTE.map((h) => (255 << 24) | (parseInt(h.slice(5, 7), 16) << 16) | (parseInt(h.slice(3, 5), 16) << 8) | parseInt(h.slice(1, 3), 16));
const LETTERS = 'CMYK';
const inks = (m: number) => [...LETTERS].filter((_, b) => m & (1 << b)).join('');

const PAUSE = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5 3v10M11 3v10" stroke="currentColor" stroke-width="2" stroke-linecap="square"/></svg>';
const PLAY = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 3v10l8-5z" fill="currentColor"/></svg>';

export type Mode = 'time' | 'color' | 'density' | 'stream' | 'one';
const MODES: [Mode, string][] = [['time', 'Time'], ['color', 'Color'], ['density', 'Density'], ['stream', 'Stream'], ['one', 'One by one']];
/// Icons on a 16-unit grid, built from squares like the Credits themselves. Color keeps its four inks.
const sq = (x: number, y: number, s = 3, fill = 'currentColor') => `<rect x="${x}" y="${y}" width="${s}" height="${s}" fill="${fill}"/>`;
const ICONS: Record<Mode, string> = {
  // payment order: the diagonal stripes the 15-second ink cycle draws
  time: sq(2, 2) + sq(6, 2) + sq(10, 6) + sq(2, 10) + sq(6, 6) + sq(10, 10) + sq(6, 10, 3, 'none') + sq(2, 6, 3, 'none'),
  // the four plates
  color: sq(2, 2, 5, '#00b5e2') + sq(9, 2, 5, '#e4007c') + sq(2, 9, 5, '#ffd100') + sq(9, 9, 5, '#111'),
  // fewest marks to most
  density: sq(2, 11) + sq(6.5, 11) + sq(6.5, 6.5) + sq(11, 11) + sq(11, 6.5) + sq(11, 2),
  // each second a column, stacked as they landed
  stream: sq(1.5, 10.5) + sq(5, 7) + sq(5, 10.5) + sq(8.5, 3.5) + sq(8.5, 7) + sq(8.5, 10.5) + sq(12, 10.5),
  // one Credit, large
  one: `<rect x="3" y="3" width="10" height="10" fill="none" stroke="currentColor" stroke-width="1.5"/>` + sq(5.5, 5.5, 2.5) + sq(8, 8, 2.5),
};

/// What every view reads: the prints and payment times. Palette and Bits load only for the views that show them.
export type Edition = { cells: Uint8Array; times: Uint32Array; n: number; palette: Uint8Array | null; bits: Uint16Array | null };
/// Payment times alone: all the mint's clock needs (index order is payment order).
export type Mint = { times: Uint32Array; n: number };

/// wall.bin whole, once it's in (so views that draw a stretch of the mint needn't ask for blocks).
let fullCells: Uint8Array | null = null;
export const loadCells = () => bin('wall.bin').then((b) => (fullCells = new Uint8Array(b)));
export const loadTimes = () => bin('times.bin').then((b): Mint => { const times = new Uint32Array(b); return { times, n: times.length }; });
let palette: Promise<Uint8Array> | null = null;
export const loadPalette = () =>
  (palette ??= bin('edition-traits.bin').then((b) => {
    const traits = new Uint32Array(b);
    const p = new Uint8Array(traits.length);
    for (let i = 0; i < traits.length; i++) p[i] = traits[i] & 15; // same packing as worker/match.ts
    return p;
  })).catch((e) => {
    palette = null;
    throw e;
  });
export const loadBits = () => bin('bits.bin').then((b) => new Uint16Array(b));

let edition: Promise<Edition> | null = null;
export const loadEdition = () =>
  (edition ??= Promise.all([loadCells(), loadTimes()]).then(([cells, { times }]) => ({ cells, times, n: cells.length / 32, palette: null, bits: null })));

/// The prints a block at a time (wall/<k>.bin, WALL_BLOCK Credits each, cut at build by scripts/bins.mjs), for views
/// that draw only a stretch of the mint. `cells` has wall.bin's layout and fills in as blocks land; `has(i)` says
/// whether Credit index i's print is in; `need(i0, i1)` loads the blocks covering i0..i1-1.
export const WALL_BLOCK = 4096;
export type Prints = { cells: Uint8Array; has: (i: number) => boolean; need: (i0: number, i1: number) => Promise<void> };
let prints: Prints | null = null;
export function printsFor(n: number): Prints {
  if (prints) return prints;
  const got = new Uint8Array(Math.ceil(n / WALL_BLOCK));
  const pending = new Map<number, Promise<void>>();
  const p: Prints = {
    cells: new Uint8Array(n * 32),
    has: (i) => got[Math.floor(i / WALL_BLOCK)] === 1,
    need: (i0, i1) => {
      if (fullCells && p.cells !== fullCells) {
        p.cells = fullCells;
        got.fill(1);
      }
      const wait: Promise<void>[] = [];
      for (let k = Math.max(0, Math.floor(i0 / WALL_BLOCK)); i1 > i0 && k <= Math.min(got.length - 1, Math.floor((i1 - 1) / WALL_BLOCK)); k++) {
        if (got[k]) continue;
        let q = pending.get(k);
        if (!q) {
          q = fetchBin(`wall/${k}.bin`, 'wall.bin')
            .then((b) => {
              p.cells.set(new Uint8Array(b), k * WALL_BLOCK * 32);
              got[k] = 1;
            })
            .finally(() => pending.delete(k));
          pending.set(k, q);
        }
        wait.push(q);
      }
      return Promise.all(wait).then(() => {});
    },
  };
  return (prints = p);
}

/// Stream: index of the first Credit paid at or after a unix second (indexes are in payment order).
export function paidAtOrAfter(e: Mint, t: number) {
  let lo = 0, hi = e.n;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (e.times[mid] < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
/// The mint's first and last payment, skipping Jack's two early Credits, weeks before the mint.
export const mintSpan = (e: Mint) => ({ first: Math.min(2, e.n - 1), start: e.times[Math.min(2, e.n - 1)], end: e.times[e.n - 1] });

/// Slot → Credit index for each mode. Ties fall back to payment order, so every order is stable.
const orders = new Map<Mode, Uint32Array>();
function orderFor(e: Edition, mode: Mode) {
  let o = orders.get(mode);
  if (o) return o;
  const ids = Array.from({ length: e.n }, (_, i) => i);
  if (mode === 'color') ids.sort((a, b) => e.palette![a] - e.palette![b] || a - b);
  if (mode === 'density') ids.sort((a, b) => e.bits![a] - e.bits![b] || a - b);
  o = Uint32Array.from(ids);
  orders.set(mode, o);
  return o;
}

/// Draw one Credit at (x, y) in a Uint32 pixel buffer `w` wide, `k` pixels per cell.
export function tile(px: Uint32Array, w: number, h: number, cells: Uint8Array, id: number, x: number, y: number, k: number) {
  for (let cell = 0; cell < 64; cell++) {
    const byte = cells[id * 32 + (cell >> 1)];
    const m = cell & 1 ? byte >> 4 : byte & 15;
    if (!m) continue;
    const color = PAL32[m];
    const cx = x + (cell & 7) * k, cy = y + (cell >> 3) * k;
    for (let dy = 0; dy < k; dy++) {
      const yy = cy + dy;
      if (yy < 0 || yy >= h) continue;
      const row = yy * w;
      for (let dx = 0; dx < k; dx++) {
        const xx = cx + dx;
        if (xx >= 0 && xx < w) px[row + xx] = color;
      }
    }
  }
}

/// The About page band. Grid modes drift left to right, Credits running down each column, drawn crisp at
/// two device pixels per cell (Color gives each ink group its own horizontal stripe, so all fifteen read at
/// once). Stream replays the mint second by second; One by one holds each Credit large, then slides on.
/// The caption names what is passing. Hover pauses it; reduced motion keeps it still; off screen it rests.
/// Options: `label` overlays a headline (the About hero); `mode` starts on a view.
export async function mountWall(host: HTMLElement, { label = '', mode: start = 'time' as Mode } = {}) {
  host.innerHTML = `<figure class="wall-band">
    <div class="wall-frame" data-mode="${start}">
      <canvas aria-label="Every Credit"></canvas>
      ${label ? `<div class="wall-label">${label}</div>` : ''}
      <figcaption class="wall-caption small"><span class="num wall-now">–</span> <span class="muted wall-about"></span></figcaption>
      <div class="wall-card" hidden></div>
      <div class="wall-hover" hidden></div>
      <div class="wall-menu">
      <div class="wall-modes" role="radiogroup" aria-label="View">${MODES.map(([m, l], i) => `<button type="button" role="radio" data-mode="${m}" aria-checked="${m === start}" aria-label="${l}"><svg viewBox="0 0 16 16" aria-hidden="true">${ICONS[m]}</svg><span>${l}</span></button>`).join('')}<button type="button" role="radio" data-magic aria-checked="false" aria-label="Magic eye"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8 12.1 12.5 8 12.5 1.5 8 1.5 8z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><circle cx="8" cy="8" r="2" fill="currentColor"/></svg><span>Magic eye</span></button></div>
      <div class="wall-tools">
        <div class="wall-zoomrow"><span>Zoom</span><button type="button" class="wall-zoom" data-zoom="-1" aria-label="Zoom out"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8h9" stroke="currentColor" stroke-width="1.5" stroke-linecap="square"/></svg></button>
        <button type="button" class="wall-zoom" data-zoom="1" aria-label="Zoom in"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8h9M8 3.5v9" stroke="currentColor" stroke-width="1.5" stroke-linecap="square"/></svg></button></div>
        <button type="button" class="wall-pause" aria-label="Pause">${PAUSE}<span>Pause</span></button>
        <button type="button" class="wall-expand" aria-label="Explore every Credit, full screen"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M9.5 2.5h4v4M6.5 13.5h-4v-4M13.5 2.5 9 7M2.5 13.5 7 9" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg><span>Play</span></button>
      </div>
      </div>
    </div>
  </figure>`;
  const cv = host.querySelector('canvas')!;
  const e = await loadEdition().catch(() => null);
  if (!e || !cv.isConnected) return;

  const day = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const sec = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit' });
  const when = (id: number, withSeconds = false) => (withSeconds ? sec : day).format(new Date(e.times[id] * 1000));
  const nowEl = host.querySelector<HTMLElement>('.wall-now')!;
  const aboutEl = host.querySelector<HTMLElement>('.wall-about')!;
  const total = e.n.toLocaleString();
  const ABOUT: Record<Mode, string> = {
    time: `· ${total} Credits in payment order. Each second of the mint picked the inks.`,
    color: `· ${total} Credits, one stripe per ink combination.`,
    density: `· ${total} Credits from fewest marks to most.`,
    stream: '· the mint replayed: every second of payments is a column, stacked as they landed.',
    one: '· one Credit at a time.',
  };

  // Color: Credits of each palette, in payment order, one list per palette (1–15).
  const byPalette: number[][] = Array.from({ length: 16 }, () => []);
  let pals: number[] = [];
  /// Palette and Bits load the first time a view (or the paused hover card) shows them.
  const needs = (m: Mode | 'card') =>
    Promise.all([
      (m === 'color' || m === 'one' || m === 'card') && !pals.length
        ? loadPalette().then((p) => {
            if (pals.length) return;
            e.palette = p;
            for (let i = 0; i < e.n; i++) byPalette[p[i]].push(i);
            pals = byPalette.map((l, k) => [k, l] as const).filter(([, l]) => l.length).map(([k]) => k);
          })
        : null,
      (m === 'density' || m === 'one' || m === 'card') && !e.bits ? loadBits().then((b) => void (e.bits ??= b)) : null,
    ]);
  const atOrAfter = (t: number) => paidAtOrAfter(e, t);
  const { start: MINT_START, end: MINT_END } = mintSpan(e);
  const SPAN = Math.max(1, MINT_END - MINT_START);
  // Payments per minute across the mint, for the scrubber strip under Stream and One by one.
  const perMin = new Uint16Array(Math.ceil(SPAN / 60) + 1);
  for (let i = 2; i < e.n; i++) perMin[Math.floor((e.times[i] - MINT_START) / 60)]++;
  const peak = Math.max(1, ...perMin);
  /// The mint moment at the same local time of day as right now (the mint ran about a day).
  const nowInMint = () => {
    const d = new Date();
    const tod = d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds();
    const mid = new Date(MINT_START * 1000);
    mid.setHours(0, 0, 0, 0);
    let t = mid.getTime() / 1000 + tod;
    if (t < MINT_START) t += 86400;
    return Math.min(t, MINT_END);
  };

  let mode: Mode = 'time';
  let order = orderFor(e, 'time');
  let img: ImageData | null = null;
  let px: Uint32Array | null = null;
  let W = 1, H = 1;
  // Size from the frame, whose height CSS fixes, never from the canvas: a canvas without a CSS height takes
  // its height from its own pixel size, and resizing it to itself would feed back and grow without end.
  const box = host.querySelector<HTMLElement>('.wall-frame')!;
  let DPR = devicePixelRatio;
  const size = () => {
    // Cap the backing store near 2.5M pixels so a big hero or full screen still draws in a few ms.
    DPR = Math.min(devicePixelRatio, Math.sqrt(2.5e6 / Math.max(1, box.clientWidth * box.clientHeight)));
    const w = Math.min(8192, Math.max(1, Math.round(box.clientWidth * DPR)));
    const h = Math.min(4096, Math.max(1, Math.round(box.clientHeight * DPR)));
    if (img && w === W && h === H) return;
    W = cv.width = w;
    H = cv.height = h;
    img = new ImageData(W, H);
    px = new Uint32Array(img.data.buffer);
  };
  const flush = () => cv.getContext('2d')!.putImageData(img!, 0, 0);

  // ---- scrubber strip: the mint as a bar chart of payments per minute, with a playhead; drag to jump
  const stripH = () => Math.round(26 * DPR);
  const INK = 0xff000000 | (0x0a << 16) | (0x0a << 8) | 0x0a;
  const BAR = 0xff000000 | (0xb4 << 16) | (0xb0 << 8) | 0xae;
  const strip = (at: number) => {
    const h = stripH(), y0 = H - h;
    for (let x = 0; x < W; x++) {
      const m = Math.floor((x / W) * perMin.length);
      const bh = Math.round((perMin[m] / peak) * (h - 4));
      for (let y = H - bh; y < H; y++) px![y * W + x] = BAR;
    }
    const hx = Math.round(((at - MINT_START) / SPAN) * (W - 1));
    const lw = Math.max(1, Math.round(DPR));
    for (let y = y0; y < H; y++) for (let d = 0; d < lw * 2; d++) {
      const xx = hx - lw + d;
      if (xx >= 0 && xx < W) px![y * W + xx] = INK;
    }
  };
  // Every Credit drawn this frame, as (index, x, y, size) in canvas pixels, so a paused wall can say what's under
  // the pointer.
  const drawn: number[] = [];
  const put = (id: number, x: number, y: number, k: number) => {
    tile(px!, W, H, e.cells, id, x, y, k);
    if (x < W && y < H && x + 8 * k > 0 && y + 8 * k > 0) drawn.push(id, x, y, 8 * k);
  };
  const scrubbable = () => mode === 'stream' || mode === 'one';
  let scrubbing = false;
  const scrubTo = (clientX: number) => {
    const r = cv.getBoundingClientRect();
    const t = MINT_START + Math.max(0, Math.min(1, (clientX - r.left) / r.width)) * SPAN;
    clock = t;
    pos = atOrAfter(t);
    frame();
  };
  cv.addEventListener('pointerdown', (ev) => {
    if (!scrubbable()) return;
    const r = cv.getBoundingClientRect();
    if (ev.clientY < r.bottom - stripH() / DPR - 6) return;
    scrubbing = true;
    cv.setPointerCapture(ev.pointerId);
    scrubTo(ev.clientX);
  });
  cv.addEventListener('pointermove', (ev) => {
    if (scrubbing) scrubTo(ev.clientX);
    else if (scrubbable()) {
      const r = cv.getBoundingClientRect();
      cv.style.cursor = ev.clientY >= r.bottom - stripH() / DPR - 6 ? 'ew-resize' : '';
    }
  });
  const endScrub = () => (scrubbing = false);
  cv.addEventListener('pointerup', endScrub);
  cv.addEventListener('pointercancel', endScrub);

  // ---- grid modes: columns drift left; `off` counts columns scrolled
  // Zoom: device pixels per cell of a Credit in the grid views (Stream draws one step larger).
  let K = 6, T = 8 * K; // starts zoomed in: a Credit is 48 device pixels
  let off = 0;
  const grid = () => {
    // Always overfill: one more row than fits, centred and cut at both edges, so the wall bleeds to the frame.
    const rows = Math.max(1, Math.ceil(H / T));
    const top = Math.floor((H - rows * T) / 2);
    const first = Math.floor(off), shift = Math.round((off - first) * T);
    const vis = Math.ceil(W / T) + 1;
    let edge = 0;
    if (mode === 'color') {
      // Share every row out among the palettes, so the stripes always fill the band; each stripe scrolls
      // its own list, wrapping.
      const startOf = (k: number) => Math.round((k * rows) / pals.length);
      pals.forEach((p, k) => {
        const list = byPalette[p];
        const from = startOf(k), per = Math.max(0, startOf(k + 1) - from);
        for (let c = 0; c < vis; c++) for (let r = 0; r < per; r++) {
          const id = list[((first + c) * per + r) % list.length];
          put(id, c * T - shift, top + (from + r) * T, K);
        }
      });
      const per = Math.max(1, startOf(1));
      edge = byPalette[pals[0]][(first * per) % byPalette[pals[0]].length];
      nowEl.textContent = `${pals.length} ink combinations`;
    } else {
      const cols = Math.ceil(e.n / rows);
      for (let c = 0; c < vis; c++) {
        const col = (first + c) % cols;
        for (let r = 0; r < rows; r++) {
          const s = col * rows + r;
          if (s >= e.n) break;
          put(order[s], c * T - shift, top + r * T, K);
        }
      }
      edge = order[Math.min(e.n - 1, (first % cols) * rows)];
      nowEl.textContent = mode === 'time' ? `${when(edge)} · #${(edge + 1).toLocaleString()}` : `${e.bits![edge]} bits`;
    }
  };

  // ---- stream: x is time; a second's payments stack up from the baseline
  let S = K + 1; // device pixels per cell (Stream draws one step larger than the grid)
  let ST = 8 * S;
  let clock = 0; // unix seconds, fractional; set below
  const stream = () => {
    const perSec = ST + Math.round(2 * DPR); // one column per second, with a hairline gap
    const anchor = Math.round(W * 0.7);
    const from = clock - anchor / perSec, to = clock + (W - anchor) / perSec;
    const base = H - stripH() - Math.round(8 * DPR);
    let col = -1, stack = 0;
    for (let i = atOrAfter(Math.floor(from)); i < e.n && e.times[i] <= to; i++) {
      const t = e.times[i];
      if (t !== col) {
        col = t;
        stack = 0;
      }
      const y = base - (stack + 1) * (ST + 2);
      stack++;
      if (y < -ST) continue;
      put(i, Math.round(anchor + (t - clock) * perSec), y, S);
    }
    const i = Math.max(0, atOrAfter(Math.floor(clock)) - 1);
    strip(clock);
    nowEl.textContent = `${sec.format(new Date(Math.floor(clock) * 1000))} · ${(i + 1).toLocaleString()} paid`;
  };

  // ---- one by one: hold each Credit, then slide the next one in
  let pos = 2; // Credits advanced, fractional (from #3: the first two are Jack's own)
  const HOLD = 0.66; // share of each beat spent still
  const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  const one = () => {
    // Big in the band; in the full window, large but with room around it.
    const room = H - stripH();
    const k = Math.max(2, Math.floor(Math.min(room - Math.round(24 * DPR), Math.max(room * 0.6, 200 * DPR)) / 8));
    const size = 8 * k;
    const gap = Math.round(size * 0.35);
    const i = Math.floor(pos), frac = pos - i;
    const t = frac < HOLD ? 0 : ease((frac - HOLD) / (1 - HOLD));
    const cx = Math.round(W / 2 - size / 2 - t * (size + gap));
    const y = Math.round((room - size) / 2);
    for (let d = -3; d <= 3; d++) {
      const id = (i + d + e.n) % e.n;
      put(id, cx + d * (size + gap), y, k);
    }
    const cur = t < 0.5 ? i % e.n : (i + 1) % e.n;
    strip(e.times[cur]);
    nowEl.textContent = `#${(cur + 1).toLocaleString()} · ${when(cur, true)} · ${inks(e.palette![cur])} · ${e.bits![cur]} bits`;
  };

  const frame = () => {
    if (!px) return;
    px.fill(PAL32[0]);
    drawn.length = 0;
    if (mode === 'stream') stream();
    else if (mode === 'one') one();
    else grid();
    aboutEl.textContent = ABOUT[mode];
    flush();
  };

  let want: Mode = start; // the view last picked, which may still be loading
  const setMode = (m: Mode) => {
    mode = m;
    box.dataset.mode = m;
    if (m === 'time' || m === 'density') order = orderFor(e, m);
    off = 0;
    clock = nowInMint();
    pos = atOrAfter(clock);
  };
  host.querySelector('.wall-modes')!.addEventListener('click', (ev) => {
    const eye = (ev.target as HTMLElement).closest<HTMLButtonElement>('button[data-magic]');
    if (eye) {
      // The magic eye isn't a wall view: it lays its own stereogram over the frame.
      host.querySelectorAll('[data-mode], [data-magic]').forEach((x) => x.setAttribute('aria-checked', String(x === eye)));
      frameEl.dataset.eye = '';
      if (!unmagic) import('./magic').then((m) => (unmagic ??= m.mountMagic(frameEl)));
      return;
    }
    const b = (ev.target as HTMLElement).closest<HTMLButtonElement>('[data-mode]');
    if (!b) return;
    endMagic();
    const m = (want = b.dataset.mode as Mode);
    host.querySelectorAll('[data-mode], [data-magic]').forEach((x) => x.setAttribute('aria-checked', String(x === b)));
    needs(m)
      .then(() => {
        if (want !== m || !cv.isConnected) return; // another view was picked while this one loaded
        setMode(m);
        frame();
      })
      .catch(() => {});
  });
  // Expand grows the live band itself to the window, so whatever view is on keeps running, just bigger.
  const frameEl = host.querySelector<HTMLElement>('.wall-frame')!;
  let unmagic: (() => void) | null = null;
  const endMagic = () => {
    unmagic?.();
    unmagic = null;
    delete frameEl.dataset.eye;
  };
  const figure = host.querySelector<HTMLElement>('.wall-band')!;
  const btn = host.querySelector<HTMLButtonElement>('.wall-expand')!;
  const EXPAND = btn.innerHTML;
  const COLLAPSE = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M13.5 6.5h-4v-4M2.5 9.5h4v4M9.5 6.5 14 2M6.5 9.5 2 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg><span>Exit</span>';
  const clip = (r: DOMRect) => `inset(${r.top}px ${innerWidth - r.right}px ${innerHeight - r.bottom}px ${r.left}px round 0px)`;
  const reduce = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  let open = false;
  const onKey = (ev: KeyboardEvent) => ev.key === 'Escape' && toggle();
  const toggle = () => {
    if (!open) {
      const r = frameEl.getBoundingClientRect();
      figure.style.minHeight = `${figure.offsetHeight}px`; // hold the band's place while it's lifted out
      frameEl.classList.add('expanded');
      document.body.style.overflow = 'hidden';
      if (!reduce()) frameEl.animate([{ clipPath: clip(r) }, { clipPath: 'inset(0px 0px 0px 0px round 0px)' }], { duration: 420, easing: 'cubic-bezier(0.32, 0.72, 0, 1)' });
      btn.innerHTML = COLLAPSE;
      btn.setAttribute('aria-label', 'Back to the page');

      addEventListener('keydown', onKey);
    } else {
      const done = () => {
        if (unmagic) {
          endMagic();
          host.querySelectorAll<HTMLElement>('[data-mode], [data-magic]').forEach((x) => x.setAttribute('aria-checked', String(x.dataset.mode === mode)));
        }
        frameEl.classList.remove('expanded');
        figure.style.minHeight = '';
        document.body.style.overflow = '';
      };
      removeEventListener('keydown', onKey);
      btn.innerHTML = EXPAND;
      btn.setAttribute('aria-label', 'Explore every Credit, full screen');

      if (reduce()) done();
      else {
        // Shrink back onto where the band sits in the page: measure it in place, then animate there.
        frameEl.classList.remove('expanded');
        const to = frameEl.getBoundingClientRect();
        frameEl.classList.add('expanded');
        frameEl.animate([{ clipPath: 'inset(0px 0px 0px 0px round 0px)' }, { clipPath: clip(to) }], { duration: 320, easing: 'cubic-bezier(0.32, 0.72, 0, 1)' }).onfinish = done;
      }
    }
    open = !open;
  };
  btn.addEventListener('click', toggle);

  if (!(await needs(start).then(() => true, () => false)) || !cv.isConnected) return;
  setMode(start);
  size();
  frame();
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let playing = !still, visible = true, last = 0;
  const tick = (now: number) => {
    if (!cv.isConnected) return;
    if (playing && visible && !scrubbing && last) {
      const dt = Math.min(0.1, (now - last) / 1000);
      if (mode === 'stream') {
        clock += dt * 4; // four seconds of the mint per second
        if (clock > e.times[e.n - 1]) clock = MINT_START;
      } else if (mode === 'one') pos = (pos + dt * 0.8) % e.n;
      else off += dt * 1.2; // columns per second: a slow drift
      frame();
    }
    last = now;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  const pauseBtn = host.querySelector<HTMLButtonElement>('.wall-pause')!;
  const setPlaying = (on: boolean) => {
    playing = on;
    if (on) hide();
    else void needs('card').catch(() => {}); // the hover card, ready before the pointer gets there
    pauseBtn.innerHTML = (on ? PAUSE : PLAY) + `<span>${on ? 'Pause' : 'Resume'}</span>`;
    pauseBtn.setAttribute('aria-label', on ? 'Pause' : 'Resume');
  };
  pauseBtn.addEventListener('click', () => setPlaying(!playing));
  // Pause only exists full screen; closing it lets the wall run again.
  new MutationObserver(() => !box.classList.contains('expanded') && !still && !playing && setPlaying(true)).observe(box, { attributes: true, attributeFilter: ['class'] });
  // Paused in full screen, hovering a Credit shows what it is and who holds it now.
  const card = host.querySelector<HTMLElement>('.wall-card')!;
  const ring = host.querySelector<HTMLElement>('.wall-hover')!;
  const owners = new Map<number, Promise<string>>();
  const ownerOf = (i: number) => {
    let p = owners.get(i);
    if (!p) {
      p = fetch(`/owner/${i + 1}`)
        .then((r) => r.json() as Promise<{ owner: string | null }>)
        .then(async ({ owner }) => {
          if (!owner) return 'Burned';
          const ens = await fetch(`/ens/${owner}`).then((r) => r.json() as Promise<{ name: string | null }>).catch(() => ({ name: null }));
          return ens.name ?? `${owner.slice(0, 6)}…${owner.slice(-4)}`;
        })
        .catch(() => '');
      owners.set(i, p);
    }
    return p;
  };
  let hovered = -1;
  const hide = () => {
    card.hidden = ring.hidden = true;
    hovered = -1;
  };
  cv.addEventListener('pointerleave', hide);
  cv.addEventListener('pointermove', (ev) => {
    if (playing || scrubbing || !box.classList.contains('expanded')) return hide();
    const r = cv.getBoundingClientRect();
    const X = ((ev.clientX - r.left) / r.width) * W, Y = ((ev.clientY - r.top) / r.height) * H;
    let hit = -1;
    for (let j = drawn.length - 4; j >= 0; j -= 4) {
      if (X >= drawn[j + 1] && X < drawn[j + 1] + drawn[j + 3] && Y >= drawn[j + 2] && Y < drawn[j + 2] + drawn[j + 3]) {
        hit = j;
        break;
      }
    }
    if (hit < 0) return hide();
    const i = drawn[hit], sx = r.width / W;
    Object.assign(ring.style, { left: `${drawn[hit + 1] * sx}px`, top: `${drawn[hit + 2] * sx}px`, width: `${drawn[hit + 3] * sx}px`, height: `${drawn[hit + 3] * sx}px` });
    ring.hidden = false;
    // Beside the pointer, flipped to stay inside the frame.
    const left = ev.clientX - r.left, top = ev.clientY - r.top;
    card.style.left = `${left + 240 > r.width ? left - 232 : left + 16}px`;
    card.style.top = `${Math.min(top + 16, r.height - 300)}px`;
    card.hidden = false;
    if (i === hovered) return;
    if (!e.palette || !e.bits) {
      void needs('card').catch(() => {});
      return hide();
    }
    hovered = i;
    card.innerHTML = `<img src="/art/mainnet/${i + 1}.svg" alt="">
      <strong>Credit #${(i + 1).toLocaleString()}</strong>
      <dl><dt>Colors</dt><dd>${inks(e.palette[i]) || '—'}</dd><dt>Bits</dt><dd>${e.bits[i]}</dd><dt>Paid</dt><dd>${when(i, true)}</dd><dt>Owner</dt><dd class="owner">…</dd></dl>`;
    ownerOf(i).then((who) => {
      if (hovered === i) card.querySelector('.owner')!.textContent = who || 'Unknown';
    });
  });

  host.querySelectorAll<HTMLButtonElement>('.wall-zoom').forEach((b) =>
    b.addEventListener('click', () => {
      const k = Math.min(12, Math.max(1, K + Number(b.dataset.zoom)));
      if (k === K) return;
      off = (off * T) / (8 * k); // keep the same Credits at the left edge
      K = k;
      T = 8 * K;
      S = K + 1;
      ST = 8 * S;
      frame();
    }),
  );
  new IntersectionObserver(([x]) => (visible = x.isIntersecting)).observe(cv);
  new ResizeObserver(() => {
    size();
    frame();
  }).observe(box);
}
