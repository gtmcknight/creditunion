/// The four directions a Statement can be composed in: Issued, Consolidated, Balance, Reconciled.
///
/// Worked out from Jack's mock of Credits #1–#80 (x.com/jackbutcher, Sep 2026), before his Statement contract is
/// public. Issued, Consolidated and Reconciled reproduce that mock cell for cell. Balance matches its order,
/// colours and grid, and 13 of its 14 cuts (one lands two rows off). Everything here is a preview: his contract
/// draws the real thing.
///
/// Geometry is in Jack's paper units: a 10,000 × 12,500 sheet. Issued lays the 80 Credits' art out as his page
/// does; the other three share one box of 64 × 80 cells, one cell per cell of Credit art.
import { processOf } from './credits';

export const DIRECTIONS = ['Issued', 'Consolidated', 'Balance', 'Reconciled'] as const;
export type Direction = (typeof DIRECTIONS)[number];

export const PAGE = { w: 10_000, h: 12_500 } as const;
const CELL = 1050 / 8; // one cell of Credit art in the box
const BOX = { x: 800, y: 1000, w: 64, h: 80 }; // in cells from (x, y)

/// [x, y, w, h, colour] in paper units.
export type Rect = [number, number, number, number, string];

/// Subtractive ink mixes by plate mask (C=1 M=2 Y=4 K=8), rounded as CreditDrawing.palette does.
const INKS = [0x00b5e2, 0xe4007c, 0xffd100, 0x111111];
export const MIX: string[] = Array.from({ length: 16 }, (_, mask) => {
  let r = 255, g = 255, b = 255;
  for (let layer = 0; layer < 4; layer++) {
    if (!(mask & (1 << layer))) continue;
    const ink = INKS[layer];
    r = Math.floor((r * ((ink >> 16) & 255) + 127) / 255);
    g = Math.floor((g * ((ink >> 8) & 255) + 127) / 255);
    b = Math.floor((b * (ink & 255) + 127) / 255);
  }
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`;
});

/// One Credit's ink: the 12×12 raster of plate masks its art prints (its 8×8 frame at rows and columns 2–9, two
/// cells around it for misprinted plates to slip into), and its literal 8s.
export type Ink = { px: Uint8Array; eights: number };

export function inkOf(seed: string, paidAt: number): Ink {
  const p = processOf(seed, paidAt);
  const px = new Uint8Array(144);
  for (let layer = 0; layer < 4; layer++) {
    if (!(p.mask & (1 << layer))) continue;
    p.plates[layer].forEach((bit, i) => {
      if (bit) px[((i >> 3) + 2 + p.dy[layer]) * 12 + (i & 7) + 2 + p.dx[layer]] |= 1 << layer;
    });
  }
  let eights = 0;
  for (const ch of seed) if (ch === '8') eights++;
  return { px, eights };
}

/// Draws one direction. `inks` is the union's 80 slots in burn order. Slots in `ghosts` hold an example Credit,
/// drawn faded as the sheet shows them; slots with no ink at all are drawn in `faint`.
export function compose(direction: Direction, inks: readonly (Ink | null)[], ghosts: ReadonlySet<number> = new Set(), faint = '#ececea'): Rect[] {
  if (direction === 'Issued') return issued(inks, ghosts, faint);
  if (direction === 'Consolidated') return consolidated(inks, ghosts, faint);
  if (direction === 'Balance') return balance(inks, ghosts);
  return reconciled(inks, ghosts, faint);
}

/// An example Credit's colour: 28% ink on white, the sheet's ghost opacity.
const FADED = MIX.map((hex) => {
  const v = parseInt(hex.slice(1), 16);
  const f = (c: number) => Math.round(255 - (255 - c) * 0.28);
  return `#${((f(v >> 16) << 16) | (f((v >> 8) & 255) << 8) | f(v & 255)).toString(16).padStart(6, '0')}`;
});

/// The Credits as issued: each one's art, eight marks included, on Jack's 8 × 10 layout. Unlike the Credit's own
/// art, a misprint isn't re-centred on its paper: its frame stays put and the slipped plates hang off it.
function issued(inks: readonly (Ink | null)[], ghosts: ReadonlySet<number>, faint: string): Rect[] {
  const out: Rect[] = [];
  for (let c = 0; c < 80; c++) {
    const x0 = 800 + (c % 8) * 1050, y0 = 820 + Math.floor(c / 8) * 1090, k = 1050 / 320;
    const at = (x: number, y: number, w: number, h: number, colour: string) => out.push([x0 + x * k, y0 + y * k, w * k, h * k, colour]);
    const ink = inks[c];
    if (!ink) {
      at(80, 80, 160, 160, faint);
      continue;
    }
    const mix = ghosts.has(c) ? FADED : MIX;
    if (ink.eights >= 5) at(0, 0, 320, 320, mix[8]), at(80, 80, 160, 160, '#ffffff'); // five 8s print on black paper
    ink.px.forEach((m, j) => {
      if (m) at(40 + (j % 12) * 20, 40 + Math.floor(j / 12) * 20, 20, 20, mix[m]);
    });
    const n = Math.min(ink.eights, 4);
    for (let i = 0; i < n; i++) at((16 - n + i) * 20, 300, 20, 20, mix[1 << (4 - n + i)]);
  }
  return out;
}

const cell = (x: number, y: number, w: number, h: number, colour: string): Rect => [BOX.x + x * CELL, BOX.y + y * CELL, w * CELL, h * CELL, colour];

/// The 80 frames butted into one 64 × 80 picture. Misprinted ink spills into the neighbours (and past the edge)
/// and overprints whatever it lands on.
function consolidated(inks: readonly (Ink | null)[], ghosts: ReadonlySet<number>, faint: string): Rect[] {
  const W = BOX.w + 4, real = new Uint8Array(W * (BOX.h + 4)), ghost = new Uint8Array(real.length), out: Rect[] = [];
  inks.forEach((ink, c) => {
    const fx = (c % 8) * 8, fy = Math.floor(c / 8) * 8, grid = ghosts.has(c) ? ghost : real;
    if (!ink) return void out.push(cell(fx, fy, 8, 8, faint));
    ink.px.forEach((m, j) => {
      if (m) grid[(fy + Math.floor(j / 12)) * W + fx + (j % 12)] |= m;
    });
  });
  real.forEach((m, k) => {
    const at = (colour: string) => out.push(cell((k % W) - 2, Math.floor(k / W) - 2, 1, 1, colour));
    if (m) at(MIX[m]);
    else if (ghost[k]) at(FADED[ghost[k]]);
  });
  return out;
}

/// A Credit's ink inside its own frame, counted by mix. Ink a misprint slips out of the frame doesn't count.
function framed(ink: Ink): number[] {
  const n = new Array<number>(16).fill(0);
  ink.px.forEach((m, j) => {
    const x = j % 12, y = Math.floor(j / 12);
    if (m && x >= 2 && x < 10 && y >= 2 && y < 10) n[m]++;
  });
  return n;
}

/// How much of each mix went in: one block per mix, largest first, cut in two by count along the longer side
/// (d3's binary treemap), with a one-cell gutter at every cut, on the box's own cells. A cut that lands within
/// two cells of the matching cut in the block beside it lines up with it, so the long lines run straight across.
function balance(inks: readonly (Ink | null)[], ghosts: ReadonlySet<number>): Rect[] {
  // Laid out for all 80 as they'd stand (members' Credits and the examples in the empty slots). Each block fills
  // solid from the top, cell by cell, as far as members' own ink of that mix goes; the rest stays faded.
  const n = new Array<number>(16).fill(0), real = new Array<number>(16).fill(0);
  inks.forEach((ink, c) => {
    if (ink) framed(ink).forEach((v, m) => ((n[m] += v), ghosts.has(c) || (real[m] += v)));
  });
  const items = n.map((v, m) => ({ m, v })).filter((b) => b.m && b.v).sort((a, b) => b.v - a.v || a.m - b.m);
  const block = (m: number, x: number, y: number, w: number, h: number) => {
    const solid = Math.round((w * h * real[m]) / n[m]), full = Math.floor(solid / w), part = solid % w, rest = h - full - (part ? 1 : 0);
    if (full) out.push(cell(x, y, w, full, MIX[m]));
    if (part) out.push(cell(x, y + full, part, 1, MIX[m]), cell(x + part, y + full, w - part, 1, FADED[m]));
    if (rest) out.push(cell(x, y + h - rest, w, rest, FADED[m]));
  };
  const out: Rect[] = [];
  // Gutters so far, as [line, first cell, last cell]: rows run across, columns run down.
  const rows: [number, number, number][] = [], cols: [number, number, number][] = [];
  // The gutter line nearest `natural` (within two) among those ending at `edge`, the block beside this one.
  const snap = (natural: number, lo: number, hi: number, done: [number, number, number][], edge: number) => {
    let at = natural, off = 3;
    for (const [line, , last] of done) {
      const d = Math.abs(line - natural);
      if (last === edge && line >= lo && line <= hi && d < off) (at = line), (off = d);
    }
    return at;
  };
  const cut = (list: typeof items, x: number, y: number, w: number, h: number) => {
    if (list.length === 1) return block(list[0].m, x, y, w, h);
    const sums = [0];
    for (const b of list) sums.push(sums[sums.length - 1] + b.v);
    const total = sums[list.length], half = total / 2;
    let k = 1;
    while (k < list.length - 1 && sums[k] < half) k++;
    if (k > 1 && half - sums[k - 1] < sums[k] - half) k--;
    const share = sums[k] / total;
    if (w > h) {
      const c = snap(x + Math.round((w - 1) * share), x + 1, x + w - 2, cols, y - 2);
      cols.push([c, y, y + h - 1]);
      cut(list.slice(0, k), x, y, c - x, h), cut(list.slice(k), c + 1, y, x + w - 1 - c, h);
    } else {
      const r = snap(y + Math.round((h - 1) * share), y + 1, y + h - 2, rows, x - 2);
      rows.push([r, x, x + w - 1]);
      cut(list.slice(0, k), x, y, w, r - y), cut(list.slice(k), x, r + 1, w, y + h - 1 - r);
    }
  };
  if (items.length) cut(items, 0, 0, BOX.w, BOX.h);
  return out;
}

/// Jack's ink order for a reconciled row: the lights, then the darks.
const LEDGER = [6, 2, 1, 4, 5, 3, 7, 12, 11, 9, 10, 8, 13, 14, 15];

/// One row per Credit in burn order, its framed ink lined up by mix, so a longer row carries more ink.
function reconciled(inks: readonly (Ink | null)[], ghosts: ReadonlySet<number>, faint: string): Rect[] {
  const out: Rect[] = [];
  inks.forEach((ink, row) => {
    if (!ink) return void out.push(cell(0, row + 0.35, 8, 0.3, faint));
    const n = framed(ink), mix = ghosts.has(row) ? FADED : MIX;
    let x = 0;
    for (const m of LEDGER) if (n[m]) out.push(cell(x, row, n[m], 1, mix[m])), (x += n[m]);
  });
  return out;
}
