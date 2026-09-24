/// Eighty's Worker. It holds no state and signs nothing. Its jobs:
///   /config.json   chain id and contract addresses for the app
///   /rpc           read-only JSON-RPC proxy (keeps the provider key private); wallets send txs themselves
///   /art/:id.svg   a Credit's art, read from Jack's art contract and cached forever (art never changes)
///   /opensea/quote cheapest OpenSea listings that fit a batch, as signed Seaport orders for the Sweeper
///   /ens/:address  primary ENS name and avatar (always from mainnet), cached a day
import { createPublicClient, http, type Address } from 'viem';
import { mainnet } from 'viem/chains';
import { normalize } from 'viem/ens';
import { batchAbi, creditsAbi, creditArtAbi } from '../app/abi';
import { quote } from './opensea';

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
}

const READ_METHODS = new Set([
  'eth_chainId',
  'eth_blockNumber',
  'eth_call',
  'eth_getBalance',
  'eth_getCode',
  'eth_getLogs',
  'eth_getBlockByNumber',
  'eth_getTransactionReceipt',
  'eth_getTransactionByHash',
  'eth_estimateGas',
  'eth_gasPrice',
  'eth_maxPriorityFeePerGas',
  'eth_feeHistory',
]);

const rpcUrl = (env: Env) => env.RPC_URL || env.FALLBACK_RPC;

export default {
  async fetch(req, env, ctx): Promise<Response> {
    const url = new URL(req.url);

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

    if (url.pathname === '/rpc') {
      if (req.method !== 'POST') return new Response('POST only', { status: 405 });
      const body = await req.text();
      let calls: { method?: string }[];
      try {
        const parsed = JSON.parse(body);
        calls = Array.isArray(parsed) ? parsed : [parsed];
      } catch {
        return new Response('bad json', { status: 400 });
      }
      if (calls.length > 50 || calls.some((c) => !c.method || !READ_METHODS.has(c.method))) {
        return new Response('method not allowed', { status: 403 });
      }
      const upstream = await fetch(rpcUrl(env), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      });
      return new Response(upstream.body, { status: upstream.status, headers: { 'content-type': 'application/json' } });
    }

    if (url.pathname === '/opensea/quote') {
      if (!env.OPENSEA_API_KEY || !env.SWEEPER) return new Response('OpenSea is not configured', { status: 501 });
      const batch = url.searchParams.get('batch') ?? '';
      const n = Number(url.searchParams.get('n'));
      if (!/^0x[0-9a-fA-F]{40}$/.test(batch) || !Number.isInteger(n) || n < 1 || n > 40) {
        return new Response('bad request', { status: 400 });
      }
      const client = createPublicClient({ transport: http(rpcUrl(env)) });
      try {
        const passes = (id: bigint) =>
          client.readContract({ address: batch as Address, abi: batchAbi, functionName: 'passes', args: [id] });
        const result = await quote({ key: env.OPENSEA_API_KEY, slug: env.OPENSEA_SLUG, sweeper: env.SWEEPER, credits: env.CREDITS, n, passes });
        return Response.json(result, { headers: { 'cache-control': 'no-store' } });
      } catch (e) {
        return Response.json({ error: (e as Error).message }, { status: 502 });
      }
    }

    const ens = url.pathname.match(/^\/ens\/(0x[0-9a-fA-F]{40})$/);
    if (ens) {
      const cache = caches.default;
      const key = new Request(url.origin + url.pathname.toLowerCase());
      const hit = await cache.match(key);
      if (hit) return hit;
      const rpc = env.ENS_RPC || (env.CHAIN_ID === '1' ? rpcUrl(env) : 'https://eth.drpc.org');
      const client = createPublicClient({ chain: mainnet, transport: http(rpc) });
      let name: string | null = null;
      let avatar: string | null = null;
      try {
        name = await client.getEnsName({ address: ens[1] as Address });
        if (name) avatar = await client.getEnsAvatar({ name: normalize(name) }).catch(() => null);
      } catch {
        return Response.json({ name: null, avatar: null }, { headers: { 'cache-control': 'no-store' } });
      }
      const res = Response.json({ name, avatar }, { headers: { 'cache-control': 'public, max-age=86400' } });
      ctx.waitUntil(cache.put(key, res.clone()));
      return res;
    }

    const art = url.pathname.match(/^\/art\/(\d{1,7})\.svg$/);
    if (art) {
      const cache = caches.default;
      const hit = await cache.match(req);
      if (hit) return hit;
      const client = createPublicClient({ transport: http(rpcUrl(env)) });
      const id = BigInt(art[1]);
      try {
        const [seed, ts, artAddr] = await Promise.all([
          client.readContract({ address: env.CREDITS, abi: creditsAbi, functionName: 'seedOf', args: [id] }),
          client.readContract({ address: env.CREDITS, abi: creditsAbi, functionName: 'timestampOf', args: [id] }),
          client.readContract({ address: env.CREDITS, abi: creditsAbi, functionName: 'art' }),
        ]);
        if (/^0x0+$/.test(seed)) return new Response('no such credit', { status: 404 });
        const svg = await client.readContract({ address: artAddr, abi: creditArtAbi, functionName: 'svg', args: [seed, ts] });
        const res = new Response(svg, {
          headers: {
            'content-type': 'image/svg+xml',
            'cache-control': 'public, max-age=31536000, immutable',
          },
        });
        ctx.waitUntil(cache.put(req, res.clone()));
        return res;
      } catch {
        return new Response('art unavailable', { status: 502 });
      }
    }

    return env.ASSETS.fetch(req);
  },
} satisfies ExportedHandler<Env>;
