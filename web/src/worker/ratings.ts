/// Official Credit ratings for a set of ids. On mainnet the score is the Statements contract's own (its CreditScore,
/// read once into public/credit-score.bin by scripts/credit-score.ts), the number every Statement's Credit Rating adds
/// up. Traits come from shared/credits.ts over the frozen edition in public/edition.bin. `rule` is the score ×10 in the
/// table a union's rating rule is checked against (public/scores.bin, the Ratings contract unions opened with so far).
/// Seeds and payment times come from the configured Credits contract, so on a testnet the test Credits are rated
/// against the real edition's distribution, by the published formula.
import { decodeFunctionResult, encodeFunctionData, type Address } from 'viem';
import { creditsAbi } from '../app/abi';
import { rate, type Edition, type Rating } from '../shared/credits';

let edition: Promise<Edition> | null = null;
const MAINNET_CREDITS = '0x97630aa70ab14ed9883b41dafccbc11349723043';

/// Jack's scores (ten-thousandths, by id − 1), each one's rank (1 + Credits scored strictly higher), and the rule table.
let table: Promise<{ score: Uint32Array; rank: Uint32Array; rule: Uint16Array }> | null = null;
export async function loadTable(assets: Fetcher, origin: string) {
  if (!table) {
    table = (async () => {
      const [a, b] = await Promise.all(['credit-score.bin', 'scores.bin'].map(async (f) => {
        const r = await assets.fetch(new Request(`${origin}/${f}`));
        if (!r.ok) throw new Error(`${f} missing`);
        return r.arrayBuffer();
      }));
      const score = new Uint32Array(a);
      const sorted = Uint32Array.from(score).sort();
      const rank = new Uint32Array(score.length);
      for (let i = 0; i < score.length; i++) {
        let lo = 0, hi = sorted.length; // first index above score[i]
        while (lo < hi) { const m = (lo + hi) >> 1; if (sorted[m] <= score[i]) lo = m + 1; else hi = m; }
        rank[i] = sorted.length - lo + 1;
      }
      return { score, rank, rule: new Uint16Array(b) };
    })();
    table.catch(() => (table = null));
  }
  return table;
}

async function loadEdition(assets: Fetcher, origin: string): Promise<Edition> {
  if (!edition) {
    edition = (async () => {
      const res = await assets.fetch(new Request(`${origin}/edition.bin`));
      if (!res.ok) throw new Error('edition.bin missing');
      const buf = await res.arrayBuffer();
      const len = new DataView(buf).getUint32(0, true);
      const meta = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, len))) as { n: number; tails: Edition['tails']; counts: Edition['counts'] };
      const rsBytes = (buf.byteLength - 4 - len) / (8 + 4);
      const rs = new Float64Array(buf.slice(4 + len, 4 + len + rsBytes * 8));
      const below = new Uint32Array(buf.slice(4 + len + rsBytes * 8));
      return { n: meta.n, tails: meta.tails, counts: meta.counts, rs, below };
    })();
    edition.catch(() => (edition = null));
  }
  return edition;
}

export type Rated = Rating & { id: string; seed: string; paidAt: number; rule: number };

/// One JSON-RPC batch per 100 calls: plain fetch, no shared scheduler (see index.ts on why). Each batch tries the RPCs
/// in order: a rate-limited, failing or slow one hands the batch to the next.
async function seeds(rpcs: string[], credits: Address, ids: bigint[]): Promise<{ out: Map<string, [string, number]>; failed: Set<string> }> {
  const out = new Map<string, [string, number]>();
  const failed = new Set<string>();
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const calls = chunk.flatMap((id, k) => [
      { jsonrpc: '2.0', id: k * 2, method: 'eth_call', params: [{ to: credits, data: encodeFunctionData({ abi: creditsAbi, functionName: 'seedOf', args: [id] }) }, 'latest'] },
      { jsonrpc: '2.0', id: k * 2 + 1, method: 'eth_call', params: [{ to: credits, data: encodeFunctionData({ abi: creditsAbi, functionName: 'timestampOf', args: [id] }) }, 'latest'] },
    ]);
    let byId: Map<number, `0x${string}` | undefined> | null = null;
    for (const rpc of rpcs) {
      try {
        const res = await fetch(rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(calls), signal: AbortSignal.timeout(8_000) });
        const results = (await res.json()) as { id: number; result?: `0x${string}`; error?: unknown }[];
        if (!res.ok || !Array.isArray(results) || results.some((r) => r.error)) continue;
        byId = new Map(results.map((r) => [r.id, r.result]));
        break;
      } catch {}
    }
    if (!byId) {
      for (const id of chunk) failed.add(id.toString());
      continue;
    }
    chunk.forEach((id, k) => {
      const s = byId.get(k * 2);
      const t = byId.get(k * 2 + 1);
      if (!s || !t || /^0x0+$/.test(s)) return;
      const seedHex = decodeFunctionResult({ abi: creditsAbi, functionName: 'seedOf', data: s });
      const seed = String.fromCharCode(...seedHex.slice(2).match(/../g)!.map((h) => parseInt(h, 16))); // latin1
      out.set(id.toString(), [seed, Number(decodeFunctionResult({ abi: creditsAbi, functionName: 'timestampOf', data: t }))]);
    });
  }
  return { out, failed };
}

type Ask = {
  assets: Fetcher;
  origin: string;
  rpcs: string[];
  credits: Address;
  ids: bigint[];
  /// Where seeds are kept once for every data center (the colo cache is per data center).
  kv?: KVNamespace;
};

export async function ratings(o: Ask): Promise<{ n: number; version: string; ratings: Record<string, Rated> }> {
  const ed = await loadEdition(o.assets, o.origin);
  const known = await seedsOf(o);
  const out: Record<string, Rated> = {};
  const t = o.credits.toLowerCase() === MAINNET_CREDITS ? await loadTable(o.assets, o.origin) : null;
  for (const [id, [seed, paidAt]] of known) {
    const r = rate(seed, paidAt, ed);
    const i = Number(id) - 1;
    out[id] = t ? { id, seed, paidAt, ...r, score: t.score[i] / 10_000, rank: t.rank[i], rule: t.rule[i] } : { id, seed, paidAt, ...r, rule: Math.round(r.score * 10) };
  }
  return { n: ed.n, version: t ? 'onchain' : '3.4.0', ratings: out };
}

/// What drawing a Credit takes, its seed, payment second and score, without the rest of its rating: on mainnet the
/// score is the table's, so nothing is worked out.
export async function inks(o: Ask): Promise<{ n: number; version: string; inks: Record<string, [string, number, number]> }> {
  const t = o.credits.toLowerCase() === MAINNET_CREDITS ? await loadTable(o.assets, o.origin) : null;
  if (!t) {
    const r = await ratings(o);
    return { n: r.n, version: r.version, inks: Object.fromEntries(Object.entries(r.ratings).map(([id, v]) => [id, [v.seed, v.paidAt, v.score]])) };
  }
  const [ed, known] = await Promise.all([loadEdition(o.assets, o.origin), seedsOf(o)]);
  return { n: ed.n, version: 'onchain', inks: Object.fromEntries([...known].map(([id, [seed, paidAt]]) => [id, [seed, paidAt, t.score[Number(id) - 1] / 10_000]])) };
}

/// Each Credit's seed and payment second: this data center's copy, else KV's, else the chain. Ids that can't be read
/// now are left out.
async function seedsOf(o: Ask): Promise<Map<string, [string, number]>> {
  const cache = caches.default;
  const key = (id: bigint) => new Request(`${o.origin}/seed2/${o.credits.toLowerCase()}/${id}`);
  const known = new Map<string, [string, number]>();
  const missing: bigint[] = [];
  await Promise.all(
    o.ids.map(async (id) => {
      const hit = await cache.match(key(id));
      if (!hit) missing.push(id);
      else {
        const v = (await hit.json()) as [string, number] | null;
        if (v) known.set(id.toString(), v); // null = a cached miss (no such Credit)
      }
    }),
  );
  const keep = (id: string, v: [string, number]) => cache.put(key(BigInt(id)), Response.json(v, { headers: { 'cache-control': 'public, max-age=31536000, immutable' } }));
  // A seed never changes: this data center's first read of one looks in KV before the chain.
  const kvKey = (id: bigint | string) => `seed:${o.credits.toLowerCase()}:${id}`;
  let unread = missing;
  if (unread.length && o.kv) {
    const kept = new Map<string, [string, number] | null>();
    for (let i = 0; i < unread.length; i += 100) {
      const got = await o.kv.get<[string, number]>(unread.slice(i, i + 100).map(kvKey), { type: 'json', cacheTtl: 3600 }).catch(() => null);
      for (const [k, v] of got ?? []) kept.set(k, v);
    }
    const fromKv = unread.filter((id) => kept.get(kvKey(id)));
    for (const id of fromKv) known.set(id.toString(), kept.get(kvKey(id))!);
    await Promise.all(fromKv.map((id) => keep(id.toString(), known.get(id.toString())!)));
    unread = unread.filter((id) => !kept.get(kvKey(id)));
  }
  if (unread.length) {
    const { out: fresh, failed } = await seeds(o.rpcs, o.credits, unread);
    await Promise.all(
      [...fresh].map(async ([id, v]) => {
        known.set(id, v);
        await Promise.all([keep(id, v), o.kv?.put(kvKey(id), JSON.stringify(v)).catch(() => {})]);
      }),
    );
    // Ids that do not exist (yet) are remembered briefly too, so a list of bogus ids is not a free RPC amplifier.
    // Ids the RPCs couldn't read at all are left out for now, not remembered as missing.
    await Promise.all(unread.filter((id) => !fresh.has(id.toString()) && !failed.has(id.toString())).map((id) => cache.put(key(id), Response.json(null, { headers: { 'cache-control': 'public, max-age=60' } }))));
  }
  return known;
}
