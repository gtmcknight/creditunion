/// Eighty's Worker. It holds no state and signs nothing. Its jobs:
///   /config.json   chain id and contract addresses for the app
///   /rpc           read-only JSON-RPC proxy to our contracts only (keeps the provider key private)
///   /art/...       a Credit's art, read from Jack's art contract and cached forever (art never changes)
///   /opensea/quote cheapest OpenSea listings that fit a batch, as signed Seaport orders for the Sweeper
///   /ens/:address  primary ENS name (always from mainnet), cached a day
/// Every response carries the security headers in `secure()`.
import { createPublicClient, http, type Address } from 'viem';
import { mainnet } from 'viem/chains';
import { batchAbi, creditsAbi, creditArtAbi, factoryAbi } from '../app/abi';
import { quote, scan } from './opensea';
import { ratings } from './ratings';
import { match, type Rules } from './match';

interface RateLimit {
  limit(o: { key: string }): Promise<{ success: boolean }>;
}

interface Env {
  ASSETS: Fetcher;
  CHAIN_ID: string;
  CREDITS: Address;
  FACTORY: Address;
  SWEEPER: Address;
  OPENSEA_SLUG: string;
  OPENSEA_API_KEY?: string;
  RPC_URL?: string;
  FALLBACK_RPC: string;
  /// Mainnet RPC for ENS when the app runs on another chain. Defaults to RPC_URL on mainnet.
  ENS_RPC?: string;
  RL_RPC?: RateLimit;
  RL_QUOTE?: RateLimit;
  RL_MISC?: RateLimit;
  RL_ART?: RateLimit;
}

/// Exactly what viem's public client needs for readContract, simulateContract and waitForTransactionReceipt.
/// Wallet transactions go through the wallet's own provider, never here.
const RPC_METHODS = new Set([
  'eth_chainId',
  'eth_blockNumber',
  'eth_call',
  'eth_getTransactionReceipt',
  'eth_getTransactionByHash',
  'eth_getBlockByNumber',
]);
const MAX_RPC_BODY = 64_000;
const MAX_RPC_BATCH = 50;

const rpcUrl = (env: Env) => env.RPC_URL || env.FALLBACK_RPC;
// No request batching here: viem's batch scheduler is shared across concurrent requests in one isolate, and a
// promise resolved in another request's context is cancelled when that request ends (the Worker then "hangs").
const client = (env: Env) => createPublicClient({ transport: http(rpcUrl(env), { timeout: 8_000 }) });
const isDev = (url: URL) => url.hostname === 'localhost' || url.hostname === '127.0.0.1';

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com", // inline style attributes size the sheets
  'font-src https://fonts.gstatic.com',
  "img-src 'self' data: https://metadata.ens.domains",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "object-src 'none'",
  "form-action 'self'",
].join('; ');

function secure(res: Response, url: URL) {
  const h = new Headers(res.headers);
  h.set('x-frame-options', 'DENY');
  h.set('x-content-type-options', 'nosniff');
  h.set('referrer-policy', 'strict-origin-when-cross-origin');
  h.set('permissions-policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  if (!isDev(url)) {
    h.set('strict-transport-security', 'max-age=31536000; includeSubDomains');
    if (!h.has('content-security-policy')) h.set('content-security-policy', CSP);
  }
  return new Response(res.body, { status: res.status, headers: h });
}

const text = (s: string, status: number) => new Response(s, { status });

async function limited(rl: RateLimit | undefined, req: Request) {
  if (!rl) return false;
  const key = req.headers.get('cf-connecting-ip') ?? 'anon';
  try {
    return !(await rl.limit({ key })).success;
  } catch {
    return false;
  }
}

/// Cross-site pages may not drive our endpoints, even fire-and-forget.
function sameSite(req: Request) {
  const s = req.headers.get('sec-fetch-site');
  return s === null || s === 'same-origin' || s === 'none';
}

export default {
  async fetch(req, env, ctx): Promise<Response> {
    const url = new URL(req.url);
    let res: Response;
    try {
      res = await handle(req, env, ctx, url);
    } catch (e) {
      // Never let a stack trace or an RPC URL out; the class of error is enough to debug.
      const msg = String((e as Error)?.message ?? e).replace(/https?:\/\/\S+/g, '<url>').slice(0, 300);
      console.error('worker error', url.pathname, msg);
      res = new Response(`worker error: ${msg}`, { status: 500 });
    }
    return secure(res, url);
  },
} satisfies ExportedHandler<Env>;

async function handle(req: Request, env: Env, ctx: ExecutionContext, url: URL): Promise<Response> {
  if (url.pathname === '/config.json') {
    return Response.json(
      {
        chainId: Number(env.CHAIN_ID),
        credits: env.CREDITS,
        factory: env.FACTORY,
        sweeper: env.OPENSEA_API_KEY && !/^0x0+$/.test(env.SWEEPER ?? '0x0') ? env.SWEEPER : null,
      },
      { headers: { 'cache-control': 'public, max-age=60' } },
    );
  }

  if (url.pathname === '/rpc') return rpc(req, env, url);

  // Design-time counts: how many Credits in the edition satisfy a rule set.
  if (url.pathname === '/edition/match') {
    if (req.method !== 'POST' || !sameSite(req)) return text('forbidden', 403);
    if (await limited(env.RL_MISC, req)) return text('slow down', 429);
    let rules: Rules;
    try {
      const b = (await req.json()) as Record<string, unknown>;
      const int = (k: string, min: number, max: number, dflt: number) => {
        const v = b[k];
        if (v === undefined || v === null) return dflt;
        if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) throw 0;
        return v;
      };
      const list = Array.isArray(b.list) ? b.list : [];
      if (list.length > 200 || list.some((x) => typeof x !== 'number' || !Number.isInteger(x) || x < 1 || x > 1e7)) throw 0;
      rules = {
        palette: int('palette', 0, 15, 0),
        print: int('print', -1, 5, -1),
        weight: int('weight', -1, 3, -1),
        eights: int('eights', -1, 31, -1),
        minuteFrom: int('minuteFrom', -1, 4000, -1),
        minuteTo: int('minuteTo', -1, 4000, -1),
        idFrom: int('idFrom', 0, 1e7, 0),
        idTo: int('idTo', 0, 1e7, 0),
        list: list as number[],
      };
    } catch {
      return text('bad request', 400);
    }
    try {
      return Response.json(await match(env.ASSETS, url.origin, rules), { headers: { 'cache-control': 'no-store' } });
    } catch (e) {
      return Response.json({ error: String((e as Error).message).slice(0, 200) }, { status: 502 });
    }
  }

  // Official ratings for up to 200 Credits, computed from the frozen edition (see shared/credits.ts).
  if (url.pathname === '/ratings') {
    if (req.method !== 'POST' || !sameSite(req)) return text('forbidden', 403);
    if (await limited(env.RL_MISC, req)) return text('slow down', 429);
    let ids: bigint[];
    try {
      const body = (await req.json()) as { ids?: unknown };
      if (!Array.isArray(body.ids) || body.ids.length === 0 || body.ids.length > 200) throw 0;
      ids = body.ids.map((x) => {
        if (!/^\d{1,9}$/.test(String(x))) throw 0;
        return BigInt(String(x));
      });
    } catch {
      return text('bad request', 400);
    }
    try {
      const r = await ratings({ assets: env.ASSETS, origin: url.origin, rpc: rpcUrl(env), credits: env.CREDITS, ids });
      return Response.json(r, { headers: { 'cache-control': 'no-store' } });
    } catch (e) {
      return Response.json({ error: String((e as Error).message).replace(/https?:\/\/\S+/g, '<url>').slice(0, 200) }, { status: 502 });
    }
  }

  if (url.pathname === '/opensea/quote') {
    if (!env.OPENSEA_API_KEY || !env.SWEEPER) return text('OpenSea is not configured', 501);
    if (!sameSite(req)) return text('forbidden', 403);
    if (await limited(env.RL_QUOTE, req)) return text('slow down', 429);
    const batch = (url.searchParams.get('batch') ?? '').toLowerCase();
    const n = Number(url.searchParams.get('n'));
    if (!/^0x[0-9a-f]{40}$/.test(batch) || !Number.isInteger(n) || n < 1 || n > 40) return text('bad request', 400);
    if (!(await isBatch(env, url, batch as Address))) return text('not a batch', 404);
    try {
      // The scan (list pages, trait and liveness checks) is the expensive part and the same for everyone.
      const cache = caches.default;
      const scanKey = new Request(`${url.origin}/opensea/scan/${batch}`);
      let listings = await cache.match(scanKey).then((r) => r?.json<Awaited<ReturnType<typeof scan>>>());
      if (!listings) {
        const c = client(env);
        listings = await scan({
          key: env.OPENSEA_API_KEY,
          slug: env.OPENSEA_SLUG,
          credits: env.CREDITS,
          max: 40,
          passes: (id) => c.readContract({ address: batch as Address, abi: batchAbi, functionName: 'passes', args: [id] }),
          live: (id, seller, operator) =>
            Promise.all([
              c.readContract({ address: env.CREDITS, abi: creditsAbi, functionName: 'ownerOf', args: [id] }),
              c.readContract({ address: env.CREDITS, abi: creditsAbi, functionName: 'isApprovedForAll', args: [seller, operator] }),
            ]).then(([o, ok]) => o.toLowerCase() === seller.toLowerCase() && ok),
          hasCode: (a) => c.getCode({ address: a }).then((code) => !!code && code !== '0x'),
        });
        ctx.waitUntil(cache.put(scanKey, Response.json(listings, { headers: { 'cache-control': 'public, max-age=30' } })));
      }
      const result = await quote({ key: env.OPENSEA_API_KEY, sweeper: env.SWEEPER, listings: listings.slice(0, n) });
      return Response.json(result, { headers: { 'cache-control': 'no-store' } });
    } catch (e) {
      return Response.json({ error: (e as Error).message.slice(0, 200) }, { status: 502, headers: { 'cache-control': 'no-store' } });
    }
  }

  const ens = url.pathname.match(/^\/ens\/(0x[0-9a-fA-F]{40})$/);
  if (ens) {
    const cache = caches.default;
    const key = new Request(url.origin + url.pathname.toLowerCase());
    const hit = await cache.match(key);
    if (hit) return hit;
    if (await limited(env.RL_MISC, req)) return text('slow down', 429);
    const rpc = env.ENS_RPC || (env.CHAIN_ID === '1' ? rpcUrl(env) : 'https://eth.drpc.org');
    const c = createPublicClient({ chain: mainnet, transport: http(rpc, { timeout: 5_000 }) });
    let name: string | null = null;
    let ttl = 86400;
    try {
      name = await c.getEnsName({ address: ens[1] as Address });
      if (!name) ttl = 3600;
    } catch {
      ttl = 60;
    }
    // The avatar is served by ENS's own metadata service, so this Worker never fetches a URL a name owner chose.
    const avatar = name ? `https://metadata.ens.domains/mainnet/avatar/${encodeURIComponent(name)}` : null;
    const res = Response.json({ name, avatar }, { headers: { 'cache-control': `public, max-age=${ttl}` } });
    ctx.waitUntil(cache.put(key, res.clone()));
    return res;
  }

  const art = url.pathname.match(/^\/art\/(?:0x[0-9a-fA-F]{40}\/)?(\d{1,7})\.svg$/);
  if (art) {
    // Keyed by contract too: art never changes for a given Credits, but the contract can (testnets).
    const cache = caches.default;
    const key = new Request(`${url.origin}/art/${env.CREDITS.toLowerCase()}/${art[1]}.svg`);
    const hit = await cache.match(key);
    if (hit) return hit;
    if (await limited(env.RL_ART, req)) return text('slow down', 429); // a page loads up to 80 at once
    const c = client(env);
    const id = BigInt(art[1]);
    // Even opened directly, the SVG can run nothing and reach nothing.
    const svgHeaders = { 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox" };
    try {
      const [seed, ts, artAddr] = await Promise.all([
        c.readContract({ address: env.CREDITS, abi: creditsAbi, functionName: 'seedOf', args: [id] }),
        c.readContract({ address: env.CREDITS, abi: creditsAbi, functionName: 'timestampOf', args: [id] }),
        c.readContract({ address: env.CREDITS, abi: creditsAbi, functionName: 'art' }),
      ]);
      if (/^0x0+$/.test(seed)) {
        const miss = new Response('no such credit', { status: 404, headers: { 'cache-control': 'public, max-age=300' } });
        ctx.waitUntil(cache.put(key, miss.clone()));
        return miss;
      }
      const svg = await c.readContract({ address: artAddr, abi: creditArtAbi, functionName: 'svg', args: [seed, ts] });
      const res = new Response(svg, {
        headers: { 'content-type': 'image/svg+xml', 'cache-control': 'public, max-age=31536000, immutable', ...svgHeaders },
      });
      ctx.waitUntil(cache.put(key, res.clone()));
      return res;
    } catch {
      return new Response('art unavailable', { status: 502, headers: svgHeaders });
    }
  }

  return env.ASSETS.fetch(req);
}

/// Read-only proxy. Only the methods the app uses, and eth_call only to our contracts, so the paid key
/// cannot be borrowed for anything else.
async function rpc(req: Request, env: Env, url: URL): Promise<Response> {
  if (req.method !== 'POST') return text('POST only', 405);
  if (!sameSite(req)) return text('forbidden', 403);
  if ((req.headers.get('content-type') ?? '').split(';')[0].trim() !== 'application/json') return text('json only', 415);
  if (Number(req.headers.get('content-length') ?? 0) > MAX_RPC_BODY) return text('too large', 413);
  if (await limited(env.RL_RPC, req)) return text('slow down', 429);

  const body = await req.text();
  if (body.length > MAX_RPC_BODY) return text('too large', 413);
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return text('bad json', 400);
  }
  const calls = Array.isArray(parsed) ? parsed : [parsed];
  if (calls.length === 0 || calls.length > MAX_RPC_BATCH) return text('bad batch', 400);

  const allowed = new Set([env.CREDITS, env.FACTORY, env.SWEEPER].map((a) => a?.toLowerCase()).filter(Boolean));
  const clean: { jsonrpc: string; id: unknown; method: string; params: unknown[] }[] = [];
  for (const c of calls) {
    if (!c || typeof c !== 'object') return text('bad call', 400);
    const { id, method, params } = c as { id?: unknown; method?: unknown; params?: unknown };
    if (typeof method !== 'string' || !RPC_METHODS.has(method)) return text('method not allowed', 403);
    const p = Array.isArray(params) ? params : [];
    if (method === 'eth_call') {
      const to = String((p[0] as { to?: string })?.to ?? '').toLowerCase();
      if (!/^0x[0-9a-f]{40}$/.test(to)) return text('bad target', 400);
      if (!allowed.has(to) && !(await isBatch(env, url, to as Address))) return text('target not allowed', 403);
    }
    clean.push({ jsonrpc: '2.0', id: id ?? null, method, params: p });
  }
  const upstream = await fetch(rpcUrl(env), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(Array.isArray(parsed) ? clean : clean[0]),
  });
  return new Response(upstream.body, {
    status: upstream.status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

/// Whether an address is one of our factory's batches. Positives are cached forever (a batch is one for good).
async function isBatch(env: Env, url: URL, addr: Address): Promise<boolean> {
  const cache = caches.default;
  const key = new Request(`${url.origin}/isbatch/${env.FACTORY.toLowerCase()}/${addr.toLowerCase()}`);
  const hit = await cache.match(key);
  if (hit) return (await hit.text()) === '1';
  let ok = false;
  try {
    ok = await client(env).readContract({ address: env.FACTORY, abi: factoryAbi, functionName: 'isBatch', args: [addr] });
  } catch {
    return false;
  }
  await cache.put(key, new Response(ok ? '1' : '0', { headers: { 'cache-control': `public, max-age=${ok ? 31536000 : 60}` } }));
  return ok;
}
