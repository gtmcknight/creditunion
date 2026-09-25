// Builds public/edition.bin from the full Credits edition (credits.json: { id: [seed, paidAt] }) and
// verifies a few Credits against jack.art's official rating API.
//   node scripts/edition.ts path/to/credits.json
import { readFileSync, writeFileSync } from 'node:fs';
import { buildEdition, fmtScore, rate, traitsOf, TRAIT_KEYS, type Traits } from '../src/shared/credits.ts';

const src = JSON.parse(readFileSync(process.argv[2], 'utf8')) as Record<string, [string, number]>;
const ids = Object.keys(src).map(Number).sort((a, b) => a - b);
console.log('credits', ids.length, 'first', ids[0], 'last', ids[ids.length - 1]);

// Seeds arrive from the event log as hex-encoded bytes21; the seed itself is 21 ASCII characters.
const seedOf = (v: string) => (v.startsWith('0x') ? Buffer.from(v.slice(2), 'hex').toString('latin1') : v);
for (const id of ids) src[id][0] = seedOf(src[id][0]);
const rows: Traits[] = ids.map((id) => traitsOf(src[id][0], src[id][1]));
const ed = buildEdition(rows);
console.log('distinct R', ed.rs.length);

// Verify against the official API.
const check = [1, 11469, 96844, 2, 50000, 122154, 777, 4242, 31337, 90000].filter((id) => src[id]);
for (const id of check) {
  const mine = rate(src[id][0], src[id][1], ed);
  const res = await fetch(`https://jack.art/credits/rating/api/detail/${id}`);
  const theirs = (await res.json()) as { score: number; rank: number; facts: { name: string; value: string | number; tail: number }[] };
  const ok = Math.abs(mine.score - theirs.score) < 1e-6 && mine.rank === theirs.rank;
  console.log(id, ok ? 'OK' : 'MISMATCH', 'mine', fmtScore(mine.score), mine.rank, 'theirs', fmtScore(theirs.score), theirs.rank);
  if (!ok) {
    theirs.facts.forEach((f, i) => console.log('  ', f.name, 'theirs', f.value, (f.tail / 100).toFixed(6), 'mine', mine.traits[TRAIT_KEYS[i]], mine.tails[i].toFixed(6)));
  }
}

// Per-minute payment counts over the mint, for the time-window picker: [[minuteStart, count], ...].
const perMinute = new Map<number, number>();
for (const id of ids) {
  const m = Math.floor(src[id][1] / 60) * 60;
  perMinute.set(m, (perMinute.get(m) ?? 0) + 1);
}
const minutes = [...perMinute.entries()].sort((a, b) => a[0] - b[0]);
writeFileSync(new URL('../public/minutes.json', import.meta.url), JSON.stringify(minutes));
console.log('wrote public/minutes.json', minutes.length, 'minutes;', minutes.filter(([, c]) => c === 80).length, 'with exactly 80');

// Per-Credit packed traits for the design-time matcher: Uint32 per id (index id-1):
//   bits 0-3 palette mask (C=1,M=2,Y=4,K=8) · 4-6 print · 7-8 weight · 9-13 eights · 14-24 minute index (2047 = none)
const PRINTS = ['Registered', 'Nudge', 'Slip', 'Skew', 'Drift', 'Loose'];
const minuteIndex = new Map(minutes.map(([m], i) => [m, i]));
const packed = new Uint32Array(ids[ids.length - 1]);
ids.forEach((id, i) => {
  const t = rows[i];
  const mask = [...'CMYK'].reduce((m, ch, b) => (t.palette.includes(ch) ? m | (1 << b) : m), 0);
  const marks = t.activeBits, cap = t.palette.length * 64;
  const weight = marks * 256 >= 120 * cap && marks * 256 <= 136 * cap ? 0 : marks * 256 >= 112 * cap && marks * 256 <= 144 * cap ? 1 : marks * 256 >= 96 * cap && marks * 256 <= 160 * cap ? 2 : 3;
  const mi = minuteIndex.get(Math.floor(src[id][1] / 60) * 60) ?? 2047;
  packed[id - 1] = mask | (PRINTS.indexOf(t.registration) << 4) | (weight << 7) | (Math.min(t.eights, 31) << 9) | (mi << 14);
});
writeFileSync(new URL('../public/edition-traits.bin', import.meta.url), Buffer.from(packed.buffer));
console.log('wrote public/edition-traits.bin', packed.byteLength, 'bytes');

// Scores for the onchain table: uint16 little-endian score×10 per id (index id-1), 80.00 → 800, 800.00 → 8000.
const scores = new Uint16Array(ids[ids.length - 1]);
ids.forEach((id) => (scores[id - 1] = Math.round(rate(src[id][0], src[id][1], ed).score * 10)));
writeFileSync(new URL('../../contracts/data/scores.bin', import.meta.url), Buffer.from(scores.buffer));
writeFileSync(new URL('../public/scores.bin', import.meta.url), Buffer.from(scores.buffer));
console.log('wrote scores.bin', scores.byteLength, 'bytes; #1', scores[0], '#11469', scores[11468]);

// Binary layout: u32 json length, json (n, tails, counts), then Float64 rs[], then Uint32 below[].
const meta = Buffer.from(JSON.stringify({ n: ed.n, tails: ed.tails, counts: ed.counts, version: '3.4.0' }));
const head = Buffer.alloc(4);
head.writeUInt32LE(meta.length);
const out = Buffer.concat([head, meta, Buffer.from(ed.rs.buffer), Buffer.from(ed.below.buffer)]);
writeFileSync(new URL('../public/edition.bin', import.meta.url), out);
console.log('wrote public/edition.bin', out.length, 'bytes');
