/// The views of an overprinted Statement. Each is a picture composed at 1080 × 1350, the Statement's own 4:5, drawn
/// that way in its frame and in the files it exports; given the page's width, a view lays itself out wider:
///   Statement  its print run, a page at a time in the contract's layer order, played or scrubbed by hand;
///   Stack      its pages lifted apart in the air, turned and spread by hand;
///   Cells      one cell of it and the Credits printed into that cell, one from each page;
///   Tree       what was burned onto what: each overprint a pair joined by a line, and what it made;
///   Equation   the whole of it as one equation, brackets round what was burned together first;
///   Sums       each overprint as a sum, oldest first;
///   Formats    the Statement in all eight formats;
///   Credits    every Credit in it, a sheet for each page.
/// Every drawing is the Credits' ink ORed page by page, which is what the contract stores, so it matches the contract.
/// The Statement and the Stack move (the print run plays; the Stack fans open, turns with a throw and loops), and play
/// and export as films; every other view shows up finished and answers the pointer: what it's on shows large beside
/// the frame, a drag scrubs the print run. What you can interrupt chases its target, so nothing jumps. A film is a
/// pure function of its time.
import { paperColor } from '../shared/formats/statement-renderers';
import { BLACK_PAPER_PAGES, layered, MIX, paint, PAGE, SHOWN, slotAt, slotBox, type Direction, type Ink, type Mark } from '../shared/statement';

export const VW = 1080, VH = 1350;
const M = 72; // the margin round every picture
const CAP = 64; // the caption band at its foot
const TEXT = 26; // captions
const SMALL = 22; // names under drawings
const STACK_MAX = 32;

/// A cubic Bézier easing, as CSS draws one.
function bezier(x1: number, y1: number, x2: number, y2: number) {
  const at = (a: number, b: number, t: number) => 3 * a * t * (1 - t) * (1 - t) + 3 * b * t * t * (1 - t) + t * t * t;
  return (x: number) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let lo = 0, hi = 1, t = x;
    for (let i = 0; i < 24; i++) {
      t = (lo + hi) / 2;
      if (at(x1, x2, t) < x) lo = t;
      else hi = t;
    }
    return at(y1, y2, t);
  };
}
const easeOut = bezier(0.23, 1, 0.32, 1); // entrances: quick, then settling
const easeInOut = bezier(0.77, 0, 0.175, 1); // movement across the picture
const clamp = (x: number, a = 0, b = 1) => Math.min(b, Math.max(a, x));
/// Progress through a window of time, eased.
const span = (t: number, start: number, dur: number, f = easeOut) => f(clamp((t - start) / dur));
/// Chase a target: the step an interruptible value takes this frame (rate per second).
const chase = (v: number, to: number, dt: number, rate: number) => v + (to - v) * (1 - Math.exp(-rate * dt));
const count = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
const still = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

export type Page = { id: bigint; parent: bigint | null; from: number[]; own: bigint; children: bigint[]; format: Direction };
export type ViewKey = 'statement' | 'stack' | 'cells' | 'tree' | 'equation' | 'sums' | 'formats' | 'credits' | 'timeline';
/// The eight views in the menu over the frame. All eight formats is the format row's first choice under it, as on a
/// union's sheet.
export const VIEWS: [ViewKey, string][] = [
  ['statement', 'Statement'],
  ['stack', 'Stack'],
  ['cells', 'Cells'],
  ['tree', 'Tree'],
  ['equation', 'Equation'],
  ['sums', 'Sums'],
  ['credits', 'Credits'],
  ['timeline', 'Timeline'],
];
export type Theme = { ground: string; fg: string; muted: string; line: string };
/// One overprint: `top` (with everything on it) burned onto `base`, its `k`th. The base held pages base..before-1
/// and holds base..after-1 after.
type Step = { base: number; top: number; k: number; before: number; after: number };

/// A Statement's pages in the contract's historyOf order, their Credits' ink, and its overprints oldest first.
export class Book {
  readonly kids: number[][];
  readonly size: number[];
  readonly steps: Step[] = [];
  /// A format picked from the row under the frame: this Statement's own drawings take it; the Statements burned
  /// onto it keep theirs.
  picked: Direction | null = null;
  constructor(
    readonly pages: Page[],
    readonly inks: (Ink | null)[][],
  ) {
    const index = new Map(pages.map((p, i) => [p.id, i]));
    this.kids = pages.map((p) => p.children.map((c) => index.get(c)).filter((x): x is number => x != null));
    // A page's children come after it in the history, so sizes fill in from the end.
    this.size = pages.map(() => 1);
    for (let i = pages.length - 1; i >= 0; i--) this.size[i] = 1 + this.kids[i].reduce((t, k) => t + this.size[k], 0);
    // What's on a page went on before that page went onto another: the order the contract allows, which is the order
    // they happened.
    const walk = (i: number) =>
      this.kids[i].forEach((c, k) => {
        walk(c);
        this.steps.push({ base: i, top: c, k, before: this.end(i, k), after: this.end(i, k + 1) });
      });
    walk(0);
  }
  get n() {
    return this.pages.length;
  }
  get id() {
    return this.pages[0].id;
  }
  /// A Statement with its first k overprints on is pages i..end-1 of the history.
  end(i: number, k: number) {
    return this.kids[i].slice(0, k).reduce((t, c) => t + this.size[c], i + 1);
  }
  /// The format of a drawing that starts at page i: this Statement's in the picked one if there is one, every other
  /// Statement in its own (a picture shows only in the format its maker chose).
  fmt(i: number): Direction {
    return (i === 0 && this.picked) || this.pages[i].format;
  }
  /// Where clicking page i's Statement goes: its own page, unless it's this one.
  href(i: number) {
    return this.pages[i].id === this.id ? undefined : `/statement/${this.pages[i].id}`;
  }
}

/// Drawings, made once per size and kept while they're in use: the least recently used are let go past a budget of
/// pixels, so big ones (the preview beside the frame, an export) can't pile up.
const marks = new Map<string, Mark[]>();
const bitmaps = new Map<string, HTMLCanvasElement>();
const BUDGET = 16_000_000; // pixels: 64 MB
let held = 0;
function kept(key: string) {
  const c = bitmaps.get(key);
  if (c) bitmaps.delete(key), bitmaps.set(key, c);
  return c;
}
function keep(key: string, c: HTMLCanvasElement) {
  bitmaps.set(key, c);
  held += c.width * c.height;
  for (const [k, old] of bitmaps) {
    if (held <= BUDGET || old === c) break;
    bitmaps.delete(k);
    held -= old.width * old.height;
  }
  return c;
}
/// Pages from..to-1 printed together in d, w device pixels wide.
function bitmap(b: Book, d: Direction, from: number, to: number, w: number) {
  const W = Math.max(4, Math.round(w));
  const key = `${b.id}:${d}:${from}:${to}`;
  const hit = kept(`${key}:${W}`);
  if (hit) return hit;
  let m = marks.get(key);
  if (!m) {
    if (marks.size >= 120) marks.delete(marks.keys().next().value!);
    // Each page's reach within these pages: it and what was overprinted onto it (Accrued piles those up).
    const spans = Array.from({ length: to - from }, (_, j) => Math.min(b.size[from + j], to - from - j));
    marks.set(key, (m = layered(d, b.inks.slice(from, to), spans)));
  }
  const c = document.createElement('canvas');
  c.width = W;
  c.height = Math.round((W * PAGE.h) / PAGE.w);
  paint(c.getContext('2d')!, W, m, to - from >= BLACK_PAPER_PAGES);
  return keep(`${key}:${W}`, c);
}

/// A Credit's 12 × 12 raster of plate masks painted S device pixels square at (X, Y), on its paper.
const blank = new Uint8Array(144);
function paintRaster(g: CanvasRenderingContext2D, src: Uint8Array, X: number, Y: number, S: number, black: boolean, edge: boolean) {
  const at = (i: number) => Math.round((i * S) / 12);
  g.fillStyle = black ? '#000000' : '#ffffff';
  g.fillRect(X, Y, S, S);
  for (let r = 0; r < 12; r++)
    for (let col = 0; col < 12; col++) {
      const m = src[r * 12 + col];
      if (!m) continue;
      g.fillStyle = black ? paperColor(MIX[m]) : MIX[m];
      g.fillRect(X + at(col), Y + at(r), at(col + 1) - at(col), at(r + 1) - at(r));
    }
  if (edge) {
    g.strokeStyle = 'rgba(0,0,0,0.45)';
    g.lineWidth = 1;
    g.strokeRect(X + 0.5, Y + 0.5, S - 1, S - 1);
  }
}
/// Small rasters drawn once per size and kept with the raster (the Credits view draws hundreds), its last few sizes.
const tiles = new WeakMap<Uint8Array, Map<string, HTMLCanvasElement>>();
function rasterTile(px: Uint8Array | null, S: number, black: boolean, edge: boolean) {
  const src = px ?? blank, key = `${S}:${black}:${edge}`;
  let sizes = tiles.get(src);
  if (!sizes) tiles.set(src, (sizes = new Map()));
  let c = sizes.get(key);
  if (c) return c;
  c = document.createElement('canvas');
  c.width = c.height = S;
  paintRaster(c.getContext('2d')!, src, 0, 0, S, black, edge);
  if (sizes.size >= 3) sizes.delete(sizes.keys().next().value!);
  sizes.set(key, c);
  return c;
}

type Box = { x: number; y: number; w: number; h: number };
export type Loupe = { from: number; to: number; as: Direction; title: string; note: string } | { credit: number; px: Uint8Array | null; title: string; note: string };
type Hit = Box & { open?: string; key?: string; cell?: number; square?: number; sheet?: number; format?: Direction; loupe?: Loupe };

/// Draws in the picture's own units (1080 × 1350, or W × 1350 when it's wider) onto a canvas of any size. Drawings
/// land on whole device pixels.
class Pen {
  readonly hits: Hit[] = [];
  constructor(
    readonly g: CanvasRenderingContext2D,
    readonly s: number,
    readonly theme: Theme,
    readonly live: boolean,
    readonly W = VW,
    readonly H = VH,
  ) {}
  px(v: number) {
    return Math.round(v * this.s);
  }
  ground() {
    const { g } = this;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalAlpha = 1;
    g.fillStyle = this.theme.ground;
    g.fillRect(0, 0, g.canvas.width, g.canvas.height);
  }
  hit(h: Hit) {
    if (this.live) this.hits.push(h);
  }
  /// How far a stack of `pages` reaches past the top right of a drawing w wide.
  reach(w: number, pages: number) {
    return ((Math.min(pages, 8) - 1) * Math.max(2, Math.round(w * this.s * 0.04))) / this.s;
  }
  /// Pages from..to-1 of `b` printed together, top left at (x, y), w wide; behind it a sheet of paper for each page
  /// it holds past the first, so a drawing shows how many pages it is. `scale` grows it from its centre, `rise`
  /// lifts it, for entrances.
  art(b: Book, d: Direction, from: number, to: number, x: number, y: number, w: number, o: { alpha?: number; sheets?: number; ring?: boolean; scale?: number; rise?: number } = {}): Box {
    const { g } = this;
    const alpha = o.alpha ?? 1;
    if (alpha <= 0) return { x, y, w, h: w * 1.25 };
    const X = this.px(x), Y = this.px(y + (o.rise ?? 0)), W = Math.max(4, this.px(x + w) - this.px(x));
    const bm = bitmap(b, d, from, to, W), H = bm.height;
    const k = o.scale ?? 1;
    // Scaling about the drawing's centre, smoothly while it moves, pixel-sharp once it lands.
    g.setTransform(k, 0, 0, k, (X + W / 2) * (1 - k), (Y + H / 2) * (1 - k));
    g.globalAlpha = alpha;
    const n = Math.min(o.sheets ?? 1, 8);
    const off = Math.max(2, Math.round(W * 0.04));
    g.lineWidth = 1;
    for (let i = n - 1; i >= 1; i--) {
      g.fillStyle = '#ffffff';
      g.fillRect(X + i * off, Y - i * off, W, H);
      g.strokeStyle = 'rgba(0,0,0,0.45)';
      g.strokeRect(X + i * off + 0.5, Y - i * off + 0.5, W - 1, H - 1);
    }
    g.imageSmoothingEnabled = k !== 1;
    g.drawImage(bm, X, Y);
    if (n > 1) {
      g.strokeStyle = 'rgba(0,0,0,0.45)';
      g.strokeRect(X + 0.5, Y + 0.5, W - 1, H - 1);
    }
    if (o.ring) this.ring(X, Y, W, H);
    g.globalAlpha = 1;
    return { x, y, w, h: H / this.s };
  }
  /// A frame round something pointed at, in device pixels.
  ring(X: number, Y: number, W: number, H: number, color = this.theme.fg) {
    const { g } = this;
    const r = Math.max(2, Math.round(2.5 * this.s));
    g.strokeStyle = color;
    g.lineWidth = r;
    g.strokeRect(X - r * 1.5, Y - r * 1.5, W + r * 3, H + r * 3);
  }
  font(size = TEXT, weight = 500) {
    return `${weight} ${size}px Geist, ui-sans-serif, system-ui, -apple-system, sans-serif`;
  }
  width(t: string, size = TEXT, weight = 500) {
    this.g.setTransform(this.s, 0, 0, this.s, 0, 0);
    this.g.font = this.font(size, weight);
    return this.g.measureText(t).width;
  }
  /// Text in runs, each [text, colour]: the first run in fg, the rest muted unless given.
  text(runs: string | [string, string?][], x: number, y: number, o: { align?: 'left' | 'right' | 'center'; size?: number; weight?: number; alpha?: number; color?: string; rise?: number } = {}) {
    const { g } = this;
    if ((o.alpha ?? 1) <= 0) return;
    const parts: [string, string?][] = typeof runs === 'string' ? [[runs, o.color]] : runs;
    const size = o.size ?? TEXT;
    const total = parts.reduce((t, [s]) => t + this.width(s, size, o.weight), 0);
    let at = o.align === 'right' ? x - total : o.align === 'center' ? x - total / 2 : x;
    g.setTransform(this.s, 0, 0, this.s, 0, 0);
    g.font = this.font(size, o.weight);
    g.textAlign = 'left';
    g.textBaseline = 'alphabetic';
    g.globalAlpha = o.alpha ?? 1;
    parts.forEach(([s, c], i) => {
      g.fillStyle = c ?? (i ? this.theme.muted : this.theme.fg);
      g.fillText(s, at, y + (o.rise ?? 0));
      at += g.measureText(s).width;
    });
    g.globalAlpha = 1;
  }
  /// Lines in picture units, 2 wide. `drawn` (0–1) draws them only that far along, for lines that grow.
  lines(d: (g: CanvasRenderingContext2D) => void, color = this.theme.line, width = 2, alpha = 1, drawn = 1, length = 0) {
    const { g } = this;
    if (alpha <= 0 || drawn <= 0) return;
    g.setTransform(this.s, 0, 0, this.s, 0, 0);
    g.globalAlpha = alpha;
    g.strokeStyle = color;
    g.lineWidth = Math.max(1, Math.round(width * this.s)) / this.s;
    g.lineCap = 'butt';
    if (drawn < 1 && length) g.setLineDash([length * drawn, length]);
    g.beginPath();
    d(g);
    g.stroke();
    g.setLineDash([]);
    g.globalAlpha = 1;
  }
  fill(x: number, y: number, w: number, h: number, color: string, alpha = 1) {
    const { g } = this;
    if (alpha <= 0) return;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalAlpha = alpha;
    g.fillStyle = color;
    const X = this.px(x), Y = this.px(y);
    g.fillRect(X, Y, Math.max(1, this.px(x + w) - X), Math.max(1, this.px(y + h) - Y));
    g.globalAlpha = 1;
  }
  clip(x: number, y: number, w: number, h: number, draw: () => void) {
    const { g } = this;
    g.save();
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.beginPath();
    const X = this.px(x), Y = this.px(y);
    g.rect(X, Y, this.px(x + w) - X, this.px(y + h) - Y);
    g.clip();
    draw();
    g.restore();
  }
  caption(left: [string, string?][] | string, right: [string, string?][] | string) {
    const y = this.H - M - 12;
    this.text(left, M, y);
    this.text(typeof right === 'string' ? [[right, this.theme.muted]] : right, this.W - M, y, { align: 'right' });
  }
  /// One Credit's 12 × 12 raster of plate masks, `size` square, on its paper. Each is drawn once per size and kept.
  raster(px: Uint8Array | null, x: number, y: number, size: number, o: { black?: boolean; alpha?: number; scale?: number; edge?: boolean } = {}) {
    const { g } = this;
    if ((o.alpha ?? 1) <= 0) return;
    const k = o.scale ?? 1;
    const X = this.px(x), Y = this.px(y), S = Math.max(2, this.px(x + size) - X);
    g.setTransform(k, 0, 0, k, (X + S / 2) * (1 - k), (Y + S / 2) * (1 - k));
    g.globalAlpha = o.alpha ?? 1;
    // A large one (the preview) is painted straight on: 144 cells cost less than keeping a big tile.
    if (S > 160) paintRaster(g, px ?? blank, X, Y, S, !!o.black, o.edge ?? true);
    else {
      g.imageSmoothingEnabled = k !== 1;
      g.drawImage(rasterTile(px, S, !!o.black, o.edge ?? true), X, Y);
    }
    g.globalAlpha = 1;
  }
}

/// What's pointed at, drawn large onto a canvas `w` CSS pixels wide (the preview beside the frame): a Statement
/// with its pages stacked behind it, or one Credit.
export function paintPeek(c: HTMLCanvasElement, b: Book, l: Loupe, w: number, ground: string) {
  const dpr = Math.min(3, devicePixelRatio || 1), isCredit = 'credit' in l;
  const pages = isCredit ? 1 : l.to - l.from;
  const W = Math.round(w * dpr);
  // The drawing fills the width less the paper stacked at its top right.
  const off = Math.max(2, Math.round(W * 0.88 * 0.04)), reach = (Math.min(pages, 8) - 1) * off;
  const aw = W - reach, ah = isCredit ? aw : Math.round(aw * 1.25);
  c.width = W;
  c.height = ah + reach;
  c.style.width = `${w}px`;
  c.style.height = `${(ah + reach) / dpr}px`;
  const g = c.getContext('2d')!;
  const pen = new Pen(g, 1, { ground, fg: '', muted: '', line: '' }, false);
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.fillStyle = ground;
  g.fillRect(0, 0, c.width, c.height);
  if (isCredit) pen.raster(l.px, 0, reach, aw);
  else pen.art(b, l.as, l.from, l.to, 0, reach, aw, { sheets: pages });
}

const statementLoupe = (b: Book, from: number, to: number): Loupe => ({
  from,
  to,
  as: b.fmt(from),
  title: `Statement #${b.pages[from].id}`,
  note: `${to - from > 1 ? `${to - from} pages · ` : ''}${b.fmt(from)}`,
});

/// What a view does: draws itself at a time t, and answers the pointer and keys. Live touches (a hover glide, a
/// loupe growing in) move on `advance`; films draw from t alone.
abstract class Scene {
  abstract readonly key: ViewKey;
  t = 0;
  playing = false;
  /// Plays round and round (and its film loops) rather than stopping at its end.
  loop = false;
  /// Moves on its own: has Play and exports a video. Only the Stack does.
  animated = false;
  hover: Hit | null = null;
  constructor(readonly v: Views) {}
  get b() {
    return this.v.book;
  }
  /// Seconds of animation: what Play runs and the films last. 0: a still.
  length() {
    return 0;
  }
  /// Coming into view: it shows up finished.
  enter() {
    this.t = this.length();
    this.playing = false;
  }
  abstract draw(p: Pen, t: number, moving: boolean): void;
  move(_x: number, _y: number, hit: Hit | null) {
    const was = this.hover;
    this.hover = hit;
    return (was?.key ?? null) !== (hit?.key ?? null);
  }
  click(_x: number, _y: number, hit: Hit | null) {
    if (hit?.open) this.v.open(hit.open);
  }
  drag(_dx: number, _dy: number) {
    return false;
  }
  release() {}
  keys(_e: KeyboardEvent) {
    return false;
  }
  cursor(hit: Hit | null): string {
    return hit?.open ? 'pointer' : 'default';
  }
  /// The formats it can draw in (the format row greys the rest); null: all eight.
  formats(): readonly Direction[] | null {
    return null;
  }
  animating() {
    return false;
  }
  advance(_dt: number) {}
}

/// The print run: page after page printed onto the sheet, a roller drawing each one down, until it's the Statement
/// as it is. From the eighth page the paper turns black, as the contract prints it. Play runs it; it exports as a film.
class StatementScene extends Scene {
  readonly key = 'statement';
  animated = true;
  static H0 = 1.1;
  static WIPE = 0.75;
  static HOLD = 0.85;
  static END = 2.2;
  length() {
    const { H0, WIPE, HOLD, END } = StatementScene;
    return H0 + (this.b.n - 1) * (WIPE + HOLD) + END;
  }
  /// The Statement as it is: it doesn't replay its print run unless asked.
  enter() {
    this.t = this.length();
    this.playing = false;
  }
  start(p: number) {
    const { H0, WIPE, HOLD } = StatementScene;
    return p === 0 ? 0 : H0 + (p - 1) * (WIPE + HOLD);
  }
  settled(p: number) {
    return p === 0 ? 0 : this.start(p) + StatementScene.WIPE;
  }
  at(t: number) {
    let p = 0;
    for (let q = 1; q < this.b.n; q++) if (t >= this.start(q)) p = q;
    const into = p > 0 && t < this.settled(p) ? easeInOut((t - this.start(p)) / StatementScene.WIPE) : 1;
    return { p, into };
  }
  box(p: Pen): Box {
    const h = Math.min(p.H - 2 * M - CAP, (p.W - 2 * M) * 1.25), w = h / 1.25;
    return { x: (p.W - w) / 2, y: M, w, h };
  }
  draw(p: Pen, t: number) {
    const b = this.b, N = b.n, d = b.fmt(0);
    const { p: at, into } = this.at(t);
    const { x, y, w, h } = this.box(p);
    if (into < 1) {
      p.art(b, d, 0, at, x, y, w);
      p.clip(x, y, w, h * into, () => p.art(b, d, 0, at + 1, x, y, w));
      // The roller: ink-dark across the paper, in the page's colour past its edges.
      const ry = y + h * into - 1.5;
      p.fill(x, ry, w, 3, '#111111', 0.9);
      p.fill(x - 14, ry, 14, 3, p.theme.fg);
      p.fill(x + w, ry, 14, 3, p.theme.fg);
    } else p.art(b, d, 0, at + 1, x, y, w);
    p.hit({ x, y, w, h, key: 'art' });
    if (N === 1) return p.caption(`Statement #${b.id}`, d);
    // One square a page at the caption's right, filled as each is printed, and what's printing beside them; for more
    // pages than leave room for that, the page number instead.
    const says = (i: number) => (i === 0 ? `#${b.pages[0].id}, the first page` : `#${b.pages[i].id} onto #${b.pages[i].parent}`);
    const what: [string, string?] = [says(at), p.theme.fg];
    const left = `Statement #${b.id}`, gap = 8;
    const x0 = p.W - M - (N * 14 + (N - 1) * gap);
    const widest = Math.max(...b.pages.map((_, i) => p.width(says(i))));
    const q = M + p.width(left) + 32 <= x0 - 24 - widest ? 14 : 0, cy = p.H - M - 12 - 9;
    for (let i = 0; i < N && q; i++) {
      const sx = x0 + i * (q + gap);
      p.lines((g) => g.rect(sx + 1, cy - q / 2 + 1, q - 2, q - 2), p.theme.muted);
      const f = i === 0 ? 1 : span(t, this.settled(i) - 0.12, 0.3);
      if (f > 0) p.fill(sx + (q * (1 - f)) / 2, cy - (q * f) / 2, q * f, q * f, p.theme.fg);
      p.hit({ x: sx - 4, y: cy - q / 2 - 10, w: q + 8, h: q + 20, square: i, key: `sq${i}` });
    }
    if (!q) return p.caption(left, [what, [`  ·  page ${at + 1} of ${N}`]]);
    p.text(left, M, p.H - M - 12);
    p.text([what], x0 - 24, p.H - M - 12, { align: 'right' });
  }
  /// To page i, settled.
  go(i: number) {
    this.playing = false;
    i = clamp(i, 0, this.b.n - 1);
    this.t = i === this.b.n - 1 ? this.length() : this.settled(i) + 0.01;
  }
  click(_x: number, _y: number, hit: Hit | null) {
    if (hit?.square != null) this.go(hit.square);
  }
  drag(dx: number) {
    this.playing = false;
    this.t = clamp(this.t + (dx / (this.v.W * 0.75)) * this.length(), 0, this.length());
    return true;
  }
  keys(e: KeyboardEvent) {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return false;
    this.go(this.at(this.t).p + (e.key === 'ArrowLeft' ? -1 : 1));
    return true;
  }
  cursor(hit: Hit | null) {
    return hit?.square != null ? 'pointer' : hit ? 'ew-resize' : 'default';
  }
}

/// The pages in the air, base at the bottom, an exploded drawing with each page named beside it. Drag sideways to
/// turn it (it carries on with the throw), up and down to spread it; click round it to close it into the Statement
/// itself. It fans open as it comes into view.
class StackScene extends Scene {
  readonly key = 'stack';
  loop = true;
  animated = true;
  yaw = -38;
  spin = 0;
  spread = 1;
  aim = 1;
  born = 1;
  lift: number[] = [];
  fade: number[] = [];
  private geo: { ox: number; oy: number; a: number; bb: number; c: number; dd: number; gap: number; st: number; sw: number; sh: number; n: number } | null = null;
  private lastDx = 0;
  private lastAt = 0;
  length() {
    return 6.4;
  }
  enter() {
    this.born = still() ? 1 : 0;
    this.spin = 0;
    this.playing = false;
    this.t = 0;
  }
  get n() {
    return Math.min(this.b.n, STACK_MAX);
  }
  animating() {
    const h = this.hover?.sheet ?? -1;
    return (
      super.animating() ||
      this.born < 1 ||
      Math.abs(this.spin) > 0.5 ||
      Math.abs(this.aim - this.spread) > 0.002 ||
      this.lift.some((l, i) => Math.abs(l - (i === h ? 1 : 0)) > 0.005) ||
      this.fade.some((f, i) => Math.abs(f - (h >= 0 && i > h ? 1 : 0)) > 0.005)
    );
  }
  advance(dt: number) {
    super.advance(dt);
    if (this.born < 1) this.born = Math.min(1, this.born + dt);
    if (Math.abs(this.spin) > 0.5) {
      this.yaw = clamp(this.yaw + this.spin * dt, -90, 90);
      this.spin *= Math.exp(-dt * 3.2);
      if (this.yaw === -90 || this.yaw === 90) this.spin = 0;
    }
    this.spread = still() ? this.aim : chase(this.spread, this.aim, dt, 7);
    const h = this.hover?.sheet ?? -1;
    for (let i = 0; i < this.n; i++) {
      this.lift[i] = chase(this.lift[i] ?? 0, i === h ? 1 : 0, dt, 14);
      this.fade[i] = chase(this.fade[i] ?? 0, h >= 0 && i > h ? 1 : 0, dt, 12);
    }
  }
  /// The film: turning gently, open, then closing flat into the Statement for a beat, then opening again.
  pose(t: number, moving: boolean) {
    if (!moving) return { yaw: this.yaw, spread: this.spread };
    const a = (2 * Math.PI * t) / this.length();
    const close = span(t, 2.3, 0.9, easeInOut), open = span(t, 4.0, 0.9, easeInOut);
    return { yaw: this.yaw + 15 * Math.sin(a), spread: 1 - close + open };
  }
  draw(p: Pen, t: number, moving: boolean) {
    const b = this.b, n = this.n, d = b.fmt(0);
    const { yaw, spread } = this.pose(t, moving);
    const th = (yaw * Math.PI) / 180, tilt = (56 * Math.PI) / 180;
    const ct = Math.cos(tilt), st = Math.sin(tilt);
    const sw = 470, sh = sw * 1.25;
    const gap = spread * Math.min(110, 640 / Math.max(1, n - 1));
    const a = Math.cos(th), bb = Math.sin(th) * ct, c = -Math.sin(th), dd = Math.cos(th) * ct;
    const live = p.live && !moving;
    // Fanning open as it arrives: each sheet rises a beat after the one under it.
    const rise = (i: number) => (live ? span(this.born, i * 0.045, 0.62) : 1);
    const lifted = (i: number) => (live ? (this.lift[i] ?? 0) * 26 : 0);
    const z = (i: number) => i * gap * rise(i) + lifted(i);
    const unit = [
      [0, 0],
      [sw, 0],
      [0, sh],
      [sw, sh],
    ];
    const corners = (i: number, ox: number, oy: number) => unit.map(([u, v]) => [ox + a * (u - sw / 2) + c * (v - sh / 2), oy + bb * (u - sw / 2) + dd * (v - sh / 2) - z(i) * st]);
    // Fit the stack at its full height, with room for the names at its right, so it holds still as it opens.
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (let i = 0; i < n; i++)
      for (const [u, v] of unit) {
        const X = a * (u - sw / 2) + c * (v - sh / 2), Y = bb * (u - sw / 2) + dd * (v - sh / 2) - i * gap * st;
        (x0 = Math.min(x0, X)), (x1 = Math.max(x1, X)), (y0 = Math.min(y0, Y)), (y1 = Math.max(y1, Y));
      }
    const names = 150;
    const ox = p.W / 2 - (x0 + x1 + names) / 2, oy = (M + p.H - M - CAP) / 2 - (y0 + y1) / 2;
    if (p.live) this.geo = { ox, oy, a, bb, c, dd, gap, st, sw, sh, n };
    const hover = live ? (this.hover?.sheet ?? -1) : -1;
    const closed = clamp(1 - spread / 0.14);
    const { g } = p;
    for (let i = 0; i < n; i++) {
      const e = ox - (a * sw) / 2 - (c * sh) / 2, f = oy - (bb * sw) / 2 - (dd * sh) / 2 - z(i) * st;
      g.setTransform(p.s * a, p.s * bb, p.s * c, p.s * dd, p.s * e, p.s * f);
      g.globalAlpha = (live ? 1 - 0.82 * (this.fade[i] ?? 0) : 1) * (live ? clamp(rise(i) * 3) : 1);
      g.imageSmoothingEnabled = true;
      g.imageSmoothingQuality = 'high';
      g.drawImage(bitmap(b, d, i, i + 1, sw * p.s * 1.15), 0, 0, sw, sh);
      g.lineWidth = 1.5 / p.s;
      g.strokeStyle = 'rgba(0,0,0,0.4)';
      g.strokeRect(0, 0, sw, sh);
      if (i === hover && closed < 1) {
        g.strokeStyle = p.theme.fg;
        g.lineWidth = 3 / p.s;
        g.strokeRect(-7, -7, sw + 14, sh + 14);
      }
      if (i === n - 1 && closed > 0) {
        g.globalAlpha = closed;
        g.drawImage(bitmap(b, d, 0, b.n, sw * p.s * 1.15), 0, 0, sw, sh);
        g.strokeRect(0, 0, sw, sh);
      }
      g.globalAlpha = 1;
    }
    // Names in a column at the right, a leader from each sheet's right-hand corner; they come in once it's open.
    const alpha = clamp((spread - 0.45) / 0.3) * (live ? span(this.born, 0.35, 0.5) : 1);
    if (alpha > 0) {
      const right = Math.max(...Array.from({ length: n }, (_, i) => Math.max(...corners(i, ox, oy).map((q) => q[0]))));
      const lx = right + 28;
      let lastY = -Infinity;
      for (let i = n - 1; i >= 0; i--) {
        const [cx, cy] = corners(i, ox, oy).reduce((m, q) => (q[0] > m[0] ? q : m));
        if (Math.abs(cy - lastY) < 28) continue;
        lastY = cy;
        const on = i === hover;
        p.lines((g) => (g.moveTo(cx + 6, cy), g.lineTo(lx, cy)), on ? p.theme.fg : p.theme.line, 2, alpha);
        p.text([[`#${b.pages[i].id}`, on ? p.theme.fg : p.theme.muted]], lx + 10, cy + 8, { size: SMALL, alpha });
      }
    }
    const shown = hover >= 0 && closed < 1 ? b.pages[hover] : null;
    p.caption(`Statement #${b.id}`, shown ? [[`#${shown.id}`, p.theme.fg], [`  ·  page ${hover + 1} of ${b.n}`]] : live ? 'Drag to turn it' : `${b.n} pages`);
  }
  /// The top sheet under a point, by undoing each sheet's turn.
  sheetAt(x: number, y: number) {
    const q = this.geo;
    if (!q) return -1;
    const det = q.a * q.dd - q.bb * q.c;
    for (let i = q.n - 1; i >= 0; i--) {
      const z = i * q.gap + (this.lift[i] ?? 0) * 26;
      const e = q.ox - (q.a * q.sw) / 2 - (q.c * q.sh) / 2, f = q.oy - (q.bb * q.sw) / 2 - (q.dd * q.sh) / 2 - z * q.st;
      const u = (q.dd * (x - e) - q.c * (y - f)) / det, v = (-q.bb * (x - e) + q.a * (y - f)) / det;
      if (u >= 0 && u <= q.sw && v >= 0 && v <= q.sh) return i;
    }
    return -1;
  }
  move(x: number, y: number) {
    const i = this.sheetAt(x, y);
    const was = this.hover?.sheet ?? -1;
    this.hover = i >= 0 ? { x: 0, y: 0, w: 0, h: 0, sheet: i, key: `s${i}`, open: this.b.href(i) } : null;
    return i !== was;
  }
  click(x: number, y: number) {
    const i = this.sheetAt(x, y);
    if (i >= 0) {
      const href = this.b.href(i);
      if (href) this.v.open(href);
    } else this.aim = this.aim > 0.5 ? 0 : 1;
  }
  drag(dx: number, dy: number) {
    this.playing = false;
    const now = performance.now(), dtm = Math.max(8, now - this.lastAt);
    this.lastAt = now;
    this.lastDx = (dx * 0.28 * 1000) / dtm;
    this.spin = 0;
    this.yaw = clamp(this.yaw + dx * 0.28, -90, 90);
    this.spread = this.aim = clamp(this.spread - dy / 420);
    return true;
  }
  /// Let go: it carries on turning with the throw and slows to a stop.
  release() {
    if (performance.now() - this.lastAt < 80 && !still()) this.spin = clamp(this.lastDx, -360, 360);
  }
  cursor() {
    return this.hover?.sheet != null ? (this.hover.open ? 'pointer' : 'grab') : 'grab';
  }
}

/// One cell of the Statement and what's printed in it: the Credit each page put there, and the cell they make
/// together. Point at a cell to see it; click to hold it; arrows move it. The frame glides from cell to cell and the
/// Credits deal in, one after another.
class CellsScene extends Scene {
  readonly key = 'cells';
  loop = true;
  cell = -1;
  held = false;
  /// The frame's position, chasing the cell's, and how long since the cell changed.
  private glide: Box | null = null;
  private target: Box | null = null;
  private since = 9;
  private best: number[] | null = null;
  static SLOT: Direction[] = ['Issued', 'Consolidated', 'Assessed', 'Amortized', 'Recorded'];
  static STAY = 1.8;
  length() {
    return this.tour().length * CellsScene.STAY;
  }
  formats() {
    return CellsScene.SLOT;
  }
  enter() {
    this.t = 0;
    this.playing = false;
    this.since = 9;
  }
  /// Its format, if it keeps each Credit in its place; Issued otherwise.
  d(): Direction {
    const d = this.b.fmt(0);
    return CellsScene.SLOT.includes(d) ? d : 'Issued';
  }
  combined(c: number) {
    const out = new Uint8Array(144);
    for (const page of this.b.inks) {
      const px = page[c]?.px;
      if (px) for (let i = 0; i < 144; i++) out[i] |= px[i];
    }
    return out;
  }
  /// The cells most worth a look, first: the most different inks, then the most ink.
  tour() {
    if (!this.best) {
      const score = (c: number) => {
        const px = this.combined(c);
        return new Set(px).size * 1000 + px.reduce((t, m) => t + (m ? 1 : 0), 0);
      };
      this.best = Array.from({ length: 80 }, (_, c) => c)
        .sort((x, y) => score(y) - score(x))
        .slice(0, 8);
    }
    return this.best;
  }
  animating() {
    const g = this.glide, t = this.target;
    return super.animating() || this.since < 1.2 || !!(g && t && (Math.abs(g.x - t.x) > 0.3 || Math.abs(g.y - t.y) > 0.3));
  }
  advance(dt: number) {
    super.advance(dt);
    this.since += dt;
    const t = this.target;
    if (t) this.glide = !this.glide || still() ? { ...t } : { x: chase(this.glide.x, t.x, dt, 20), y: chase(this.glide.y, t.y, dt, 20), w: t.w, h: t.h };
  }
  /// The sum along the foot is laid out for the 1080 picture, however wide this one is, so the drawing keeps its size.
  geometry(p: Pen) {
    const N = this.b.n;
    const count = Math.min(N, 10), op = 36;
    const tile = Math.max(36, Math.floor((VW - 2 * M - (count + 1) * op - (N > count ? op * 3 : 0)) / (count + 1.5))), big = Math.round(tile * 1.5);
    const eqY = p.H - M - CAP - big - 46;
    const ah = eqY - 52 - M, aw = Math.min(p.W - 2 * M, ah / 1.25), ax = (p.W - aw) / 2, ay = M;
    return { count, op, tile, big, eqY, aw, ax, ay };
  }
  cellBox(c: number, g: { aw: number; ax: number; ay: number }): Box | null {
    const box = slotBox(this.d(), c);
    if (!box) return null;
    const k = g.aw / PAGE.w;
    return { x: g.ax + box[0] * k, y: g.ay + box[1] * k, w: box[2] * k, h: box[3] * k };
  }
  draw(p: Pen, t: number, moving: boolean) {
    const b = this.b, N = b.n, d = this.d();
    const black = N >= BLACK_PAPER_PAGES;
    const geo = this.geometry(p);
    const { count, op, tile, big, eqY, aw, ax, ay } = geo;
    // Which cell, how long it has shown, and (in the film) the one before, to glide from.
    const tour = this.tour();
    let cell: number, age: number, from: number | null = null;
    if (moving) {
      const k = Math.floor(t / CellsScene.STAY) % tour.length;
      cell = tour[k];
      age = t - Math.floor(t / CellsScene.STAY) * CellsScene.STAY;
      from = tour[(k + tour.length - 1) % tour.length];
    } else {
      cell = this.cell >= 0 ? this.cell : tour[0];
      age = p.live ? this.since : 9;
    }
    p.art(b, d, 0, N, ax, ay, aw);
    p.hit({ x: ax, y: ay, w: aw, h: aw * 1.25, cell: -1, key: 'art' });
    const target = this.cellBox(cell, geo);
    if (target) {
      if (p.live && !moving) this.target = target;
      // The frame: in the film it glides from the last cell; live it chases the pointer.
      let box = target;
      if (moving && from != null) {
        const a = this.cellBox(from, geo)!, e = span(age, 0, 0.5, easeInOut);
        box = { x: a.x + (target.x - a.x) * e, y: a.y + (target.y - a.y) * e, w: target.w, h: target.h };
      } else if (p.live && this.glide) box = this.glide;
      const { g } = p;
      g.setTransform(p.s, 0, 0, p.s, 0, 0);
      g.globalAlpha = 0.8;
      g.fillStyle = black ? '#000000' : '#ffffff';
      g.beginPath();
      g.rect(ax, ay, aw, aw * 1.25);
      g.rect(box.x - 6, box.y - 6, box.w + 12, box.h + 12);
      g.fill('evenodd');
      g.globalAlpha = 1;
      p.lines((g) => g.rect(box.x - 6, box.y - 6, box.w + 12, box.h + 12), black ? '#ffffff' : '#000000', 3);
    }
    // The sum along the foot: each page's Credit dealt in, one after another, then the cell they make.
    const rowW = count * tile + count * op + big + (N > count ? op * 3 : 0);
    let x = p.W / 2 - rowW / 2;
    const ty = eqY + (big - tile) / 2;
    const deal = (i: number) => span(age, 0.08 + i * 0.05, 0.34);
    for (let i = 0; i < count; i++) {
      const e = deal(i);
      const ink = b.inks[i][cell];
      p.raster(ink?.px ?? null, x, ty + 10 * (1 - e), tile, { alpha: e });
      const id = b.pages[i].from[cell];
      p.text([[`#${id.toLocaleString('en-US')}`, p.theme.muted]], x + tile / 2, eqY + big + 36, { size: SMALL - 4, align: 'center', alpha: e });
      p.hit({ x, y: ty, w: tile, h: tile, key: `t${i}`, open: `/credit/${id}`, loupe: { credit: id, px: ink?.px ?? null, title: `Credit #${id.toLocaleString('en-US')}`, note: `On #${b.pages[i].id}, page ${i + 1} of ${N}` } });
      x += tile;
      p.text([[i < count - 1 || N > count ? '+' : '=', p.theme.muted]], x + op / 2, ty + tile / 2 + 9, { align: 'center', alpha: e });
      x += op;
    }
    if (N > count) {
      p.text([[`${N - count} more`, p.theme.muted]], x + 10, ty + tile / 2 + 8, { size: SMALL - 4 });
      x += op * 3;
    }
    const r = span(age, 0.14 + count * 0.05, 0.45);
    p.raster(this.combined(cell), x, eqY, big, { black, alpha: r, scale: 0.96 + 0.04 * r });
    p.text(`#${b.id}`, x + big / 2, eqY + big + 36, { size: SMALL - 4, align: 'center', alpha: r });
    const row = Math.floor(cell / 8), col = cell % 8;
    p.caption(`Statement #${b.id}`, [[`Row ${row + 1}, column ${col + 1}`, p.theme.fg], [`  ·  ${N} Credits in one cell`]]);
  }
  /// The cell under a point of the drawing.
  at(x: number, y: number) {
    const art = this.v.hits.find((h) => h.cell === -1);
    if (!art || x < art.x || y < art.y || x > art.x + art.w || y > art.y + art.h) return -1;
    return slotAt(this.d(), ((x - art.x) / art.w) * PAGE.w, ((y - art.y) / art.h) * PAGE.h);
  }
  set(c: number) {
    if (c === this.cell) return false;
    this.cell = c;
    return true;
  }
  move(x: number, y: number, hit: Hit | null) {
    const lens = super.move(x, y, hit);
    if (this.held) return lens;
    const c = this.at(x, y);
    return (c >= 0 && this.set(c)) || lens;
  }
  click(x: number, y: number, hit: Hit | null) {
    if (hit?.open) return void this.v.open(hit.open);
    const c = this.at(x, y);
    if (c >= 0) {
      this.held = !(this.held && c === this.cell);
      this.set(c);
    }
  }
  keys(e: KeyboardEvent) {
    const step = ({ ArrowLeft: -1, ArrowRight: 1, ArrowUp: -8, ArrowDown: 8 } as Record<string, number>)[e.key];
    if (!step) return e.key === 'Escape' && this.held ? ((this.held = false), true) : false;
    const at = this.cell >= 0 ? this.cell : this.tour()[0];
    const next = at + step;
    if (next < 0 || next >= 80 || (Math.abs(step) === 1 && Math.floor(next / 8) !== Math.floor(at / 8))) return true;
    this.held = true;
    this.set(next);
    return true;
  }
  cursor(hit: Hit | null) {
    return hit?.open ? 'pointer' : hit?.cell === -1 ? 'crosshair' : 'default';
  }
}

/// The family tree: every overprint a pair (the Statement as it stood and the one burned onto it) joined by a line,
/// with what it made under them; that's one of the pair in the next. An original comes in just above the overprint
/// it goes into. In a wide picture it lies on its side, oldest at the left. Point at one to see what's in it; click
/// one to open it.
type Node = { i: number; to: number; x: number; h: number; kids: Node[]; step: number };
/// Where a tree draws: each node's drawing (tw × th, top left), its name, and the line from its pair into it.
type Shape = {
  tw: number;
  th: number;
  at(n: Node): { x: number; y: number };
  name(n: Node, on: boolean): { x: number; y: number };
  wire(n: Node): { path: (g: CanvasRenderingContext2D) => void; len: number };
};
class TreeScene extends Scene {
  readonly key = 'tree';
  static D = 0.8;
  private tree: { root: Node; nodes: Node[]; cols: number } | null = null;
  private dim = 0;
  private dimFor: Node | null = null;
  length() {
    return this.b.steps.length * TreeScene.D + 0.4 + 2.2;
  }
  animating() {
    return super.animating() || Math.abs(this.dim - (this.hover?.key?.startsWith('n') ? 1 : 0)) > 0.01;
  }
  advance(dt: number) {
    super.advance(dt);
    this.dim = still() ? (this.hover?.key?.startsWith('n') ? 1 : 0) : chase(this.dim, this.hover?.key?.startsWith('n') ? 1 : 0, dt, 14);
  }
  layout() {
    if (this.tree) return this.tree;
    const b = this.b;
    const state = (i: number, k: number): Node => {
      if (k === 0) return { i, to: i + 1, x: 0, h: 0, kids: [], step: -1 };
      const base = state(i, k - 1), c = b.kids[i][k - 1], top = state(c, b.kids[c].length);
      return { i, to: b.end(i, k), x: 0, h: 1 + Math.max(base.h, top.h), kids: [base, top], step: b.steps.findIndex((s) => s.base === i && s.k === k - 1) };
    };
    const root = state(0, b.kids[0].length);
    const under = (n: Node): Node[] => [n, ...n.kids.flatMap(under)];
    const nodes = under(root);
    for (const n of nodes) for (const k of n.kids) if (!k.kids.length) (k.h = n.h - 1), (k.step = n.step);
    const edge = (ns: Node[], f: (a: number, b: number) => number) => {
      const m = new Map<number, number>();
      for (const n of ns) m.set(n.h, m.has(n.h) ? f(m.get(n.h)!, n.x) : n.x);
      return m;
    };
    const place = (n: Node) => {
      if (!n.kids.length) return;
      const [base, top] = n.kids;
      place(base);
      place(top);
      const right = edge(under(base), Math.max), left = edge(under(top), Math.min);
      let shift = base.x + 1 - top.x;
      for (const [h, x] of left) if (right.has(h)) shift = Math.max(shift, right.get(h)! + 1 - x);
      for (const m of under(top)) m.x += shift;
      n.x = (base.x + top.x) / 2;
    };
    place(root);
    const min = Math.min(...nodes.map((n) => n.x));
    for (const n of nodes) n.x -= min;
    return (this.tree = { root, nodes, cols: Math.max(...nodes.map((n) => n.x)) + 1 });
  }
  /// Upright, the oldest at the top: a row for each generation, names beside the drawings, each pair's line dropping
  /// into what it made.
  upright(p: Pen): Shape {
    const { root, nodes, cols } = this.layout();
    const rows = root.h + 1, top = M + 10, bottom = p.H - M - CAP - 10;
    const rowH = (bottom - top) / rows;
    let colW = (p.W - 2 * M) / cols;
    // A row needs the drawing, the paper stacked above the tallest stack, and room for its lines: the drawings shrink
    // until every line has that room.
    const most = Math.min(8, Math.max(...nodes.map((n) => n.to - n.i)));
    let th = Math.min(colW * 0.5 * 1.25, 320);
    while (th > 40 && th + p.reach(th / 1.25, most) + 46 > rowH) th -= 2;
    const tw = th / 1.25;
    // In a picture wider than 1080 the columns stay near the drawings' size, so the tree doesn't stretch thin.
    colW = Math.min(colW, Math.max((VW - 2 * M) / cols, tw * 3));
    const ox = (p.W - cols * colW) / 2;
    const cx = (n: Node) => ox + (n.x + 0.5) * colW - 24, ny = (n: Node) => top + n.h * rowH + rowH - th - 12;
    return {
      tw,
      th,
      at: (n) => ({ x: cx(n) - tw / 2, y: ny(n) }),
      name: (n, on) => ({ x: cx(n) + tw / 2 + p.reach(tw, n.to - n.i) + (on ? 20 : 12), y: ny(n) + th / 2 + 8 }),
      wire: (n) => {
        // The join sits halfway between the row above and the top of the paper this one is stacked on. One line,
        // drawn in order: down from the left, across, up into the right; then down into what they made.
        const above = ny(n) - rowH + th + 4, end = ny(n) - 4 - p.reach(tw, n.to - n.i), bar = (above + end) / 2;
        const [l, r] = n.kids, lo = ny(l) + th + 4, ro = ny(r) + th + 4;
        return {
          len: bar - lo + Math.abs(cx(r) - cx(l)) + (bar - ro) + (end - bar),
          path: (g) => (g.moveTo(cx(l), lo), g.lineTo(cx(l), bar), g.lineTo(cx(r), bar), g.lineTo(cx(r), ro), g.moveTo(cx(n), bar), g.lineTo(cx(n), end)),
        };
      },
    };
  }
  /// On its side, the oldest at the left, for a wide picture: a column for each generation, names under the drawings,
  /// each pair's line running right into what it made. The drawings can be about twice the size.
  across(p: Pen): Shape {
    const { root, nodes, cols } = this.layout();
    const gens = root.h + 1, label = 40, top = M + 10, bottom = p.H - M - CAP - 10;
    const rowH = (bottom - top) / cols;
    let genW = (p.W - 2 * M) / gens;
    // A row holds a drawing, the paper stacked above it and its name; a generation, a drawing, its paper and the
    // lines out of it.
    const most = Math.min(8, Math.max(...nodes.map((n) => n.to - n.i)));
    let th = 320;
    while (th > 40 && (th + p.reach(th / 1.25, most) + label + 12 > rowH || th / 1.25 + p.reach(th / 1.25, most) + 72 > genW)) th -= 2;
    const tw = th / 1.25, reach = p.reach(tw, most);
    genW = Math.min(genW, tw + reach + 150);
    const gap = genW - tw - reach, ox = (p.W - (gens - 1) * genW - tw - reach) / 2;
    const nx = (n: Node) => ox + n.h * genW;
    const ny = (n: Node) => top + (n.x + 0.5) * rowH - (th + label - reach) / 2;
    const cy = (n: Node) => ny(n) + th / 2;
    return {
      tw,
      th,
      at: (n) => ({ x: nx(n), y: ny(n) }),
      name: (n) => ({ x: nx(n), y: ny(n) + th + 30 }),
      wire: (n) => {
        // Out of each of the pair, clear of its paper, to a join halfway across the gap; then right into what they made.
        const [l, r] = n.kids, out = (k: Node) => nx(k) + tw + p.reach(tw, k.to - k.i) + 6;
        const bar = nx(n) - gap / 2, into = nx(n) - 6;
        return {
          len: bar - out(l) + Math.abs(cy(r) - cy(l)) + (bar - out(r)) + (into - bar),
          path: (g) => (g.moveTo(out(l), cy(l)), g.lineTo(bar, cy(l)), g.lineTo(bar, cy(r)), g.lineTo(out(r), cy(r)), g.moveTo(bar, cy(n)), g.lineTo(into, cy(n))),
        };
      },
    };
  }
  draw(p: Pen, t: number) {
    const b = this.b, D = TreeScene.D;
    const { nodes } = this.layout();
    const { tw, th, at, name, wire } = p.W > p.H ? this.across(p) : this.upright(p);
    // Growing: an original arrives as its overprint starts, the lines draw, then what it made lands.
    const arrive = (n: Node) => (n.kids.length ? span(t, n.step * D + 0.48, 0.42) : span(t, Math.max(0, n.step) * D, 0.4));
    const drawn = (n: Node) => span(t, n.step * D + 0.18, 0.42, easeInOut);
    // What's in the one pointed at: it and everything above it in the tree.
    const pointedKey = this.hover?.key?.startsWith('n') ? Number(this.hover.key.slice(1)) : null;
    if (pointedKey != null) this.dimFor = nodes[pointedKey];
    const pointed = p.live ? (pointedKey != null ? nodes[pointedKey] : this.dim > 0.01 ? this.dimFor : null) : null;
    const inside = new Set<Node>();
    const mark = (n: Node) => (inside.add(n), n.kids.forEach(mark));
    if (pointed) mark(pointed);
    const dim = (n: Node) => (pointed && !inside.has(n) ? 1 - 0.75 * this.dim : 1);
    for (const n of nodes) {
      if (!n.kids.length) continue;
      const q = drawn(n);
      if (q <= 0) continue;
      const color = pointed && inside.has(n) && this.dim > 0.5 ? p.theme.fg : p.theme.line;
      const { path, len } = wire(n);
      p.lines(path, color, 2, dim(n), q, len);
    }
    nodes.forEach((n, idx) => {
      const a = arrive(n);
      if (a <= 0) return;
      const { x, y } = at(n);
      const pages = n.to - n.i;
      const on = pointed === n && this.dim > 0.5;
      p.art(b, b.fmt(n.i), n.i, n.to, x, y, tw, { alpha: a * dim(n), sheets: pages, scale: 0.96 + 0.04 * a, rise: 8 * (1 - a), ring: on });
      const l = name(n, on);
      p.text([[`#${b.pages[n.i].id}`, on ? p.theme.fg : p.theme.muted]], l.x, l.y, { size: SMALL, alpha: a * dim(n) });
      p.hit({ x, y, w: tw, h: th, key: `n${idx}`, open: pages === 1 ? b.href(n.i) : undefined, loupe: statementLoupe(b, n.i, n.to) });
    });
    p.caption(`Statement #${b.id}`, count(b.steps.length, 'overprint'));
  }
}

/// The whole Statement as one equation: each Statement as it was made, brackets round what was burned together
/// before it went on, on one line (or as few as keep the drawings readable); under it, = this one, large.
type Token = { kind: 'term'; from: number } | { kind: 'op' } | { kind: '(' | ')' };
class EquationScene extends Scene {
  readonly key = 'equation';
  private laid: { at: string; w: number; fit: ReturnType<EquationScene['lines']> } | null = null;
  /// Drawings narrower than this stop reading as Statements: the sum takes another line instead.
  static READ = 64;
  tokens(): Token[] {
    const b = this.b;
    const term = (i: number, top: boolean): Token[] => {
      const me: Token = { kind: 'term', from: i };
      if (!b.kids[i].length) return [me];
      const inner: Token[] = [me];
      for (const k of b.kids[i]) inner.push({ kind: 'op' }, ...term(k, false));
      return top ? inner : [{ kind: '(' }, ...inner, { kind: ')' }];
    };
    return term(0, true);
  }
  length() {
    return (this.tokens().length + 2) * 0.11 + 0.7 + 2.4;
  }
  /// The room round a sign and a bracket, and between tokens, in step with the drawings.
  static space(w: number) {
    return { op: clamp(w * 0.5, 28, 56), br: clamp(w * 0.3, 18, 34), gap: clamp(w * 0.06, 4, 6) };
  }
  /// The sum in lines at drawing width w, each centred: a line breaks only before a +, outside brackets where it can,
  /// so each line after the first starts with its sign; as few lines as hold it, the breaks where the longest line is
  /// shortest.
  lines(p: Pen, w: number) {
    const { op, br, gap } = EquationScene.space(w);
    const width = (t: Token) => (t.kind === 'term' ? w : t.kind === 'op' ? op : br);
    const run = (ts: Token[]) => ts.reduce((s, x) => s + width(x) + gap, -gap);
    const room = p.W - 2 * M, sum = this.tokens();
    // How deep in brackets each token sits.
    const depth: number[] = [];
    let d = 0;
    for (const t of sum) {
      if (t.kind === ')') d--;
      depth.push(d);
      if (t.kind === '(') d++;
    }
    const pack = (level: number) => {
      const pieces: Token[][] = [];
      sum.forEach((t, i) => (i === 0 || (t.kind === 'op' && depth[i] <= level) ? pieces.push([t]) : pieces[pieces.length - 1].push(t)));
      const n = pieces.length, at = [0];
      for (const piece of pieces) at.push(at[at.length - 1] + run(piece) + gap);
      const along = (i: number, j: number) => at[j] - at[i] - gap;
      // longest[c][j]: the shortest longest line the first j pieces make in c lines; from[c][j]: where its last starts.
      const longest = [[0, ...Array<number>(n).fill(Infinity)]], from: number[][] = [[]];
      for (let c = 1; c <= n; c++) {
        (longest[c] = Array<number>(n + 1).fill(Infinity)), (from[c] = Array<number>(n + 1).fill(0));
        for (let j = c; j <= n; j++)
          for (let i = c - 1; i < j; i++) {
            const v = Math.max(longest[c - 1][i], along(i, j));
            if (v < longest[c][j]) (longest[c][j] = v), (from[c][j] = i);
          }
        if (longest[c][n] <= room || c === n) {
          const lines: Token[][] = [];
          for (let k = c, j = n; k > 0; j = from[k][j], k--) lines.unshift(pieces.slice(from[k][j], j).flat());
          return lines;
        }
      }
      return pieces;
    };
    let lines = pack(0), level = 0;
    while (level < Math.max(0, ...depth) && lines.some((l) => run(l) > room)) lines = pack(++level);
    return { lines, level, width, run, gap };
  }
  draw(p: Pen, t: number) {
    const b = this.b, label = 36, rowGap = 40, between = 72;
    const room = p.H - 2 * M - CAP - 20;
    type Fit = ReturnType<EquationScene['lines']>;
    const sumH = (f: Fit, w: number) => f.lines.length * (w * 1.25 + label) + (f.lines.length - 1) * rowGap;
    const answerH = (a: number) => a * 1.25 + p.reach(a, b.n) + label;
    const least = Math.min(p.W, p.H * 0.8) * 0.2;
    const fits = (f: Fit, w: number) => Math.max(...f.lines.map(f.run)) <= p.W - 2 * M && sumH(f, w) + between + answerH(least) <= room;
    // The largest drawings each number of lines allows (breaking inside brackets only if it must), never so large the
    // answer stops standing out; then the fewest lines that keep them readable: one formula, not a gallery.
    // The search runs once per picture size; a hover redraws with what it found.
    const at = `${p.W}:${p.H}:${p.s}`;
    const ways = new Map<number, { w: number; f: Fit }>();
    for (const deep of this.laid?.at === at ? [] : [false, true]) {
      for (let v = 40; v <= Math.min(240, p.W * 0.16); v += 2) {
        const f = this.lines(p, v);
        if (!fits(f, v) || (f.level > 0) !== deep) continue;
        const best = ways.get(f.lines.length);
        if (!best || best.w < v) ways.set(f.lines.length, { w: v, f });
      }
      if ([...ways.values()].some((x) => x.w >= EquationScene.READ)) break;
    }
    if (this.laid?.at !== at) {
      const byLines = [...ways.entries()].sort((a, c) => a[0] - c[0]).map(([, x]) => x);
      const pick = byLines.find((x) => x.w >= EquationScene.READ) ?? byLines[byLines.length - 1];
      this.laid = { at, w: pick?.w ?? 40, fit: pick?.f ?? this.lines(p, 40) };
    }
    const { w, fit } = this.laid;
    const { br } = EquationScene.space(w);
    // The answer: a third of the way across, less if the height runs out.
    const sh = sumH(fit, w);
    let A = p.W * 0.36;
    while (A > w && sh + between + answerH(A) > room) A -= 4;
    let y = M + 10 + (room - sh - between - answerH(A)) / 2, n = 0;
    for (const line of fit.lines) {
      let x = p.W / 2 - fit.run(line) / 2;
      const mid = y + (w * 1.25) / 2;
      for (const tk of line) {
        const tw = fit.width(tk);
        // Written out a term at a time; the answer lands last.
        const e = span(t, n++ * 0.11, 0.38);
        if (tk.kind === 'term') {
          p.art(b, b.fmt(tk.from), tk.from, tk.from + 1, x, y, w, { alpha: e, rise: 10 * (1 - e) });
          p.text([[`#${b.pages[tk.from].id}`, p.theme.muted]], x, y + w * 1.25 + 30, { size: SMALL, alpha: e });
          p.hit({ x, y, w, h: w * 1.25, key: `e${n}`, open: b.href(tk.from), loupe: statementLoupe(b, tk.from, tk.from + 1) });
        } else if (tk.kind === 'op') p.text([['+', p.theme.muted]], x + tw / 2, mid + 10, { align: 'center', size: TEXT + 6, alpha: e });
        else {
          // A bracket as tall as the drawings: a light curve, not a glyph.
          const h = w * 1.25 + 24, cx = x + tw / 2, top = y - 12, bend = (tk.kind === '(' ? -1 : 1) * br * 0.27;
          p.lines((g) => (g.moveTo(cx - bend / 3, top), g.quadraticCurveTo(cx + bend, top + h / 2, cx - bend / 3, top + h)), p.theme.muted, 3, e);
        }
        x += tw + fit.gap;
      }
      y += w * 1.25 + label + rowGap;
    }
    // = this one, large, centred under the sum, its pages stacked behind it.
    const reach = p.reach(A, b.n), ax = p.W / 2 - (A + reach) / 2, ay = y - rowGap + between + reach;
    const e = span(t, n * 0.11 + 0.2, 0.55);
    p.art(b, b.fmt(0), 0, b.n, ax, ay, A, { sheets: b.n, alpha: e, rise: 10 * (1 - e), scale: 0.96 + 0.04 * e });
    p.text([['=', p.theme.muted]], ax - 44, ay + (A * 1.25) / 2 + 14, { align: 'center', size: TEXT + 14, alpha: e });
    p.text(`#${b.id}`, ax, ay + A * 1.25 + 34, { alpha: e });
    p.hit({ x: ax, y: ay, w: A, h: A * 1.25, key: 'answer', loupe: statementLoupe(b, 0, b.n) });
    p.caption(`Statement #${b.id}`, `${count(b.n, 'page')}, one equation`);
  }
}

/// Each overprint as a sum, oldest first: the Statement as it stood + the one burned onto it = what it made. Over
/// them, the whole thing on one line. The sums write themselves out one after another as it comes into view.
class SumsScene extends Scene {
  readonly key = 'sums';
  static ROW = 0.36;
  private dim = 0;
  length() {
    return 0.4 + this.b.steps.length * SumsScene.ROW + 0.5 + 2.2;
  }
  animating() {
    return super.animating() || Math.abs(this.dim - (this.hover ? 1 : 0)) > 0.01;
  }
  advance(dt: number) {
    super.advance(dt);
    this.dim = still() ? (this.hover ? 1 : 0) : chase(this.dim, this.hover ? 1 : 0, dt, 14);
  }
  formula() {
    const b = this.b;
    const term = (i: number, top: boolean): string => {
      const me = `#${b.pages[i].id}`;
      if (!b.kids[i].length) return me;
      const inner = [me, ...b.kids[i].map((k) => term(k, false))].join(' + ');
      return top ? inner : `(${inner})`;
    };
    return term(0, true);
  }
  draw(p: Pen, t: number) {
    const b = this.b, S = b.steps.length;
    const head = this.formula(), result = ` = #${b.id}`;
    const showHead = p.width(head + result) <= p.W - 2 * M;
    const top = M + (showHead ? 80 : 8), bottom = p.H - M - CAP - 10;
    const colGap = 56, num = 36, op = 40, gap = 10, label = 34, rowGap = 34;
    const fit = (cols: number) => {
      const per = Math.ceil(S / cols), colW = (p.W - 2 * M - (cols - 1) * colGap) / cols;
      let w = Math.min(cols === 1 || p.W > VW ? 190 : 150, (colW - num - 2 * op - 4 * gap - 40) / 3);
      if (per * (w * 1.25 + label + rowGap) > bottom - top) w = ((bottom - top) / per - label - rowGap) / 1.25;
      return { cols, per, w };
    };
    // One column for a few sums, two for more; a wide picture takes whichever draws them largest.
    let f = fit(S <= 4 ? 1 : 2);
    if (p.W > VW) for (const c of [1, 2, 3]) if (fit(c).w > f.w + 0.5) f = fit(c);
    const { cols, per, w } = f;
    const terms = (s: Step): [number, number][] => [
      [s.base, s.before],
      [s.top, s.top + b.size[s.top]],
      [s.base, s.after],
    ];
    // The columns sit side by side as wide as their longest sum, centred.
    const rowW = Math.max(...b.steps.map((s) => terms(s).reduce((x, [from, to]) => x + w + p.reach(w, to - from) + gap, num + 2 * op - gap)));
    const left = (p.W - cols * rowW - (cols - 1) * colGap) / 2;
    const rowH = w * 1.25 + label + rowGap;
    const y0 = top + (bottom - top - per * rowH + rowGap) / 2;
    if (showHead) p.text([[head, p.theme.muted], [result, p.theme.fg]], p.W / 2, M + 30, { align: 'center', alpha: span(t, 0, 0.5) });
    const pointedRow = p.live && this.hover?.key?.startsWith('r') ? Number(this.hover.key.split(':')[0].slice(1)) : null;
    b.steps.forEach((s, n) => {
      const col = Math.floor(n / per), row = n % per;
      const x0 = left + col * (rowW + colGap), y = y0 + row * rowH;
      const dim = pointedRow != null && pointedRow !== n ? 1 - 0.6 * this.dim : 1;
      const at = 0.35 + n * SumsScene.ROW;
      p.text([[`${n + 1}`, p.theme.muted]], x0, y + (w * 1.25) / 2 + 9, { alpha: dim * span(t, at, 0.3) });
      let x = x0 + num;
      terms(s).forEach(([from, to], k) => {
        const pages = to - from;
        const e = span(t, at + k * 0.08 + (k === 2 ? 0.08 : 0), 0.36);
        p.art(b, b.fmt(from), from, to, x, y, w, { alpha: dim * e, sheets: pages, rise: 8 * (1 - e), scale: k === 2 ? 0.96 + 0.04 * e : 1 });
        p.text([[`#${b.pages[from].id}`, k === 2 ? p.theme.fg : p.theme.muted]], x, y + w * 1.25 + 28, { size: SMALL, alpha: dim * e });
        p.hit({ x, y, w, h: w * 1.25, key: `r${n}:${k}`, open: pages === 1 ? b.href(from) : undefined, loupe: statementLoupe(b, from, to) });
        x += w + p.reach(w, pages) + gap;
        if (k < 2) p.text([[k ? '=' : '+', p.theme.muted]], x + op / 2 - gap / 2, y + (w * 1.25) / 2 + 9, { align: 'center', alpha: dim * span(t, at + k * 0.08 + 0.05, 0.3) });
        x += k < 2 ? op : 0;
      });
    });
    p.caption(`Statement #${b.id}`, S === 1 ? '1 overprint' : `${count(S, 'overprint')}, oldest first`);
  }
}

/// The Statement in all eight formats, three by three with what it is in the ninth: the same ink, eight ways. Click
/// one to see the Statement in it.
class FormatsScene extends Scene {
  readonly key = 'formats';
  click(_x: number, _y: number, hit: Hit | null) {
    if (hit?.format) this.v.hooks.format(hit.format);
  }
  cursor(hit: Hit | null) {
    return hit?.format ? 'pointer' : 'default';
  }
  length() {
    return SHOWN.length * 0.08 + 0.5 + 2.4;
  }
  draw(p: Pen, t: number) {
    const b = this.b, N = b.n, own = b.fmt(0);
    const gap = 26, label = 40, room = p.H - 2 * M - CAP - 10;
    // Nine cells, the eight and what it is, in the columns that draw them largest: three by three, more in a wide one.
    const size = (cols: number) => {
      const rows = Math.ceil(9 / cols);
      return Math.min((p.W - 2 * M - (cols - 1) * gap) / cols, (room - rows * label - (rows - 1) * gap) / rows / 1.25);
    };
    let cols = 3;
    for (let c = 1; c <= 9; c++) if (size(c) > size(cols) + 0.5) cols = c;
    const rows = Math.ceil(9 / cols), w = size(cols), h = w * 1.25;
    const gw = cols * w + (cols - 1) * gap, x0 = (p.W - gw) / 2, y0 = M + (room - (rows * (h + label) + (rows - 1) * gap)) / 2;
    const cell = (i: number) => ({ x: x0 + (i % cols) * (w + gap), y: y0 + Math.floor(i / cols) * (h + label + gap) });
    SHOWN.forEach((d, i) => {
      const { x, y } = cell(i);
      const e = span(t, i * 0.08, 0.42);
      p.art(b, d, 0, N, x, y, w, { alpha: e, rise: 10 * (1 - e) });
      p.text([[d, d === own ? p.theme.fg : p.theme.muted], ...(d === own ? ([['  ·  its format', p.theme.muted]] as [string, string][]) : [])], x, y + h + 30, { size: SMALL, alpha: e });
      p.hit({ x, y, w, h, key: `f${i}`, format: d, loupe: { from: 0, to: N, as: d, title: d, note: d === own ? 'Its format' : `A preview: it's ${own}` } });
    });
    // The ninth: what it is.
    const { x, y } = cell(8), e = span(t, SHOWN.length * 0.08, 0.42);
    const rating = Number(b.pages.reduce((t, pg) => t + pg.own, 0n) / 10_000n).toLocaleString('en-US');
    p.text(count(N, 'page'), x, y + 34, { alpha: e });
    p.text([[`${(N * 80).toLocaleString('en-US')} Credits`, p.theme.muted]], x, y + 72, { alpha: e });
    p.text([[`Rating ${rating}`, p.theme.muted]], x, y + 108, { alpha: e });
    p.text([[`The same ink, eight ways`, p.theme.muted]], x, y + h - 4, { size: SMALL, alpha: e });
    p.caption(`Statement #${b.id}`, 'All eight formats');
  }
}

/// Every Credit in it: a sheet for each page, its 80 Credits in their places, named by the Statement it was. Point
/// at a Credit to see it large; click it to open it.
class CreditsScene extends Scene {
  readonly key = 'credits';
  length() {
    return 0.25 + Math.min(this.b.n, 24) * 0.07 + 0.6 + 2.2;
  }
  layout(p: Pen) {
    const N = this.b.n, gap = 26, label = 40, room = p.H - 2 * M - CAP - 10, wide = p.W - 2 * M;
    let best = { cols: 1, s: 0 };
    for (let cols = 1; cols <= N; cols++) {
      const rows = Math.ceil(N / cols);
      const s = Math.min((wide - (cols - 1) * gap) / (8 * cols), (room - rows * label - (rows - 1) * gap) / (10 * rows));
      if (s > best.s) best = { cols, s };
    }
    const { cols, s } = best, rows = Math.ceil(N / cols);
    const gw = cols * 8 * s + (cols - 1) * gap, gh = rows * (10 * s + label) + (rows - 1) * gap;
    return { cols, s, gap, label, x0: (p.W - gw) / 2, y0: M + (room - gh) / 2 };
  }
  /// Issued shows the Credits themselves, a tile each; any other format draws each page in it, every sheet alike, its
  /// Credits pointable where the format keeps each in its place.
  draw(p: Pen, t: number) {
    const b = this.b, N = b.n, f = b.fmt(0);
    const { cols, s, gap, x0, y0, label } = this.layout(p);
    for (let i = 0; i < N; i++) {
      const sx = x0 + (i % cols) * (8 * s + gap), sy = y0 + Math.floor(i / cols) * (10 * s + label + gap);
      const e = span(t, 0.25 + Math.min(i, 24) * 0.07, 0.45);
      if (e <= 0) continue;
      const credit = (c: number, x: number, y: number, w: number, h: number) => {
        const id = b.pages[i].from[c], ink = b.inks[i][c];
        p.hit({ x, y, w, h, key: `c${i}:${c}`, open: `/credit/${id}`, loupe: { credit: id, px: ink?.px ?? null, title: `Credit #${id.toLocaleString('en-US')}`, note: `On #${b.pages[i].id}, page ${i + 1} of ${N}` } });
      };
      if (f === 'Issued')
        for (let c = 0; c < 80; c++) {
          const x = sx + (c % 8) * s, y = sy + Math.floor(c / 8) * s;
          p.raster(b.inks[i][c]?.px ?? null, x + 1, y + 1 + 8 * (1 - e), s - 2, { alpha: e, edge: false });
          credit(c, x, y, s, s);
        }
      else {
        p.art(b, f, i, i + 1, sx, sy + 8 * (1 - e), 8 * s, { alpha: e });
        const k = (8 * s) / PAGE.w;
        if (slotBox(f, 0))
          for (let c = 0; c < 80; c++) {
            const [x, y, w, h] = slotBox(f, c)!;
            credit(c, sx + x * k, sy + y * k, w * k, h * k);
          }
        else p.hit({ x: sx, y: sy, w: 8 * s, h: 10 * s, key: `c${i}:page`, open: b.href(i), loupe: { from: i, to: i + 1, as: f, title: `Statement #${b.pages[i].id}`, note: `Page ${i + 1} of ${N} · ${f}` } });
      }
      p.text([[`#${b.pages[i].id}`, p.theme.muted]], sx, sy + 10 * s + 30, { size: SMALL, alpha: e });
    }
    const on = p.live && this.hover?.key?.startsWith('c') ? this.hover : null;
    if (on) p.ring(p.px(on.x + 1), p.px(on.y + 1), p.px(on.x + on.w - 1) - p.px(on.x + 1), p.px(on.y + on.h - 1) - p.px(on.y + 1));
    p.caption(`Statement #${b.id}`, `${(N * 80).toLocaleString('en-US')} Credits on ${N} pages`);
  }
}

/// When a page was made and when it was burned onto another (null while it stands), in ms.
export type Life = { made: number | null; burned: number | null };
const day = (ms: number) => new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
const clock = (ms: number) => new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
const lasted = (ms: number) => {
  const m = Math.max(1, Math.round(ms / 60_000)), h = Math.round(m / 60);
  return m < 90 ? count(m, 'minute') : h < 48 ? count(h, 'hour') : count(Math.round(h / 24), 'day');
};

/// Every page's life on one time line: a line from when it was made to when it was burned onto another, joining that
/// one's line, until one is left. When the burning was quick next to the making, the axis gives each its half: days
/// while they were made, minutes while they were burned. Play draws it along time. Point at a line for its dates;
/// click it to open that Statement.
class TimelineScene extends Scene {
  readonly key = 'timeline';
  animated = true;
  lives: Life[] | null = null;
  private asked = false;
  private failed = false;
  private dim = 0;
  length() {
    return 7.5;
  }
  enter() {
    super.enter();
    this.read();
  }
  /// When its pages were made and burned, read once (the page asks early, so it's there when the view opens).
  read() {
    if (this.asked) return;
    this.asked = true;
    const read = this.v.hooks.lives;
    if (!read) return void (this.failed = true);
    const shown = () => this.v.scene === this && this.v.draw();
    read(this.b.pages.map((pg) => pg.id)).then(
      (l) => ((this.lives = l), shown()),
      () => ((this.failed = true), shown()),
    );
  }
  lane() {
    return this.hover?.key?.startsWith('l') ? Number(this.hover.key.slice(1)) : null;
  }
  animating() {
    return super.animating() || Math.abs(this.dim - (this.lane() != null ? 1 : 0)) > 0.01;
  }
  advance(dt: number) {
    super.advance(dt);
    const to = this.lane() != null ? 1 : 0;
    this.dim = still() ? to : chase(this.dim, to, dt, 14);
  }
  draw(p: Pen, t: number, moving: boolean) {
    const b = this.b, N = b.n, L = this.lives;
    const made = L?.map((l) => l.made).filter((v): v is number => v != null) ?? [];
    if (!L || made.length < N) {
      p.text([[this.failed || (L && made.length < N) ? 'Couldn’t read when these were made' : 'Reading the dates from the chain…', p.theme.muted]], p.W / 2, p.H / 2, { align: 'center' });
      return p.caption(`Statement #${b.id}`, count(N, 'page'));
    }
    // Its own burn, if it has since gone onto another Statement, lies past its story: its line runs to the end.
    const gone = (i: number) => (i === 0 ? null : L[i].burned);
    const burned = L.map((_, i) => gone(i)).filter((v): v is number => v != null);
    const t0 = Math.min(...made), b0 = burned.length ? Math.min(...burned) : Math.max(...made), b1 = burned.length ? Math.max(...burned) : b0;
    const end = b1 + Math.max((b1 - b0) * 0.12, 120_000);
    // Room at the left for the first drawing, at the right for the Statement it ends as.
    const fw = 120, xl = M + 90, xr = p.W - M - fw - 40;
    const split = b0 > t0 && b0 - t0 > 4 * (end - b0), xs = xl + (xr - xl) * 0.5;
    const X = (v: number) => (split ? (v <= b0 ? xl + ((v - t0) / (b0 - t0)) * (xs - xl) : xs + ((v - b0) / (end - b0)) * (xr - xs)) : xl + ((v - t0) / Math.max(1, end - t0)) * (xr - xl));
    const axisH = 70, top = M + 20, laneH = Math.min(150, (p.H - 2 * M - CAP - axisH - 20) / N);
    const y0 = top + (p.H - 2 * M - CAP - axisH - 20 - laneH * N) / 2;
    const Y = (i: number) => y0 + (i + 0.5) * laneH;
    const tw = Math.min(56, (laneH * 0.52) / 1.25), th = tw * 1.25;
    // Played, a sweep runs across time and things appear as it passes them.
    const sweep = moving ? xl - tw + (xr + fw + 40 - xl + tw) * span(t, 0.4, 5.6, easeInOut) : Infinity;
    const pointed = p.live && !moving ? this.lane() : null;
    const index = new Map(b.pages.map((pg, i) => [pg.id, i]));
    const fade = (i: number) => (pointed != null && pointed !== i ? 1 - 0.75 * this.dim : 1);
    // Where each line turns into the one it was burned onto: at its time, but never nearer another turn than GAP, so
    // pages burned within a minute of each other keep their own lines; pushed back from the end if that runs past it.
    const GAP = 18, turn = new Map<number, number>();
    const order = L.map((_, i) => i).filter((i) => gone(i) != null).sort((a, c) => gone(a)! - gone(c)!);
    let at = -Infinity;
    for (const i of order) turn.set(i, (at = Math.max(X(gone(i)!), at + GAP)));
    at = xr + GAP;
    for (const i of [...order].reverse()) turn.set(i, (at = Math.min(turn.get(i)!, at - GAP)));
    const until = (i: number) => turn.get(i) ?? xr;
    // Lines first, the later pages under the earlier, then each one's drawing at its start.
    for (let i = N - 1; i >= 0; i--) {
      const l = L[i], x0 = X(l.made!), x1 = until(i), y = Y(i);
      if (sweep < x0) continue;
      const color = pointed === i && this.dim > 0.5 ? p.theme.fg : p.theme.line;
      const reach = Math.min(x1, sweep);
      p.lines((g) => (g.moveTo(x0, y), g.lineTo(reach, y)), color, 2, fade(i));
      const parent = b.pages[i].parent, j = parent != null ? index.get(parent) : undefined;
      if (gone(i) != null && j != null && sweep >= x1) {
        p.lines((g) => (g.moveTo(x1, y), g.lineTo(x1, Y(j))), color, 2, fade(i));
        p.fill(x1 - 3, Y(j) - 3, 6, 6, color === p.theme.line ? p.theme.muted : p.theme.fg, fade(i));
      }
    }
    for (let i = 0; i < N; i++) {
      const l = L[i], x0 = X(l.made!), y = Y(i);
      const a = moving ? clamp((sweep - x0 + tw) / 40) : 1;
      if (a <= 0) continue;
      const on = pointed === i && this.dim > 0.5;
      p.art(b, b.fmt(i), i, i + 1, x0 - tw - 8, y - th / 2, tw, { alpha: a * fade(i), ring: on });
      p.text([[`#${b.pages[i].id}`, on ? p.theme.fg : p.theme.muted]], x0 - tw - 8, y + th / 2 + 26, { size: SMALL - 2, alpha: a * fade(i) });
      p.hit({ x: x0 - tw - 8, y: y - laneH / 2, w: until(i) - x0 + tw + 8, h: laneH, key: `l${i}`, open: b.href(i), loupe: statementLoupe(b, i, i + 1) });
    }
    // What it is now, at the end of the first line.
    const fa = moving ? clamp((sweep - xr) / 40) : 1;
    if (fa > 0) {
      const fh = fw * 1.25, reach = p.reach(fw, N);
      p.art(b, b.fmt(0), 0, N, xr + 24, Y(0) - fh / 2 + reach / 2, fw, { sheets: N, alpha: fa });
      p.text(`#${b.id}`, xr + 24, Y(0) + fh / 2 + reach / 2 + 30, { size: SMALL, alpha: fa });
    }
    // The axis: the days at the left, the minutes of the burning at the right, a break between.
    const ay = y0 + N * laneH + 24;
    p.lines((g) => (g.moveTo(xl, ay), g.lineTo(xr, ay)), p.theme.line, 2);
    const tick = (x: number, label: string, align: 'left' | 'center' | 'right' = 'center') => {
      p.lines((g) => (g.moveTo(x, ay - 6), g.lineTo(x, ay + 6)), p.theme.muted, 2);
      p.text([[label, p.theme.muted]], x, ay + 36, { size: SMALL - 2, align });
    };
    // Each midnight the making ran through, named by the day it starts; the first day's date if it ran through none.
    const days: number[] = [];
    for (let d = new Date(t0); ; ) {
      d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
      if (d.getTime() >= (split ? b0 : end) || X(d.getTime()) > (split ? xs : xr) - 100) break;
      days.push(d.getTime());
    }
    if (days.length) days.forEach((v) => tick(X(v), day(v)));
    else tick(xl, day(t0), 'left');
    if (burned.length) {
      tick(X(b0), split ? `${day(b0)}, ${clock(b0)}` : clock(b0), split ? 'left' : 'center');
      if (X(b1) - X(b0) > 120) tick(X(b1), clock(b1));
    }
    if (split) {
      p.fill(xs - 10, ay - 10, 20, 20, p.theme.ground);
      p.lines((g) => (g.moveTo(xs - 9, ay + 8), g.lineTo(xs - 3, ay - 8), g.moveTo(xs + 3, ay + 8), g.lineTo(xs + 9, ay - 8)), p.theme.muted, 2);
    }
    const i = pointed;
    const right =
      i != null
        ? [[`#${b.pages[i].id}`, p.theme.fg], [`  ·  made ${day(L[i].made!)}, ${clock(L[i].made!)}${gone(i) != null ? `  ·  burned onto #${b.pages[i].parent} ${day(gone(i)!)}, ${clock(gone(i)!)}` : ''}`]]
        : `Made over ${lasted(Math.max(...made) - t0)}, burned into one in ${lasted(b1 - b0)}`;
    p.caption(`Statement #${b.id}`, right as [string, string?][] | string);
  }
}

export type Film = { name: string; length: number; loop: boolean; at: number; draw(g: CanvasRenderingContext2D, W: number, H: number, t: number, moving: boolean): void };

/// The views in one frame: which one shows, play, the pointer and the keys, and the films they export.
export class Views {
  readonly scenes: Record<ViewKey, Scene>;
  scene: Scene;
  hits: Hit[] = [];
  /// The picture's size in its units as the frame last drew it.
  W = VW;
  H = VH;
  private raf = 0;
  private last = 0;
  private down: { x: number; y: number; cx: number; cy: number; moved: boolean } | null = null;
  constructor(
    readonly book: Book,
    public canvas: HTMLCanvasElement,
    readonly hooks: { changed(): void; open(href: string): void; format(d: Direction): void; peek(l: Loupe | null): void; lives?(ids: bigint[]): Promise<Life[]> },
  ) {
    this.scenes = {
      statement: new StatementScene(this),
      stack: new StackScene(this),
      cells: new CellsScene(this),
      tree: new TreeScene(this),
      equation: new EquationScene(this),
      sums: new SumsScene(this),
      formats: new FormatsScene(this),
      credits: new CreditsScene(this),
      timeline: new TimelineScene(this),
    };
    this.scene = this.scenes.statement;
    this.scene.enter();
    this.listen(canvas);
    void document.fonts?.ready.then(() => this.draw());
  }
  theme(): Theme {
    const r = getComputedStyle(document.documentElement), v = (k: string) => r.getPropertyValue(k).trim();
    return { ground: v('--empty') || '#161616', fg: v('--fg') || '#f5f5f5', muted: v('--muted') || '#8f8f8f', line: v('--line-strong') || 'rgba(255,255,255,.16)' };
  }
  show(k: ViewKey) {
    if (this.scene.key === k) return;
    this.scene.playing = false;
    this.scene.hover = null;
    this.peek(null);
    this.scene = this.scenes[k];
    this.scene.hover = null;
    this.scene.enter();
    this.draw();
    this.kick();
    this.hooks.changed();
  }
  open(href: string) {
    this.hooks.open(href);
  }
  private peeking: Loupe | null = null;
  /// What the pointer is on, large, for the page to show beside the frame (only when it changes).
  peek(l: Loupe | null) {
    if (l === this.peeking || (l && this.peeking && l.title === this.peeking.title && l.note === this.peeking.note)) return;
    this.peeking = l;
    this.hooks.peek(l);
  }
  play() {
    const sc = this.scene;
    if (!sc.animated) return;
    if (sc.playing) sc.playing = false;
    else {
      if (sc.t >= sc.length() - 1e-3 && !sc.loop) sc.t = 0;
      sc.playing = true;
      this.kick();
    }
    this.hooks.changed();
    this.draw();
  }
  get playing() {
    return this.scene.playing;
  }
  /// At the end of its run: Play starts it over.
  get ended() {
    const sc = this.scene;
    return sc.animated && !sc.loop && !sc.playing && sc.t >= sc.length() - 1e-3;
  }
  /// What a view reads from elsewhere, read ahead while nothing else is going on.
  warm() {
    (this.scenes.timeline as TimelineScene).read();
  }
  kick() {
    if (this.raf) return;
    this.last = performance.now();
    this.raf = requestAnimationFrame(this.tick);
  }
  private tick = (now: number) => {
    this.raf = 0;
    if (!this.canvas.isConnected) return;
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    const sc = this.scene;
    if (sc.playing) {
      sc.t += dt;
      const L = sc.length();
      if (sc.t >= L) {
        if (sc.loop) sc.t %= L;
        else {
          sc.t = L;
          sc.playing = false;
          this.hooks.changed();
        }
      }
    }
    sc.advance(dt);
    this.draw();
    if (sc.playing || sc.animating()) this.kick();
  };
  draw() {
    const r = this.canvas.getBoundingClientRect();
    if (!r.width || !r.height) return;
    // The picture's units: 1080 × 1350 in a 4:5 frame; a wider frame widens the picture, a narrower one heightens it.
    const aspect = r.width / r.height;
    if (Math.abs(aspect - VW / VH) < 0.01) (this.W = VW), (this.H = VH);
    else if (aspect > VW / VH) (this.W = Math.round(VH * aspect)), (this.H = VH);
    else (this.W = VW), (this.H = Math.round(VW / aspect));
    const W = Math.round(r.width * Math.min(3, devicePixelRatio || 1)), H = Math.round((W * this.H) / this.W);
    if (this.canvas.width !== W || this.canvas.height !== H) (this.canvas.width = W), (this.canvas.height = H);
    const g = this.canvas.getContext('2d')!;
    const pen = new Pen(g, W / this.W, this.theme(), true, this.W, this.H);
    pen.ground();
    this.scene.draw(pen, this.scene.t, this.scene.playing);
    this.hits = pen.hits;
  }
  /// The film of the view as it is now: its animation from the start, or this moment as a still.
  film(): Film {
    const sc = this.scene, theme = this.theme();
    return {
      name: `statement-${this.book.id}-${sc.key}`,
      // Only the Stack's film moves; every other view is a picture of it as it shows (the print run at the layer
      // you scrubbed to).
      length: sc.animated ? sc.length() : 0,
      loop: sc.loop,
      at: sc.t,
      draw: (g, W, H, t, moving) => {
        const pen = new Pen(g, W / VW, theme, false);
        pen.ground();
        sc.draw(pen, t, moving);
      },
    };
  }
  private point(e: PointerEvent) {
    const r = this.canvas.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * this.W, y: ((e.clientY - r.top) / r.height) * this.H };
  }
  private hitAt(x: number, y: number) {
    for (let i = this.hits.length - 1; i >= 0; i--) {
      const h = this.hits[i];
      if (x >= h.x && y >= h.y && x <= h.x + h.w && y <= h.y + h.h) return h;
    }
    return null;
  }
  private listen(c: HTMLCanvasElement) {
    c.addEventListener('pointerdown', (e) => {
      const v = this.point(e);
      this.down = { ...v, cx: e.clientX, cy: e.clientY, moved: false };
      c.setPointerCapture(e.pointerId);
    });
    c.addEventListener('pointermove', (e) => {
      const v = this.point(e), sc = this.scene;
      if (this.down) {
        if (!this.down.moved && Math.hypot(e.clientX - this.down.cx, e.clientY - this.down.cy) > 4) this.down.moved = true;
        if (this.down.moved && sc.drag(v.x - this.down.x, v.y - this.down.y)) {
          this.hooks.changed();
          this.draw();
          this.kick();
        }
        this.down.x = v.x;
        this.down.y = v.y;
        return;
      }
      const hit = this.hitAt(v.x, v.y);
      if (sc.move(v.x, v.y, hit)) {
        this.draw();
        this.kick();
      }
      this.peek(sc.hover?.loupe ?? null);
      c.style.cursor = sc.cursor(hit);
    });
    c.addEventListener('pointerup', (e) => {
      const v = this.point(e);
      if (this.down && !this.down.moved) {
        this.scene.click(v.x, v.y, this.hitAt(v.x, v.y));
        this.hooks.changed();
        this.draw();
        this.kick();
      } else if (this.down?.moved) {
        this.scene.release();
        this.kick();
      }
      this.down = null;
    });
    c.addEventListener('pointerleave', () => {
      if (this.down) return;
      this.peek(null);
      const sc = this.scene;
      if (sc.hover) {
        sc.hover = null;
        this.draw();
        this.kick();
      }
    });
  }
  /// Keys the view takes before the page does (the Statement's and Cells' arrows).
  keys(e: KeyboardEvent) {
    if (this.scene.keys(e)) {
      this.draw();
      this.kick();
      return true;
    }
    return false;
  }
}
