/// Design-time matcher: how many Credits in the frozen edition satisfy a set of rules, and a few examples.
/// Reads public/edition-traits.bin (one packed Uint32 per Credit; layout in scripts/edition.ts).

let table: Promise<Uint32Array> | null = null;

async function load(assets: Fetcher, origin: string) {
  if (!table) {
    table = assets
      .fetch(new Request(`${origin}/edition-traits.bin`))
      .then(async (r) => {
        if (!r.ok) throw new Error('edition-traits.bin missing');
        return new Uint32Array(await r.arrayBuffer());
      })
      .catch((e) => {
        table = null;
        throw e;
      });
  }
  return table;
}

export type Rules = {
  palette?: number; // mask 1..15, 0 = any
  print?: number; // 0..5, -1 = any
  weight?: number; // 0..3, -1 = any
  eights?: number; // 0..31, -1 = any
  minuteFrom?: number; // indices into minutes.json, -1 = any
  minuteTo?: number;
  idFrom?: number;
  idTo?: number;
  list?: number[]; // explicit ids, empty = any
};

export async function match(assets: Fetcher, origin: string, r: Rules, samples = 24) {
  const t = await load(assets, origin);
  const list = r.list?.length ? new Set(r.list) : null;
  let count = 0;
  const sample: number[] = [];
  const stride = Math.max(1, Math.floor(t.length / 4000)); // spread samples across the edition
  const lo = Math.max(1, r.idFrom || 1);
  const hi = Math.min(t.length, r.idTo || t.length);
  for (let id = lo; id <= hi; id++) {
    if (list && !list.has(id)) continue;
    const v = t[id - 1];
    if (!v) continue;
    if (r.palette && (v & 15) !== r.palette) continue;
    if (r.print !== undefined && r.print >= 0 && ((v >> 4) & 7) !== r.print) continue;
    if (r.weight !== undefined && r.weight >= 0 && ((v >> 7) & 3) !== r.weight) continue;
    if (r.eights !== undefined && r.eights >= 0 && ((v >> 9) & 31) !== r.eights) continue;
    if ((r.minuteFrom ?? -1) >= 0 || (r.minuteTo ?? -1) >= 0) {
      const mi = (v >> 14) & 2047;
      if (mi === 2047) continue;
      if (r.minuteFrom !== undefined && r.minuteFrom >= 0 && mi < r.minuteFrom) continue;
      if (r.minuteTo !== undefined && r.minuteTo >= 0 && mi > r.minuteTo) continue;
    }
    count++;
    if (sample.length < samples && count % stride === 1) sample.push(id);
  }
  return { count, total: t.length, sample };
}
