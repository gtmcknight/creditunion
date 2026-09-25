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

// Binary layout: u32 json length, json (n, tails, counts), then Float64 rs[], then Uint32 below[].
const meta = Buffer.from(JSON.stringify({ n: ed.n, tails: ed.tails, counts: ed.counts, version: '3.4.0' }));
const head = Buffer.alloc(4);
head.writeUInt32LE(meta.length);
const out = Buffer.concat([head, meta, Buffer.from(ed.rs.buffer), Buffer.from(ed.below.buffer)]);
writeFileSync(new URL('../public/edition.bin', import.meta.url), out);
console.log('wrote public/edition.bin', out.length, 'bytes');
