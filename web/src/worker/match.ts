/// Design-time matcher: how many Credits in the frozen edition satisfy a set of rules, and a few examples.
/// Reads public/edition-traits.bin (one packed Uint32 per Credit; layout in scripts/edition.ts).

let table: Promise<Uint32Array> | null = null;
let scores: Promise<Uint16Array> | null = null;

async function loadScores(assets: Fetcher, origin: string) {
  if (!scores) {
    scores = assets
      .fetch(new Request(`${origin}/scores.bin`))
      .then(async (r) => {
        if (!r.ok) throw new Error('scores.bin missing');
        return new Uint16Array(await r.arrayBuffer());
      })
      .catch((e) => {
        scores = null;
        throw e;
      });
  }
  return scores;
}

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

/// Sets, one bit per accepted value, 0 = any (same encoding as Batch.Filter).
export type Rules = {
  palettes?: number; // bit (C=1|M=2|Y=4|K=8)
  prints?: number; // bit 0 Registered … 5 Loose
  weights?: number; // bit 0 even, 1 lean, 2 sparse, 3 extreme
  eights?: number; // bit n = n eights
  minuteFrom?: number; // indices into minutes.json, -1 = any
  minuteTo?: number;
  idFrom?: number;
  idTo?: number;
  minScore?: number; // score ×10, 0 = any
  maxScore?: number;
  list?: number[]; // explicit ids, empty = any
};

/// A test for one Credit against the rules, from the frozen edition (no chain reads).
export async function predicate(assets: Fetcher, origin: string, r: Rules) {
  const t = await load(assets, origin);
  const sc = r.minScore || r.maxScore ? await loadScores(assets, origin) : null;
  const list = r.list?.length ? new Set(r.list) : null;
  const lo = Math.max(1, r.idFrom || 1);
  const hi = Math.min(t.length, r.idTo || t.length);
  return (id: number) => {
    if (id < lo || id > hi) return false;
    if (list && !list.has(id)) return false;
    const v = t[id - 1];
    if (!v) return false;
    if (r.palettes && !(r.palettes & (1 << (v & 15)))) return false;
    if (r.prints && !(r.prints & (1 << ((v >> 4) & 7)))) return false;
    if (r.weights && !(r.weights & (1 << ((v >> 7) & 3)))) return false;
    if (r.eights && !(r.eights & (1 << ((v >> 9) & 31)))) return false;
    if (sc) {
      const s = sc[id - 1];
      if (r.minScore && s < r.minScore) return false;
      if (r.maxScore && s > r.maxScore) return false;
    }
    if ((r.minuteFrom ?? -1) >= 0 || (r.minuteTo ?? -1) >= 0) {
      const mi = (v >> 14) & 2047;
      if (mi === 2047) return false;
      if (r.minuteFrom !== undefined && r.minuteFrom >= 0 && mi < r.minuteFrom) return false;
      if (r.minuteTo !== undefined && r.minuteTo >= 0 && mi > r.minuteTo) return false;
    }
    return true;
  };
}

export async function match(assets: Fetcher, origin: string, r: Rules, samples = 80) {
  const t = await load(assets, origin);
  const ok = await predicate(assets, origin, r);
  const lo = Math.max(1, r.idFrom || 1);
  const hi = Math.min(t.length, r.idTo || t.length);
  // Two passes: count, then take matches evenly spaced across the edition (all of them when few).
  let count = 0;
  for (let id = lo; id <= hi; id++) if (ok(id)) count++;
  const stride = Math.max(1, Math.floor(count / samples));
  const sample: number[] = [];
  const palettes: number[] = [];
  let seen = 0;
  for (let id = lo; id <= hi && sample.length < samples; id++) {
    if (!ok(id)) continue;
    if (seen++ % stride === 0) {
      sample.push(id);
      palettes.push(t[id - 1] & 15);
    }
  }
  return { count, total: t.length, sample, palettes };
}
