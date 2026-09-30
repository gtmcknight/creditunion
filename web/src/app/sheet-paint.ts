/// Card sheets drawn on one canvas each, not 80 SVG images: Chrome rasterizes every SVG <img> on the main thread, and a
/// list of cards (4,000 of them) froze the tab for seconds as it opened and again as it closed. The cells stay (plain
/// elements, cheap) for everything that reads them; only their art moves to the canvas behind them, drawn from each
/// Credit's seed exactly as the contract draws it (worker/print.ts), misprints included.
import { printOf, type Rect } from '../worker/print';
import { seedsOf } from './directions';

/// A Credit's rects, worked out once per visit.
const prints = new Map<string, Promise<Rect[] | null>>();
function printFor(id: string, seed: [string, number, number] | null) {
  let p = prints.get(id);
  if (!p && seed) {
    p = printOf(Uint8Array.from(seed[0], (ch) => ch.charCodeAt(0)), seed[1]);
    prints.set(id, p);
  }
  return p ?? Promise.resolve(null);
}

const TILE = [60, 60, 200, 200]; // where a Credit's art sits in its 320 box: the grey stand-in covers the same
const EIGHTS_ROW = 290; // placeholders drop the Eights marks' row (y 290–320 of 320), as .cell.ghost img's clip does

const rectsOf = async (ids: (string | null)[]) => {
  const seeds = await seedsOf(ids);
  return Promise.all(ids.map((id, i) => (id ? printFor(id, seeds[i]) : null)));
};
const turn = new WeakMap<HTMLElement, number>();

/// The sheet's own Credits first, with a grey tile in every open slot; then again once its placeholders' seeds land.
async function paint(sheet: HTMLElement) {
  const canvas = sheet.previousElementSibling as HTMLCanvasElement | null;
  if (!canvas?.classList.contains('sheet-paint')) return;
  place(sheet, canvas); // the paper at its full size now, before the Credits' seeds come back
  const t = (turn.get(sheet) ?? 0) + 1;
  turn.set(sheet, t);
  const cells = [...sheet.children] as HTMLElement[];
  const ghosts = cells.map((c) => c.dataset.ghost ?? null);
  const own = await rectsOf(cells.map((c) => c.dataset.id ?? null));
  if (turn.get(sheet) !== t) return;
  draw(sheet, canvas, cells, own);
  if (!ghosts.some(Boolean)) return;
  const theirs = await rectsOf(ghosts);
  if (turn.get(sheet) !== t) return;
  draw(sheet, canvas, cells, own.map((r, i) => r ?? theirs[i]));
}

/// The canvas over the sheet exactly, in CSS pixels.
function place(sheet: HTMLElement, canvas: HTMLCanvasElement) {
  const w = sheet.offsetWidth, h = sheet.offsetHeight;
  if (w && h) Object.assign(canvas.style, { left: `${sheet.offsetLeft}px`, top: `${sheet.offsetTop}px`, width: `${w}px`, height: `${h}px` });
}

function draw(sheet: HTMLElement, canvas: HTMLCanvasElement, cells: HTMLElement[], rects: (Rect[] | null)[]) {
  if (!sheet.isConnected) return;
  // The canvas covers the sheet exactly, at device pixels.
  const w = sheet.offsetWidth, h = sheet.offsetHeight;
  if (!w || !h) return;
  place(sheet, canvas);
  const dpr = Math.min(3, devicePixelRatio || 1);
  const W = Math.round(w * dpr), H = Math.round(h * dpr);
  if (canvas.width !== W) canvas.width = W;
  if (canvas.height !== H) canvas.height = H;
  const g = canvas.getContext('2d')!;
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.globalAlpha = 1;
  g.fillStyle = '#fff';
  g.fillRect(0, 0, W, H);
  const dark = document.documentElement.dataset.mode === 'dark';
  const picture = !!sheet.closest('.card-art.picture');
  const ghostAlpha = picture ? 0.6 : dark ? 0.4 : 0.28;
  const keepEights = sheet.classList.contains('eights-rule');
  // An open union's empty slots, until their placeholders are drawn: a grey tile each, so the sheet reads full.
  const open = !!sheet.dataset.batch, settled = !!sheet.dataset.ghosted;
  cells.forEach((cell, i) => {
    const r = rects[i];
    if (!r && open && (cell.classList.contains('ghost') || (!settled && cell.classList.contains('empty')))) {
      const x0 = Math.round(cell.offsetLeft * dpr), y0 = Math.round(cell.offsetTop * dpr);
      const s = Math.round((cell.offsetLeft + cell.offsetWidth) * dpr) - x0;
      const k = s / 320;
      g.globalAlpha = 1;
      g.fillStyle = dark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)';
      g.fillRect(x0 + Math.round(TILE[0] * k), y0 + Math.round(TILE[1] * k), Math.round(TILE[2] * k), Math.round(TILE[3] * k));
      return;
    }
    if (!r) return;
    const ghost = cell.classList.contains('ghost');
    // Snapped to device pixels so neighbouring cells don't blur into each other.
    const x0 = Math.round(cell.offsetLeft * dpr), y0 = Math.round(cell.offsetTop * dpr);
    const s = Math.round((cell.offsetLeft + cell.offsetWidth) * dpr) - x0;
    const k = s / 320;
    g.globalAlpha = ghost ? ghostAlpha : 1;
    for (const [x, y, rw, rh, c] of r) {
      if (ghost && !keepEights && y >= EIGHTS_ROW) continue;
      g.fillStyle = `#${c.toString(16).padStart(6, '0')}`;
      const px = x0 + Math.round(x * k), py = y0 + Math.round(y * k);
      g.fillRect(px, py, x0 + Math.round((x + rw) * k) - px, y0 + Math.round((y + rh) * k) - py);
    }
  });
  g.globalAlpha = 1;
}

/// Sheets paint once they come near the screen, and again when they change size or their placeholders land.
const near = new IntersectionObserver(
  (entries) => {
    for (const e of entries)
      if (e.isIntersecting) {
        near.unobserve(e.target);
        sized.observe(e.target);
        void paint(e.target as HTMLElement);
      }
  },
  { rootMargin: '600px 0px' },
);
const sized = new ResizeObserver((entries) => {
  for (const e of entries) if (e.target.isConnected) void paint(e.target as HTMLElement);
});
new MutationObserver((records) => {
  for (const r of records)
    for (const n of r.addedNodes) {
      if (!(n instanceof HTMLElement)) continue;
      if (n.matches('.sheet.painted')) near.observe(n);
      n.querySelectorAll?.<HTMLElement>('.sheet.painted').forEach((s) => near.observe(s));
    }
}).observe(document.documentElement, { childList: true, subtree: true });
document.addEventListener('ghosts', (e) => {
  const s = e.target as HTMLElement;
  if (s.matches?.('.sheet.painted')) void paint(s);
});
