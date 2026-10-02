/// The Format Lab: picking 80 real Credits so that one of the Statement formats draws something on purpose, the way a
/// picture union makes Consolidated draw a picture. Pure functions over every Credit's ink (public/lab/inks.bin,
/// scripts/lab-inks.ts): 72 bytes per Credit in id order, its 12 × 12 raster as Statements draw it (inkOf), cell 2k
/// in the low nibble of byte k. Used by the lab page and by scripts/lab-maze.ts alike.
import type { Ink } from './statement';

export type Pool = {
  inks: Uint8Array;
  /// Credits for sale and their prices (wei). When set, only these are used, cheapest first where it matters.
  price?: Map<number, bigint> | null;
};

export const creditsIn = (pool: Pool) => pool.inks.length / 72;
export const pxOf = (pool: Pool, id: number, p: number) => {
  const b = pool.inks[(id - 1) * 72 + (p >> 1)];
  return p & 1 ? b >> 4 : b & 15;
};
/// A Credit's ink for the renderers (its 8s don't matter to the formats the lab plans).
export function inkFor(pool: Pool, id: number): Ink {
  const px = new Uint8Array(144);
  for (let p = 0; p < 144; p++) px[p] = pxOf(pool, id, p);
  return { px, eights: 0 };
}
const usable = (pool: Pool, id: number) => !pool.price || pool.price.has(id);
const costOf = (pool: Pool, id: number) => pool.price?.get(id) ?? 0n;
export const totalCost = (pool: Pool, ids: number[]) => ids.reduce((t, id) => t + costOf(pool, id), 0n);
/// Whether any of a Credit's ink lands outside its own 8 × 8 (a misprint), where it would print on its neighbours.
const spills = (pool: Pool, id: number) => {
  for (let y = 0; y < 12; y++) for (let x = 0; x < 12; x++) if ((x < 2 || x > 9 || y < 2 || y > 9) && pxOf(pool, id, y * 12 + x)) return true;
  return false;
};

/// A seeded generator, so a plan can be made again from its number.
export function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}
const shuffle = <T>(a: T[], rnd: () => number) => {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

// ================================================================ Amortized: a maze
// Amortized outlines every inked region of the page with rings inside, so its paper reads as passages and its ink as
// walls. Each Credit is a room of the 8 × 10 page; a maze is a spanning tree of rooms; a Credit fits a room when one
// paper area of its art (its main area) reaches every door the room needs. Across a shared edge, paper may meet paper
// only main to main and only at a door; the maze's own passages may reach the page's paper margin only at the
// entrance and the exit.

type Room = { id: number; main: number[]; other: number[]; all: number[] }; // per edge N E S W: 8-bit position masks
export type MazeIndex = Room[][]; // by door set (bits N=1 E=2 S=4 W=8)

const EDGE_AT = [(k: number) => k, (k: number) => k * 8 + 7, (k: number) => 56 + k, (k: number) => k * 8];
export function mazeIndex(pool: Pool): MazeIndex {
  const sigs: Room[][] = Array.from({ length: 16 }, () => []);
  const n = creditsIn(pool);
  for (let id = 1; id <= n; id++) {
    if (!usable(pool, id) || spills(pool, id)) continue;
    const paper = new Uint8Array(64);
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) paper[y * 8 + x] = pxOf(pool, id, (y + 2) * 12 + x + 2) ? 0 : 1;
    const comp = new Int16Array(64).fill(-1);
    let nc = 0;
    for (let i = 0; i < 64; i++) {
      if (!paper[i] || comp[i] >= 0) continue;
      const q = [i];
      comp[i] = nc;
      for (let k = 0; k < q.length; k++) {
        const j = q[k], x = j & 7, y = j >> 3;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const X = x + dx, Y = y + dy;
          if (X < 0 || Y < 0 || X > 7 || Y > 7) continue;
          const t = Y * 8 + X;
          if (paper[t] && comp[t] < 0) (comp[t] = nc), q.push(t);
        }
      }
      nc++;
    }
    const pos: number[][] = Array.from({ length: nc }, () => [0, 0, 0, 0]);
    const all = [0, 0, 0, 0];
    for (let e = 0; e < 4; e++)
      for (let k = 0; k < 8; k++) {
        const i = EDGE_AT[e](k);
        if (paper[i]) (pos[comp[i]][e] |= 1 << k), (all[e] |= 1 << k);
      }
    for (let c = 0; c < nc; c++) {
      const sig = pos[c].reduce((s, p, e) => s | (p ? 1 << e : 0), 0);
      if (!sig) continue;
      const room = { id, main: pos[c], other: all.map((a, e) => a & ~pos[c][e]), all };
      for (let s = 1; s < 16; s++) if ((s & sig) === s) sigs[s].push(room);
    }
  }
  return sigs;
}

const MW = 8, MH = 10, DX = [0, 1, 0, -1], DY = [-1, 0, 1, 0];
function fits(a: Room, ea: number, b: Room, eb: number, door: boolean) {
  const meet = a.all[ea] & b.all[eb], mm = a.main[ea] & b.main[eb];
  return door ? mm !== 0 && meet === mm : meet === 0;
}
function borderOk(r: Room, x: number, y: number, doors: number) {
  for (const [e, edge] of [[0, y === 0], [1, x === MW - 1], [2, y === MH - 1], [3, x === 0]] as [number, boolean][]) {
    if (!edge) continue;
    if (doors & (1 << e) ? !r.main[e] : r.main[e]) return false;
  }
  return true;
}
function makeMaze(rnd: () => number) {
  const doors = new Array(MW * MH).fill(0), seen = new Array(MW * MH).fill(false);
  const start = Math.floor(rnd() * MW), stack = [start];
  seen[start] = true;
  while (stack.length) {
    const r = stack[stack.length - 1], x = r % MW, y = Math.floor(r / MW);
    const next = shuffle([0, 1, 2, 3], rnd).find((e) => {
      const X = x + DX[e], Y = y + DY[e];
      return X >= 0 && Y >= 0 && X < MW && Y < MH && !seen[Y * MW + X];
    });
    if (next === undefined) {
      stack.pop();
      continue;
    }
    const t = (y + DY[next]) * MW + x + DX[next];
    doors[r] |= 1 << next;
    doors[t] |= 1 << ((next + 2) % 4);
    seen[t] = true;
    stack.push(t);
  }
  // the exit: the bottom room farthest from the entrance along the maze, so the way through is as long as it gets
  const dist = new Array(MW * MH).fill(-1), q = [start];
  dist[start] = 0;
  for (let k = 0; k < q.length; k++) {
    const r = q[k], x = r % MW, y = Math.floor(r / MW);
    for (let e = 0; e < 4; e++)
      if (doors[r] & (1 << e)) {
        const t = (y + DY[e]) * MW + x + DX[e];
        if (dist[t] < 0) (dist[t] = dist[r] + 1), q.push(t);
      }
  }
  let exit = (MH - 1) * MW;
  for (let x = 0; x < MW; x++) if (dist[(MH - 1) * MW + x] > dist[exit]) exit = (MH - 1) * MW + x;
  doors[start] |= 1;
  doors[exit] |= 4;
  return { doors, start, exit };
}
function solveMaze(index: MazeIndex, doors: number[], rnd: () => number, budget: number) {
  const pick: (Room | null)[] = new Array(MW * MH).fill(null);
  const order = doors.map((d, r) => shuffle(index[d].filter((c) => borderOk(c, r % MW, Math.floor(r / MW), d)), rnd).slice(0, 8000));
  const at = new Array(MW * MH).fill(0), used = new Set<number>();
  let steps = 0, r = 0;
  while (r >= 0 && r < MW * MH) {
    const x = r % MW, y = Math.floor(r / MW), list = order[r];
    let found = false;
    for (; at[r] < list.length; at[r]++) {
      if (++steps > budget) return null;
      const c = list[at[r]];
      if (used.has(c.id)) continue;
      if (x > 0 && !fits(pick[r - 1]!, 1, c, 3, !!(doors[r] & 8))) continue;
      if (y > 0 && !fits(pick[r - MW]!, 2, c, 0, !!(doors[r] & 1))) continue;
      pick[r] = c;
      used.add(c.id);
      at[r]++;
      found = true;
      break;
    }
    if (found) {
      r++;
      continue;
    }
    // Nothing fits: back to the neighbour that constrains this room (left, or above for the first of a row).
    const back = x > 0 ? r - 1 : r - MW;
    for (let k = r; k > back && k >= 0; k--) {
      if (pick[k]) used.delete(pick[k]!.id);
      pick[k] = null;
      at[k] = 0;
    }
    r = back;
    if (r >= 0 && pick[r]) used.delete(pick[r]!.id), (pick[r] = null);
  }
  return r === MW * MH ? (pick as Room[]) : null;
}
/// Each room in turn takes the cheapest Credit that still fits all four neighbours, until nothing changes.
function cheapenMaze(pool: Pool, index: MazeIndex, doors: number[], rooms: Room[]) {
  if (!pool.price) return;
  const used = new Set(rooms.map((r) => r.id));
  for (let pass = 0, changed = true; changed && pass < 6; pass++) {
    changed = false;
    for (let r = 0; r < MW * MH; r++) {
      const x = r % MW, y = Math.floor(r / MW), d = doors[r];
      const ok = (c: Room) =>
        !used.has(c.id) &&
        borderOk(c, x, y, d) &&
        (x === 0 || fits(rooms[r - 1], 1, c, 3, !!(d & 8))) &&
        (y === 0 || fits(rooms[r - MW], 2, c, 0, !!(d & 1))) &&
        (x === MW - 1 || fits(c, 1, rooms[r + 1], 3, !!(d & 2))) &&
        (y === MH - 1 || fits(c, 2, rooms[r + MW], 0, !!(d & 4)));
      let best = rooms[r];
      for (const c of index[d]) if (costOf(pool, c.id) < costOf(pool, best.id) && ok(c)) best = c;
      if (best !== rooms[r]) used.delete(rooms[r].id), used.add(best.id), (rooms[r] = best), (changed = true);
    }
  }
}

/// The page's paper as the formats lay the 80 rasters down (fieldOf, format 1): 76 × 92, the box at (6, 6).
export const FIELD = { w: 76, h: 92 } as const;
export function fieldFor(pool: Pool, ids: number[]) {
  const f = new Uint8Array(FIELD.w * FIELD.h);
  ids.forEach((id, c) => {
    const cx = (c % 8) * 8, cy = Math.floor(c / 8) * 8;
    for (let p = 0; p < 144; p++) {
      const m = pxOf(pool, id, p);
      if (m) f[(cy + Math.floor(p / 12) + 4) * FIELD.w + cx + (p % 12) + 4] |= m;
    }
  });
  return f;
}

export type Maze = { ids: number[]; doors: number[]; start: number; exit: number; path: [number, number][]; leaks: number; cost: bigint; seed: number };
/// A maze from `seed`: tries mazes until one can be built from the pool, then checks it on the drawing itself.
export function planMaze(pool: Pool, index: MazeIndex, seed: number, tries = 40, budget = 400_000): Maze | null {
  const rnd = rng(seed);
  for (let t = 0; t < tries; t++) {
    const m = makeMaze(rnd), rooms = solveMaze(index, m.doors, rnd, budget);
    if (!rooms) continue;
    cheapenMaze(pool, index, m.doors, rooms);
    const ids = rooms.map((r) => r.id);
    return { ...m, ids, ...walk(pool, ids, m.doors, m.start, m.exit), cost: totalCost(pool, ids), seed };
  }
  return null;
}
/// The way through, pixel by pixel through the drawing's paper, and any edge where paper meets paper off a door.
function walk(pool: Pool, ids: number[], doors: number[], start: number, exit: number) {
  const f = fieldFor(pool, ids), W = FIELD.w;
  const inBox = (x: number, y: number) => x >= 6 && x < 70 && y >= 6 && y < 86;
  const sx = 6 + (start % 8) * 8, ex = 6 + (exit % 8) * 8;
  const q: number[] = [], prev = new Int32Array(W * FIELD.h).fill(-2);
  for (let k = 0; k < 8; k++) if (!f[6 * W + sx + k]) q.push(6 * W + sx + k), (prev[6 * W + sx + k] = -1);
  for (let i = 0; i < q.length; i++) {
    const j = q[i], x = j % W, y = Math.floor(j / W);
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const X = x + dx, Y = y + dy, t = Y * W + X;
      if (inBox(X, Y) && !f[t] && prev[t] === -2) (prev[t] = j), q.push(t);
    }
  }
  let end = -1;
  for (let k = 0; k < 8 && end < 0; k++) if (prev[85 * W + ex + k] !== -2) end = 85 * W + ex + k;
  const path: [number, number][] = [];
  for (let i = end; i >= 0; i = prev[i]) path.push([i % W, Math.floor(i / W)]);
  let leaks = 0;
  for (let r = 0; r < MW * MH; r++) {
    const x = r % MW, y = Math.floor(r / MW);
    for (const e of [1, 2]) {
      const X = x + DX[e], Y = y + DY[e];
      if (X >= MW || Y >= MH) continue;
      let meet = false;
      for (let k = 0; k < 8; k++) {
        const [a, b] = e === 1 ? [[6 + x * 8 + 7, 6 + y * 8 + k], [6 + X * 8, 6 + y * 8 + k]] : [[6 + x * 8 + k, 6 + y * 8 + 7], [6 + x * 8 + k, 6 + Y * 8]];
        if (!f[a[1] * W + a[0]] && !f[b[1] * W + b[0]]) meet = true;
      }
      if (meet !== !!(doors[r] & (1 << e))) leaks++;
    }
  }
  return { path: path.reverse(), leaks };
}

// ================================================================ Reconciled: a wave
// Reconciled draws one row per Credit, in burn order: its ink inside its own frame, lined up by colour from the light
// mixes to the dark, so a row is as long as the Credit has inked pixels (0 to 64). Eighty row lengths draw any shape
// that hangs from the left edge: a wave, a skyline, a heartbeat.

export const WAVE_SHAPES = ['Wave', 'Triangle', 'Saw', 'Steps', 'Peaks', 'Heartbeat'] as const;
export type WaveShape = (typeof WAVE_SHAPES)[number];
export const WAVE_COLORS = ['Any', 'Cyan', 'Magenta', 'Yellow', 'Black', 'C M Y K'] as const;
export type WaveColor = (typeof WAVE_COLORS)[number];
export type WaveParams = { shape: WaveShape; color: WaveColor; middle: number; height: number; waves: number; shift: number };

/// Per Credit: how many of its framed pixels print, and which mixes they print in (a bit per mix).
export type WaveIndex = { len: Uint8Array; mixes: Uint16Array; byColorLen: number[][][] }; // byColorLen[color][len] → ids
const SINGLE = { Cyan: 1, Magenta: 2, Yellow: 4, Black: 8 } as const;
export function waveIndex(pool: Pool): WaveIndex {
  const n = creditsIn(pool), len = new Uint8Array(n + 1), mixes = new Uint16Array(n + 1);
  const byColorLen: number[][][] = Array.from({ length: 5 }, () => Array.from({ length: 65 }, () => []));
  for (let id = 1; id <= n; id++) {
    let l = 0, m = 0;
    for (let y = 2; y < 10; y++)
      for (let x = 2; x < 10; x++) {
        const v = pxOf(pool, id, y * 12 + x);
        if (v) (l++, (m |= 1 << v));
      }
    len[id] = l;
    mixes[id] = m;
    if (!usable(pool, id)) continue;
    byColorLen[0][l].push(id); // Any
    ([1, 2, 4, 8] as const).forEach((mask, k) => m === 1 << mask && byColorLen[k + 1][l].push(id));
  }
  // cheapest first within each list, when priced
  if (pool.price) for (const c of byColorLen) for (const l of c) l.sort((a, b) => (costOf(pool, a) < costOf(pool, b) ? -1 : costOf(pool, a) > costOf(pool, b) ? 1 : a - b));
  return { len, mixes, byColorLen };
}
/// The lengths a colour can reach at all in this pool (rows outside them come out as close as the pool allows).
export function waveRange(index: WaveIndex, color: WaveColor) {
  const lists = color === 'C M Y K' ? [1, 2, 3, 4].map((k) => index.byColorLen[k]) : [index.byColorLen[colorSlot(color, 0)]];
  let lo = 64, hi = 0;
  for (const l of lists) for (let n = 0; n <= 64; n++) if (l[n].length) (lo = Math.min(lo, n)), (hi = Math.max(hi, n));
  return { lo, hi };
}
const colorSlot = (color: WaveColor, row: number) => (color === 'Any' ? 0 : color === 'C M Y K' ? 1 + (row % 4) : 1 + (['Cyan', 'Magenta', 'Yellow', 'Black'] as const).indexOf(color as keyof typeof SINGLE));

function shapeAt(shape: WaveShape, t: number) {
  const u = ((t % 1) + 1) % 1; // position within one wave, 0..1
  switch (shape) {
    case 'Wave': return Math.sin(2 * Math.PI * u);
    case 'Triangle': return 1 - 4 * Math.abs(u - 0.5);
    case 'Saw': return 2 * u - 1;
    case 'Steps': return u < 0.5 ? 1 : -1;
    case 'Peaks': return 2 * Math.abs(Math.sin(Math.PI * u)) - 1;
    case 'Heartbeat': {
      // flat, a small bump, then the spike and its dip
      const g = (c: number, w: number) => Math.exp(-(((u - c) / w) ** 2));
      return -0.6 + 0.35 * g(0.25, 0.05) + 1.6 * g(0.5, 0.025) - 0.7 * g(0.55, 0.025) + 0.3 * g(0.75, 0.06);
    }
  }
}
export function waveTargets(p: WaveParams) {
  return Array.from({ length: 80 }, (_, row) => Math.round(Math.max(0, Math.min(64, p.middle + p.height * shapeAt(p.shape, (row * p.waves) / 80 + p.shift / 360)))));
}
export type Wave = { ids: number[]; targets: number[]; got: number[]; off: number; cost: bigint };
/// The Credits for a wave: each row the cheapest unused Credit of its colour at exactly its length, or the nearest
/// length the pool has. Rows that are hardest to fill (the rarest lengths) choose first.
export function planWave(pool: Pool, index: WaveIndex, p: WaveParams): Wave {
  const targets = waveTargets(p), ids = new Array<number>(80).fill(0), used = new Set<number>();
  const rarity = (row: number) => index.byColorLen[colorSlot(p.color, row)][targets[row]].length;
  const rows = Array.from({ length: 80 }, (_, r) => r).sort((a, b) => rarity(a) - rarity(b));
  // Within two pixels of the row's length a cheaper Credit wins (a pixel off is worth 0.01 ETH, two 0.04); past that,
  // the nearest length the pool has.
  const score = (id: number, d: number) => Number(costOf(pool, id)) / 1e18 + 0.01 * d * d;
  for (const row of rows) {
    const lists = index.byColorLen[colorSlot(p.color, row)];
    let chosen = 0, best = Infinity;
    for (let d = 0; d <= 64; d++) {
      for (const n of d ? [targets[row] - d, targets[row] + d] : [targets[row]]) {
        if (n < 0 || n > 64) continue;
        const id = lists[n].find((x) => !used.has(x)); // each list runs cheapest first
        if (id && score(id, d) < best) (best = score(id, d)), (chosen = id);
      }
      if (chosen && d >= 2) break;
    }
    ids[row] = chosen;
    if (chosen) used.add(chosen);
  }
  const got = ids.map((id) => (id ? index.len[id] : 0));
  return { ids, targets, got, off: got.reduce((s, g, i) => s + Math.abs(g - targets[i]), 0), cost: totalCost(pool, ids.filter(Boolean)) };
}

// ================================================================ Accrued: a shape
// Accrued measures the page's ink density (how many plates print at each pixel), blurs it, and draws the one line
// where it crosses the level that 45% of the page sits under. Light Credits inside a shape and dense ones around it
// make that line trace the shape, as long as the shape is about 45% of the page: then the line falls in the gap
// between the two. A smaller shape gets a light band round the page to make up the rest, and the line draws that too.

export type ShapeIndex = { dense: Float32Array; ids: number[] }; // per Credit: framed ink per pixel, 0..4 (64 each)
export function shapeIndex(pool: Pool): ShapeIndex {
  const n = creditsIn(pool), ids: number[] = [];
  const dense = new Float32Array((n + 1) * 64);
  for (let id = 1; id <= n; id++) {
    if (!usable(pool, id) || spills(pool, id)) continue;
    ids.push(id);
    for (let y = 0; y < 8; y++)
      for (let x = 0; x < 8; x++) {
        const m = pxOf(pool, id, (y + 2) * 12 + x + 2);
        dense[id * 64 + y * 8 + x] = (m & 1) + ((m >> 1) & 1) + ((m >> 2) & 1) + ((m >> 3) & 1);
      }
  }
  return { dense, ids };
}
/// The target over the 64 × 80 box: 1 where ink should be dense (around the shape), 0 where light (the shape, and the
/// band round the page a shape under 45% needs).
export const SHAPE_SHARE = 0.45;
export function shapeTarget(mask: Uint8Array) {
  const light = mask.slice();
  let on = light.reduce((s, v) => s + v, 0);
  const want = Math.round(64 * 80 * SHAPE_SHARE);
  for (let b = 0; on < want && b < 32; b++)
    for (let y = 0; y < 80; y++)
      for (let x = 0; x < 64; x++) {
        if (on >= want) break;
        const edge = Math.min(x, y, 63 - x, 79 - y);
        if (edge === b && !light[y * 64 + x]) (light[y * 64 + x] = 1), on++;
      }
  return light.map((v) => (v ? 0 : 1));
}
export type Shape = { ids: number[]; target: Uint8Array; cost: bigint };
/// Each slot takes the unused Credit whose ink best matches the target over its 8 × 8 (dense where 1, paper where 0),
/// the cheapest among near ties. Slots that are all one or the other take from the densest or the lightest.
export function planShape(pool: Pool, index: ShapeIndex, mask: Uint8Array): Shape {
  const target = shapeTarget(mask);
  const used = new Set<number>(), ids = new Array<number>(80).fill(0);
  // rank once: densest and lightest first, for the slots that are all one way
  const total = (id: number) => { let s = 0; for (let k = 0; k < 64; k++) s += index.dense[id * 64 + k]; return s; };
  const byTotal = index.ids.slice().sort((a, b) => total(b) - total(a));
  // dense enough / light enough to sit clearly either side of the line (top and bottom fifth by ink), cheapest first
  const cheap = (ids: number[]) => ids.sort((a, b) => (costOf(pool, a) < costOf(pool, b) ? -1 : costOf(pool, a) > costOf(pool, b) ? 1 : 0));
  const dense = cheap(byTotal.slice(0, Math.ceil(byTotal.length / 5)));
  const light = cheap(byTotal.slice(-Math.ceil(byTotal.length / 5)));
  const slots = Array.from({ length: 80 }, (_, c) => c);
  const part = (c: number) => { let s = 0; for (let k = 0; k < 64; k++) s += target[(Math.floor(c / 8) * 8 + (k >> 3)) * 64 + (c % 8) * 8 + (k & 7)]; return s / 64; };
  // mixed slots first (they need the best matches), then the full and the empty
  slots.sort((a, b) => Math.abs(part(a) - 0.5) - Math.abs(part(b) - 0.5));
  for (const c of slots) {
    const f = part(c);
    let pick = 0;
    if (f === 1) pick = dense.find((id) => !used.has(id)) ?? 0;
    else if (f === 0) pick = light.find((id) => !used.has(id)) ?? 0;
    else {
      // the best matches over this slot's 8 × 8, then the cheapest of those within a tenth of the best
      const scored: [number, number][] = [];
      for (const id of index.ids) {
        if (used.has(id)) continue;
        let err = 0;
        for (let k = 0; k < 64; k++) {
          const t = target[(Math.floor(c / 8) * 8 + (k >> 3)) * 64 + (c % 8) * 8 + (k & 7)] ? 2.5 : 0;
          const d = index.dense[id * 64 + k] - t;
          err += d * d;
        }
        scored.push([err, id]);
      }
      const best = Math.min(...scored.map(([e]) => e));
      for (const [e, id] of scored) if (e <= best * 1.1 && (!pick || costOf(pool, id) < costOf(pool, pick))) pick = id;
    }
    ids[c] = pick;
    if (pick) used.add(pick);
  }
  return { ids, target, cost: totalCost(pool, ids.filter(Boolean)) };
}

// ================================================================ designs for anyone to fill
// A Painted union names a Colors for each slot, and anyone joins in any order. Ink follows plates closely (one plate
// inks about half its pixels, four about 15 in 16), so Colors alone steer the formats that read density or length:
// Accrued traces a shape drawn in one-plate slots on a field of CMYK, and Reconciled's rows step with plate count.

const heartCurve = (X: number, Y: number) => (X * X + Y * Y - 1) ** 3 - X * X * Y ** 3 < 0;
const stem = (x: number, y: number, top: number) => y + 0.5 > top && y + 0.5 < 76 && Math.abs(x + 0.5 - 32) < 3 + (y + 0.5 - top) * 0.45;
/// Shapes on the 64 × 80 box, each about 45% of it, where Accrued's line traces it and nothing else.
export const SHAPES: Record<string, (x: number, y: number) => boolean> = {
  Spades: (x, y) => heartCurve((x + 0.5 - 32) / 24, (y + 0.5 - 30) / 24) || stem(x, y, 48),
  Hearts: (x, y) => heartCurve((x + 0.5 - 32) / 25, -(y + 0.5 - 44) / 25),
  Diamonds: (x, y) => Math.abs(x + 0.5 - 32) / 28 + Math.abs(y + 0.5 - 40) / 39 < 1,
  Clubs: (x, y) => [[32, 22], [17, 43], [47, 43]].some(([cx, cy]) => (x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2 < 14 * 14) || (Math.abs(x + 0.5 - 32) < 6 && y > 28 && y < 50) || stem(x, y, 50),
  Circle: (x, y) => (x + 0.5 - 32) ** 2 + (y + 0.5 - 40) ** 2 < 27 ** 2,
  Cross: (x, y) => Math.abs(x + 0.5 - 32) < 9 || Math.abs(y + 0.5 - 40) < 9,
  Ring: (x, y) => { const r = Math.hypot(x + 0.5 - 32, y + 0.5 - 40); return r < 31 && r > 15; },
};
export const SHAPE_INKS = ['Mixed', 'Cyan', 'Magenta', 'Yellow', 'Black'] as const;
export type ShapeInk = (typeof SHAPE_INKS)[number];
const ONE_PLATE = [1, 2, 4, 8]; // C M Y K masks
/// A shape as 80 slot Colors (plate masks): one plate where at least half the slot is inside, CMYK elsewhere.
export function shapeColors(shape: (x: number, y: number) => boolean, ink: ShapeInk = 'Mixed') {
  return Array.from({ length: 80 }, (_, c) => {
    let inside = 0;
    for (let k = 0; k < 64; k++) if (shape((c % 8) * 8 + (k & 7), Math.floor(c / 8) * 8 + (k >> 3))) inside++;
    if (inside < 32) return 15;
    return ink === 'Mixed' ? ONE_PLATE[c % 4] : ONE_PLATE[SHAPE_INKS.indexOf(ink) - 1];
  });
}
/// Plate counts' Colors, cycled row by row for colour: 1 plate (rows of ~32 pixels), 2 (~48), 3 (~56), 4 (~60).
const BY_PLATES = [[1, 2, 4, 8], [3, 5, 6, 9, 10, 12], [7, 11, 13, 14], [15]];
/// A wave as 80 slot Colors: each row's length picks a plate count, rising from about 32 pixels to about 60.
export function waveColors(p: Pick<WaveParams, 'shape' | 'waves' | 'shift'>) {
  return waveTargets({ ...p, color: 'Any', middle: 46, height: 14 }).map((t, r) => {
    const k = t < 40 ? 0 : t < 52 ? 1 : t < 58 ? 2 : 3;
    return BY_PLATES[k][r % BY_PLATES[k].length];
  });
}
