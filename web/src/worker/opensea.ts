/// OpenSea → Sweeper. Finds the cheapest live listings that fit a batch and returns them as Seaport
/// AdvancedOrders the Sweeper contract can fill. OpenSea's key never leaves the Worker.
import type { Address } from 'viem';

const API = 'https://api.opensea.io/api/v2';
const PAGES = 5; // up to 500 listings scanned for filtered batches
const CONCURRENCY = 4;
const SEAPORT = '0x0000000000000068f116a894984e2db1123eb395';
/// OpenSea's conduit for its own conduit key; any other key is resolved through the ConduitController.
const OS_CONDUIT_KEY = '0x0000007b02230091a7ed01230072f7006a004d60a8d4e71d599b8104250f0000';
const OS_CONDUIT = '0x1e0049783f008a0085193e00003d00cd54003c71';
/// OpenSea's fee wallet: the one contract recipient a listing may pay.
const OS_FEES = '0x0000a26b00c1f0df003000390027140000faa719';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export type Listing = { id: string; price: string; hash: string; protocol: string };
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

/// A listing we can fill: ETH only, one Credit, full fill, fixed price.
function usable(l: Json, credits: Address) {
  const p = l?.protocol_data?.parameters;
  const offer = p?.offer;
  if (!Array.isArray(offer) || offer.length !== 1) return null;
  const o = offer[0];
  if (Number(o.itemType) !== 2 || String(o.token).toLowerCase() !== credits.toLowerCase()) return null;
  if (!Array.isArray(p.consideration) || p.consideration.some((c: Json) => Number(c.itemType) !== 0)) return null;
  if (p.consideration.some((c: Json) => c.startAmount !== c.endAmount)) return null; // no dutch auctions
  const total = p.consideration.reduce((a: bigint, c: Json) => a + BigInt(c.endAmount), 0n);
  const key = String(p.conduitKey ?? '').toLowerCase();
  const operator = key === OS_CONDUIT_KEY ? OS_CONDUIT : /^0x0+$/.test(key) ? SEAPORT : null;
  return {
    id: String(o.identifierOrCriteria),
    price: total,
    hash: String(l.order_hash),
    protocol: String(l.protocol_address),
    seller: String(p.offerer).toLowerCase() as Address,
    operator: operator as Address | null,
    recipients: p.consideration.map((c: Json) => String(c.recipient).toLowerCase() as Address),
  };
}

/// The cheapest listings that fit, one per Credit, checked on-chain so a stale one cannot revert the sweep:
/// the seller still owns it and still has Seaport (or OpenSea's conduit) approved, and no consideration
/// goes to a contract other than OpenSea's fee wallet (a contract recipient could revert the whole fill).
export async function scan(o: {
  key: string;
  slug: string;
  credits: Address;
  max: number;
  passes: (id: bigint) => Promise<boolean>;
  live: (id: bigint, seller: Address, operator: Address) => Promise<boolean>;
  hasCode: (a: Address) => Promise<boolean>;
}): Promise<Listing[]> {
  const picked: Listing[] = [];
  const seen = new Set<string>();
  const codeMemo = new Map<string, Promise<boolean>>();
  const isContract = (a: Address) => {
    if (a === OS_FEES) return Promise.resolve(false);
    if (!codeMemo.has(a)) codeMemo.set(a, o.hasCode(a).catch(() => true));
    return codeMemo.get(a)!;
  };
  let next = '';
  for (let page = 0; page < PAGES && picked.length < o.max; page++) {
    const r = await os(o.key, `/listings/collection/${o.slug}/best?limit=100${next ? `&next=${encodeURIComponent(next)}` : ''}`);
    const fresh = ((r.listings ?? []) as Json[])
      .map((l) => usable(l, o.credits))
      .filter((c): c is NonNullable<typeof c> => !!c && !!c.operator && !seen.has(c.id) && !!seen.add(c.id));
    const ok = await Promise.all(
      fresh.map(async (c) => {
        const [fits, live, contracts] = await Promise.all([
          o.passes(BigInt(c.id)).catch(() => false),
          o.live(BigInt(c.id), c.seller, c.operator!).catch(() => false),
          Promise.all(c.recipients.map(isContract)),
        ]);
        return fits && live && !contracts.some(Boolean);
      }),
    );
    for (let i = 0; i < fresh.length && picked.length < o.max; i++) {
      if (ok[i]) picked.push({ id: fresh[i].id, price: fresh[i].price.toString(), hash: fresh[i].hash, protocol: fresh[i].protocol });
    }
    next = r.next;
    if (!next) break;
  }
  picked.sort((a, b) => (BigInt(a.price) < BigInt(b.price) ? -1 : BigInt(a.price) > BigInt(b.price) ? 1 : 0));
  return picked;
}

/// Signed fill data for each listing (includes the zone signature OpenSea's restricted orders need).
/// The Sweeper is named as the fulfiller: OpenSea's zone checks it against Seaport's caller.
export async function quote(o: { key: string; sweeper: Address; listings: Listing[] }): Promise<Quote> {
  if (!o.listings.length) throw new Error('No listings fit this batch right now.');
  const orders: Json[] = new Array(o.listings.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (i < o.listings.length) {
        const k = i++;
        const l = o.listings[k];
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
    ids: o.listings.map((p) => p.id),
    prices: o.listings.map((p) => p.price),
    total: o.listings.reduce((a, p) => a + BigInt(p.price), 0n).toString(),
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
