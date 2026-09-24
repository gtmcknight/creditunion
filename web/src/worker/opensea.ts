/// OpenSea → Sweeper. Finds the cheapest live listings that fit a batch and returns them as Seaport
/// AdvancedOrders the Sweeper contract can fill. OpenSea's key never leaves the Worker.
import type { Address } from 'viem';

const API = 'https://api.opensea.io/api/v2';
const PAGES = 5; // up to 500 listings scanned for filtered batches
const CONCURRENCY = 4;

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export type Quote = {
  orders: Json[]; // AdvancedOrder, ready for Sweeper.sweep
  ids: string[];
  prices: string[]; // wei, per listing
  total: string; // wei, sum of listings (fee not included)
};

async function os(key: string, path: string, init?: RequestInit): Promise<Json> {
  const res = await fetch(API + path, {
    ...init,
    headers: { accept: 'application/json', 'content-type': 'application/json', 'x-api-key': key, ...init?.headers },
  });
  if (!res.ok) throw new Error(`OpenSea ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

/// A listing we can fill: ETH only, one Credit, full fill, Seaport 1.6.
function usable(l: Json, credits: Address) {
  const p = l?.protocol_data?.parameters;
  const offer = p?.offer;
  if (!Array.isArray(offer) || offer.length !== 1) return null;
  const o = offer[0];
  if (Number(o.itemType) !== 2 || String(o.token).toLowerCase() !== credits.toLowerCase()) return null;
  if (!Array.isArray(p.consideration) || p.consideration.some((c: Json) => Number(c.itemType) !== 0)) return null;
  const total = p.consideration.reduce((a: bigint, c: Json) => a + BigInt(c.endAmount), 0n);
  if (p.consideration.some((c: Json) => c.startAmount !== c.endAmount)) return null; // no dutch auctions
  return { id: String(o.identifierOrCriteria), price: total, hash: String(l.order_hash), protocol: String(l.protocol_address) };
}

export async function quote(o: {
  key: string;
  slug: string;
  sweeper: Address;
  credits: Address;
  n: number;
  passes: (id: bigint) => Promise<boolean>;
}): Promise<Quote> {
  // 1. Cheapest listings that fit, one per Credit.
  const picked: NonNullable<ReturnType<typeof usable>>[] = [];
  const seen = new Set<string>();
  let next = '';
  for (let page = 0; page < PAGES && picked.length < o.n; page++) {
    const r = await os(o.key, `/listings/collection/${o.slug}/best?limit=100${next ? `&next=${encodeURIComponent(next)}` : ''}`);
    const candidates = (r.listings ?? []).map((l: Json) => usable(l, o.credits)).filter(Boolean) as typeof picked;
    const fresh = candidates.filter((c) => !seen.has(c.id) && seen.add(c.id));
    const ok = await Promise.all(fresh.map((c) => o.passes(BigInt(c.id)).catch(() => false)));
    for (let i = 0; i < fresh.length && picked.length < o.n; i++) if (ok[i]) picked.push(fresh[i]);
    next = r.next;
    if (!next) break;
  }
  picked.sort((a, b) => (a.price < b.price ? -1 : a.price > b.price ? 1 : 0));
  if (!picked.length) throw new Error('No listings fit this batch right now.');

  // 2. Signed fill data for each (includes the zone signature OpenSea's restricted orders need).
  const orders: Json[] = new Array(picked.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (i < picked.length) {
        const k = i++;
        const l = picked[k];
        const r = await os(o.key, '/listings/fulfillment_data', {
          method: 'POST',
          body: JSON.stringify({
            listing: { hash: l.hash, chain: 'ethereum', protocol_address: l.protocol },
            fulfiller: { address: o.sweeper },
          }),
        });
        orders[k] = toAdvanced(r);
      }
    }),
  );

  return {
    orders,
    ids: picked.map((p) => p.id),
    prices: picked.map((p) => p.price.toString()),
    total: picked.reduce((a, p) => a + p.price, 0n).toString(),
  };
}

/// Normalise OpenSea's fulfillment response into Seaport's AdvancedOrder.
function toAdvanced(r: Json): Json {
  const fd = r.fulfillment_data ?? {};
  const input = fd.transaction?.input_data ?? {};
  const adv = input.advancedOrder;
  const order = fd.orders?.[0] ?? {};
  const params = adv?.parameters ?? order.parameters;
  if (!params) throw new Error('OpenSea returned no order parameters.');
  const p = { ...params };
  if (p.totalOriginalConsiderationItems === undefined) p.totalOriginalConsiderationItems = p.consideration.length;
  delete p.counter;
  return {
    parameters: p,
    numerator: 1,
    denominator: 1,
    signature: adv?.signature ?? order.signature,
    extraData: adv?.extraData ?? '0x',
  };
}
