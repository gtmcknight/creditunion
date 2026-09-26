/// Eighty's Worker. It holds no state and signs nothing. Its jobs:
///   /config.json   chain id and contract addresses for the app
///   /rpc           read-only JSON-RPC proxy to our contracts only (keeps the provider key private)
///   /art/...       a Credit's art, read from Jack's art contract and cached forever (art never changes)
///   /opensea/quote cheapest OpenSea listings that fit a batch, as signed Seaport orders for the Sweeper
///   /ens/:address  primary ENS name (always from mainnet), cached a day
/// Every response carries the security headers in `secure()`.
import { createPublicClient, http, type Address, parseAbiItem } from 'viem';
import { mainnet } from 'viem/chains';
import { batchAbi, creditsAbi, creditArtAbi, factoryAbi } from '../app/abi';
import { quote, scan } from './opensea';
import { ratings } from './ratings';
import { match, predicate, type Rules } from './match';
import { cardFor, partyCard, withCard } from './og';
import { drawParty, sample, type PartyCard } from './card';
import { stamp } from '../shared/stamp';
import { ruleFor } from '../shared/layout';

interface RateLimit {
  limit(o: { key: string }): Promise<{ success: boolean }>;
}

interface Env {
  ASSETS: Fetcher;
  CHAIN_ID: string;
  CREDITS: Address;
  FACTORY: Address;
  SWEEPER: Address;
  RATINGS?: Address;
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
const MAINNET_CREDITS: Address = '0x97630aA70AB14ed9883B41dAfccBc11349723043';
const MAX_RPC_BATCH = 50;
/// Credits ever minted; ids outside 1..SUPPLY are refused before any RPC.
const SUPPLY = 122_154;
const inSupply = (id: number) => Number.isInteger(id) && id >= 1 && id <= SUPPLY;

/// The site's home. The old domains (OLD_HOSTS) redirect here.
const OLD_HOSTS = new Set(['creditunion.party', 'eighty.fun', 'www.eighty.fun', 'eighty.rhps.fun']);
const SITE_HOST = 'creditunion.fun';
const rpcUrl = (env: Env) => env.RPC_URL || env.FALLBACK_RPC;
/// Listing scans in progress, per batch, so a burst of quotes costs one scan.
const inflight = new Map<string, Promise<Awaited<ReturnType<typeof scan>>>>();
// No request batching here: viem's batch scheduler is shared across concurrent requests in one isolate, and a
// promise resolved in another request's context is cancelled when that request ends (the Worker then "hangs").
const client = (env: Env) => createPublicClient({ transport: http(rpcUrl(env), { timeout: 8_000 }) });
const isDev = (url: URL) => url.hostname === 'localhost' || url.hostname === '127.0.0.1';

const CSP = [
  "default-src 'self'",
  "script-src 'self' https://static.cloudflareinsights.com", // Cloudflare Web Analytics beacon
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com", // inline style attributes size the sheets
  'font-src https://fonts.gstatic.com',
  "img-src 'self' data: https://metadata.ens.domains",
  "connect-src 'self' https://cloudflareinsights.com",
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

/// Rate-limit key: the IPv4 address, or the /64 for IPv6 (one home gets a whole /64, so keying on the full
/// address would hand an attacker 2^64 fresh limits).
function ipKey(ip: string) {
  if (!ip.includes(':')) return ip;
  const [a, b = ''] = ip.split('::');
  const head = a ? a.split(':') : [];
  const tail = b ? b.split(':') : [];
  const groups = [...head, ...Array<string>(Math.max(0, 8 - head.length - tail.length)).fill('0'), ...tail];
  return `${groups.slice(0, 4).map((g) => g.padStart(4, '0')).join(':')}::/64`;
}

/// Read a body of at most `max` bytes, whatever the headers claim; null if it is larger.
async function readBody(req: Request, max: number): Promise<string | null> {
  if (Number(req.headers.get('content-length') ?? 0) > max) return null;
  const reader = req.body?.getReader();
  if (!reader) return '';
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      return null;
    }
    parts.push(value);
  }
  const all = new Uint8Array(size);
  let off = 0;
  for (const p of parts) {
    all.set(p, off);
    off += p.byteLength;
  }
  return new TextDecoder().decode(all);
}

/// Charges `n` hits to the caller's limit; true if any of them is over.
async function limited(rl: RateLimit | undefined, req: Request, n = 1) {
  if (!rl || n < 1) return false;
  const key = ipKey(req.headers.get('cf-connecting-ip') ?? 'anon');
  try {
    const r = await Promise.all(Array.from({ length: n }, () => rl.limit({ key })));
    return r.some((x) => !x.success);
  } catch {
    return false;
  }
}

/// An error fit for a response body: short, with no URL or key in it. viem's messages carry the RPC URL (and so
/// the provider key) on 429s and timeouts, so only its shortMessage is used, and scrubbed anyway.
export function safeError(e: unknown): string {
  const raw = (e as { shortMessage?: unknown } | null)?.shortMessage ?? (e as Error | null)?.message ?? e;
  const s = (typeof raw === 'string' ? raw : '')
    .split('\n')[0]
    .replace(/https?:\/\/\S+/g, '<url>')
    .replace(/[A-Za-z0-9_-]{32,}/g, (m) => (/^0x[0-9a-fA-F]+$/.test(m) ? m : '<key>')) // keep addresses and hashes
    .trim()
    .slice(0, 200);
  return s || 'Upstream error';
}

/// Cross-site pages may not drive our endpoints, even fire-and-forget.
function sameSite(req: Request) {
  const s = req.headers.get('sec-fetch-site');
  return s === null || s === 'same-origin' || s === 'none';
}
export default {
  async fetch(req, env, ctx): Promise<Response> {
    const url = new URL(req.url);
    // The old domains send pages to the new one (same path), so shared links keep working.
    if (OLD_HOSTS.has(url.hostname))
      return Response.redirect(`https://${SITE_HOST}${url.pathname}${url.search}`, 301);
    let res: Response;
    try {
      res = await handle(req, env, ctx, url);
    } catch (e) {
      // Never let a stack trace or an RPC URL out; the class of error is enough to debug.
      const msg = safeError(e);
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
        ratings: env.RATINGS && !/^0x0+$/.test(env.RATINGS) ? env.RATINGS : null,
      },
      { headers: { 'cache-control': 'public, max-age=60' } },
    );
  }

  if (url.pathname === '/rpc') return rpc(req, env, url);

  // Design-time counts: how many Credits in the edition satisfy a rule set.
  if (url.pathname === '/edition/match') {
    if (req.method !== 'POST' || !sameSite(req)) return text('forbidden', 403);
    let page = -1;
    if (await limited(env.RL_MISC, req)) return text('slow down', 429);
    let rules: Rules;
    try {
      const raw = await readBody(req, 16_000);
      if (raw === null) return text('too large', 413);
      const b = JSON.parse(raw) as Record<string, unknown>;
      const int = (k: string, min: number, max: number, dflt: number) => {
        const v = b[k];
        if (v === undefined || v === null) return dflt;
        if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) throw 0;
        return v;
      };
      const list = Array.isArray(b.list) ? b.list : [];
      if (list.length > 200 || list.some((x) => typeof x !== 'number' || !Number.isInteger(x) || x < 1 || x > 1e7)) throw 0;
      rules = {
        palettes: int('palettes', 0, 0xffff, 0),
        prints: int('prints', 0, 63, 0),
        weights: int('weights', 0, 15, 0),
        eights: int('eights', 0, 0x7fffffff, 0),
        minuteFrom: int('minuteFrom', -1, 4000, -1),
        minuteTo: int('minuteTo', -1, 4000, -1),
        idFrom: int('idFrom', 0, 1e7, 0),
        idTo: int('idTo', 0, 1e7, 0),
        minScore: int('minScore', 0, 8000, 0),
        maxScore: int('maxScore', 0, 8000, 0),
        list: list as number[],
      };
      page = int('page', -1, 2000, -1);
    } catch {
      return text('bad request', 400);
    }
    try {
      return Response.json(await match(env.ASSETS, url.origin, rules, page >= 0 ? 120 : 80, page), { headers: { 'cache-control': 'no-store' } });
    } catch (e) {
      return Response.json({ error: safeError(e) }, { status: 502 });
    }
  }

  // Official ratings for up to 200 Credits, computed from the frozen edition (see shared/credits.ts).
  if (url.pathname === '/ratings') {
    if (req.method !== 'POST' || !sameSite(req)) return text('forbidden', 403);
    if (await limited(env.RL_MISC, req)) return text('slow down', 429);
    let ids: bigint[];
    try {
      const raw = await readBody(req, 16_000);
      if (raw === null) return text('too large', 413);
      const body = JSON.parse(raw) as { ids?: unknown };
      if (!Array.isArray(body.ids) || body.ids.length === 0 || body.ids.length > 200) throw 0;
      ids = body.ids.map((x) => {
        if (!/^\d{1,6}$/.test(String(x)) || !inSupply(Number(x))) throw 0;
        return BigInt(String(x));
      });
    } catch {
      return text('bad request', 400);
    }
    try {
      const r = await ratings({ assets: env.ASSETS, origin: url.origin, rpc: rpcUrl(env), credits: env.CREDITS, ids });
      return Response.json(r, { headers: { 'cache-control': 'no-store' } });
    } catch (e) {
      return Response.json({ error: safeError(e) }, { status: 502 });
    }
  }

  // Live OpenSea listings that fit a party, cheapest first: what the Buy tab shows before anyone asks for a price.
  if (url.pathname === '/opensea/listings') {
    if (!env.OPENSEA_API_KEY) return text('OpenSea is not configured', 501);
    if (!sameSite(req)) return text('forbidden', 403);
    if (await limited(env.RL_MISC, req)) return text('slow down', 429);
    const batch = (url.searchParams.get('batch') ?? '').toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(batch)) return text('bad request', 400);
    if (!(await isBatch(env, url, batch as Address))) return text('not a batch', 404);
    try {
      // Without a Sweeper (testnets) the party can't take mainnet Credits, so this is a live preview: real
      // mainnet listings and prices, checked against the party's rules via the frozen edition.
      const live = hasSweeper(env);
      const listings = live ? await fitting(env, url, ctx, batch as Address) : await previewFitting(env, url, ctx, batch as Address);
      return Response.json({ listings: listings.map((l) => ({ id: l.id, price: l.price })), preview: !live }, { headers: { 'cache-control': 'no-store' } });
    } catch (e) {
      return Response.json({ error: safeError(e) }, { status: 502, headers: { 'cache-control': 'no-store' } });
    }
  }

  if (url.pathname === '/opensea/quote') {
    if (!env.OPENSEA_API_KEY || !hasSweeper(env)) return text('OpenSea is not configured', 501);
    if (!sameSite(req)) return text('forbidden', 403);
    if (await limited(env.RL_QUOTE, req)) return text('slow down', 429);
    const batch = (url.searchParams.get('batch') ?? '').toLowerCase();
    // Either the `n` cheapest, or exactly the listings the buyer picked (`ids`, comma separated).
    const idsParam = url.searchParams.get('ids');
    const ids = idsParam ? idsParam.split(',') : null;
    const n = ids ? ids.length : Number(url.searchParams.get('n'));
    if (!/^0x[0-9a-f]{40}$/.test(batch) || !Number.isInteger(n) || n < 1 || n > 40) return text('bad request', 400);
    if (ids && ids.some((x) => !/^\d{1,7}$/.test(x))) return text('bad request', 400);
    if (!(await isBatch(env, url, batch as Address))) return text('not a batch', 404);
    try {
      let listings = await fitting(env, url, ctx, batch as Address);
      if (ids) {
        const want = new Set(ids);
        listings = listings.filter((l) => want.has(l.id));
      }
      const result = await quote({ key: env.OPENSEA_API_KEY, sweeper: env.SWEEPER, listings, n, origin: url.origin });
      return Response.json(result, { headers: { 'cache-control': 'no-store' } });
    } catch (e) {
      return Response.json({ error: safeError(e) }, { status: 502, headers: { 'cache-control': 'no-store' } });
    }
  }

  // Bid history for a party's auction, from its Bid events. Bids only exist after assembly, so the scan starts
  // near the assembly time (12 s blocks, with margin) and walks forward in windows public RPCs accept.
  const bids = url.pathname.match(/^\/bids\/(0x[0-9a-fA-F]{40})$/);
  if (bids) {
    const cache = caches.default;
    const key = new Request(url.origin + url.pathname.toLowerCase());
    const hit = await cache.match(key);
    if (hit) return hit;
    if (await limited(env.RL_MISC, req)) return text('slow down', 429);
    const batch = bids[1].toLowerCase() as Address;
    if (!(await isBatch(env, url, batch))) return text('not a batch', 404);
    try {
      const c = client(env);
      const [assembledAt, head] = await Promise.all([
        c.readContract({ address: batch, abi: batchAbi, functionName: 'assembledAt' }),
        c.getBlockNumber(),
      ]);
      const out: { bidder: string; amount: string; end: number; block: number; tx: string; time: number }[] = [];
      if (Number(assembledAt) > 0) {
        const since = Math.max(0, Math.floor(Date.now() / 1000) - Number(assembledAt));
        let from = head - BigInt(Math.ceil(since / 12) + 2_000);
        if (from < 0n) from = 0n;
        const event = parseAbiItem('event Bid(address indexed bidder, uint256 amount, uint64 auctionEnd)');
        const logs = [] as Awaited<ReturnType<typeof c.getLogs<typeof event>>>;
        for (let f = from; f <= head; f += 45_000n) {
          const t = f + 44_999n > head ? head : f + 44_999n;
          logs.push(...(await c.getLogs({ address: batch, event, fromBlock: f, toBlock: t })));
        }
        const blocks = new Map<bigint, number>();
        await Promise.all(
          [...new Set(logs.map((l) => l.blockNumber))].map(async (n) => blocks.set(n, Number((await c.getBlock({ blockNumber: n })).timestamp))),
        );
        for (const l of logs) {
          out.push({ bidder: l.args.bidder!, amount: String(l.args.amount), end: Number(l.args.auctionEnd), block: Number(l.blockNumber), tx: l.transactionHash, time: blocks.get(l.blockNumber) ?? 0 });
        }
        out.sort((a, b) => b.block - a.block || b.time - a.time);
      }
      const res = Response.json({ bids: out }, { headers: { 'cache-control': 'public, max-age=15' } });
      ctx.waitUntil(cache.put(key, res.clone()));
      return res;
    } catch (e) {
      return Response.json({ error: safeError(e) }, { status: 502 });
    }
  }

  // /owner/<id>: who holds a Credit of the real edition right now (for the About wall's hover card).
  const owner = url.pathname.match(/^\/owner\/(\d{1,6})$/);
  if (owner) {
    const cache = caches.default;
    const key = new Request(url.origin + url.pathname);
    const hit = await cache.match(key);
    if (hit) return hit;
    if (await limited(env.RL_MISC, req)) return text('slow down', 429);
    const rpc = env.ENS_RPC || (env.CHAIN_ID === '1' ? rpcUrl(env) : 'https://eth.drpc.org');
    const c = createPublicClient({ chain: mainnet, transport: http(rpc, { timeout: 5_000 }) });
    let who: string | null = null;
    try {
      who = await c.readContract({ address: MAINNET_CREDITS, abi: creditsAbi, functionName: 'ownerOf', args: [BigInt(owner[1])] });
    } catch {} // burned, or the RPC is down: say nothing rather than guess
    const res = Response.json({ owner: who }, { headers: { 'cache-control': `public, max-age=${who ? 300 : 60}` } });
    ctx.waitUntil(cache.put(key, res.clone()));
    return res;
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

  // /art/<id>.svg and /art/<contract>/<id>.svg: the configured Credits. /art/mainnet/<id>.svg: the real
  // edition, for previews of Credits you don't hold, on any network.
  const art = url.pathname.match(/^\/art\/(?:(mainnet)\/|0x[0-9a-fA-F]{40}\/)?(\d{1,7})\.svg$/);
  if (art) {
    const real = art[1] === 'mainnet' && env.CHAIN_ID !== '1';
    const creditsAddr = real ? MAINNET_CREDITS : env.CREDITS;
    // Keyed by contract too: art never changes for a given Credits, but the contract can (testnets).
    const cache = caches.default;
    const key = new Request(`${url.origin}/art/${creditsAddr.toLowerCase()}/${art[2]}.svg`);
    const hit = await cache.match(key);
    if (hit) return hit;
    if (!inSupply(Number(art[2]))) return new Response('no such credit', { status: 404, headers: { 'cache-control': 'public, max-age=86400' } });
    if (await limited(env.RL_ART, req)) return text('slow down', 429);
    const c = real
      ? createPublicClient({ transport: http(env.ENS_RPC || 'https://eth.drpc.org', { timeout: 8_000 }) })
      : client(env);
    const id = BigInt(art[2]);
    // Even opened directly, the SVG can run nothing and reach nothing.
    const svgHeaders = { 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox" };
    try {
      const [seed, ts, artAddr] = await Promise.all([
        c.readContract({ address: creditsAddr, abi: creditsAbi, functionName: 'seedOf', args: [id] }),
        c.readContract({ address: creditsAddr, abi: creditsAbi, functionName: 'timestampOf', args: [id] }),
        c.readContract({ address: creditsAddr, abi: creditsAbi, functionName: 'art' }),
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

  // Link cards drawn per party (and made-up ones for /og).
  const drawn = url.pathname.match(/^\/og\/(party|sample)\/([0-9a-zA-Zx]+)\.png$/);
  if (drawn) return linkCard(req, env, url, ctx, drawn[1], drawn[2]);

  // Pages: the app shell with this route's link-preview tags; a party page describes that party.
  let card = req.method === 'GET' ? cardFor(url.pathname) : null;
  const party = url.pathname.match(/^\/(?:party|b)\/(0x[0-9a-fA-F]{40})$/)?.[1];
  // Each party page costs RPC reads, so it is rate limited; over the limit, or not one of ours, it gets the generic card.
  if (card && party && !(await limited(env.RL_MISC, req)) && (await isBatch(env, url, party.toLowerCase() as Address))) {
    const p = await readParty(env, party as Address).catch(() => null);
    if (p) card = partyCard(party, p.name, p.state, p.count, p.highBid > 0n ? ethText(p.highBid) : '', stamp(p.state, p.count, p.highBid));
  }
  if (card) {
    const shell = await env.ASSETS.fetch(new Request(new URL('/', url), req));
    if (shell.ok && (shell.headers.get('content-type') ?? '').includes('text/html')) return withCard(shell, card, url);
    return shell;
  }

  return env.ASSETS.fetch(req);
}

const STATE_NAMES = ['Open', 'Full', 'Expired', 'Auction', 'Settled'] as const;
const ethText = (wei: bigint) => `${(Number(wei) / 1e18).toFixed(4).replace(/\.?0+$/, '')} ETH`;

/// What a link card needs from a party: its summary and its Credits in sheet order.
async function readParty(env: Env, batch: Address): Promise<PartyCard> {
  const c = client(env);
  const [s, slots] = await Promise.all([
    c.readContract({ address: batch, abi: batchAbi, functionName: 'summary' }),
    c.readContract({ address: batch, abi: batchAbi, functionName: 'slots' }),
  ]);
  const sum = s as unknown as { name: string; state: number; count: bigint; split: number; highBid: bigint; auctionEnd: bigint; phase: number };
  return {
    name: [...sum.name].slice(0, 64).join(''), // names are the creator's; cards and tags show at most 64 characters
    state: STATE_NAMES[Number(sum.state)],
    count: Number(sum.count),
    ids: (slots[0] as readonly bigint[]).map(Number),
    early: Number(sum.split) === 1,
    highBid: sum.highBid,
    auctionEnd: Number(sum.auctionEnd),
    canBurn: Number(sum.phase) === 3, // Batch.Phase.Burnable: locked, anyone can burn now
  };
}

/// /og/party/<address>.png and /og/sample/<kind>.png. Party cards are cached a minute: they change as it fills.
/// Cached by path plus the `s` stamp only, so made-up query strings can't force a redraw.
async function linkCard(req: Request, env: Env, url: URL, ctx: ExecutionContext, kind: string, key: string): Promise<Response> {
  const cache = caches.default;
  const s = kind === 'party' ? (url.searchParams.get('s') ?? '') : '';
  const cacheKey = `${url.origin}${url.pathname.toLowerCase()}${/^[0-9a-z.]{1,24}$/.test(s) ? `?s=${s}` : ''}`;
  const hit = await cache.match(cacheKey);
  if (hit) return hit;
  const generic = () => env.ASSETS.fetch(new Request(new URL('/og/party.png', url)));
  if (await limited(env.RL_MISC, req)) return generic();
  let p: PartyCard | null;
  if (kind === 'sample') p = sample(key);
  else if (/^0x[0-9a-fA-F]{40}$/.test(key) && (await isBatch(env, url, key.toLowerCase() as Address))) p = await readParty(env, key as Address).catch(() => null);
  else p = null;
  if (!p) return generic();
  const body = await drawParty(env.ASSETS, url.origin, p);
  const res = new Response(body, { headers: { 'content-type': 'image/png', 'cache-control': `public, max-age=${kind === 'sample' ? 3600 : 60}` } });
  ctx.waitUntil(cache.put(cacheKey, res.clone()));
  return res;
}

/// Read-only proxy. Only the methods the app uses, and eth_call only to our contracts, so the paid key
/// cannot be borrowed for anything else.
async function rpc(req: Request, env: Env, url: URL): Promise<Response> {
  if (req.method !== 'POST') return text('POST only', 405);
  if (!sameSite(req)) return text('forbidden', 403);
  if ((req.headers.get('content-type') ?? '').split(';')[0].trim() !== 'application/json') return text('json only', 415);
  if (Number(req.headers.get('content-length') ?? 0) > MAX_RPC_BODY) return text('too large', 413);
  if (await limited(env.RL_RPC, req)) return text('slow down', 429);

  const body = await readBody(req, MAX_RPC_BODY);
  if (body === null) return text('too large', 413);
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return text('bad json', 400);
  }
  const calls = Array.isArray(parsed) ? parsed : [parsed];
  if (calls.length === 0 || calls.length > MAX_RPC_BATCH) return text('bad batch', 400);
  // Every call in a batch counts against the limit, not just the request (one was charged above).
  if (await limited(env.RL_RPC, req, calls.length - 1)) return text('slow down', 429);

  const allowed = new Set([env.CREDITS, env.FACTORY, env.SWEEPER].map((a) => a?.toLowerCase()).filter(Boolean));
  const clean: { jsonrpc: string; id: unknown; method: string; params: unknown[] }[] = [];
  for (const c of calls) {
    if (!c || typeof c !== 'object') return text('bad call', 400);
    const { id, method, params } = c as { id?: unknown; method?: unknown; params?: unknown };
    if (typeof method !== 'string' || !RPC_METHODS.has(method)) return text('method not allowed', 403);
    // Params are rebuilt, not forwarded: no state overrides, gas/value fields, archive block tags or full
    // transaction bodies ride along on the paid key.
    const p = Array.isArray(params) ? params : [];
    let out: unknown[];
    if (method === 'eth_call') {
      const call = (p[0] ?? {}) as { to?: string; data?: string; from?: string; value?: string };
      const to = String(call.to ?? '').toLowerCase();
      const data = String(call.data ?? '0x');
      if (!/^0x[0-9a-f]{40}$/.test(to) || !/^0x([0-9a-fA-F]{2}){0,8192}$/.test(data)) return text('bad call', 400);
      if (!allowed.has(to) && !(await isBatch(env, url, to as Address))) return text('target not allowed', 403);
      // `from` rides along (only as an address): simulating a write needs the real sender, or msg.sender is 0x0.
      const from = String(call.from ?? '').toLowerCase();
      // and `value` (a hex quantity), so a bid simulates with the ETH it carries.
      const value = String(call.value ?? '');
      out = [{ to, data, ...(/^0x[0-9a-f]{40}$/.test(from) ? { from } : {}), ...(/^0x[0-9a-fA-F]{1,32}$/.test(value) ? { value } : {}) }, 'latest'];
    } else if (method === 'eth_getBlockByNumber') {
      const tag = p[0] === 'latest' || p[0] === 'pending' || p[0] === 'safe' || p[0] === 'finalized' ? p[0] : 'latest';
      out = [tag, false];
    } else if (method === 'eth_getTransactionReceipt' || method === 'eth_getTransactionByHash') {
      if (!/^0x[0-9a-fA-F]{64}$/.test(String(p[0] ?? ''))) return text('bad hash', 400);
      out = [String(p[0]).toLowerCase()];
    } else {
      out = [];
    }
    clean.push({ jsonrpc: '2.0', id: id ?? null, method, params: out });
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

/// Listings that fit a party and would land in it, cheapest first. The scan (list pages, trait and liveness
/// checks) is the expensive part and the same for everyone, so it is cached briefly and shared while in flight.
const hasSweeper = (env: Env) => !!env.SWEEPER && !/^0x0+$/.test(env.SWEEPER);

/// Testnet preview of `fitting`: mainnet listings that pass the party's rules as the edition knows them.
/// Layouts: a Credit fits if its palette has a painted slot, or any slot is open.
async function previewFitting(env: Env, url: URL, ctx: ExecutionContext, batch: Address) {
  const cache = caches.default;
  const key = new Request(`${url.origin}/opensea/preview/${batch}`);
  const hit = await cache.match(key);
  if (hit) return hit.json<Awaited<ReturnType<typeof scan>>>();
  let s: { filter: Record<string, bigint | number>; allowlistSize: bigint };
  try {
    s = (await client(env).readContract({ address: batch, abi: batchAbi, functionName: 'summary' })) as typeof s;
  } catch (e) {
    throw new Error(`party unreadable: ${safeError(e)}`);
  }
  const f = s.filter;
  const layout = [BigInt(f.layout0), BigInt(f.layout1)];
  let palettes = Number(f.palettes);
  const narrowed = { eights: Number(f.eights), prints: Number(f.prints), weights: Number(f.weights) };
  if (layout[0] || layout[1]) {
    // With no open slot, a Credit fits only if some painted slot takes its value of the painted trait.
    const slots = Array.from({ length: 80 }, (_, i) => Number((layout[i < 64 ? 0 : 1] >> BigInt(4 * (i < 64 ? i : i - 64))) & 15n));
    if (!slots.includes(0)) {
      const u: { palettes?: number; eights?: number; prints?: number; weights?: number } = {};
      for (const v of new Set(slots)) for (const [k, bits] of Object.entries(ruleFor(Number(f.layoutTrait ?? 0), v))) u[k as keyof typeof u] = (u[k as keyof typeof u] ?? 0) | bits!;
      if (u.palettes !== undefined) palettes = palettes ? palettes & u.palettes : u.palettes;
      for (const k of ['eights', 'prints', 'weights'] as const) if (u[k] !== undefined) narrowed[k] = narrowed[k] ? narrowed[k] & u[k]! : u[k]!;
    }
  }
  const ok = await predicate(env.ASSETS, url.origin, {
    palettes,
    prints: narrowed.prints,
    weights: narrowed.weights,
    eights: narrowed.eights,
    idFrom: Number(f.idFrom),
    idTo: Number(f.idTo),
    minScore: Number(f.minScore),
    maxScore: Number(f.maxScore),
    paidFrom: Number(f.paidFrom),
    paidTo: Number(f.paidTo),
    bitsFrom: Number(f.bitsFrom ?? 0), // present once the contracts with the Bits rule are live
    bitsTo: Number(f.bitsTo ?? 0),
  });
  // A named list lives in the party itself; test Credit numbers are the edition's, so ask it directly.
  const listed = Number(s.allowlistSize) > 0;
  const inList = (id: bigint) => (listed ? client(env).readContract({ address: batch, abi: batchAbi, functionName: 'allowed', args: [id] }) : Promise.resolve(true));
  const main = createPublicClient({ transport: http(env.ENS_RPC || 'https://eth.drpc.org', { timeout: 8_000 }) });
  const listings = await scan({
    key: env.OPENSEA_API_KEY!,
    slug: env.OPENSEA_SLUG,
    credits: MAINNET_CREDITS,
    max: 40,
    passes: async (id) => ok(Number(id)) && (await inList(id)),
    live: (id, seller, operator) =>
      Promise.all([
        main.readContract({ address: MAINNET_CREDITS, abi: creditsAbi, functionName: 'ownerOf', args: [id] }),
        main.readContract({ address: MAINNET_CREDITS, abi: creditsAbi, functionName: 'isApprovedForAll', args: [seller, operator] }),
      ]).then(([o, a]) => o.toLowerCase() === seller.toLowerCase() && a),
    hasCode: (a) => main.getCode({ address: a }).then((code) => !!code && code !== '0x'),
  });
  ctx.waitUntil(cache.put(key, Response.json(listings, { headers: { 'cache-control': 'public, max-age=60' } })));
  return listings;
}

async function fitting(env: Env, url: URL, ctx: ExecutionContext, batch: Address) {
  const cache = caches.default;
  const scanKey = new Request(`${url.origin}/opensea/scan/${batch}`);
  let listings = await cache.match(scanKey).then((r) => r?.json<Awaited<ReturnType<typeof scan>>>());
  if (!listings && inflight.has(batch)) listings = await inflight.get(batch)!;
  if (!listings) {
    const c = client(env);
    const p = scan({
      key: env.OPENSEA_API_KEY!,
      slug: env.OPENSEA_SLUG,
      credits: env.CREDITS,
      max: 40,
      passes: (id) => c.readContract({ address: batch, abi: batchAbi, functionName: 'passes', args: [id] }),
      live: (id, seller, operator) =>
        Promise.all([
          c.readContract({ address: env.CREDITS, abi: creditsAbi, functionName: 'ownerOf', args: [id] }),
          c.readContract({ address: env.CREDITS, abi: creditsAbi, functionName: 'isApprovedForAll', args: [seller, operator] }),
        ]).then(([o, ok]) => o.toLowerCase() === seller.toLowerCase() && ok),
      hasCode: (a) => c.getCode({ address: a }).then((code) => !!code && code !== '0x'),
    });
    // waitUntil keeps this request's context (and so the scan's I/O) alive even if the client goes away.
    inflight.set(batch, p);
    ctx.waitUntil(p.finally(() => inflight.delete(batch)).catch(() => {}));
    listings = await p;
    ctx.waitUntil(cache.put(scanKey, Response.json(listings, { headers: { 'cache-control': 'public, max-age=30' } })));
  }
  // Slots: on a layout party two listings of one palette can fight over one slot, so the party replays its
  // deposit rule over the whole bundle, in price order, and only the ones that would land are kept.
  if (listings.length) {
    try {
      const ok = (await client(env).readContract({
        address: batch,
        abi: batchAbi,
        functionName: 'canTake',
        args: [listings.map((l) => BigInt(l.id))],
      })) as readonly boolean[];
      listings = listings.filter((_, i) => ok[i]);
    } catch {}
  }
  return listings;
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
