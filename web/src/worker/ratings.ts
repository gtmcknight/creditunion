/// Official Credit ratings for a set of ids: Jack's formula (see shared/credits.ts) over the frozen mainnet
/// edition in public/edition.bin. Seeds and payment times come from the configured Credits contract, so on a
/// testnet the test Credits are rated against the real edition's distribution.
import { decodeFunctionResult, encodeFunctionData, type Address } from 'viem';
import { creditsAbi } from '../app/abi';
import { rate, type Edition, type Rating } from '../shared/credits';

let edition: Promise<Edition> | null = null;

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

export type Rated = Rating & { id: string; seed: string; paidAt: number };

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

export async function ratings(o: {
  assets: Fetcher;
  origin: string;
  rpcs: string[];
  credits: Address;
  ids: bigint[];
  /// Where seeds are kept once for every data center (the colo cache is per data center).
  kv?: KVNamespace;
}): Promise<{ n: number; version: string; ratings: Record<string, Rated> }> {
  const ed = await loadEdition(o.assets, o.origin);
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
  const out: Record<string, Rated> = {};
  for (const [id, [seed, paidAt]] of known) out[id] = { id, seed, paidAt, ...rate(seed, paidAt, ed) };
  return { n: ed.n, version: '3.4.0', ratings: out };
}
