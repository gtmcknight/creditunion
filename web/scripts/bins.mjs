// The edition's data files (public/*.bin) at build time, as a Vite plugin (vite.config.ts):
//   - a content hash per file, compiled into the app as __BINS__, so each fetch asks for /<file>?v=<hash> and the
//     Worker can let browsers keep it for good (worker/index.ts serveBin);
//   - wall.bin cut into blocks of WALL_BLOCK Credits (wall/<k>.bin), for views that draw only a stretch of the mint;
//   - a brotli and a gzip copy of each (<file>.br, <file>.gz) next to it in the build, which the Worker hands out
//     as they are: Cloudflare doesn't compress application/octet-stream, and wall.bin alone is 3.9 MB;
//   - the /credits tiles' numbers, counted once here (virtual:credits-facts) so that page reads no data file for them.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { brotliCompress, constants, gzip } from 'node:zlib';

/// Credits per block of wall.bin (32 bytes each: 128 KB). Mirrored in src/app/wall.ts and src/worker/index.ts.
export const WALL_BLOCK = 4096;
const FACTS = 'virtual:credits-facts';

const br = promisify(brotliCompress);
const gz = promisify(gzip);

export function bins() {
  const pub = new URL('../public/', import.meta.url);
  const read = (f) => readFileSync(new URL(f, pub));
  const files = readdirSync(pub).filter((f) => f.endsWith('.bin'));
  const hashes = Object.fromEntries(files.map((f) => [f, createHash('sha256').update(read(f)).digest('hex').slice(0, 12)]));
  return {
    name: 'edition-bins',
    config: () => ({ define: { __BINS__: JSON.stringify(hashes) } }),
    resolveId: (id) => (id === FACTS ? `\0${FACTS}` : null),
    load: (id) => (id === `\0${FACTS}` ? `export default ${JSON.stringify(facts(read))};` : null),
    // After the client build copies public/ into its output: the blocks, then a compressed copy of every file.
    async writeBundle(options) {
      if (this.environment?.name !== 'client' || !options.dir) return;
      const out = (f) => new URL(f, `file://${options.dir}/`);
      const wall = read('wall.bin');
      mkdirSync(out('wall/'), { recursive: true });
      const blocks = [];
      for (let k = 0; k * WALL_BLOCK * 32 < wall.length; k++) {
        writeFileSync(out(`wall/${k}.bin`), wall.subarray(k * WALL_BLOCK * 32, (k + 1) * WALL_BLOCK * 32));
        blocks.push(`wall/${k}.bin`);
      }
      await Promise.all(
        [...files, ...blocks].map(async (f) => {
          const raw = readFileSync(out(f));
          const [b, g] = await Promise.all([
            br(raw, { params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_SIZE_HINT]: raw.length } }),
            gz(raw, { level: 9 }),
          ]);
          writeFileSync(out(`${f}.br`), b);
          writeFileSync(out(`${f}.gz`), g);
        }),
      );
    },
  };
}

/// Everything the /credits tiles show (views/credits.ts Facts), from the same files /edition/match reads.
function facts(read) {
  const own = (f) => { const b = read(f); return b.buffer.slice(b.byteOffset, b.byteOffset + b.length); };
  const u32 = (f) => new Uint32Array(own(f)), u16 = (f) => new Uint16Array(own(f));
  const traits = u32('edition-traits.bin'), times = u32('times.bin'), bits = u16('bits.bin'), sc = u16('scores.bin');
  const n = read('wall.bin').length / 32;
  const pal = new Array(16).fill(0), eights = new Array(6).fill(0), print = new Array(6).fill(0), weight = new Array(4).fill(0);
  for (const v of traits) {
    if (!v) continue;
    pal[v & 15]++;
    print[(v >> 4) & 7]++;
    weight[(v >> 7) & 3]++;
    eights[(v >> 9) & 31]++;
  }
  const palette = [1, 2, 3, 4]
    .flatMap((k) => Array.from({ length: 15 }, (_, i) => i + 1).filter((m) => [0, 1, 2, 3].filter((b) => m & (1 << b)).length === k))
    .map((m) => [[...'CMYK'].filter((_, b) => m & (1 << b)).join(''), pal[m]]);
  // wall.ts mintSpan: skip Jack's two early Credits, weeks before the mint.
  const first = Math.min(2, n - 1), start = times[first], end = times[n - 1];
  const perHour = new Array(Math.ceil((end - start + 1) / 3600)).fill(0);
  const perMin = new Map();
  for (let i = first; i < n; i++) {
    perHour[Math.floor((times[i] - start) / 3600)]++;
    const m = Math.floor(times[i] / 60);
    perMin.set(m, (perMin.get(m) ?? 0) + 1);
  }
  const rating = new Array(72).fill(0);
  for (const t of sc) rating[Math.min(71, Math.max(0, Math.floor((t - 800) / 100)))]++;
  const sorted = Uint16Array.from(sc).sort();
  let lo = 65535, hi = 0;
  for (const b of bits) (lo = Math.min(lo, b)), (hi = Math.max(hi, b));
  const bitCounts = new Array(hi - lo + 1).fill(0);
  for (const b of bits) bitCounts[b - lo]++;
  return {
    n,
    palette,
    eights,
    print,
    weight,
    perHour,
    hours: (end - start) / 3600,
    busiest: Math.max(...perMin.values()),
    rating,
    top1: sorted[Math.max(0, sorted.length - Math.round(sorted.length / 100))],
    bits: bitCounts,
    bitsLo: lo,
    bitsHi: hi,
  };
}
