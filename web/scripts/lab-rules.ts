// Can a Painted-by-Colors union (any Credit of the slot's Colors, any order) still make Accrued trace a shape and
// Reconciled draw a wave? Random Credits per slot, several draws each.
import { readFileSync, writeFileSync } from 'node:fs';
import { compose, type Rect } from '../src/shared/statement';
import { svgOf } from '../src/shared/formats/statement-renderers';
import { inkFor, pxOf, type Pool } from '../src/shared/lab';
const out = process.argv[2];
const pool: Pool = { inks: new Uint8Array(readFileSync(new URL('../public/lab/inks.bin', import.meta.url))) };
const n = pool.inks.length / 72;
// Colors mask of each Credit = OR of its pixels' plates
const byMask: number[][] = Array.from({ length: 16 }, () => []);
for (let id = 1; id <= n; id++) { let m = 0; for (let p = 0; p < 144; p++) m |= pxOf(pool, id, p); byMask[m].push(id); }
let seed = 7; const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
const pick = (m: number, used: Set<number>) => { const l = byMask[m]; for (;;) { const id = l[Math.floor(rnd() * l.length)]; if (!used.has(id)) return used.add(id), id; } };
function svg(marks: ReturnType<typeof compose>) {
  let s = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10000 12500"><rect width="10000" height="12500" fill="#fff"/>';
  for (const m of marks) {
    if (Array.isArray(m)) { const [x, y, w, h, c] = m as Rect; s += `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${c}"/>`; }
    else { const inner = svgOf((m as any).model); const vb = inner.match(/viewBox="0 0 ([\d.]+) ([\d.]+)"/)!; s += inner.replace(/^<svg[^>]*>/, `<svg width="10000" height="12500" viewBox="0 0 ${vb[1]} ${vb[2]}">`); }
  }
  return s + '</svg>';
}
const heart = (X: number, Y: number) => (X * X + Y * Y - 1) ** 3 - X * X * Y ** 3 < 0;
const shapes: Record<string, (x: number, y: number) => boolean> = {
  circle: (x, y) => (x - 32) ** 2 + (y - 40) ** 2 < 27 ** 2,
  diamond: (x, y) => Math.abs(x - 32) / 28 + Math.abs(y - 40) / 39 < 1,
  spades: (x, y) => heart((x - 32) / 24, (y - 30) / 24) || (y > 48 && y < 76 && Math.abs(x - 32) < 3 + (y - 48) * 0.45),
  clubs: (x, y) => [[32, 22], [17, 43], [47, 43]].some(([a, b]) => (x - a) ** 2 + (y - b) ** 2 < 196) || (Math.abs(x - 32) < 6 && y > 28 && y < 50) || (y > 50 && y < 76 && Math.abs(x - 32) < 3 + (y - 50) * 0.45),
};
for (const [name, f] of Object.entries(shapes)) {
  // each slot: inside (by its centre 8x8 share >= half) → a 1-plate Colors, else CMYK
  const used = new Set<number>(), ids: number[] = [];
  for (let c = 0; c < 80; c++) { let k = 0; for (let j = 0; j < 64; j++) k += f((c % 8) * 8 + (j & 7) + 0.5, Math.floor(c / 8) * 8 + (j >> 3) + 0.5) ? 1 : 0; ids.push(pick(k >= 32 ? [1, 2, 4, 8][c % 4] : 15, used)); }
  writeFileSync(`${out}/rules-${name}.svg`, svg(compose('Accrued', ids.map((id) => inkFor(pool, id)))));
}
// wave: row target length → plates (32,48,56,60 → 1..4), colours cycling within each plate count
const PL = [[1, 2, 4, 8], [3, 5, 6, 9, 10, 12], [7, 11, 13, 14], [15]];
for (const [name, waves] of [['wave', 2], ['wave3', 3]] as const) {
  const used = new Set<number>(), ids: number[] = [];
  for (let r = 0; r < 80; r++) { const t = 46 + 14 * Math.sin((2 * Math.PI * r * waves) / 80); const k = t < 40 ? 0 : t < 52 ? 1 : t < 58 ? 2 : 3; ids.push(pick(PL[k][r % PL[k].length], used)); }
  writeFileSync(`${out}/rules-${name}.svg`, svg(compose('Reconciled', ids.map((id) => inkFor(pool, id)))));
}
console.log('done');
