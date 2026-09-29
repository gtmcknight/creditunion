/// A picture framed for a sheet: the example strip, upload (button, drop or paste), and a 4:5 window you drag and
/// zoom. The Printer matches exact Credits to it; a Picture union paints its sheet from the Credits that draw it and
/// keeps recommending the best Credit for each open slot (Guide).
import type { Address } from 'viem';
import { bin } from './bins';
import { myCredits } from './data';
import { costs, type Candidate } from './printer-match';

/// Pictures to start from: a few faces, space photos (NASA; the black hole is the Event Horizon Telescope's, CC-BY 4.0)
/// and geometric designs in the Credits' own inks, with shapes at least a Credit wide so they survive the print.
/// Five at a time, a different five per visit.
export const EXAMPLES = [
  ['Jack', '/examples/jack.jpg'],
  ['Mona Lisa', '/examples/mona-lisa.jpg'],
  ['Girl with a Pearl Earring', '/examples/pearl-earring.jpg'],
  ['The Sun', '/examples/sun.jpg'],
  ['Black hole', '/examples/black-hole.jpg'],
  ['Blue Marble', '/examples/blue-marble.jpg'],
  ['Jupiter', '/examples/jupiter.jpg'],
  ['Saturn', '/examples/saturn.jpg'],
  ['Rings', '/examples/rings.png'],
  ['Sunburst', '/examples/sunburst.png'],
  ['Waves', '/examples/waves.png'],
  ['Spiral', '/examples/spiral.png'],
  ['CMYK', '/examples/cmyk.png'],
  ['Dot', '/examples/dot.png'],
] as const;

export type Framer = {
  /// Redraw the window (after the contrast or background changed).
  frame(): void;
  /// The framed picture at 64 × 80, one 8 × 8 patch per slot.
  pixels(): Uint8ClampedArray;
  /// The picture's name: the example's, or the uploaded file's.
  label(): string;
  /// A picture is loaded.
  ready(): boolean;
  /// Back to the whole picture, centred.
  reset(): void;
};

/// Wires a framer onto its elements. `settle` runs once a change is done (a new picture, a drag let go, a zoom);
/// `minZoom` below 1 lets the picture shrink inside the window on `bg`. The window's own zoom buttons are
/// `[data-zoom]` inside `crop`'s parent.
export function framer(o: {
  crop: HTMLCanvasElement;
  /// The example strip; without one there are no examples, and the empty frame asks for a picture.
  strip?: HTMLElement;
  file: HTMLInputElement;
  shuffle?: HTMLElement | null;
  target?: HTMLCanvasElement;
  contrast: () => number;
  /// Brightness and saturation too (1 = as is), where the page offers them.
  brightness?: () => number;
  saturation?: () => number;
  bg?: () => string;
  minZoom?: number;
  /// At rest, show the picture as the matchers see it (64 × 80, one square per Credit).
  pixelate?: boolean;
  settle: () => void;
}): Framer {
  const { crop, strip, file } = o;
  // No picture yet: the frame itself is the upload box.
  const empty = () => {
    const g = crop.getContext('2d')!;
    g.fillStyle = getComputedStyle(crop).getPropertyValue('--surface') || '#e6e6e3';
    g.fillRect(0, 0, crop.width, crop.height);
    g.fillStyle = getComputedStyle(crop).getPropertyValue('--muted') || '#6b6b6b';
    g.font = `500 ${Math.round(crop.width / 16)}px ${getComputedStyle(crop).fontFamily}`;
    g.textAlign = 'center';
    g.fillText('Drop a picture here', crop.width / 2, crop.height / 2 - crop.width / 24);
    g.fillText('or tap to choose one', crop.width / 2, crop.height / 2 + crop.width / 24);
    crop.style.cursor = 'pointer';
  };
  let img: HTMLImageElement | null = null, zoom = 1, cx = 0.5, cy = 0.5, label = 'Untitled';
  const minZoom = o.minZoom ?? 0.25;
  // The 4:5 window onto the picture. Zoomed out past 1× the window is bigger than the picture, which then sits
  // inside it on the background colour; either way it can be dragged, as far as keeps it in view.
  const win = () => {
    const ir = img!.width / img!.height, r = 4 / 5;
    const w = (ir > r ? img!.height * r : img!.width) / zoom, h = w / r;
    const clamp = (v: number, span: number, size: number) => Math.min(Math.max(v, Math.min(0, size - span)), Math.max(0, size - span));
    return [clamp(cx * img!.width - w / 2, w, img!.width), clamp(cy * img!.height - h / 2, h, img!.height), w, h] as const;
  };
  // The framed picture, drawn clean here; `crop` shows it, or (with `pixelate`, at rest) as the matchers see it.
  const clean = document.createElement('canvas');
  clean.width = crop.width;
  clean.height = crop.height;
  let moving = false;
  const show = () => {
    const g = crop.getContext('2d')!;
    if (!o.pixelate || moving) {
      g.imageSmoothingEnabled = true;
      return g.drawImage(clean, 0, 0);
    }
    // 64 × 80, one 8 × 8 patch per Credit, with the 80 Credits' squares faintly over it.
    const small = pixelsOf(clean), s = document.createElement('canvas');
    s.width = 64;
    s.height = 80;
    s.getContext('2d')!.putImageData(new ImageData(Uint8ClampedArray.from(small), 64, 80), 0, 0);
    g.imageSmoothingEnabled = false;
    g.drawImage(s, 0, 0, crop.width, crop.height);
    g.strokeStyle = 'rgba(255,255,255,0.35)';
    g.lineWidth = 1;
    g.beginPath();
    for (let c = 1; c < 8; c++) (g.moveTo(Math.round((c * crop.width) / 8) + 0.5, 0), g.lineTo(Math.round((c * crop.width) / 8) + 0.5, crop.height));
    for (let r = 1; r < 10; r++) (g.moveTo(0, Math.round((r * crop.height) / 10) + 0.5), g.lineTo(crop.width, Math.round((r * crop.height) / 10) + 0.5));
    g.stroke();
  };
  const frame = () => {
    if (!img) return;
    const [x, y, w] = win(), g = clean.getContext('2d')!, k = crop.width / w;
    g.filter = 'none';
    g.fillStyle = o.bg?.() ?? '#ffffff';
    g.fillRect(0, 0, crop.width, crop.height);
    g.filter = `brightness(${o.brightness?.() ?? 1}) contrast(${o.contrast()}) saturate(${o.saturation?.() ?? 1})`;
    g.imageSmoothingQuality = 'high';
    g.drawImage(img, -x * k, -y * k, img.width * k, img.height * k);
    if (o.target) {
      const t = o.target.getContext('2d')!;
      t.imageSmoothingQuality = 'high';
      t.drawImage(clean, 0, 0, 64, 80);
    }
    show();
  };
  const exValue = (name: string) => strip?.querySelectorAll<HTMLButtonElement>('[data-ex]').forEach((b) => b.setAttribute('aria-pressed', String(b.title === name)));
  const load = (src: string, name: string) => {
    const i = new Image();
    // A picture that finishes loading after its page is gone does nothing.
    i.onload = () => crop.isConnected && ((img = i), (label = name), (zoom = 1), (cx = cy = 0.5), (crop.style.cursor = ''), exValue(name), frame(), o.settle());
    i.src = src;
  };
  // Five examples at a time, plus Upload; Shuffle deals five others.
  let shown: (typeof EXAMPLES)[number][] = [];
  const deal = () => {
    if (!strip) return;
    const rest = EXAMPLES.filter((e) => !shown.includes(e));
    shown = [...rest].sort(() => Math.random() - 0.5).slice(0, 5);
    strip.innerHTML =
      shown.map(([n, src]) => `<button type="button" class="printer-thumb" data-ex="${src}" title="${n}" aria-label="${n}" aria-pressed="${img?.src.endsWith(src) ?? false}"><img src="${src}" alt=""></button>`).join('') +
      '<button type="button" class="printer-thumb printer-upload" data-upload title="Upload your own" aria-label="Upload your own">+</button>';
    strip.querySelectorAll<HTMLButtonElement>('[data-ex]').forEach((b) => b.addEventListener('click', () => load(b.dataset.ex!, b.title)));
    strip.querySelector<HTMLButtonElement>('[data-upload]')!.addEventListener('click', () => file.click());
  };
  o.shuffle?.addEventListener('click', deal);
  deal();
  if (strip) load(shown[0][1], shown[0][0]); // open on one of the five, framed and ready
  else {
    empty();
    crop.addEventListener('click', () => !img && file.click());
  }
  const fromFile = (f?: File | null) => f?.type.startsWith('image/') && load(URL.createObjectURL(f), f.name.replace(/\.\w+$/, ''));
  const drop = crop.parentElement!; // drop an image straight onto the picture
  file.addEventListener('change', () => (fromFile(file.files?.[0]), (file.value = ''))); // the same file again still loads
  drop.addEventListener('dragover', (e) => (e.preventDefault(), drop.classList.add('over')));
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => (e.preventDefault(), drop.classList.remove('over'), fromFile(e.dataTransfer?.files[0])));
  // A pasted image, while this framer is on the page (and showing).
  const onPaste = (e: ClipboardEvent) => (!crop.isConnected ? document.removeEventListener('paste', onPaste) : crop.offsetParent && fromFile(e.clipboardData?.files[0]));
  document.addEventListener('paste', onPaste);
  // Frame on the image itself: drag to move, scroll or pinch to zoom.
  const setZoom = (z: number) => ((zoom = Math.min(4, Math.max(minZoom, z))), frame(), o.settle());
  const down = new Map<number, { x: number; y: number }>();
  let drag: { x: number; y: number; cx: number; cy: number } | null = null, pinch: { d: number; zoom: number } | null = null;
  const spread = () => {
    const [a, b] = [...down.values()];
    return Math.hypot(a.x - b.x, a.y - b.y);
  };
  crop.addEventListener('pointerdown', (e) => {
    if (!img) return;
    crop.setPointerCapture(e.pointerId);
    down.set(e.pointerId, { x: e.clientX, y: e.clientY });
    moving = true; // the real picture while it moves, so it's easy to frame
    show();
    if (down.size === 2) (pinch = { d: spread(), zoom }), (drag = null);
    else drag = { x: e.clientX, y: e.clientY, cx, cy };
  });
  crop.addEventListener('pointermove', (e) => {
    if (!img || !down.has(e.pointerId)) return;
    down.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch && down.size === 2) return setZoom((pinch.zoom * spread()) / pinch.d);
    if (!drag) return;
    const [, , w, h] = win(), s = w / crop.clientWidth;
    cx = Math.min(Math.max(drag.cx - ((e.clientX - drag.x) * s) / img.width, -2), 3);
    cy = Math.min(Math.max(drag.cy - ((e.clientY - drag.y) * s * (h / w) * 1.25) / img.height, -2), 3);
    frame();
  });
  const up = (e: PointerEvent) => {
    down.delete(e.pointerId);
    if (down.size < 2) pinch = null;
    if (down.size) return;
    moving = false;
    show();
    if (drag) (drag = null), o.settle();
  };
  crop.addEventListener('pointerup', up);
  crop.addEventListener('pointercancel', up);
  // Trackpad pinch arrives as ctrl+wheel with small steps (Chrome, Firefox) or as gesture events (Safari).
  crop.addEventListener('wheel', (e) => img && (e.preventDefault(), setZoom(zoom * Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.002)))), { passive: false });
  let gesture = 1;
  crop.addEventListener('gesturestart', (e) => (e.preventDefault(), (gesture = zoom)));
  crop.addEventListener('gesturechange', (e) => (e.preventDefault(), setZoom(gesture * (e as unknown as { scale: number }).scale)));
  drop.querySelectorAll<HTMLButtonElement>('[data-zoom]').forEach((b) => b.addEventListener('click', () => setZoom(zoom * (b.dataset.zoom === 'in' ? 1.25 : 0.8))));
  const reset = () => {
    zoom = 1;
    cx = cy = 0.5;
    frame();
  };
  return { frame, pixels: () => pixelsOf(clean), label: () => label, ready: () => !!img, reset };
}

/// The picture as the matchers see it: 64 × 80 pixels.
export function pixelsOf(src: HTMLCanvasElement | HTMLImageElement): Uint8ClampedArray {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 80;
  const g = c.getContext('2d')!;
  g.imageSmoothingQuality = 'high';
  g.drawImage(src, 0, 0, 64, 80);
  return g.getImageData(0, 0, 64, 80).data;
}

// ---------------------------------------------------------------- the Credits that draw it

/// Everything the matchers read: every Credit's print, its packed traits (palette in the low 4 bits; registered when
/// its print trait is 0, since a misprint's ink spills into the next patch), and the market. Read once per visit.
type Base = { wall: Uint8Array; traits: Uint32Array; registered: (id: number) => boolean; market: Map<number, number> };
let base: Promise<Base> | null = null;
export function loadBase() {
  return (base ??= Promise.all([bin('wall.bin'), bin('edition-traits.bin'), fetch('/market.json').then((r) => r.json() as Promise<{ items?: [string, string, string][] }>)]).then(([w, t, m]) => {
    const traits = new Uint32Array(t);
    const market = new Map<number, number>();
    for (const [id, price] of m.items ?? []) market.set(Number(id), Number(price) / 1e18);
    return { wall: new Uint8Array(w), traits, registered: (id: number) => ((traits[id - 1] >> 4) & 7) === 0, market };
  })).catch((e) => {
    base = null;
    throw e;
  });
}
/// A Credit's Colors value (CMYK mask).
export const paletteOf = (b: Base, id: number) => b.traits[id - 1] & 15;

/// Candidates: the wallets' own registered Credits (free), then every registered listing nobody here owns, except
/// `skip` (Credits already in the union).
/// `held`: the first wallet's Credits as the page already knows them (read from chain when not given).
export async function candidates(wallets: Address[], skip: ReadonlySet<number> = new Set(), held?: readonly bigint[]) {
  const b = await loadBase();
  const owned = await Promise.all(wallets.map((a, w) => (w === 0 && held ? Promise.resolve(held) : myCredits(a).catch(() => [] as readonly bigint[]))));
  const cands: Candidate[] = [];
  const mine = new Set<number>();
  owned.forEach((ids, w) =>
    ids.forEach((x) => {
      const id = Number(x);
      if (b.registered(id) && !skip.has(id)) cands.push({ id, price: 0, owner: w }), mine.add(id);
    }),
  );
  for (const [id, price] of b.market) if (!mine.has(id) && !skip.has(id) && b.registered(id)) cands.push({ id, price, owner: -1 });
  return { cands, wall: b.wall, owned: owned.map((x) => x.length), base: b };
}

/// Most a recommended listing may cost, and how much edges count, as the Printer's defaults.
const MAX_PRICE = 0.08;
export const DETAIL = 2;

/// A picture against the Credits that could draw it: every candidate's cost at every slot (likeness, then price, less
/// a bonus for ones the wallet already holds), so the sheet can be designed and each open slot given its best Credit.
export class Guide {
  private constructor(
    readonly cands: Candidate[],
    private cost: Float32Array[],
    private pal: Uint8Array,
    private detail: number[],
  ) {}

  /// `wallets`: whose Credits count as theirs (the viewer's). `held`: the first wallet's Credits that can go in, when
  /// the page knows better than a chain read, and `colours` their Colors as the contract reads them. `detail`: how
  /// much to favour Credits that keep edges (eyes, mouths), 0 to 4, as the Printer's Detail.
  static async of(px: Uint8ClampedArray, o: { wallets?: Address[]; held?: readonly bigint[]; colours?: (id: bigint) => number; detail?: number; progress?: (f: number) => void } = {}) {
    const { cands: all, wall, base: b } = await candidates(o.wallets ?? [], new Set(), o.held);
    const cands = all.filter((c) => c.owner >= 0 || c.price <= MAX_PRICE);
    const cost = await costs(px, cands, wall, { features: o.detail ?? DETAIL, maxPrice: MAX_PRICE, own: 1 }, o.progress);
    return new Guide(cands, cost, Uint8Array.from(cands, (c) => (c.owner === 0 && o.colours?.(BigInt(c.id))) || paletteOf(b, c.id)), detailOf(px));
  }

  /// A sheet for the picture: the best Credit for each slot, the most detailed slots choosing first, and its Colors
  /// painted where it goes.
  /// `allowed`: only Credits of these Colors.
  design(allowed?: ReadonlySet<number>): { layout: number[]; ids: number[] } {
    const used = Uint8Array.from(this.pal, (m) => (allowed && !allowed.has(m) ? 1 : 0)), ids = new Array<number>(80);
    for (const t of [...Array(80).keys()].sort((a, b) => this.detail[b] - this.detail[a])) {
      const j = this.best(t, used, 0);
      if (j < 0) throw new Error('Not enough Credits for sale to draw it right now.');
      used[j] = 1;
      ids[t] = j;
    }
    return { layout: ids.map((j) => this.pal[j]), ids: ids.map((j) => this.cands[j].id) };
  }

  /// Each open slot's best Credit of its colour, given the Credits already `placed`. A colour's open slots fill in
  /// slot order as Credits of it come in, so these are exactly the ones to add next, in slot order. Slots are settled
  /// cheapest-first, so two slots never want the same Credit.
  /// `gone`: Credits no longer to be had (a listing that sold since the market was read).
  fill(layout: readonly number[], placed: readonly (number | null)[], gone: ReadonlySet<number> = new Set()): (Candidate | null)[] {
    const inSheet = new Set([...placed.filter((x): x is number => x !== null), ...gone]);
    const used = Uint8Array.from(this.cands, (c) => (inSheet.has(c.id) ? 1 : 0));
    const out: (Candidate | null)[] = placed.map(() => null);
    const open = new Set([...Array(80).keys()].filter((t) => placed[t] === null && layout[t]));
    const want = new Map<number, number>(); // slot → its current best candidate
    const pick = (t: number) => want.set(t, this.best(t, used, layout[t]));
    open.forEach(pick);
    while (open.size) {
      let t = -1;
      for (const s of open) if (want.get(s)! >= 0 && (t < 0 || this.cost[s][want.get(s)!] < this.cost[t][want.get(t)!])) t = s;
      if (t < 0) break; // nothing of these colours left for sale
      const j = want.get(t)!;
      used[j] = 1;
      out[t] = this.cands[j];
      open.delete(t);
      for (const s of open) if (want.get(s) === j) pick(s);
    }
    return out;
  }

  /// The cheapest unused candidate for slot `t`, of Colors `pal` (0 = any).
  private best(t: number, used: Uint8Array, pal: number) {
    const row = this.cost[t];
    let best = -1;
    for (let j = 0; j < row.length; j++) if (!used[j] && (!pal || this.pal[j] === pal) && (best < 0 || row[j] < row[best])) best = j;
    return best;
  }
}

/// What can go in next, from a `fill`: each Colors' open slots fill in slot order as Credits of it go in, so only
/// the start of each Colors' run can go in now.
///   slot    every recommended Credit → its slot
///   mine    the wallet's own (owner 0) that are next in their Colors: deposit these, in slot order
///   buy     listings with only listings ahead of them in their Colors: bought together, they land in order
///   colour  every recommended Credit → its slot's Colors
export type Plan = { slot: Map<string, number>; mine: Set<string>; buy: Set<string>; colour: Map<string, number> };
export function planOf(rec: readonly (Candidate | null)[], layout: readonly number[], placed?: readonly (bigint | number | null)[]): Plan {
  const plan: Plan = { slot: new Map(), mine: new Set(), buy: new Set(), colour: new Map() };
  const mineOpen = new Set<number>(), buyOpen = new Set<number>(); // Colors whose run is still yours / still listings
  const seen = new Set<number>();
  for (let i = 0; i < 80; i++) {
    const c = rec[i], m = layout[i];
    if (placed?.[i] != null || !m) continue;
    const first = !seen.has(m);
    seen.add(m);
    if (!c) {
      mineOpen.delete(m);
      buyOpen.delete(m);
      continue;
    }
    const id = String(c.id);
    plan.slot.set(id, i);
    plan.colour.set(id, m);
    if (c.owner === 0) {
      if (first) mineOpen.add(m);
      if (mineOpen.has(m)) plan.mine.add(id);
      buyOpen.delete(m);
    } else {
      if (first) buyOpen.add(m);
      if (buyOpen.has(m)) plan.buy.add(id);
      mineOpen.delete(m);
    }
  }
  return plan;
}

/// A Credit that must come along with `ids`: one the picture puts ahead of one of them in the same Colors (else
/// they'd land a slot early). Null when `ids` start each of their Colors' runs.
export function gapOf(plan: Plan, ids: Iterable<string>): string | null {
  const have = new Set(ids);
  for (const id of have) {
    const at = plan.slot.get(id), c = plan.colour.get(id);
    if (at === undefined) continue;
    for (const [o, t] of plan.slot) if (t < at && !have.has(o) && plan.colour.get(o) === c && (plan.mine.has(o) || plan.buy.has(o))) return o;
  }
  return null;
}

/// How much detail each slot's patch has (its lightness spread): detailed slots pick first.
function detailOf(px: Uint8ClampedArray) {
  return Array.from({ length: 80 }, (_, t) => {
    const l: number[] = [];
    for (let c = 0; c < 64; c++) {
      const i = ((Math.floor(t / 8) * 8 + (c >> 3)) * 64 + (t % 8) * 8 + (c & 7)) * 4;
      l.push(0.3 * px[i] + 0.59 * px[i + 1] + 0.11 * px[i + 2]);
    }
    const m = l.reduce((a, b) => a + b, 0) / 64;
    return l.reduce((a, b) => a + (b - m) ** 2, 0);
  });
}

/// The picture as stored with its union: 64 × 80 RGBA, base64, and the Detail it was matched with.
/// `ids`: the Credit picked for each slot when the union was made, so lists can draw the picture without matching.
export type Stored = { px: string; detail: number; ids?: (number | null)[] };
export const packPicture = (px: Uint8ClampedArray, detail: number): Stored => ({ px: btoa(String.fromCharCode(...px)), detail });
export const unpackPicture = (s: string) => Uint8ClampedArray.from(atob(s), (c) => c.charCodeAt(0));
