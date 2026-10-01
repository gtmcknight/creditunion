/// A Statement as a picture: one direction alone, or all eight in Jack's 4 × 2 (his 2000 × 1340 8-up, scaled), on a
/// background. The union page's All eight view and its shared images both draw through here.
import { compose, paint, PAGE, SHOWN, type Direction, type Ink } from '../shared/statement';

export type Pick = Direction | 'All';
export type Bg = 'black' | 'white' | 'grey';
export const BG: Record<Bg, string> = { black: '#000', white: '#fff', grey: '#eeeeec' };
export type Size = 'wide' | 'square';
export const SIZES: Record<Size, [number, number]> = { wide: [4000, 2680], square: [3200, 3200] }; // Jack's 2000 × 1340, at 2x

/// The share picture's settings, kept in this browser. Sizes are per kind: one direction starts Square, All Wide.
export type Prefs = { one: Size; all: Size; bg: Bg };
const PREF = 'cu-share';
export function prefs(): Prefs {
  let p: Partial<Prefs> = {};
  try {
    p = JSON.parse(localStorage.getItem(PREF) ?? '{}');
  } catch {}
  return { one: p.one === 'wide' ? 'wide' : 'square', all: p.all === 'square' ? 'square' : 'wide', bg: p.bg && p.bg in BG ? p.bg : 'black' };
}
export function keepPrefs(p: Prefs) {
  try {
    localStorage.setItem(PREF, JSON.stringify(p));
  } catch {}
}
export const sizeFor = (p: Prefs, pick: Pick) => (pick === 'All' ? p.all : p.one);

// Jack's 8-up, in his pixels: 346-wide pages, 68.67 across and 69 down between them, filling 1590 × 934 of 2000 × 1340.
const PW = 346, GX = (1590 - 4 * PW) / 3, GY = 69, PH = (PW * PAGE.h) / PAGE.w;

/// The eight three across: rows of light, dense, light, then dense, light, dense, so they alternate down the columns
/// too.
const SHOWN_3: readonly Direction[] = ['Issued', 'Liquidated', 'Accrued', 'Consolidated', 'Amortized', 'Assessed', 'Recorded', 'Reconciled'];
/// Draws `pick` into a W × H frame (device pixels). A single page stands 3/4 of the frame tall, at most 3/5 wide.
/// `label`: the union's name, for the ninth cell of the tall All eight.
export function drawPicture(g: CanvasRenderingContext2D, W: number, H: number, pick: Pick, list: (Ink | null)[], ghosts: ReadonlySet<number>, bg: Bg, label = '') {
  g.fillStyle = BG[bg];
  g.fillRect(0, 0, W, H);
  const pages: [Direction, number, number, number][] = [];
  if (pick === 'All') {
    // Four across, two down; in a frame taller than wide (the union page's 4:5 sheet), three across, a grid about as
    // tall as the frame, with the union's name and rating in the ninth cell. Either way light and dense formats
    // alternate like a checkerboard.
    const cols = H > W ? 3 : 4, rows = Math.ceil(8 / cols);
    const gw = cols * PW + (cols - 1) * GX, gh = rows * PH + (rows - 1) * GY;
    const k = H > W ? Math.min((0.84 * W) / gw, (0.84 * H) / gh) : Math.min((0.795 * W) / gw, (0.697 * H) / gh);
    const x0 = (W - gw * k) / 2, y0 = (H - gh * k) / 2;
    (cols === 3 ? SHOWN_3 : SHOWN).forEach((d, i) => pages.push([d, x0 + (i % cols) * (PW + GX) * k, y0 + Math.floor(i / cols) * (PH + GY) * k, PW * k]));
    if (cols === 3) caption(g, x0 + 2 * (PW + GX) * k, y0 + 2 * (PH + GY) * k, PW * k, PH * k, label, list, bg);
  } else {
    const h = Math.min(0.746 * H, 0.6 * W * (PAGE.h / PAGE.w)), w = (h * PAGE.w) / PAGE.h;
    pages.push([pick, (W - w) / 2, (H - h) / 2, w]);
  }
  for (const [d, x, y, w] of pages) {
    const X = Math.round(x), Y = Math.round(y), pw = Math.round(w);
    g.save();
    g.translate(X, Y);
    paint(g, pw, compose(d, list, ghosts));
    g.restore();
    // White paper on a white ground: a hairline keeps the page's edge.
    if (bg === 'white') {
      const t = Math.max(1, Math.round(W / 1600));
      g.fillStyle = '#dcdcd8';
      const ph = Math.round((pw * PAGE.h) / PAGE.w);
      g.fillRect(X - t, Y - t, pw + 2 * t, t);
      g.fillRect(X - t, Y + ph, pw + 2 * t, t);
      g.fillRect(X - t, Y, t, ph);
      g.fillRect(X + pw, Y, t, ph);
    }
  }
}

/// The ninth cell: name, Credit rating (the sum of its Credits' ratings, so far), set at its bottom left.
function caption(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, name: string, list: (Ink | null)[], bg: Bg) {
  const scores = list.flatMap((ink) => (ink?.score != null ? [ink.score] : []));
  // Says it's a preview, so nobody takes the 3 × 3 for a ninth format.
  const lines = [name, scores.length ? `Credit rating ${Math.round(scores.reduce((a, b) => a + b, 0)).toLocaleString('en-US')}` : '', 'Preview of all 8 formats'].filter(Boolean);
  const size = Math.round(w * 0.075), lead = Math.round(size * 1.45);
  g.textBaseline = 'alphabetic';
  lines.forEach((t, i) => {
    g.font = `${i ? 400 : 500} ${size}px Geist, sans-serif`;
    g.fillStyle = bg === 'black' ? (i ? '#8f8f8f' : '#f5f5f5') : i ? '#6b6b6b' : '#0a0a0a';
    let s = t;
    while (s.length > 1 && g.measureText(s).width > w) s = s.slice(0, -2) + '…';
    g.fillText(s, Math.round(x), Math.round(y + h - (lines.length - 1 - i) * lead));
  });
}
