/// The eight directions a Statement can be composed in.
///
/// Worked out from Jack's mocks (x.com/jackbutcher, Sep 2026) before his Statement contract is public: Credits
/// #1–#80 for the first four, and 80 misprints from #82 to #1013 for all eight. Against the second mock, every
/// direction but Allocated reproduces his pixels exactly; Allocated has his cells, colours and order, with some
/// edges a few pixels off. Everything here is a preview: his contract draws the real thing.
///
/// Geometry is in Jack's paper units: a 10,000 × 12,500 sheet. Issued and Voided lay the 80 Credits' art out as
/// his page does; the rest share one box of 64 × 80 cells, one cell per cell of Credit art. Line widths are set
/// from his 566-pixel-wide mock, where they are 1, 2 and 3 pixels.
import { processOf } from './credits';

export const DIRECTIONS = ['Issued', 'Consolidated', 'Accrued', 'Allocated', 'Balanced', 'Amortized', 'Reconciled', 'Voided'] as const;
export type Direction = (typeof DIRECTIONS)[number];

export const PAGE = { w: 10_000, h: 12_500 } as const;
const CELL = PAGE.w / 76; // one cell of Credit art in the box: 64 cells with 6 of margin each side
const BOX = { x: PAGE.w / 2 - 32 * CELL, y: PAGE.h / 2 - 40 * CELL, w: 64, h: 80 }; // centred, in cells from (x, y)
const PX = PAGE.w / 566; // one pixel of Jack's mock

/// [x, y, w, h, colour] in paper units.
export type Rect = [number, number, number, number, string];
/// A polygon or polyline in paper units ([x0, y0, x1, y1, …]), filled and/or stroked.
export type Path = { pts: number[]; fill?: string; stroke?: string; width?: number; closed?: boolean };
export type Mark = Rect | Path;

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

/// Draws one direction. `inks` is the union's 80 slots in burn order. Slots in `ghosts` hold an example Credit,
/// drawn faded as the sheet shows them; slots with no ink at all are drawn in `faint`.
export function compose(direction: Direction, inks: readonly (Ink | null)[], ghosts: ReadonlySet<number> = new Set(), faint = '#ececea'): Mark[] {
  switch (direction) {
    case 'Issued': return issued(inks, ghosts, faint);
    case 'Consolidated': return consolidated(inks, ghosts, faint);
    case 'Accrued': return accrued(inks, ghosts);
    case 'Allocated': return allocated(inks, ghosts);
    case 'Balanced': return balanced(inks, ghosts);
    case 'Amortized': return amortized(inks, ghosts, faint);
    case 'Reconciled': return reconciled(inks, ghosts, faint);
    case 'Voided': return voided(inks, ghosts, faint);
  }
}

/// The 2D-canvas calls `paint` uses.
type Pen = {
  fillStyle: unknown; strokeStyle: unknown; lineWidth: number; lineCap: string; lineJoin: string;
  fillRect(x: number, y: number, w: number, h: number): void;
  beginPath(): void; moveTo(x: number, y: number): void; lineTo(x: number, y: number): void; closePath(): void;
  fill(): void; stroke(): void;
};

/// Paints marks onto a canvas `W` device pixels wide, on white. Rects snap to device pixels, as Jack's mock does.
export function paint(g: Pen, W: number, marks: readonly Mark[]) {
  const k = W / PAGE.w;
  // Neighbouring cells reach their shared edge by different sums; trimming the float noise first keeps both
  // snapping to the same pixel, so no hairline of paper shows between them.
  const snap = (v: number) => Math.round(Math.round(v * 1e3) * 1e-3 * k);
  g.fillStyle = '#fff';
  g.fillRect(0, 0, W, Math.round((W * PAGE.h) / PAGE.w));
  for (const m of marks) {
    if (Array.isArray(m)) {
      const [x, y, w, h, colour] = m;
      const x0 = snap(x), y0 = snap(y), x1 = snap(x + w), y1 = snap(y + h);
      if (x1 > x0 && y1 > y0) (g.fillStyle = colour), g.fillRect(x0, y0, x1 - x0, y1 - y0);
      continue;
    }
    g.beginPath();
    for (let i = 0; i < m.pts.length; i += 2) (i ? g.lineTo : g.moveTo).call(g, m.pts[i] * k, m.pts[i + 1] * k);
    if (m.closed) g.closePath();
    if (m.fill) (g.fillStyle = m.fill), g.fill();
    if (m.stroke) (g.strokeStyle = m.stroke), (g.lineWidth = (m.width ?? PX) * k), (g.lineCap = 'round'), (g.lineJoin = 'round'), g.stroke();
  }
}

/// An example Credit's colour: 28% ink on white, the sheet's ghost opacity.
const FADED = MIX.map((hex) => {
  const v = parseInt(hex.slice(1), 16);
  const f = (c: number) => Math.round(255 - (255 - c) * 0.28);
  return `#${((f(v >> 16) << 16) | (f((v >> 8) & 255) << 8) | f(v & 255)).toString(16).padStart(6, '0')}`;
});

const popcount = (m: number) => (m & 1) + ((m >> 1) & 1) + ((m >> 2) & 1) + ((m >> 3) & 1);

/// Where Credit `c`'s art sits on the Issued page, and paper units per unit of its 320-unit art.
const issuedAt = (c: number) => ({ x0: 800 + (c % 8) * 1050, y0: 820 + Math.floor(c / 8) * 1090, k: 1050 / 320 });

/// Five 8s print on black paper; up to four 8s print as marks along the bottom right.
function eightsOf(ink: Ink, mix: string[], at: (x: number, y: number, w: number, h: number, colour: string) => void) {
  const n = Math.min(ink.eights, 4);
  for (let i = 0; i < n; i++) at((16 - n + i) * 20, 300, 20, 20, mix[1 << (4 - n + i)]);
}

/// The Credits as issued: each one's art, eight marks included, on Jack's 8 × 10 layout. Unlike the Credit's own
/// art, a misprint isn't re-centred on its paper: its frame stays put and the slipped plates hang off it.
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
    if (ink.eights >= 5) at(0, 0, 320, 320, mix[8]), at(80, 80, 160, 160, '#ffffff');
    ink.px.forEach((m, j) => {
      if (m) at(40 + (j % 12) * 20, 40 + Math.floor(j / 12) * 20, 20, 20, mix[m]);
    });
    eightsOf(ink, mix, at);
  }
  return out;
}

/// Issued with the ink voided: each patch of one mix is drawn as a one-pixel outline in that mix.
function voided(inks: readonly (Ink | null)[], ghosts: ReadonlySet<number>, faint: string): Rect[] {
  const out: Rect[] = [], t = PX, u = 20 * (1050 / 320);
  for (let c = 0; c < 80; c++) {
    const { x0, y0, k } = issuedAt(c);
    const at = (x: number, y: number, w: number, h: number, colour: string) => out.push([x0 + x * k, y0 + y * k, w * k, h * k, colour]);
    const ink = inks[c];
    if (!ink) {
      at(80, 80, 160, 160, faint);
      continue;
    }
    const mix = ghosts.has(c) ? FADED : MIX;
    if (ink.eights >= 5) at(0, 0, 320, 320, mix[8]), at(80, 80, 160, 160, '#ffffff');
    const m = (x: number, y: number) => (x < 0 || y < 0 || x > 11 || y > 11 ? 0 : ink.px[y * 12 + x]);
    for (let y = 0; y < 12; y++) {
      for (let x = 0; x < 12; x++) {
        const v = m(x, y);
        if (!v) continue;
        const X = x0 + (40 + x * 20) * k, Y = y0 + (40 + y * 20) * k;
        if (m(x, y - 1) !== v) out.push([X, Y, u + t, t, mix[v]]);
        if (m(x, y + 1) !== v) out.push([X, Y + u, u + t, t, mix[v]]);
        if (m(x - 1, y) !== v) out.push([X, Y, t, u + t, mix[v]]);
        if (m(x + 1, y) !== v) out.push([X + u, Y, t, u + t, mix[v]]);
      }
    }
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

/// Consolidated, amortized: its ink peeled away a ring at a time (a cell belongs to ring n when it has ink and
/// all eight neighbours made it to ring n − 1), and every ring's edge drawn in the ink of the cell inside it.
function amortized(inks: readonly (Ink | null)[], ghosts: ReadonlySet<number>, faint: string): Rect[] {
  const { real, ghost, empty } = butted(inks, ghosts), out: Rect[] = [];
  for (const c of empty) out.push(cell((c % 8) * 8, Math.floor(c / 8) * 8, 8, 8, faint));
  const W = 68, H = 84, depth = new Uint8Array(W * H);
  let ring = Array.from(real, (m, k) => m | ghost[k]).map((m) => m > 0);
  for (let n = 1; ring.some(Boolean); n++) {
    ring.forEach((on, k) => on && (depth[k] = n));
    const at = (x: number, y: number) => x >= 0 && y >= 0 && x < W && y < H && ring[y * W + x];
    ring = ring.map((on, k) => {
      const x = k % W, y = Math.floor(k / W);
      if (!on) return false;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (!at(x + dx, y + dy)) return false;
      return true;
    });
  }
  const t = 3 * PX, o = PX / 2 - t / 2;
  const d = (x: number, y: number) => (x < 0 || y < 0 || x >= W || y >= H ? 0 : depth[y * W + x]);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const v = d(x, y);
      if (!v) continue;
      const colour = shade(real, ghost, y * W + x)!;
      const X = BOX.x + (x - 2) * CELL + o, Y = BOX.y + (y - 2) * CELL + o;
      if (v > d(x, y - 1)) out.push([X, Y, CELL + t, t, colour]);
      if (v > d(x, y + 1)) out.push([X, Y + CELL, CELL + t, t, colour]);
      if (v > d(x - 1, y)) out.push([X, Y, t, CELL + t, colour]);
      if (v > d(x + 1, y)) out.push([X + CELL, Y, t, CELL + t, colour]);
    }
  }
  return out;
}

/// What the ink has accrued: plates per butted cell, blurred (1 6 15 20 15 6 1 / 64 each way), and the line where
/// that reaches its median over the butted grid (1.055 on the misprint mock, 0.477 on the all-black one), drawn in
/// the ink of the cell it crosses; over bare paper, in black, or in the sheet's one ink if it has only one. Loops
/// under 0.6 of a cell are left out (both mocks fit anything from 0.55 to 0.7).
function accrued(inks: readonly (Ink | null)[], ghosts: ReadonlySet<number>): Path[] {
  const { real, ghost } = butted(inks, ghosts);
  const P = 6, FW = 68 + 2 * P, FH = 84 + 2 * P, K = [1, 6, 15, 20, 15, 6, 1].map((v) => v / 64);
  let f = new Float64Array(FW * FH);
  real.forEach((m, k) => (f[(Math.floor(k / 68) + P) * FW + (k % 68) + P] = popcount(m | ghost[k])));
  const blur = (src: Float64Array, dx: number, dy: number) => {
    const out = new Float64Array(src.length);
    for (let y = 0; y < FH; y++)
      for (let x = 0; x < FW; x++) {
        let s = 0;
        for (let i = -3; i <= 3; i++) {
          const xx = x + i * dx, yy = y + i * dy;
          if (xx >= 0 && yy >= 0 && xx < FW && yy < FH) s += K[i + 3] * src[yy * FW + xx];
        }
        out[y * FW + x] = s;
      }
    return out;
  };
  f = blur(blur(f, 1, 0), 0, 1);
  const grid: number[] = [];
  for (let y = P; y < P + 84; y++) for (let x = P; x < P + 68; x++) grid.push(f[y * FW + x]);
  grid.sort((a, b) => a - b);
  const LEVEL = (grid[grid.length / 2 - 1] + grid[grid.length / 2]) / 2;
  const mixes = new Set<string>();
  real.forEach((_, k) => { const s = shade(real, ghost, k); if (s) mixes.add(s); });
  const bare = mixes.size === 1 ? [...mixes][0] : MIX[8];

  // Catmull-Rom up to four samples a cell, then marching squares.
  const S = 4, UW = (FW - 1) * S + 1, UH = (FH - 1) * S + 1;
  const cr = (t: number) => {
    const a = Math.abs(t);
    return a < 1 ? 1.5 * a ** 3 - 2.5 * a ** 2 + 1 : a < 2 ? -0.5 * a ** 3 + 2.5 * a ** 2 - 4 * a + 2 : 0;
  };
  const taps = (n: number, un: number) =>
    Array.from({ length: un }, (_, i) => {
      const p = i / S, i0 = Math.floor(p), out: [number, number][] = [];
      for (let o = -1; o <= 2; o++) out.push([Math.min(n - 1, Math.max(0, i0 + o)), cr(p - (i0 + o))]);
      return out;
    });
  const tx = taps(FW, UW), ty = taps(FH, UH);
  const rows = new Float64Array(FH * UW);
  for (let y = 0; y < FH; y++) for (let i = 0; i < UW; i++) for (const [x, w] of tx[i]) rows[y * UW + i] += w * f[y * FW + x];
  const v = new Float64Array(UH * UW);
  for (let j = 0; j < UH; j++) for (const [y, w] of ty[j]) for (let i = 0; i < UW; i++) v[j * UW + i] += w * rows[y * UW + i];

  // Crossing points on the sample grid's edges, keyed by edge: horizontal edges 2k, vertical edges 2k + 1.
  const cross = (a: number, b: number) => (LEVEL - a) / (b - a);
  const point = (e: number): [number, number] => {
    const k = e >> 1, x = k % UW, y = Math.floor(k / UW);
    return e & 1 ? [x, y + cross(v[k], v[k + UW])] : [x + cross(v[k], v[k + 1]), y];
  };
  // Each crossing joins the two segments either side of it; a closed loop never touches the padded border.
  const links = new Map<number, number[]>();
  const link = (p: number, q: number) => {
    (links.get(p) ?? links.set(p, []).get(p)!).push(q);
    (links.get(q) ?? links.set(q, []).get(q)!).push(p);
  };
  for (let y = 0; y < UH - 1; y++) {
    for (let x = 0; x < UW - 1; x++) {
      const k = y * UW + x, a = v[k] > LEVEL, b = v[k + 1] > LEVEL, c = v[k + UW + 1] > LEVEL, d = v[k + UW] > LEVEL;
      const top = 2 * k, bottom = 2 * (k + UW), left = 2 * k + 1, right = 2 * (k + 1) + 1;
      const hi = (v[k] + v[k + 1] + v[k + UW] + v[k + UW + 1]) / 4 > LEVEL;
      switch ((a ? 8 : 0) | (b ? 4 : 0) | (c ? 2 : 0) | (d ? 1 : 0)) {
        case 1: case 14: link(bottom, left); break;
        case 2: case 13: link(right, bottom); break;
        case 3: case 12: link(left, right); break;
        case 4: case 11: link(top, right); break;
        case 6: case 9: link(top, bottom); break;
        case 7: case 8: link(top, left); break;
        case 5: hi ? (link(top, right), link(bottom, left)) : (link(top, left), link(bottom, right)); break;
        case 10: hi ? (link(top, left), link(bottom, right)) : (link(top, right), link(bottom, left)); break;
      }
    }
  }

  const out: Path[] = [], seen = new Set<number>();
  for (const start of links.keys()) {
    if (seen.has(start)) continue;
    const loop: [number, number][] = [];
    for (let e: number | undefined = start; e !== undefined; e = links.get(e)!.find((q) => !seen.has(q))) seen.add(e), loop.push(point(e));
    let area = 0;
    loop.forEach(([x, y], i) => {
      const [x2, y2] = loop[(i + 1) % loop.length];
      area += x * y2 - x2 * y;
    });
    if (Math.abs(area) / 2 / (S * S) < 0.6) continue;
    // Sample point (x, y) is field cell x / S − P, i.e. butted cell x / S − P + 0.5 from the grid's corner.
    const paper = ([x, y]: [number, number]) => [BOX.x + (x / S - P - 2 + 0.5) * CELL, BOX.y + (y / S - P - 2 + 0.5) * CELL];
    const inkAt = (x: number, y: number) => {
      const gx = Math.floor(x / S - P + 0.5), gy = Math.floor(y / S - P + 0.5);
      const k = gy * 68 + gx;
      return (gx >= 0 && gy >= 0 && gx < 68 && gy < 84 && shade(real, ghost, k)) || bare;
    };
    // One polyline per run of one ink.
    let run: number[] = [], colour = '';
    loop.concat([loop[0]]).forEach((p, i, all) => {
      if (i === 0) return void (run = paper(p));
      const q = all[i - 1], ink = inkAt((p[0] + q[0]) / 2, (p[1] + q[1]) / 2);
      if (ink !== colour && run.length > 2) out.push({ pts: run, stroke: colour, width: 3 * PX }), (run = paper(q));
      colour = ink;
      run.push(...paper(p));
    });
    if (run.length > 2) out.push({ pts: run, stroke: colour, width: 3 * PX });
  }
  return out;
}

/// The page allocated by rating: one cell per Credit round the centre of its ink, sized by its Credit Rating (a
/// power diagram, weight 0.147 cells² per rating point), in the ink it prints most. Low-rated Credits can lose
/// their cell entirely. Close to Jack's mock, not exact: some edges sit a few pixels off his.
function allocated(inks: readonly (Ink | null)[], ghosts: ReadonlySet<number>): Path[] {
  const sites: { x: number; y: number; w: number; colour: string }[] = [];
  const scores = inks.flatMap((ink) => (ink?.score != null ? [ink.score] : []));
  const mean = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;
  inks.forEach((ink, c) => {
    if (!ink) return;
    let n = 0, sx = 0, sy = 0;
    const count = new Array<number>(16).fill(0);
    ink.px.forEach((m, j) => {
      if (m) n++, (sx += j % 12), (sy += Math.floor(j / 12)), count[m]++;
    });
    if (!n) return;
    let top = 1;
    for (let m = 2; m < 16; m++) if (count[m] > count[top]) top = m;
    sites.push({
      x: (c % 8) * 8 + sx / n + 0.5 - 2,
      y: Math.floor(c / 8) * 8 + sy / n + 0.5 - 2,
      w: 0.147 * (ink.score ?? mean),
      colour: (ghosts.has(c) ? FADED : MIX)[top],
    });
  });
  const out: Path[] = [], edges: number[][] = [];
  const on = (a: number[], b: number[]) => (a[0] === b[0] && (a[0] === 0 || a[0] === BOX.w)) || (a[1] === b[1] && (a[1] === 0 || a[1] === BOX.h));
  for (const s of sites) {
    // The box, cut by every other site's half-plane: 2x·(b − a) ≤ |b|² − |a|² − (w_b − w_a).
    let poly = [[0, 0], [BOX.w, 0], [BOX.w, BOX.h], [0, BOX.h]];
    for (const o of sites) {
      if (o === s || !poly.length) continue;
      const nx = 2 * (o.x - s.x), ny = 2 * (o.y - s.y), lim = o.x ** 2 + o.y ** 2 - s.x ** 2 - s.y ** 2 - (o.w - s.w);
      const inside = (p: number[]) => p[0] * nx + p[1] * ny <= lim;
      const cut: number[][] = [];
      poly.forEach((p, i) => {
        const q = poly[(i + 1) % poly.length], pin = inside(p), qin = inside(q);
        if (pin) cut.push(p);
        if (pin !== qin) {
          const t = (lim - p[0] * nx - p[1] * ny) / ((q[0] - p[0]) * nx + (q[1] - p[1]) * ny);
          cut.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]);
        }
      });
      poly = cut;
    }
    if (poly.length < 3) continue;
    const pts = poly.flatMap(([x, y]) => [BOX.x + x * CELL, BOX.y + y * CELL]);
    out.push({ pts, fill: s.colour, closed: true });
    poly.forEach((p, i) => {
      const q = poly[(i + 1) % poly.length];
      if (!on(p, q)) edges.push([BOX.x + p[0] * CELL, BOX.y + p[1] * CELL, BOX.x + q[0] * CELL, BOX.y + q[1] * CELL]);
    });
  }
  for (const pts of edges) out.push({ pts, stroke: '#ffffff', width: 2 * PX });
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
/// three cells of the matching cut in the block beside it lines up with it, so the long lines run straight across.
function balanced(inks: readonly (Ink | null)[], ghosts: ReadonlySet<number>): Rect[] {
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
  // The gutter line nearest `natural` (within three) among those ending at `edge`, the block beside this one.
  const snap = (natural: number, lo: number, hi: number, done: [number, number, number][], edge: number) => {
    let at = natural, off = 4;
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
