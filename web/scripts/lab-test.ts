// Runs the Format Lab's planners against every Credit (or only those for sale) and writes each result as the
// Statement draws it, for a look: maze, wave and shape SVGs.
//   npx esbuild scripts/lab-test.ts --bundle --platform=node --format=esm --outfile=scripts/.lab-test.mjs && node scripts/.lab-test.mjs <outdir> [listed.json]
import { readFileSync, writeFileSync } from 'node:fs';
import { compose, type Rect } from '../src/shared/statement';
import { svgOf } from '../src/shared/formats/statement-renderers';
import { inkFor, mazeIndex, planMaze, planShape, planWave, shapeIndex, waveIndex, waveRange, type Pool, type WaveParams } from '../src/shared/lab';

const [outDir, listedFile] = process.argv.slice(2);
const inks = new Uint8Array(readFileSync(new URL('../public/lab/inks.bin', import.meta.url)));
const price = listedFile ? new Map(Object.entries(JSON.parse(readFileSync(listedFile, 'utf8')) as Record<string, { price: string }>).map(([id, v]) => [Number(id), BigInt(v.price)])) : null;
const pool: Pool = { inks, price };
const eth = (w: bigint) => (Number(w) / 1e18).toFixed(3);

// a Statement's marks as an SVG on its 10,000 × 12,500 page
function svg(marks: ReturnType<typeof compose>) {
  let s = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10000 12500"><rect width="10000" height="12500" fill="#fff"/>';
  for (const m of marks) {
    if (Array.isArray(m)) { const [x, y, w, h, c] = m as Rect; s += `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${c}"/>`; }
    else { const inner = svgOf((m as { model: Parameters<typeof svgOf>[0] }).model); s += inner.replace(/^<svg[^>]*>/, `<svg x="0" y="0" width="10000" height="12500" viewBox="0 0 ${inner.match(/viewBox="0 0 ([\d.]+) ([\d.]+)"/)![1]} ${inner.match(/viewBox="0 0 ([\d.]+) ([\d.]+)"/)![2]}">`); }
  }
  return s + '</svg>';
}
const inksOf = (ids: number[]) => ids.map((id) => (id ? inkFor(pool, id) : null));

let t = Date.now();
const mi = mazeIndex(pool);
console.log(`maze index ${Date.now() - t} ms`);
t = Date.now();
const maze = planMaze(pool, mi, 11);
console.log(`maze ${Date.now() - t} ms:`, maze ? `${maze.ids.length} rooms, way through ${maze.path.length} px, ${maze.leaks} leaks, ${eth(maze.cost)} ETH` : 'none');
if (maze) writeFileSync(`${outDir}/lab-maze.svg`, svg(compose('Amortized', inksOf(maze.ids))));

t = Date.now();
const wi = waveIndex(pool);
console.log(`wave index ${Date.now() - t} ms · Any reaches ${JSON.stringify(waveRange(wi, 'Any'))}, Cyan ${JSON.stringify(waveRange(wi, 'Cyan'))}, C M Y K ${JSON.stringify(waveRange(wi, 'C M Y K'))}`);
const waves: [string, WaveParams][] = [
  ['wave', { shape: 'Wave', color: 'Any', middle: 42, height: 20, waves: 2, shift: 0 }],
  ['cmyk', { shape: 'Wave', color: 'C M Y K', middle: 32, height: 10, waves: 3, shift: 90 }],
  ['heartbeat', { shape: 'Heartbeat', color: 'Black', middle: 34, height: 12, waves: 3, shift: 0 }],
  ['peaks', { shape: 'Peaks', color: 'Any', middle: 40, height: 22, waves: 4, shift: 0 }],
];
for (const [name, p] of waves) {
  const w = planWave(pool, wi, p);
  console.log(`wave ${name}: off by ${w.off} pixels over 80 rows, ${eth(w.cost)} ETH`);
  writeFileSync(`${outDir}/lab-${name}.svg`, svg(compose('Reconciled', inksOf(w.ids))));
}

t = Date.now();
const si = shapeIndex(pool);
console.log(`shape index ${Date.now() - t} ms`);
const circle = new Uint8Array(64 * 80), heart = new Uint8Array(64 * 80);
for (let y = 0; y < 80; y++) for (let x = 0; x < 64; x++) {
  if ((x - 32) ** 2 + (y - 40) ** 2 < 20 ** 2) circle[y * 64 + x] = 1;
  const X = (x - 32) / 17, Y = -(y - 42) / 17; // heart curve: (x² + y² − 1)³ − x² y³ < 0
  if ((X * X + Y * Y - 1) ** 3 - X * X * Y ** 3 < 0) heart[y * 64 + x] = 1;
}
for (const [name, mask] of [['circle', circle], ['heart', heart]] as const) {
  t = Date.now();
  const s = planShape(pool, si, mask);
  console.log(`shape ${name} ${Date.now() - t} ms, ${eth(s.cost)} ETH`);
  writeFileSync(`${outDir}/lab-${name}.svg`, svg(compose('Accrued', inksOf(s.ids))));
}
