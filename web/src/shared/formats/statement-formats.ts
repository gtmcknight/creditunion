// @ts-nocheck
// Reference implementation of the four Statement formats' pixel fields, as StatementFormats.sol
// draws them. Integer math throughout, so every implementation lands on the same pixels. Keep it exact.
//
//   0 issued        the page as StatementArt.inkPage draws it (no field)
//   1 consolidated  every cell's 12 × 12 raster on the 8-pixel pitch (ink ORs across cells)
//   2 balanced      the page's ink as blocks, one per mix, sized to its share, 1-pixel gutters
//   3 reconciled    one line per cell: its 64 square pixels, sorted by colour
//
// A field is 76 × 92 pixels: the 64 × 80 grid of the Statement's squares edge to edge, inside
// a 6-pixel paper margin. Each pixel is a plate mask (0 paper, C 1, M 2, Y 4, K 8).
export const FW = 76, FH = 92, MARGIN = 6;
export const HUE = [0, 6, 2, 1, 4, 5, 3, 7, 12, 11, 9, 10, 8, 13, 14, 15];
const hueRank = (m) => HUE.indexOf(m);
const square = (cell) => { const out = []; for (let y = 2; y < 10; y++) for (let x = 2; x < 10; x++) out.push(cell[y * 12 + x]); return out; };

function snapCut(lines, vertical, pos, from, to, lo, hi) {
  let best = pos, dist = 4;
  for (const l of lines) {
    if (l.vertical !== vertical) continue;
    const gap = Math.max(l.from - to, from - l.to);
    if (gap < 1 || gap > 2) continue;
    const d = Math.abs(l.pos - pos);
    if (d > 0 && d < dist && l.pos >= lo && l.pos <= hi) { dist = d; best = l.pos; }
  }
  return best;
}
export function blocks(items, x, y, w, h, out, lines = []) {
  if (!items.length || w <= 0 || h <= 0) return;
  if (items.length === 1) { out.push({ mix: items[0].mix, x, y, w, h }); return; }
  const total = items.reduce((a, i) => a + i.n, 0);
  let acc = 0, cut = 1, best = Infinity, sumA = 0;
  for (let k = 1; k < items.length; k++) { acc += items[k - 1].n; const d = Math.abs(2 * acc - total); if (d < best) { best = d; cut = k; sumA = acc; } }
  const A = items.slice(0, cut), B = items.slice(cut);
  const g = (w >= h ? w : h) >= 3 ? 1 : 0;
  const share = (len) => Math.floor((2 * (len - g) * sumA + total) / (2 * total)); // round half up
  if (w >= h) {
    let wa = Math.min(w - g - 1, Math.max(1, share(w)));
    if (g) { wa = snapCut(lines, true, x + wa, y, y + h - 1, x + 1, x + w - 2) - x; lines.push({ vertical: true, pos: x + wa, from: y, to: y + h - 1 }); }
    blocks(A, x, y, wa, h, out, lines); blocks(B, x + wa + g, y, w - wa - g, h, out, lines);
  } else {
    let ha = Math.min(h - g - 1, Math.max(1, share(h)));
    if (g) { ha = snapCut(lines, false, y + ha, x, x + w - 1, y + 1, y + h - 2) - y; lines.push({ vertical: false, pos: y + ha, from: x, to: x + w - 1 }); }
    blocks(A, x, y, w, ha, out, lines); blocks(B, x, y + ha + g, w, h - ha - g, out, lines);
  }
}
// Balanced: all 80 squares, edge to edge, each one mix. Each mix gets a whole number of squares from its
// share of the inked square pixels (floor of 80 · n / total, then one more each to the largest
// remainders, ties to the mix listed first), laid in page order in items' order. A one-pixel paper
// line runs on the right or bottom edge of a square where the next square is a different mix.
export function tiles(items) {
  const total = items.reduce((a, i) => a + i.n, 0), out = new Array(80).fill(0);
  tiles.last = out;
  if (!total) return out;
  const q = items.map((it) => Math.floor((80 * it.n) / total));
  const left = 80 - q.reduce((a, b) => a + b, 0);
  const byRem = items.map((it, k) => ({ k, r: (80 * it.n) % total })).sort((a, b) => b.r - a.r || a.k - b.k);
  for (let j = 0; j < left; j++) q[byRem[j].k]++;
  let t = 0; items.forEach((it, k) => { for (let j = 0; j < q[k]; j++) out[t++] = it.mix; });
  return out;
}
// cells: 80 arrays of at least 144 plate masks (the 12 × 12 raster).
export function fieldOf(cells, format) {
  const f = new Uint8Array(FW * FH), put = (x, y, m) => { f[(y + MARGIN) * FW + x + MARGIN] = m; };
  if (format === 1) {
    cells.forEach((cell, c) => {
      const cx = (c % 8) * 8, cy = Math.floor(c / 8) * 8;
      for (let p = 0; p < 144; p++) if (cell[p]) f[(cy + Math.floor(p / 12) + 4) * FW + cx + (p % 12) + 4] |= cell[p];
    });
  } else if (format === 2) {
    // each Credit's square becomes one tile, in place: the mix it prints most (ties along the colour
    // wheel), or paper; 7 × 7 at an 8-pixel pitch, so a one-pixel paper line runs round every tile
    cells.forEach((cell, c) => {
      const n = new Array(16).fill(0); square(cell).forEach((m) => m && n[m]++);
      let top = 0; for (let m = 1; m < 16; m++) if (n[m] && (!top || n[m] > n[top] || (n[m] === n[top] && hueRank(m) < hueRank(top)))) top = m;
      if (top) for (let y = 0; y < 7; y++) for (let x = 0; x < 7; x++) put((c % 8) * 8 + x, Math.floor(c / 8) * 8 + y, top);
    });
  } else if (format === 3) {
    cells.forEach((cell, c) => {
      const counts = new Array(16).fill(0); square(cell).forEach((m) => m && counts[m]++);
      let x = 0;
      for (const m of HUE) if (m) for (let k = 0; k < counts[m]; k++) put(x++, c, m);
    });
  }
  return f;
}
// 240 ink words (BigInt), three per cell, pixel i in word i / 64 at bits (i % 64) * 4.
export const cellsOfInk = (words) => Array.from({ length: 80 }, (_, c) => Array.from({ length: 144 }, (_, i) => Number((words[c * 3 + (i >> 6)] >> BigInt((i % 64) * 4)) & 15n)));
