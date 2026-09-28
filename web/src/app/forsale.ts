import { sweeperAbi } from './abi';
import { config, pub, send, session } from './chain';
import { editionArt } from './ghosts';
import { creditCell } from './views/trait';
import { boughtToast, errText, esc, rangeHtml, setRange, toast } from './ui';

/// Where a listing is: its marketplace's name and mark (Buy tab, Credit pages, For sale rows).
export type Source = 'opensea' | 'fwa' | 'strategy';
export const SOURCES: Record<Source, { name: string; icon: string }> = {
  opensea: { name: 'OpenSea', icon: '/sources/opensea.svg' },
  fwa: { name: 'FWA', icon: '/sources/fwa.png' },
  strategy: { name: 'CreditStrategy', icon: '/sources/strategy.svg' },
};

/// Credits this browser just bought. Listings are cached (60 s here, longer at the marketplaces), so a sold Credit
/// can still come back listed for a while; a fresh page leaves these out until the listings catch up. (On the page
/// that bought them they stay in place and read "Yours".)
const BOUGHT_KEY = 'cu-bought';
const BOUGHT_FOR = 15 * 60_000;
const boughtAt = (): Record<string, number> => {
  try {
    const all = JSON.parse(sessionStorage.getItem(BOUGHT_KEY) ?? '{}') as Record<string, number>;
    return Object.fromEntries(Object.entries(all).filter(([, t]) => Date.now() - t < BOUGHT_FOR));
  } catch {
    return {};
  }
};
export const justBought = (id: string | number) => String(id) in boughtAt();
export function rememberBought(ids: (string | number)[]) {
  const all = boughtAt();
  for (const id of ids) all[String(id)] = Date.now();
  try {
    sessionStorage.setItem(BOUGHT_KEY, JSON.stringify(all));
  } catch {}
}

// ERC-721 Transfer(address indexed from, address indexed to, uint256 indexed tokenId)
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

export const minEth = (wei: bigint) => (Number(wei) / 1e18).toFixed(4).replace(/\.?0+$/, '');

/// The mark before a price, linking to the listing on its marketplace.
export const sourceMark = (id: string | number, source: Source, url?: string) =>
  `<a class="src" href="${esc(url ?? '#')}" target="_blank" rel="noopener" title="Credit #${id} on ${SOURCES[source].name}"><img class="src" src="${SOURCES[source].icon}" alt="${SOURCES[source].name}"></a>`;

type Listed = { id: string; price: string; source: Source; url?: string; hash?: string; protocol?: string; listingId?: string };

/// The most one buy takes, on every Buy (the worker's quote allows as many).
export const MAX_SWEEP = 24;

/// Every Buy the same: a slider for how many, with the count beside it (the button can't always say it: signed out
/// it asks to connect), then what the wallet will ask, fee in (sweepTotal fills it). On phones the slider takes its
/// own line. `key` names the parts: #<key>-n, #<key>-total.
export const sweepRow = (key: string, min: number, max: number, value: number) =>
  `${rangeHtml(`${key}-n`, min, max, value)}<span class="sweep-total num" id="${key}-total"></span>`;
export const sweepTotal = (sum: bigint, bps: bigint, n: number, hint = '') =>
  n
    ? `<span>${(Number(sum + (sum * bps) / 10_000n) / 1e18).toFixed(4)} ETH</span>${bps ? `<span class="muted small">incl. ${Number(bps) / 100}% fee</span>` : ''}`
    : hint && `<span class="muted">${hint}</span>`;
/// Signed out, every Buy button connects first.
export const connectToBuy = (block = false) => `<button class="btn primary${block ? ' block' : ''}" data-connect>Connect to buy</button>`;
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
  const show = sale.all.slice(0, 8);
  el.innerHTML = `<div class="jb-controls static"><h2 class="jb-buy">Buy Credits</h2><div class="jb-sweep" id="fs-act"></div></div>
    <div class="trait-grid" id="fs-grid">${show.map((l) => (sale.mine.has(l.id) ? creditCell(Number(l.id), YOURS) : creditCell(Number(l.id), priceTag(l)))).join('')}</div>
    <p class="jb-line"><a class="jb-link" href="/palette">Every Credit for sale, cheapest first →</a></p>`;
  sweepControls(el.querySelector<HTMLElement>('#fs-act')!, { ...sale, ls: show.filter((l) => !sale.mine.has(l.id)) }, el.querySelector<HTMLElement>('#fs-grid')!);
  el.hidden = false;
}

/// `ls`/`byId`: what can be bought. `all`: the listings in grid order, including `mine`, bought on this page.
export type Sale = { ls: Listed[]; preview: boolean; byId: Map<string, Listed>; all: Listed[]; mine: Set<string> };

/// Where a bought Credit's price was.
export const YOURS = '<span class="cc-price yours">Yours</span>';

/// Every Credit listed anywhere (of one trait, `palette/K`, or within rules like { minScore, maxScore }), cheapest first, paged in from /opensea/listed as asked
/// for. A Credit listed more than once keeps its cheapest. `sale.ls` is the same list, for Sweep.
export function listedPager(where: { trait?: string; rules?: Record<string, number> } = {}) {
  const items: Listed[] = []; // the grid's order, just-bought included
  const sale: Sale = { ls: [], preview: true, byId: new Map(), all: items, mine: new Set() };
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
          if (!SOURCES[l.source] || sale.byId.has(l.id) || sale.mine.has(l.id) || justBought(l.id)) continue;
          items.push(l);
          sale.byId.set(l.id, l);
          sale.ls.push(l);
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
    const ls = (d.listings ?? []).filter((l) => SOURCES[l.source] && !justBought(l.id));
    return ls.length ? { ls, preview: !!d.preview, byId: new Map(ls.map((l) => [l.id, l])), all: [...ls], mine: new Set() } : null;
  } catch {
    return null;
  }
}

/// A listed Credit's price under its number: the marketplace's mark, then the price. `up`: it rose since the page
/// loaded (a union's Buy stopped on it), shown in red.
export const priceTag = (l: Listed, up = false) =>
  `<span class="cc-price num${up ? ' up' : ''}" title="On ${SOURCES[l.source].name}"><img class="src" src="${SOURCES[l.source].icon}" alt="${SOURCES[l.source].name}">${minEth(BigInt(l.price))}</span>`;

/// Sweep: drag the slider to take the cheapest that many (up to MAX_SWEEP), or tap listed Credits' squares to pick
/// them one by one. The picked are outlined in `grid` wherever they are; the button carries their total.
/// `mark()` re-outlines after the grid changes (and lets the slider reach listings that paged in since).
export function sweepControls(host: HTMLElement, sale: Sale, grid: HTMLElement) {
  // Nothing picked to start: drag, or tap Credits.
  const picked = new Set<string>();
  // The price sits between the slider and the button and moves as you drag; the button carries the count.
  const signedOut = canBuy(sale.preview) && !session.account;
  host.classList.add('buy-row');
  host.innerHTML = `${sweepRow('sale', 0, Math.min(MAX_SWEEP, sale.ls.length), 0)}${signedOut ? connectToBuy() : `<button class="btn primary" id="sale-go"${canBuy(sale.preview) ? '' : ' disabled title="Mainnet prices, shown as a preview"'}>Buy</button>`}`;
  const totalEl = host.querySelector<HTMLElement>('#sale-total')!;
  const range = host.querySelector<HTMLInputElement>('#sale-n')!;
  const go = host.querySelector<HTMLButtonElement>('#sale-go');
  const chosen = () => sale.ls.filter((l) => picked.has(l.id)); // in price order
  go?.addEventListener('click', async () => {
    if (!picked.size) return;
    const mine = [...picked];
    const cells = () => mine.map((id) => grid.querySelector<HTMLElement>(`.cc[data-id="${id}"]`)).filter((c): c is HTMLElement => !!c);
    const got = await sweepToWallet(chosen(), go, () => cells().forEach((c) => c.classList.add('buying')));
    cells().forEach((c) => c.classList.remove('buying'));
    if (!got) return;
    // Bought: off the market here at once. Each square drops its price and says it's yours.
    for (const id of got) {
      sale.mine.add(id);
      sale.byId.delete(id);
      const i = sale.ls.findIndex((l) => l.id === id);
      if (i >= 0) sale.ls.splice(i, 1);
      const c = grid.querySelector<HTMLElement>(`.cc[data-id="${id}"]`);
      if (!c) continue;
      c.classList.remove('listed', 'sel');
      c.classList.add('got'); // a small pop as it becomes yours
      c.querySelector('.cc-art')?.removeAttribute('title');
      c.querySelector('.cc-price')?.insertAdjacentHTML('afterend', YOURS);
      c.querySelector('.cc-price:not(.yours)')?.remove();
    }
    picked.clear();
    mark();
  });
  let bps = DEFAULT_FEE_BPS;
  void sweepFee().then((b) => {
    bps = b;
    mark();
  });
  const mark = () => {
    setRange(range, picked.size, Math.min(MAX_SWEEP, sale.ls.length));
    grid.querySelectorAll<HTMLElement>('.cc').forEach((c) => c.classList.toggle('sel', picked.has(c.dataset.id!)));
    // What the wallet will ask: the listings plus the Sweeper's fee (sweepToWallet reads the exact quote on click).
    totalEl.innerHTML = sweepTotal(chosen().reduce((a, l) => a + BigInt(l.price), 0n), bps, picked.size, 'Drag or tap Credits');
    if (!go) return;
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
/// Resolves to the ids bought, or null if nothing was.
/// `onSubmit` runs once the wallet has sent it (the Credits' squares start their buying pulse then).
export async function sweepToWallet(picked: Listed[], btn: HTMLButtonElement, onSubmit?: () => void): Promise<string[] | null> {
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
    btn.textContent = 'Confirm in wallet';
    const receipt = await send(
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
        btn.classList.add('busy');
        btn.textContent = 'Buying';
        onSubmit?.();
      },
    );
    btn.classList.remove('busy');
    // What actually landed: the Credits transferred to this wallet in the receipt, not what was quoted (a listing
    // can sell to someone else between the quote and the block).
    const me = session.account!.toLowerCase();
    const got = receipt.logs
      .filter((l) => l.address.toLowerCase() === config.credits.toLowerCase() && l.topics[0] === TRANSFER && l.topics.length === 4 && `0x${l.topics[2]!.slice(26)}` === me)
      .map((l) => BigInt(l.topics[3]!).toString());
    const missed = picked.length - got.length;
    boughtToast(got, missed > 0 ? `${missed} sold before you got to ${missed === 1 ? 'it' : 'them'}.` : '');
    rememberBought(got);
    return got;
  } catch (e) {
    toast(errText(e), 'err', 8000);
    btn.classList.remove('busy');
    btn.disabled = false;
    btn.textContent = label;
    return null;
  }
}
