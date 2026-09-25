// Builds public/wall.bin (every Credit's 8×8 print, for the About page's wall) and public/bits.bin (Jack's
// "Bits" trait per Credit, for the Bits rule) from data/credits.json.gz.
//   node scripts/wall.ts
// wall.bin: 32 bytes per Credit in id order (id 1 first), one 4-bit CMYK mask per cell, cell 2k in the low
// nibble of byte k. bits.bin: one Uint16 per Credit, marks set across its active plates (0–256).
// times.bin: one Uint32 per Credit, the unix second its payment landed (for the wall's Stream mode).
import { gunzipSync } from 'node:zlib';
import { readFileSync, writeFileSync } from 'node:fs';
import { sha256 } from '@noble/hashes/sha2.js';

const src = JSON.parse(gunzipSync(readFileSync(new URL('../data/credits.json.gz', import.meta.url))).toString('utf8')) as Record<string, [string, number]>;
const n = Math.max(...Object.keys(src).map(Number));
const seedOf = (v: string) => (v.startsWith('0x') ? Buffer.from(v.slice(2), 'hex') : Buffer.from(v, 'latin1'));

const wall = new Uint8Array(n * 32);
const bits = new Uint16Array(n);
const times = new Uint32Array(n);
for (const [key, [seed, paidAt]] of Object.entries(src)) {
  const id = Number(key);
  const hash = sha256(seedOf(seed));
  const plates = (paidAt % 15) + 1; // CreditDrawing.platesAt: the second of payment picks the inks
  let marks = 0;
  for (let c = 0; c < 64; c++) {
    let m = 0;
    for (let layer = 0; layer < 4; layer++) {
      if (!(plates & (1 << layer))) continue;
      const i = layer * 64 + c;
      if ((hash[i >> 3] >> (7 - (i & 7))) & 1) {
        m |= 1 << layer;
        marks++;
      }
    }
    wall[(id - 1) * 32 + (c >> 1)] |= c & 1 ? m << 4 : m;
  }
  bits[id - 1] = marks;
  times[id - 1] = paidAt;
}
writeFileSync(new URL('../public/wall.bin', import.meta.url), wall);
writeFileSync(new URL('../public/bits.bin', import.meta.url), Buffer.from(bits.buffer));
writeFileSync(new URL('../public/times.bin', import.meta.url), Buffer.from(times.buffer));
console.log('credits', n, 'wall.bin', wall.length, 'bytes; bits.bin', bits.byteLength, 'bytes; bits range', Math.min(...bits), '–', Math.max(...bits));
