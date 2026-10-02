/// Slices of the edition's files for a Picture union's page, which otherwise reads all of wall.bin, edition-traits.bin
/// and market.json (2.9 MB over the wire) to use a few thousand rows of them: only the listings that could draw its
/// Colors (registered, at or under the price its plan considers), and the viewer's own Credits, each with its print
/// (wall.bin's 32 bytes) and the low byte of its packed traits (Colors, and print: 0 is registered).
///
/// Layout, little-endian: u32 edition size, u32 rows; then each row's u32 id (ascending), u32 price in gwei (0 for a
/// Credit not for sale), u8 traits and 32 bytes of print. The app reads it back in picture.ts (sliceBase).

/// wall.bin, read once per isolate.
let walls: Promise<Uint8Array> | null = null;
export function wallOf(assets: Fetcher, origin: string): Promise<Uint8Array> {
  walls ??= assets
    .fetch(new Request(`${origin}/wall.bin`))
    .then(async (r) => {
      if (!r.ok) throw new Error('wall.bin missing');
      return new Uint8Array(await r.arrayBuffer());
    })
    .catch((e) => {
      walls = null;
      throw e;
    });
  return walls;
}

/// The rows for `ids` with their prices (gwei), ids ascending.
export function rowsOf(rows: { id: number; gwei: number }[], wall: Uint8Array, traits: Uint32Array): Uint8Array {
  rows.sort((a, b) => a.id - b.id);
  const n = rows.length, out = new Uint8Array(8 + n * 41), v = new DataView(out.buffer);
  v.setUint32(0, traits.length, true);
  v.setUint32(4, n, true);
  rows.forEach((r, i) => {
    v.setUint32(8 + i * 4, r.id, true);
    v.setUint32(8 + n * 4 + i * 4, r.gwei, true);
    out[8 + n * 8 + i] = traits[r.id - 1] & 0x7f;
    out.set(wall.subarray((r.id - 1) * 32, r.id * 32), 8 + n * 9 + i * 32);
  });
  return out;
}

/// Which listings a picture can use: registered, of one of the Colors in `colours` (bit c set for Colors c), priced at
/// or under `maxWei`. `book`: [id, price in wei, …] rows.
export function pictureRows(book: readonly (readonly [string, string, ...unknown[]])[], traits: Uint32Array, colours: number, maxWei: bigint) {
  const out: { id: number; gwei: number }[] = [];
  for (const r of book) {
    const id = Number(r[0]), t = traits[id - 1] ?? 0;
    if (!t || (t >> 4) & 7 || !(colours & (1 << (t & 15)))) continue;
    const wei = BigInt(r[1]);
    if (wei > maxWei) continue;
    out.push({ id, gwei: Number(wei / 1_000_000_000n) });
  }
  return out;
}

export async function gzip(b: Uint8Array): Promise<ArrayBuffer> {
  return new Response(new Blob([b]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer();
}
