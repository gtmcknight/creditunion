/// One Statement (/statement/123): its drawing, who holds it, its Credit Rating and format as the contract states
/// them, the Credit Union that made it (if one did), its OpenSea price with Buy when it's listed, and its Credits.
/// An overprinted Statement has a row of views of how it was made over its frame (overprint.ts); under it, the format
/// row with Play and Share; Expand sits in the frame's corner. Layer n is pages 1..n printed together, in the
/// contract's historyOf order. Beside it, the facts (and for a single page, its 80 Credits).
import { parseAbi, type Address } from 'viem';
import { config, pub, session } from '../chain';
import { listBatches, type Listed } from '../data';
import { glyph, pickRow, seedsOf } from '../directions';
import { hydrate, who } from '../ens';
import { connectToBuy } from '../forsale';
import { openExport } from '../media-export';
import { Book, paintPeek, Views, VIEWS, type Life, type Loupe, type Page, type ViewKey } from '../overprint';
import { esc, eth, same, statementArt } from '../ui';
import { DIRECTIONS, inkOf, type Direction, type Ink } from '../../shared/statement';
import { editionArt } from '../ghosts';
import { go as navigate } from '../main';
import { creditsHead } from './trait';
import { buyListed, type ForSale } from './statements';

const ABI = parseAbi([
  'function ownerOf(uint256) view returns (address)',
  'function creditScoreOf(uint256) view returns (uint256)',
  'function formatOf(uint256) view returns (uint8)',
  'function formatName(uint8) view returns (string)',
  'function historyLength(uint256) view returns (uint256)',
  'function historyOf(uint256, uint256, uint256) view returns (uint256[])',
  'function overprintedWith(uint256) view returns (uint256[])',
  'function composedFrom(uint256) view returns (uint32[80])',
]);
const fact = (k: string, v: string) => `<div><dt>${k}</dt><dd>${v}</dd></div>`;
const rating = (score: bigint) => Number(score / 10_000n).toLocaleString();
const VIEW_KEY = 'statement-view';
const icon = (d: string) => `<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.25" d="${d}"/></svg>`;
const PLAY = icon('M4.5 2.8v10.4L13 8z'), PAUSE = icon('M5 3v10M11 3v10'), EXPAND = icon('M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10');
const REPLAY = icon('M3 8a5 5 0 1 0 1.6-3.7M3 2.5v2.8h2.8');
const SHRINK = icon('M6 2.5V6H2.5M13.5 6H10V2.5M10 13.5V10h3.5M2.5 10H6v3.5');
const SHARE = icon('M8 10.5V2.2M5.1 5.1 8 2.2l2.9 2.9M3.1 8.6v5.8h9.8V8.6');
/// A 16-pixel glyph for each view, the weight of the format glyphs: what it shows, at a glance.
const S = (d: string) => `<path fill="none" stroke="currentColor" stroke-width="1.25" d="${d}"/>`;
const F = (d: string) => `<path fill="currentColor" d="${d}"/>`;
const VIEW_GLYPH: Record<ViewKey, string> = {
  statement: S('M3.5 1.6h9v12.8h-9z') + F('M1.8 7.4h12.4v1.3H1.8z'), // a page, the roller across it
  stack: S('M8 2.2 14 5 8 7.8 2 5zM2 8.2l6 2.8 6-2.8M2 11.2 8 14l6-2.8'), // pages in the air
  cells: S('M2 2h3.4v3.4H2zM6.3 2h3.4v3.4H6.3zM10.6 2H14v3.4h-3.4zM2 6.3h3.4v3.4H2zM10.6 6.3H14v3.4h-3.4zM2 10.6h3.4V14H2zM6.3 10.6h3.4V14H6.3zM10.6 10.6H14V14h-3.4z') + F('M6 6h4v4H6z'), // one cell picked out
  tree: S('M2.2 1.8h3.6v3.6H2.2zM10.2 1.8h3.6v3.6h-3.6zM4 5.4v2.3h8V5.4M8 7.7v2.6M6.2 10.3h3.6v3.9H6.2z'), // two make one
  equation: S('M4.2 2.2c-1.9 1.8-1.9 9.8 0 11.6M11.8 2.2c1.9 1.8 1.9 9.8 0 11.6M8 5.3v5.4M5.3 8h5.4'), // brackets and a plus
  sums: S('M2 3.5h6.5M10.6 2.8H14M10.6 4.2H14M2 8h6.5M10.6 7.3H14M10.6 8.7H14M2 12.5h6.5M10.6 11.8H14M10.6 13.2H14'), // row after row, each with its equals
  formats: S('M1.8 1.8h3.4v4.2H1.8zM6.3 1.8h3.4v4.2H6.3zM10.8 1.8h3.4v4.2h-3.4zM1.8 7h3.4v4.2H1.8zM6.3 7h3.4v4.2H6.3zM10.8 7h3.4v4.2h-3.4zM1.8 12.2h3.4V14H1.8zM6.3 12.2h3.4V14H6.3z'), // eight of the same
  credits: F('M1.8 1.8h1.8v1.8h-1.8zM5.6 1.8h1.8v1.8h-1.8zM9.4 1.8h1.8v1.8h-1.8zM13.2 1.8h1.8v1.8h-1.8zM1.8 5.6h1.8v1.8h-1.8zM5.6 5.6h1.8v1.8h-1.8zM9.4 5.6h1.8v1.8h-1.8zM13.2 5.6h1.8v1.8h-1.8zM1.8 9.4h1.8v1.8h-1.8zM5.6 9.4h1.8v1.8h-1.8zM9.4 9.4h1.8v1.8h-1.8zM13.2 9.4h1.8v1.8h-1.8zM1.8 13.2h1.8v1.8h-1.8zM5.6 13.2h1.8v1.8h-1.8zM9.4 13.2h1.8v1.8h-1.8zM13.2 13.2h1.8v1.8h-1.8z'), // the Credits, in rows
  timeline: S('M4 3.5h5V8M2 12.5h7V8M6 8h8'), // lines that join
};

export async function statement(app: HTMLElement, raw: string, rerender: () => void) {
  const n = /^\d{1,7}$/.test(raw) ? Number(raw) : 0;
  const at = config.statements;
  if (!n || !at) {
    app.innerHTML = `<section class="prose"><h1>Statement not found</h1></section>`;
    return;
  }
  const id = BigInt(n);
  const read = <T,>(functionName: string, args: readonly unknown[] = [id]) => pub.readContract({ address: at, abi: ABI, functionName, args } as never).catch(() => null) as Promise<T | null>;
  // Everything that waits on nothing goes out at once: its own reads, its whole history (the contract stops at its
  // length, so asking for more is safe) and the unions. OpenSea's listings don't hold the page up: Buy fills in.
  const sale = fetch('/market/statements.json').then((r) => r.json() as Promise<{ items?: ForSale[] }>).catch(() => ({}) as { items?: ForSale[] });
  const [owner, score, format, length, history, list] = await Promise.all([
    read<Address>('ownerOf'),
    read<bigint>('creditScoreOf'),
    read<number>('formatOf'),
    read<bigint>('historyLength'),
    read<readonly bigint[]>('historyOf', [id, 0n, 1024n]),
    listBatches().catch(() => [] as Listed[]),
  ]);
  const title = `Statement #${n.toLocaleString()}`;
  // A page overprinted onto another is burned (no owner), but its record and drawing stay readable.
  const burned = !owner && length != null;
  if (!owner && !burned) {
    app.innerHTML = `<div class="jb">${creditsHead('statement', `#${n}`)}</div><section class="prose"><h1>${title}</h1><p class="muted">Not made yet.</p></section>`;
    return;
  }
  const order = history?.length ? history : [id];
  const [fname, pages] = await Promise.all([format != null ? read<string>('formatName', [format]) : null, readHistory(order, read)]);
  const union = list.find((b) => b.s.statementId === id) ?? null;
  // At auction the union holds it; the high bidder takes it at settle.
  const atAuction = !!union && !!owner && same(union.s.address, owner);
  const mine = !!session.account && !!owner && same(owner, session.account);
  const name = union ? esc(union.s.name || 'Untitled') : title;
  const os = `https://opensea.io/item/ethereum/${at.toLowerCase()}/${n}`;
  const layers = pages.length > 1;
  const own = (DIRECTIONS[format ?? 0] ?? 'Issued') as Direction;

  const facts = [
    burned ? fact('Owner', '<span class="muted">Overprinted onto another Statement</span>') : fact('Owner', atAuction ? `<a href="/union/${union!.s.address}">At auction</a>` : `${who(owner!, 'sm', true)}${mine ? ' <span class="tag you">You</span>' : ''}`),
    union ? fact('Made by', `<a href="/union/${union.s.address}">${esc(union.s.name || 'Untitled')}</a> <span class="muted">· a Credit Union</span>`) : '',
    score != null ? fact('Rating', `<span class="num">${rating(score)}</span>`) : '',
    fname ? fact('Format', esc(fname)) : '',
    layers ? fact('Made from', `<span class="num">${pages.length} Statements · ${(pages.length * 80).toLocaleString()} Credits</span>`) : '',
    burned ? '' : fact('OpenSea', `<a href="${os}" target="_blank" rel="noopener">View ↗</a>`),
  ].join('');
  const buyBox = atAuction ? `<a class="btn primary block" href="/union/${union!.s.address}">Bid at auction</a>` : '<div class="st-buy-slot"></div>';

  // What you're looking at, as a row of glyphs over the frame (an overprinted Statement's views), Expand in the
  // frame's corner; how it's drawn, as the format row under it, as on a union's sheet, with Play and Share at its right.
  const top = layers
    ? `<div class="st-top"><span class="st-row-label">Overprints</span><div class="dirs st-views" role="radiogroup" aria-label="Overprints">${VIEWS.map(([k, l]) => `<button type="button" role="radio" class="dir-glyph" data-view="${k}" aria-checked="${k === 'statement'}" aria-label="${l}" data-tip="${l}">${glyph(VIEW_GLYPH[k])}</button>`).join('')}</div></div>`
    : '';
  const acts = `<span class="st-acts">${layers ? `<button type="button" class="st-act" data-act="play" aria-label="Play" title="Play (Space)">${PLAY}</button>` : ''}<button type="button" class="st-act" data-act="share" aria-label="Share" title="Share (S)">${SHARE}</button></span>`;
  const bar = `<span class="st-formats muted">${pickRow(own)}</span>${acts}`;

  app.innerHTML = `
  <div class="jb">${creditsHead('statement', `#${n}`)}</div>
  <section class="batch credit-page">
    <div class="st-col">
      ${top}
      <div class="credit-art st-page-art statement-host">
        ${statementArt(id)}
        <canvas class="st-view" aria-label="${layers ? 'How it was made' : 'The Statement'}"></canvas>
        <button type="button" class="st-expand" data-act="expand" aria-label="Expand" title="Expand (F)">${EXPAND}</button>
      </div>
      <div class="st-bar">${bar}</div>
    </div>
    <div class="batch-side">
      <div class="st-peek" aria-hidden="true"><canvas></canvas><p class="st-peek-title"></p><p class="st-peek-note muted"></p></div>
      <header>${union ? `<h3 class="side-label">${title}</h3>` : ''}<h1>${name}</h1></header>
      <dl class="facts">${facts}</dl>
      ${buyBox}
      ${layers ? '' : `<section class="st-page"><p class="st-page-line small">Made from <span class="muted">80 Credits</span></p><div class="st-pane">${creditGrid(pages[0])}</div></section>`}
    </div>
  </section>`;
  hydrate(app);
  // Its OpenSea listing, once read: the price and Buy.
  void sale.then((d) => {
    const listing = d.items?.find((x) => x.id === raw), slot = app.querySelector('.st-buy-slot');
    if (!listing || !slot) return;
    slot.outerHTML = `<div class="st-buy st-buy-page"><strong class="num">${eth(BigInt(listing.price))}</strong>${mine ? '<span class="muted small">Yours</span>' : session.account ? `<button type="button" class="btn primary" data-buy>Buy</button>` : connectToBuy()}</div>`;
    const btn = app.querySelector<HTMLButtonElement>('[data-buy]');
    btn?.addEventListener('click', () => void buyListed(btn, listing, rerender));
  });
  void mount(app, pages, own);
}

/// Every page in historyOf order, with the tree around it: what it went onto, its own Credits and rating.
async function readHistory(order: readonly bigint[], read: <T>(fn: string, args?: readonly unknown[]) => Promise<T | null>): Promise<Page[]> {
  const rows = await Promise.all(
    order.map(async (p) => {
      const [kids, from, sc, f] = await Promise.all([read<readonly bigint[]>('overprintedWith', [p]), read<readonly number[]>('composedFrom', [p]), read<bigint>('creditScoreOf', [p]), read<number>('formatOf', [p])]);
      return { id: p, kids: [...(kids ?? [])], from: (from ?? []).map(Number), score: sc ?? 0n, format: (DIRECTIONS[f ?? 0] ?? 'Issued') as Direction };
    }),
  );
  const byId = new Map(rows.map((r) => [r.id, r]));
  const parent = new Map<bigint, bigint>();
  for (const r of rows) for (const k of r.kids) parent.set(k, r.id);
  return rows.map((r) => ({
    id: r.id,
    parent: parent.get(r.id) ?? null,
    from: r.from,
    // A page's score counts every page under it; its own 80 are what's left.
    own: r.kids.reduce((t, k) => t - (byId.get(k)?.score ?? 0n), r.score),
    children: r.kids,
    format: r.format,
  }));
}

/// When each page was made and burned, from the Worker (which reads each page's first and last Transfer).
async function readLives(ids: bigint[]): Promise<Life[]> {
  const r = await fetch(`/statements/lives.json?ids=${ids.join(',')}`);
  if (!r.ok) throw new Error(`Couldn't read the dates (${r.status})`);
  return ((await r.json()) as { items: Life[] }).items;
}

/// The picked Statement's 80 Credits, in its own order.
const creditGrid = (p: Page) =>
  `<div class="st-credits">${p.from.map((c) => `<a href="/credit/${c}" title="Credit #${c.toLocaleString('en-US')}"><img src="${editionArt(c)}" alt="Credit #${c}" loading="lazy" decoding="async"></a>`).join('')}</div>`;

/// The views, the row of them over the frame and the format row under it (and the keys: A all formats, Space play,
/// F expand, S share; the Statement's and Cells' arrows move through pages and cells). A Statement of one page has
/// the Statement and its formats only.
async function mount(app: HTMLElement, pages: Page[], own: Direction) {
  const host = app.querySelector<HTMLElement>('.st-page-art')!;
  const layers = pages.length > 1;
  const ids = [...new Set(pages.flatMap((p) => p.from))];
  const seeds = await seedsOf(ids.map(String));
  if (!app.isConnected) return;
  const ink = new Map<number, Ink | null>(ids.map((c, i) => [c, seeds[i]?.[0] ? inkOf(seeds[i]![0], seeds[i]![1]) : null]));
  const inks = pages.map((p) => p.from.map((c) => ink.get(c) ?? null));

  const canvas = host.querySelector<HTMLCanvasElement>('.st-view')!;
  const bar = app.querySelector<HTMLElement>('.st-bar')!;
  const book = new Book(pages, inks);
  /// The view to go back to from All formats.
  let back: ViewKey = 'statement';
  const page = app.querySelector<HTMLElement>('.credit-page')!;
  const peek = app.querySelector<HTMLElement>('.st-peek')!;
  let hide = 0;
  /// What the pointer is on in the views, large, in place of the facts until the pointer leaves it. Not when the
  /// views are wide: the drawings are large enough there.
  const show = (l: Loupe | null) => {
    clearTimeout(hide);
    if (!l || page.classList.contains('st-wide')) return void (hide = window.setTimeout(() => peek.classList.remove('on'), 90));
    const side = peek.parentElement!, w = Math.min(side.clientWidth, 420);
    paintPeek(peek.querySelector('canvas')!, book, l, w, getComputedStyle(document.documentElement).getPropertyValue('--bg').trim() || '#0a0a0a');
    peek.querySelector('.st-peek-title')!.textContent = l.title;
    peek.querySelector('.st-peek-note')!.textContent = l.note;
    peek.classList.add('on');
  };
  const views = new Views(book, canvas, {
    changed: () => sync(),
    open: (href) => navigate(href),
    format: (d) => format(d),
    peek: show,
    lives: (ids) => readLives(ids),
  });
  if (location.hostname === 'localhost') (window as unknown as { views: Views }).views = views; // for looking at the views in dev tools
  /// What's chosen, shown: the view (its glyph underlined), the format (or All formats),
  /// Play where something moves,
  /// Expand or its way back.
  const sync = () => {
    const k = views.scene.key, shown = k === 'formats' ? back : k;
    for (const b of app.querySelectorAll<HTMLElement>('[data-view]')) b.setAttribute('aria-checked', String(k !== 'formats' && b.dataset.view === shown));
    // The format row: what's picked, and greyed, what this view can't draw in.
    const on = k === 'formats' ? 'All' : (book.picked ?? own), can = views.scene.formats();
    for (const b of bar.querySelectorAll<HTMLButtonElement>('[data-pick]')) {
      b.setAttribute('aria-checked', String(b.dataset.pick === on));
      b.disabled = !!can && b.dataset.pick !== 'All' && !can.includes(b.dataset.pick as Direction);
    }
    const play = bar.querySelector<HTMLButtonElement>('[data-act="play"]');
    if (play) {
      play.hidden = !views.scene.animated;
      const say = views.playing ? 'Pause' : views.ended ? 'Replay' : 'Play';
      play.innerHTML = views.playing ? PAUSE : views.ended ? REPLAY : PLAY;
      play.setAttribute('aria-label', say);
      play.title = `${say} (Space)`;
    }
    const ex = host.querySelector<HTMLButtonElement>('.st-expand')!, wide = page.classList.contains('st-wide');
    ex.innerHTML = wide ? SHRINK : EXPAND;
    ex.setAttribute('aria-label', wide ? 'Back to the page' : 'Expand');
    ex.title = wide ? 'Back (Esc)' : 'Expand (F)';
  };
  const choose = (k: ViewKey) => {
    if (k !== 'formats') back = k;
    views.show(k);
    try {
      localStorage.setItem(VIEW_KEY, k);
    } catch {}
    sync();
  };
  /// A format from the row: its own goes back to the way it was made; from All formats, back to the view you were on.
  const format = (d: Direction) => {
    book.picked = d === own ? null : d;
    if (views.scene.key === 'formats') choose(back);
    else views.draw();
    sync();
  };
  const act = (a: string | undefined) => {
    if (a === 'play') views.play();
    else if (a === 'share') openExport(views.film());
    else if (a === 'expand') expand(page, views);
    sync();
  };
  if (layers)
    try {
      const v = localStorage.getItem(VIEW_KEY) as ViewKey | null;
      if (v && (VIEWS.some(([k]) => k === v) || v === 'formats')) {
        if (v !== 'formats') back = v;
        views.show(v);
      }
    } catch {}
  app.querySelector('.st-top')?.addEventListener('click', (e) => {
    const b = (e.target as Element).closest<HTMLElement>('[data-view]');
    if (b) choose(b.dataset.view as ViewKey);
  });
  views.draw();
  sync();
  // The print run plays once, the first time the frame is seen, so it isn't missed behind Play.
  if (layers && views.scene.key === 'statement' && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
    const seen = new IntersectionObserver((es) => {
      if (!es.some((e) => e.isIntersecting)) return;
      seen.disconnect();
      if (canvas.isConnected && views.scene.key === 'statement' && !views.playing) views.play();
    }, { threshold: 0.5 });
    seen.observe(canvas);
  }
  if (layers) {
    const idle = (f: () => void) => ('requestIdleCallback' in window ? requestIdleCallback(f, { timeout: 3000 }) : setTimeout(f, 1500));
    idle(() => views.warm());
  }
  // Everything here lets go once the page is left (the app's root stays, so it's the canvas that tells).
  const left = () => !canvas.isConnected && (resized.disconnect(), themed.disconnect(), document.removeEventListener('keydown', keys), true);
  const resized = new ResizeObserver(() => left() || views.draw());
  resized.observe(canvas);
  // A theme switch repaints the views in its colours.
  const themed = new MutationObserver(() => left() || views.draw());
  themed.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-mode', 'class'] });
  bar.addEventListener('click', (e) => {
    const b = (e.target as Element).closest<HTMLElement>('[data-act], [data-pick]');
    if (!b) return;
    if (b.dataset.pick === 'All') choose(views.scene.key === 'formats' ? back : 'formats');
    else if (b.dataset.pick) format(b.dataset.pick as Direction);
    else act(b.dataset.act);
  });
  host.querySelector('.st-expand')!.addEventListener('click', () => act('expand'));
  const keys = (e: KeyboardEvent) => {
    if (left()) return;
    if (e.metaKey || e.ctrlKey || e.altKey || (e.target as Element).closest('input, textarea, select, [contenteditable], dialog.share, .sort-menu')) return;
    if (views.keys(e)) return e.preventDefault();
    if (e.key === 'a' || e.key === 'A') return choose(views.scene.key === 'formats' ? back : 'formats');
    if (e.key === ' ' && views.scene.animated) return e.preventDefault(), act('play');
    if (e.key === 'f' || e.key === 'F') return act('expand');
    if (e.key === 'Escape' && page.classList.contains('st-wide')) return act('expand');
    if (e.key === 's' || e.key === 'S') return act('share');
  };
  document.addEventListener('keydown', keys);
}

/// Expand: the views take the page's full width over the facts column, as tall as the window allows, and lay
/// themselves out wider; again (or Esc) gives the column back.
function expand(page: HTMLElement, views: Views) {
  const wide = page.classList.toggle('st-wide');
  views.peek(null);
  views.draw();
  if (wide) page.querySelector('.st-col')?.scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
}
