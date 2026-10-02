// Builds public/lab/inks.bin for the Format Lab: every Credit's 12×12 ink raster exactly as the Statements draw it
// (inkOf: its 8×8 frame at rows and columns 2–9, misprinted plates slipped into the ring around it), 72 bytes per
// Credit in id order (id 1 first), cell 2k in the low nibble of byte k.
//   npx esbuild scripts/lab-inks.ts --bundle --platform=node --format=esm --outfile=<tmp>.mjs && node <tmp>.mjs
import { gunzipSync } from 'node:zlib';
import { readFileSync, writeFileSync } from 'node:fs';
import { inkOf } from '../src/shared/statement';

const src = JSON.parse(gunzipSync(readFileSync(new URL('../data/credits.json.gz', import.meta.url))).toString('utf8')) as Record<string, [string, number]>;
const n = Math.max(...Object.keys(src).map(Number));
const out = new Uint8Array(n * 72);
const text = (v: string) => (v.startsWith('0x') ? Buffer.from(v.slice(2), 'hex').toString('latin1') : v);
let done = 0;
for (const [key, [seed, paidAt]] of Object.entries(src)) {
  const id = Number(key), { px } = inkOf(text(seed), paidAt);
  for (let k = 0; k < 72; k++) out[(id - 1) * 72 + k] = px[2 * k] | (px[2 * k + 1] << 4);
  if (++done % 20000 === 0) console.log(done);
}
writeFileSync(new URL('../public/lab/inks.bin', import.meta.url), out);
console.log(`${n} Credits, ${out.length} bytes`);
