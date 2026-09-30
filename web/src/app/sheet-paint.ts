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

const EIGHTS_ROW = 290; // placeholders drop the Eights marks' row (y 290–320 of 320), as .cell.ghost img's clip does

async function paint(sheet: HTMLElement) {
  const canvas = sheet.previousElementSibling as HTMLCanvasElement | null;
  if (!canvas?.classList.contains('sheet-paint')) return;
  const cells = [...sheet.children] as HTMLElement[];
  const ids = cells.map((c) => c.dataset.id ?? c.dataset.ghost ?? null);
  const seeds = await seedsOf(ids);
  const rects = await Promise.all(ids.map((id, i) => (id ? printFor(id, seeds[i]) : null)));
  if (!sheet.isConnected) return;
  // The canvas covers the sheet exactly, at device pixels.
  const w = sheet.offsetWidth, h = sheet.offsetHeight;
  if (!w || !h) return;
  Object.assign(canvas.style, { left: `${sheet.offsetLeft}px`, top: `${sheet.offsetTop}px`, width: `${w}px`, height: `${h}px` });
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
  cells.forEach((cell, i) => {
    const r = rects[i];
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
