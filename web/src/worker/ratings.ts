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

export type Rated = Rating & { id: string; paidAt: number };

/// One JSON-RPC batch per 100 calls: plain fetch, no shared scheduler (see index.ts on why).
async function seeds(rpc: string, credits: Address, ids: bigint[]): Promise<Map<string, [string, number]>> {
  const out = new Map<string, [string, number]>();
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const calls = chunk.flatMap((id, k) => [
      { jsonrpc: '2.0', id: k * 2, method: 'eth_call', params: [{ to: credits, data: encodeFunctionData({ abi: creditsAbi, functionName: 'seedOf', args: [id] }) }, 'latest'] },
      { jsonrpc: '2.0', id: k * 2 + 1, method: 'eth_call', params: [{ to: credits, data: encodeFunctionData({ abi: creditsAbi, functionName: 'timestampOf', args: [id] }) }, 'latest'] },
    ]);
    const res = await fetch(rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(calls) });
    const results = (await res.json()) as { id: number; result?: `0x${string}` }[];
    const byId = new Map(results.map((r) => [r.id, r.result]));
    chunk.forEach((id, k) => {
      const s = byId.get(k * 2);
      const t = byId.get(k * 2 + 1);
      if (!s || !t || /^0x0+$/.test(s)) return;
      const seedHex = decodeFunctionResult({ abi: creditsAbi, functionName: 'seedOf', data: s });
      const seed = String.fromCharCode(...seedHex.slice(2).match(/../g)!.map((h) => parseInt(h, 16))); // latin1
      out.set(id.toString(), [seed, Number(decodeFunctionResult({ abi: creditsAbi, functionName: 'timestampOf', data: t }))]);
    });
  }
  return out;
}

export async function ratings(o: {
  assets: Fetcher;
  origin: string;
  rpc: string;
  credits: Address;
  ids: bigint[];
}): Promise<{ n: number; version: string; ratings: Record<string, Rated> }> {
  const ed = await loadEdition(o.assets, o.origin);
  const cache = caches.default;
  const key = (id: bigint) => new Request(`${o.origin}/seed2/${o.credits.toLowerCase()}/${id}`);
  const known = new Map<string, [string, number]>();
  const missing: bigint[] = [];
  await Promise.all(
    o.ids.map(async (id) => {
      const hit = await cache.match(key(id));
      if (hit) known.set(id.toString(), (await hit.json()) as [string, number]);
      else missing.push(id);
    }),
  );
  if (missing.length) {
    const fresh = await seeds(o.rpc, o.credits, missing);
    for (const [id, v] of fresh) {
      known.set(id, v);
      await cache.put(key(BigInt(id)), Response.json(v, { headers: { 'cache-control': 'public, max-age=31536000, immutable' } }));
    }
  }
  const out: Record<string, Rated> = {};
  for (const [id, [seed, paidAt]] of known) out[id] = { id, paidAt, ...rate(seed, paidAt, ed) };
  return { n: ed.n, version: '3.4.0', ratings: out };
}
