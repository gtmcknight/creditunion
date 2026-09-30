/// The eight formats a Statement can be composed in, in the contract's order (Statements.formatOf).
///
/// Drawn the way the Statements contracts draw them. Issued, Consolidated and Reconciled lay out each Credit's
/// ink on the contract's geometry (StatementArt, StatementFormats); the other five come from the reference
/// renderers in ./formats, which the renderer contracts match byte for byte. A Credit's ink here matches
/// StatementArt.inkOf for all 122,154 Credits.
///
/// Geometry is in the contract's paper units: a 10,000 × 12,500 sheet. Consolidated and Reconciled share one box of
/// 64 × 80 cells inside a 6-cell margin, one cell per pixel of Credit art.
import { processOf } from './credits';
import { accrued, amortized, assessed, binary, liquidated, paintModel, PALETTE } from './formats/statement-renderers';

export const DIRECTIONS = ['Issued', 'Consolidated', 'Assessed', 'Reconciled', 'Accrued', 'Amortized', 'Liquidated', 'Recorded'] as const;
export type Direction = (typeof DIRECTIONS)[number];

export const PAGE = { w: 10_000, h: 12_500 } as const;
const CELL = PAGE.w / 76; // one cell of Credit art in the box: 64 cells with 6 of margin each side
const BOX = { x: PAGE.w / 2 - 32 * CELL, y: PAGE.h / 2 - 40 * CELL, w: 64, h: 80 }; // centred, in cells from (x, y)

/// [x, y, w, h, colour] in paper units.
export type Rect = [number, number, number, number, string];
/// A drawing from the reference renderers (groups of SVG paths in their own view box), painted as they paint it.
export type Model = { model: object };
export type Mark = Rect | Model;

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
/// cells around it for misprinted plates to slip into), its literal 8s, and (when known) its Credit Rating.
export type Ink = { px: Uint8Array; eights: number; score?: number };

export function inkOf(seed: string, paidAt: number, score?: number): Ink {
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
  return { px, eights, score };
}

/// Draws one format. `inks` is the union's 80 slots in burn order. Slots in `ghosts` hold a Credit that isn't in the
/// union (an example, or someone else's when showing yours) and are drawn faded, as the sheet does. Issued,
/// Consolidated and Reconciled fade them Credit by Credit. The renderer formats draw all 80 as they'd stand, then
/// veil the squares of the slots that aren't the members' (ghost or empty); Liquidated, whose bands don't keep
/// slots, veils each mix past the members' own share of it. Slots with no ink at all are drawn in `faint` where the
/// format has a place for them.
export function compose(direction: Direction, inks: readonly (Ink | null)[], ghosts: ReadonlySet<number> = new Set(), faint = '#ececea'): Mark[] {
  const off = (c: number) => ghosts.has(c) || !inks[c];
  switch (direction) {
    case 'Issued': return issued(inks, ghosts, faint);
    case 'Consolidated': return consolidated(inks, ghosts, faint);
    case 'Reconciled': return reconciled(inks, ghosts, faint);
    case 'Assessed': return [{ model: assessed(wordsOf(inks)) }, ...veiled(off)];
    case 'Accrued': return [{ model: accrued([wordsOf(inks)]) }, ...veiled(off)]; // one page: nothing overprinted yet
    case 'Amortized': return [{ model: amortized(wordsOf(inks)) }, ...veiled(off)];
    case 'Liquidated': {
      const model = liquidated(wordsOf(inks));
      return [{ model }, ...poured(model, inks, off)];
    }
    case 'Recorded': return [{ model: binary(wordsOf(inks)) }, ...veiled(off)];
  }
}

/// Over ink, white at 72% leaves 28% of it: the sheet's ghost opacity, the same as FADED.
const VEIL = 'rgba(255,255,255,0.72)';

/// A veil over the box square of every slot that's `off`, neighbours along a row in one piece. A square on the box's
/// edge takes the margin beside it too: misprints, Amortized's rings and Accrued's line reach out there.
function veiled(off: (c: number) => boolean): Rect[] {
  const out: Rect[] = [];
  for (let c = 0; c < 80; c++) {
    if (!off(c)) continue;
    let end = c + 1;
    while (end % 8 && off(end)) end++;
    const row = Math.floor(c / 8), x0 = c % 8 ? (c % 8) * 8 : -6, x1 = end % 8 ? (end % 8) * 8 : 70;
    const y0 = row ? row * 8 : -7.5, y1 = row < 9 ? row * 8 + 8 : 87.5;
    out.push(cell(x0, y0, x1 - x0, y1 - y0, VEIL));
    c = end - 1;
  }
  return out;
}

/// Liquidated pours the page's ink into bands by mix, so its pixels don't keep their slots. As Balanced did, each
/// mix stays solid, in reading order, as far as the members' own ink of it goes; the rest of it is veiled.
type Poured = { groups: { items: { color: string; d: string }[] }[] };
function poured(model: object, inks: readonly (Ink | null)[], off: (c: number) => boolean): Rect[] {
  const all = new Array<number>(16).fill(0), own = new Array<number>(16).fill(0);
  inks.forEach((ink, c) => ink && framed(ink).forEach((v, m) => ((all[m] += v), off(c) || (own[m] += v))));
  const veil = new Uint8Array(64 * 80);
  for (const { color, d } of (model as Poured).groups[0].items) {
    const m = PALETTE.indexOf(color);
    if (m < 1 || own[m] >= all[m]) continue;
    const runs = [...d.matchAll(/M(\d+) (\d+)h(\d+)/g)].map(([, x, y, n]) => [+x, +y, +n]);
    let solid = Math.round((runs.reduce((t, r) => t + r[2], 0) * own[m]) / all[m]);
    for (const [x, y, n] of runs) for (let i = 0; i < n; i++) solid > 0 ? solid-- : (veil[y * 64 + x + i] = 1);
  }
  const out: Rect[] = [];
  for (let y = 0; y < 80; y++)
    for (let x = 0; x < 64; x++) {
      if (!veil[y * 64 + x]) continue;
      let end = x + 1;
      while (end < 64 && veil[y * 64 + end]) end++;
      out.push(cell(x, y, end - x, 1, VEIL));
      x = end - 1;
    }
  return out;
}

/// The contract's 240 ink words for these slots (StatementArt.inkOf's layout): three per cell, pixel i in word
/// i / 64 at bits (i % 64) × 4. Empty slots print nothing.
function wordsOf(inks: readonly (Ink | null)[]): bigint[] {
  const words: bigint[] = [];
  for (let c = 0; c < 80; c++) {
    const ink = inks[c];
    for (let w = 0; w < 3; w++) {
      let v = 0n;
      for (let j = 0; j < 64 && w * 64 + j < 144; j++) {
        const m = ink?.px[w * 64 + j];
        if (m) v |= BigInt(m) << BigInt(j * 4);
      }
      words.push(v);
    }
  }
  return words;
}

/// The 2D-canvas calls `paint` makes itself (a renderer's drawing needs the whole canvas context).
type Pen = { fillStyle: unknown; fillRect(x: number, y: number, w: number, h: number): void };

/// Paints marks onto a 2D canvas `W` device pixels wide, on white. Rects snap to device pixels.
/// paintModel sets whole transforms, as if its page were the canvas. Where it isn't (a tile in the All grid,
/// translated there), each transform it sets is taken relative to where the page sits.
type Matrix = { a: number; b: number; c: number; d: number; e: number; f: number; isIdentity: boolean };
type Placeable = { getTransform?(): Matrix; setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void };
function placed<T extends object>(ctx: T): T {
  const pen = ctx as unknown as Placeable;
  const m = typeof pen.getTransform === 'function' ? pen.getTransform() : null;
  if (!m || m.isIdentity) return ctx;
  return new Proxy(ctx, {
    get(t, p) {
      if (p === 'setTransform')
        return (a: number, b: number, c: number, d: number, e: number, f: number) =>
          (t as unknown as Placeable).setTransform(m.a * a + m.c * b, m.b * a + m.d * b, m.a * c + m.c * d, m.b * c + m.d * d, m.a * e + m.c * f + m.e, m.b * e + m.d * f + m.f);
      const v = Reflect.get(t, p);
      return typeof v === 'function' ? v.bind(t) : v;
    },
    set(t, p, v) {
      (t as unknown as Record<PropertyKey, unknown>)[p] = v;
      return true;
    },
  });
}

export function paint(g: Pen, W: number, marks: readonly Mark[]) {
  const k = W / PAGE.w;
  // Neighbouring cells reach their shared edge by different sums; trimming the float noise first keeps both
  // snapping to the same pixel, so no hairline of paper shows between them.
  const snap = (v: number) => Math.round(Math.round(v * 1e3) * 1e-3 * k);
  g.fillStyle = '#fff';
  g.fillRect(0, 0, W, Math.round((W * PAGE.h) / PAGE.w));
  for (const m of marks) {
    if (!Array.isArray(m)) {
      paintModel(placed(g), W, m.model);
      continue;
    }
    const [x, y, w, h, colour] = m;
    const x0 = snap(x), y0 = snap(y), x1 = snap(x + w), y1 = snap(y + h);
    if (x1 > x0 && y1 > y0) (g.fillStyle = colour), g.fillRect(x0, y0, x1 - x0, y1 - y0);
  }
}

/// An example Credit's colour: 28% ink on white, the sheet's ghost opacity.
const FADED = MIX.map((hex) => {
  const v = parseInt(hex.slice(1), 16);
  const f = (c: number) => Math.round(255 - (255 - c) * 0.28);
  return `#${((f(v >> 16) << 16) | (f((v >> 8) & 255) << 8) | f(v & 255)).toString(16).padStart(6, '0')}`;
});

/// Where Credit `c`'s art sits on the Issued page, and paper units per unit of its 320-unit art.
const issuedAt = (c: number) => ({ x0: 800 + (c % 8) * 1050, y0: 820 + Math.floor(c / 8) * 1090, k: 1050 / 320 });

/// Up to four 8s print as marks along the bottom right (1: K; 2: Y K; 3: M Y K; 4: C M Y K).
function eightsOf(ink: Ink, mix: string[], at: (x: number, y: number, w: number, h: number, colour: string) => void) {
  const n = Math.min(ink.eights, 4);
  for (let i = 0; i < n; i++) at((16 - n + i) * 20, 300, 20, 20, mix[1 << (4 - n + i)]);
}

/// Where slot `c` sits on the page, in paper units ([x, y, w, h]), in the formats that keep each Credit in its own
/// place (Issued on the contract's 8 × 10 layout; Consolidated, Assessed, Amortized and Recorded in the box). Null in
/// the rest, which move ink between Credits.
export function slotBox(d: Direction, c: number): [number, number, number, number] | null {
  if (d === 'Issued') {
    const { x0, y0, k } = issuedAt(c);
    return [x0, y0, 320 * k, 320 * k];
  }
  if (d === 'Consolidated' || d === 'Assessed' || d === 'Amortized' || d === 'Recorded') return [BOX.x + (c % 8) * 8 * CELL, BOX.y + Math.floor(c / 8) * 8 * CELL, 8 * CELL, 8 * CELL];
  return null;
}
/// The slot under a point on the page (paper units), or -1.
export function slotAt(d: Direction, x: number, y: number): number {
  for (let c = 0; c < 80; c++) {
    const b = slotBox(d, c);
    if (!b) return -1;
    if (x >= b[0] && x < b[0] + b[2] && y >= b[1] && y < b[1] + b[3]) return c;
  }
  return -1;
}

/// Issued: each Credit's ink, eights marks included, on the contract's 8 × 10 layout (StatementArt.inkPage). A
/// misprint isn't re-centred: its frame stays put and the slipped plates hang off it. A Statement cell has no ground,
/// so even five 8s print as four marks.
function issued(inks: readonly (Ink | null)[], ghosts: ReadonlySet<number>, faint: string): Rect[] {
  const out: Rect[] = [];
  for (let c = 0; c < 80; c++) {
    const { x0, y0, k } = issuedAt(c);
    const at = (x: number, y: number, w: number, h: number, colour: string) => out.push([x0 + x * k, y0 + y * k, w * k, h * k, colour]);
    const ink = inks[c];
    if (!ink) {
      at(80, 80, 160, 160, faint);
      continue;
    }
    const mix = ghosts.has(c) ? FADED : MIX;
    ink.px.forEach((m, j) => {
      if (m) at(40 + (j % 12) * 20, 40 + Math.floor(j / 12) * 20, 20, 20, mix[m]);
    });
    eightsOf(ink, mix, at);
  }
  return out;
}

const cell = (x: number, y: number, w: number, h: number, colour: string): Rect => [BOX.x + x * CELL, BOX.y + y * CELL, w * CELL, h * CELL, colour];

/// The 80 frames butted into one grid, with two cells round the box for misprints to spill into (68 × 84, box
/// cell (x, y) at [(y + 2) · 68 + x + 2]). Members' ink ORs into `real`, the examples' into `ghost`; `empty` lists
/// the slots with no ink.
function butted(inks: readonly (Ink | null)[], ghosts: ReadonlySet<number>) {
  const real = new Uint8Array(68 * 84), ghost = new Uint8Array(real.length), empty: number[] = [];
  inks.forEach((ink, c) => {
    const fx = (c % 8) * 8, fy = Math.floor(c / 8) * 8, grid = ghosts.has(c) ? ghost : real;
    if (!ink) return void empty.push(c);
    ink.px.forEach((m, j) => {
      if (m) grid[(fy + Math.floor(j / 12)) * 68 + fx + (j % 12)] |= m;
    });
  });
  return { real, ghost, empty };
}

/// A butted cell's colour: members' ink over the examples'.
const shade = (real: Uint8Array, ghost: Uint8Array, k: number) => (real[k] ? MIX[real[k]] : ghost[k] ? FADED[ghost[k]] : null);

/// The 80 frames butted into one 64 × 80 picture. Misprinted ink spills into the neighbours (and past the edge)
/// and overprints whatever it lands on.
function consolidated(inks: readonly (Ink | null)[], ghosts: ReadonlySet<number>, faint: string): Rect[] {
  const { real, ghost, empty } = butted(inks, ghosts), out: Rect[] = [];
  for (const c of empty) out.push(cell((c % 8) * 8, Math.floor(c / 8) * 8, 8, 8, faint));
  real.forEach((_, k) => {
    const colour = shade(real, ghost, k);
    if (colour) out.push(cell((k % 68) - 2, Math.floor(k / 68) - 2, 1, 1, colour));
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

/// The contract's ink order for a reconciled row: the lights, then the darks.
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
