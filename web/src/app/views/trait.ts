import { hasLayout, layoutSlot, listBatches, type Listed } from '../data';
import { YOURS, listedPager, priceTag, sweepControls } from '../forsale';
import { hydrate } from '../ens';
import { editionArt, fillGhosts } from '../ghosts';
import { dice, printGlyph, swatch, weightGlyph } from '../glyphs';
import { EIGHTS_TOP, TRAIT_KINDS, parseTrait, traitPath, type TraitKind, type TraitValue } from '../../shared/trait';
import { esc, pageHead } from '../ui';
import facts from 'virtual:credits-facts';
import { card } from './lists';

const SUPPLY = 122_154;
/// Listed Credits to have in hand before drawing a page of them.
const FIRST = 36;
const RULE_KEY = { palette: 'palettes', eights: 'eights', print: 'prints', weight: 'weights' } as const;

export const traitGlyph = (t: TraitValue) =>
  t.kind === 'palette' ? swatch(t.name) : t.kind === 'eights' ? dice(t.v - 1) : t.kind === 'print' ? printGlyph(t.name) : weightGlyph(t.slug);

/// "Sparse Credits", "3×8 Credits", "Credits with no eights".
export const creditsOf = (t: TraitValue) => (t.kind === 'eights' && t.v === 1 ? 'Credits with no eights' : `${t.name} Credits`);

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
/// Credit, every value's glyph a way in.
export async function traitPage(app: HTMLElement, kind: string, raw: string) {
  if (!(TRAIT_KINDS as readonly string[]).includes(kind)) {
    app.innerHTML = `<section class="prose"><h1>Not found</h1></section>`;
    return;
  }
  const k = kind as TraitKind;
  const t = raw ? parseTrait(kind, raw) : null;
  if (raw && !t) {
    app.innerHTML = `<section class="prose"><h1>Not found</h1><p class="muted">No such ${esc(kind)}.</p></section>`;
    return;
  }
  if (t && location.pathname !== traitPath(t)) history.replaceState(null, '', traitPath(t) + location.search);
  const label = valuesOf(k)[0].label;
  const saleKey = t ? `${t.kind}/${t.slug}` : undefined;

  const start = t ? `/create?${t.kind}=${encodeURIComponent(t.slug)}` : '/create';
  // How many, from the counts built into the page (no wait, so the line never shifts); the unions link, which
  // does wait, comes last on the line.
  const count = !t ? facts.n : t.kind === 'palette' ? (facts.palette.find(([p]) => p === t.name)?.[1] ?? 0) : facts[t.kind][t.v - 1] ?? 0;
  app.innerHTML = `
  <section class="trait-page jb">
    ${creditsHead(k, t?.name)}
    <nav class="jb-values ${k}${t ? '' : ' all'}" aria-label="${esc(label)}">${valuesOf(k)
      .map((v) => `<a href="${traitPath(v)}" title="${esc(v.name)}"${v.slug === t?.slug ? ' aria-current="page"' : ''}><span class="trait-glyph ${v.kind}">${traitGlyph(v)}</span></a>`)
      .join('')}</nav>
    <p class="jb-line num"><b>${count.toLocaleString()} ${count === 1 ? 'Credit' : 'Credits'}</b>${t ? `<span class="muted">${pct(count)} of ${SUPPLY.toLocaleString()}</span>` : ''}
      <a class="jb-link" href="${start}">Start a Credit Union${t ? ' for them' : ''}</a>
      <a class="jb-link" id="jb-unions" href="/unions${t ? `?${t.kind}=${encodeURIComponent(t.slug)}` : ''}" hidden></a></p>
    <div class="jb-controls">
      <h2 class="jb-buy">Buy ${esc(t ? creditsOf(t) : 'Credits')}</h2>
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

  // Listed first, cheapest first, then the rest of these Credits in Credit order, a page at a time.
  const grid = buyGrid(app, { trait: saleKey }, async (page) => {
    const res = await fetch('/edition/match', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...(t?.rules ?? {}), page }) });
    if (!res.ok) throw new Error();
    const d = (await res.json()) as { count: number; sample: number[] };
    return { ids: d.sample, total: d.count };
  });
  await grid.start();
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
/// as the grid's end comes into view, so nothing waits on a slow listing search. `start()` again (after `where`
/// changes) redraws it. Needs .jb-buy, #sale-act, #trait-grid and #trait-more inside `app`.
export type Where = { trait?: string; rules?: Record<string, number> };
export function buyGrid(app: HTMLElement, where: Where, rest: (page: number) => Promise<{ ids: number[]; total: number }>) {
  const grid = app.querySelector<HTMLElement>('#trait-grid')!;
  const more = app.querySelector<HTMLButtonElement>('#trait-more')!;
  const heading = app.querySelector<HTMLElement>('.jb-buy');
  const host = app.querySelector<HTMLElement>('#sale-act')!;
  let listed = listedPager(where);
  let sweep: { mark: () => void } | null = null;
  let page = 0, shown = 0, gen = 0, placed = 0;
  const cell = (id: number) =>
    creditCell(id, listed.sale.mine.has(String(id)) ? YOURS : listed.sale.byId.has(String(id)) ? priceTag(listed.sale.byId.get(String(id))!) : '');
  // A range (rules) can't be searched quickly (OpenSea can't filter it), so its Credits draw at once and the listed
  // ones join the head of the grid as the search finds them; the browser keeps the view still as they arrive.
  // A trait searches fast, so it pages its listed Credits first, then the rest.
  const behind = () => !!(where.rules);
  // Listed Credits found since the last look, onto the grid: at its end, or (behind) at the end of the listed run
  // at its head, moved there if the rest already drew them.
  const place = () => {
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
    if (heading) heading.hidden = !listed.items.length;
    sweep?.mark();
  };
  const inView = () => more.getBoundingClientRect().top < innerHeight + 600;
  const load = async () => {
    const my = gen;
    more.disabled = true;
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
      grid.insertAdjacentHTML('beforeend', d.ids.filter((id) => !listed.sale.byId.has(String(id)) && !listed.sale.mine.has(String(id))).map(cell).join(''));
      sweep?.mark();
      shown += d.ids.length;
      page++;
      const left = d.total - shown;
      more.hidden = left <= 0 || !d.ids.length;
      more.textContent = `Show more · ${left.toLocaleString()} left`;
      if (!d.total && !listed.items.length) grid.innerHTML = '<p class="muted">No Credit here.</p>';
    } catch {
      if (!page && grid.isConnected) grid.innerHTML = '<p class="error">Couldn’t load Credits.</p>';
    } finally {
      more.disabled = false;
      // Still at the end of the grid (a short step, or a search that found little): keep going.
      if (my === gen && grid.isConnected && !more.hidden && inView()) setTimeout(() => void load());
    }
  };
  more.addEventListener('click', () => void load());
  new IntersectionObserver((es) => es.some((e) => e.isIntersecting) && !more.hidden && !more.disabled && void load(), { rootMargin: '600px' }).observe(more);
  return {
    async start(next?: Where) {
      const my = ++gen;
      if (next) (where = next), (listed = listedPager(next));
      page = shown = placed = 0;
      sweep = null;
      host.innerHTML = '';
      if (heading) heading.hidden = true;
      grid.innerHTML = '';
      more.hidden = true;
      if (behind()) {
        await load();
        while (!listed.done && my === gen && grid.isConnected) {
          await listed.fill(listed.items.length + 1, 1);
          if (my !== gen || !grid.isConnected) return;
          place();
        }
        return;
      }
      await listed.fill(FIRST, 1); // a first look (one request)
      if (my !== gen || !grid.isConnected) return; // drawn again meanwhile: that drawing owns it now
      place();
      await load();
    },
  };
}

/// Credits as a grid, each its art over its number (and price when it's listed), linking to its page.
export const creditTiles = (ids: number[]) => ids.map((id) => creditCell(id)).join('');
export const creditCell = (id: number, price = '') =>
  `<div class="cc${price ? ' listed' : ''}" data-id="${id}"><a class="cc-art" href="/credit/${id}"${price ? ' title="Tap to pick for a sweep"' : ''}><img src="${editionArt(id)}" alt="Credit #${id}" loading="lazy" decoding="async"></a><span class="cc-cap"><a class="num" href="/credit/${id}">#${id.toLocaleString('en-US')}</a>${price}</span></div>`;


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

/// The Credits explorer's header on every page of it: Overview, the trait indexes, then Time, Rating, Bits.
/// The Credits explorer's header on every page of it: where you are as a breadcrumb (Credits / Palette / C), and
/// its sections beside it as words, the current one underlined. `value`: a trait value's name, the crumb's end.
export const creditsHead = (current: string, value?: string) => {
  const sections: [string, string][] = [['credits', 'Overview'], ...TRAIT_KINDS.map((k): [string, string] => [k, valuesOf(k)[0].label]), ['time', 'Time'], ['rating', 'Rating'], ['bits', 'Bits']];
  const label = sections.find(([k]) => k === current)?.[1] ?? '';
  const crumb =
    current === 'credits'
      ? '<b>Credits</b>'
      : `<a href="/credits">Credits</a><span>/</span>${value ? `<a href="/${current}">${esc(label)}</a><span>/</span><b>${esc(value)}</b>` : `<b>${esc(label)}</b>`}`;
  return `<header class="jb-head">
      <nav class="jb-crumb" aria-label="Where">${crumb}</nav>
      <nav class="jb-kinds" aria-label="Credits by">${sections.map(([k, l]) => `<a href="/${k}"${k === current ? ' aria-current="page"' : ''}>${l}</a>`).join('')}</nav>
    </header>`;
};

