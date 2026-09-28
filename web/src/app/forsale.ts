import { sweeperAbi } from './abi';
import { config, pub, send } from './chain';
import { editionArt } from './ghosts';
import { creditCell } from './views/trait';
import { errText, esc, rangeHtml, setRange, toast } from './ui';

/// Where a listing is: its marketplace's name and mark (Buy tab, Credit pages, For sale rows).
export type Source = 'opensea' | 'fwa' | 'strategy';
export const SOURCES: Record<Source, { name: string; icon: string }> = {
  opensea: { name: 'OpenSea', icon: '/sources/opensea.svg' },
  fwa: { name: 'FWA', icon: '/sources/fwa.png' },
  strategy: { name: 'CreditStrategy', icon: '/sources/strategy.svg' },
};

export const minEth = (wei: bigint) => (Number(wei) / 1e18).toFixed(4).replace(/\.?0+$/, '');

/// The mark before a price, linking to the listing on its marketplace.
export const sourceMark = (id: string | number, source: Source, url?: string) =>
  `<a class="src" href="${esc(url ?? '#')}" target="_blank" rel="noopener" title="Credit #${id} on ${SOURCES[source].name}"><img class="src" src="${SOURCES[source].icon}" alt="${SOURCES[source].name}"></a>`;

type Listed = { id: string; price: string; source: Source; url?: string; hash?: string; protocol?: string; listingId?: string };

/// The most one sweep takes (the worker's quote allows as many).
const MAX_SWEEP = 24;
/// Buying runs where the Sweeper is deployed (mainnet); elsewhere the prices are mainnet's, as a preview.
const canBuy = (preview?: boolean) => !preview && !!config.sweeper;
/// The Sweeper's fee on every buy, read once, so the price says it before the wallet does. Where there's no
/// Sweeper (testnets) it's the 2% mainnet deploys with, so the preview prices match what mainnet will charge.
const DEFAULT_FEE_BPS = 200n;
let feeBps: Promise<bigint> | null = null;
export const sweepFee = () =>
  (feeBps ??= config.sweeper
    ? (pub.readContract({ address: config.sweeper, abi: sweeperAbi, functionName: 'feeBps' }) as Promise<bigint>).catch(() => DEFAULT_FEE_BPS)
    : Promise.resolve(DEFAULT_FEE_BPS));

/// /credits: the eight cheapest Credits for sale anywhere, laid out like a trait page's grid with the same Buy row
/// (tap to pick, or 1 / 5 / 10), and a way through to all of them. It replaces the page's skeleton of the same
/// shape, so nothing moves when it lands; nothing listed hides it.
export async function drawForSale(el: HTMLElement) {
  const sale = await loadSale();
  if (!el.isConnected) return;
  if (!sale) return void (el.hidden = true); // nothing listed: the skeleton goes
  const show = sale.ls.slice(0, 8);
  el.innerHTML = `<div class="jb-controls static"><h2 class="jb-buy">Buy Credits</h2><div class="jb-sweep" id="fs-act"></div></div>
    <div class="trait-grid" id="fs-grid">${show.map((l) => creditCell(Number(l.id), priceTag(l))).join('')}</div>
    <p class="jb-line"><a class="jb-link" href="/palette">Every Credit for sale, cheapest first →</a></p>`;
  sweepControls(el.querySelector<HTMLElement>('#fs-act')!, { ...sale, ls: show }, el.querySelector<HTMLElement>('#fs-grid')!);
  el.hidden = false;
}

export type Sale = { ls: Listed[]; preview: boolean; byId: Map<string, Listed> };

/// Every Credit listed anywhere (of one trait, `palette/K`, or within rules like { minScore, maxScore }), cheapest first, paged in from /opensea/listed as asked
/// for. A Credit listed more than once keeps its cheapest. `sale.ls` is the same list, for Sweep.
export function listedPager(where: { trait?: string; rules?: Record<string, number> } = {}) {
  const items: Listed[] = [];
  const sale: Sale = { ls: items, preview: true, byId: new Map() };
  let cursor: string | null = '';
  const self = {
    items,
    sale,
    done: false,
    /// Pages in until at least `n` are in hand, or there are no more (at most `calls` requests).
    async fill(n: number, most = 20) {
      for (let calls = 0; items.length < n && cursor !== null && calls < most; calls++) {
        const qs = new URLSearchParams();
        if (where.trait) qs.set('trait', where.trait);
        if (where.rules) qs.set('rules', JSON.stringify(where.rules));
        if (cursor) qs.set('c', cursor);
        const res = await fetch(`/opensea/listed?${qs}`);
        if (!res.ok) break;
        const d = (await res.json()) as { items?: Listed[]; next?: string | null; preview?: boolean; error?: string };
        if (d.error) break;
        sale.preview = !!d.preview;
        for (const l of d.items ?? []) {
          if (!SOURCES[l.source] || sale.byId.has(l.id)) continue;
          sale.byId.set(l.id, l);
          items.push(l);
        }
        cursor = d.next ?? null;
      }
      self.done = cursor === null;
    },
  };
  return self;
}

/// The cheapest Credits for sale of one trait (`palette/K`), or null when none are or they can't be read.
export async function loadSale(trait?: string): Promise<Sale | null> {
  try {
    const res = await fetch(`/opensea/forsale${trait ? `?trait=${encodeURIComponent(trait)}` : ''}`);
    if (!res.ok) return null;
    const d = (await res.json()) as { listings?: Listed[]; preview?: boolean };
    const ls = (d.listings ?? []).filter((l) => SOURCES[l.source]);
    return ls.length ? { ls, preview: !!d.preview, byId: new Map(ls.map((l) => [l.id, l])) } : null;
  } catch {
    return null;
  }
}

/// A listed Credit's price under its number: the marketplace's mark, then the price.
export const priceTag = (l: Listed) =>
  `<span class="cc-price num" title="On ${SOURCES[l.source].name}"><img class="src" src="${SOURCES[l.source].icon}" alt="${SOURCES[l.source].name}">${minEth(BigInt(l.price))}</span>`;

/// Sweep: drag the slider to take the cheapest that many (up to MAX_SWEEP), or tap listed Credits' squares to pick
/// them one by one. The picked are outlined in `grid` wherever they are; the button carries their total.
/// `mark()` re-outlines after the grid changes (and lets the slider reach listings that paged in since).
export function sweepControls(host: HTMLElement, sale: Sale, grid: HTMLElement) {
  // Nothing picked to start: drag, or tap Credits.
  const picked = new Set<string>();
  // The price sits between the slider and the button and moves as you drag; the button carries the count.
  host.innerHTML = `<span class="muted">Sweep</span>${rangeHtml('sale-n', 0, Math.min(MAX_SWEEP, sale.ls.length), 0, false)}<span class="sweep-total num" id="sale-total"></span><button class="btn primary" id="sale-go"${canBuy(sale.preview) ? '' : ' disabled title="Mainnet prices, shown as a preview"'}>Buy</button>`;
  const totalEl = host.querySelector<HTMLElement>('#sale-total')!;
  const range = host.querySelector<HTMLInputElement>('#sale-n')!;
  const go = host.querySelector<HTMLButtonElement>('#sale-go')!;
  const chosen = () => sale.ls.filter((l) => picked.has(l.id)); // in price order
  go.addEventListener('click', () => picked.size && void sweepToWallet(chosen(), go));
  let bps = DEFAULT_FEE_BPS;
  void sweepFee().then((b) => {
    bps = b;
    mark();
  });
  const mark = () => {
    setRange(range, picked.size, Math.min(MAX_SWEEP, sale.ls.length));
    grid.querySelectorAll<HTMLElement>('.cc').forEach((c) => c.classList.toggle('sel', picked.has(c.dataset.id!)));
    // What the wallet will ask: the listings plus the Sweeper's fee (sweepToWallet reads the exact quote on click).
    const total = chosen().reduce((a, l) => a + BigInt(l.price), 0n);
    const pay = total + (total * bps) / 10_000n;
    totalEl.innerHTML = picked.size
      ? `<span>${(Number(pay) / 1e18).toFixed(4)} ETH</span>${bps ? `<span class="muted small">incl. ${Number(bps) / 100}% fee</span>` : ''}`
      : '<span class="muted">Drag or tap Credits</span>';
    go.textContent = picked.size ? `Buy ${picked.size}` : 'Buy';
    if (!sale.preview && config.sweeper) go.disabled = !picked.size;
  };
  range.addEventListener('input', () => {
    picked.clear();
    for (const l of sale.ls.slice(0, Number(range.value))) picked.add(l.id);
    mark();
  });
  // A listed Credit's square picks or unpicks it; its number still opens its page. The slider follows the count.
  grid.addEventListener('click', (e) => {
    const art = (e.target as HTMLElement).closest('.cc-art');
    const id = art?.closest<HTMLElement>('.cc')?.dataset.id;
    if (!id || !sale.byId.has(id)) return;
    e.preventDefault();
    if (picked.has(id)) picked.delete(id);
    else if (picked.size >= MAX_SWEEP) return toast(`Up to ${MAX_SWEEP} in one sweep.`, 'info');
    else picked.add(id);
    mark();
  });
  mark();
  return { mark };
}

/// OpenSea listings come as signed orders (orders/ids/prices); FWA listings by listing id and price; CreditStrategy's
/// by Credit id and price. `total` is all of them.
export type Quote = {
  orders: unknown[];
  ids: string[];
  prices: string[];
  total: string;
  expires?: number | null;
  fwa?: { listingId: string; id: string; price: string }[];
  strategy?: { id: string; price: string }[];
  error?: string;
};

/// The orders are what gets sent to the chain; the ids/prices/total are what gets shown. Make sure they agree,
/// so a bad quote (or a tampered one) can't show ten Credits and buy one.
export function checkQuote(q: Quote) {
  type Order = { parameters?: { offer?: { token?: string; identifierOrCriteria?: string; itemType?: number }[]; consideration?: { itemType?: number; startAmount?: string; endAmount?: string }[] } };
  const orders = q.orders as Order[];
  if (!Array.isArray(orders) || orders.length !== q.ids.length || q.prices.length !== q.ids.length) throw new Error('Bad quote.');
  let sum = 0n;
  orders.forEach((o, i) => {
    const offer = o.parameters?.offer ?? [];
    const cons = o.parameters?.consideration ?? [];
    if (offer.length !== 1 || Number(offer[0].itemType) !== 2 || String(offer[0].identifierOrCriteria) !== q.ids[i]) throw new Error('Bad quote.');
    if (String(offer[0].token).toLowerCase() !== config.credits.toLowerCase()) throw new Error('Bad quote.');
    const price = cons.reduce((a, c) => {
      if (Number(c.itemType) !== 0 || c.startAmount !== c.endAmount) throw new Error('Bad quote.');
      return a + BigInt(c.endAmount ?? '0');
    }, 0n);
    if (price !== BigInt(q.prices[i])) throw new Error('Bad quote.');
    sum += price;
  });
  for (const f of q.fwa ?? []) {
    if (!/^\d+$/.test(f.listingId) || !/^\d+$/.test(f.id) || !/^\d+$/.test(f.price)) throw new Error('Bad quote.');
    sum += BigInt(f.price);
  }
  for (const f of q.strategy ?? []) {
    if (!/^\d+$/.test(f.id) || !/^\d+$/.test(f.price)) throw new Error('Bad quote.');
    sum += BigInt(f.price);
  }
  if (sum !== BigInt(q.total)) throw new Error('Bad quote.');
}

/// Sweep these listings into the connected wallet (Sweeper.buy): a fresh price for exactly them, checked
/// against what it shows, the fee read now, then one transaction. Credits sold since drop out of the price.
export async function sweepToWallet(picked: Listed[], btn: HTMLButtonElement) {
  const label = btn.textContent ?? '';
  btn.disabled = true;
  btn.textContent = 'Pricing…';
  try {
    const r = await fetch('/opensea/buyquote', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ listings: picked }) });
    const q = (await r.json()) as Quote;
    if (!r.ok || q.error) throw new Error(q.error ?? 'No price right now.');
    checkQuote(q);
    const total = BigInt(q.total);
    const [value, feeBps] = (await Promise.all([
      pub.readContract({ address: config.sweeper!, abi: sweeperAbi, functionName: 'quote', args: [total] }),
      pub.readContract({ address: config.sweeper!, abi: sweeperAbi, functionName: 'feeBps' }),
    ])) as [bigint, bigint];
    const n = q.ids.length + (q.fwa?.length ?? 0) + (q.strategy?.length ?? 0);
    btn.textContent = 'Confirm…'; // in the wallet
    await send(
      {
        address: config.sweeper!,
        abi: sweeperAbi,
        functionName: 'buy',
        args: [
          q.orders,
          (q.fwa ?? []).map((f) => ({ listingId: BigInt(f.listingId), price: BigInt(f.price) })),
          (q.strategy ?? []).map((f) => ({ tokenId: BigInt(f.id), price: BigInt(f.price) })),
          1n,
          feeBps,
        ],
        value,
      },
      () => {
        btn.textContent = 'Buying…';
      },
    );
    toast(`${n} ${n === 1 ? 'Credit is' : 'Credits are'} yours.${n < picked.length ? ` ${picked.length - n} sold before you got to them.` : ''}`, 'ok', 8000);
    btn.textContent = 'Bought';
  } catch (e) {
    toast(errText(e), 'err', 8000);
    btn.disabled = false;
    btn.textContent = label;
  }
}
