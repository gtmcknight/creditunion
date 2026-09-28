/// Credit Union's Worker. It holds no state and signs nothing. Its jobs:
///   /config.json   chain id and contract addresses for the app
///   /rpc           read-only JSON-RPC proxy to our contracts (and Credits' art) only (keeps the provider key private)
///   /unions.json   every Credit Union, summary and slots, one cached multicall for all visitors
///   /passes        which of a wallet's Credits a Credit Union takes, in one multicall
///   /activity.json what wallets have done on the site, newest first (the Activity page)
///   /art/...       a Credit's art, read from Jack's art contract and cached forever (art never changes)
///   /*.bin         the edition's data files, precompressed at build and cached by the browser until they change
///   /opensea/quote cheapest listings that fit a batch (OpenSea as signed Seaport orders, FWA, CreditStrategy)
///   /opensea/credit/:id  one Credit's best OpenSea listing price (mainnet's, as a preview, on testnets)
///   /ens/:address  primary ENS name (always from mainnet), cached a day
/// Every response carries the security headers in `secure()` (headers.ts; the build copies them into _headers for
/// what the asset layer serves on its own).
import { createPublicClient, fallback, hexToBytes, http, type Address, type Hex, parseAbiItem } from 'viem';
import { mainnet } from 'viem/chains';
import { batchAbi, creditsAbi, creditArtAbi, factoryAbi } from '../app/abi';
import { best, bestPage, quote, scan, type Extra, type Listing } from './opensea';
import { cacheStore, confirmListing, marketListings, type FwaListing } from './fwa';
import { confirmStrategy, strategyAbi, strategyListings } from './strategy';
import { ratings } from './ratings';
import { load, loadScores, match, predicate, type Rules } from './match';
import { cardFor, creditCard, creditsCard, partyCard, rangeCard, ruleLine, timeCard, traitCard, withCard, type Filter } from './og';
import { parseTrait } from '../shared/trait';
import { drawCredit, drawUnion, sample, type CreditFacts, type UnionCard } from './card';
import { printOf, type Rect } from './print';
import { readActivity } from './activity';
import { keyOf, ruleFor } from '../shared/layout';
import { ALWAYS, CSP, HSTS } from './headers';
import { fromJson, toJson } from '../shared/json';
import { keep, type Kept } from './keeper';

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
  /// The keeper's private key (keeper.ts), a secret. Unset: the keeper does nothing.
  KEEPER_KEY?: string;
  /// The most the keeper pays for gas, in gwei (base fee); above it, it waits.
  KEEPER_MAX_GWEI?: string;
  RL_RPC?: RateLimit;
  RL_QUOTE?: RateLimit;
  RL_MISC?: RateLimit;
  RL_ART?: RateLimit;
  /// FWA's marketplace on mainnet: a second Buy Credits source. Empty to turn it off.
  FWA_MARKET?: string;
  /// CreditStrategy (nftstrategy.fun) on mainnet: the Credits it holds for sale are a third Buy Credits source.
  /// Empty to turn it off.
  STRATEGY?: string;
  /// Dev only (localhost): JSON [{ "id": "123", "price": "<wei>", "source": "fwa" | "strategy" | "opensea" }] shown as listings.
  DEV_FAKE_LISTINGS?: string;
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
/// The mainnet factory's deploy block (contracts/DEPLOY.md); /activity.json scans from here.
const ACTIVITY_FROM = 26_072_342n;
/// Credits ever minted; ids outside 1..SUPPLY are refused before any RPC.
const SUPPLY = 122_154;
const inSupply = (id: number) => Number.isInteger(id) && id >= 1 && id <= SUPPLY;

/// The site's home. The old domains (OLD_HOSTS) redirect here.
const OLD_HOSTS = new Set(['creditunion.party', 'eighty.fun', 'www.eighty.fun', 'eighty.rhps.fun']);
const SITE_HOST = 'creditunion.fun';
const rpcUrl = (env: Env) => env.RPC_URL || env.FALLBACK_RPC;
/// The public node behind the paid RPC, for when the paid key is over its limit, refused or down.
const hasFallback = (env: Env) => !!env.RPC_URL && !!env.FALLBACK_RPC && env.RPC_URL !== env.FALLBACK_RPC;
const rpcTransport = (env: Env) =>
  hasFallback(env) ? fallback([http(env.RPC_URL, { timeout: 8_000 }), http(env.FALLBACK_RPC, { timeout: 8_000 })]) : http(rpcUrl(env), { timeout: 8_000 });
/// Listing scans in progress, per batch, so a burst of quotes costs one scan.
const inflight = new Map<string, Promise<Awaited<ReturnType<typeof scan>>>>();
// No request batching here: viem's batch scheduler is shared across concurrent requests in one isolate, and a
// promise resolved in another request's context is cancelled when that request ends (the Worker then "hangs").
const client = (env: Env) => createPublicClient({ transport: rpcTransport(env) });
const isDev = (url: URL) => url.hostname === 'localhost' || url.hostname === '127.0.0.1';

/// Responses whose body is already compressed (serveBin): passed on as they are, not encoded again.
const precompressed = new WeakSet<Response>();

function secure(res: Response, url: URL) {
  const h = new Headers(res.headers);
  for (const [k, v] of ALWAYS) h.set(k, v);
  if (!isDev(url)) {
    h.set('strict-transport-security', HSTS);
    if (!h.has('content-security-policy')) h.set('content-security-policy', CSP);
  }
  return new Response(res.body, { status: res.status, headers: h, encodeBody: precompressed.has(res) ? 'manual' : 'automatic' });
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

  // Every minute: the keeper (keeper.ts), once KEEPER_KEY is set.
  async scheduled(_event, env, ctx) {
    if (!env.KEEPER_KEY) return;
    ctx.waitUntil(
      keep({
        key: env.KEEPER_KEY,
        chainId: Number(env.CHAIN_ID),
        factory: env.FACTORY as Address,
        maxGwei: Number(env.KEEPER_MAX_GWEI) || 20,
        transport: rpcTransport(env),
        unions: () => unionList(env) as Promise<Kept[]>,
      }).catch((e) => console.error('[keeper] run failed', safeError(e))),
    );
  },
} satisfies ExportedHandler<Env>;

/// Chain and addresses for the app: at /config.json, and written into every page the Worker serves (#config).
const publicConfig = (env: Env) => ({
  chainId: Number(env.CHAIN_ID),
  credits: env.CREDITS,
  factory: env.FACTORY,
  sweeper: env.OPENSEA_API_KEY && !/^0x0+$/.test(env.SWEEPER ?? '0x0') ? env.SWEEPER : null,
  ratings: env.RATINGS && !/^0x0+$/.test(env.RATINGS) ? env.RATINGS : null,
  fwaMarket: addrOrNull(env.FWA_MARKET),
});

async function handle(req: Request, env: Env, ctx: ExecutionContext, url: URL): Promise<Response> {
  if (url.pathname === '/config.json') return Response.json(publicConfig(env), { headers: { 'cache-control': 'public, max-age=60' } });

  if (url.pathname === '/rpc') return rpc(req, env, url);

  // Every Credit Union with its summary and slots, one cached read for everyone (the lists, profiles, Credit pages).
  if (url.pathname === '/unions.json') {
    if (req.method !== 'GET' || !sameSite(req)) return text('forbidden', 403);
    const fresh = url.searchParams.has('fresh'); // after the reader's own transaction: skip the cache
    if (fresh && (await limited(env.RL_MISC, req))) return text('slow down', 429);
    return unionsJson(env, url, ctx, fresh);
  }

  // Which of a wallet's Credits a Credit Union would take (Batch.passes), all in one multicall: a holder of
  // hundreds would otherwise make hundreds of RPC calls per page.
  if (url.pathname === '/passes') {
    if (req.method !== 'POST' || !sameSite(req)) return text('forbidden', 403);
    if (await limited(env.RL_MISC, req)) return text('slow down', 429);
    let batch: string, ids: bigint[];
    try {
      const raw = await readBody(req, 64_000);
      if (raw === null) return text('too large', 413);
      const b = JSON.parse(raw) as { batch?: unknown; ids?: unknown };
      batch = String(b.batch ?? '').toLowerCase();
      if (!/^0x[0-9a-f]{40}$/.test(batch) || !Array.isArray(b.ids) || b.ids.length > 2000) throw 0; // the biggest wallet holds 1,348
      ids = b.ids.map((x) => {
        if (typeof x !== 'string' || !/^\d{1,6}$/.test(x) || !inSupply(Number(x))) throw 0;
        return BigInt(x);
      });
    } catch {
      return text('bad request', 400);
    }
    // Each ~50 Credits is one eth_call upstream: counted against the RPC limit like /rpc's calls.
    if (await limited(env.RL_RPC, req, Math.ceil(ids.length / 50))) return text('slow down', 429);
    if (!(await isBatch(env, url, batch as Address))) return text('not a batch', 404);
    try {
      const c = client(env);
      const contracts = ids.map((id) => ({ address: batch as Address, abi: batchAbi, functionName: 'passes', args: [id] }) as const);
      const res = hasMulticall(env)
        ? await c.multicall({ contracts, allowFailure: false, multicallAddress: MULTICALL3, batchSize: 8_192 })
        : await Promise.all(contracts.map((x) => c.readContract(x)));
      return Response.json({ ok: res }, { headers: { 'cache-control': 'no-store' } });
    } catch (e) {
      return Response.json({ error: safeError(e) }, { status: 502, headers: { 'cache-control': 'no-store' } });
    }
  }

  // Data files; any other .bin (og/font.bin) is the plain asset, as before these came through here.
  if (url.pathname.endsWith('.bin')) {
    const binFile = url.pathname.match(/^\/((?:wall\/\d{1,3})|[a-z-]+)\.bin$/);
    const res = binFile && (req.method === 'GET' || req.method === 'HEAD') ? await serveBin(req, env, url, binFile[1]) : null;
    return res ?? env.ASSETS.fetch(req);
  }

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
        paidFrom: int('paidFrom', 0, 0xffffffff, 0),
        paidTo: int('paidTo', 0, 0xffffffff, 0),
        bitsFrom: int('bitsFrom', 0, 256, 0),
        bitsTo: int('bitsTo', 0, 256, 0),
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
    if (!env.OPENSEA_API_KEY && !offOpenSea(env) && !devFake(env, url)) return text('OpenSea is not configured', 501);
    if (!sameSite(req)) return text('forbidden', 403);
    if (await limited(env.RL_MISC, req)) return text('slow down', 429);
    const batch = (url.searchParams.get('batch') ?? '').toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(batch)) return text('bad request', 400);
    if (!(await isBatch(env, url, batch as Address))) return text('not a batch', 404);
    // No OpenSea key and nothing elsewhere: the client shows its edition preview.
    if (!env.OPENSEA_API_KEY && !devFake(env, url) && !(await extras(env, url, ctx)).extra.length) return text('OpenSea is not configured', 501);
    try {
      // Without a Sweeper (testnets) the party can't take mainnet Credits, so this is a live preview: real
      // mainnet listings and prices, checked against the party's rules via the frozen edition.
      const live = hasSweeper(env);
      const listings = live ? await fitting(env, url, ctx, batch as Address) : await previewFitting(env, url, ctx, batch as Address);
      // A preview's listings carry their packed edition traits, so the Buy tab can book them against the sheet's
      // slots without reading edition-traits.bin (478 KB) itself.
      const table = live ? null : await load(env.ASSETS, url.origin).catch(() => null);
      return Response.json(
        { listings: listings.map((l) => ({ id: l.id, price: l.price, source: l.source, url: listingUrl(env, live, l), ...(table ? { traits: table[Number(l.id) - 1] ?? 0 } : {}) })), preview: !live },
        { headers: { 'cache-control': 'no-store' } },
      );
    } catch (e) {
      return Response.json({ error: safeError(e) }, { status: 502, headers: { 'cache-control': 'no-store' } });
    }
  }

  if (url.pathname === '/opensea/quote') {
    if (!hasSweeper(env) || (!env.OPENSEA_API_KEY && !offOpenSea(env))) return text('OpenSea is not configured', 501);
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
      listings = listings.slice(0, n);
      return Response.json(await quoteListings(env, url, listings), { headers: { 'cache-control': 'no-store' } });
    } catch (e) {
      return Response.json({ error: safeError(e) }, { status: 502, headers: { 'cache-control': 'no-store' } });
    }
  }

  // The cheapest Credits for sale across OpenSea, CreditStrategy and FWA, for /credits and trait pages
  // (?trait=palette/K). Mainnet's listings on testnets. Cached a minute per trait.
  if (url.pathname === '/opensea/forsale') {
    if (!env.OPENSEA_API_KEY && !offOpenSea(env)) return text('OpenSea is not configured', 501);
    if (!sameSite(req)) return text('forbidden', 403);
    const raw = url.searchParams.get('trait') ?? '';
    const tm = raw.match(/^(palette|eights|print|weight)\/([^/]{1,16})$/);
    const trait = tm ? parseTrait(tm[1], tm[2]) : null;
    if (raw && !trait) return text('bad trait', 400);
    if (await limited(env.RL_MISC, req)) return text('slow down', 429);
    try {
      const live = hasSweeper(env);
      const listings = await forSale(env, url, ctx, trait);
      return Response.json(
        { listings: listings.map((l) => ({ ...l, url: listingUrl(env, live, l) })), preview: !live },
        { headers: { 'cache-control': 'no-store' } },
      );
    } catch (e) {
      return Response.json({ error: safeError(e) }, { status: 502, headers: { 'cache-control': 'no-store' } });
    }
  }

  // Every Credit for sale, cheapest first, a chunk at a time (?trait=palette/K&c=<cursor>): OpenSea's listings page
  // by page with CreditStrategy's and FWA's merged in by price, then whatever of those is left. Shown as listed;
  // a sweep's quote re-checks each one.
  if (url.pathname === '/opensea/listed') {
    if (!env.OPENSEA_API_KEY && !offOpenSea(env)) return text('OpenSea is not configured', 501);
    if (!sameSite(req)) return text('forbidden', 403);
    const raw = url.searchParams.get('trait') ?? '';
    const tm = raw.match(/^(palette|eights|print|weight)\/([^/]{1,16})$/);
    const trait = tm ? parseTrait(tm[1], tm[2]) : null;
    if (raw && !trait) return text('bad trait', 400);
    // Or a range (/rating, /bits, /time): rules the edition answers, with OpenSea read unfiltered.
    let rules: Rules | null = null;
    const rawRules = url.searchParams.get('rules');
    if (rawRules) {
      try {
        const b = JSON.parse(rawRules) as Record<string, unknown>;
        const keys = ['minScore', 'maxScore', 'bitsFrom', 'bitsTo', 'paidFrom', 'paidTo'] as const;
        if (!b || typeof b !== 'object' || Object.keys(b).some((k) => !(keys as readonly string[]).includes(k))) throw 0;
        rules = {};
        for (const k of keys) {
          const v = b[k];
          if (v === undefined) continue;
          if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 0xffffffff) throw 0;
          (rules as Record<string, number>)[k] = v;
        }
      } catch {
        return text('bad rules', 400);
      }
    }
    if (await limited(env.RL_MISC, req)) return text('slow down', 429);
    // OpenSea's next page, the highest OpenSea price shown so far, OpenSea done, how many of the rest are shown.
    type Cursor = { n: string; w: string; d: boolean; i: number; p?: number };
    let cur: Cursor = { n: '', w: '-1', d: !env.OPENSEA_API_KEY, i: 0 };
    try {
      const c = url.searchParams.get('c');
      if (c) cur = JSON.parse(atob(c)) as Cursor;
      if (typeof cur.n !== 'string' || !/^-?\d{1,40}$/.test(cur.w) || typeof cur.d !== 'boolean' || !Number.isInteger(cur.i) || cur.i < 0) throw 0;
    } catch {
      return text('bad cursor', 400);
    }
    try {
      const live = hasSweeper(env);
      const credits = live ? env.CREDITS : MAINNET_CREDITS;
      const ok = trait ? await predicate(env.ASSETS, url.origin, trait.rules) : rules ? await predicate(env.ASSETS, url.origin, rules) : () => true;
      const more = (await extras(env, url, ctx)).extra
        .map((e): Listing => ({ id: e.id, price: e.price, source: e.source, listingId: e.listingId }))
        .sort((a, b) => (BigInt(a.price) < BigInt(b.price) ? -1 : BigInt(a.price) > BigInt(b.price) ? 1 : 0));
      const out: Listing[] = [];
      // Merge by price: the rest's listings up to OpenSea's price reached, a chunk at a time; then OpenSea's next
      // page (OpenSea filters by the trait itself). Up to five OpenSea pages per call.
      for (let pages = 0; ; ) {
        const upTo = cur.d ? null : BigInt(cur.w);
        const start = cur.i;
        while (cur.i < more.length && cur.i - start < LISTED_CHUNK * 4 && (upTo === null || BigInt(more[cur.i].price) <= upTo)) {
          const l = more[cur.i++];
          if (ok(Number(l.id))) out.push(l);
        }
        if (out.length >= LISTED_CHUNK) break;
        if (cur.i - start >= LISTED_CHUNK * 4) continue; // a long run at one price: keep going on the rest
        if (cur.d || pages >= (rules ? 10 : 5)) break; // unfiltered for a range, so read further
        const pg = await bestPage(env.OPENSEA_API_KEY!, env.OPENSEA_SLUG, credits, cur.n, trait ? openseaTrait(trait) : undefined);
        pages++;
        out.push(...pg.items.filter((l) => ok(Number(l.id))));
        const top = pg.items.reduce((m, l) => (BigInt(l.price) > m ? BigInt(l.price) : m), BigInt(cur.w));
        const read = (cur.p ?? 0) + 1;
        // A range OpenSea can't filter (rules) reads the cheapest RANGE_DEPTH pages of the whole collection and stops,
        // so a rare range doesn't read every listing before the page can move on.
        cur = { ...cur, n: pg.next, w: top.toString(), d: !pg.next || !pg.items.length || (!!rules && read >= RANGE_DEPTH), p: read };
      }
      const items = out
        .sort((a, b) => (BigInt(a.price) < BigInt(b.price) ? -1 : BigInt(a.price) > BigInt(b.price) ? 1 : 0))
        .map((l) => ({ ...l, url: listingUrl(env, live, l) }));
      const left = !cur.d || cur.i < more.length;
      return Response.json({ items, next: left ? btoa(JSON.stringify(cur)) : null, preview: !live }, { headers: { 'cache-control': 'no-store' } });
    } catch (e) {
      return Response.json({ error: safeError(e) }, { status: 502, headers: { 'cache-control': 'no-store' } });
    }
  }

  // A price for sweeping exactly these listings into the buyer's wallet (Sweeper.buy). Each is checked again here:
  // OpenSea's through its signed fill, CreditStrategy's and FWA's read on-chain.
  if (url.pathname === '/opensea/buyquote') {
    if (req.method !== 'POST' || !sameSite(req)) return text('forbidden', 403);
    if (!hasSweeper(env)) return text('buying is off here', 501);
    if (await limited(env.RL_QUOTE, req)) return text('slow down', 429);
    let ls: Listing[];
    try {
      const raw = await readBody(req, 16_000);
      if (raw === null) return text('too large', 413);
      const b = JSON.parse(raw) as { listings?: unknown };
      if (!Array.isArray(b.listings) || !b.listings.length || b.listings.length > MAX_SWEEP) throw 0;
      ls = b.listings.map((x) => {
        const l = x as Record<string, unknown>;
        const id = String(l.id), price = String(l.price), source = String(l.source);
        if (!/^\d{1,6}$/.test(id) || !inSupply(Number(id)) || !/^\d{1,30}$/.test(price) || !['opensea', 'fwa', 'strategy'].includes(source)) throw 0;
        if (source === 'opensea' && (!/^0x[0-9a-fA-F]{64}$/.test(String(l.hash)) || !/^0x[0-9a-fA-F]{40}$/.test(String(l.protocol)))) throw 0;
        if (source === 'fwa' && !/^\d{1,20}$/.test(String(l.listingId))) throw 0;
        return { id, price, source: source as Listing['source'], hash: l.hash as string | undefined, protocol: l.protocol as string | undefined, listingId: l.listingId as string | undefined };
      });
    } catch {
      return text('bad request', 400);
    }
    try {
      return Response.json(await quoteListings(env, url, ls), { headers: { 'cache-control': 'no-store' } });
    } catch (e) {
      return Response.json({ error: safeError(e) }, { status: 502, headers: { 'cache-control': 'no-store' } });
    }
  }

  // One Credit's cheapest listing (OpenSea, CreditStrategy or FWA), for its page. Without a Sweeper (testnets) it's
  // the mainnet Credit of the same number, as a preview. Cached a minute per Credit, so a busy page costs OpenSea
  // one call a minute.
  const listed = url.pathname.match(/^\/opensea\/credit\/(\d{1,6})$/);
  if (listed) {
    if (!env.OPENSEA_API_KEY && !offOpenSea(env)) return text('OpenSea is not configured', 501);
    if (!sameSite(req)) return text('forbidden', 403);
    const id = Number(listed[1]);
    if (!inSupply(id)) return text('no such credit', 404);
    const live = hasSweeper(env);
    const credits = live ? env.CREDITS : MAINNET_CREDITS;
    const cache = caches.default;
    const key = new Request(`${url.origin}/opensea/credit/${credits.toLowerCase()}/${id}`);
    const hit = await cache.match(key);
    if (hit) return hit;
    if (await limited(env.RL_MISC, req)) return text('slow down', 429);
    try {
      const main = mainClient(env);
      const strategy = addrOrNull(env.STRATEGY);
      const [os, held, fwa] = await Promise.all([
        env.OPENSEA_API_KEY
          ? best(env.OPENSEA_API_KEY, env.OPENSEA_SLUG, credits, id).then(async (l) => {
              // A listing whose seller no longer holds the Credit is dead: say nothing.
              if (!l) return null;
              const c = live ? client(env) : createPublicClient({ transport: http(env.ENS_RPC || 'https://eth.drpc.org', { timeout: 8_000 }) });
              const holder = await c.readContract({ address: credits, abi: creditsAbi, functionName: 'ownerOf', args: [BigInt(id)] }).catch(() => null);
              return holder && holder.toLowerCase() === l.seller.toLowerCase() ? l : null;
            })
          : null,
        strategy ? main.readContract({ address: strategy, abi: strategyAbi, functionName: 'nftForSale', args: [BigInt(id)] }).catch(() => 0n) : 0n,
        fwaListings(env, url, ctx).then((ls) => ls.find((l) => l.id === String(id)) ?? null),
      ]);
      const offers: Listing[] = [];
      if (os !== null) offers.push({ id: String(id), price: os.price.toString(), source: 'opensea', hash: os.hash, protocol: os.protocol });
      if (held > 0n) offers.push({ id: String(id), price: held.toString(), source: 'strategy' });
      if (fwa) offers.push({ id: String(id), price: fwa.price, source: 'fwa', listingId: fwa.listingId });
      offers.sort((a, b) => (BigInt(a.price) < BigInt(b.price) ? -1 : 1));
      const l = offers[0];
      const res = Response.json(
        l
          ? {
              price: l.price,
              source: l.source,
              // Where to buy it in-app: the strategy sells a held Credit itself; FWA's market by listing id.
              contract: l.source === 'strategy' ? addrOrNull(env.STRATEGY) : l.source === 'fwa' ? addrOrNull(env.FWA_MARKET) : null,
              listingId: l.listingId ?? null,
              // An OpenSea order, bought in-app through the Sweeper (Sweeper.buy), like a sweep of one.
              hash: l.hash ?? null,
              protocol: l.protocol ?? null,
              url: listingUrl(env, live, l),
              preview: !live,
            }
          : { price: null, preview: !live },
        { headers: { 'cache-control': 'public, max-age=60' } },
      );
      ctx.waitUntil(cache.put(key, res.clone()));
      return res;
    } catch (e) {
      return Response.json({ error: safeError(e) }, { status: 502, headers: { 'cache-control': 'no-store' } });
    }
  }

  // The Activity page moved from /live: old links land on it.
  if (url.pathname === '/live') return Response.redirect(`${url.origin}/activity${url.search}`, 301);

  // /activity.json: what wallets have done on the site, newest first (activity.ts). Fifteen seconds per colo.
  if (url.pathname === '/activity.json') {
    const cache = caches.default;
    const key = new Request(`${url.origin}/activity.json`);
    const hit = await cache.match(key);
    if (hit) return hit;
    if (await limited(env.RL_MISC, req)) return text('slow down', 429);
    try {
      const c = client(env);
      // Mainnet scans from the factory's deploy block; elsewhere, the last ~2 weeks.
      const from = env.CHAIN_ID === '1' ? ACTIVITY_FROM : (await c.getBlockNumber()) - 100_000n;
      const items = await readActivity(c as never, cache, `${url.origin}/activity-state/${env.FACTORY.toLowerCase()}`, {
        factory: env.FACTORY,
        sweeper: hasSweeper(env) ? env.SWEEPER : null,
        credits: env.CREDITS,
        from: from < 0n ? 0n : from,
      });
      const res = Response.json({ items }, { headers: { 'cache-control': 'public, max-age=15' } });
      ctx.waitUntil(cache.put(key, res.clone()));
      return res;
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
      // The art contract is read once per isolate (artOf), not per Credit.
      const [seed, ts, artAddr] = await Promise.all([
        c.readContract({ address: creditsAddr, abi: creditsAbi, functionName: 'seedOf', args: [id] }),
        c.readContract({ address: creditsAddr, abi: creditsAbi, functionName: 'timestampOf', args: [id] }),
        artOf(env, creditsAddr, c).then((a) => {
          if (!a) throw new Error('no art contract');
          return a as Address;
        }),
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
  // A Credit's card: its art from the edition, drawn once and cached a day.
  const creditPng = url.pathname.match(/^\/og\/credit\/(\d{1,6})\.png$/);
  if (creditPng) {
    const id = Number(creditPng[1]);
    const generic = () => env.ASSETS.fetch(new Request(new URL('/og/home.png', url)));
    if (!inSupply(id)) return generic();
    const cache = caches.default;
    const key = new Request(`${url.origin}/og/credit/v3/${id}.png`); // v: the card's design
    const hit = await cache.match(key);
    if (hit) return hit;
    if (await limited(env.RL_MISC, req)) return generic();
    const [facts, [print]] = await Promise.all([creditFacts(env, url, id).catch(() => null), printsFor(env, [id])]);
    // Drawn from the chain it's exact for good. Without the chain there is no exact art (wall.bin keeps only the
    // registered grid: no misprints, paper or marks), and sites keep the first image they fetch, so the site's card.
    if (!print) return generic();
    const res = new Response(await drawCredit(env.ASSETS, url.origin, id, facts, print), { headers: { 'content-type': 'image/png', 'cache-control': 'public, max-age=86400' } });
    ctx.waitUntil(cache.put(key, res.clone()));
    return res;
  }

  // Pages: the app shell with this route's link-preview tags; a party page describes that party.
  let card = req.method === 'GET' ? cardFor(url.pathname) : null;
  const party = url.pathname.match(/^\/(?:union|party|b)\/(0x[0-9a-fA-F]{40})$/)?.[1];
  // Each party page costs RPC reads, so it is rate limited; over the limit, or not one of ours, it gets the generic card.
  const creditId = url.pathname.match(/^\/credit\/(\d{1,6})$/)?.[1];
  if (card && creditId && inSupply(Number(creditId))) card = creditCard(Number(creditId));
  // The Credits overview: the edition's real count.
  if (card && url.pathname.replace(/\/$/, '') === '/credits') card = (await load(env.ASSETS, url.origin).then((t) => creditsCard(t.length)).catch(() => null)) ?? card;
  // A trait page (/weight/sparse): its name and how many Credits in the edition have it.
  const traitAt = req.method === 'GET' ? url.pathname.match(/^\/(palette|eights|print|weight)\/([^/]+)\/?$/) : null;
  const trait = traitAt ? (() => { try { return parseTrait(traitAt[1], traitAt[2]); } catch { return null; } })() : null;
  if (trait) card = traitCard(trait.name, (await match(env.ASSETS, url.origin, trait.rules, 1).catch(() => null))?.count ?? null);
  // A time window (/time?from=&to=): how many Credits were paid in it.
  const paidFrom = Number(url.searchParams.get('from')), paidTo = Number(url.searchParams.get('to'));
  if (card && url.pathname === '/time' && paidFrom > 0 && paidTo >= paidFrom && paidTo < 2 ** 32)
    card = (await match(env.ASSETS, url.origin, { paidFrom, paidTo }, 1).then((m) => timeCard(m.count)).catch(() => null)) ?? card;
  // A range (/rating?min=443.1&max=800, /bits?min=20&max=40): how many Credits are in it.
  const rMin = Number(url.searchParams.get('min')), rMax = Number(url.searchParams.get('max'));
  if (card && (url.pathname === '/rating' || url.pathname === '/bits') && url.searchParams.has('min') && url.searchParams.has('max') && Number.isFinite(rMin) && Number.isFinite(rMax) && rMin <= rMax) {
    const rating = url.pathname === '/rating';
    const lo = rating ? Math.max(800, Math.min(8000, Math.round(rMin * 10))) : Math.max(0, Math.min(256, Math.round(rMin)));
    const hi = rating ? Math.max(800, Math.min(8000, Math.round(rMax * 10))) : Math.max(0, Math.min(256, Math.round(rMax)));
    const rules = rating ? { minScore: lo, maxScore: hi } : { bitsFrom: lo, bitsTo: hi };
    const show = (x: number) => (rating ? (x / 10).toFixed(1) : String(x));
    card = (await match(env.ASSETS, url.origin, rules, 1).then((m) => rangeCard(rating ? 'rating' : 'bits', m.count, show(lo), show(hi))).catch(() => null)) ?? card;
  }
  if (card && party && !(await limited(env.RL_MISC, req)) && (await isBatch(env, url, party.toLowerCase() as Address))) {
    const p = await readParty(env, party as Address, url, ctx).catch(() => null);
    if (p) card = partyCard(party, p.name, ruleLine(p.filter, p.allowlistSize));
  }
  if (card) {
    const shell = await env.ASSETS.fetch(new Request(new URL('/', url), req));
    if (shell.ok && (shell.headers.get('content-type') ?? '').includes('text/html')) return withCard(shell, card, url, bootHead(env, url));
    return shell;
  }

  return env.ASSETS.fetch(req);
}

/// Pages that read the union list: it starts loading alongside the scripts instead of after them.
const LISTS = /^\/(unions|parties|auctions|me|member|credit|credits|palette|eights|print|weight|time|rating|bits|og|create)(\/|$)/;
/// Into every page's head: the app's config, so the first draw doesn't wait on /config.json, and on pages that
/// list Credit Unions a preload of the union index.
function bootHead(env: Env, url: URL) {
  const config = `<script type="application/json" id="config">${JSON.stringify(publicConfig(env)).replace(/</g, '\\u003c')}</script>`;
  return LISTS.test(url.pathname) ? `${config}\n  <link rel="preload" href="/unions.json" as="fetch" crossorigin="anonymous">` : config;
}

/// What a Credit's card shows, from the edition's packed traits and score table.
async function creditFacts(env: Env, url: URL, id: number): Promise<CreditFacts> {
  const [table, sc] = await Promise.all([load(env.ASSETS, url.origin), loadScores(env.ASSETS, url.origin)]);
  const t = table[id - 1] ?? 0;
  const mine = sc[id - 1] ?? 0;
  let above = 0;
  for (let i = 0; i < sc.length; i++) if (sc[i] > mine) above++;
  return {
    palette: t & 15,
    print: ['Registered', 'Nudge', 'Slip', 'Skew', 'Drift', 'Loose'][(t >> 4) & 7] ?? '–',
    weight: ['even', 'lean', 'sparse', 'extreme'][(t >> 7) & 3],
    eights: (t >> 9) & 31,
    score: mine ? mine / 10 : null,
    rank: mine ? above + 1 : null,
    of: sc.length,
  };
}


/// What a link card needs from a Credit Union: only what never changes, its name and its rule. Kept for good.
type UnionFacts = { name: string; filter: Filter; allowlistSize: number };
async function readParty(env: Env, batch: Address, url?: URL, ctx?: ExecutionContext): Promise<UnionFacts> {
  const key = url && new Request(`${url.origin}/union-facts/v1/${batch.toLowerCase()}`);
  const hit = key && (await caches.default.match(key));
  if (hit) return fromJson(await hit.text()) as UnionFacts;
  const s = (await client(env).readContract({ address: batch, abi: batchAbi, functionName: 'summary' })) as unknown as {
    name: string;
    filter: Filter;
    allowlistSize: bigint;
  };
  // names are the creator's; cards and tags show at most 64 characters
  const facts = { name: [...s.name].slice(0, 64).join(''), filter: s.filter, allowlistSize: Number(s.allowlistSize) };
  if (key) ctx?.waitUntil(caches.default.put(key, new Response(toJson(facts), { headers: { 'cache-control': 'public, max-age=31536000, immutable' } })));
  return facts;
}

/// Every Credit Union, newest first, with its summary (Batch.summary, bigints as { "$n": "…" }) and slots: two
/// calls per union in one Multicall3 pass, cached a few seconds for everyone. `fresh` (after the reader's own
/// transaction) reads the chain now and refreshes the cache for everyone else.
const UNIONS_S = 10;
async function unionsJson(env: Env, url: URL, ctx: ExecutionContext, fresh: boolean): Promise<Response> {
  try {
    return new Response(await unionsBody(env, url, ctx, fresh), { headers: { 'content-type': 'application/json', 'cache-control': `public, max-age=${UNIONS_S}` } });
  } catch (e) {
    return Response.json({ error: safeError(e) }, { status: 502, headers: { 'cache-control': 'no-store' } });
  }
}
async function unionsBody(env: Env, url: URL, ctx: ExecutionContext, fresh = false): Promise<string> {
  const key = new Request(`${url.origin}/unions.json/v1`);
  const hit = fresh ? null : await caches.default.match(key);
  if (hit) return hit.text();
  const body = await readUnions(env);
  ctx.waitUntil(caches.default.put(key, new Response(body, { headers: { 'content-type': 'application/json', 'cache-control': `public, max-age=${UNIONS_S}` } })));
  return body;
}

async function readUnions(env: Env): Promise<string> {
  return toJson({ at: Math.floor(Date.now() / 1000), unions: await unionList(env) });
}
async function unionList(env: Env) {
  const c = client(env);
  const n = Number(await c.readContract({ address: env.FACTORY as Address, abi: factoryAbi, functionName: 'batchCount' }));
  const pages = await Promise.all(
    Array.from({ length: Math.ceil(n / 500) }, (_, k) =>
      c.readContract({ address: env.FACTORY as Address, abi: factoryAbi, functionName: 'batches', args: [BigInt(k * 500), 500n] }),
    ),
  );
  const addrs = pages.flat() as Address[];
  const contracts = addrs.flatMap((a) => [
    { address: a, abi: batchAbi, functionName: 'summary' } as const,
    { address: a, abi: batchAbi, functionName: 'slots' } as const,
  ]);
  const res = hasMulticall(env)
    ? await c.multicall({ contracts, allowFailure: true, multicallAddress: MULTICALL3, batchSize: 8_192 }) // ~25 unions a call: a full one's slots cost ~350k gas to read
    : await Promise.all(contracts.map((x) => c.readContract(x).then((result) => ({ status: 'success' as const, result }), () => ({ status: 'failure' as const, result: undefined }))));
  const unions = addrs.flatMap((address, i) => {
    const [s, sl] = [res[2 * i], res[2 * i + 1]];
    if (s.status !== 'success' || sl.status !== 'success') return [];
    const [ids, depositors] = sl.result as readonly [readonly bigint[], readonly Address[]];
    return [{ address, summary: s.result, ids: ids.map(Number), depositors }];
  });
  return unions;
}

/// A rule as the matcher's Rules, to pick the card's wall.
const rulesOf = (f: Filter) => ({
  palettes: f.palettes, prints: f.prints, weights: f.weights, eights: f.eights,
  paidFrom: Number(f.paidFrom), paidTo: Number(f.paidTo), idFrom: Number(f.idFrom), idTo: Number(f.idTo),
  minScore: f.minScore, maxScore: f.maxScore, bitsFrom: f.bitsFrom, bitsTo: f.bitsTo,
});

/// Every Credit the rules let in, in Credit order.
async function admitted(env: Env, url: URL, rules: Record<string, number>): Promise<number[]> {
  const [t, ok] = await Promise.all([load(env.ASSETS, url.origin), predicate(env.ASSETS, url.origin, rules)]);
  const out: number[] = [];
  for (let id = 1; id <= t.length; id++) if (ok(id)) out.push(id);
  return out;
}

const MULTICALL3: Address = '0xcA11bde05977b3631167028862bE2a173976CA11'; // same address on every chain
/// A fresh local anvil chain (31337) has no Multicall3: reads there go one by one.
const hasMulticall = (env: Env) => env.CHAIN_ID !== '31337';

/// Link cards draw each Credit exactly as its contract does (print.ts): its seed and payment second, for every id
/// in one multicall, so a full sheet costs one subrequest. null where a Credit has no seed or the read failed; the
/// card then falls back to wall.bin. `real`: the mainnet edition (made-up sample cards) on any network.
async function printsFor(env: Env, ids: number[], real = false): Promise<(Rect[] | null)[]> {
  const want = ids.filter((id) => inSupply(id));
  if (!want.length) return ids.map(() => null);
  const main = real && env.CHAIN_ID !== '1';
  const address = main ? MAINNET_CREDITS : env.CREDITS;
  try {
    const res = await (main ? mainClient(env) : client(env)).multicall({
      contracts: want.flatMap((id) => [
        { address, abi: creditsAbi, functionName: 'seedOf', args: [BigInt(id)] } as const,
        { address, abi: creditsAbi, functionName: 'timestampOf', args: [BigInt(id)] } as const,
      ]),
      allowFailure: true,
      multicallAddress: MULTICALL3,
    });
    const byId = new Map<number, Promise<Rect[] | null>>();
    want.forEach((id, i) => {
      const seed = res[2 * i], ts = res[2 * i + 1];
      const ok = seed.status === 'success' && ts.status === 'success' && !/^0x0+$/.test(String(seed.result));
      byId.set(id, ok ? printOf(hexToBytes(seed.result as Hex), Number(ts.result)) : Promise.resolve(null));
    });
    return await Promise.all(ids.map((id) => byId.get(id) ?? null));
  } catch {
    return ids.map(() => null);
  }
}

/// /og/party/<address>.png and /og/sample/<kind>.png. A union's card never changes (name and rule are fixed), so
/// it's cached a day. Cached by path plus the `v` design version only, so made-up query strings can't force a redraw.
async function linkCard(req: Request, env: Env, url: URL, ctx: ExecutionContext, kind: string, key: string): Promise<Response> {
  const cache = caches.default;
  const v = url.searchParams.get('v') ?? '';
  const cacheKey = `${url.origin}${url.pathname.toLowerCase()}${/^\d{1,3}$/.test(v) ? `?v=${v}` : ''}`;
  const hit = await cache.match(cacheKey);
  if (hit) return hit;
  const generic = () => env.ASSETS.fetch(new Request(new URL('/og/party.png', url)));
  if (await limited(env.RL_MISC, req)) return generic();
  let u: UnionCard | null = null;
  try {
    if (kind === 'sample') {
      const x = sample(key);
      if (x) u = { name: x.name, ids: await admitted(env, url, x.rules) };
    } else if (/^0x[0-9a-fA-F]{40}$/.test(key) && (await isBatch(env, url, key.toLowerCase() as Address))) {
      const p = await readParty(env, key as Address, url, ctx);
      u = { name: p.name, ids: await admitted(env, url, rulesOf(p.filter)) };
    }
  } catch {
    u = null;
  }
  if (!u) return generic();
  const body = await drawUnion(env.ASSETS, url.origin, u);
  const res = new Response(body, { headers: { 'content-type': 'image/png', 'cache-control': 'public, max-age=86400' } });
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
  // Targets outside `allowed`, by the call that first names each. They are checked together below (Credits' art
  // contract once, each batch address once, in parallel), not one call at a time.
  const others = new Map<string, number>();
  let refused: Response | null = null; // the first malformed call's answer, once the calls before it are cleared
  for (const c of calls) {
    refused = checkCall(c);
    if (refused) break;
  }
  function checkCall(c: unknown): Response | null {
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
      if (!allowed.has(to) && !others.has(to)) others.set(to, clean.length);
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
    return null;
  }
  // eth_call only to our contracts: Credits, the factory, the Sweeper, Credits' art contract, or a batch the
  // factory made. Every target named before the first malformed call must pass, as when checked in order.
  if (others.size) {
    const art = await artOf(env);
    const rest = [...others.keys()].filter((to) => to !== art);
    const ok = await Promise.all(rest.map((to) => isBatch(env, url, to as Address)));
    if (ok.some((x) => !x)) return text('target not allowed', 403);
  }
  if (refused) return refused;
  const payload = JSON.stringify(Array.isArray(parsed) ? clean : clean[0]);
  const post = (to: string) => fetch(to, { method: 'POST', headers: { 'content-type': 'application/json' }, body: payload }).catch(() => null);
  // The paid key over its limit, refused or down: the public node answers instead, so pages and pre-send
  // simulations keep working.
  let upstream = await post(rpcUrl(env));
  if ((!upstream || [401, 403, 429].includes(upstream.status) || upstream.status >= 500) && hasFallback(env)) upstream = await post(env.FALLBACK_RPC);
  if (!upstream) return text('upstream unavailable', 502);
  return new Response(upstream.body, {
    status: upstream.status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

/// Listings that fit a party and would land in it, cheapest first. The scan (list pages, trait and liveness
/// checks) is the expensive part and the same for everyone, so it is cached briefly and shared while in flight.
const hasSweeper = (env: Env) => !!env.SWEEPER && !/^0x0+$/.test(env.SWEEPER);
const addrOrNull = (a?: string) => (a && /^0x[0-9a-fA-F]{40}$/.test(a) && !/^0x0+$/.test(a) ? (a as Address) : null);
/// Mainnet reads (FWA). ENS_RPC when set; publicnode otherwise, which (unlike drpc's free tier) honours an eth_call's
/// gas price, needed to price FWA's randomness fee.
const mainClient = (env: Env) =>
  createPublicClient({
    chain: mainnet,
    transport: env.ENS_RPC ? http(env.ENS_RPC, { timeout: 8_000 }) : env.CHAIN_ID === '1' ? rpcTransport(env) : http('https://ethereum-rpc.publicnode.com', { timeout: 8_000 }),
  });

type Fake = { id: string; price: string; source: 'fwa' | 'strategy' | 'opensea' };
/// A price for exactly these listings, ready for the Sweeper: OpenSea's as signed Seaport orders (the Sweeper as
/// fulfiller), FWA's and CreditStrategy's each re-read now and sent by id and price. Gone ones drop out.
async function quoteListings(env: Env, url: URL, listings: Listing[]) {
  // FWA and strategy listings need no signed fill: read each again now, and send it with its price to the Sweeper.
  const main = mainClient(env);
  const confirmed = async (source: 'fwa' | 'strategy') =>
    (
      await Promise.all(
        listings
          .filter((l) => l.source === source)
          .map(async (l) =>
            (await (source === 'fwa'
              ? confirmListing(main, env.FWA_MARKET as Address, env.CREDITS, { id: l.id, price: l.price, listingId: l.listingId! })
              : confirmStrategy(main, env.STRATEGY as Address, l)
            ).catch(() => false))
              ? l
              : null,
          ),
      )
    ).filter((l): l is Listing => !!l);
  const [fwaLive, strategyLive] = await Promise.all([confirmed('fwa'), confirmed('strategy')]);
  const osPicked = listings.filter((l) => l.source === 'opensea');
  let os = { orders: [] as unknown[], ids: [] as string[], prices: [] as string[], total: '0', expires: null as number | null };
  if (osPicked.length) {
    try {
      os = await quote({ key: env.OPENSEA_API_KEY!, sweeper: env.SWEEPER, listings: osPicked, n: osPicked.length, origin: url.origin });
    } catch (e) {
      if (!fwaLive.length && !strategyLive.length) throw e; // with other listings still good, the quote is those
    }
  }
  if (!os.ids.length && !fwaLive.length && !strategyLive.length) throw new Error('Those listings just sold. Try again.');
  const fwa = fwaLive.map((l) => ({ listingId: l.listingId!, id: l.id, price: l.price }));
  const strategy = strategyLive.map((l) => ({ id: l.id, price: l.price }));
  const total = [...fwa, ...strategy].reduce((a, l) => a + BigInt(l.price), BigInt(os.total));
  return { ...os, total: total.toString(), fwa, strategy };
}

/// The cheapest Credits for sale anywhere, of one trait or of all, cached a minute per trait (the full listings,
/// with what a quote needs).
async function forSale(env: Env, url: URL, ctx: ExecutionContext, trait: ReturnType<typeof parseTrait>): Promise<Listing[]> {
  const cache = caches.default;
  const key = new Request(`${url.origin}/opensea/forsale/v2/${trait ? `${trait.kind}/${trait.slug}` : 'all'}`);
  const hit = await cache.match(key);
  if (hit) return hit.json<Listing[]>();
  const live = hasSweeper(env);
  const credits = live ? env.CREDITS : MAINNET_CREDITS;
  const c = live ? client(env) : createPublicClient({ transport: http(env.ENS_RPC || 'https://eth.drpc.org', { timeout: 8_000 }) });
  const ok = trait ? await predicate(env.ASSETS, url.origin, trait.rules) : () => true;
  const listings = (
    await scan({
      key: env.OPENSEA_API_KEY,
      slug: env.OPENSEA_SLUG,
      credits,
      ...(await extras(env, url, ctx)),
      max: FOR_SALE,
      take: async (ids) => ids.map((id) => ok(Number(id))),
      live: (id, seller, operator) =>
        Promise.all([
          c.readContract({ address: credits, abi: creditsAbi, functionName: 'ownerOf', args: [id] }),
          c.readContract({ address: credits, abi: creditsAbi, functionName: 'isApprovedForAll', args: [seller, operator] }),
        ]).then(([o, a]) => o.toLowerCase() === seller.toLowerCase() && a),
      hasCode: (a) => c.getCode({ address: a }).then((code) => !!code && code !== '0x'),
    })
  ).slice(0, FOR_SALE);
  ctx.waitUntil(cache.put(key, Response.json(listings, { headers: { 'cache-control': 'public, max-age=60' } })));
  return listings;
}

/// Where a listing can be seen on its own marketplace. OpenSea's is the Credit's item page (mainnet's on testnets).
function listingUrl(env: Env, live: boolean, l: Pick<Listing, 'id' | 'source'>): string {
  if (l.source === 'strategy') return `https://www.nftstrategy.fun/strategies/${(addrOrNull(env.STRATEGY) ?? '').toLowerCase()}`;
  if (l.source === 'fwa') return 'https://fwa.fun';
  return `https://opensea.io/assets/ethereum/${(live ? env.CREDITS : MAINNET_CREDITS).toLowerCase()}/${l.id}`;
}
/// A trait as OpenSea's Credits metadata names it, so its listings can be asked for directly.
function openseaTrait(t: NonNullable<ReturnType<typeof parseTrait>>): { traitType: string; value: string } {
  if (t.kind === 'palette') return { traitType: 'Colors', value: t.name };
  if (t.kind === 'eights') return { traitType: 'Eights', value: ['None', 'One', 'Two', 'Three', 'Four', 'Five'][t.v - 1] };
  const cap = t.slug.charAt(0).toUpperCase() + t.slug.slice(1);
  return { traitType: t.kind === 'print' ? 'Print' : 'Weight', value: cap };
}

/// OpenSea pages (100 listings each) a range search reads, cheapest first, before it stops: past every listing
/// today, as a guard.
const RANGE_DEPTH = 150;

/// Credits in a For sale row.
const FOR_SALE = 10;
/// The most Credits one sweep takes.
const MAX_SWEEP = 24;
/// Listed Credits per page of /opensea/listed (before a trait filters them).
const LISTED_CHUNK = 60;
const offOpenSea = (env: Env) => !!(addrOrNull(env.FWA_MARKET) || addrOrNull(env.STRATEGY));
/// DEV_FAKE_LISTINGS, on localhost only: made-up listings to see both sources on the Buy tab without real ones.
function devFake(env: Env, url: URL): Fake[] | null {
  if (!env.DEV_FAKE_LISTINGS || !isDev(url)) return null;
  try {
    const list = JSON.parse(env.DEV_FAKE_LISTINGS) as Fake[];
    return Array.isArray(list) ? list.filter((f) => /^\d{1,6}$/.test(String(f.id)) && /^\d{1,30}$/.test(String(f.price))) : null;
  } catch {
    return null;
  }
}

/// Live mainnet listings off OpenSea, as extras for the scan: FWA's marketplace and CreditStrategy's holdings.
/// A failed read of either is no listings from it, never a failed Buy tab.
async function extras(env: Env, url: URL, ctx: ExecutionContext): Promise<{ extra: Extra[]; fakeOpenSea?: { id: string; price: string }[] }> {
  const fake = devFake(env, url);
  if (fake) {
    const os = fake.filter((f) => f.source === 'opensea').map((f) => ({ id: String(f.id), price: String(f.price) }));
    return {
      extra: fake
        .filter((f) => f.source !== 'opensea')
        .map((f, i) => ({ id: String(f.id), price: String(f.price), source: f.source as Extra['source'], listingId: f.source === 'fwa' ? String(900_000 + i) : undefined })),
      fakeOpenSea: os.length ? os : undefined, // none: the real OpenSea listings
    };
  }
  const [fwa, strategy] = await Promise.all([fwaListings(env, url, ctx), heldByStrategy(env, url, ctx)]);
  return { extra: [...fwa, ...strategy] };
}

async function fwaListings(env: Env, url: URL, ctx: ExecutionContext): Promise<Extra[]> {
  const market = addrOrNull(env.FWA_MARKET);
  if (!market) return [];
  const cache = caches.default;
  const key = new Request(`${url.origin}/fwa/listings/${market.toLowerCase()}`);
  const hit = await cache.match(key);
  const tag = (ls: FwaListing[]): Extra[] => ls.map((l) => ({ ...l, source: 'fwa' }));
  if (hit) return tag(await hit.json<FwaListing[]>());
  try {
    const live = await marketListings(mainClient(env), { market, collection: MAINNET_CREDITS, store: cacheStore(url.origin) });
    ctx.waitUntil(cache.put(key, Response.json(live, { headers: { 'cache-control': 'public, max-age=30' } })));
    return tag(live);
  } catch (e) {
    console.warn('[fwa] listings unavailable', safeError(e));
    return [];
  }
}

/// The Credits CreditStrategy has for sale. Reading them is 13 heavy eth_calls, so the result is cached for a
/// minute and shared while in flight; a Credit sold since is dropped when it is quoted.
let strategyRead: Promise<Extra[]> | null = null;
async function heldByStrategy(env: Env, url: URL, ctx: ExecutionContext): Promise<Extra[]> {
  const strategy = addrOrNull(env.STRATEGY);
  if (!strategy) return [];
  const cache = caches.default;
  const key = new Request(`${url.origin}/strategy/listings/${strategy.toLowerCase()}`);
  const hit = await cache.match(key);
  if (hit) return hit.json<Extra[]>();
  if (!strategyRead) {
    strategyRead = strategyListings(mainClient(env), { strategy, supply: SUPPLY })
      .then((ls) => {
        const out = ls.map((l): Extra => ({ ...l, source: 'strategy' }));
        ctx.waitUntil(cache.put(key, Response.json(out, { headers: { 'cache-control': 'public, max-age=60' } })));
        return out;
      })
      .catch((e) => {
        console.warn('[strategy] listings unavailable', safeError(e));
        return [];
      })
      .finally(() => {
        strategyRead = null;
      });
  }
  return strategyRead;
}

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
  // A painted sheet: book each listing against the slots still free, as Batch.canTake would, by the Credit's
  // real (edition) value of the painted trait, since this testnet sheet can't read mainnet Credits.
  let book: ((ids: bigint[]) => boolean[]) | null = null;
  if (layout[0] || layout[1]) {
    const trait = Number(f.layoutTrait ?? 0);
    const slots = new Array(16).fill(0);
    let any = 0;
    for (let i = 0; i < 80; i++) {
      const v = Number((layout[i < 64 ? 0 : 1] >> BigInt(4 * (i < 64 ? i : i - 64))) & 15n);
      if (v) slots[v]++;
      else any++;
    }
    const c = client(env);
    const [ids] = (await c.readContract({ address: batch, abi: batchAbi, functionName: 'slots' })) as readonly [readonly bigint[], readonly Address[]];
    const keys = (await Promise.all(ids.map((id) => c.readContract({ address: batch, abi: batchAbi, functionName: 'keyOf', args: [id] })))) as number[];
    const have0 = new Array(16).fill(0);
    for (const k of keys) have0[Number(k)]++;
    const spill0 = have0.reduce((n, h, p) => n + Math.max(0, h - slots[p]), 0);
    const table = await load(env.ASSETS, url.origin);
    book = (xs) => {
      const have = [...have0];
      let spill = spill0;
      return xs.map((id) => {
        const p = keyOf(trait, table[Number(id) - 1] ?? 0);
        if (have[p] >= slots[p]) {
          if (spill >= any) return false;
          spill++;
        }
        have[p]++;
        return true;
      });
    };
  }
  const more = await extras(env, url, ctx);
  const listings = await scan({
    key: env.OPENSEA_API_KEY,
    slug: env.OPENSEA_SLUG,
    credits: MAINNET_CREDITS,
    ...more,
    max: 40,
    take: async (ids) => {
      const pass = await Promise.all(ids.map(async (id) => ok(Number(id)) && (await inList(id))));
      if (!book) return pass;
      const fit = book(ids.filter((_, i) => pass[i]));
      let j = 0;
      return pass.map((p) => p && fit[j++]);
    },
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
    const p = extras(env, url, ctx).then((more) => scan({
      key: env.OPENSEA_API_KEY,
      slug: env.OPENSEA_SLUG,
      credits: env.CREDITS,
      ...more,
      max: 40,
      take: (ids) => c.readContract({ address: batch, abi: batchAbi, functionName: 'canTake', args: [ids] }),
      live: (id, seller, operator) =>
        Promise.all([
          c.readContract({ address: env.CREDITS, abi: creditsAbi, functionName: 'ownerOf', args: [id] }),
          c.readContract({ address: env.CREDITS, abi: creditsAbi, functionName: 'isApprovedForAll', args: [seller, operator] }),
        ]).then(([o, ok]) => o.toLowerCase() === seller.toLowerCase() && ok),
      hasCode: (a) => c.getCode({ address: a }).then((code) => !!code && code !== '0x'),
    }));
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

/// A Credits contract's art contract, as Credits itself names it (`art()`): the app asks it for a Credit's traits
/// (describe) the way a batch does, and /art draws with it. Read once per isolate per Credits contract (the
/// configured one, and mainnet's for previews); only a well-formed nonzero address is ever returned.
const artAddrs = new Map<string, Promise<string | null>>();
function artOf(env: Env, credits: Address = env.CREDITS, c: ReturnType<typeof client> = client(env)): Promise<string | null> {
  const key = credits.toLowerCase();
  let at = artAddrs.get(key);
  if (!at) {
    const read = c
      .readContract({ address: credits, abi: creditsAbi, functionName: 'art' })
      .then((a) => {
        const v = String(a).toLowerCase();
        return /^0x[0-9a-f]{40}$/.test(v) && !/^0x0+$/.test(v) ? v : null;
      })
      .catch(() => null);
    at = read;
    artAddrs.set(key, read);
    // A failed read is retried on the next call rather than remembered.
    void read.then((v) => {
      if (v === null && artAddrs.get(key) === read) artAddrs.delete(key);
    });
  }
  return at;
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

/// Credits per block of wall.bin, as scripts/bins.mjs cuts them.
const WALL_BLOCK = 4096;

/// /<file>.bin and /wall/<k>.bin: the edition's data files. The build keeps a brotli and a gzip copy beside each
/// (scripts/bins.mjs), handed out as they are, since Cloudflare leaves application/octet-stream uncompressed. The
/// app asks with the file's content hash (?v=), so the browser keeps it for good; without one, for five minutes.
/// Null when there is no such file: the request then goes to the assets as before. The Worker's own reads
/// (env.ASSETS) never come through here, so they still get the raw bytes.
async function serveBin(req: Request, env: Env, url: URL, name: string): Promise<Response | null> {
  const asset = (path: string) =>
    env.ASSETS.fetch(new Request(`${url.origin}/${path}`)).then((r) => (r.ok && !(r.headers.get('content-type') ?? '').includes('text/html') ? r : null));
  // Encodings the client takes (q=0 means no).
  const takes = new Set(
    (req.headers.get('accept-encoding') ?? '')
      .split(',')
      .map((p) => p.trim().split(';'))
      .filter(([, q]) => !q || !/^\s*q\s*=\s*0(\.0*)?\s*$/.test(q))
      .map(([e]) => e.trim().toLowerCase()),
  );
  let found: Response | null = null, encoding = '';
  // Cloudflare hands the Worker a normalized Accept-Encoding and decompresses for clients that can't take the
  // encoding. `vite preview` can't pass a precompressed body on, so on localhost the raw file goes.
  for (const [enc, ext] of [['br', 'br'], ['gzip', 'gz']] as const) {
    if (!takes.has(enc) || isDev(url)) continue;
    found = await asset(`${name}.bin.${ext}`);
    if (found) {
      encoding = enc;
      break;
    }
  }
  found ??= await asset(`${name}.bin`);
  let body: BodyInit | null = found?.body ?? null;
  if (!found) {
    // Development serves public/ as it is, without the build's blocks: cut the block from wall.bin here.
    const k = Number(name.match(/^wall\/(\d+)$/)?.[1] ?? -1);
    const whole = k >= 0 && isDev(url) ? await asset('wall.bin') : null;
    if (!whole) return null;
    const cut = (await whole.arrayBuffer()).slice(k * WALL_BLOCK * 32, (k + 1) * WALL_BLOCK * 32);
    if (!cut.byteLength) return null;
    body = cut;
  }
  const h = new Headers({
    'content-type': 'application/octet-stream',
    vary: 'accept-encoding',
    'cache-control': isDev(url) ? 'no-cache' : url.searchParams.has('v') ? 'public, max-age=31536000, immutable' : 'public, max-age=300',
  });
  if (encoding) h.set('content-encoding', encoding);
  const len = found?.headers.get('content-length');
  if (len) h.set('content-length', len);
  const res = new Response(req.method === 'HEAD' ? null : body, { headers: h, encodeBody: encoding ? 'manual' : 'automatic' });
  if (encoding) precompressed.add(res);
  return res;
}
