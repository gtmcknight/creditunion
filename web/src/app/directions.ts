/// The eight Statement formats under a sheet (a union's, or the create page's preview), in the order the Statements
/// contract lists them. Issued is the sheet itself; the other seven are drawn from the Credits' ink
/// (shared/statement.ts), so a preview is what the contract draws.
import { compose, inkOf, paint as paintMarks, PAGE, SHOWN, slotBox, type Direction, type Ink } from '../shared/statement';
import { seeds, type Seed } from './data';
import { drawPicture, type Pick } from './pictures';

/// The create page adds its Rules view to the same row.
/// A union's page adds All eight (the eight side by side) in front of them.
type Shown = Pick | 'Rules';
const drawnView = (d: Shown): d is Exclude<Pick, 'Issued'> => d !== 'Issued' && d !== 'Rules';

/// What each switch is showing, for the visit: pages re-render as Credits come in.
const showing = new Map<string, Shown>();
/// Switches whose viewer picked a direction themselves (a click or a key), not the page.
const clicked = new Set<string>();
/// The direction to go back to when the create page leaves its Rules view.
const before = new Map<string, Pick>();
/// Each Credit's ink, read once.
const inks = new Map<string, Promise<Ink | null>>();
/// What each canvas last drew, so a resize can redraw it.
const drawn = new WeakMap<HTMLCanvasElement, { d: Pick; list: (Ink | null)[]; ghosts: ReadonlySet<number>; marks?: ReadonlySet<number> }>();
const sized = new ResizeObserver((entries) => {
  for (const { target } of entries) {
    const last = drawn.get(target as HTMLCanvasElement);
    if (last) paint(target as HTMLCanvasElement, last.d, last.list, last.ghosts, last.marks);
  }
});

/// What a canvas is showing now (a union's drawn direction), for hover cards over it.
export const canvasShowing = (c: HTMLCanvasElement) => drawn.get(c)?.d;

/// The canvas the three drawn directions share; it sits over the sheet, inside the same `.dir-host`.
export const directionCanvas = '<canvas class="dir-canvas" hidden aria-hidden="true"></canvas>';

/// A 16-pixel glyph for each direction, what its sheet looks like. Every glyph fills the same page-shaped box with about the same ink, lines at 1.25 (Share matches).
export const GLYPH: Record<Direction, string> = {
  Issued: '<path fill="currentColor" d="M2.5 3h2.5v2.5h-2.5zM2.5 7.25h2.5v2.5h-2.5zM2.5 11.5h2.5v2.5h-2.5zM6.75 3h2.5v2.5h-2.5zM6.75 7.25h2.5v2.5h-2.5zM6.75 11.5h2.5v2.5h-2.5zM11 3h2.5v2.5h-2.5zM11 7.25h2.5v2.5h-2.5zM11 11.5h2.5v2.5h-2.5z"/>', // Credits spaced on the page
  Consolidated: '<path fill="currentColor" d="M2 1h2v2h-2zM6 1h2v2h-2zM8 1h2v2h-2zM12 1h2v2h-2zM4 3h2v2h-2zM8 3h2v2h-2zM10 3h2v2h-2zM2 5h2v2h-2zM6 5h2v2h-2zM10 5h2v2h-2zM12 5h2v2h-2zM2 7h2v2h-2zM4 7h2v2h-2zM8 7h2v2h-2zM12 7h2v2h-2zM4 9h2v2h-2zM6 9h2v2h-2zM10 9h2v2h-2zM2 11h2v2h-2zM6 11h2v2h-2zM8 11h2v2h-2zM12 11h2v2h-2zM4 13h2v2h-2zM8 13h2v2h-2zM10 13h2v2h-2z"/>', // cells butted into one mosaic
  Assessed: '<path fill="currentColor" d="M2.5 2h5.5v5.5H2.5zM8.5 8.5h5v5.5h-5zM9 2.5h1v1h-1zM11 2.5h1v1h-1zM13 2.5h1v1h-1zM9 4.5h1v1h-1zM11 4.5h1v1h-1zM13 4.5h1v1h-1zM9 6.5h1v1h-1zM11 6.5h1v1h-1zM13 6.5h1v1h-1zM3 9h1v1h-1zM5 9h1v1h-1zM7 9h1v1h-1zM3 11h1v1h-1zM5 11h1v1h-1zM7 11h1v1h-1zM3 13h1v1h-1zM5 13h1v1h-1zM7 13h1v1h-1z"/>', // each Credit a block of its mix, dithered to how much it inks
  Accrued: '<path fill="none" stroke="currentColor" stroke-width="1.25" stroke-linejoin="round" d="M5 1.9c1.6-.5 2.6.4 4 .1 1.9-.4 3.7.3 3.7 2.6 0 1.7-1.2 2.3-.8 3.9.4 1.6.9 2.6-.1 4.2-.9 1.5-2.8 1.3-4 1.8-1.5.6-3.3.2-4-1.4-.6-1.4.4-2.4.1-3.9C3.6 7.6 2.7 6.6 3 4.9c.3-1.6 1-2.6 2-3zM6.2 5.4c1-.5 2.6-.2 2.6 1 0 1.1-1.5 1-2.2 1.8-.6.6-1.6.3-1.5-.8.1-.9.5-1.6 1.1-2z"/>', // a contour, a loop inside it
  Amortized: '<path fill="none" stroke="currentColor" stroke-width="1.25" d="M2.6 1.6h10.8v12.8H2.6zM5.1 4.1h5.8v3h-2v4.8H5.1z"/>', // stepped edges between depths
  Liquidated: '<path fill="currentColor" d="M2.6 1.8h10.8v1.6H2.6zM2.6 4.4h10.8v2.4H2.6zM2.6 7.8h10.8v1.4H2.6zM2.6 10.2h10.8v4H2.6z"/>', // the page's ink poured into bands
  Recorded: '<path fill="currentColor" fill-rule="evenodd" d="M3.65 2.2h1.2v3h-1.2zM6.75 2.2h2.5v3H6.75zM7.6 3.05v1.3h0.8v-1.3zM11.15 2.2h1.2v3h-1.2zM3 6.4h2.5v3H3zM3.85 7.25v1.3h0.8v-1.3zM7.4 6.4h1.2v3h-1.2zM10.5 6.4h2.5v3H10.5zM11.35 7.25v1.3h0.8v-1.3zM3.65 10.6h1.2v3h-1.2zM7.4 10.6h1.2v3h-1.2zM10.5 10.6h2.5v3H10.5zM11.35 11.45v1.3h0.8v-1.3z"/>', // every pixel written as a 1 or a 0
  Reconciled: '<path fill="currentColor" d="M2 1.5h12V3H2zM2 4.5h8V6H2zM2 7.5h10.5V9H2zM2 10.5h6V12H2zM2 13.5h9V15H2z"/>', // one row per Credit, ragged right
};

export const glyph = (paths: string) => `<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">${paths}</svg>`;

/// The buttons of a row, the eight with All in front if `all`; `attr` names the attribute each carries its direction in.
function row(radio: (d: Pick) => string, attr: string, all: boolean) {
  // All is a word, not a glyph: a way to look at the eight, not a ninth format.
  return [...(all ? ['All' as const] : []), ...SHOWN]
    .map((d) =>
      d === 'All'
        ? `<button ${radio(d)} ${attr}="All" class="dir-word" aria-label="Preview all 8 formats">All formats</button>`
        : `<button ${radio(d)} ${attr}="${d}" class="dir-glyph" aria-label="${d}" data-tip="${d}">${glyph(GLYPH[d])}</button>`,
    )
    .join('');
}
/// The same row for somewhere else (the share modal): `data-pick`, not wired to any sheet.
export const pickRow = (on: Pick) =>
  `<div class="dirs dir-row" role="radiogroup" aria-label="Format">${row((d) => `type="button" role="radio" aria-checked="${d === on}"`, 'data-pick', true)}</div>`;

/// The switch: one row of glyphs, each named in its tooltip. `all` puts All eight in front of the eight (a union's
/// page); `rules` puts the create page's Painted view (the hand-painted design; 'Rules' inside) in front, hidden until
/// a design is painted.
export function directions(key: string, rules = false, all = false) {
  const k = key.toLowerCase(), on = showing.get(k) ?? 'Issued';
  const radio = (d: Shown) => `type="button" role="radio" aria-checked="${d === on}" tabindex="${d === on ? 0 : -1}"`;
  return `<div class="dirs" role="radiogroup" aria-label="Statement format" data-key="${k}">${
    rules ? `<button ${radio('Rules')} data-dir="Rules" class="dir-word" hidden>Painted</button>` : ''
  }${row(radio, 'data-dir', all)}</div>`;
}

/// A still Statement over a sheet with no switch (a picture union's card): its Credits as Now shows them,
/// drawn in `d` on a canvas laid over the sheet. Redrawn when the sheet's example Credits land.
export async function drawStill(host: HTMLElement, d: Direction) {
  const cells = [...(host.querySelector('.sheet')?.children ?? [])] as HTMLElement[];
  const ids = cells.map((c) => c.dataset.id ?? c.dataset.ghost ?? null);
  // As Now shows it: the Credits already in at full ink, the planned ones still to come faded.
  const faded = new Set(cells.flatMap((c, i) => (c.dataset.ghost && !c.dataset.id ? [i] : [])));
  const canvasOf = () => {
    let c = host.querySelector<HTMLCanvasElement>(':scope > .dir-canvas');
    if (!c) {
      c = document.createElement('canvas');
      c.className = 'dir-canvas still';
      host.append(c);
    }
    return c;
  };
  const key = host.dataset.portrait;
  // The sheet's own grid stays up until every Credit's ink is read, then the Statement replaces it whole: no grey
  // frames while it loads.
  const list = await load(ids);
  if (!host.isConnected) return;
  const canvas = canvasOf();
  host.classList.add('dir-on');
  sized.observe(canvas);
  paint(canvas, d, list, faded);
  if (key) saveSnapshot(key, canvas);
}

/// A card's last drawing, per union and its Credits, kept small in this browser (a 256 × 320 PNG, a few KB).
const SNAP = 'cu-portrait:';
/// A picture card's last drawing, shown at once (before its Credits are placed or their ink read).
export function showStill(host: HTMLElement) {
  const key = host.dataset.portrait;
  if (!key || drawn.get(host.querySelector(':scope > .dir-canvas') as HTMLCanvasElement)) return;
  void showSnapshot(host, key, () => {
    let c = host.querySelector<HTMLCanvasElement>(':scope > .dir-canvas');
    if (!c) {
      c = document.createElement('canvas');
      c.className = 'dir-canvas still';
      host.append(c);
    }
    return c;
  });
}
async function showSnapshot(host: HTMLElement, key: string, canvasOf: () => HTMLCanvasElement) {
  let url: string | null = null;
  try {
    url = localStorage.getItem(SNAP + key);
  } catch {}
  if (!url) return;
  const img = new Image();
  img.src = url;
  await img.decode().catch(() => null);
  const canvas = canvasOf();
  if (!host.isConnected || drawn.get(canvas)) return; // the real drawing got there first
  const w = canvas.clientWidth || 256, W = Math.round(w * Math.min(3, devicePixelRatio || 1));
  canvas.width = W;
  canvas.height = Math.round((W * PAGE.h) / PAGE.w);
  const g = canvas.getContext('2d')!;
  g.imageSmoothingEnabled = false;
  g.drawImage(img, 0, 0, canvas.width, canvas.height);
  host.classList.add('dir-on');
}
function saveSnapshot(key: string, canvas: HTMLCanvasElement) {
  try {
    const small = document.createElement('canvas');
    small.width = 256;
    small.height = 320;
    const g = small.getContext('2d')!;
    g.imageSmoothingEnabled = false;
    g.drawImage(canvas, 0, 0, 256, 320);
    const union = key.split(':')[0];
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k?.startsWith(SNAP + union + ':') && k !== SNAP + key) localStorage.removeItem(k); // one per union
    }
    localStorage.setItem(SNAP + key, small.toDataURL('image/png'));
  } catch {}
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

/// Switch a row to a direction from the page's own controls (no `direction` event back).
/// Whether a switch's direction was picked (by a click or a key) rather than left at its default.
export const pickedDirection = (key: string) => showing.has(key.toLowerCase());
/// Whether the viewer picked a direction themselves, so the page shouldn't switch it for them.
export const viewerPicked = (key: string) => clicked.has(key.toLowerCase());

export function showDirection(g: HTMLElement | null, d: Direction) {
  if (g && showing.get(g.dataset.key!) !== d) void show(g, d, false, true);
}

/// The sheet's 80 slots in burn order: each Credit in it, or the example Credit shown faded in an empty slot. The
/// host's `data-show` changes what's faded: `finished` draws the examples at full ink, `yours` fades everyone else's.
function slotsOf(g: HTMLElement) {
  return hostSlots(g.closest<HTMLElement>('.dir-host'));
}
function hostSlots(host: HTMLElement | null) {
  const cells = [...(host?.querySelector('.sheet')?.children ?? [])] as HTMLElement[];
  const ids = cells.map((c) => c.dataset.id ?? c.dataset.ghost ?? null);
  // A host marked solid-ghosts draws its examples at full ink (the create page's picture preview).
  const show = host?.classList.contains('solid-ghosts') ? 'finished' : (host?.dataset.show ?? 'now');
  // A planned Credit picked to go in (a picture union's `chosen`) shows at full ink in its spot.
  const faded = (c: HTMLElement) => (show === 'yours' ? !c.classList.contains('mine') : show === 'now' && !!c.dataset.ghost && !c.classList.contains('chosen'));
  const ghosts = new Set(cells.flatMap((c, i) => (faded(c) ? [i] : [])));
  // …and framed, so it shows which spot it takes.
  const marks = new Set(cells.flatMap((c, i) => (c.classList.contains('chosen') ? [i] : [])));
  return { ids, ghosts, marks };
}

/// A sheet's Credits read for drawing elsewhere (the share images): each slot's ink, the faded slots, and the
/// direction its switch shows (Issued when it has none).
export async function sheetInks(host: HTMLElement): Promise<{ list: (Ink | null)[]; ghosts: ReadonlySet<number>; direction: Pick }> {
  const { ids, ghosts } = hostSlots(host);
  const d = showing.get(host.querySelector<HTMLElement>('.dirs')?.dataset.key ?? '');
  return { list: await load(ids), ghosts, direction: d && d !== 'Rules' ? d : 'Issued' };
}

/// A Credit's seed never changes, so what's been read is kept in this browser too: a repeat visit draws at once.
const SEEDS = 'cu-seeds-v1', KEEP = 4000; // keys are 'c' + id, so they keep insertion order (oldest drop first)
let kept: Record<string, Seed> = {};
try {
  kept = JSON.parse(localStorage.getItem(SEEDS) ?? '{}');
} catch {}
let saving = 0;
function keep(id: string, v: Seed) {
  kept['c' + id] = v;
  clearTimeout(saving);
  saving = window.setTimeout(() => {
    try {
      const all = Object.entries(kept);
      if (all.length > KEEP) kept = Object.fromEntries(all.slice(-KEEP));
      localStorage.setItem(SEEDS, JSON.stringify(kept));
    } catch {}
  }, 500);
}
/// Start reading these Credits' ink now, so a later draw finds it ready.
export const warmInks = (ids: readonly (bigint | string)[]) => void load(ids.map(String));

/// Seeds handed over with a page's data (a picture's planned Credits): drawn without asking for them.
export function primeInks(seeds: Record<string, Seed> | undefined) {
  for (const [id, v] of Object.entries(seeds ?? {})) {
    if (!inks.has(id)) inks.set(id, Promise.resolve(inkOf(v[0], v[1], v[2])));
    if (!kept['c' + id]) keep(id, v);
  }
}

function load(slots: readonly (string | null)[]): Promise<(Ink | null)[]> {
  for (const s of slots) {
    const k = s && !inks.has(s) ? kept['c' + s] : undefined;
    if (k) inks.set(s!, Promise.resolve(inkOf(k[0], k[1], k[2])));
  }
  const need = [...new Set(slots.filter((s): s is string => !!s && !inks.has(s)))];
  if (need.length) {
    const read = seeds(need).catch(() => {
      for (const id of need) inks.delete(id); // try again next time
      return {} as Record<string, Seed>;
    });
    for (const id of need)
      inks.set(id, read.then((r) => {
        const v = r[id];
        if (!v?.[0]) return null;
        keep(id, v);
        return inkOf(v[0], v[1], v[2]);
      }));
  }
  return Promise.all(slots.map((s) => (s ? (inks.get(s) ?? null) : null)));
}

/// Each Credit's seed and payment second (what its art is drawn from), from this browser's keep or a ratings read.
/// Asked for in the same moment (every card on a page), they go out together, 500 to a request.
const seedReads = new Map<string, Promise<Seed | null>>();
let seedAsk: Map<string, (v: Seed | null) => void> | null = null;
async function askSeeds() {
  const all = seedAsk!;
  seedAsk = null;
  const ids = [...all.keys()], parts: string[][] = [];
  for (let i = 0; i < ids.length; i += 500) parts.push(ids.slice(i, i + 500));
  await Promise.all(
    parts.map(async (part) => {
      const r = await seeds(part).catch(() => null);
      for (const id of part) {
        const seed = r?.[id];
        if (!seed?.[0]) {
          seedReads.delete(id); // asked again next time
          all.get(id)!(null);
          continue;
        }
        keep(id, seed);
        all.get(id)!(seed);
      }
    }),
  );
}
export function seedsOf(ids: readonly (string | null)[]): Promise<(Seed | null)[]> {
  for (const id of ids) {
    if (!id || kept['c' + id] || seedReads.has(id)) continue;
    seedReads.set(
      id,
      new Promise((done) => {
        if (!seedAsk) {
          seedAsk = new Map();
          setTimeout(askSeeds, 30);
        }
        seedAsk.set(id, done);
      }),
    );
  }
  return Promise.all(ids.map((s) => (!s ? null : kept['c' + s] ? kept['c' + s] : (seedReads.get(s) ?? null))));
}

/// `quiet` changes are the page's own; the rest tell it with a `direction` event.
async function show(g: HTMLElement, d: Shown, focus = false, quiet = false) {
  const key = g.dataset.key!;
  showing.set(key, d);
  if (!quiet) clicked.add(key);
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
  const { ids, ghosts, marks } = slotsOf(g);
  // Faint frames at once; the ink as soon as it's read (the first time only).
  const last = drawn.get(canvas);
  paint(canvas, d, last?.list ?? ids.map(() => null), last?.ghosts ?? ghosts, marks);
  // Only the latest draw paints: an earlier one (say, of the example Credits before a picture's plan filled the
  // sheet) whose ink arrives late must not paint over it.
  const turn = (turns.get(canvas) ?? 0) + 1;
  turns.set(canvas, turn);
  const list = await load(ids);
  if (showing.get(key) !== d || !canvas.isConnected || turns.get(canvas) !== turn) return;
  paint(canvas, d, list, ghosts, marks);
  // A Credit whose ink didn't come (a failed or throttled read) would stay a grey frame: read it again, twice at most.
  const tries = retries.get(canvas) ?? 0;
  if (tries < 2 && list.some((ink, i) => ids[i] && !ink)) {
    retries.set(canvas, tries + 1);
    setTimeout(() => showing.get(key) === d && canvas.isConnected && void show(g, d, false, true), 1500 * (tries + 1));
  } else retries.delete(canvas);
}
const retries = new WeakMap<HTMLCanvasElement, number>();
const turns = new WeakMap<HTMLCanvasElement, number>();

/// Crisp cells, snapped to device pixels. `marks`: slots to frame (a picture union's picked Credits, in the formats
/// that keep each Credit in its own place).
function paint(canvas: HTMLCanvasElement, d: Pick, list: (Ink | null)[], ghosts: ReadonlySet<number>, marks?: ReadonlySet<number>) {
  drawn.set(canvas, { d, list, ghosts, marks });
  const w = canvas.clientWidth;
  if (!w) return;
  const W = Math.round(w * Math.min(3, devicePixelRatio || 1)), H = Math.round((W * PAGE.h) / PAGE.w);
  if (canvas.width !== W) canvas.width = W;
  if (canvas.height !== H) canvas.height = H;
  const name = canvas.closest<HTMLElement>('.dir-host')?.dataset.name ?? '';
  if (d === 'All') return drawPicture(canvas.getContext('2d')!, W, H, 'All', list, ghosts, 'black', name);
  const g = canvas.getContext('2d')!;
  paintMarks(g, W, compose(d, list, ghosts));
  if (!marks?.size) return;
  // Black outside, white inside: the frame shows on light ink and dark alike.
  const k = W / PAGE.w, line = Math.max(1, Math.round(W / 480));
  g.lineWidth = line;
  for (const c of marks) {
    const b = slotBox(d, c);
    if (!b) continue;
    const [x, y, w, h] = [Math.round(b[0] * k), Math.round(b[1] * k), Math.round(b[2] * k), Math.round(b[3] * k)];
    g.strokeStyle = '#111111';
    g.strokeRect(x - line / 2, y - line / 2, w + line, h + line);
    g.strokeStyle = '#ffffff';
    g.strokeRect(x + line / 2, y + line / 2, w - line, h - line);
  }
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
