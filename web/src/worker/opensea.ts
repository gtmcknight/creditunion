/// OpenSea → Sweeper. Finds the cheapest live listings that fit a batch and returns them as Seaport
/// AdvancedOrders the Sweeper contract can fill. OpenSea's key never leaves the Worker.
import type { Address } from 'viem';

const API = 'https://api.opensea.io/api/v2';
const PAGES = 5; // up to 500 listings scanned for filtered batches
const CONCURRENCY = 4;
const TAKE_CHUNK = 25; // listings per canTake call
/// Off-OpenSea listings (FWA, CreditStrategy) checked against a batch per scan, cheapest first. The strategy alone
/// holds thousands, and each chunk is a canTake call.
const EXTRA_CHECKS = 1_000;
const SEAPORT = '0x0000000000000068f116a894984e2db1123eb395';
/// OpenSea's conduit for its own conduit key; any other key is resolved through the ConduitController.
const OS_CONDUIT_KEY = '0x0000007b02230091a7ed01230072f7006a004d60a8d4e71d599b8104250f0000';
const OS_CONDUIT = '0x1e0049783f008a0085193e00003d00cd54003c71';
/// OpenSea's fee wallet: the one contract recipient a listing may pay.
const OS_FEES = '0x0000a26b00c1f0df003000390027140000faa719';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export type Source = 'opensea' | 'fwa' | 'strategy';
/// A listing that fits: on OpenSea (a Seaport order, by hash), on FWA's marketplace (by listing id) or held by
/// CreditStrategy (by Credit id).
export type Listing = { id: string; price: string; source: Source; hash?: string; protocol?: string; listingId?: string; seller?: string; until?: number };
/// A listing off OpenSea handed to the scan, just read on-chain: FWA (with its listing id) or CreditStrategy.
export type Extra = { id: string; price: string; source: 'fwa' | 'strategy'; listingId?: string };
type Cand = {
  id: string;
  price: bigint;
  source: Source;
  hash?: string;
  protocol?: string;
  listingId?: string;
  seller?: Address;
  operator?: Address | null;
  recipients?: Address[];
};
export type Quote = {
  orders: Json[]; // AdvancedOrder, ready for Sweeper.sweep
  ids: string[];
  prices: string[]; // wei, per listing
  total: string; // wei, sum of listings (fee not included)
  expires: number | null; // unix seconds when the earliest zone signature expires, null if unsigned
};

/// A second OpenSea key (secret OPENSEA_API_KEY_2), tried when the first is rate limited.
let spare: string | undefined;
export const setSpareKey = (k: string | undefined) => void (spare = k || undefined);

/// What a person sees when OpenSea says no (the raw status and body only go to the logs).
function osError(status: number) {
  if (status === 429) return 'OpenSea is busy right now. Try again in a minute.';
  if (status >= 500) return 'OpenSea isn’t answering right now. Try again in a minute.';
  if (status === 404) return 'That listing is no longer on OpenSea.';
  return 'OpenSea couldn’t fill this right now. Refresh and try again.';
}

async function os(key: string, path: string, init?: RequestInit): Promise<Json> {
  const go = (k: string) =>
    fetch(API + path, {
      ...init,
      headers: { accept: 'application/json', 'content-type': 'application/json', 'x-api-key': k, ...init?.headers },
    });
  let res = await go(key);
  if (res.status === 429 && spare && spare !== key) res = await go(spare);
  if (!res.ok) {
    const body = (await res.text()).slice(0, 200);
    if (res.status !== 404) console.warn(`[opensea] ${res.status} ${path.split('?')[0]}: ${body}`);
    // The status rides along (callers tell a missing listing from an outage by it); the message is for people.
    throw Object.assign(new Error(osError(res.status)), { status: res.status, body });
  }
  return res.json();
}

/// A listing we can fill: ETH only, one Credit, full fill, fixed price.
function usable(l: Json, credits: Address) {
  const p = l?.protocol_data?.parameters;
  const offer = p?.offer;
  if (!Array.isArray(offer) || offer.length !== 1) return null;
  const o = offer[0];
  if (Number(o.itemType) !== 2 || String(o.token).toLowerCase() !== credits.toLowerCase()) return null;
  if (String(o.startAmount) !== '1' || String(o.endAmount) !== '1') return null;
  if (String(l.protocol_address ?? '').toLowerCase() !== SEAPORT) return null; // the Sweeper speaks 1.6 only
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
    until: Number(p.endTime ?? 0) || 0,
    operator: operator as Address | null,
    recipients: p.consideration.map((c: Json) => String(c.recipient).toLowerCase() as Address),
  };
}

/// One Credit's cheapest usable listing, or null when it has none.
export async function best(key: string, slug: string, credits: Address, id: number): Promise<{ price: bigint; seller: Address; hash: string; protocol: string } | null> {
  let r: Json;
  try {
    r = await os(key, `/listings/collection/${slug}/nfts/${id}/best`);
  } catch (e) {
    if ((e as { status?: number }).status === 404) return null;
    throw e;
  }
  const l = usable(r, credits);
  return l && l.id === String(id) ? { price: l.price, seller: l.seller, hash: l.hash, protocol: l.protocol } : null;
}

/// One page of OpenSea's listings of the collection, cheapest first, as fillable listings (the checks `scan` makes
/// before a fill are left to the quote). `next`: OpenSea's cursor for the page after, empty at the end.
/// `trait`: only Credits with it, as OpenSea names it ({ traitType: 'Eights', value: 'Three' }).
export async function bestPage(key: string, slug: string, credits: Address, next = '', trait?: { traitType: string; value: string }): Promise<{ items: Listing[]; next: string }> {
  const q = `limit=100${trait ? `&traits=${encodeURIComponent(JSON.stringify([trait]))}` : ''}${next ? `&next=${encodeURIComponent(next)}` : ''}`;
  const r = await os(key, `/listings/collection/${slug}/best?${q}`);
  const items = ((r.listings ?? []) as Json[])
    .map((l) => usable(l, credits))
    .filter((c): c is NonNullable<typeof c> => !!c && !!c.operator)
    .map((c): Listing => ({ id: c.id, price: c.price.toString(), source: 'opensea', hash: c.hash, protocol: c.protocol, seller: c.seller, until: c.until }));
  return { items, next: String(r.next ?? '') };
}

/// The cheapest listings that fit, one per Credit, checked on-chain so a stale one cannot revert the sweep:
/// the seller still owns it and still has Seaport (or OpenSea's conduit) approved, and no consideration
/// goes to a contract other than OpenSea's fee wallet (a contract recipient could revert the whole fill).
/// `extra` listings (FWA, CreditStrategy) join in price order: each OpenSea page takes the ones priced within it,
/// and whatever is left joins once OpenSea runs out. With extras, an OpenSea outage (or no key) leaves those;
/// without them it throws as before.
export async function scan(o: {
  key?: string;
  slug: string;
  credits: Address;
  max: number;
  /// The batch's canTake: which of `ids` it would accept, booked in order (rules and, on a painted sheet, a
  /// free slot of each Credit's kind or an open one).
  take: (ids: bigint[]) => Promise<readonly boolean[]>;
  live: (id: bigint, seller: Address, operator: Address) => Promise<boolean>;
  hasCode: (a: Address) => Promise<boolean>;
  extra?: Extra[];
  /// Dev only: stand-in OpenSea listings instead of the API (they skip the on-chain liveness checks).
  fakeOpenSea?: { id: string; price: string }[];
}): Promise<Listing[]> {
  const picked: Listing[] = [];
  const seen = new Set<string>();
  const codeMemo = new Map<string, Promise<boolean>>();
  const isContract = (a: Address) => {
    if (a === OS_FEES) return Promise.resolve(false);
    if (!codeMemo.has(a)) codeMemo.set(a, o.hasCode(a).catch(() => true));
    return codeMemo.get(a)!;
  };
  const byPrice = (a: { price: bigint }, b: { price: bigint }) => (a.price < b.price ? -1 : a.price > b.price ? 1 : 0);
  let extras: Cand[] = (o.extra ?? []).map((e) => ({ id: e.id, price: BigInt(e.price), source: e.source, listingId: e.listingId })).sort(byPrice);
  let extraBudget = EXTRA_CHECKS;
  let osDone = !o.key && !o.fakeOpenSea;
  let next = '';
  for (let page = 0; picked.length < o.max && (!osDone || extras.length); page++) {
    let fresh: Cand[] = [];
    if (!osDone) {
      if (o.fakeOpenSea) {
        fresh = o.fakeOpenSea.map((f) => ({ id: f.id, price: BigInt(f.price), source: 'opensea' as const, hash: `0xfake${f.id}`, protocol: SEAPORT }));
        osDone = true;
      } else {
        let r: Json | null = null;
        try {
          r = await os(o.key!, `/listings/collection/${o.slug}/best?limit=100${next ? `&next=${encodeURIComponent(next)}` : ''}`);
        } catch (e) {
          if (!extras.length) throw e;
          console.warn('[scan] OpenSea unavailable, other markets only:', (e as Error).message.slice(0, 80));
        }
        fresh = ((r?.listings ?? []) as Json[])
          .map((l) => usable(l, o.credits))
          .filter((c): c is NonNullable<typeof c> => !!c && !!c.operator)
          .map((c) => ({ ...c, source: 'opensea' as const }));
        next = r?.next ?? '';
        if (!r || !next || page + 1 >= PAGES) osDone = true;
      }
    }
    // Extras priced within this page join it; the rest once OpenSea is done, up to the check budget.
    const top = fresh.reduce((m, c) => (c.price > m ? c.price : m), -1n);
    const join = (osDone ? extras : extras.filter((e) => e.price <= top)).slice(0, extraBudget);
    extraBudget -= join.length;
    extras = osDone ? [] : extras.filter((e) => e.price > top);
    fresh = [...join, ...fresh].filter((c) => !seen.has(c.id) && !!seen.add(c.id)).sort(byPrice);
    // Ask the batch in small chunks, with what's already picked booked first, so a painted sheet's slots fill in
    // price order and the scan keeps going past Credits it has no room for. Chunks keep each call's gas modest.
    // Enough that fit (with room for OpenSea ones failing liveness) ends the page early.
    const fits: boolean[] = [];
    for (let i = 0; i < fresh.length && picked.length + fits.filter(Boolean).length < o.max + TAKE_CHUNK; i += TAKE_CHUNK) {
      const chunk = fresh.slice(i, i + TAKE_CHUNK).map((c) => BigInt(c.id));
      const lead = picked.map((l) => BigInt(l.id)).concat(fresh.slice(0, i).filter((_, j) => fits[j]).map((c) => BigInt(c.id)));
      const ok = await o.take([...lead, ...chunk]).catch(() => null);
      fits.push(...chunk.map((_, j) => !!ok?.[lead.length + j]));
    }
    const ok = await Promise.all(
      fresh.map(async (c, i) => {
        // Cheapest first: most listings don't fit, so the liveness calls run only for those that do.
        if (!fits[i]) return false;
        // FWA and strategy listings are custodial and were just read on-chain; the dev stand-ins have nothing to check.
        if (c.source !== 'opensea' || o.fakeOpenSea) return true;
        const [live, contracts] = await Promise.all([
          o.live(BigInt(c.id), c.seller!, c.operator!).catch(() => false),
          Promise.all(c.recipients!.map(isContract)),
        ]);
        return live && !contracts.some(Boolean);
      }),
    );
    for (let i = 0; i < fresh.length && picked.length < o.max; i++) {
      if (!ok[i]) continue;
      const c = fresh[i];
      picked.push(
        c.source === 'opensea'
          ? { id: c.id, price: c.price.toString(), source: 'opensea', hash: c.hash, protocol: c.protocol }
          : { id: c.id, price: c.price.toString(), source: c.source, listingId: c.listingId },
      );
    }
  }
  picked.sort((a, b) => (BigInt(a.price) < BigInt(b.price) ? -1 : BigInt(a.price) > BigInt(b.price) ? 1 : 0));
  return picked;
}

/// Signed fill data for the `n` cheapest listings OpenSea will still fill (includes the zone signature its
/// restricted orders need). A listing can pass the on-chain liveness check yet be dead on OpenSea's side
/// (gasless cancel, superseded listing): those come back "Order not valid" and are skipped, and the next
/// cheapest takes their place. The Sweeper is named as the fulfiller: OpenSea's zone checks it against
/// Seaport's caller.
export async function quote(o: { key: string; sweeper: Address; listings: Listing[]; n: number; origin: string }): Promise<Quote> {
  if (!o.listings.length) throw new Error('No listings fit this batch right now.');
  const got: { l: Listing; order: Json }[] = [];
  let next = 0;
  let stale = false;
  let upstream: Error | null = null;
  const cache = caches.default;
  // Fill data is per listing and changes only when the listing does; a short cache means a burst of quotes
  // for the same batch costs OpenSea one call per listing, not one per quote.
  const fill = async (l: Listing): Promise<Json> => {
    const key = new Request(`${o.origin}/opensea/fill/${l.hash!}/${o.sweeper.toLowerCase()}`);
    const hit = await cache.match(key);
    if (hit) return hit.json();
    const r = await os(o.key, '/listings/fulfillment_data', {
      method: 'POST',
      body: JSON.stringify({
        listing: { hash: l.hash, chain: 'ethereum', protocol_address: l.protocol },
        fulfiller: { address: o.sweeper },
      }),
    });
    await cache.put(key, Response.json(r, { headers: { 'cache-control': 'public, max-age=20' } }));
    return r;
  };
  while (got.length < o.n && next < o.listings.length && !upstream) {
    const want = o.listings.slice(next, next + Math.min(CONCURRENCY, o.n - got.length));
    next += want.length;
    const results = await Promise.all(
      want.map(async (l) => {
        try {
          return { l, order: toAdvanced(await fill(l)) };
        } catch (e) {
          const err = e as Error;
          // "Order not valid" (400) is a dead listing, and a malformed fill is skipped the same way; a rate
          // limit or outage stops the walk, and what was already collected is still a valid quote.
          if ((e as { status?: number }).status === 400 || /no order parameters/.test(err.message)) stale = true;
          else upstream = err;
          return null;
        }
      }),
    );
    for (const r of results) if (r) got.push(r);
  }
  if (!got.length) {
    if (upstream) throw upstream;
    throw new Error(stale ? 'The listings that fit just went stale on OpenSea. Try again in a moment.' : 'No listings fit this batch right now.');
  }
  const expiries = got.map((g) => zoneExpiry(String(g.order.extraData ?? '0x'))).filter((e): e is number => e !== null);
  return {
    orders: got.map((g) => g.order),
    ids: got.map((g) => g.l.id),
    prices: got.map((g) => g.l.price),
    total: got.reduce((a, g) => a + BigInt(g.l.price), 0n).toString(),
    expires: expiries.length ? Math.min(...expiries) : null,
  };
}

/// SIP-7 signed-zone extraData: 1 byte version, 64-byte signature, then a uint64 expiration (unix seconds).
/// OpenSea signs fills for about 90 s; past that the zone rejects the order and the sweep would revert.
function zoneExpiry(extraData: string): number | null {
  const hex = extraData.replace(/^0x/, '');
  if (hex.length < (1 + 64 + 8) * 2 || hex.slice(0, 2) !== '00') return null;
  const exp = parseInt(hex.slice(130, 146), 16);
  return Number.isFinite(exp) && exp > 1_600_000_000 ? exp : null;
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

/// What happened to the collection since `after` (unix seconds): new listings, and Credits that left an address
/// (a sale or any transfer). Newest first from OpenSea; read back to `after`, `pages` at most.
export async function events(key: string, slug: string, credits: Address, after: number, pages = 10) {
  // In the order they happened (OpenSea sends newest first): a relist after a listing must win over it.
  const ops: ({ t: number; listed: Listing } | { t: number; gone: { id: string; from: string } })[] = [];
  let newest = after, next = '';
  for (let pg = 0; pg < pages; pg++) {
    const r = await os(key, `/events/collection/${slug}?event_type=listing&event_type=sale&event_type=transfer&after=${after}&limit=50${next ? `&next=${encodeURIComponent(next)}` : ''}`);
    for (const e of (r.asset_events ?? []) as Json[]) {
      newest = Math.max(newest, Number(e.event_timestamp) || 0);
      const nft = e.asset ?? e.nft;
      if (String(nft?.contract ?? '').toLowerCase() !== credits.toLowerCase()) continue;
      const id = String(nft.identifier);
      if (e.event_type === 'order' && e.order_type === 'listing') {
        // A plain ETH listing of one Credit through Seaport 1.6, open to anyone, not expired: what the Sweeper fills.
        if (e.is_private_listing || Number(e.quantity) !== 1) continue;
        if (String(e.payment?.token_address ?? '') !== '0x0000000000000000000000000000000000000000') continue;
        if (String(e.protocol_address ?? '').toLowerCase() !== SEAPORT) continue;
        const until = Number(e.expiration_date) || 0;
        if (until && until <= Date.now() / 1000) continue;
        ops.push({ t: Number(e.event_timestamp) || 0, listed: { id, price: String(e.payment.quantity), source: 'opensea', hash: String(e.order_hash), protocol: String(e.protocol_address), seller: String(e.maker ?? '').toLowerCase(), until } });
      } else if (e.event_type === 'sale') ops.push({ t: Number(e.event_timestamp) || 0, gone: { id, from: String(e.seller ?? '').toLowerCase() } });
      else if (e.event_type === 'transfer') ops.push({ t: Number(e.event_timestamp) || 0, gone: { id, from: String(e.from_address ?? '').toLowerCase() } });
    }
    next = String(r.next ?? '');
    const oldest = Math.min(...((r.asset_events ?? []) as Json[]).map((e) => Number(e.event_timestamp) || Infinity));
    if (!next || oldest < after) break;
  }
  // OpenSea's newest-first order, reversed, then sorted by time (a stable sort): same-second events stay in order.
  return { ops: ops.reverse().sort((a, b) => a.t - b.t), newest };
}
