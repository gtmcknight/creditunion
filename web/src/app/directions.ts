/// The eight Statement directions under a sheet (a union's, or the create page's preview). Issued is the sheet
/// itself; the other seven are drawn from the Credits' ink (shared/statement.ts), read with their ratings.
/// Previews until Jack's Statement contract is out.
import { compose, DIRECTIONS, inkOf, paint as paintMarks, PAGE, type Direction, type Ink } from '../shared/statement';
import { ratings } from './data';

/// The create page adds its Rules view to the same row.
type Shown = Direction | 'Rules';
const drawnView = (d: Shown): d is Exclude<Direction, 'Issued'> => d !== 'Issued' && d !== 'Rules';

/// What each switch is showing, for the visit: pages re-render as Credits come in.
const showing = new Map<string, Shown>();
/// The direction to go back to when the create page leaves its Rules view.
const before = new Map<string, Direction>();
/// Each Credit's ink, read once.
const inks = new Map<string, Promise<Ink | null>>();
/// What each canvas last drew, so a resize can redraw it.
const drawn = new WeakMap<HTMLCanvasElement, { d: Direction; list: (Ink | null)[]; ghosts: ReadonlySet<number> }>();
const sized = new ResizeObserver((entries) => {
  for (const { target } of entries) {
    const last = drawn.get(target as HTMLCanvasElement);
    if (last) paint(target as HTMLCanvasElement, last.d, last.list, last.ghosts);
  }
});

/// The canvas the three drawn directions share; it sits over the sheet, inside the same `.dir-host`.
export const directionCanvas = '<canvas class="dir-canvas" hidden aria-hidden="true"></canvas>';

/// A 16-pixel glyph for each direction: what its sheet looks like, in one colour.
const GLYPH: Record<Direction, string> = {
  Issued: '<path fill="currentColor" d="M2 2h5v5H2zM9 2h5v5H9zM2 9h5v5H2zM9 9h5v5H9z"/>',
  Consolidated: '<path fill="currentColor" d="M2 2h12v12H2zM5 5v2h2V5zm4 2v2h2V7zM5 10v2h2v-2z" fill-rule="evenodd"/>',
  Accrued: '<path fill="none" stroke="currentColor" stroke-width="1.5" d="M4 3.5c2-1 3 .5 5 0s4.5 0 4.5 2.5-2 2.5-1.5 4.5-1 3-3.5 2.5-2.5 1-4.5 0S2 10 3 8 2 4.5 4 3.5z"/>',
  Allocated: '<path fill="none" stroke="currentColor" stroke-width="1.5" d="M2.75 2.75h10.5v10.5H2.75zM7 2.75 6 7.5l-3.25 1M6 7.5l3.5 2 1 3.75M9.5 9.5l3.75-2.5M9.5 2.75 11 7"/>',
  Balanced: '<path fill="currentColor" d="M2 2h5v12H2zM8 2h6v6H8zM8 9h3v5H8zM12 9h2v5h-2z"/>',
  Amortized: '<path fill="none" stroke="currentColor" stroke-width="1.5" d="M2.75 2.75h10.5v10.5H2.75zM5.75 5.75h4.5v4.5h-4.5z"/>',
  Reconciled: '<path fill="currentColor" d="M2 2h12v2H2zM2 5.5h8v2H2zM2 9h10v2H2zM2 12.5h6v2H2z"/>',
  Voided: '<path fill="none" stroke="currentColor" stroke-width="1.25" d="M2.6 2.6h3.8v3.8H2.6zM9.6 2.6h3.8v3.8H9.6zM2.6 9.6h3.8v3.8H2.6zM9.6 9.6h3.8v3.8H9.6z"/>',
};

/// The directions as one row of glyphs, each named in its tooltip. `rules` adds the create page's Rules view in
/// front, hidden until a design is painted.
export function directions(key: string, rules = false) {
  const k = key.toLowerCase(), on = showing.get(k) ?? 'Issued';
  const all: Shown[] = rules ? ['Rules', ...DIRECTIONS] : [...DIRECTIONS];
  return `<div class="dirs" role="radiogroup" aria-label="Statement direction" data-key="${k}">${all
    .map((d) => {
      const attrs = `type="button" role="radio" data-dir="${d}" aria-checked="${d === on}" tabindex="${d === on ? 0 : -1}"`;
      return d === 'Rules'
        ? `<button ${attrs} class="dir-word" hidden>Rules</button>`
        : `<button ${attrs} class="dir-glyph" aria-label="${d}" data-tip="${d}"><svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">${GLYPH[d]}</svg></button>`;
    })
    .join('')}</div>`;
}

/// After a render: redraw whatever direction each switch was showing.
export function mountDirections(root: ParentNode = document) {
  root.querySelectorAll<HTMLElement>('.dirs').forEach((g) => {
    const d = showing.get(g.dataset.key!);
    if (d && drawnView(d)) void show(g, d, false, true);
  });
}

/// The create page's Rules view, switched from its own controls: on shows Rules, off goes back to the direction.
export function rulesView(g: HTMLElement | null, on: boolean) {
  if (!g) return;
  const key = g.dataset.key!, now = showing.get(key) ?? 'Issued';
  if (on && now !== 'Rules') before.set(key, now), void show(g, 'Rules', false, true);
  if (!on && now === 'Rules') void show(g, before.get(key) ?? 'Issued', false, true);
}

/// The sheet's 80 slots in burn order: each Credit in it, or the example Credit shown faded in an empty slot. The
/// host's `data-show` changes what's faded: `finished` draws the examples at full ink, `yours` fades everyone else's.
function slotsOf(g: HTMLElement) {
  const host = g.closest<HTMLElement>('.dir-host');
  const cells = [...(host?.querySelector('.sheet')?.children ?? [])] as HTMLElement[];
  const ids = cells.map((c) => c.dataset.id ?? c.dataset.ghost ?? null);
  // A host marked solid-ghosts draws its examples at full ink (the create page's picture preview).
  const show = host?.classList.contains('solid-ghosts') ? 'finished' : (host?.dataset.show ?? 'now');
  const faded = (c: HTMLElement) => (show === 'yours' ? !c.classList.contains('mine') : show === 'now' && !!c.dataset.ghost);
  const ghosts = new Set(cells.flatMap((c, i) => (faded(c) ? [i] : [])));
  return { ids, ghosts };
}

function load(slots: readonly (string | null)[]): Promise<(Ink | null)[]> {
  const need = [...new Set(slots.filter((s): s is string => !!s && !inks.has(s)))];
  if (need.length) {
    const read = ratings(need.map(BigInt)).then(
      (r) => r.ratings,
      () => {
        for (const id of need) inks.delete(id); // try again next time
        return {} as Awaited<ReturnType<typeof ratings>>['ratings'];
      },
    );
    for (const id of need) inks.set(id, read.then((r) => (r[id]?.seed ? inkOf(r[id].seed, r[id].paidAt, r[id].score) : null)));
  }
  return Promise.all(slots.map((s) => (s ? (inks.get(s) ?? null) : null)));
}

/// `quiet` changes are the page's own; the rest tell it with a `direction` event.
async function show(g: HTMLElement, d: Shown, focus = false, quiet = false) {
  const key = g.dataset.key!;
  showing.set(key, d);
  g.querySelectorAll<HTMLButtonElement>('[data-dir]').forEach((b) => {
    const on = b.dataset.dir === d;
    b.setAttribute('aria-checked', String(on));
    b.tabIndex = on ? 0 : -1;
    if (on && focus) b.focus();
  });
  if (!quiet) g.dispatchEvent(new CustomEvent('direction', { bubbles: true, detail: d }));
  const host = g.closest<HTMLElement>('.dir-host');
  const canvas = host?.querySelector<HTMLCanvasElement>('.dir-canvas');
  if (!host || !canvas) return;
  host.classList.toggle('dir-on', drawnView(d));
  canvas.hidden = !drawnView(d);
  if (!drawnView(d)) return;
  sized.observe(canvas);
  const { ids, ghosts } = slotsOf(g);
  // Faint frames at once; the ink as soon as it's read (the first time only).
  const last = drawn.get(canvas);
  paint(canvas, d, last?.list ?? ids.map(() => null), last?.ghosts ?? ghosts);
  const list = await load(ids);
  if (showing.get(key) === d && canvas.isConnected) paint(canvas, d, list, ghosts);
}

/// Crisp cells, snapped to device pixels, as Jack's mock draws them.
function paint(canvas: HTMLCanvasElement, d: Direction, list: (Ink | null)[], ghosts: ReadonlySet<number>) {
  drawn.set(canvas, { d, list, ghosts });
  const w = canvas.clientWidth;
  if (!w) return;
  const W = Math.round(w * Math.min(3, devicePixelRatio || 1)), H = Math.round((W * PAGE.h) / PAGE.w);
  if (canvas.width !== W) canvas.width = W;
  if (canvas.height !== H) canvas.height = H;
  paintMarks(canvas.getContext('2d')!, W, compose(d, list, ghosts));
}

document.addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLButtonElement>('.dirs [data-dir]');
  if (b) void show(b.closest<HTMLElement>('.dirs')!, b.dataset.dir as Shown);
});
// Read the ink on the way to a click.
document.addEventListener('pointerover', (e) => {
  const g = (e.target as HTMLElement).closest?.<HTMLElement>('.dirs');
  if (g) void load(slotsOf(g).ids);
});
// Example Credits land in a union's empty slots after its sheet renders: redraw with them.
document.addEventListener('ghosts', (e) => {
  const g = (e.target as HTMLElement).closest('.dir-host')?.querySelector<HTMLElement>('.dirs');
  const d = g && showing.get(g.dataset.key!);
  if (g && d && drawnView(d)) void show(g, d, false, true);
});
// ← and → flip through the words, from the switch or from anywhere on the page that isn't taking keys itself.
document.addEventListener('keydown', (e) => {
  if ((e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || e.defaultPrevented) return;
  const t = e.target as HTMLElement;
  const inside = t.closest?.<HTMLElement>('.dirs');
  if (!inside && t !== document.body && !t.closest?.('.dir-host')) return;
  if (document.querySelector('dialog[open]')) return;
  const g = inside ?? document.querySelector<HTMLElement>('.dirs');
  if (!g || !g.offsetParent) return;
  const all = [...g.querySelectorAll<HTMLElement>('[data-dir]:not([hidden])')].map((b) => b.dataset.dir as Shown);
  const at = Math.max(0, all.indexOf(showing.get(g.dataset.key!) ?? 'Issued'));
  e.preventDefault();
  void show(g, all[(at + (e.key === 'ArrowRight' ? 1 : all.length - 1)) % all.length], !!inside);
});
