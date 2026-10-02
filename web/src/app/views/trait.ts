import { hasLayout, layoutSlot, listBatches, type Listed } from '../data';
import { YOURS, listedPager, live, onSources, priceTag, relist, sourceMarks, sourceShown, sweepControls, sweepWaiting, type Listed as Listing } from '../forsale';
import { hydrate } from '../ens';
import { bin } from '../bins';
import { fmtScore } from '../../shared/credits';
import { editionArt, fillGhosts } from '../ghosts';
import { dice, printGlyph, swatch, weightGlyph } from '../glyphs';
import { EIGHTS_TOP, TRAIT_KINDS, eightsName, parseTrait, traitPath, type TraitKind, type TraitValue } from '../../shared/trait';
import { bindSort, esc, pageHead, sortMenu } from '../ui';
import facts from 'virtual:credits-facts';
import { card } from './lists';

const SUPPLY = 122_154;

/// The edition's counts, made at build from the edition files (scripts/bins.mjs; the same table /edition/match
/// reads), so pages have them with no data file to read.
export type Facts = {
  n: number; // Credits in the edition
  palette: [string, number][]; // mask letters, count
  eights: number[]; // Credits with 0..5 eights
  print: number[];
  weight: number[];
};
/// Listed Credits to have in hand before drawing a page of them.
const FIRST = 36;
const RULE_KEY = { palette: 'palettes', eights: 'eights', print: 'prints', weight: 'weights' } as const;

export const traitGlyph = (t: TraitValue) =>
  t.kind === 'palette' ? swatch(t.name) : t.kind === 'eights' ? dice(t.v - 1) : t.kind === 'print' ? printGlyph(t.name) : weightGlyph(t.slug);

/// "Sparse Credits", "Credits with three eights", "Credits with no eights".
export const creditsOf = (t: TraitValue) => (t.kind === 'eights' ? `Credits with ${eightsName(t.v - 1, true)}` : `${t.name} Credits`);

export const pct = (n: number) => {
  const p = (n / SUPPLY) * 100;
  return p >= 1 ? `${p.toFixed(1)}%` : p >= 0.01 ? `${p.toFixed(2)}%` : n ? '<0.01%' : '0%';
};

/// Whether an open Credit Union's rules admit this value: no rule on the trait, or a rule that includes it. A painted
/// sheet of this trait (or of Plates, for a palette) also needs a slot of this value or an open slot.
export function takes({ s }: Listed, t: TraitValue) {
  if (s.state !== 'Open') return false;
  const f = s.filter, key = RULE_KEY[t.kind];
  const want = t.rules[key] ?? 0;
  if (f[key] && !(f[key] & want)) return false;
  if (!hasLayout(f)) return true;
  const lt = f.layoutTrait ?? 0;
  const v = lt === t.trait ? t.v : lt === 4 && t.kind === 'palette' ? [0, 1, 2, 3].filter((b) => t.v & (1 << b)).length : -1;
  if (v < 0) return true;
  for (let i = 0; i < 80; i++) {
    const slot = layoutSlot(f, i);
    if (slot === 0 || slot === v) return true;
  }
  return false;
}

/// A trait value's page (/palette/C): how many Credits have it, the open Credit Unions that take it, and every
/// Credit with it, cheapest listed first. The trait's own page (/palette) is the same with no value picked: every
/// Credit, every value's glyph a way in. /credits is every Credit too, with no trait to pick by.
export async function traitPage(app: HTMLElement, kind: string, raw: string) {
  const all = kind === 'credits';
  if (!all && !(TRAIT_KINDS as readonly string[]).includes(kind)) {
    app.innerHTML = `<section class="prose"><h1>Not found</h1></section>`;
    return;
  }
  const k = kind as TraitKind;
  const t = raw && !all ? parseTrait(kind, raw) : null;
  if (raw && !t) {
    app.innerHTML = `<section class="prose"><h1>Not found</h1><p class="muted">No such ${esc(kind)}.</p></section>`;
    return;
  }
  if (t && location.pathname !== traitPath(t)) history.replaceState(null, '', traitPath(t) + location.search);
  const saleKey = t ? `${t.kind}/${t.slug}` : undefined;
  // /credits only: Cheapest or Best value (rating per ETH), remembered; each Credit shows its rating there.
  let order: Where['order'] = undefined;
  try {
    const v = localStorage.getItem('cu-credits-order');
    if (all && (v === 'value' || v === 'rating')) order = v;
  } catch {}
  let scoreOf = new Uint32Array(0);
  if (all)
    await bin('credit-score.bin')
      .then((b) => (scoreOf = new Uint32Array(b)))
      .catch(() => {});

  const start = t ? `/create?${t.kind}=${encodeURIComponent(t.slug)}` : '/create';
  // How many, from the counts built into the page (no wait, so the line never shifts); the unions link, which
  // does wait, comes last on the line.
  const count = !t ? facts.n : t.kind === 'palette' ? (facts.palette.find(([p]) => p === t.name)?.[1] ?? 0) : facts[t.kind][t.v - 1] ?? 0;
  app.innerHTML = `
  <section class="trait-page jb">
    ${creditsHead(kind, t?.name, `<a class="jb-link" id="jb-unions" href="/unions${t ? `?${t.kind}=${encodeURIComponent(t.slug)}` : ''}" hidden></a><a class="jb-link" href="${start}">Start a Credit Union${t ? ' for them' : ''}</a>`)}
    ${
      all
        ? ''
        : `<nav class="jb-values ${k}${t ? '' : ' all'}" aria-label="${esc(valuesOf(k)[0].label)}">${valuesOf(k)
            .map((v) => `<a href="${traitPath(v)}" title="${esc(v.name)}"${v.slug === t?.slug ? ' aria-current="page"' : ''}><span class="trait-glyph ${v.kind}">${traitGlyph(v)}</span></a>`)
            .join('')}</nav>`
    }
    <div class="jb-controls">
      <p class="jb-buy jb-count num"><b id="sale-n">Credits listed</b></p>
      ${all ? `<div class="jb-sorter">${sortMenu(CREDIT_ORDERS, order ?? 'cheap')}</div>` : ''}
      <div class="jb-sweep" id="sale-act"></div>
    </div>
    <div class="trait-grid" id="trait-grid"></div>
    <button type="button" class="btn block" id="trait-more" hidden>Show more</button>
  </section>`;

  // Open Credit Unions that take these Credits: a count that links to them on /unions.
  void listBatches()
    .then((list) => {
      const open = list.filter((b) => (t ? takes(b, t) : b.s.state === 'Open'));
      const a = document.getElementById('jb-unions') as HTMLAnchorElement | null;
      if (!a || !open.length) return;
      a.textContent = t ? `${open.length} open Credit ${open.length === 1 ? 'Union takes' : 'Unions take'} them` : `${open.length} open Credit ${open.length === 1 ? 'Union' : 'Unions'}`;
      a.hidden = false;
    })
    .catch(() => {});

  // Market: only the Credits for sale, in the chosen order, and how many there are.
  const saleN = (n: number) => {
    const el = document.getElementById('sale-n');
    if (el) el.textContent = `${n.toLocaleString()} ${n === 1 ? 'Credit' : 'Credits'} listed`;
  };
  const grid = buyGrid(app, { trait: saleKey, order }, async () => ({ ids: [], total: 0 }), all ? (id) => (scoreOf[id - 1] ? `Rating ${fmtScore(scoreOf[id - 1] / 10_000)}` : '') : undefined, saleN);
  bindSort(app, (k) => {
    const next = k === 'cheap' ? undefined : (k as Where['order']);
    if (next === order) return;
    order = next;
    try {
      if (order) localStorage.setItem('cu-credits-order', order);
      else localStorage.removeItem('cu-credits-order');
    } catch {}
    void grid.start({ trait: saleKey, order });
  });
  // Not awaited: the page shows at once (the router fades it in when this returns), the grid filling in behind.
  void grid.start();
}

/// The Buy row's markup: the heading, Sweep beside it, then the grid and its Show more.
export const buyRow = (heading: string) => `<div class="jb-controls">
      <h2 class="jb-buy">${esc(heading)}</h2>
      <div class="jb-sweep" id="sale-act"></div>
    </div>
    <div class="trait-grid" id="trait-grid"></div>
    <button type="button" class="btn block" id="trait-more" hidden>Show more</button>`;

/// "4 open Credit Unions take them", linking to /unions narrowed the same way (`query`), into #jb-unions.
export async function unionsLink(app: HTMLElement, test: (b: Listed) => boolean, from: Promise<Listed[]> = listBatches(), query = '') {
  const a = app.querySelector<HTMLAnchorElement>('#jb-unions');
  if (!a) return;
  const open = (await from.catch(() => [] as Listed[])).filter((b) => b.s.state === 'Open' && test(b));
  if (!a.isConnected) return;
  a.hidden = !open.length;
  a.textContent = `${open.length} open Credit ${open.length === 1 ? 'Union takes' : 'Unions take'} them`;
  a.href = `/unions${query ? `?${query}` : ''}`;
}

/// The Buy row and grid every Credits page shares: the Buy heading and Sweep over one grid, every listed Credit
/// first (cheapest first, paged in from /opensea/listed a request or two at a time), then the rest of these
/// Credits from `rest(page)`, leaving out the listed ones. Each step draws what it has at once and the next loads
/// as the grid's end comes into view, so nothing waits on a slow listing search. The listed ones stay live, as on a
/// marketplace's own page. `start()` again (after `where` changes) redraws it. Needs .jb-buy, #sale-act, #trait-grid
/// and #trait-more inside `app`.
export type Where = { trait?: string; rules?: Record<string, number>; order?: 'value' | 'rating' };
/// /credits: how listed Credits are ordered.
const CREDIT_ORDERS = [['cheap', 'Lowest price'], ['rating', 'Top rated'], ['value', 'Most rating per ETH']] as const;
export function buyGrid(app: HTMLElement, where: Where, rest: (page: number) => Promise<{ ids: number[]; total: number }>, line?: (id: number) => string, onTotal?: (n: number) => void) {
  const grid = app.querySelector<HTMLElement>('#trait-grid')!;
  const more = app.querySelector<HTMLButtonElement>('#trait-more')!;
  const heading = app.querySelector<HTMLElement>('.jb-buy');
  const host = app.querySelector<HTMLElement>('#sale-act')!;
  let listed = listedPager(where);
  let sweep: ReturnType<typeof sweepControls> | null = null;
  let page = 0, shown = 0, gen = 0, placed = 0;
  // Listings being read for the grid: the live read waits till they're in.
  let loading = 0;
  const reading = async (p: Promise<void>) => {
    loading++;
    try {
      await p;
    } finally {
      loading--;
    }
  };
  const cell = (id: number) =>
    creditCell(id, listed.sale.mine.has(String(id)) ? YOURS : listed.sale.byId.has(String(id)) ? priceTag(listed.sale.byId.get(String(id))!) : '', { line: line?.(id) });
  // A range (rules) can't be searched quickly (OpenSea can't filter it), so its Credits draw at once and the listed
  // ones join the head of the grid as the search finds them; the browser keeps the view still as they arrive.
  // A trait searches fast, so it pages its listed Credits first, then the rest.
  const behind = () => !!(where.rules);
  // Listed Credits found since the last look, onto the grid: at its end, or (behind) at the end of the listed run
  // at its head, moved there if the rest already drew them.
  const unskel = () => grid.querySelectorAll(':scope > .skel').forEach((el) => el.remove());
  // The marketplaces' marks by the heading: tap one to hide its listings for this visit.
  const marks = document.createElement('span');
  marks.className = 'src-toggles';
  heading?.append(marks);
  // The Buy row (heading, marks and Sweep): up while listings load, while any are listed, and while a marketplace is
  // hidden (so it can be shown again).
  const row = (on: boolean) => {
    sourceMarks(marks, listed.seen);
    const up = on || !!marks.childElementCount;
    if (heading && !heading.classList.contains('jb-count')) heading.hidden = !up; // a count stays up regardless
    host.hidden = !up;
  };
  const tile = (l: Listing) => creditCell(Number(l.id), priceTag(l), { line: line?.(Number(l.id)) });
  const place = () => {
    unskel();
    for (; placed < listed.items.length; placed++) {
      const id = listed.items[placed].id;
      if (!behind()) {
        grid.insertAdjacentHTML('beforeend', cell(Number(id)));
        continue;
      }
      grid.querySelector(`.cc[data-id="${id}"]`)?.remove();
      const firstRest = grid.querySelector('.cc:not(.listed)');
      if (firstRest) firstRest.insertAdjacentHTML('beforebegin', cell(Number(id)));
      else grid.insertAdjacentHTML('beforeend', cell(Number(id)));
    }
    if (listed.items.length && !sweep) sweep = sweepControls(host, listed.sale, grid);
    row(!!listed.items.length);
    sweep?.mark();
    if (listed.total !== null) onTotal?.(listed.total);
  };
  const inView = () => more.getBoundingClientRect().top < innerHeight + 600;
  const load = async () => {
    const my = gen;
    more.disabled = true;
    loading++;
    try {
      // While listings last: the next listed Credits.
      if (!listed.done && !behind()) {
        await listed.fill(listed.items.length + FIRST, 2);
        if (my !== gen || !grid.isConnected) return;
        place();
        more.hidden = false;
        more.textContent = 'Show more';
        return;
      }
      const d = await rest(page);
      if (!grid.isConnected || my !== gen) return;
      unskel();
      grid.insertAdjacentHTML('beforeend', d.ids.filter((id) => !listed.sale.byId.has(String(id)) && !listed.sale.mine.has(String(id))).map(cell).join(''));
      sweep?.mark();
      shown += d.ids.length;
      page++;
      const left = d.total - shown;
      more.hidden = left <= 0 || !d.ids.length;
      more.textContent = `Show more · ${left.toLocaleString()} left`;
      if (!d.total && !listed.items.length) grid.innerHTML = '<p class="muted">None for sale right now.</p>';
    } catch {
      if (!page && grid.isConnected) grid.innerHTML = '<p class="error">Couldn’t load Credits.</p>';
    } finally {
      loading--;
      more.disabled = false;
      // Still at the end of the grid (a short step, or a search that found little): keep going.
      if (my === gen && grid.isConnected && !more.hidden && inView()) setTimeout(() => void load());
    }
  };
  more.addEventListener('click', () => void load());
  new IntersectionObserver((es) => es.some((e) => e.isIntersecting) && !more.hidden && !more.disabled && void load(), { rootMargin: '600px' }).observe(more);
  // Live: every 20 s the cheapest listed Credits (one read's worth) are read again and what changed moves into place.
  // Dearer ones already shown stay as they were read: at or past the read's dearest, where it may have stopped.
  live(grid, async () => {
    const my = gen;
    if (loading) return;
    const fresh = listedPager(where);
    await fresh.fill(1, 1);
    if (my !== gen || loading || !grid.isConnected || (!fresh.items.length && !fresh.done)) return; // the read failed
    // Kept past the read: by price, those at or past its dearest; by value, those already shown beyond its length.
    const top = fresh.done ? null : fresh.items.reduce((m, l) => (BigInt(l.price) > m ? BigInt(l.price) : m), 0n);
    const past =
      top === null ? []
      : where.order ? listed.sale.ls.slice(fresh.items.length).filter((l) => !fresh.sale.byId.has(l.id))
      : listed.sale.ls.filter((l) => BigInt(l.price) >= top && !fresh.sale.byId.has(l.id));
    for (const src of fresh.seen) listed.seen.add(src);
    relist(grid, listed.sale, [...fresh.items, ...past], tile, sweep);
    placed = listed.items.length;
    if (listed.items.length && !sweep) sweep = sweepControls(host, listed.sale, grid);
    row(!!listed.items.length);
  });
  // A marketplace hidden: its tiles leave at once. Shown again: the listings are read again as far as the grid
  // reaches, so its Credits slide in where they belong (and paging on picks up after them).
  onSources(grid, async () => {
    const my = gen;
    const keep = listed.sale.ls.filter(sourceShown);
    if (keep.length < listed.sale.ls.length) relist(grid, listed.sale, keep, tile, sweep);
    else {
      const top = listed.sale.ls.length ? BigInt(listed.sale.ls[listed.sale.ls.length - 1].price) : 0n;
      const fresh = listedPager(where);
      for (let calls = 0; calls < 8 && !fresh.done; calls++) {
        await fresh.fill(fresh.items.length + 1, 1);
        const last = fresh.items[fresh.items.length - 1];
        if (where.order ? fresh.items.length >= listed.sale.ls.length : last && BigInt(last.price) >= top) break;
      }
      if (my !== gen || !grid.isConnected) return;
      relist(grid, listed.sale, fresh.items, tile, sweep);
    }
    placed = listed.items.length;
    if (listed.items.length && !sweep) sweep = sweepControls(host, listed.sale, grid);
    row(!!listed.items.length);
  });
  return {
    async start(next?: Where) {
      const my = ++gen;
      if (next) (where = next), (listed = listedPager(next));
      page = shown = placed = 0;
      sweep = null;
      // Loading: the Buy row as it will be and a screenful of grey tiles, so nothing moves when listings land.
      sweepWaiting(host);
      row(true);
      grid.innerHTML = creditSkel.repeat(SKELS);
      more.hidden = true;
      try {
        if (behind()) {
          await load();
          while (!listed.done && my === gen && grid.isConnected) {
            await reading(listed.fill(listed.items.length + 1, 1));
            if (my !== gen || !grid.isConnected) return;
            place();
          }
          return;
        }
        await reading(listed.fill(FIRST, 1)); // a first look (one request)
        if (my !== gen || !grid.isConnected) return; // drawn again meanwhile: that drawing owns it now
        place();
        await load();
      } catch {
        if (my === gen && grid.isConnected && !grid.querySelector('.cc:not(.skel)')) grid.innerHTML = '<p class="error">Couldn’t load Credits.</p>';
      }
    },
  };
}

/// Credits as a grid, each its art over its number (and price when it's listed), linking to its page.
export const creditTiles = (ids: number[]) => ids.map((id) => creditCell(id)).join('');
/// A Credit tile still loading, the same shape as the one that replaces it.
export const creditSkel = '<div class="cc skel" aria-hidden="true"><span class="cc-art"></span><span class="cc-cap"></span></div>';
/// Loading tiles a grid of Credits shows before its first listings land: about a screenful.
const SKELS = 24;

/// One Credit tile for every grid of Credits: its art (to its page), then its number and, when listed, its price.
/// `title`: the art's tooltip (where it is, on a member's page).
/// `line`: a third line under the price, the value the page is about ("Rating 797.03").
export const creditCell = (id: number, price = '', { title = '', line = '' } = {}) =>
  `<div class="cc${price ? ' listed' : ''}" data-id="${id}"><a class="cc-art" href="/credit/${id}"${title ? ` title="${esc(title)}"` : price ? ' title="Tap to pick for a sweep"' : ''}><img src="${editionArt(id)}" alt="Credit #${id}" loading="lazy" decoding="async"></a><span class="cc-cap"><a class="num" href="/credit/${id}">#${id.toLocaleString('en-US')}</a>${price}</span>${line ? `<span class="cc-line num">${line}</span>` : ''}</div>`;


/// The two lists under a time window or range, as tabs: the open Credit Unions that take these Credits, and the
/// Credits themselves. `note`: one line under the Credit Unions tab (how they were matched).
export const pairTabs = (note = '') => `<section class="trait-section pair">
      <div class="pair-tabs jb-tabs" role="tablist">
        <button type="button" role="tab" data-pane="credits" aria-selected="true">Credits <span class="num" id="credits-n"></span></button>
        <button type="button" role="tab" data-pane="unions" aria-selected="false">Credit Unions <span class="num" id="unions-n"></span></button>
      </div>
      <div class="pair-pane" data-pane="unions" hidden>${note ? `<p class="muted small time-rule">${note}</p>` : ''}<div id="trait-unions"><p class="muted">Checking open Credit Unions…</p></div></div>
      <div class="pair-pane" data-pane="credits"><div class="trait-grid" id="trait-grid"></div><button type="button" class="btn block" id="trait-more" hidden>Show more</button></div>
    </section>`;

let pairPicked = false;
const showPane = (name: string) => {
  document.querySelectorAll<HTMLElement>('.pair-tabs [data-pane]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.pane === name)));
  document.querySelectorAll<HTMLElement>('.pair-pane').forEach((p) => (p.hidden = p.dataset.pane !== name));
};
/// Tab clicks switch panes. Credits leads.
export function bindPairTabs() {
  pairPicked = false;
  document.querySelectorAll<HTMLElement>('.pair-tabs [data-pane]').forEach((b) =>
    b.addEventListener('click', () => {
      pairPicked = true;
      showPane(b.dataset.pane!);
    }),
  );
}

/// The open Credit Unions that pass `test`, as cards, into #trait-unions (count in #unions-n). `from`: a list
/// already read, for pages that redraw it.
export async function drawOpenUnions(test: (b: Listed) => boolean, from: Promise<Listed[]> = listBatches()) {
  const el = document.getElementById('trait-unions');
  if (!el) return;
  let list: Listed[];
  try {
    list = await from;
  } catch {
    if (el.isConnected) el.innerHTML = `<p class="error">Couldn’t read Credit Unions from chain.</p>`;
    return;
  }
  if (!el.isConnected) return;
  const open = list.filter((b) => b.s.state === 'Open' && test(b));
  document.getElementById('unions-n')!.textContent = open.length ? String(open.length) : '';
  el.innerHTML = open.length ? `<div class="grid">${open.map((b) => card(b)).join('')}</div>` : `<p class="muted">None right now.</p>`;
  hydrate(el);
  fillGhosts(el);
}

/// Every value a trait can take, in order: the palettes by ink count, 0 to 5 eights, the prints, the weights.
function valuesOf(kind: TraitKind): TraitValue[] {
  const raw =
    kind === 'palette'
      ? [1, 2, 3, 4].flatMap((n) => Array.from({ length: 15 }, (_, i) => i + 1).filter((m) => [0, 1, 2, 3].filter((b) => m & (1 << b)).length === n).map((m) => [...'CMYK'].filter((_, b) => m & (1 << b)).join('')))
      : kind === 'eights'
        ? Array.from({ length: EIGHTS_TOP + 1 }, (_, n) => String(n))
        : kind === 'print'
          ? ['registered', 'nudge', 'slip', 'skew', 'drift', 'loose']
          : ['even', 'lean', 'sparse', 'extreme'];
  return raw.map((v) => parseTrait(kind, v)!).filter(Boolean);
}

/// The Credits pages' header, opening the way every section page does (pageHead): the title, here where you are as
/// a breadcrumb (Credits / Palette / C, or Credits / #123 on a Credit's page), at the h1's size and place, then the
/// sections as the same tabs, the current one lit (none on a Credit's page). `value`: the crumb's end.
/// `side`: a link at the right end of the trait tabs (Start a Credit Union).
export const creditsHead = (current: string, value?: string, side = '') => {
  const sections: [string, string][] = [...TRAIT_KINDS.map((k): [string, string] => [k, valuesOf(k)[0].label]), ['time', 'Time'], ['rating', 'Rating'], ['bits', 'Bits']];
  const label = sections.find(([k]) => k === current)?.[1] ?? '';
  // Market's two halves at its top: Credits (with its trait tabs) and Statements.
  const crumb =
    current === 'credits'
      ? '<b>Credits</b><a class="crumb-alt" href="/statements">Statements</a>'
      : current === 'statements'
        ? '<a class="crumb-alt" href="/credits">Credits</a><b>Statements</b>'
        : current === 'statement'
          ? `<a href="/statements">Statements</a><span>/</span><b>${esc(value ?? '')}</b>`
        : !label
        ? `<a href="/credits">Credits</a><span>/</span><b>${esc(value ?? '')}</b>`
        : `<a href="/credits">Credits</a><span>/</span>${value ? `<a href="/${current}">${esc(label)}</a><span>/</span><b>${esc(value)}</b>` : `<b>${esc(label)}</b>`}`;
  const tabs: [string, string][] = [['credits', 'All'], ...sections];
  return `<header class="page-head">
      <nav class="jb-crumb" aria-label="Where">${crumb}</nav>
      ${current === 'statements' || current === 'statement' ? '' : `<div class="page-bar"><nav class="subtabs swipe" aria-label="Credits by">${tabs.map(([k, l]) => `<a href="/${k}"${k === current ? ' aria-current="page"' : ''}>${l}</a>`).join('')}</nav>${side ? `<span class="page-side">${side}</span>` : ''}</div>`}
    </header>`;
};

