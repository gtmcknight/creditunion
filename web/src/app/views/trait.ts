import { hasLayout, layoutSlot, listBatches, type Listed } from '../data';
import { hydrate } from '../ens';
import { editionArt, fillGhosts } from '../ghosts';
import { dice, printGlyph, swatch, weightGlyph } from '../glyphs';
import { EIGHTS_TOP, TRAIT_KINDS, parseTrait, traitPath, type TraitKind, type TraitValue } from '../../shared/trait';
import { esc, pageHead } from '../ui';
import { card } from './lists';

const SUPPLY = 122_154;
const RULE_KEY = { palette: 'palettes', eights: 'eights', print: 'prints', weight: 'weights' } as const;

export const traitGlyph = (t: TraitValue) =>
  t.kind === 'palette' ? swatch(t.name) : t.kind === 'eights' ? dice(t.v - 1) : t.kind === 'print' ? printGlyph(t.name) : weightGlyph(t.slug);

/// "Sparse Credits", "3×8 Credits", "Credits with no eights".
const credits = (t: TraitValue) => (t.kind === 'eights' && t.v === 1 ? 'Credits with no eights' : `${t.name} Credits`);

export const pct = (n: number) => {
  const p = (n / SUPPLY) * 100;
  return p >= 1 ? `${p.toFixed(1)}%` : p >= 0.01 ? `${p.toFixed(2)}%` : n ? '<0.01%' : '0%';
};

/// Whether an open Credit Union's rules admit this value: no rule on the trait, or a rule that includes it. A painted
/// sheet of this trait (or of Plates, for a palette) also needs a slot of this value or an open slot.
function takes({ s }: Listed, t: TraitValue) {
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

/// A trait value's page: how many Credits have it, the open Credit Unions that take it, and every Credit with it.
export async function traitPage(app: HTMLElement, kind: string, raw: string) {
  if (!raw) return traitIndex(app, kind as TraitKind);
  const t = parseTrait(kind, raw ?? '');
  if (!t) {
    app.innerHTML = `<section class="prose"><h1>Not found</h1><p class="muted">No such ${esc(kind)}.</p></section>`;
    return;
  }
  if (location.pathname !== traitPath(t)) history.replaceState(null, '', traitPath(t) + location.search);

  const start = `/create?${t.kind}=${encodeURIComponent(t.slug)}`;
  app.innerHTML = `
  <section class="trait-page">
    ${creditsHead(t.kind)}
    <header class="trait-head">
      <span class="trait-glyph ${t.kind}">${traitGlyph(t)}</span>
      <div class="trait-title">
        <h2>${esc(t.name)}</h2>
        <p class="muted num" id="trait-count">&nbsp;</p>
      </div>
      <a class="btn primary trait-start" href="${start}">Start a Credit Union for ${esc(credits(t))}</a>
    </header>
    ${pairTabs()}
  </section>`;

  bindPairTabs();
  void drawUnions(t);

  const grid = document.getElementById('trait-grid')!;
  const more = document.getElementById('trait-more') as HTMLButtonElement;
  let page = 0, shown = 0;
  const load = async () => {
    more.disabled = true;
    try {
      const res = await fetch('/edition/match', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...t.rules, page }) });
      if (!res.ok) throw new Error();
      const d = (await res.json()) as { count: number; sample: number[] };
      if (!grid.isConnected) return;
      if (page === 0) {
        document.getElementById('trait-count')!.textContent = `${d.count.toLocaleString()} ${d.count === 1 ? 'Credit' : 'Credits'} · ${pct(d.count)} of ${SUPPLY.toLocaleString()}`;
        document.getElementById('credits-n')!.textContent = d.count.toLocaleString();
        if (!d.count) grid.outerHTML = '<p class="muted">No Credit has it.</p>';
      }
      grid.insertAdjacentHTML('beforeend', creditTiles(d.sample));
      shown += d.sample.length;
      page++;
      const left = d.count - shown;
      more.hidden = left <= 0 || !d.sample.length;
      more.textContent = `Show more · ${left.toLocaleString()} left`;
    } catch {
      if (page === 0 && grid.isConnected) grid.outerHTML = '<p class="error">Couldn’t load Credits.</p>';
    }
    more.disabled = false;
  };
  more.addEventListener('click', load);
  await load();
}

/// Credits as a grid of their art, each linking to its page.
export const creditTiles = (ids: number[]) =>
  ids.map((id) => `<a class="pick" href="/credit/${id}" title="Credit #${id.toLocaleString()}"><img src="${editionArt(id)}" alt="Credit #${id}" loading="lazy" decoding="async"></a>`).join('');

const drawUnions = (t: TraitValue) => drawOpenUnions((b) => takes(b, t));

/// The two lists under a trait or time window, as tabs: the open Credit Unions that take these Credits, and the
/// Credits themselves. `note`: one line under the Credit Unions tab (how they were matched).
export const pairTabs = (note = '') => `<section class="trait-section pair">
      <div class="subtabs pair-tabs" role="tablist">
        <button type="button" role="tab" data-pane="unions" aria-selected="true">Credit Unions <span class="num muted" id="unions-n"></span></button>
        <button type="button" role="tab" data-pane="credits" aria-selected="false">Credits <span class="num muted" id="credits-n"></span></button>
      </div>
      <div class="pair-pane" data-pane="unions">${note ? `<p class="muted small time-rule">${note}</p>` : ''}<div id="trait-unions"><p class="muted">Checking open Credit Unions…</p></div></div>
      <div class="pair-pane" data-pane="credits" hidden><div class="trait-grid" id="trait-grid"></div><button type="button" class="btn block" id="trait-more" hidden>Show more</button></div>
    </section>`;

let pairPicked = false;
const showPane = (name: string) => {
  document.querySelectorAll<HTMLElement>('.pair-tabs [data-pane]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.pane === name)));
  document.querySelectorAll<HTMLElement>('.pair-pane').forEach((p) => (p.hidden = p.dataset.pane !== name));
};
/// Tab clicks switch panes; until someone clicks, the Credit Unions tab leads only when there are any.
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
  if (!pairPicked) showPane(open.length ? 'unions' : 'credits');
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
export const creditsHead = (current: string) =>
  pageHead({
    title: 'Credits',
    lede: 'Every Credit, by trait. Pick one to see who has it.',
    label: 'Credits',
    tabs: [['credits', 'Overview'], ...TRAIT_KINDS.map((k) => [k, valuesOf(k)[0].label]), ['time', 'Time'], ['rating', 'Rating'], ['bits', 'Bits']].map(([k, l]) => ({ href: `/${k}`, label: l, current: k === current })),
  });

/// A trait's index (/weight): each value as a tile with its glyph, name and how many Credits have it.
async function traitIndex(app: HTMLElement, kind: TraitKind) {
  if (!(TRAIT_KINDS as readonly string[]).includes(kind)) {
    app.innerHTML = `<section class="prose"><h1>Not found</h1></section>`;
    return;
  }
  const values = valuesOf(kind);
  const label = values[0].label;
  app.innerHTML = `
  <section class="trait-page">
    ${creditsHead(kind)}
    <h2 class="page-sub">${label}</h2>
    <div class="trait-values">${values
      .map((t) => `<a class="trait-value" href="${traitPath(t)}"><span class="trait-glyph sm ${t.kind}">${traitGlyph(t)}</span><span class="tv-name">${esc(t.name)}</span><span class="tv-count muted num" data-slug="${esc(t.slug)}">&nbsp;</span></a>`)
      .join('')}</div>
  </section>`;
  await Promise.all(
    values.map(async (t) => {
      try {
        const res = await fetch('/edition/match', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(t.rules) });
        const d = (await res.json()) as { count: number };
        const el = app.querySelector<HTMLElement>(`.tv-count[data-slug="${CSS.escape(t.slug)}"]`);
        if (el) el.textContent = `${d.count.toLocaleString()} · ${pct(d.count)}`;
      } catch {}
    }),
  );
}
