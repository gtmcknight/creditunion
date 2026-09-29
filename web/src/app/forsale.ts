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

export type Listed = { id: string; price: string; source: Source; url?: string; hash?: string; protocol?: string; listingId?: string };

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

/// Buys in flight on this page (a price being checked, or the wallet open): live views hold still till they're done.
export const buying = { n: 0 };

/// How often a live view reads its listings again.
const LIVE_MS = 20_000;

/// Keeps a view of listings live, the way a marketplace's own page is: `tick` every LIVE_MS while the page is in
/// front (and at once on coming back to it after longer), one at a time, and none while a buy is in flight or a
/// slider is held. A pointer moving over `el` (on its way to a tap) puts it off a moment, so nothing moves under it.
/// Stops for good once `el` has left the page.
export function live(el: HTMLElement, tick: () => Promise<void>) {
  let running = false;
  let last = Date.now();
  let touched = 0;
  let again: ReturnType<typeof setTimeout> | null = null;
  const near = () => (touched = Date.now());
  el.addEventListener('pointermove', near, { passive: true });
  el.addEventListener('pointerdown', near, { passive: true });
  const run = async () => {
    if (!el.isConnected) return stop();
    if (running || document.hidden || buying.n || document.querySelector('.sweep-range input:active')) return;
    if (Date.now() - touched < 1500) {
      again ??= setTimeout(() => {
        again = null;
        void run();
      }, 2000);
      return;
    }
    running = true;
    last = Date.now();
    try {
      await tick();
    } catch (e) {
      console.warn('[live]', e);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void run(), LIVE_MS);
  const back = () => {
    if (!document.hidden && Date.now() - last >= LIVE_MS) void run();
  };
  const stop = () => {
    clearInterval(timer);
    if (again) clearTimeout(again);
    document.removeEventListener('visibilitychange', back);
  };
  document.addEventListener('visibilitychange', back);
}

/// Ease-out for tiles that move or arrive (leaving is quicker, and eases in).
const EASE = 'cubic-bezier(0.23, 1, 0.32, 1)';
const fromHtml = (html: string) => {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild as HTMLElement;
};

/// Brings `grid`'s listed run (its tiles for sale, and any just bought here) to `next`, cheapest first, the way a
/// marketplace's live page moves: a Credit that left the market fades out where it stood, a new listing fades in at
/// its place, a changed price takes the old one's place, and every tile that shifts glides to where it lands. Tiles
/// of Credits not for sale keep their order behind the run. Off screen (or with reduced motion) things just move.
/// Returns the ids that left.
export function reflow(grid: HTMLElement, next: Listed[], cell: (l: Listed) => string): string[] {
  const motion = !document.hidden && !matchMedia('(prefers-reduced-motion: reduce)').matches;
  const inRun = (el: Element) => el.classList.contains('listed') || el.classList.contains('got');
  const kids = [...grid.children].filter((el): el is HTMLElement => el instanceof HTMLElement && el.classList.contains('cc'));
  const want = new Map(next.map((l) => [l.id, l]));
  // First: where every tile is, and which part of the grid is on screen (a scrolling grid shows only its box).
  const g = grid.getBoundingClientRect();
  const top = Math.max(0, g.top), bottom = Math.min(innerHeight, g.bottom);
  const onScreen = (r: DOMRect) => r.bottom > top && r.top < bottom;
  const first = new Map(kids.map((el) => [el, el.getBoundingClientRect()]));

  // Left the market: out of the flow at once, fading where it stood.
  const gone: string[] = [];
  for (const el of kids) {
    if (!inRun(el) || want.has(el.dataset.id!)) continue;
    gone.push(el.dataset.id!);
    const r = first.get(el)!;
    first.delete(el);
    el.classList.remove('listed', 'got', 'sel');
    if (!motion || !onScreen(r)) {
      el.remove();
      continue;
    }
    if (getComputedStyle(grid).position === 'static') grid.style.position = 'relative';
    Object.assign(el.style, {
      position: 'absolute',
      left: `${r.left - g.left - grid.clientLeft + grid.scrollLeft}px`,
      top: `${r.top - g.top - grid.clientTop + grid.scrollTop}px`,
      width: `${r.width}px`,
      margin: '0',
      pointerEvents: 'none',
    });
    const out = el.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'scale(0.94)' }], { duration: 180, easing: 'ease-in', fill: 'forwards' });
    void out.finished.then(() => el.remove(), () => el.remove());
  }

  // Then the run in its new order, ahead of the first tile that isn't for sale. A Credit that was on the grid as not
  // for sale and is listed now moves into the run; a changed price replaces the old one.
  const at = new Map(kids.filter((el) => inRun(el) && want.has(el.dataset.id!)).map((el) => [el.dataset.id!, el]));
  for (const l of next) if (!at.has(l.id)) grid.querySelector(`:scope > .cc[data-id="${l.id}"]`)?.remove();
  if (next.length) grid.querySelector(':scope > p')?.remove(); // "No Credit here."
  const arrived = new Set<HTMLElement>();
  const run = next.map((l) => {
    const had = at.get(l.id);
    const now = fromHtml(cell(l));
    if (!had) {
      arrived.add(now);
      return now;
    }
    const price = had.querySelector('.cc-price'), fresh = now.querySelector('.cc-price');
    if (price && fresh && price.outerHTML !== fresh.outerHTML) {
      price.replaceWith(fresh);
      if (motion) fresh.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 400, easing: EASE });
    }
    return had;
  });
  const behind = [...grid.children].find((el) => el instanceof HTMLElement && el.classList.contains('cc') && !inRun(el) && el.style.position !== 'absolute') ?? null;
  for (const el of run) grid.insertBefore(el, behind);
  if (!motion) return gone;

  // Last: every tile that moved plays from where it was; new ones fade in.
  for (const [el, r] of first) {
    if (!el.isConnected) continue;
    const n = el.getBoundingClientRect();
    const dx = r.left - n.left, dy = r.top - n.top;
    if ((!dx && !dy) || (!onScreen(r) && !onScreen(n))) continue;
    el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], { duration: 320, easing: EASE });
  }
  for (const el of arrived)
    if (onScreen(el.getBoundingClientRect())) el.animate([{ opacity: 0, transform: 'scale(0.94)' }, { opacity: 1, transform: 'none' }], { duration: 260, delay: 80, easing: EASE, fill: 'backwards' });
  return gone;
}

/// One live step for a grid with Sweep: `next` onto the grid and into `sale` (bought ones stay in `mine`), then
/// Sweep's marks and total. A Credit you'd picked that left the market is said so.
export function relist(grid: HTMLElement, sale: Sale, next: Listed[], cell: (l: Listed) => string, sweep: { mark: () => void; chosen: () => Listed[] } | null) {
  const had = new Set(sweep?.chosen().map((l) => l.id));
  const gone = reflow(grid, next, cell);
  sale.ls = next.filter((l) => !sale.mine.has(l.id));
  sale.byId.clear();
  for (const l of sale.ls) sale.byId.set(l.id, l);
  sale.all.splice(0, sale.all.length, ...next);
  sweep?.mark();
  const lost = gone.filter((id) => had.has(id)).length;
  if (lost) toast(lost === 1 ? 'A Credit you picked is no longer for sale.' : `${lost} Credits you picked are no longer for sale.`, 'info');
}

/// Marketplaces hidden for this visit (the marks by a Buy heading): their listings leave every grid of Credits for
/// sale until shown again. A new visit shows them all.
const HIDE_KEY = 'cu-hide-sources';
const hiddenSources = new Set<Source>(
  (() => {
    try {
      return (JSON.parse(sessionStorage.getItem(HIDE_KEY) ?? '[]') as Source[]).filter((s) => s in SOURCES);
    } catch {
      return [];
    }
  })(),
);
export const sourceShown = (l: { source: Source }) => !hiddenSources.has(l.source);

/// The marketplaces as marks, into `el`: one for each in `have` (and any hidden, so it can come back), lit while its
/// listings show. None when there's only one to choose from.
export function sourceMarks(el: HTMLElement, have: Iterable<Source>) {
  const seen = new Set(have);
  const list = (Object.keys(SOURCES) as Source[]).filter((s) => seen.has(s) || hiddenSources.has(s));
  el.innerHTML =
    list.length < 2
      ? ''
      : list
          .map((s) => {
            const tip = sourceTip(s);
            return `<button type="button" class="src-toggle" data-src="${s}" aria-pressed="${!hiddenSources.has(s)}" aria-label="${tip}" data-tip="${tip}"><img class="src" src="${SOURCES[s].icon}" alt=""></button>`;
          })
          .join('');
}

/// What tapping a mark does, as its tooltip says it.
const sourceTip = (s: Source) => `${hiddenSources.has(s) ? 'Show' : 'Hide'} ${SOURCES[s].name} listings`;

/// `fn` each time a marketplace is hidden or shown, while `el` is on the page.
export function onSources(el: HTMLElement, fn: () => void) {
  const on = () => (el.isConnected ? fn() : window.removeEventListener('cu-sources', on));
  window.addEventListener('cu-sources', on);
}

// Every mark on every page: tap to hide or show that marketplace's listings for the visit. The last one lit stays.
document.addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLButtonElement>('.src-toggle');
  if (!b) return;
  const s = b.dataset.src as Source;
  if (hiddenSources.has(s)) hiddenSources.delete(s);
  else if ([...(b.parentElement?.children ?? [])].filter((x) => x.getAttribute('aria-pressed') === 'true').length > 1) hiddenSources.add(s);
  else return;
  try {
    sessionStorage.setItem(HIDE_KEY, JSON.stringify([...hiddenSources]));
  } catch {}
  document.querySelectorAll<HTMLButtonElement>(`.src-toggle[data-src="${s}"]`).forEach((x) => {
    x.setAttribute('aria-pressed', String(!hiddenSources.has(s)));
    x.setAttribute('aria-label', sourceTip(s));
    x.dataset.tip = sourceTip(s);
  });
  window.dispatchEvent(new Event('cu-sources'));
});

/// `ls`/`byId`: what can be bought. `all`: the listings in grid order, including `mine`, bought on this page.
export type Sale = { ls: Listed[]; preview: boolean; byId: Map<string, Listed>; all: Listed[]; mine: Set<string> };

/// Where a bought Credit's price was.
export const YOURS = '<span class="cc-price yours">Yours</span>';

/// Every Credit listed anywhere (of one trait, `palette/K`, or within rules like { minScore, maxScore }), cheapest first, paged in from /opensea/listed as asked
/// for. A Credit listed more than once keeps its cheapest. `sale.ls` is the same list, for Sweep. Marketplaces hidden
/// this visit are left out; `seen` is every marketplace with Credits listed (as the Worker says), hidden or not.
export function listedPager(where: { trait?: string; rules?: Record<string, number> } = {}) {
  const items: Listed[] = []; // the grid's order, just-bought included
  const sale: Sale = { ls: [], preview: true, byId: new Map(), all: items, mine: new Set() };
  const seen = new Set<Source>();
  let cursor: string | null = '';
  const self = {
    items,
    sale,
    seen,
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
        const d = (await res.json()) as { items?: Listed[]; next?: string | null; preview?: boolean; sources?: Source[]; error?: string };
        if (d.error) break;
        sale.preview = !!d.preview;
        for (const src of d.sources ?? []) if (src in SOURCES) seen.add(src);
        for (const l of d.items ?? []) {
          if (!SOURCES[l.source] || sale.byId.has(l.id) || sale.mine.has(l.id) || justBought(l.id)) continue;
          seen.add(l.source);
          if (!sourceShown(l)) continue;
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

/// A listed Credit's price under its number: the marketplace's mark, then the price. `up`: it rose since the page
/// loaded (a union's Buy stopped on it), shown in red.
export const priceTag = (l: Listed, up = false) =>
  `<span class="cc-price num${up ? ' up' : ''}" title="On ${SOURCES[l.source].name}"><img class="src" src="${SOURCES[l.source].icon}" alt="${SOURCES[l.source].name}">${minEth(BigInt(l.price))}</span>`;

/// Sweep's row before its listings are in: the same shape, with nothing to drag yet, so nothing moves when they land.
export function sweepWaiting(host: HTMLElement) {
  host.classList.add('buy-row');
  host.innerHTML = `${sweepRow('sale', 0, 0, 0)}${canBuy() && !session.account ? connectToBuy() : '<button class="btn primary" disabled>Buy</button>'}`;
}

/// Sweep: drag the slider to take the cheapest that many (up to MAX_SWEEP), or tap listed Credits' squares to pick
/// them one by one. The picked are outlined in `grid` wherever they are; the button carries their total.
/// `mark()` re-outlines after the grid changes (and lets the slider reach listings that paged in since).
/// `button: false` leaves the buying to the page (the create page buys and opens in one go, a union's Buy tab
/// deposits too); it reads `chosen()` and hears every change through `onPick`. `cap`: at most this many (a union's
/// open slots).
export function sweepControls(host: HTMLElement, sale: Sale, grid: HTMLElement, o: { button?: boolean; cap?: number; onPick?: () => void } = {}) {
  // Nothing picked to start: drag, or tap Credits.
  const picked = new Set<string>();
  const cap = Math.min(MAX_SWEEP, o.cap ?? MAX_SWEEP);
  const most = () => Math.min(cap, sale.ls.length);
  // The price sits between the slider and the button and moves as you drag; the button carries the count.
  const signedOut = canBuy(sale.preview) && !session.account;
  host.classList.add('buy-row');
  const button = o.button === false ? '' : signedOut ? connectToBuy() : `<button class="btn primary" id="sale-go"${canBuy(sale.preview) ? '' : ' disabled title="Mainnet prices, shown as a preview"'}>Buy</button>`;
  host.innerHTML = `${sweepRow('sale', 0, most(), 0)}${button}`;
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
    // Only Credits still for sale stay picked (one bought or sold since drops out).
    for (const id of picked) if (!sale.byId.has(id)) picked.delete(id);
    setRange(range, picked.size, most());
    grid.querySelectorAll<HTMLElement>('.cc').forEach((c) => c.classList.toggle('sel', picked.has(c.dataset.id!)));
    // What the wallet will ask: the listings plus the Sweeper's fee (sweepToWallet reads the exact quote on click).
    totalEl.innerHTML = sweepTotal(chosen().reduce((a, l) => a + BigInt(l.price), 0n), bps, picked.size, 'Drag or tap Credits');
    o.onPick?.();
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
    else if (picked.size >= cap) return toast(cap < MAX_SWEEP ? `Only ${cap} to go.` : `Up to ${MAX_SWEEP} in one sweep.`, 'info');
    else picked.add(id);
    mark();
  });
  mark();
  // `fee()`: the fee the total shows; `setFee` when the Sweeper's changed.
  return {
    mark,
    chosen,
    fee: () => bps,
    setFee: (b: bigint) => {
      bps = b;
      mark();
    },
  };
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

/// The live listing for each of these Credits (skipping ones not for sale), ready to buy.
export async function listedById(ids: string[]): Promise<Listed[]> {
  const got = await Promise.all(
    ids.map((x) =>
      fetch(`/opensea/credit/${x}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((l: { price: string | null; source?: Listed['source']; hash?: string | null; protocol?: string | null; listingId?: string | null; preview?: boolean } | null) =>
          l?.price && !l.preview ? ({ id: x, price: l.price, source: l.source!, hash: l.hash ?? undefined, protocol: l.protocol ?? undefined, listingId: l.listingId ?? undefined } as Listed) : null,
        )
        .catch(() => null),
    ),
  );
  return got.filter((l): l is Listed => !!l);
}

/// Sweep these listings into the connected wallet (Sweeper.buy): a fresh price for exactly them, checked
/// against what it shows, the fee read now, then one transaction. Credits sold since drop out of the price.
/// Resolves to the ids bought, or null if nothing was.
/// `onSubmit` runs once the wallet has sent it (the Credits' squares start their buying pulse then).
/// `whole`: all of them or none (a picture's Credits: one missing would shift the rest out of their slots). A quote
/// short of any refuses before the wallet, naming them in `onSold`; the transaction itself reverts if one sells after.
export async function sweepToWallet(picked: Listed[], btn: HTMLButtonElement, onSubmit?: () => void, whole?: { onSold: (ids: string[]) => void }): Promise<string[] | null> {
  const label = btn.textContent ?? '';
  btn.disabled = true;
  btn.textContent = 'Pricing…';
  buying.n++;
  try {
    const r = await fetch('/opensea/buyquote', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ listings: picked }) });
    const q = (await r.json()) as Quote;
    if (!r.ok || q.error) throw new Error(q.error ?? 'No price right now.');
    checkQuote(q);
    if (whole) {
      const have = new Set([...q.ids, ...(q.fwa ?? []).map((f) => f.id), ...(q.strategy ?? []).map((f) => f.id)]);
      const sold = picked.map((l) => l.id).filter((id) => !have.has(id));
      if (sold.length) {
        whole.onSold(sold);
        throw new Error(`${sold.map((id) => `#${id}`).join(', ')} just sold. The picture picked another for ${sold.length === 1 ? 'its slot' : 'their slots'}: check and buy again.`);
      }
    }
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
          whole ? BigInt(picked.length) : 1n,
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
  } finally {
    buying.n--;
  }
}
