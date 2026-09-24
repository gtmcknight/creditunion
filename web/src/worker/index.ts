/// Eighty's Worker. It holds no state and signs nothing. Three jobs:
///   /config.json   chain id and contract addresses for the app
///   /rpc           read-only JSON-RPC proxy (keeps the provider key private); wallets send txs themselves
///   /art/:id.svg   a Credit's art, read from Jack's art contract and cached forever (art never changes)
import { createPublicClient, http, type Address } from 'viem';
import { creditsAbi, creditArtAbi } from '../app/abi';

interface Env {
  ASSETS: Fetcher;
  CHAIN_ID: string;
  CREDITS: Address;
  FACTORY: Address;
  RPC_URL?: string;
  FALLBACK_RPC: string;
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
        { chainId: Number(env.CHAIN_ID), credits: env.CREDITS, factory: env.FACTORY },
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
