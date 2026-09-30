// @ts-nocheck
// Reference for the on-chain Statement renderers beyond StatementArt and StatementFormats:
//   Assessed   (format 2) each Credit as its most-printed mix, dithered to the share of its square it inks
//   Liquidated (format 6) the page's ink poured into one column, mixes in colour-wheel order, dithered
//   Recorded   (format 7, binary()) every pixel written as a 1 in its ink or a 0 in black
//   Voided     (not installed) the Issued page with each ink region reduced to its outline, eights marks kept
//   Amortized  every inked pixel of the Consolidated field is land; a ring on each pixel edge where
//              the ground steps one pixel nearer the coast (chessboard distance)
//   Accrued    ink heights summed over the Statement's pages (up to 16), smoothed, cut by one contour where
//              55% of the page is land; each segment takes the colour of the nearest ink
//   Allocated  (not installed) one country per Credit: a power diagram of the Credits' ink centres, weighted by
//              each Credit's rating; countries filled in the ink the Credit prints most
// Whole-number arithmetic throughout (BigInt where products grow), so the renderer contracts can
// match the SVG byte for byte. Each renderer returns a model: a list of groups, each with an SVG
// transform and items {fill|stroke, d}; svgOf(model) is the exact string the contract returns and
// paintModel(ctx, w, model) draws the same shapes on a canvas.
import { fieldOf, cellsOfInk } from './statement-formats';

export const FW = 76, FH = 92, M = 6;
const INKS = [0x00b5e2, 0xe4007c, 0xffd100, 0x111111];
export const PALETTE = Array.from({ length: 16 }, (_, mask) => {
  let r = 255, g = 255, b = 255;
  for (let l = 0; l < 4; l++) if (mask & (1 << l)) { const c = INKS[l]; r = Math.floor((r * ((c >> 16) & 255) + 127) / 255); g = Math.floor((g * ((c >> 8) & 255) + 127) / 255); b = Math.floor((b * (c & 255) + 127) / 255); }
  return '#' + ((r << 16) | (g << 8) | b).toString(16).padStart(6, '0');
});
// hundredths → "12", "12.5" or "12.05"
export const num = (v) => { const i = Math.floor(v / 100), f = v % 100; return f === 0 ? `${i}` : f % 10 === 0 ? `${i}.${f / 10}` : `${i}.${String(f).padStart(2, '0')}`; };
const pop = (m) => (m & 1) + ((m >> 1) & 1) + ((m >> 2) & 1) + ((m >> 3) & 1);

// ---------------------------------------------------------------- black paper
// From INVERTED_AT overprints on, a Statement prints on black paper, for good: the paper and pure
// black trade places, black ink alone turns #eeeeee, every other colour stays (Statements.sol
// _swapPaper, applied to whatever the format draws).
export const INVERTED_AT = 8;
const SWAP = { ffffff: '000000', '000000': 'ffffff', '111111': 'eeeeee' };
export const paperSwap = (svg) => svg.replace(/#(ffffff|000000|111111)/g, (_, c) => '#' + SWAP[c]);
export const paperColor = (c) => { const k = c.replace(/\s/g, '').toLowerCase(); return k === '#fff' || k === '#ffffff' || k === 'rgb(255,255,255)' ? '#000000' : k === '#000' || k === '#000000' || k === 'rgb(0,0,0)' ? '#ffffff' : k === '#111111' || k === 'rgb(17,17,17)' ? '#eeeeee' : c; };

// ---------------------------------------------------------------- output
// model: { head, groups: [{ open, close, t: [a,b,c,d,e,f] (viewBox units), items: [{ kind, color, width, cap, join, d }] }], tail }
export function svgOf(model) {
  let s = model.head;
  for (const g of model.groups) { s += g.open; for (const it of g.items) s += it.svg; s += g.close; }
  return s + model.tail;
}
export function paintModel(ctx, w, model, inverted = false) {
  const h = Math.round(w * 1.25), k = w / model.vw, C = inverted ? paperColor : (c) => c;
  ctx.save(); ctx.fillStyle = C('#fff'); ctx.fillRect(0, 0, w, h);
  for (const g of model.groups) {
    const [a, b, c, d, e, f] = g.t;
    ctx.setTransform(a * k, b * k, c * k, d * k, e * k, f * k);
    for (const it of g.items) {
      const p = new Path2D(it.d);
      if (it.kind === 'fill') { ctx.fillStyle = C(it.color); ctx.fill(p); if (it.stroke) { ctx.strokeStyle = C(it.stroke); ctx.lineWidth = it.width; ctx.lineJoin = it.join || 'miter'; ctx.stroke(p); } }
      else if (it.kind === 'rect') { ctx.fillStyle = C(it.color); ctx.fillRect(it.x, it.y, 1, 1); }
      else { ctx.strokeStyle = C(it.color); ctx.lineWidth = it.width; ctx.lineCap = it.cap; ctx.lineJoin = it.join || 'miter'; ctx.stroke(p); }
    }
  }
  ctx.restore();
}
const FIELD_HEAD = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 76 95"><rect width="76" height="95" fill="#ffffff"/>';
const stroke = (color, d, width, cap, join) => ({ kind: 'stroke', color, d, width, cap, join, svg: `<path stroke="${color}" d="${d}"/>` });

// Merge unit edges into runs. edges: Map key "line,pos" → per mix; returns path data per mix.
// h[m][y] = sorted x starts of horizontal unit edges on line y; v[m][x] = sorted y starts on line x.
function runsToPath(hs, vs, offX = 0, offY = 0) {
  let d = '';
  for (const [y, xs] of hs) { let i = 0; while (i < xs.length) { let j = i; while (j + 1 < xs.length && xs[j + 1] === xs[j] + 1) j++; d += `M${xs[i] + offX} ${y + offY}h${j - i + 1}`; i = j + 1; } }
  for (const [x, ys] of vs) { let i = 0; while (i < ys.length) { let j = i; while (j + 1 < ys.length && ys[j + 1] === ys[j] + 1) j++; d += `M${x + offX} ${ys[i] + offY}v${j - i + 1}`; i = j + 1; } }
  return d;
}
// Collect unit edges per mix in a deterministic order: lines ascending, positions ascending.
function edgeSets() { return Array.from({ length: 16 }, () => ({ h: new Map(), v: new Map() })); }
const addEdge = (map, line, pos) => { if (!map.has(line)) map.set(line, []); map.get(line).push(pos); };
const sortedEntries = (map) => [...map.entries()].sort((a, b) => a[0] - b[0]).map(([k, v]) => [k, v.sort((p, q) => p - q)]);

// ---------------------------------------------------------------- Voided
export function voided(words, eights) {
  const cells = cellsOfInk(words), groups = [];
  const head = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10000 12500"><rect width="10000" height="12500" fill="#ffffff"/><g fill="none" stroke-width="0.2" stroke-linecap="square">';
  cells.forEach((cell, c) => {
    const X = 800 + (c % 8) * 1050, Y = 820 + Math.floor(c / 8) * 1090;
    const at = (x, y) => (x < 0 || y < 0 || x > 11 || y > 11 ? 0 : cell[y * 12 + x]);
    const E = edgeSets();
    for (let y = 0; y < 12; y++) for (let x = 0; x < 12; x++) {
      const m = cell[y * 12 + x]; if (!m) continue;
      if (at(x, y - 1) !== m) addEdge(E[m].h, y + 2, x + 2);
      if (at(x, y + 1) !== m) addEdge(E[m].h, y + 3, x + 2);
      if (at(x - 1, y) !== m) addEdge(E[m].v, x + 2, y + 2);
      if (at(x + 1, y) !== m) addEdge(E[m].v, x + 3, y + 2);
    }
    const items = [];
    for (let m = 1; m < 16; m++) { const d = runsToPath(sortedEntries(E[m].h), sortedEntries(E[m].v)); if (d) items.push(stroke(PALETTE[m], d, 0.2, 'square')); }
    const n = Number((BigInt(eights) >> BigInt(3 * c)) & 7n);
    for (let i = 0; i < n; i++) { const slot = 16 - n + i, color = PALETTE[1 << (slot - 12)]; items.push({ kind: 'rect', x: slot, y: 15, color, svg: `<rect x="${slot}" y="15" width="1" height="1" fill="${color}" stroke="none"/>` }); }
    if (!items.length) return;
    groups.push({ open: `<svg x="${X}" y="${Y}" width="1050" height="1050" viewBox="0 0 16 16" overflow="visible">`, close: '</svg>', t: [1050 / 16, 0, 0, 1050 / 16, X, Y], items });
  });
  return { vw: 10000, head, groups, tail: '</g></svg>' };
}

// ---------------------------------------------------------------- Amortized
// Chessboard distance from each inked pixel to the nearest paper (outside the field is paper).
export function chessboard(f) {
  const d = new Int32Array(FW * FH), INF = 1 << 20, at = (x, y) => (x < 0 || y < 0 || x >= FW || y >= FH ? 0 : d[y * FW + x]);
  for (let i = 0; i < FW * FH; i++) d[i] = f[i] ? INF : 0;
  for (let y = 0; y < FH; y++) for (let x = 0; x < FW; x++) { const i = y * FW + x; if (!d[i]) continue; d[i] = Math.min(d[i], at(x - 1, y) + 1, at(x - 1, y - 1) + 1, at(x, y - 1) + 1, at(x + 1, y - 1) + 1); }
  for (let y = FH - 1; y >= 0; y--) for (let x = FW - 1; x >= 0; x--) { const i = y * FW + x; if (!d[i]) continue; d[i] = Math.min(d[i], at(x + 1, y) + 1, at(x + 1, y + 1) + 1, at(x, y + 1) + 1, at(x - 1, y + 1) + 1); }
  return d;
}
export function amortized(words) {
  const f = fieldOf(cellsOfInk(words), 1), d = chessboard(f), at = (x, y) => (x < 0 || y < 0 || x >= FW || y >= FH ? 0 : d[y * FW + x]);
  const E = edgeSets();
  for (let y = 0; y < FH; y++) for (let x = 0; x < FW; x++) {
    const v = d[y * FW + x]; if (!v) continue; const m = f[y * FW + x];
    if (at(x, y - 1) < v) addEdge(E[m].h, y, x);
    if (at(x, y + 1) < v) addEdge(E[m].h, y + 1, x);
    if (at(x - 1, y) < v) addEdge(E[m].v, x, y);
    if (at(x + 1, y) < v) addEdge(E[m].v, x + 1, y);
  }
  const items = [];
  for (let m = 1; m < 16; m++) { const p = runsToPath(sortedEntries(E[m].h), sortedEntries(E[m].v)); if (p) items.push(stroke(PALETTE[m], p, 0.38, 'square')); }
  return { vw: 76, head: FIELD_HEAD, groups: [{ open: '<g transform="translate(0 1.5)" fill="none" stroke-width="0.38" stroke-linecap="square">', close: '</g>', t: [1, 0, 0, 1, 0, 1.5], items }], tail: '</svg>' };
}

// ---------------------------------------------------------------- Accrued
export const ACCRUED_PAGES = 16;
// Heights: over every page (up to ACCRUED_PAGES), each raster pixel adds how many inks it prints,
// at its Consolidated position; then blurred by three passes of 1 2 1 each way (zero off the field).
export function accruedHeights(pageWords) {
  const H = new Array(FW * FH).fill(0);
  for (const words of pageWords.slice(0, ACCRUED_PAGES)) {
    cellsOfInk(words).forEach((cell, c) => {
      const cx = (c % 8) * 8 + 4, cy = Math.floor(c / 8) * 8 + 4;
      for (let p = 0; p < 144; p++) if (cell[p]) H[(cy + Math.floor(p / 12)) * FW + cx + (p % 12)] += pop(cell[p]);
    });
  }
  // three passes of 1 2 1 across, then three down (zero off the field at every pass)
  let A = H;
  for (let pass = 0; pass < 6; pass++) {
    const across = pass < 3, O = new Array(FW * FH).fill(0);
    for (let y = 0; y < FH; y++) for (let x = 0; x < FW; x++) {
      const i = y * FW + x, lo = across ? (x > 0 ? A[i - 1] : 0) : (y > 0 ? A[i - FW] : 0), hi = across ? (x < FW - 1 ? A[i + 1] : 0) : (y < FH - 1 ? A[i + FW] : 0);
      O[i] = lo + 2 * A[i] + hi;
    }
    A = O;
  }
  return A;
}
// The mix of the nearest inked pixel to (x, y): rings of growing Manhattan distance d = 0..12, each
// probed dy ascending, then dx ascending (−r before +r); 8 (black) if none is found.
export function nearInk(f, x, y) {
  for (let d = 0; d <= 12; d++) for (let dy = -d; dy <= d; dy++) {
    const r = d - Math.abs(dy), Y = y + dy;
    for (const dx of r ? [-r, r] : [0]) { const X = x + dx; if (X < 0 || Y < 0 || X >= FW || Y >= FH) continue; const m = f[Y * FW + X]; if (m) return m; }
  }
  return 8;
}
// (kept for reference) The mix of the nearest inked pixel, breadth first.
export function nearestInk(f) {
  const near = new Uint8Array(f), q = [];
  for (let i = 0; i < FW * FH; i++) if (f[i]) q.push(i);
  for (let qi = 0; qi < q.length; qi++) { const i = q[qi], x = i % FW, y = Math.floor(i / FW);
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const X = x + dx, Y = y + dy; if (X < 0 || Y < 0 || X >= FW || Y >= FH) continue; const j = Y * FW + X; if (!near[j]) { near[j] = near[i]; q.push(j); } } }
  return near;
}
const SEGS = [null, [['l', 'b']], [['b', 'r']], [['l', 'r']], [['t', 'r']], [['l', 't'], ['b', 'r']], [['t', 'b']], [['l', 't']], [['l', 't']], [['t', 'b']], [['l', 'b'], ['t', 'r']], [['t', 'r']], [['l', 'r']], [['b', 'r']], [['l', 'b']]];
export const ACCRUED_POINTS = 2000; // points drawn at most (AccruedRenderer.POINTS)
export function accrued(pageWords) {
  const B = accruedHeights(pageWords), f = fieldOf(cellsOfInk(pageWords[0]), 1);
  const vals = []; for (let y = M; y < FH - M; y++) for (let x = M; x < FW - M; x++) vals.push(B[y * FW + x]);
  vals.sort((a, b) => a - b);
  const L = vals[Math.floor(vals.length * 45 / 100)], T2 = 2 * L + 1; // cut at L + ½: no node sits on the line
  const v = (x, y) => B[y * FW + x];
  // point on the edge from node (x0,y0) (value p) to node (x1,y1) (value q), in hundredths
  const cut = (x0, y0, p, x1, y1, q) => { const num = (T2 - 2 * p) * 100, den = 2 * (q - p), t = Math.floor(Math.abs(num) / Math.abs(den)); return [x0 * 100 + 50 + (x1 - x0) * t, y0 * 100 + 50 + (y1 - y0) * t]; };
  const pts = new Map(), adj = new Map(), order = [];
  const touch = (k, p) => { if (!adj.has(k)) { adj.set(k, []); order.push(k); pts.set(k, p); } };
  for (let y = 0; y < FH - 1; y++) for (let x = 0; x < FW - 1; x++) {
    const a = v(x, y), b = v(x + 1, y), c = v(x + 1, y + 1), d = v(x, y + 1);
    const idx = (a > L ? 8 : 0) | (b > L ? 4 : 0) | (c > L ? 2 : 0) | (d > L ? 1 : 0);
    if (idx === 0 || idx === 15) continue;
    const key = { t: y * FW + x, b: (y + 1) * FW + x, l: FW * FH + y * FW + x, r: FW * FH + y * FW + x + 1 };
    const at = { t: () => cut(x, y, a, x + 1, y, b), b: () => cut(x, y + 1, d, x + 1, y + 1, c), l: () => cut(x, y, a, x, y + 1, d), r: () => cut(x + 1, y, b, x + 1, y + 1, c) };
    for (const [p, q] of SEGS[idx]) { touch(key[p], at[p]()); touch(key[q], at[q]()); adj.get(key[p]).push(key[q]); adj.get(key[q]).push(key[p]); }
  }
  const seen = new Set(), lines = [];
  const walk = (s) => { const line = [s]; seen.add(s); let cur = s; for (;;) { const nx = adj.get(cur).find((n) => !seen.has(n)); if (nx === undefined) break; seen.add(nx); line.push(nx); cur = nx; } return line; };
  for (const k of order) if (!seen.has(k) && adj.get(k).length === 1) lines.push({ keys: walk(k), closed: false });
  for (const k of order) if (!seen.has(k)) { const keys = walk(k); lines.push({ keys, closed: keys.length > 2 && adj.get(keys[keys.length - 1]).includes(keys[0]) }); }
  const items = [];
  const P = (p) => `${num(p[0])} ${num(p[1])}`, mid = (p, q) => [Math.floor((p[0] + q[0]) / 2), Math.floor((p[1] + q[1]) / 2)];
  const mixOf = (p, q) => nearInk(f, Math.min(FW - 1, Math.floor((p[0] + q[0]) / 200)), Math.min(FH - 1, Math.floor((p[1] + q[1]) / 200)));
  let drawn = 0;
  for (const { keys, closed } of lines) {
    if (closed && keys.length < 8) continue; // too small to read
    if (drawn + keys.length > ACCRUED_POINTS) continue; // past the point budget: left out
    drawn += keys.length;
    const pp = keys.map((k) => pts.get(k)), n = pp.length;
    const segMix = []; for (let i = 0; i < (closed ? n : n - 1); i++) segMix.push(mixOf(pp[i], pp[(i + 1) % n]));
    if (closed && segMix.every((m) => m === segMix[0])) { // one colour all round: a closed smooth loop
      let d = `M${P(mid(pp[n - 1], pp[0]))}`; for (let i = 0; i < n; i++) d += `Q${P(pp[i])} ${P(mid(pp[i], pp[(i + 1) % n]))}`;
      items.push(stroke(PALETTE[segMix[0]], d, 0.36, 'round', 'round')); continue;
    }
    const seq = closed ? [...pp, pp[0]] : pp; // runs of one colour; neighbouring runs share their end point
    let s = 0;
    while (s < segMix.length) {
      let e = s; while (e + 1 < segMix.length && segMix[e + 1] === segMix[s]) e++;
      const R = seq.slice(s, e + 2); let d = `M${P(R[0])}`;
      if (R.length === 2) d += `L${P(R[1])}`;
      else { d += `L${P(mid(R[0], R[1]))}`; for (let i = 1; i < R.length - 1; i++) d += `Q${P(R[i])} ${P(mid(R[i], R[i + 1]))}`; d += `L${P(R[R.length - 1])}`; }
      items.push(stroke(PALETTE[segMix[s]], d, 0.36, 'round', 'round'));
      s = e + 1;
    }
  }
  return { vw: 76, head: FIELD_HEAD, groups: [{ open: '<g transform="translate(0 1.5)" fill="none" stroke-width="0.36" stroke-linecap="round" stroke-linejoin="round">', close: '</g>', t: [1, 0, 0, 1, 0, 1.5], items }], tail: '</svg>' };
}

// ---------------------------------------------------------------- Allocated
export const ALLOC_WEIGHT = 96; // px² of extra reach for a Credit rated twice the median
const floorDiv = (a, b) => { let q = a / b; if ((a % b !== 0n) && ((a < 0n) !== (b < 0n))) q -= 1n; return q; };
export function allocated(words, scores) {
  const cells = cellsOfInk(words), sites = [];
  const sorted = [...scores].map(BigInt).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)), med = sorted[40] > 0n ? sorted[40] : 1n;
  cells.forEach((cell, c) => {
    let n = 0n, sx = 0n, sy = 0n; const counts = new Array(16).fill(0);
    for (let p = 0; p < 144; p++) if (cell[p]) { n++; counts[cell[p]]++; sx += BigInt(((c % 8) * 8 + (p % 12) + 4) * 2 + 1); sy += BigInt((Math.floor(c / 8) * 8 + Math.floor(p / 12) + 4) * 2 + 1); }
    if (!n) return;
    let top = 0; for (let m = 1; m < 16; m++) if (counts[m] > (top ? counts[top] : 0)) top = m;
    const s = BigInt(scores[c]), r = s > 4n * med ? 4n * med : s;
    sites.push({ c, x: (sx * 128n) / n, y: (sy * 128n) / n, w: floorDiv(BigInt(ALLOC_WEIGHT) * 65536n * (r - med), med), mix: top });
  });
  const items = [];
  for (const si of sites) {
    let poly = [[1536n, 1536n], [17920n, 1536n], [17920n, 22016n], [1536n, 22016n]]; // the page, 6..70 × 6..86, in 256ths
    for (const sj of sites) {
      if (sj === si || poly.length < 3) continue;
      const A = 2n * (sj.x - si.x), B = 2n * (sj.y - si.y); if (A === 0n && B === 0n) continue;
      const C = (sj.x * sj.x + sj.y * sj.y - sj.w) - (si.x * si.x + si.y * si.y - si.w);
      const out = [];
      for (let k = 0; k < poly.length; k++) {
        const Pp = poly[k], Q = poly[(k + 1) % poly.length], fp = A * Pp[0] + B * Pp[1] - C, fq = A * Q[0] + B * Q[1] - C;
        if (fp <= 0n) out.push(Pp);
        if ((fp <= 0n) !== (fq <= 0n)) out.push([Pp[0] + floorDiv((Q[0] - Pp[0]) * fp, fp - fq), Pp[1] + floorDiv((Q[1] - Pp[1]) * fp, fp - fq)]);
      }
      poly = out;
    }
    if (poly.length < 3) continue;
    const h = (v) => num(Number((v * 100n) / 256n));
    let d = `M${h(poly[0][0])} ${h(poly[0][1])}`; for (let k = 1; k < poly.length; k++) d += `L${h(poly[k][0])} ${h(poly[k][1])}`; d += 'Z';
    items.push({ kind: 'fill', color: PALETTE[si.mix], d, stroke: '#ffffff', width: 0.3, join: 'round', svg: `<path fill="${PALETTE[si.mix]}" d="${d}"/>` });
  }
  return { vw: 76, head: FIELD_HEAD, groups: [{ open: '<g transform="translate(0 1.5)" stroke="#ffffff" stroke-width="0.3" stroke-linejoin="round">', close: '</g>', t: [1, 0, 0, 1, 0, 1.5], items }], tail: '</svg>' };
}

// ---------------------------------------------------------------- Allocated · stacks
// Eight torn stacks of paper, one per column of Credits: each column's 80-pixel height is shared
// among its ten Credits by rating; every boundary is a tear, its edge taken from the pixels of the
// Credit below it (the top row of its square, one point per pixel). Pieces are filled in the ink the
// Credit prints most, with a paper line between them.
export function allocatedStacks(words, scores) {
  const cells = cellsOfInk(words), items = [];
  const tops = cells.map((cell) => { const counts = new Array(16).fill(0); for (let p = 0; p < 144; p++) if (cell[p]) counts[cell[p]]++; let top = 0; for (let m = 1; m < 16; m++) if (counts[m] > (top ? counts[top] : 0)) top = m; return top; });
  for (let col = 0; col < 8; col++) {
    const s = Array.from({ length: 10 }, (_, r) => Math.max(1, Number(scores[r * 8 + col])));
    const total = s.reduce((a, b) => a + b, 0), x0 = (6 + col * 8) * 100, x1 = x0 + 800;
    let acc = 0; const ys = [600];
    for (let r = 0; r < 10; r++) { acc += s[r]; ys.push(600 + Math.floor((8000 * acc) / total)); }
    // tear r (between piece r-1 and r): 9 points across, offset by the pixels of Credit (r, col)
    // 17 points, every half pixel, alternating between the top two rows of the square, ±0.9 px
    const tear = (r) => { const cell = cells[r * 8 + col], pts = []; for (let j = 0; j <= 16; j++) { const m = cell[(2 + (j & 1)) * 12 + 2 + Math.min(j >> 1, 7)]; const off = j === 0 || j === 16 ? 0 : ((m * 7 + j * 5) % 19 - 9) * 10; pts.push([x0 + j * 50, ys[r] + off]); } return pts; };
    for (let r = 0; r < 10; r++) {
      const top = r === 0 ? [[x0, 600], [x1, 600]] : tear(r), bottom = r === 9 ? [[x1, 8600], [x0, 8600]] : tear(r + 1).reverse();
      const poly = [...top, ...bottom]; let d = `M${num(poly[0][0])} ${num(poly[0][1])}`; for (let k = 1; k < poly.length; k++) d += `L${num(poly[k][0])} ${num(poly[k][1])}`; d += 'Z';
      const color = tops[r * 8 + col] ? PALETTE[tops[r * 8 + col]] : '#ffffff';
      items.push({ kind: 'fill', color, d, stroke: '#ffffff', width: 0.3, join: 'miter', svg: `<path fill="${color}" d="${d}"/>` });
    }
  }
  return { vw: 76, head: FIELD_HEAD, groups: [{ open: '<g transform="translate(0 1.5)" stroke="#ffffff" stroke-width="0.3" stroke-linejoin="miter">', close: '</g>', t: [1, 0, 0, 1, 0, 1.5], items }], tail: '</svg>' };
}

// ---------------------------------------------------------------- Allocated · one stack
// The page as one stack of 80 torn sheets, one per Credit in page order: each sheet's height is its
// share of the 80 by rating; each tear runs across the page, its edge taken from the pixels of the
// Credit below it (its 8 × 8 square read row by row, one point per pixel across the 64, ±0.36 px).
export function allocatedStack(words, scores) {
  const cells = cellsOfInk(words), items = [];
  const tops = cells.map((cell) => { const counts = new Array(16).fill(0); for (let p = 0; p < 144; p++) if (cell[p]) counts[cell[p]]++; let top = 0; for (let m = 1; m < 16; m++) if (counts[m] > (top ? counts[top] : 0)) top = m; return top; });
  const s = scores.map((v) => Math.max(1, Number(v))), total = s.reduce((a, b) => a + b, 0);
  let acc = 0; const ys = [600]; for (let c = 0; c < 80; c++) { acc += s[c]; ys.push(600 + Math.floor((8000 * acc) / total)); }
  // tear c: 129 points across 6..70, point j offset by square pixel j of Credit c (row by row)
  const tear = (c) => { const cell = cells[c], pts = []; for (let j = 0; j <= 64; j++) { const k = Math.min(j, 63), m = cell[(2 + (k >> 3)) * 12 + 2 + (k & 7)]; const off = j === 0 || j === 64 ? 0 : ((m * 7 + j * 5) % 19 - 9) * 4; pts.push([600 + j * 100, ys[c] + off]); } return pts; };
  // each sheet runs from its own tear to the foot of the page; the next sheet covers the rest
  for (let c = 0; c < 80; c++) {
    const top = c === 0 ? [[600, 600], [7000, 600]] : tear(c);
    const poly = [...top, [7000, 8600], [600, 8600]]; let d = `M${num(poly[0][0])} ${num(poly[0][1])}`; for (let k = 1; k < poly.length; k++) d += `L${num(poly[k][0])} ${num(poly[k][1])}`; d += 'Z';
    const color = tops[c] ? PALETTE[tops[c]] : '#ffffff';
    items.push({ kind: 'fill', color, d, stroke: '#ffffff', width: 0.3, join: 'miter', svg: `<path fill="${color}" d="${d}"/>` });
  }
  return { vw: 76, head: FIELD_HEAD, groups: [{ open: '<g transform="translate(0 1.5)" stroke="#ffffff" stroke-width="0.3" stroke-linejoin="miter">', close: '</g>', t: [1, 0, 0, 1, 0, 1.5], items }], tail: '</svg>' };
}

// ---------------------------------------------------------------- Binary
// Each square pixel of the 64 × 80 (the 80 squares edge to edge) is a digit in a 4 × 4 block of
// quarter-pixel glyph units: a 1 (a stroke one unit wide, three tall, in the pixel's ink) where it
// prints, a 0 (a 3 × 3 ring, one unit thick, in black) on paper. Glyph units are exactly a quarter of
// a page pixel, square; the digits fill 6..70 × 7.5..87.5 of the 76 × 95 page.
export function binary(words) {
  const cells = cellsOfInk(words), zeros = [], ones = Array.from({ length: 16 }, () => []);
  for (let y = 0; y < 80; y++) for (let x = 0; x < 64; x++) {
    const m = cells[Math.floor(y / 8) * 8 + Math.floor(x / 8)][((y % 8) + 2) * 12 + (x % 8) + 2];
    if (m) ones[m].push(`M${4 * x + 1} ${4 * y}v3`); else zeros.push(`M${4 * x} ${4 * y}h2v2h-2z`);
  }
  const zeroItems = zeros.length ? [stroke(PALETTE[8], zeros.join(''), 1, 'butt', 'miter')] : [];
  const oneItems = []; for (let m = 1; m < 16; m++) if (ones[m].length) oneItems.push(stroke(PALETTE[m], ones[m].join(''), 1, 'butt', 'miter'));
  return { vw: 76, head: FIELD_HEAD, groups: [
    { open: '<g fill="none" stroke-width="1" transform="matrix(0.25 0 0 0.25 6.125 7.625)">', close: '</g>', t: [0.25, 0, 0, 0.25, 6.125, 7.625], items: zeroItems },
    { open: '<g fill="none" stroke-width="1" transform="matrix(0.25 0 0 0.25 6.125 7.5)">', close: '</g>', t: [0.25, 0, 0, 0.25, 6.125, 7.5], items: oneItems },
  ], tail: '</svg>' };
}

// ---------------------------------------------------------------- Assessed, Liquidated
// Both are pixel-true on the 64 × 80 (the Statement's 80 squares edge to edge), placed as Binary places
// it: 6..70 × 7.5..87.5 of the 76 × 95 page. Each row's pixels are written as runs of one mix, a
// stroke one pixel wide down the middle of the row: per mix "M{x} {y}h{n}", rows then x ascending,
// under translate(6 8). Mixes in ascending order; mixes with no pixels are left out.
export const BAYER = [[0, 32, 8, 40, 2, 34, 10, 42], [48, 16, 56, 24, 50, 18, 58, 26], [12, 44, 4, 36, 14, 46, 6, 38], [60, 28, 52, 20, 62, 30, 54, 22], [3, 35, 11, 43, 1, 33, 9, 41], [51, 19, 59, 27, 49, 17, 57, 25], [15, 47, 7, 39, 13, 45, 5, 37], [63, 31, 55, 23, 61, 29, 53, 21]];
export const HUE = [0, 6, 2, 1, 4, 5, 3, 7, 12, 11, 9, 10, 8, 13, 14, 15];
const HUE_RANK = HUE.reduce((r, m, i) => { r[m] = i; return r; }, new Array(16).fill(0));
const PIXEL_GROUP = '<g fill="none" stroke-width="1" transform="translate(6 8)">';
function pixelModel(grid) {
  const runs = Array.from({ length: 16 }, () => '');
  for (let y = 0; y < 80; y++) { let x = 0; while (x < 64) { const m = grid[y * 64 + x]; let e = x + 1; while (e < 64 && grid[y * 64 + e] === m) e++; if (m) runs[m] += `M${x} ${y}h${e - x}`; x = e; } }
  const items = []; for (let m = 1; m < 16; m++) if (runs[m]) items.push(stroke(PALETTE[m], runs[m], 1, 'butt', 'miter'));
  return { vw: 76, head: FIELD_HEAD, groups: [{ open: PIXEL_GROUP, close: '</g>', t: [1, 0, 0, 1, 6, 8], items }], tail: '</svg>' };
}
const inkAt = (cells, x, y) => cells[Math.floor(y / 8) * 8 + Math.floor(x / 8)][((y % 8) + 2) * 12 + (x % 8) + 2];

// Assessed: each Credit as one mix, the one it prints most (ties to the earlier on the colour wheel),
// dithered over its square to the share of the square it inks: of its 64 pixels, those whose Bayer
// threshold is below its inked count.
export function assessed(words) {
  const cells = cellsOfInk(words), grid = new Uint8Array(64 * 80);
  for (let c = 0; c < 80; c++) {
    const n = new Array(16).fill(0); let k = 0;
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) { const m = cells[c][(y + 2) * 12 + x + 2]; if (m) { n[m]++; k++; } }
    let t = 0; for (let m = 1; m < 16; m++) if (n[m] && (!t || n[m] > n[t] || (n[m] === n[t] && HUE_RANK[m] < HUE_RANK[t]))) t = m;
    const ox = (c % 8) * 8, oy = Math.floor(c / 8) * 8;
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) if (BAYER[y][x] < k) grid[(oy + y) * 64 + ox + x] = t;
  }
  return pixelModel(grid);
}

// Liquidated: the page's ink poured into one column. The mixes, in colour-wheel order, each take a band
// the height of their share of the inked pixels; each band's colour sits at its centre, and between two
// neighbouring centres a pixel takes the lower colour where its Bayer threshold is below how far down it
// lies between them (in 64ths). Above the first centre and below the last, solid. All whole numbers:
// with total inked pixels T, a centre is at P/(2T) rows, P = (2 · pixels before + own) · 80, and row y's
// middle at (2y + 1)T/(2T).
export function liquidated(words) {
  const cells = cellsOfInk(words), grid = new Uint8Array(64 * 80), n = new Array(16).fill(0);
  let total = 0;
  for (let y = 0; y < 80; y++) for (let x = 0; x < 64; x++) { const m = inkAt(cells, x, y); if (m) { n[m]++; total++; } }
  if (total) {
    // In 1/(128T) rows, shifted by 189T so nothing is negative: a centre at (2·before + own)·80·64
    // + 189T; a pixel at its row's middle, (2y + 1)·64, moved by 6 × its transposed Bayer threshold
    // (up to 1½ rows either way), so a band thinner than a row scatters instead of filling one.
    const stops = []; let at = 0;
    for (const m of HUE) if (m && n[m]) { stops.push({ m, p: (2 * at + n[m]) * 5120 + 189 * total }); at += n[m]; }
    const last = stops.length - 1;
    let kRow = 0;
    for (let y = 0; y < 80; y++) {
      const Y0 = (2 * y + 1) * 64 * total;
      while (kRow < last && stops[kRow + 1].p < Y0) kRow++;
      for (let x = 0; x < 64; x++) {
        const Y = ((2 * y + 1) * 64 + 6 * BAYER[x % 8][y % 8]) * total;
        let k = kRow; while (k < last && stops[k + 1].p < Y) k++;
        let m;
        if (Y <= stops[0].p) m = stops[0].m;
        else if (Y >= stops[last].p) m = stops[last].m;
        else m = BAYER[y % 8][x % 8] * (stops[k + 1].p - stops[k].p) < 64 * (Y - stops[k].p) ? stops[k + 1].m : stops[k].m;
        grid[y * 64 + x] = m;
      }
    }
  }
  return pixelModel(grid);
}
