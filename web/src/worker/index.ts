/// Credit Union's Worker. It holds no state and signs nothing. Its jobs:
///   /config.json   chain id and contract addresses for the app
///   /rpc           read-only JSON-RPC proxy to our contracts (and Credits' art) only (keeps the provider key private)
///   /unions.json   every Credit Union, summary and slots, read once per block for the whole site (ChainBook);
///                  ?union= just one, which a union page polls instead of the chain
///   /passes        which of a wallet's Credits a Credit Union takes, in one multicall
///   /activity.json what wallets have done on the site, newest first (the Activity page)
///   /art/...       a Credit's art, read from Jack's art contract once and kept for good in KV (art never changes)
///   /*.bin         the edition's data files, precompressed at build and cached by the browser until they change
///   /opensea/quote cheapest listings that fit a batch (OpenSea as signed Seaport orders, FWA, CreditStrategy)
///   /opensea/credit/:id  one Credit's best OpenSea listing price (mainnet's, as a preview, on testnets)
///   /opensea/credits?ids=  many Credits' best listings at once, from the market book
///   /ens/:address  primary ENS name (always from mainnet), cached a day
/// Every response carries the security headers in `secure()` (headers.ts; the build copies them into _headers for
/// what the asset layer serves on its own).
import { DurableObject } from 'cloudflare:workers';
import { createPublicClient, decodeFunctionData, fallback, hexToBytes, http, type Address, type Hex, parseAbiItem } from 'viem';
import { mainnet } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { normalize } from 'viem/ens';
import { batchAbi, creditsAbi, creditArtAbi, factoryAbi, unionFormatsAbi } from '../app/abi';
import { setSpareKey, best, bestOrder, bestPage, events, quote, scan, type Cand, type Extra, type Listing } from './opensea';
import type { Row } from './market';
import { cacheStore, confirmListing, marketListings, type FwaListing } from './fwa';
import { confirmStrategy, strategyAbi, strategyListings } from './strategy';
import { ratings } from './ratings';
import { load, loadScores, match, predicate, type Rules } from './match';
import { cardFor, creditCard, creditsCard, partyCard, rangeCard, ruleLine, timeCard, traitCard, withCard, type Filter } from './og';
import { parseTrait } from '../shared/trait';
import { drawCredit, drawUnion, sample, type CreditFacts, type UnionCard } from './card';
import { printOf, type Rect } from './print';
import { readActivity, type Activity } from './activity';
import { keyOf, ruleFor } from '../shared/layout';
import { ALWAYS, CSP, HSTS } from './headers';
import { fromJson, toJson } from '../shared/json';
import { idsKey } from '../shared/ids';
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
  OPENSEA_API_KEY_2?: string; // tried when the first is rate limited
  RPC_URL?: string;
  FALLBACK_RPC: string;
  ACTIVITY_MIRROR?: string; // local dev only: serve /activity.json from this URL
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
  /// Plans (/plan/<id>): a design's 80 Credits in slot order and who buys and deposits which. Unset: plans are off.
  PLANS?: KVNamespace;
  /// Buy locks for Picture unions (locks.ts), one object per union.
  LOCKS?: DurableObjectNamespace<import('./locks').BuyLocks>;
  MARKET?: DurableObjectNamespace<import('./market').MarketBook>;
  /// The chain read once for the whole site: the union index and the Activity feed (ChainBook, below).
  CHAIN?: DurableObjectNamespace<ChainBook>;
  /// FWA's marketplace on mainnet: a second Buy Credits source. Empty to turn it off.
  FWA_MARKET?: string;
  /// UnionFormats: where each union's creator picks its Statement format. Zero until deployed.
  FORMATS?: string;
  /// Token unions (TokenAdapter's factory, the adapter, that factory's UnionFormats). Empty until deployed.
  TOKEN_FACTORY?: string;
  TOKEN_ADAPTER?: string;
  TOKEN_FORMATS?: string;
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
  'eth_getBalance', // a bidder's own ETH, shown under the bid box
]);
/// A full sweep's simulation is the biggest body: 40 Seaport orders are ~65 KB of calldata, ~130 KB as hex.
const MAX_RPC_BODY = 200_000;
const MAX_CALL_BYTES = 96_000;
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
/// The RPCs to try in order: the paid one, then the public one.
const rpcList = (env: Env) => [...new Set([env.RPC_URL, env.FALLBACK_RPC].filter((u): u is string => !!u))];
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

/// What never changes (a Credit's art, its seed) or changes slowly (an ENS name, with `ttl`), kept once in KV for
/// every data center: the colo cache is per data center, so without this each of them reads the chain for the same
/// thing. Misses and failures are nothing, never an error.
async function keptGet(env: Env, key: string): Promise<string | null> {
  return env.PLANS ? env.PLANS.get(key, { cacheTtl: 3600 }).catch(() => null) : null;
}
async function keptPut(env: Env, key: string, value: string | Uint8Array, ttl?: number): Promise<void> {
  await env.PLANS?.put(key, value, ttl ? { expirationTtl: ttl } : undefined).catch(() => {});
}
/// A drawn image kept in KV (a link card): drawn once for every data center, not once per data center.
async function keptPng(env: Env, key: string): Promise<ArrayBuffer | null> {
  return env.PLANS ? env.PLANS.get(key, { type: 'arrayBuffer', cacheTtl: 3600 }).catch(() => null) : null;
}

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
export { BuyLocks } from './locks';
export { MarketBook } from './market';

export default {
  async fetch(req, env, ctx): Promise<Response> {
    setSpareKey(env.OPENSEA_API_KEY_2);
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

  // Every 5 minutes: the keeper (keeper.ts), once KEEPER_KEY is set.
  async scheduled(_event, env, ctx) {
    // The market book, kept live each minute (keepMarket).
    ctx.waitUntil(keepMarket(env, ctx).catch((e) => console.error('[market] update failed', safeError(e))));
    // The keeper runs every 5 minutes, as before.
    if (new Date(_event.scheduledTime).getUTCMinutes() % 5 !== 0) return;
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

/// Every Activity row (newest first) with plans' unions left out until they fill. Read once for the site by the
/// ChainBook (at most every FEED_MS), kept FEED_MS in the colo cache and in this isolate, so /activity.json's slices
/// never rescan and never parse the whole feed per request. Without the ChainBook, this data center reads it itself.
let feedMemo: { got: number; at: number; items: Activity[] } | null = null;
let feedRead: Promise<Activity[]> | null = null;
async function activityAll(env: Env, url: URL, ctx: ExecutionContext): Promise<Activity[]> {
  if (feedMemo && Date.now() - feedMemo.got < FEED_MS) return feedMemo.items;
  if (feedRead) return feedRead;
  const p = (async () => {
    const key = new Request(`${url.origin}/activity-all/v2`);
    const hit = await caches.default.match(key);
    const at = Number(hit?.headers.get('x-read-at'));
    if (hit && at) {
      const items = feedMemo?.at === at ? feedMemo.items : ((await hit.json()) as Activity[]);
      feedMemo = { got: Date.now(), at, items };
      return items;
    }
    let v: { at: number; body: string };
    const book = chainBook(env);
    try {
      if (!book) throw new Error('no ChainBook');
      v = await book.activity(BOOK_MS);
    } catch (e) {
      if (book) console.warn('[chain] feed read here', safeError(e));
      v = { at: Date.now(), body: JSON.stringify(await activityItems(env, caches.default, `${url.origin}/activity-state/${env.FACTORY.toLowerCase()}`)) };
    }
    ctx.waitUntil(caches.default.put(key, new Response(v.body, { headers: { 'content-type': 'application/json', 'cache-control': `public, max-age=${FEED_MS / 1000}`, 'x-read-at': String(v.at) } })));
    const items = JSON.parse(v.body) as Activity[];
    feedMemo = { got: Date.now(), at: v.at, items };
    return items;
  })();
  feedRead = p;
  void p.finally(() => feedRead === p && (feedRead = null)).catch(() => {});
  return p;
}

/// The feed read from the chain: the scan state lives in `store` (the colo cache, or the ChainBook's storage).
async function activityItems(env: Env, store: Cache, stateKey: string): Promise<Activity[]> {
  const c = client(env);
  // Mainnet scans from the factory's deploy block; elsewhere, the last ~2 weeks.
  const from = env.CHAIN_ID === '1' ? ACTIVITY_FROM : (await c.getBlockNumber()) - 100_000n;
  const items = await readActivity(c as never, store, stateKey, {
    factory: env.FACTORY,
    sweeper: hasSweeper(env) ? env.SWEEPER : null,
    credits: env.CREDITS,
    from: from < 0n ? 0n : from,
  });
  // A plan's union stays out of Activity until it fills.
  const hidden = await hiddenUnions(env);
  const filling = new Set<string>();
  await Promise.all(
    [...hidden].map(async (a) => {
      const s = (await c.readContract({ address: a as Address, abi: batchAbi, functionName: 'summary' }).catch(() => null)) as { count: bigint } | null;
      if (!s || Number(s.count) < 80) filling.add(a);
    }),
  );
  return filling.size ? items.filter((x) => !x.union || !filling.has(x.union.toLowerCase())) : items;
}

/// Burn day's hold: the PLANS key `burns-open` is "1" (open now) or a unix time (open from then, and every union page
/// counts down to it). Unset: held, no time yet. The page keeps Convert Union to Statement disabled while held (anyone can still call
/// assemble() directly; the keeper never burns). No deploy needed:
///   pnpm wrangler kv key put --binding PLANS burns-open 1790902800 --remote
async function burnsOpen(env: Env): Promise<{ open: boolean; at: number | null }> {
  const v = (await env.PLANS?.get('burns-open', { cacheTtl: 30 })) ?? '';
  if (v === '1') return { open: true, at: null };
  const at = /^\d{10}$/.test(v) ? Number(v) : null;
  return { open: at !== null && Date.now() / 1000 >= at, at };
}

/// The keeper's address, never its key, at /burns: so its gas money can be checked before burn day.
let keeperAddr: Address | null | undefined;
const keeperOf = (env: Env) =>
  keeperAddr !== undefined
    ? keeperAddr
    : (keeperAddr = /^0x[0-9a-fA-F]{64}$/.test(env.KEEPER_KEY ?? '') ? privateKeyToAccount(env.KEEPER_KEY as Hex).address : null);

/// Chain and addresses for the app: at /config.json, and written into every page the Worker serves (#config).
const publicConfig = (env: Env) => ({
  chainId: Number(env.CHAIN_ID),
  credits: env.CREDITS,
  factory: env.FACTORY,
  sweeper: env.OPENSEA_API_KEY && !/^0x0+$/.test(env.SWEEPER ?? '0x0') ? env.SWEEPER : null,
  ratings: env.RATINGS && !/^0x0+$/.test(env.RATINGS) ? env.RATINGS : null,
  fwaMarket: addrOrNull(env.FWA_MARKET),
  formats: addrOrNull(env.FORMATS),
  tokenFactory: addrOrNull(env.TOKEN_FACTORY),
  tokenAdapter: addrOrNull(env.TOKEN_ADAPTER),
  tokenFormats: addrOrNull(env.TOKEN_FORMATS),
});

/// /edition/match answers kept per isolate: the edition never changes within a deploy, and every visitor of /unions
/// asks for the same cards' examples.
const matchMemo = new Map<string, Awaited<ReturnType<typeof match>>>();
/// A /edition/match body as the matcher's Rules (and page); throws on anything out of range.
function matchRules(b: Record<string, unknown>): { rules: Rules; page: number } {
  const int = (k: string, min: number, max: number, dflt: number) => {
    const v = b[k];
    if (v === undefined || v === null) return dflt;
    if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) throw 0;
    return v;
  };
  const list = Array.isArray(b.list) ? b.list : [];
  if (list.length > 200 || list.some((x) => typeof x !== 'number' || !Number.isInteger(x) || x < 1 || x > 1e7)) throw 0;
  return {
    rules: {
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
    },
    page: int('page', -1, 2000, -1),
  };
}

async function handle(req: Request, env: Env, ctx: ExecutionContext, url: URL): Promise<Response> {
  if (url.pathname === '/burns') return Response.json({ ...(await burnsOpen(env)), keeper: keeperOf(env) }, { headers: { 'cache-control': 'public, max-age=15' } });
  if (url.pathname === '/config.json') return Response.json(publicConfig(env), { headers: { 'cache-control': 'public, max-age=60' } });

  if (url.pathname === '/rpc') return rpc(req, env, url);

  // Every Credit Union with its summary and slots, one cached read for everyone (the lists, profiles, Credit pages).
  // ?union=0x…: just that one, { at, union } (null when the index doesn't have it), which a union page polls instead
  // of the chain.
  if (url.pathname === '/unions.json') {
    if (req.method !== 'GET' || !sameSite(req)) return text('forbidden', 403);
    const fresh = url.searchParams.has('fresh'); // after the reader's own transaction: skip the cache
    if (fresh && (await limited(env.RL_MISC, req))) return text('slow down', 429);
    try {
      const v = await unionIndex(env, url, ctx, fresh);
      const one = url.searchParams.get('union');
      const body = one ? oneUnion(v, one) : v.body;
      return new Response(body, { headers: { 'content-type': 'application/json', 'cache-control': `public, max-age=${INDEX_MS / 1000}` } });
    } catch (e) {
      return Response.json({ error: safeError(e) }, { status: 502, headers: { 'cache-control': 'no-store' } });
    }
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
  // { many: [rules…] } (up to 50): each answered in turn, as { many: [answer…] }, for a page that needs several (the
  // union cards' examples) in one request.
  if (url.pathname === '/edition/match') {
    if (req.method !== 'POST' || !sameSite(req)) return text('forbidden', 403);
    if (await limited(env.RL_MISC, req)) return text('slow down', 429);
    let asks: { rules: Rules; page: number; key: string }[];
    let many = false;
    try {
      const raw = await readBody(req, 64_000);
      if (raw === null) return text('too large', 413);
      const b = JSON.parse(raw) as Record<string, unknown>;
      many = Array.isArray(b.many);
      const each = many ? (b.many as Record<string, unknown>[]) : [b];
      if (!each.length || each.length > 50) throw 0;
      const live = await liveTable(env);
      asks = each.map((one) => {
        const m = matchRules(one);
        return { ...m, rules: { ...m.rules, live }, key: JSON.stringify(one) + live };
      });
    } catch {
      return text('bad request', 400);
    }
    try {
      const out = [];
      for (const a of asks) {
        let m = matchMemo.get(a.key);
        if (!m) {
          m = await match(env.ASSETS, url.origin, a.rules, a.page >= 0 ? 120 : 80, a.page);
          if (matchMemo.size >= 2000) matchMemo.delete(matchMemo.keys().next().value!);
          matchMemo.set(a.key, m);
        }
        out.push(m);
      }
      return Response.json(many ? { many: out } : out[0], { headers: { 'cache-control': 'no-store' } });
    } catch (e) {
      return Response.json({ error: safeError(e) }, { status: 502 });
    }
  }

  // The whole book for the Printer: every Credit for sale (OpenSea, CreditStrategy, FWA), cheapest listing each, as
  // [id, price in wei, source]. Rebuilt every 5 minutes by the cron (reading it cold takes a minute or more), so
  // this is one storage read; buying re-prices each Credit anyway.
  // Kept 30 s in the colo cache, so a data center pulls the ~2 MB book from the object twice a minute at most, however
  // many pages ask; only a request that has to pull it counts against the rate limit.
  if (url.pathname === '/market.json') {
    if (!sameSite(req)) return text('forbidden', 403);
    const key = new Request(`${url.origin}/market.json/v2`);
    const hit = await caches.default.match(key);
    if (hit) return hit;
    if (await limited(env.RL_MISC, req, 20)) return text('slow down', 429);
    try {
      if (!env.MARKET) return Response.json({ at: Date.now(), items: [] });
      const b = book(env);
      if (!(await b.state()).rows) {
        // Not filled yet (just deployed): fill it in the background, and serve the last book kept in storage meanwhile.
        ctx.waitUntil(keepMarket(env, ctx).catch((e) => console.error('[market] fill failed', safeError(e))));
        const kept = env.PLANS ? await env.PLANS.get('market', { cacheTtl: 60 }) : null;
        if (kept) return new Response(kept, { headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=30' } });
      }
      const body = await b.snapshot();
      const res = new Response(body, { headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=30' } });
      ctx.waitUntil(caches.default.put(key, res.clone()));
      return res;
    } catch (e) {
      return Response.json({ error: safeError(e) }, { status: 502 });
    }
  }

  // Printer plans: a picture's 80 Credits, rising by number (the union burns them in Number order), each slot with
  // the friend who brings it and whether they already own it. Friends buy theirs; a slot whose listing sold before
  // it was bought takes a replacement (signed by a plan wallet); once every Credit is held, a plan wallet opens the
  // union with these 80 as its allowlist. The union stays off the site's lists until it fills.
  // A wallet's plans, for its own page. Plans are private until their union fills, so the list needs the wallet's
  // signature on "Credit Union: my plans <day>" (a day's signature, so one signing lasts the visit).
  if (url.pathname === '/plans/mine' && req.method === 'POST') {
    if (!env.PLANS) return text('plans are off here', 501);
    if (!sameSite(req)) return text('forbidden', 403);
    if (await limited(env.RL_MISC, req, 5)) return text('slow down', 429);
    try {
      const b = JSON.parse((await readBody(req, 4_000)) ?? '') as { address?: string; day?: number; sig?: string };
      const address = String(b.address ?? '').toLowerCase(), day = Number(b.day);
      if (!/^0x[0-9a-f]{40}$/.test(address) || !Number.isInteger(day) || Math.abs(day - Math.floor(Date.now() / 86_400_000)) > 1) throw 0;
      if (!(await client(env).verifyMessage({ address: address as Address, message: `Credit Union: my plans ${day}`, signature: String(b.sig) as Hex }))) return text('bad signature', 400);
      const ids = (await env.PLANS.get<string[]>(`w:${address}`, 'json')) ?? [];
      const plans = (await Promise.all(ids.map((id) => env.PLANS!.get<{ id: string; name: string; createdAt: number; union: Address | null; wallets: unknown[] }>(id, 'json'))))
        .filter((x) => !!x)
        .map((x) => ({ id: x!.id, name: x!.name, createdAt: x!.createdAt, union: x!.union, people: x!.wallets.length }));
      return Response.json({ plans }, { headers: { 'cache-control': 'no-store' } });
    } catch {
      return text('bad request', 400);
    }
  }

  // A Picture union's picture (64 × 80 RGBA, base64, and the Detail it was matched with): the page it was made on keeps it here, so every visitor's union
  // page can recommend the Credit that draws each open slot best. Once per union: the first save stands.
  // /market/moved: a transaction of ours that moved Credits (a buy or a deposit). Its receipt says which Credits left
  // whom; the market book drops those listings now instead of at its next read of the chain.
  if (url.pathname === '/market/moved') {
    if (req.method !== 'POST' || !sameSite(req)) return text('forbidden', 403);
    if (await limited(env.RL_MISC, req, 5)) return text('slow down', 429);
    const tx = String(((await req.json().catch(() => ({}))) as { tx?: unknown }).tx ?? '');
    if (!/^0x[0-9a-fA-F]{64}$/.test(tx) || !env.MARKET) return text('bad request', 400);
    try {
      const r = await client(env).getTransactionReceipt({ hash: tx as `0x${string}` });
      const moves = r.logs
        .filter((l) => l.address.toLowerCase() === env.CREDITS.toLowerCase() && l.topics[0] === '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef' && l.topics.length === 4)
        .map((l) => ({ id: String(BigInt(l.topics[3]!)), from: `0x${l.topics[1]!.slice(26)}`.toLowerCase() }));
      await book(env).moved(moves);
      return Response.json({ moved: moves.length });
    } catch (e) {
      return Response.json({ error: safeError(e) }, { status: 502 });
    }
  }

  // /placed/<union>: a layout union's Credits in deposit order, the value it recorded for each (Batch.keyOf: which
  // painted slots it takes) and each one's ink, so a card or page places and draws them from one answer instead of a
  // chain read per Credit. A deposited Credit's value never changes; the answer is kept at the edge per set of ids.
  // A union's own list of Credits, ascending: { ids }. It never changes, so it's kept for good.
  const allowPath = url.pathname.match(/^\/allowlist\/(0x[0-9a-fA-F]{40})$/);
  if (allowPath) {
    if (req.method !== 'GET' || !sameSite(req)) return text('forbidden', 403);
    const batch = allowPath[1].toLowerCase() as Address;
    const key = new Request(`${url.origin}/allowlist/${batch}`);
    const hit = await caches.default.match(key);
    if (hit) return hit;
    if (await limited(env.RL_MISC, req)) return text('slow down', 429);
    if (!(await isBatch(env, url, batch))) return text('not a batch', 404);
    const ids = await allowlistOf(env, batch);
    if (!ids) return Response.json({ error: 'The list can’t be read right now.' }, { status: 502, headers: { 'cache-control': 'no-store' } });
    const res = Response.json({ ids }, { headers: { 'cache-control': 'public, max-age=31536000, immutable' } });
    ctx.waitUntil(caches.default.put(key, res.clone()));
    return res;
  }

  const placedPath = url.pathname.match(/^\/placed\/(0x[0-9a-fA-F]{40})$/);
  if (placedPath) {
    if (req.method !== 'GET' || !sameSite(req)) return text('forbidden', 403);
    const batch = placedPath[1] as Address;
    const edgeFor = (k: string) => new Request(`${url.origin}/placed-cache/v2/${batch.toLowerCase()}/${k}`);
    // ?v= names the ids the page has (idsKey): when the edge has that answer, no chain read at all.
    const v = url.searchParams.get('v');
    if (v && /^[0-9a-z]{1,8}-\d{1,2}$/.test(v)) {
      const hit = await caches.default.match(edgeFor(v));
      if (hit) return hit;
    }
    if (await limited(env.RL_MISC, req)) return text('slow down', 429);
    try {
      const c = client(env);
      const [ids] = (await c.readContract({ address: batch, abi: batchAbi, functionName: 'slots' })) as readonly [readonly bigint[], readonly Address[]];
      const now = idsKey(ids);
      // The browser keeps an answer for good only under the URL that names its ids.
      const asked = v === now;
      const hit = await caches.default.match(edgeFor(now));
      if (hit) return asked ? hit : new Response(hit.body, { headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
      const keyCalls = ids.map((id) => ({ address: batch, abi: batchAbi, functionName: 'keyOf', args: [id] }) as const);
      const [keys, rated] = await Promise.all([
        hasMulticall(env)
          ? c.multicall({ contracts: keyCalls, allowFailure: false, multicallAddress: MULTICALL3 })
          : Promise.all(keyCalls.map((x) => c.readContract(x))),
        ids.length ? ratings({ assets: env.ASSETS, origin: url.origin, rpcs: rpcList(env), kv: env.PLANS, credits: env.CREDITS, ids: [...ids] }).catch(() => null) : null,
      ]);
      const inks: Record<string, [string, number, number]> = {};
      for (const [id, v] of Object.entries((rated?.ratings ?? {}) as Record<string, { seed?: string; paidAt?: number; score?: number }>)) if (v?.seed) inks[id] = [v.seed, v.paidAt ?? 0, v.score ?? 0];
      const body = JSON.stringify({ ids: ids.map(String), keys: (keys as unknown[]).map(Number), inks });
      // Without every ink (a busy RPC), kept only a minute, so the next read fills them in.
      const whole = ids.every((id) => inks[id.toString()]);
      const keep = whole ? 'public, max-age=31536000, immutable' : 'public, max-age=60';
      ctx.waitUntil(caches.default.put(edgeFor(now), new Response(body, { headers: { 'content-type': 'application/json', 'cache-control': keep } })));
      return new Response(body, { headers: { 'content-type': 'application/json', 'cache-control': asked ? keep : 'no-store' } });
    } catch (e) {
      return Response.json({ error: safeError(e) }, { status: 502, headers: { 'cache-control': 'no-store' } });
    }
  }

  const picPath = url.pathname.match(/^\/pictures\/(0x[0-9a-fA-F]{40})$/);
  if (picPath) {
    if (!env.PLANS) return text('pictures are off here', 501);
    const batch = picPath[1].toLowerCase() as Address;
    const key = `picture:${batch}`;
    if (req.method === 'GET') {
      // With the ink of its planned Credits (seed, paid at, score), so a page draws the picture from this one
      // answer. A picture never changes once saved, so the whole answer is kept at the edge.
      const edge = new Request(`${url.origin}/pictures-inked/${batch}`);
      const hit = await caches.default.match(edge);
      if (hit) return hit;
      const stored = await env.PLANS.get(key);
      // No picture: an empty answer rather than a 404, which browsers log as an error for every plain union on a page.
      if (!stored) return Response.json(null, { headers: { 'cache-control': 'public, max-age=30' } });
      let body = stored, whole = false;
      try {
        const d = JSON.parse(stored) as { ids?: (number | null)[] };
        const ids = [...new Set((d.ids ?? []).filter((x): x is number => typeof x === 'number' && inSupply(x)))].map(BigInt);
        if (ids.length) {
          const r = await ratings({ assets: env.ASSETS, origin: url.origin, rpcs: rpcList(env), kv: env.PLANS, credits: env.CREDITS, ids });
          const inks: Record<string, [string, number, number]> = {};
          for (const [id, v] of Object.entries(r.ratings as Record<string, { seed?: string; paidAt?: number; score?: number }>)) if (v?.seed) inks[id] = [v.seed, v.paidAt ?? 0, v.score ?? 0];
          body = JSON.stringify({ ...d, inks });
          whole = ids.every((id) => inks[id.toString()]);
        }
      } catch {
        // no ink: the page reads it itself, as before
      }
      const res = new Response(body, { headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=300' } });
      // Missing any ink (a busy RPC): kept a minute, so a later read fills them in.
      if (body !== stored) ctx.waitUntil(caches.default.put(edge, new Response(body, { headers: { 'content-type': 'application/json', 'cache-control': `public, max-age=${whole ? 86400 : 60}` } })));
      return res;
    }
    if (req.method !== 'POST') return text('bad request', 400);
    if (!sameSite(req)) return text('forbidden', 403);
    if (await limited(env.RL_MISC, req, 5)) return text('slow down', 429);
    const raw = await readBody(req, 40_000);
    let px = '', detail = NaN, ids: (number | null)[] | null = null, look: string | null = null;
    try {
      const b = JSON.parse(raw ?? '') as { px?: unknown; detail?: unknown; ids?: unknown; look?: unknown };
      // The format it was matched in, when not Consolidated (the union page plans and draws in it).
      if (b.look === 'Assessed' || b.look === 'Reconciled') look = b.look;
      px = String(b.px ?? '');
      detail = Number(b.detail);
      // The Credit picked for each slot, for list cards: 80 of them (null where none was for sale).
      if (Array.isArray(b.ids) && b.ids.length === 80 && b.ids.every((x) => x === null || (Number.isInteger(x) && inSupply(x as number)))) ids = b.ids as (number | null)[];
    } catch {}
    if (!/^[A-Za-z0-9+/]{27307}=$/.test(px) || !(detail >= 0 && detail <= 4)) return text('bad picture', 400); // 20,480 bytes
    if (!(await isBatch(env, url, batch))) return text('not a batch', 404);
    // Only a sheet painted by Colors can use one.
    const f = ((await client(env).readContract({ address: batch, abi: batchAbi, functionName: 'summary' })) as { filter: { layout0: bigint; layout1: bigint; layoutTrait: number } }).filter;
    if ((!f.layout0 && !f.layout1) || Number(f.layoutTrait) !== 0) return text('not a painted union', 400);
    if (await env.PLANS.get(key)) return text('already has a picture', 409);
    await env.PLANS.put(key, JSON.stringify({ px, detail, ...(ids ? { ids } : {}), ...(look ? { look } : {}) }));
    return new Response(null, { status: 201 });
  }

  // A Picture union's buy locks (locks.ts): GET the Colors being bought; POST { op, id, colours } to acquire (60 s to
  // confirm in the wallet), hold (2 min while the transaction is pending) or release them.
  const lockPath = url.pathname.match(/^\/locks\/(0x[0-9a-fA-F]{40})$/);
  if (lockPath) {
    if (!env.LOCKS) return text('locks are off here', 501);
    const batch = lockPath[1].toLowerCase() as Address;
    const stub = env.LOCKS.get(env.LOCKS.idFromName(batch));
    if (req.method === 'GET') return Response.json({ held: await stub.held() }, { headers: { 'cache-control': 'no-store' } });
    if (req.method !== 'POST' || !sameSite(req)) return text('forbidden', 403);
    if (await limited(env.RL_MISC, req)) return text('slow down', 429);
    let b: { op?: unknown; id?: unknown; colours?: unknown };
    try {
      b = JSON.parse((await readBody(req, 2_000)) ?? '');
    } catch {
      return text('bad request', 400);
    }
    const id = String(b.id ?? '');
    if (!/^[A-Za-z0-9]{16,64}$/.test(id)) return text('bad request', 400);
    if (b.op === 'release') return (await stub.release(id), new Response(null, { status: 204 }));
    if (b.op === 'hold') return (await stub.hold(id, 120_000), new Response(null, { status: 204 }));
    const colours = Array.isArray(b.colours) ? b.colours.map(Number) : [];
    if (b.op !== 'acquire' || !colours.length || colours.length > 15 || colours.some((c) => !Number.isInteger(c) || c < 1 || c > 15)) return text('bad request', 400);
    if (!(await isBatch(env, url, batch))) return text('not a batch', 404);
    return Response.json(await stub.acquire(id, [...new Set(colours)], 60_000), { headers: { 'cache-control': 'no-store' } });
  }

  const planPath = url.pathname.match(/^\/plans(?:\/([A-Za-z0-9]{10})(\.json|\/union|\/swap)?)?$/);
  if (planPath) {
    if (!env.PLANS) return text('plans are off here', 501);
    if (!sameSite(req)) return text('forbidden', 403);
    const [, id, rest] = planPath;
    if (req.method === 'GET' && id && rest === '.json') {
      const plan = await env.PLANS.get(id);
      return plan ? new Response(plan, { headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } }) : text('no such plan', 404);
    }
    if (req.method !== 'POST' || (id ? !rest || rest === '.json' : !!rest)) return text('bad request', 400);
    if (await limited(env.RL_MISC, req, 10)) return text('slow down', 429);
    const raw = await readBody(req, 64_000);
    if (raw === null) return text('too large', 413);
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(raw) as Record<string, unknown>;
      if (!body || typeof body !== 'object') throw 0;
    } catch {
      return text('bad request', 400);
    }
    const addr = (x: unknown) => (typeof x === 'string' && /^0x[0-9a-fA-F]{40}$/.test(x) ? (x.toLowerCase() as Address) : null);
    if (!id) {
      try {
        const plan = checkPlan(body);
        const key = Array.from(crypto.getRandomValues(new Uint8Array(10)), (b) => 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'[b % 56]).join('');
        const saved = { id: key, ...plan, union: null as Address | null, createdAt: Date.now() };
        await env.PLANS.put(key, JSON.stringify(saved));
        // Each wallet's plans, so it can find them again from its own page.
        await Promise.all(
          plan.wallets.map(async (w) => {
            const had = (await env.PLANS!.get<string[]>(`w:${w.address}`, 'json')) ?? [];
            await env.PLANS!.put(`w:${w.address}`, JSON.stringify([key, ...had.filter((x) => x !== key)].slice(0, 200)));
          }),
        );
        return Response.json(saved, { status: 201 });
      } catch {
        return text('bad request', 400);
      }
    }
    const stored = await env.PLANS.get(id);
    if (!stored) return text('no such plan', 404);
    const plan = JSON.parse(stored) as Plan;
    const c = client(env);
    const inPlan = (a: string) => plan.wallets.some((w) => w.address === a.toLowerCase());
    if (rest === '/swap') {
      // A replacement for a slot whose Credit nobody in the plan holds (it sold, or was delisted). Signed by a plan
      // wallet; the new Credit must be new to the plan and keep the numbers rising.
      if (plan.union) return text('the union is open: the 80 are fixed', 400);
      const slot = Number(body.slot), next = String(body.id ?? ''), by = addr(body.by);
      if (!Number.isInteger(slot) || slot < 0 || slot > 79 || !/^\d{1,6}$/.test(next) || !inSupply(Number(next)) || !by || !inPlan(by)) return text('bad request', 400);
      if (plan.slots.some((s) => s.id === next)) return text('already in the plan', 400);
      const lo = slot > 0 ? Number(plan.slots[slot - 1].id) : 0, hi = slot < 79 ? Number(plan.slots[slot + 1].id) : Infinity;
      if (plan.order !== 'deposit' && !(Number(next) > lo && Number(next) < hi)) return text('numbers must keep rising', 400);
      const message = `Credit Union plan ${id}: slot ${slot + 1} takes #${next} instead of #${plan.slots[slot].id}`;
      try {
        if (!(await c.verifyMessage({ address: by, message, signature: String(body.sig) as Hex }))) return text('bad signature', 400);
        const owner = ((await c.readContract({ address: env.CREDITS, abi: creditsAbi, functionName: 'ownerOf', args: [BigInt(plan.slots[slot].id)] })) as string).toLowerCase();
        if (inPlan(owner)) return text('someone in the plan already holds that Credit', 400);
      } catch (e) {
        return Response.json({ error: safeError(e) }, { status: 502 });
      }
      plan.slots[slot] = { ...plan.slots[slot], id: next, owned: false };
      await env.PLANS.put(id, JSON.stringify(plan));
      return Response.json(plan);
    }
    // The union the plan opened: our factory's, opened by a plan wallet, Number order, equal payout (early bird would
  // turn depositing into a race between friends), exactly the plan's 80. Once.
    if (plan.union) return Response.json(plan);
    const batch = addr(body.union);
    if (!batch) return text('bad request', 400);
    try {
      if (!(await c.readContract({ address: env.FACTORY, abi: factoryAbi, functionName: 'isBatch', args: [batch] }))) return text('not a union', 400);
      const s = (await c.readContract({ address: batch, abi: batchAbi, functionName: 'summary' })) as unknown as { creator: Address; arrangement: number; split: number; allowlistSize: bigint };
      const all = await Promise.all(plan.slots.map((x) => c.readContract({ address: batch, abi: batchAbi, functionName: 'allowed', args: [BigInt(x.id)] })));
      if (!inPlan(s.creator) || Number(s.arrangement) !== (plan.order === 'deposit' ? 0 : 2) || Number(s.split) !== 0 || Number(s.allowlistSize) !== 80 || all.some((ok) => !ok)) return text('that union does not match this plan', 400);
      const next = { ...plan, union: batch };
      const hidden = new Set((await env.PLANS.get<string[]>('hidden', 'json')) ?? []);
      hidden.add(batch);
      await Promise.all([env.PLANS.put(id, JSON.stringify(next)), env.PLANS.put('hidden', JSON.stringify([...hidden]))]);
      return Response.json(next);
    } catch (e) {
      return Response.json({ error: safeError(e) }, { status: 502 });
    }
  }

  // Official ratings for up to 200 Credits, computed from the frozen edition (see shared/credits.ts). `scores: true`
  // returns just each score, for totals (the list's Top rated sort).
  if (url.pathname === '/ratings') {
    if (req.method !== 'POST' || !sameSite(req)) return text('forbidden', 403);
    if (await limited(env.RL_MISC, req)) return text('slow down', 429);
    let ids: bigint[], only = false;
    try {
      const raw = await readBody(req, 16_000);
      if (raw === null) return text('too large', 413);
      const body = JSON.parse(raw) as { ids?: unknown; scores?: unknown };
      only = body.scores === true;
      if (!Array.isArray(body.ids) || body.ids.length === 0 || body.ids.length > 200) throw 0;
      ids = body.ids.map((x) => {
        if (!/^\d{1,6}$/.test(String(x)) || !inSupply(Number(x))) throw 0;
        return BigInt(String(x));
      });
    } catch {
      return text('bad request', 400);
    }
    try {
      const r = await ratings({ assets: env.ASSETS, origin: url.origin, rpcs: rpcList(env), kv: env.PLANS, credits: env.CREDITS, ids });
      const out = only ? { n: r.n, version: r.version, scores: Object.fromEntries(Object.entries(r.ratings).map(([id, v]) => [id, v.score])) } : r;
      return Response.json(out, { headers: { 'cache-control': 'no-store' } });
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
      const more = (await extras(env, url, ctx)).extra;
      return Response.json(
        { listings: listings.map((l) => ({ id: l.id, price: l.price, source: l.source, url: listingUrl(env, live, l), ...(table ? { traits: table[Number(l.id) - 1] ?? 0 } : {}) })), preview: !live, sources: sourcesOf(env, more) },
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
      let listings = await fitting(env, url, ctx, batch as Address, true);
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
        const keys = ['palettes', 'prints', 'weights', 'eights', 'idFrom', 'idTo', 'minScore', 'maxScore', 'bitsFrom', 'bitsTo', 'paidFrom', 'paidTo'] as const;
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
      if (rules.minScore || rules.maxScore) rules.live = await liveTable(env);
    }
    if (await limited(env.RL_MISC, req)) return text('slow down', 429);
    // On mainnet, from the market book (every Credit for sale, kept current): no OpenSea call at all. The cursor is how
    // many of the Credits that pass have been shown. Buying prices each listing again, so a sold one just drops out.
    const bookCur = (() => {
      try {
        const c = url.searchParams.get('c');
        const o = c ? (JSON.parse(atob(c)) as { b?: unknown }) : { b: 0 };
        return typeof o.b === 'number' && Number.isInteger(o.b) && o.b >= 0 ? o.b : null;
      } catch {
        return null;
      }
    })();
    if (hasSweeper(env) && env.MARKET && bookCur !== null) {
      try {
        const bk = await marketBook(env, url, ctx);
        if (bk.rows.length && Date.now() - bk.at < 5 * 60_000) {
          const ok = trait ? await predicate(env.ASSETS, url.origin, trait.rules) : rules ? await predicate(env.ASSETS, url.origin, rules) : () => true;
          // An OpenSea row without its order can't be bought through the Sweeper: left out.
          const pass = bk.rows.filter((r) => ok(Number(r[0])) && (r[2] !== 'opensea' || (r[3] && r[4])));
          const items = pass.slice(bookCur, bookCur + LISTED_CHUNK).map((r) => {
            const l: Listing = r[2] === 'opensea' ? { id: r[0], price: r[1], source: 'opensea', hash: r[3], protocol: r[4] } : { id: r[0], price: r[1], source: r[2] as Listing['source'], ...(r[3] ? { listingId: r[3] } : {}) };
            return { ...l, url: listingUrl(env, true, l) };
          });
          const next = bookCur + LISTED_CHUNK < pass.length ? btoa(JSON.stringify({ b: bookCur + LISTED_CHUNK })) : null;
          return Response.json({ items, next, preview: false, sources: sourcesOf(env, pass.map((r) => ({ source: r[2] }))) }, { headers: { 'cache-control': 'no-store' } });
        }
      } catch (e) {
        console.warn('[listed] from OpenSea', safeError(e));
      }
    }
    // OpenSea's next page, the highest OpenSea price shown so far, OpenSea done, how many of the rest are shown.
    type Cursor = { n: string; w: string; d: boolean; i: number; p?: number };
    let cur: Cursor = { n: '', w: '-1', d: !env.OPENSEA_API_KEY, i: 0 };
    try {
      const c = url.searchParams.get('c');
      if (c && bookCur === null) cur = JSON.parse(atob(c)) as Cursor;
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
        const pg = await bestPageCached(env, url, ctx, credits, cur.n, trait ? openseaTrait(trait) : undefined);
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
      return Response.json({ items, next: left ? btoa(JSON.stringify(cur)) : null, preview: !live, sources: sourcesOf(env, more) }, { headers: { 'cache-control': 'no-store' } });
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

  // Many Credits' cheapest listings at once, from the market book: { items: { id: offer | null } }, as
  // /opensea/credit/:id answers each (null: not for sale). An id the book can't price (an OpenSea row without its
  // order) is left out, for the page to ask /opensea/credit/:id. A stale or missing book is a 503: ask one by one.
  // Kept 5 s per set of ids: everyone on a Picture union's Buy tab asks for the same ones.
  if (url.pathname === '/opensea/credits') {
    if (!sameSite(req)) return text('forbidden', 403);
    const ids = [...new Set((url.searchParams.get('ids') ?? '').split(',').filter((x) => /^\d{1,6}$/.test(x) && inSupply(Number(x))))].slice(0, 100);
    if (!ids.length) return text('bad request', 400);
    if (!hasSweeper(env) || !env.MARKET) return text('no market book here', 503);
    const cache = caches.default;
    const key = new Request(`${url.origin}/opensea/credits/${env.CREDITS.toLowerCase()}/${[...ids].sort((a, b) => Number(a) - Number(b)).join('.')}`);
    const hit = await cache.match(key);
    if (hit) return hit;
    if (await limited(env.RL_MISC, req)) return text('slow down', 429);
    const got = await book(env).getMany(ids).catch(() => null);
    if (!got || Date.now() - got.updated > 2 * 60_000) return text('the market book is behind', 503);
    const items: Record<string, unknown> = Object.fromEntries(ids.map((id) => [id, null]));
    for (const e of got.rows) {
      const [eid, eprice, esource, ea, eb] = e.map(String);
      if (esource === 'opensea' && !(ea && eb)) {
        delete items[eid]; // no order to buy it by: the page asks for it alone
        continue;
      }
      const l: Listing = esource === 'opensea' ? { id: eid, price: eprice, source: 'opensea', hash: ea, protocol: eb } : { id: eid, price: eprice, source: esource as Listing['source'], listingId: ea || undefined };
      items[eid] = {
        price: l.price,
        source: l.source,
        contract: l.source === 'strategy' ? addrOrNull(env.STRATEGY) : l.source === 'fwa' ? addrOrNull(env.FWA_MARKET) : null,
        listingId: l.listingId ?? null,
        hash: l.hash ?? null,
        protocol: l.protocol ?? null,
        url: listingUrl(env, true, l),
        preview: false,
      };
    }
    const res = Response.json({ items }, { headers: { 'cache-control': 'public, max-age=5' } });
    ctx.waitUntil(cache.put(key, res.clone()));
    return res;
  }

  // One Credit's cheapest listing (OpenSea, CreditStrategy or FWA), for its page. Without a Sweeper (testnets) it's
  // the mainnet Credit of the same number, as a preview. Cached 20 s per Credit (its page reads it again every
  // 20 s), so a busy page costs OpenSea one call per 20 s.
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
    // From the market book first (every listing, rebuilt every 5 minutes): no OpenSea call for a Credit it has.
    // Buying still asks OpenSea for a fresh signed order, so one that sold since just drops out then.
    if (live && env.MARKET) {
      const got = await book(env).get(String(id)).catch(() => null);
      const fresh = !!got && Date.now() - got.updated < 2 * 60_000; // the loop touches it every ~10 s
      const e = got?.row;
      // Not in a fresh book: not for sale anywhere we buy from, no need to ask OpenSea.
      if (fresh && !e) {
        const res = Response.json({ price: null, preview: false }, { headers: { 'cache-control': 'public, max-age=10' } });
        ctx.waitUntil(cache.put(key, res.clone()));
        return res;
      }
      // A listed row counts only from a fresh book too: a stalled loop must not keep selling a Credit that sold.
      if (fresh && e && (e[2] !== 'opensea' || (e[3] && e[4]))) {
        const [eid, eprice, esource, ea, eb] = e.map(String);
        const l: Listing = esource === 'opensea' ? { id: eid, price: eprice, source: 'opensea', hash: ea, protocol: eb } : { id: eid, price: eprice, source: esource as Listing['source'], listingId: ea || undefined };
        const res = Response.json(
          {
            price: l.price,
            source: l.source,
            contract: l.source === 'strategy' ? addrOrNull(env.STRATEGY) : l.source === 'fwa' ? addrOrNull(env.FWA_MARKET) : null,
            listingId: l.listingId ?? null,
            hash: l.hash ?? null,
            protocol: l.protocol ?? null,
            url: listingUrl(env, live, l),
            preview: false,
          },
          { headers: { 'cache-control': 'public, max-age=10' } },
        );
        ctx.waitUntil(cache.put(key, res.clone()));
        return res;
      }
    }
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

  // About became the homepage: /about and /how land there, any chapter as the homepage scrolled to it. The FAQ
  // grew into /docs: /faq and /about/faq land on it.
  if (/^\/(?:faq|(?:about|how)\/faq)\/?$/.test(url.pathname)) return Response.redirect(`${url.origin}/docs`, 301);
  const about = url.pathname.match(/^\/(?:about|how)(?:\/([a-z-]+))?\/?$/);
  if (about) return Response.redirect(`${url.origin}/${about[1] ? `#${about[1]}` : ''}`, 301);

  // The Activity page moved from /live: old links land on it.
  if (url.pathname === '/live') return Response.redirect(`${url.origin}/activity${url.search}`, 301);

  // /activity.json: what wallets have done on the site, newest first (activity.ts), served in slices:
  //   ?limit=100 (max 1000)  ?after=<tx>:<i>:<kind> (the last row you have)  ?union=0x… or ?member=0x…  ?last  ?bids
  // The whole list is built at most once per 15 seconds per colo; every slice is cut from it.
  if (url.pathname === '/activity.json') {
    // Local preview without an RPC key: .dev.vars can point this at the live site's feed.
    if (env.ACTIVITY_MIRROR) return fetch(env.ACTIVITY_MIRROR + url.search);
    try {
      const all = await activityAll(env, url, ctx);
      const q = url.searchParams;
      // ?last: when each union last took a Credit (a deposit, or a buy straight into it): { union: unix seconds }.
      if (q.has('last')) {
        const last: Record<string, number> = {};
        for (const x of all) if (x.union && x.time && (x.kind === 'deposited' || (x.kind === 'bought' && x.intoUnion))) last[x.union.toLowerCase()] ??= x.time;
        return Response.json({ last }, { headers: { 'cache-control': 'public, max-age=15' } });
      }
      // ?bids: how many bids each union's auction has taken: { union: count }.
      if (q.has('bids')) {
        const bids: Record<string, number> = {};
        for (const x of all) if (x.kind === 'bid' && x.union) bids[x.union.toLowerCase()] = (bids[x.union.toLowerCase()] ?? 0) + 1;
        return Response.json({ bids }, { headers: { 'cache-control': 'public, max-age=15' } });
      }
      const union = q.get('union')?.toLowerCase(), member = q.get('member')?.toLowerCase(), after = q.get('after');
      const limit = Math.min(Math.max(Number(q.get('limit')) || 100, 1), 1000);
      let rows = union ? all.filter((x) => x.union?.toLowerCase() === union) : member ? all.filter((x) => x.who.toLowerCase() === member) : all;
      if (after) {
        const k = rows.findIndex((x) => `${x.tx}:${x.i}:${x.kind}` === after);
        rows = k < 0 ? [] : rows.slice(k + 1);
      }
      return Response.json({ items: rows.slice(0, limit), more: rows.length > limit }, { headers: { 'cache-control': 'public, max-age=15' } });
    } catch (e) {
      return Response.json({ error: safeError(e) }, { status: 502, headers: { 'cache-control': 'no-store' } });
    }
  }

  // Bid history for a party's auction, newest first. ?v= is the high bid the page shows: the answer for it never
  // changes, so it's kept a day. It comes from the Activity feed (read once for the site); when the feed doesn't have
  // that bid yet, the ChainBook reads it now (one read for everyone asking). Without the ChainBook, from the chain's
  // Bid events: the scan starts near the assembly time (12 s blocks, with margin) and walks forward in windows public
  // RPCs accept.
  const bids = url.pathname.match(/^\/bids\/(0x[0-9a-fA-F]{40})$/);
  if (bids) {
    const cache = caches.default;
    const v = url.searchParams.get('v');
    const named = !!v && /^\d{1,30}$/.test(v);
    const key = new Request(url.origin + url.pathname.toLowerCase() + (named ? `?v=${v}` : ''));
    const hit = await cache.match(key);
    if (hit) return hit;
    if (await limited(env.RL_MISC, req)) return text('slow down', 429);
    const batch = bids[1].toLowerCase() as Address;
    if (!(await isBatch(env, url, batch))) return text('not a batch', 404);
    const book = chainBook(env);
    if (book) {
      try {
        const of = (items: Activity[]) => items.filter((x) => x.kind === 'bid' && x.union?.toLowerCase() === batch);
        let rows = of(await activityAll(env, url, ctx));
        if (named && v !== '0' && rows[0]?.eth !== v) rows = of(JSON.parse((await book.activity(2_000)).body) as Activity[]);
        const whole = !named || v === '0' || rows[0]?.eth === v;
        const out = rows.map((x) => ({ bidder: x.who, amount: x.eth ?? '0', end: 0, block: x.block, tx: x.tx, time: x.time }));
        const res = Response.json({ bids: out }, { headers: { 'cache-control': `public, max-age=${named && whole ? 86400 : 5}` } });
        ctx.waitUntil(cache.put(key, res.clone()));
        return res;
      } catch (e) {
        console.warn('[bids] from the chain', safeError(e));
      }
    }
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

  // A name's address (always from mainnet), for typing friends' names on the Printer. Cached an hour.
  const named = url.pathname.match(/^\/ens\/name\/([a-z0-9\-_.]{3,100}\.[a-z]{2,20})$/i);
  if (named) {
    const cache = caches.default;
    const key = new Request(url.origin + url.pathname.toLowerCase());
    const hit = await cache.match(key);
    if (hit) return hit;
    if (await limited(env.RL_MISC, req)) return text('slow down', 429);
    const rpc = env.ENS_RPC || (env.CHAIN_ID === '1' ? rpcUrl(env) : 'https://eth.drpc.org');
    const c = createPublicClient({ chain: mainnet, transport: http(rpc, { timeout: 5_000 }) });
    try {
      const address = await c.getEnsAddress({ name: normalize(named[1]) });
      const res = Response.json({ address }, { headers: { 'cache-control': `public, max-age=${address ? 3600 : 300}` } });
      ctx.waitUntil(cache.put(key, res.clone()));
      return res;
    } catch {
      return Response.json({ address: null }, { headers: { 'cache-control': 'no-store' } });
    }
  }

  const ens = url.pathname.match(/^\/ens\/(0x[0-9a-fA-F]{40})$/);
  if (ens) {
    const r = await ensOf(env, url, ctx, ens[1].toLowerCase() as Address, () => limited(env.RL_MISC, req));
    if (!r) return text('slow down', 429);
    return new Response(JSON.stringify({ name: r.name, avatar: r.avatar }), { headers: { 'content-type': 'application/json', 'cache-control': `public, max-age=${r.ttl}` } });
  }
  // Many at once, as a page's names come in one request: /ens?a=0x…,0x… (up to 50) → { "0x…": { name, avatar } }.
  if (url.pathname === '/ens') {
    if (!sameSite(req)) return text('forbidden', 403);
    const list = [...new Set((url.searchParams.get('a') ?? '').toLowerCase().split(','))].filter((a) => /^0x[0-9a-f]{40}$/.test(a)).slice(0, 50) as Address[];
    if (!list.length) return text('bad request', 400);
    if (await limited(env.RL_MISC, req)) return text('slow down', 429);
    const out: Record<string, { name: string | null; avatar: string | null }> = {};
    let ttl = 86400;
    for (let i = 0; i < list.length; i += 10)
      await Promise.all(
        list.slice(i, i + 10).map(async (a) => {
          const r = await ensOf(env, url, ctx, a);
          if (!r) return;
          out[a] = { name: r.name, avatar: r.avatar };
          ttl = Math.min(ttl, r.ttl);
        }),
      );
    return Response.json(out, { headers: { 'cache-control': `public, max-age=${ttl}` } });
  }

  // /avatar/<ens name>: the name's avatar at 96 px (ENS serves the original, often megabytes, for a 20 px face).
  // Resized once by wsrv.nl and kept at the edge a week; no avatar is a 404 kept a day.
  const av = url.pathname.match(/^\/avatar\/([^/]{1,300})$/);
  if (av) {
    let name: string;
    try {
      name = decodeURIComponent(av[1]).toLowerCase();
    } catch {
      return text('bad name', 400);
    }
    if (!/^[^\s/?#]{1,255}$/.test(name)) return text('bad name', 400);
    const cache = caches.default;
    const key = new Request(`${url.origin}/avatar/v2/${encodeURIComponent(name)}`); // v2: none is a 204
    const hit = await cache.match(key);
    if (hit) return hit;
    if (await limited(env.RL_MISC, req)) return text('slow down', 429);
    const src = `https://metadata.ens.domains/mainnet/avatar/${encodeURIComponent(name)}`;
    const r = await fetch(`https://wsrv.nl/?url=${encodeURIComponent(src)}&w=96&h=96&fit=cover&output=webp`, { signal: AbortSignal.timeout(10_000) }).catch(() => null);
    const type = r?.headers.get('content-type') ?? '';
    if (r?.ok && type.startsWith('image/')) {
      const res = new Response(r.body, { headers: { 'content-type': type, 'cache-control': 'public, max-age=604800' } });
      ctx.waitUntil(cache.put(key, res.clone()));
      return res;
    }
    // No avatar (a 404 from ENS) is kept; a slow or failing resizer is not, so the next viewer tries again. An empty
    // 204, not a 404: the face keeps its mark, and the console stays clean.
    const none = r?.status === 404;
    const miss = new Response(null, { status: 204, headers: { 'cache-control': none ? 'public, max-age=86400' : 'no-store' } });
    if (none) ctx.waitUntil(cache.put(key, miss.clone()));
    return miss;
  }

  // /art/<id>.svg and /art/<contract>/<id>.svg: the configured Credits. /art/mainnet/<id>.svg: the real
  // edition, for previews of Credits you don't hold, on any network.
  const art = url.pathname.match(/^\/art\/(?:(mainnet)\/|0x[0-9a-fA-F]{40}\/)?(\d{1,7})\.svg$/);
  if (art) {
    const real = art[1] === 'mainnet' && env.CHAIN_ID !== '1';
    const creditsAddr = real ? MAINNET_CREDITS : env.CREDITS;
    // Keyed by contract too: art never changes for a given Credits, but the contract can (testnets).
    const cache = caches.default;
    const key = new Request(`${url.origin}/art/${creditsAddr.toLowerCase()}/${Number(art[2])}.svg`);
    const hit = await cache.match(key);
    if (hit) return hit;
    if (!inSupply(Number(art[2]))) return new Response('no such credit', { status: 404, headers: { 'cache-control': 'public, max-age=86400' } });
    // Even opened directly, the SVG can run nothing and reach nothing.
    const svgHeaders = { 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox" };
    const svgResponse = (svg: string) =>
      new Response(svg, { headers: { 'content-type': 'image/svg+xml', 'cache-control': 'public, max-age=31536000, immutable', ...svgHeaders } });
    // The colo cache is per data center; KV keeps each Credit's art once for all of them, so the chain is read once
    // per Credit, not once per Credit per data center.
    const kept = await keptGet(env, `art:${creditsAddr.toLowerCase()}:${Number(art[2])}`);
    if (kept) {
      const res = svgResponse(kept);
      ctx.waitUntil(cache.put(key, res.clone()));
      return res;
    }
    if (await limited(env.RL_ART, req)) return text('slow down', 429);
    const c = real
      ? createPublicClient({ transport: http(env.ENS_RPC || 'https://eth.drpc.org', { timeout: 8_000 }) })
      : client(env);
    const id = BigInt(art[2]);
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
      const res = svgResponse(svg);
      ctx.waitUntil(Promise.all([cache.put(key, res.clone()), keptPut(env, `art:${creditsAddr.toLowerCase()}:${Number(art[2])}`, svg)]));
      return res;
    } catch {
      // Remembered here for a few seconds, so a page of these while the RPC is down isn't 3 calls per image.
      const res = new Response('art unavailable', { status: 502, headers: { ...svgHeaders, 'cache-control': 'no-store' } });
      ctx.waitUntil(cache.put(key, new Response('art unavailable', { status: 502, headers: { ...svgHeaders, 'cache-control': 'public, max-age=10' } })));
      return res;
    }
  }

  // /statement/<id>.svg: a Statement as Jack's contract draws it, for burned unions' pages and cards. Read from the
  // Statements the factory's burn contract mints into (statementSVG, else the image in tokenURI). The drawing only
  // changes when its owner switches its format or overprints it, so each data center keeps it 10 minutes.
  const stmt = url.pathname.match(/^\/statement\/(\d{1,7})\.svg$/);
  if (stmt) {
    const cache = caches.default;
    const key = new Request(`${url.origin}/statement/${Number(stmt[1])}.svg`);
    const hit = await cache.match(key);
    if (hit) return hit;
    const svgHeaders = { 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox" };
    const miss = (why: string, age: number) => new Response(why, { status: 404, headers: { ...svgHeaders, 'cache-control': `public, max-age=${age}` } });
    if (await limited(env.RL_ART, req)) return text('slow down', 429);
    const statements = await statementsOf(env);
    if (!statements) return miss('no Statements yet', 60);
    const c = client(env);
    const id = BigInt(stmt[1]);
    const svg = await c
      .readContract({ address: statements, abi: statementsAbi, functionName: 'statementSVG', args: [id] })
      .catch(() => c.readContract({ address: statements, abi: statementsAbi, functionName: 'tokenURI', args: [id] }).then(imageOf))
      .catch(() => null);
    if (!svg || !svg.includes('<svg')) return miss('no such Statement', 60);
    const res = new Response(svg, { headers: { 'content-type': 'image/svg+xml', 'cache-control': 'public, max-age=600', ...svgHeaders } });
    ctx.waitUntil(cache.put(key, res.clone()));
    return res;
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
    const pngHeaders = { 'content-type': 'image/png', 'cache-control': 'public, max-age=86400' };
    const kept = await keptPng(env, `og:credit:v3:${id}`);
    if (kept) {
      const res = new Response(kept, { headers: pngHeaders });
      ctx.waitUntil(cache.put(key, res.clone()));
      return res;
    }
    if (await limited(env.RL_MISC, req)) return generic();
    const [facts, [print]] = await Promise.all([creditFacts(env, url, id).catch(() => null), printsFor(env, [id])]);
    // Drawn from the chain it's exact for good. Without the chain there is no exact art (wall.bin keeps only the
    // registered grid: no misprints, paper or marks), and sites keep the first image they fetch, so the site's card.
    if (!print) return generic();
    const png = await drawCredit(env.ASSETS, url.origin, id, facts, print);
    const res = new Response(png, { headers: pngHeaders });
    ctx.waitUntil(Promise.all([cache.put(key, res.clone()), keptPut(env, `og:credit:v3:${id}`, png, 86400)]));
    return res;
  }

  // Pages: the app shell with this route's link-preview tags; a party page describes that party.
  let card = req.method === 'GET' ? cardFor(url.pathname) : null;
  const party = url.pathname.match(/^\/(?:union|party|b)\/(0x[0-9a-fA-F]{40})$/)?.[1];
  // Each party page costs RPC reads, so it is rate limited; over the limit, or not one of ours, it gets the generic card.
  const creditId = url.pathname.match(/^\/credit\/(\d{1,6})$/)?.[1];
  if (card && creditId && inSupply(Number(creditId))) card = creditCard(Number(creditId));
  // /credits: the edition's real count.
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
    const rules = rating ? { minScore: lo, maxScore: hi, live: await liveTable(env) } : { bitsFrom: lo, bitsTo: hi };
    const show = (x: number) => (rating ? (x / 10).toFixed(1) : String(x));
    card = (await match(env.ASSETS, url.origin, rules, 1).then((m) => rangeCard(rating ? 'rating' : 'bits', m.count, show(lo), show(hi))).catch(() => null)) ?? card;
  }
  if (card && party && !(await limited(env.RL_MISC, req)) && (await isBatch(env, url, party.toLowerCase() as Address))) {
    const p = await readParty(env, party as Address, url, ctx).catch(() => null);
    if (p) card = partyCard(party, p.name, ruleLine(p.filter, p.allowlistSize));
  }
  if (card) {
    const shell = await env.ASSETS.fetch(new Request(new URL('/', url), req));
    // The Printer is unlisted: nothing links to it, and search engines leave it out.
    const unlisted = /^\/printer(\/|$)/.test(url.pathname) ? '\n  <meta name="robots" content="noindex, nofollow">' : '';
    if (shell.ok && (shell.headers.get('content-type') ?? '').includes('text/html')) return withCard(shell, card, url, bootHead(env, url) + unlisted);
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

/// Every Credit Union, newest first, with its summary (Batch.summary, bigints as { "$n": "…" }) and slots, read by the
/// ChainBook for the whole site. This isolate keeps it INDEX_MS, then the colo cache, then the ChainBook; `fresh`
/// (after the reader's own transaction) asks the ChainBook for a read made after this call. Without the ChainBook
/// (or with it unreachable), this data center reads the chain itself and keeps that 10 s, as before.
type Index = { at: number; body: string; one?: Map<string, string> };
let indexMemo: { got: number; v: Index } | null = null;
let indexRead: Promise<Index> | null = null;
async function unionIndex(env: Env, url: URL, ctx: ExecutionContext, fresh = false): Promise<Index> {
  if (!fresh && indexMemo && Date.now() - indexMemo.got < INDEX_MS) return indexMemo.v;
  if (!fresh && indexRead) return indexRead;
  const p = (async (): Promise<Index> => {
    const key = new Request(`${url.origin}/unions.json/v2`);
    if (!fresh) {
      const hit = await caches.default.match(key);
      const at = Number(hit?.headers.get('x-read-at'));
      if (hit && at) {
        const v = indexMemo?.v.at === at ? indexMemo.v : { at, body: await hit.text() };
        indexMemo = { got: Date.now(), v };
        return v;
      }
    }
    let v: Index, keep = INDEX_MS / 1000;
    const book = chainBook(env);
    try {
      if (!book) throw new Error('no ChainBook');
      v = await book.unions(fresh ? 0 : BOOK_MS);
    } catch (e) {
      if (book) console.warn('[chain] index read here', safeError(e));
      v = { at: Date.now(), body: await readUnions(env) };
      keep = 10;
    }
    ctx.waitUntil(caches.default.put(key, new Response(v.body, { headers: { 'content-type': 'application/json', 'cache-control': `public, max-age=${keep}`, 'x-read-at': String(v.at) } })));
    if (!indexMemo || indexMemo.v.at <= v.at) indexMemo = { got: Date.now(), v };
    return v;
  })();
  if (!fresh) {
    indexRead = p;
    void p.finally(() => indexRead === p && (indexRead = null)).catch(() => {});
  }
  return p;
}
/// One union of the index as { at, union }: parsed once per index read, then a lookup.
function oneUnion(v: Index, addr: string): string {
  if (!v.one) {
    const { at, unions } = JSON.parse(v.body) as { at: number; unions: { address: string }[] };
    v.one = new Map(unions.map((u) => [u.address.toLowerCase(), JSON.stringify({ at, union: u })]));
  }
  return v.one.get(addr.toLowerCase()) ?? '{"at":0,"union":null}';
}

/// A printer plan as stored (plus id, union and createdAt).
type Plan = {
  name: string;
  target: string; // the framed picture, 64 x 80, as a PNG data URL: replacements are matched against it
  wallets: { address: Address; label: string; cap: number }[]; // cap: most of the 80 this wallet brings, in percent
  slots: { id: string; wallet: number; owned: boolean }[]; // slot order; ids rise unless `order` is deposit
  order: 'deposit' | 'number'; // deposit: one wallet deposits all 80 in slot order; number: the union sorts them
  union: Address | null;
};
function checkPlan(b: Record<string, unknown>): Omit<Plan, 'union'> {
  const name = String(b.name ?? '').trim().slice(0, 64);
  const target = String(b.target ?? '');
  if (!name || !/^data:image\/png;base64,[A-Za-z0-9+/=]{100,40000}$/.test(target)) throw 0;
  const wallets = (b.wallets as { address?: unknown; label?: unknown; cap?: unknown }[]).map((w) => ({
    address: (typeof w.address === 'string' && /^0x[0-9a-fA-F]{40}$/.test(w.address) ? w.address.toLowerCase() : '') as Address,
    label: String(w.label ?? '').trim().slice(0, 32),
    cap: Number(w.cap),
  }));
  if (!wallets.length || wallets.length > 8 || wallets.some((w) => !w.address || !Number.isInteger(w.cap) || w.cap < 1 || w.cap > 100)) throw 0;
  if (new Set(wallets.map((w) => w.address)).size !== wallets.length) throw 0;
  const order = b.order === 'deposit' ? 'deposit' : 'number';
  if (order === 'deposit' && wallets.length !== 1) throw 0; // only one wallet can deposit in exact order without turns
  const slots = (b.slots as { id?: unknown; wallet?: unknown; owned?: unknown }[]).map((s) => ({ id: String(s.id), wallet: Number(s.wallet), owned: !!s.owned }));
  if (slots.length !== 80 || new Set(slots.map((s) => s.id)).size !== 80) throw 0;
  if (slots.some((s, k) => !/^\d{1,6}$/.test(s.id) || !inSupply(Number(s.id)) || (order === 'number' && k > 0 && Number(s.id) <= Number(slots[k - 1].id)))) throw 0;
  if (slots.some((s) => !Number.isInteger(s.wallet) || s.wallet < 0 || s.wallet >= wallets.length)) throw 0;
  if (wallets.some((w, i) => slots.filter((s) => s.wallet === i).length > Math.ceil((w.cap * 80) / 100))) throw 0;
  return { name, target, wallets, slots, order };
}

/// Unions a plan opened, kept off the lists until they fill.
async function hiddenUnions(env: Env): Promise<Set<string>> {
  if (!env.PLANS) return new Set();
  return new Set(((await env.PLANS.get<string[]>('hidden', { type: 'json', cacheTtl: 60 })) ?? []).map((a) => a.toLowerCase()));
}

/// Every Credit for sale, cheapest listing each: FWA and CreditStrategy, then OpenSea's pages to the end.

/// The whole book read from scratch: FWA and the strategy, then every OpenSea listing page (the hourly rebuild).
async function readMarketRows(env: Env, url: URL, ctx: ExecutionContext): Promise<Row[]> {
  const credits = hasSweeper(env) ? env.CREDITS : MAINNET_CREDITS;
  const best = new Map<string, Row>();
  const add = (r: Row) => {
    const had = best.get(r[0]);
    if (!had || BigInt(r[1]) < BigInt(had[1])) best.set(r[0], r);
  };
  for (const e of (await extras(env, url, ctx)).extra) add([e.id, e.price, e.source, e.listingId ?? '', '', '', 0]);
  if (env.OPENSEA_API_KEY) {
    let next = '';
    for (let page = 0; page < 200; page++) {
      const pg = await bestPage(env.OPENSEA_API_KEY, env.OPENSEA_SLUG, credits, next);
      for (const l of pg.items) add([l.id, l.price, 'opensea', l.hash ?? '', l.protocol ?? '', l.seller ?? '', l.until ?? 0]);
      if (!pg.next) break;
      next = pg.next;
    }
  }
  return [...best.values()];
}
const book = (env: Env) => env.MARKET!.get(env.MARKET!.idFromName('credits'));

/// Each minute: keep the book's 10-second loop going (the feed and the chain, market.ts); every 5 minutes FWA and the
/// strategy; every hour (or when the book is empty or the loop fell behind) the whole book again.
async function keepMarket(env: Env, ctx: ExecutionContext) {
  if (!env.MARKET || !env.OPENSEA_API_KEY) return;
  const b = book(env);
  const st = await b.state();
  const url = new URL('https://creditunion.fun/market.json');
  const now = Math.floor(Date.now() / 1000);
  const credits = hasSweeper(env) ? env.CREDITS : MAINNET_CREDITS;
  if (!st.rows || Date.now() - st.built > 60 * 60_000 || now - st.cursor > 30 * 60) {
    if (!(await b.claim('rebuild', 10 * 60_000))) return; // one already running
    try {
      await b.replaceAll(await readMarketRows(env, url, ctx), now - 60);
      console.log('[market] rebuilt');
    } finally {
      await b.release('rebuild');
    }
    return;
  }
  await b.kick(); // the book's own 10-second loop reads the feed and the chain (market.ts)
  if (new Date().getUTCMinutes() % 5 === 0) await b.setExtras((await extras(env, url, ctx)).extra.map((e) => [e.id, e.price, e.source, e.listingId ?? '', '', '', 0] as Row));
}


async function readUnions(env: Env): Promise<string> {
  return toJson({ at: Math.floor(Date.now() / 1000), unions: await unionList(env) });
}
/// One union as the index has it.
type Indexed = { address: Address; summary: unknown; ids: number[]; depositors: readonly Address[]; format?: number | null };
/// Every union's summary and slots. `kept`, the last good read by address: a union whose read fails this time keeps
/// its last good entry (a busy RPC never blanks a card), and with none it waits for the next read. When nothing
/// could be read at all, this throws rather than answer an empty list.
async function unionList(env: Env, kept?: Map<string, Indexed>): Promise<Indexed[]> {
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
  // batchSize counts calldata bytes (4 a call here): 200 is 25 unions a call. A full union's slots cost ~350k gas to
  // read, so each call stays far under any RPC's eth_call gas cap however many unions there are.
  const res = hasMulticall(env)
    ? await c.multicall({ contracts, allowFailure: true, multicallAddress: MULTICALL3, batchSize: 200 })
    : await Promise.all(contracts.map((x) => c.readContract(x).then((result) => ({ status: 'success' as const, result }), () => ({ status: 'failure' as const, result: undefined }))));
  const hidden = await hiddenUnions(env);
  let failed = 0;
  const unions = addrs.flatMap((address, i): Indexed[] => {
    const [s, sl] = [res[2 * i], res[2 * i + 1]];
    if (s.status !== 'success' || sl.status !== 'success') {
      failed++;
      const k = kept?.get(address.toLowerCase());
      return k ? [k] : [];
    }
    const [ids, depositors] = sl.result as readonly [readonly bigint[], readonly Address[]];
    if (ids.length < 80 && hidden.has(address.toLowerCase())) return []; // a plan's union, still filling
    return [{ address, summary: s.result, ids: ids.map(Number), depositors }];
  });
  if (addrs.length && failed === addrs.length && !kept?.size) throw new Error('Credit Unions could not be read');
  // A full union waiting to burn carries its creator's format pick (UnionFormats; null for none), so its card draws
  // what it will burn in. A pick that can't be read keeps the last one read.
  const formats = addrOrNull(env.FORMATS);
  const full = formats ? unions.filter((u) => (u.summary as { state?: number }).state === 1) : [];
  if (formats && full.length) {
    const calls = full.map((u) => ({ address: formats, abi: unionFormatsAbi, functionName: 'pickOf', args: [u.address] }) as const);
    const picks = hasMulticall(env)
      ? await c.multicall({ contracts: calls, allowFailure: true, multicallAddress: MULTICALL3, batchSize: 1024 })
      : await Promise.all(calls.map((x) => c.readContract(x).then((result) => ({ status: 'success' as const, result }), () => ({ status: 'failure' as const, result: undefined }))));
    full.forEach((u, i) => {
      const r = picks[i];
      const pick = r.status === 'success' ? (r.result as readonly [boolean, number]) : null;
      u.format = pick ? (pick[0] ? Number(pick[1]) : null) : (kept?.get(u.address.toLowerCase())?.format ?? null);
    });
  }
  return unions;
}

// ---------------------------------------------------------------- the chain, read once for the site

/// How long this isolate and the colo cache keep the union index: under a block, so a bid or a deposit shows within
/// a poll.
const INDEX_MS = 2_000;
/// How long they keep the Activity feed: about a block.
const FEED_MS = 10_000;
/// How often the ChainBook looks for a new block while pages are asking; it reads the index and the feed again on
/// each one, so a page's read never waits on the chain.
const LOOP_MS = 2_000;
/// The oldest read the ChainBook hands out without reading again (a guard in case its loop falls behind).
const BOOK_MS = 15_000;
/// The site's one ChainBook, placed in eastern North America (near the RPC and most visitors) when first made.
const chainBook = (env: Env) => (env.CHAIN ? env.CHAIN.get(env.CHAIN.idFromName('chain'), { locationHint: 'enam' }) : null);

/// The chain as every page reads it, read by one object for the whole site: the union index (every union's summary
/// and slots) and the Activity feed. The colo cache is per data center, so without this each of them reads the chain
/// for the same things; and a union page polls the index rather than the chain, so watching costs no RPC however
/// many watch. A read older than its caller allows is redone, one at a time (callers waiting share it); a failed read
/// keeps the last good one.
export class ChainBook extends DurableObject<Env> {
  private index: { at: number; body: string } | null = null;
  private kept = new Map<string, Indexed>();
  private indexing: Promise<void> | null = null;
  private feed: { at: number; body: string } | null = null;
  private feeding: Promise<void> | null = null;
  private asked = 0; // when a page last asked: the loop runs while that's recent
  private head = -1n; // the newest block the loop has read the index and the feed at

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS kept (k TEXT PRIMARY KEY, v TEXT)`);
  }

  /// Keep the loop going while pages ask (it stops five minutes after the last ask, and the next ask starts it).
  private async wake() {
    this.asked = Date.now();
    if (!(await this.ctx.storage.getAlarm())) await this.ctx.storage.setAlarm(Date.now() + LOOP_MS);
  }
  /// Every LOOP_MS: a new block (or a read going stale) reads the index and the feed again, one read for every page.
  async alarm() {
    try {
      const head = await client(this.env).getBlockNumber();
      if (head !== this.head || Date.now() - (this.index?.at ?? 0) > 12_000) {
        this.head = head;
        this.indexing ??= this.readIndex().finally(() => (this.indexing = null));
        this.feeding ??= this.readFeed().finally(() => (this.feeding = null));
        await Promise.allSettled([this.indexing, this.feeding]);
      }
    } catch (e) {
      console.warn('[chain] loop', safeError(e));
    } finally {
      if (Date.now() - this.asked < 5 * 60_000) await this.ctx.storage.setAlarm(Date.now() + LOOP_MS);
    }
  }

  /// The union index as /unions.json serves it, read at most `maxMs` before this call (0: after it). `at` is when
  /// that read began.
  async unions(maxMs: number): Promise<{ at: number; body: string }> {
    await this.wake();
    const asked = Date.now();
    // Too old for this caller: read again. One that can take the last copy (maxMs > 0) gets it at once while the
    // read runs, so a slow chain never holds a page up; only a caller after its own transaction (0) waits for it.
    if (this.index && maxMs > 0 && asked - this.index.at > maxMs) {
      this.indexing ??= this.readIndex().finally(() => (this.indexing = null));
      this.indexing.catch(() => {});
      return this.index;
    }
    while (!this.index || asked - this.index.at > maxMs) {
      this.indexing ??= this.readIndex().finally(() => (this.indexing = null));
      try {
        await this.indexing;
      } catch (e) {
        if (!this.index) throw e;
        break; // the last good read
      }
    }
    return this.index!;
  }
  private async readIndex() {
    const at = Date.now();
    const unions = await unionList(this.env, this.kept);
    this.kept = new Map(unions.map((u) => [u.address.toLowerCase(), u]));
    this.index = { at, body: toJson({ at: Math.floor(at / 1000), unions }) };
  }

  /// Every Activity row as a JSON array (newest first, plans' unions left out until they fill), read at most `maxMs`
  /// before this call.
  async activity(maxMs: number): Promise<{ at: number; body: string }> {
    await this.wake();
    const asked = Date.now();
    while (!this.feed || asked - this.feed.at > maxMs) {
      this.feeding ??= this.readFeed().finally(() => (this.feeding = null));
      try {
        await this.feeding;
      } catch (e) {
        if (!this.feed) throw e;
        break;
      }
    }
    return this.feed!;
  }
  private async readFeed() {
    const at = Date.now();
    const items = await activityItems(this.env, this.store(), `activity-state/${this.env.FACTORY.toLowerCase()}`);
    this.feed = { at, body: JSON.stringify(items) };
  }

  /// A union's fitting listings (scanFor), scanned at most once per `maxMs` for the whole site, whoever asks. A scan up
  /// to STALE_MS old is handed out while the next one runs behind it, so a Buy tab never waits on a scan it can do
  /// without (buying prices each listing again anyway). Finished scans are also saved in this object's storage, so a
  /// restart hands out the last one rather than making the next viewer wait on a fresh scan.
  private scans = new Map<string, { at: number; p: Promise<Listing[]>; done: boolean }>();
  private rescans = new Set<string>();
  async listings(batch: Address, extra: Extra[], maxMs: number, deep?: string[] | null): Promise<Listing[]> {
    setSpareKey(this.env.OPENSEA_API_KEY_2);
    const k = batch.toLowerCase();
    let hit = this.scans.get(k);
    if (!hit) {
      const row = this.ctx.storage.sql.exec(`SELECT v FROM kept WHERE k = ?`, `scan:${k}`).toArray()[0];
      if (row) {
        try {
          const { at, ls } = JSON.parse(String(row.v)) as { at: number; ls: Listing[] };
          hit = { at, p: Promise.resolve(ls), done: true };
          this.scans.set(k, hit);
        } catch {}
      }
    }
    const age = hit ? Date.now() - hit.at : Infinity;
    if (hit && age <= maxMs) return hit.p;
    const keep = (at: number, ls: Listing[]) => {
      this.scans.set(k, { at, p: Promise.resolve(ls), done: true });
      this.ctx.storage.sql.exec(`INSERT INTO kept (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`, `scan:${k}`, JSON.stringify({ at, ls }));
    };
    if (hit?.done && age <= STALE_MS) {
      if (!this.rescans.has(k)) {
        this.rescans.add(k);
        const at = Date.now();
        void scanFor(this.env, batch, { extra }, deep)
          .then((ls) => keep(at, ls))
          .catch((e) => console.warn('[scan]', safeError(e)))
          .finally(() => this.rescans.delete(k));
      }
      return hit.p;
    }
    for (const [x, v] of this.scans) if (Date.now() - v.at > STALE_MS) this.scans.delete(x);
    const at = Date.now();
    const entry = { at, p: scanFor(this.env, batch, { extra }, deep), done: false };
    this.scans.set(k, entry);
    entry.p.then(
      (ls) => {
        entry.done = true;
        if (this.scans.get(k) === entry) keep(at, ls);
      },
      () => this.scans.get(k) === entry && this.scans.delete(k),
    );
    return entry.p;
  }

  /// Where the feed's scan state lives (activity.ts keeps it in a Cache): this object's storage, so a restart reads
  /// on from where it stopped instead of rescanning.
  private store(): Cache {
    const sql = this.ctx.storage.sql;
    const k = (r: RequestInfo | URL) => (typeof r === 'string' ? r : r instanceof URL ? r.href : r.url);
    return {
      match: async (r: RequestInfo | URL) => {
        const row = sql.exec(`SELECT v FROM kept WHERE k = ?`, k(r)).toArray()[0];
        return row ? new Response(String(row.v)) : undefined;
      },
      put: async (r: RequestInfo | URL, res: Response) => {
        const v = await res.text();
        // A row holds 2 MB; past that the state stays in memory only (a restart rescans).
        if (v.length < 1_800_000) sql.exec(`INSERT INTO kept (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`, k(r), v);
      },
    } as unknown as Cache;
  }
}

/// A rule as the matcher's Rules, to pick the card's wall.
const rulesOf = (f: Filter) => ({
  palettes: f.palettes, prints: f.prints, weights: f.weights, eights: f.eights,
  paidFrom: Number(f.paidFrom), paidTo: Number(f.paidTo), idFrom: Number(f.idFrom), idTo: Number(f.idTo),
  minScore: f.minScore, maxScore: f.maxScore, bitsFrom: f.bitsFrom, bitsTo: f.bitsTo,
});

/// Whether rating rules are checked against LiveRatings: for a union, the table it opened with (fixed for good); with
/// none, the factory's table now (what a union opened now would use). The original table is env.RATINGS.
const unionTables = new Map<string, Promise<boolean>>();
let factoryTable: { at: number; p: Promise<boolean> } | null = null;
async function liveTable(env: Env, union?: Address): Promise<boolean> {
  const original = (env.RATINGS ?? '').toLowerCase();
  const isLive = (a: unknown) => !!original && String(a).toLowerCase() !== original;
  if (union) {
    const k = union.toLowerCase();
    let p = unionTables.get(k);
    if (!p) {
      p = client(env).readContract({ address: union, abi: [{ type: 'function', name: 'ratings', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] }], functionName: 'ratings' }).then(isLive);
      unionTables.set(k, p);
      p.catch(() => unionTables.delete(k));
    }
    return p.catch(() => false);
  }
  if (!factoryTable || Date.now() - factoryTable.at > 60_000) {
    const p = client(env).readContract({ address: env.FACTORY as Address, abi: factoryAbi, functionName: 'ratings' }).then(isLive);
    factoryTable = { at: Date.now(), p };
    p.catch(() => (factoryTable = null));
  }
  return factoryTable.p.catch(() => false);
}

/// Every Credit the rules let in, in Credit order.
async function admitted(env: Env, url: URL, rules: Rules): Promise<number[]> {
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
  // Another data center's drawing, kept in KV the same day.
  const kvKey = `og:${cacheKey.slice(url.origin.length)}`;
  const kept = await keptPng(env, kvKey);
  if (kept) {
    const res = new Response(kept, { headers: { 'content-type': 'image/png', 'cache-control': 'public, max-age=86400' } });
    ctx.waitUntil(cache.put(cacheKey, res.clone()));
    return res;
  }
  const generic = () => env.ASSETS.fetch(new Request(new URL('/og/party.png', url)));
  if (await limited(env.RL_MISC, req)) return generic();
  let u: UnionCard | null = null;
  try {
    if (kind === 'sample') {
      const x = sample(key);
      if (x) u = { name: x.name, ids: await admitted(env, url, x.rules) };
    } else if (/^0x[0-9a-fA-F]{40}$/.test(key) && (await isBatch(env, url, key.toLowerCase() as Address))) {
      const p = await readParty(env, key as Address, url, ctx);
      u = { name: p.name, ids: await admitted(env, url, { ...rulesOf(p.filter), live: await liveTable(env, key as Address) }) };
    }
  } catch {
    u = null;
  }
  if (!u) return generic();
  const body = await drawUnion(env.ASSETS, url.origin, u);
  const res = new Response(body, { headers: { 'content-type': 'image/png', 'cache-control': 'public, max-age=86400' } });
  ctx.waitUntil(Promise.all([cache.put(cacheKey, res.clone()), keptPut(env, kvKey, body, 86400)]));
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

  const allowed = new Set([env.CREDITS, env.FACTORY, env.SWEEPER, addrOrNull(env.FORMATS), addrOrNull(env.TOKEN_FACTORY), addrOrNull(env.TOKEN_ADAPTER), addrOrNull(env.TOKEN_FORMATS)].map((a) => a?.toLowerCase()).filter(Boolean));
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
      if (!/^0x[0-9a-f]{40}$/.test(to) || !/^0x([0-9a-fA-F]{2})*$/.test(data) || data.length > 2 + 2 * MAX_CALL_BYTES) return text('bad call', 400);
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
    } else if (method === 'eth_getBalance') {
      if (!/^0x[0-9a-fA-F]{40}$/.test(String(p[0] ?? ''))) return text('bad address', 400);
      out = [String(p[0]).toLowerCase(), 'latest'];
    } else {
      out = [];
    }
    clean.push({ jsonrpc: '2.0', id: id ?? null, method, params: out });
    return null;
  }
  // eth_call only to our contracts: Credits, the factory, the Sweeper, UnionFormats, Credits' art contract, the
  // factory's burn contract (a picture's spots), the Statements it mints into (a burned union's format), or a batch
  // the factory made. Every target named before the first malformed call must pass, as when checked in order.
  if (others.size) {
    const [art, adapter, statements] = await Promise.all([artOf(env), assemblerOf(env), statementsOf(env)]);
    const rest = [...others.keys()].filter((to) => to !== art && to !== adapter && to !== statements?.toLowerCase());
    const ok = await Promise.all(rest.map((to) => isBatch(env, url, to as Address)));
    if (ok.some((x) => !x)) return text('target not allowed', 403);
  }
  if (refused) return refused;
  const payload = JSON.stringify(Array.isArray(parsed) ? clean : clean[0]);
  const post = async (to: string) => {
    try {
      const r = await fetch(to, { method: 'POST', headers: { 'content-type': 'application/json' }, body: payload, signal: AbortSignal.timeout(6_000) });
      return { status: r.status, body: await r.text() };
    } catch {
      return null; // down, or slower than a page should wait
    }
  };
  // Refused, down, slow, or over its limit, which a batch can also say inside a 200 (each call answering 429).
  const failed = (u: Awaited<ReturnType<typeof post>>) => !u || [401, 403, 429].includes(u.status) || u.status >= 500 || /"code"\s*:\s*(429|-32005)\b/.test(u.body);
  // The paid key failing: the public node answers instead, so pages and pre-send simulations keep working, and for
  // a few seconds this isolate asks the public node first rather than piling onto a key that's over its limit.
  let upstream: Awaited<ReturnType<typeof post>>;
  if (!hasFallback(env)) upstream = await post(rpcUrl(env));
  else if (Date.now() < rpcCooling) {
    upstream = await post(env.FALLBACK_RPC);
    if (failed(upstream)) upstream = await post(rpcUrl(env));
  } else {
    upstream = await post(rpcUrl(env));
    if (failed(upstream)) {
      rpcCooling = Date.now() + 5_000;
      upstream = await post(env.FALLBACK_RPC);
    }
  }
  if (!upstream) return text('upstream unavailable', 502);
  return new Response(upstream.body, {
    status: upstream.status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}
/// Until when this isolate sends /rpc to the public node first (the paid key just failed).
let rpcCooling = 0;

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

/// The marketplaces with any Credit listed right now (OpenSea whenever it's read), in the order the site shows them:
/// every Buy heading shows the same marks, whatever the first listings happen to be.
const sourcesOf = (env: Env, extra: { source: string }[]) => [...(env.OPENSEA_API_KEY ? ['opensea'] : []), ...['fwa', 'strategy'].filter((s) => extra.some((e) => e.source === s))];

/// One page of OpenSea's cheapest listings, cached 15 s: every live grid reads its head again every 20 s, so any
/// number of people watching one costs OpenSea a call per page every 15 s.
async function bestPageCached(env: Env, url: URL, ctx: ExecutionContext, credits: Address, next: string, trait?: { traitType: string; value: string }) {
  const cache = caches.default;
  const key = new Request(`${url.origin}/opensea/best/v1/${credits.toLowerCase()}/${trait ? `${encodeURIComponent(trait.traitType)}/${encodeURIComponent(trait.value)}` : 'all'}?next=${encodeURIComponent(next)}`);
  const hit = await cache.match(key);
  if (hit) return hit.json<Awaited<ReturnType<typeof bestPage>>>();
  const pg = await bestPage(env.OPENSEA_API_KEY!, env.OPENSEA_SLUG, credits, next, trait);
  ctx.waitUntil(cache.put(key, Response.json(pg, { headers: { 'cache-control': 'public, max-age=15' } })));
  return pg;
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

/// The most Credits one quote takes: the Printer buys 40 at a time; the site's own Buy sliders stop at 24.
const MAX_SWEEP = 40;
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
    ctx.waitUntil(cache.put(key, Response.json(live, { headers: { 'cache-control': 'public, max-age=15' } }))); // as fresh as OpenSea's pages
    return tag(live);
  } catch (e) {
    console.warn('[fwa] listings unavailable', safeError(e));
    return [];
  }
}

/// The Credits CreditStrategy has for sale. Reading them is 13 heavy eth_calls, so the result is cached 15 s (as
/// fresh as OpenSea's pages) and shared while in flight; a Credit sold since is dropped when it is quoted. A read that fails everywhere
/// serves the last good one, up to an hour old: each buy re-reads its Credits on-chain first.
let strategyRead: Promise<Extra[]> | null = null;
async function heldByStrategy(env: Env, url: URL, ctx: ExecutionContext): Promise<Extra[]> {
  const strategy = addrOrNull(env.STRATEGY);
  if (!strategy) return [];
  const cache = caches.default;
  const key = new Request(`${url.origin}/strategy/listings/${strategy.toLowerCase()}`);
  const lastGood = new Request(`${url.origin}/strategy/listings-last/${strategy.toLowerCase()}`);
  const hit = await cache.match(key);
  if (hit) return hit.json<Extra[]>();
  if (!strategyRead) {
    strategyRead = readStrategy(env, strategy)
      .then((ls) => {
        const out = ls.map((l): Extra => ({ ...l, source: 'strategy' }));
        ctx.waitUntil(cache.put(key, Response.json(out, { headers: { 'cache-control': 'public, max-age=15' } })));
        ctx.waitUntil(cache.put(lastGood, Response.json(out, { headers: { 'cache-control': 'public, max-age=3600' } })));
        return out;
      })
      .catch(async (e) => {
        console.warn('[strategy] listings unavailable', safeError(e));
        return (await cache.match(lastGood))?.json<Extra[]>() ?? [];
      })
      .finally(() => {
        strategyRead = null;
      });
  }
  return strategyRead;
}

/// The strategy's scan (creation code run in an eth_call, 50M gas each) through our RPC first, then public ones:
/// some providers refuse that kind of call ("Transaction creation failed") while serving every ordinary read.
async function readStrategy(env: Env, strategy: Address) {
  const urls = [...new Set([env.FALLBACK_RPC, 'https://ethereum-rpc.publicnode.com', 'https://eth.drpc.org'].filter((u): u is string => !!u))];
  const clients = [mainClient(env), ...urls.map((u) => createPublicClient({ chain: mainnet, transport: http(u, { timeout: 20_000 }) }))];
  let last: unknown;
  for (const c of clients) {
    try {
      return await strategyListings(c, { strategy, supply: SUPPLY });
    } catch (e) {
      last = e;
    }
  }
  throw last;
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
    hasCode: (a) => main.getCode({ address: a }).then((code) => !!code && code !== '0x' && !/^0xef0100[0-9a-f]{40}$/i.test(code)), // an EIP-7702 wallet is a person's
  });
  ctx.waitUntil(cache.put(key, Response.json(listings, { headers: { 'cache-control': 'public, max-age=60' } })));
  return listings;
}

/// Listings that fit a union, cheapest first. The scan (OpenSea's pages, FWA and the strategy, liveness checks) is the
/// costly part and the same for everyone: the ChainBook runs it once per union for the whole site (SCAN_MS), and the
/// colo keeps it 10 s. `fresh` (a quote about to be bought): the union's canTake is asked now rather than taken from
/// the last few seconds.
async function fitting(env: Env, url: URL, ctx: ExecutionContext, batch: Address, fresh = false) {
  const cache = caches.default;
  const scanKey = new Request(`${url.origin}/opensea/scan/${batch}`);
  let listings = await cache.match(scanKey).then((r) => r?.json<Awaited<ReturnType<typeof scan>>>());
  if (!listings && inflight.has(batch)) listings = await inflight.get(batch)!;
  if (!listings) {
    const book = chainBook(env);
    const p = Promise.all([extras(env, url, ctx), deepCandidates(env, url, ctx, batch).catch(() => null)]).then(async ([more, deep]) => {
      if (book && !more.fakeOpenSea) {
        try {
          return await book.listings(batch, more.extra, SCAN_MS, deep);
        } catch (e) {
          console.warn('[scan] read here', safeError(e));
        }
      }
      return scanFor(env, batch, more, deep);
    });
    // waitUntil keeps this request's context (and so the scan's I/O) alive even if the client goes away.
    inflight.set(batch, p);
    ctx.waitUntil(p.finally(() => inflight.delete(batch)).catch(() => {}));
    listings = await p;
    ctx.waitUntil(cache.put(scanKey, Response.json(listings, { headers: { 'cache-control': 'public, max-age=10' } })));
  }
  // Slots: on a layout party two listings of one palette can fight over one slot, so the party replays its
  // deposit rule over the whole bundle, in price order, and only the ones that would land are kept. Kept 5 s per set
  // of listings for everyone watching the Buy tab; a quote asks now.
  if (listings.length) {
    const takeKey = new Request(`${url.origin}/opensea/take/${batch}/${idsKey(listings.map((l) => l.id))}`);
    let ok = fresh ? null : await cache.match(takeKey).then((r) => (r ? r.json<boolean[]>() : null));
    if (!ok) {
      try {
        ok = [...((await client(env).readContract({ address: batch, abi: batchAbi, functionName: 'canTake', args: [listings.map((l) => BigInt(l.id))] })) as readonly boolean[])];
        ctx.waitUntil(cache.put(takeKey, Response.json(ok, { headers: { 'cache-control': 'public, max-age=5' } })));
      } catch {}
    }
    if (ok) listings = listings.filter((_, i) => ok[i]);
  }
  return listings;
}
/// How long the ChainBook keeps a union's scan.
const SCAN_MS = 20_000;
/// How old a scan can be and still be handed out (while a new one runs): the Buy tab shows it at once, and a buy
/// prices every listing again before it sends.
const STALE_MS = 30 * 60_000;
/// The scan itself (opensea.ts), with this union's canTake and the chain's liveness checks; `deep`, a narrow union's
/// Credits for sale (deepCandidates), is read through once OpenSea's cheapest pages come up short.
function scanFor(env: Env, batch: Address, more: { extra: Extra[]; fakeOpenSea?: { id: string; price: string }[] }, deep?: readonly string[] | null) {
  const c = client(env);
  return scan({
    key: env.OPENSEA_API_KEY,
    slug: env.OPENSEA_SLUG,
    credits: env.CREDITS,
    ...more,
    deep: deep?.length && env.OPENSEA_API_KEY ? (seen, need) => deepOrders(env, deep, seen, need) : undefined,
    max: 40,
    take: (ids) => c.readContract({ address: batch, abi: batchAbi, functionName: 'canTake', args: [ids] }),
    live: (id, seller, operator) =>
      Promise.all([
        c.readContract({ address: env.CREDITS, abi: creditsAbi, functionName: 'ownerOf', args: [id] }),
        c.readContract({ address: env.CREDITS, abi: creditsAbi, functionName: 'isApprovedForAll', args: [seller, operator] }),
      ]).then(([o, ok]) => o.toLowerCase() === seller.toLowerCase() && ok),
    // A wallet delegated under EIP-7702 (its code is just 0xef0100 and the delegate's address) is a person's account,
    // and takes ETH like one: only real contracts are kept out.
    hasCode: (a) => c.getCode({ address: a }).then((code) => !!code && code !== '0x' && !/^0xef0100[0-9a-f]{40}$/i.test(code)),
  });
}

/// Most Credits the deep pass hands the scan, cheapest first.
const DEEP_MAX = 60;
/// A union that fewer Credits than this fit is narrow: OpenSea's cheapest pages can hold none of its listings.
const NARROW = 12_000;
/// The orders of these Credits (the Worker's pick, deepCandidates) not yet weighed by the scan, cheapest first, read
/// from OpenSea four at a time.
async function deepOrders(env: Env, ids: readonly string[], seen: ReadonlySet<string>, need: number): Promise<Cand[]> {
  const want = ids.filter((id) => !seen.has(id)).slice(0, need + 10);
  const out: Cand[] = [];
  for (let i = 0; i < want.length; i += 4) for (const c of await Promise.all(want.slice(i, i + 4).map((id) => orderOf(env, id)))) if (c) out.push(c);
  return out;
}
/// Which Credits a union takes, by its rules and its own list, kept per isolate (a union's rules never change); null
/// for a union so many Credits fit that OpenSea's cheapest pages always have some.
const narrowUnions = new Map<string, Promise<{ fits: (id: number) => boolean; list: number[] | null } | null>>();
/// For a narrow union (its own list of Credits, a rare trait), the Credits for sale that fit it, cheapest first, from
/// the market book: the scan reads their orders once OpenSea's cheapest pages run out (deepOrders). Null otherwise.
async function deepCandidates(env: Env, url: URL, ctx: ExecutionContext, batch: Address): Promise<string[] | null> {
  if (!hasSweeper(env) || !env.MARKET || !env.OPENSEA_API_KEY) return null;
  const k = batch.toLowerCase();
  let rule = narrowUnions.get(k);
  if (!rule) {
    rule = (async () => {
      const s = (await client(env).readContract({ address: batch, abi: batchAbi, functionName: 'summary' })) as unknown as { filter: Filter; allowlistSize: bigint };
      const fits = await predicate(env.ASSETS, url.origin, { ...rulesOf(s.filter), live: await liveTable(env, batch) });
      if (Number(s.allowlistSize) > 0) {
        const list = await allowlistOf(env, batch);
        if (!list) throw new Error('the union’s list can’t be read now');
        const on = new Set(list);
        return { fits: (id: number) => on.has(id) && fits(id), list };
      }
      let n = 0;
      for (let id = 1; id <= SUPPLY && n < NARROW; id++) if (fits(id)) n++;
      return n < NARROW ? { fits, list: null } : null;
    })();
    narrowUnions.set(k, rule);
    rule.catch(() => narrowUnions.get(k) === rule && narrowUnions.delete(k));
  }
  const r = await rule;
  if (!r) return null;
  const rows = r.list ? ((await book(env).getMany(r.list.map(String))).rows as unknown as Row[]) : await marketRows(env, url, ctx);
  return rows
    .filter((x) => x[2] === 'opensea' && r.fits(Number(x[0])))
    .sort((a, b) => (BigInt(a[1]) < BigInt(b[1]) ? -1 : BigInt(a[1]) > BigInt(b[1]) ? 1 : 0))
    .slice(0, DEEP_MAX)
    .map((x) => String(x[0]));
}
/// The market book as /market.json has it: when it last changed, and its rows (id, price, source, a, b) cheapest first.
/// The colo's copy, parsed and sorted once per isolate for 30 s.
let bookMemo: { at: number; book: Promise<{ at: number; rows: Row[] }> } | null = null;
function marketBook(env: Env, url: URL, ctx: ExecutionContext): Promise<{ at: number; rows: Row[] }> {
  if (bookMemo && Date.now() - bookMemo.at < 30_000) return bookMemo.book;
  const book_ = (async () => {
    const key = new Request(`${url.origin}/market.json/v2`);
    const hit = await caches.default.match(key);
    const body = hit ? await hit.text() : await book(env).snapshot();
    if (!hit) ctx.waitUntil(caches.default.put(key, new Response(body, { headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=30' } })));
    const j = JSON.parse(body) as { at: number; items: string[][] };
    const rows = j.items.map((x) => [x[0], x[1], x[2], x[3], x[4], '', 0] as Row);
    rows.sort((a, b) => (BigInt(a[1]) < BigInt(b[1]) ? -1 : BigInt(a[1]) > BigInt(b[1]) ? 1 : 0));
    return { at: j.at, rows };
  })();
  bookMemo = { at: Date.now(), book: book_ };
  book_.catch(() => bookMemo?.book === book_ && (bookMemo = null));
  return book_;
}
const marketRows = async (env: Env, url: URL, ctx: ExecutionContext) => (await marketBook(env, url, ctx)).rows;

/// Orders the deep pass read, a minute each (in the ChainBook, where scans run, that's for the whole site).
const orders = new Map<string, { at: number; p: Promise<Cand | null> }>();
function orderOf(env: Env, id: string): Promise<Cand | null> {
  const hit = orders.get(id);
  if (hit && Date.now() - hit.at < 60_000) return hit.p;
  if (orders.size > 2000) for (const [k, v] of orders) if (Date.now() - v.at >= 60_000) orders.delete(k);
  // A failed read (a rate limit) is nothing this time, not remembered as "no listing".
  const entry: { at: number; p: Promise<Cand | null> } = { at: Date.now(), p: Promise.resolve(null) };
  entry.p = bestOrder(env.OPENSEA_API_KEY!, env.OPENSEA_SLUG, env.CREDITS, id).catch(() => {
    if (orders.get(id) === entry) orders.delete(id);
    return null;
  });
  orders.set(id, entry);
  return entry.p;
}

const BATCH_CREATED = parseAbiItem('event BatchCreated(address indexed batch, address indexed creator, string name, uint256 index)');
/// A union's own list of Credits (Batch's allowlist, set once when it was made), ascending: from the transaction that
/// made it (the factory's create call), or failing that asked of the union for every Credit. Kept in KV for good.
/// Null when it can't be read now; [] for a union without one.
async function allowlistOf(env: Env, batch: Address): Promise<number[] | null> {
  const k = `allowlist:${batch.toLowerCase()}`;
  const kept = await keptGet(env, k);
  if (kept) return JSON.parse(kept) as number[];
  const c = client(env);
  const size = Number(await c.readContract({ address: batch, abi: batchAbi, functionName: 'allowlistSize' }).catch(() => -1n));
  if (size < 0) return null;
  if (!size) return [];
  let ids: number[] | null = null;
  try {
    const [log] = await c.getLogs({ address: env.FACTORY, event: BATCH_CREATED, args: { batch }, fromBlock: env.CHAIN_ID === '1' ? ACTIVITY_FROM : 0n });
    const tx = log ? await c.getTransaction({ hash: log.transactionHash! }) : null;
    if (tx && tx.to?.toLowerCase() === env.FACTORY.toLowerCase()) {
      const call = decodeFunctionData({ abi: factoryAbi, data: tx.input });
      if (call.functionName === 'create') {
        const list = [...new Set((call.args[2] as readonly bigint[]).map(Number))].sort((a, b) => a - b);
        if (list.length === size) ids = list;
      }
    }
  } catch {}
  // Made some other way (through a smart wallet, say): the union answers for every Credit, 2,000 to a call.
  if (!ids && hasMulticall(env)) {
    try {
      const found: number[] = [];
      for (let from = 1; from <= SUPPLY; from += 2000) {
        const part = Array.from({ length: Math.min(2000, SUPPLY - from + 1) }, (_, i) => from + i);
        const res = await c.multicall({ contracts: part.map((id) => ({ address: batch, abi: batchAbi, functionName: 'allowed', args: [BigInt(id)] }) as const), allowFailure: false, multicallAddress: MULTICALL3, batchSize: 1_000_000 });
        part.forEach((id, i) => res[i] && found.push(id));
      }
      if (found.length === size) ids = found;
    } catch {}
  }
  if (ids) await keptPut(env, k, JSON.stringify(ids));
  return ids;
}

/// A wallet's primary ENS name and its avatar (ENS's own metadata service, so this Worker never fetches a URL a name
/// owner chose), the avatar only when the name has an avatar record (most don't): the colo's copy, else another data center's from KV, else the chain. `ttl`: a day with a name, an
/// hour without, a minute after a failed lookup. `gate`, asked before a chain lookup: true (over the rate limit) is
/// null.
async function ensOf(env: Env, url: URL, ctx: ExecutionContext, addr: Address, gate?: () => Promise<boolean>): Promise<{ name: string | null; avatar: string | null; ttl: number } | null> {
  const cache = caches.default;
  const key = new Request(`${url.origin}/ens/v2/${addr}`); // v2: avatar only with an avatar record
  const hit = await cache.match(key);
  if (hit) return { ...((await hit.json()) as { name: string | null; avatar: string | null }), ttl: Number(hit.headers.get('cache-control')?.match(/max-age=(\d+)/)?.[1] ?? 3600) };
  const kvKey = `ens2:${addr}`;
  const kept = await keptGet(env, kvKey);
  if (kept) {
    ctx.waitUntil(cache.put(key, new Response(kept, { headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=3600' } })));
    return { ...(JSON.parse(kept) as { name: string | null; avatar: string | null }), ttl: 3600 };
  }
  if (gate && (await gate())) return null;
  const rpc = env.ENS_RPC || (env.CHAIN_ID === '1' ? rpcUrl(env) : 'https://eth.drpc.org');
  const c = createPublicClient({ chain: mainnet, transport: http(rpc, { timeout: 5_000 }) });
  let name: string | null = null;
  let ttl = 86400;
  let has = false;
  try {
    name = await c.getEnsName({ address: addr });
    if (!name) ttl = 3600;
    else has = !!(await c.getEnsText({ name, key: 'avatar' }));
  } catch {
    ttl = 60;
  }
  const avatar = name && has ? `https://metadata.ens.domains/mainnet/avatar/${encodeURIComponent(name)}` : null;
  const body = JSON.stringify({ name, avatar });
  ctx.waitUntil(Promise.all([cache.put(key, new Response(body, { headers: { 'content-type': 'application/json', 'cache-control': `public, max-age=${ttl}` } })), ttl > 60 ? keptPut(env, kvKey, body, ttl) : null]));
  return { name, avatar, ttl };
}

/// A Credits contract's art contract, as Credits itself names it (`art()`): the app asks it for a Credit's traits
/// (describe) the way a batch does, and /art draws with it. Read once per isolate per Credits contract (the
/// configured one, and mainnet's for previews); only a well-formed nonzero address is ever returned.
const artAddrs = new Map<string, Promise<string | null>>();
/// Jack's Statements, as far as the Worker reads it: the drawing of one Statement.
const statementsAbi = [
  { type: 'function', name: 'statementSVG', stateMutability: 'view', inputs: [{ type: 'uint256' }], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'tokenURI', stateMutability: 'view', inputs: [{ type: 'uint256' }], outputs: [{ type: 'string' }] },
] as const;
/// The factory's burn contract (lowercase), or null until one is active. Read once a minute per isolate; once set it
/// can never change.
let assemblerKept: { at: number; addr: Promise<string | null> } | null = null;
function assemblerOf(env: Env): Promise<string | null> {
  if (assemblerKept && Date.now() - assemblerKept.at < 60_000) return assemblerKept.addr;
  const addr = client(env)
    .readContract({ address: env.FACTORY as Address, abi: factoryAbi, functionName: 'assembler' })
    .then((a) => (/^0x0{40}$/i.test(a as string) ? null : (a as string).toLowerCase()))
    .catch(() => null);
  assemblerKept = { at: Date.now(), addr };
  return addr;
}

/// The Statements contract burned unions mint into: the factory's burn contract's statement(). Read once a minute per
/// isolate; null until a burn contract is active.
let statementsKept: { at: number; addr: Promise<Address | null> } | null = null;
function statementsOf(env: Env): Promise<Address | null> {
  if (statementsKept && Date.now() - statementsKept.at < 60_000) return statementsKept.addr;
  const c = client(env);
  const addr = c
    .readContract({ address: env.FACTORY as Address, abi: factoryAbi, functionName: 'assembler' })
    .then((a) => (/^0x0{40}$/i.test(a as string) ? null : c.readContract({ address: a as Address, abi: [{ type: 'function', name: 'statement', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] }] as const, functionName: 'statement' })))
    .then((a) => (a && /^0x[0-9a-fA-F]{40}$/.test(a) && !/^0x0{40}$/i.test(a) ? (a as Address) : null))
    .catch(() => null);
  statementsKept = { at: Date.now(), addr };
  return addr;
}
/// The SVG in a tokenURI's image: the JSON and the image each a data URI, as base64 or as text.
function imageOf(uri: string): string | null {
  const data = (u: string) => {
    const m = u.match(/^data:[^,]*?(;base64)?,([\s\S]*)$/);
    if (!m) return null;
    if (m[1]) return new TextDecoder().decode(Uint8Array.from(atob(m[2]), (ch) => ch.charCodeAt(0)));
    try {
      return decodeURIComponent(m[2]);
    } catch {
      return m[2];
    }
  };
  try {
    const image = (JSON.parse(data(uri) ?? '') as { image?: unknown }).image;
    return typeof image === 'string' ? data(image) : null;
  } catch {
    return null;
  }
}

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
  // A union from either factory: the auction one, or the token one once it's deployed (same Batch code).
  const tokens = addrOrNull(env.TOKEN_FACTORY);
  try {
    ok = await client(env).readContract({ address: env.FACTORY, abi: factoryAbi, functionName: 'isBatch', args: [addr] });
    if (!ok && tokens) ok = await client(env).readContract({ address: tokens, abi: factoryAbi, functionName: 'isBatch', args: [addr] });
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
