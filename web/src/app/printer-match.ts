/// The Printer's matcher: which 80 Credits draw a picture in the Consolidated view, one Credit per 8 × 8 patch.
///
/// Each patch is compared with each candidate's print (wall.bin: its 8 × 8 cells as they print) at three scales,
/// colour and, where the picture has detail, lightness. The 80 must rise by Credit number across the sheet, left to
/// right and top to bottom, because the union burns them in Number order; the best rising set is found exactly
/// (dynamic programming over the candidates in number order). Credits the friends already own cost nothing; a
/// friend holding more than their share is eased back (their Credits cost a little more each round) until everyone
/// fits. Listings then go to whoever has room left, in turn.
import { MIX } from '../shared/statement';
import { BAYER, HUE } from '../shared/formats/statement-renderers';

export type Candidate = { id: number; price: number; owner: number }; // price in ETH; owner: wallet index, -1 for a listing
export type Pick = { id: number; wallet: number; owned: boolean; price: number };
/// `own`: how much likeness to give up to use a Credit the wallets already hold instead of buying one (0 = none;
/// 1 = a patch may be up to about half as good again as the best buy).
/// `free`: no rising-number rule (a solo print: one wallet deposits all 80 in slot order).
/// `look`: the format the picture is matched in. Consolidated draws each Credit's own cells; Assessed draws it as one
/// block of its main ink, as dense as it's inked; Reconciled as one bar across the page, its inks in hue order, as
/// long as it's inked.
export type Look = 'Consolidated' | 'Assessed' | 'Reconciled';
export type Params = { features: number; maxPrice: number; own?: number; budget?: number | null; free?: boolean; look?: Look };
/// What each ETH of listings costs in likeness by default (a typical patch's error is ~250k).
const PRICE_WEIGHT = 2e5;
const OWN_BONUS = 250_000; // a typical patch's match error, per unit of `own`

const RGB = MIX.map((h, m) => (m === 0 ? [255, 255, 255] : [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16))));
const LUM = RGB.map(([r, g, b]) => 0.3 * r + 0.59 * g + 0.11 * b);

/// One Credit's print at the scales the cost reads: 4 × 4 blocks of 2 × 2 cells, 2 × 2 blocks of 4 × 4, and cells.
type Print = { cells: Float32Array; b2: Float32Array; b4: Float32Array; l2: Float32Array };
const prints = new Map<string, Print>();
const HUE_RANK = HUE.reduce((r, m, i) => ((r[m] = i), r), new Array<number>(16).fill(0));
/// A Credit's 64 cells as `look` draws them in its square: as printed, or (Assessed) its most-used ink, ties to the
/// earlier hue, on the cells whose Bayer threshold is under how many of its cells are inked.
function cellsOf(id: number, wall: Uint8Array, look: Look): number[] {
  const raw = Array.from({ length: 64 }, (_, c) => {
    const byte = wall[(id - 1) * 32 + (c >> 1)];
    return c & 1 ? byte >> 4 : byte & 15;
  });
  if (look !== 'Assessed') return raw;
  const n = new Array<number>(16).fill(0);
  let k = 0;
  for (const m of raw) if (m) (n[m]++, k++);
  let t = 0;
  for (let m = 1; m < 16; m++) if (n[m] && (!t || n[m] > n[t] || (n[m] === n[t] && HUE_RANK[m] < HUE_RANK[t]))) t = m;
  return raw.map((_, c) => (BAYER[c >> 3][c & 7] < k ? t : 0));
}
function printOf(id: number, wall: Uint8Array, look: Look = 'Consolidated'): Print {
  const key = `${look}:${id}`;
  let p = prints.get(key);
  if (p) return p;
  const cells = new Float32Array(192), b2 = new Float32Array(48), b4 = new Float32Array(12), l2 = new Float32Array(16);
  const ink = cellsOf(id, wall, look);
  for (let c = 0; c < 64; c++) {
    const m = ink[c];
    const x = c & 7, y = c >> 3, k2 = (y >> 1) * 4 + (x >> 1), k4 = (y >> 2) * 2 + (x >> 2);
    for (let ch = 0; ch < 3; ch++) {
      cells[c * 3 + ch] = RGB[m][ch];
      b2[k2 * 3 + ch] += RGB[m][ch] / 4;
      b4[k4 * 3 + ch] += RGB[m][ch] / 16;
    }
    l2[k2] += LUM[m] / 4;
  }
  p = { cells, b2, b4, l2 };
  prints.set(key, p);
  return p;
}

/// The picture's patches at the same scales, plus how much detail each has (lightness spread).
function patches(target: Uint8ClampedArray) {
  return Array.from({ length: 80 }, (_, t) => {
    const cells = new Float32Array(192), b2 = new Float32Array(48), b4 = new Float32Array(12), l2 = new Float32Array(16);
    const lums: number[] = [];
    for (let c = 0; c < 64; c++) {
      const x = (t % 8) * 8 + (c & 7), y = Math.floor(t / 8) * 8 + (c >> 3), i = (y * 64 + x) * 4;
      const k2 = ((c >> 3) >> 1) * 4 + ((c & 7) >> 1), k4 = ((c >> 3) >> 2) * 2 + ((c & 7) >> 2);
      const lum = 0.3 * target[i] + 0.59 * target[i + 1] + 0.11 * target[i + 2];
      lums.push(lum);
      for (let ch = 0; ch < 3; ch++) {
        cells[c * 3 + ch] = target[i + ch];
        b2[k2 * 3 + ch] += target[i + ch] / 4;
        b4[k4 * 3 + ch] += target[i + ch] / 16;
      }
      l2[k2] += lum / 4;
    }
    const mean = lums.reduce((a, b) => a + b, 0) / 64;
    const detail = Math.sqrt(lums.reduce((a, b) => a + (b - mean) ** 2, 0) / 64) / 30;
    return { cells, b2, b4, l2, detail };
  });
}

const sq = (a: Float32Array, b: Float32Array) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += (a[i] - b[i]) ** 2;
  return s;
};

/// Assessed draws each square as one ink at a density, so a patch is read the same way: each pixel to its nearest
/// ink (or the paper), the ink most of them take, and how many are inked. A Credit's block is its most-used ink, as
/// dense as it's inked. A different ink costs a lot (more the further apart they look); density, by how far off.
function assessedCosts(target: Uint8ClampedArray, cands: Candidate[], wall: Uint8Array, p: Params, priceWeight: number) {
  const majority = (n: number[]) => {
    let t = 0;
    for (let m = 1; m < 16; m++) if (n[m] && (!t || n[m] > n[t] || (n[m] === n[t] && HUE_RANK[m] < HUE_RANK[t]))) t = m;
    return t;
  };
  const want = Array.from({ length: 80 }, (_, slot) => {
    const n = new Array<number>(16).fill(0);
    let k = 0;
    for (let c = 0; c < 64; c++) {
      const x = (slot % 8) * 8 + (c & 7), y = Math.floor(slot / 8) * 8 + (c >> 3), i = (y * 64 + x) * 4;
      const best = nearestInk(target, i);
      if (best) (n[best]++, k++);
    }
    return { t: majority(n), k };
  });
  const have = cands.map((c) => {
    const n = new Array<number>(16).fill(0);
    let k = 0;
    for (const m of cellsOf(c.id, wall, 'Consolidated')) if (m) (n[m]++, k++);
    return { t: majority(n), k };
  });
  const own = (p.own ?? 0) * OWN_BONUS;
  return want.map((w) => {
    const row = new Float32Array(cands.length);
    for (let j = 0; j < cands.length; j++) {
      const h = have[j];
      const ink = h.t === w.t ? 0 : 150_000 + (RGB[h.t][0] - RGB[w.t][0]) ** 2 + (RGB[h.t][1] - RGB[w.t][1]) ** 2 + (RGB[h.t][2] - RGB[w.t][2]) ** 2;
      row[j] = ink + 300 * (h.k - w.k) ** 2 + cands[j].price * priceWeight - (cands[j].owner >= 0 ? own : 0);
    }
    return row;
  });
}

/// The nearest ink (or the paper, 0) to a pixel of the picture.
function nearestInk(target: Uint8ClampedArray, i: number) {
  let best = 0, d = Infinity;
  for (let m = 0; m < 16; m++) {
    const e = (RGB[m][0] - target[i]) ** 2 + (RGB[m][1] - target[i + 1]) ** 2 + (RGB[m][2] - target[i + 2]) ** 2;
    if (e < d) (d = e), (best = m);
  }
  return best;
}

/// Reconciled draws slot `r` as row `r` of the page: a bar of the Credit's inks, each as long as its count of cells,
/// in hue order. So the picture's row `r` of 64 pixels is read as how many take each ink, and a Credit costs how far
/// its own counts are from those.
function reconciledCosts(target: Uint8ClampedArray, cands: Candidate[], wall: Uint8Array, p: Params, priceWeight: number) {
  const want = Array.from({ length: 80 }, (_, row) => {
    const n = new Array<number>(16).fill(0);
    for (let x = 0; x < 64; x++) n[nearestInk(target, (row * 64 + x) * 4)]++;
    return n;
  });
  const have = cands.map((c) => {
    const n = new Array<number>(16).fill(0);
    for (const m of cellsOf(c.id, wall, 'Consolidated')) n[m]++;
    return n;
  });
  const own = (p.own ?? 0) * OWN_BONUS;
  return want.map((w) => {
    const row = new Float32Array(cands.length);
    for (let j = 0; j < cands.length; j++) {
      let e = 0;
      for (let m = 1; m < 16; m++) e += (have[j][m] - w[m]) ** 2;
      row[j] = 1000 * e + cands[j].price * priceWeight - (cands[j].owner >= 0 ? own : 0);
    }
    return row;
  });
}

/// How far each candidate is from each patch: 80 rows of candidates, in the order given.
export async function costs(target: Uint8ClampedArray, cands: Candidate[], wall: Uint8Array, p: Params, progress?: (f: number) => void, priceWeight = PRICE_WEIGHT) {
  if (p.look === 'Assessed') return (progress?.(1), assessedCosts(target, cands, wall, p, priceWeight));
  if (p.look === 'Reconciled') return (progress?.(1), reconciledCosts(target, cands, wall, p, priceWeight));
  const ps = patches(target);
  const pr = cands.map((c) => printOf(c.id, wall, p.look));
  const out = Array.from({ length: 80 }, () => new Float32Array(cands.length));
  const own = (p.own ?? 0) * OWN_BONUS, price = priceWeight;
  for (let t = 0; t < 80; t++) {
    const q = ps[t], row = out[t], w = p.features * q.detail * 3;
    for (let j = 0; j < cands.length; j++) {
      const c = pr[j];
      row[j] = 4 * sq(q.b4, c.b4) + sq(q.b2, c.b2) + 0.15 * sq(q.cells, c.cells) + w * sq(q.l2, c.l2) + cands[j].price * price - (cands[j].owner >= 0 ? own : 0);
    }
    if (t % 8 === 7) {
      progress?.((t + 1) / 80);
      await new Promise((r) => setTimeout(r)); // let the page breathe
    }
  }
  return out;
}

/// The cheapest set of 80 whose numbers rise across the sheet. `cands` must be in number order.
export function rising(cost: Float32Array[], extra?: Float32Array): number[] {
  const n = cost[0].length;
  const back = new Int32Array(80 * n);
  let dp = new Float64Array(n);
  for (let j = 0; j < n; j++) dp[j] = cost[0][j] + (extra?.[j] ?? 0);
  for (let t = 1; t < 80; t++) {
    const next = new Float64Array(n);
    let best = Infinity, arg = -1;
    for (let j = 0; j < n; j++) {
      next[j] = best + cost[t][j] + (extra?.[j] ?? 0);
      back[t * n + j] = arg;
      if (dp[j] < best) (best = dp[j]), (arg = j);
    }
    dp = next;
  }
  let j = 0;
  for (let k = 1; k < n; k++) if (dp[k] < dp[j]) j = k;
  if (!Number.isFinite(dp[j])) throw new Error('Not enough Credits to draw it. Raise the max price or add wallets.');
  const out = new Array<number>(80);
  for (let t = 79; t >= 0; t--) (out[t] = j), (j = back[t * n + j]);
  return out;
}

/// The best Credit for each patch with no order to keep: the most detailed patches choose first.
function greedy(cost: Float32Array[], extra: Float32Array, order: number[]): number[] {
  const n = cost[0].length, used = new Uint8Array(n), out = new Array<number>(80);
  for (const t of order) {
    let best = -1, bv = Infinity;
    const row = cost[t];
    for (let j = 0; j < n; j++) {
      if (used[j]) continue;
      const v = row[j] + extra[j];
      if (v < bv) (bv = v), (best = j);
    }
    if (best < 0) throw new Error('Not enough Credits to draw it. Raise the max price.');
    used[best] = 1;
    out[t] = best;
  }
  return out;
}

/// What a print came to: the picks, what the listings in it cost, and the range a budget can move in: `floor` is the
/// cheapest rising set (the least 80 can cost), `top` the best likeness under the per-Credit limit.
export type Printed = { picks: Pick[]; spend: number; floor: number; top: number };

/// Match, keep every friend at or under their cap (`caps`: slots each may bring), and split the listings. With a
/// budget, price weighs in exactly as much as it must for the listings to fit (bisected).
export async function print(target: Uint8ClampedArray, cands: Candidate[], wall: Uint8Array, caps: number[], p: Params, progress?: (f: number) => void): Promise<Printed> {
  if (caps.length && caps.reduce((a, b) => a + b, 0) < 80) throw new Error('The max percentages add up to less than 100%.');
  const ok = cands.filter((c) => c.owner >= 0 || c.price <= p.maxPrice).sort((a, b) => a.id - b.id);
  const cost = await costs(target, ok, wall, p, progress, 0);
  const price = Float32Array.from(ok, (c) => (c.owner >= 0 ? 0 : c.price));
  const order = p.free ? patches(target).map((q, t) => [q.detail, t]).sort((a, b) => b[0] - a[0]).map(([, t]) => t) : [];
  const at = (lambda: number) => {
    const extra = price.map((x) => x * lambda);
    const slots = p.free ? greedy(cost, extra, order) : rising(cost, extra);
    return { slots, extra, spend: slots.reduce((n, j) => n + price[j], 0) };
  };
  const floor = at(1e10).spend, top = at(0).spend;
  let run = at(PRICE_WEIGHT);
  if (p.budget != null) {
    if (p.budget >= top) run = at(0);
    else if (p.budget <= floor) run = at(1e10);
    else {
      let lo = 1e2, hi = 1e10; // bisect λ in log space: the least weight on price that fits
      run = at(hi);
      for (let i = 0; i < 26; i++) {
        const mid = Math.sqrt(lo * hi), r = at(mid);
        if (r.spend <= p.budget) (hi = mid), (run = r);
        else lo = mid;
      }
    }
  }
  const { slots, extra } = run;
  const used = new Set(slots);
  // Anyone bringing more than their cap gives up the slots that cost the picture least to fill otherwise, one at
  // a time: each such slot takes the best Credit between its neighbours' numbers that isn't theirs.
  for (; !p.free; ) {
    const mine = caps.map((_, w) => slots.filter((j) => ok[j].owner === w).length);
    const over = mine.findIndex((n, w) => n > caps[w]);
    if (over < 0) break;
    let best: { t: number; j: number; d: number } | null = null;
    for (let t = 0; t < 80; t++) {
      if (ok[slots[t]].owner !== over) continue;
      const lo = t > 0 ? slots[t - 1] : -1, hi = t < 79 ? slots[t + 1] : ok.length;
      for (let j = lo + 1; j < hi; j++) {
        if (used.has(j) || ok[j].owner === over || (ok[j].owner >= 0 && mine[ok[j].owner] >= caps[ok[j].owner])) continue;
        const d = cost[t][j] + extra[j] - cost[t][slots[t]] - extra[slots[t]];
        if (!best || d < best.d) best = { t, j, d };
      }
    }
    if (!best) throw new Error('Couldn’t keep everyone under their max. Raise someone’s max percentage.');
    used.delete(slots[best.t]);
    used.add(best.j);
    slots[best.t] = best.j;
  }
  const room = caps.map((cap, w) => cap - slots.filter((j) => ok[j].owner === w).length);
  // Listings to whoever has the most room left, one at a time, so the buying is shared out.
  const picks = slots.map((j): Pick => {
    const c = ok[j];
    if (c.owner >= 0) return { id: c.id, wallet: c.owner, owned: true, price: 0 };
    if (!room.length) return { id: c.id, wallet: -1, owned: false, price: c.price }; // no wallets yet: just the picture
    const w = room.indexOf(Math.max(...room));
    room[w]--;
    return { id: c.id, wallet: w, owned: false, price: c.price };
  });
  return { picks, spend: picks.reduce((n, x) => n + x.price, 0), floor, top };
}

/// A replacement for one slot: the best Credit between its neighbours' numbers, not already used.
export async function replace(target: Uint8ClampedArray, slot: number, lo: number, hi: number, used: Set<number>, cands: Candidate[], wall: Uint8Array, p: Params) {
  const ok = cands.filter((c) => c.id > lo && c.id < hi && !used.has(c.id) && (c.owner >= 0 || c.price <= p.maxPrice));
  if (!ok.length) return null;
  const row = (await costs(target, ok, wall, p))[slot];
  let j = 0;
  for (let k = 1; k < ok.length; k++) if (row[k] < row[j]) j = k;
  return ok[j];
}
