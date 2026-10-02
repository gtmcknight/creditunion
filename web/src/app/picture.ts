/// A picture framed for a sheet: the example strip, upload (button, drop or paste), and a 4:5 window you drag and
/// zoom. The Printer matches exact Credits to it; a Picture union paints its sheet from the Credits that draw it and
/// keeps recommending the best Credit for each open slot (Guide).
import type { Address } from 'viem';
import { bin, binsVersion } from './bins';
import { myCredits } from './data';
import { costs, type Candidate, type Look } from './printer-match';

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

/// What a Picture union's page reads instead (Guide only weighs a wallet's own Credits and listings at or under
/// MAX_PRICE, and a union's plan only those of its Colors): the Worker's cut of the market for these Colors, and the
/// viewer's own Credits, each with its print and traits (worker/slice.ts), a few hundred KB rather than 2.9 MB. The
/// whole files when the cut can't be read.
export function sliceBase(colours: Iterable<number>, own: readonly bigint[]): Promise<Base> {
  const mask = [...colours].reduce((m, c) => (c > 0 && c < 16 ? m | (1 << c) : m), 0);
  const get = (path: string) => fetch(path).then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`${path.split('?')[0]} ${r.status}`))));
  const mine = [...new Set(own.map(Number))];
  return Promise.all([
    get(`/market/picture?pal=${mask}`),
    ...Array.from({ length: Math.ceil(mine.length / 500) }, (_, i) => get(`/edition/rows?ids=${mine.slice(i * 500, i * 500 + 500).join(',')}&v=${binsVersion}`)),
  ])
    .then(([market, ...rows]) => {
      const n = new DataView(market).getUint32(0, true);
      const wall = new Uint8Array(n * 32), traits = new Uint32Array(n), prices = new Map<number, number>();
      for (const buf of [market, ...rows]) {
        const v = new DataView(buf), k = v.getUint32(4, true), b = new Uint8Array(buf);
        for (let i = 0; i < k; i++) {
          const id = v.getUint32(8 + i * 4, true), gwei = v.getUint32(8 + k * 4 + i * 4, true);
          traits[id - 1] = b[8 + k * 8 + i];
          wall.set(b.subarray(8 + k * 9 + i * 32, 8 + k * 9 + i * 32 + 32), (id - 1) * 32);
          if (buf === market) prices.set(id, gwei / 1e9);
        }
      }
      // A Credit outside the cut has no traits here (0): not one to weigh.
      return { wall, traits, registered: (id: number) => !!traits[id - 1] && ((traits[id - 1] >> 4) & 7) === 0, market: prices };
    })
    .catch((e) => {
      console.warn('[picture] the cut of the market', e);
      return loadBase();
    });
}

/// Candidates: the wallets' own registered Credits (free), then every registered listing nobody here owns, except
/// `skip` (Credits already in the union).
/// `held`: the first wallet's Credits as the page already knows them (read from chain when not given).
export async function candidates(wallets: Address[], skip: ReadonlySet<number> = new Set(), held?: readonly bigint[], base?: Promise<Base>) {
  const b = await (base ?? loadBase());
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
/// How much a Credit you hold is favoured over one for sale when a picture union plans its next Credits, in typical
/// patch errors: yours takes a spot only when it draws it about as well as the best for sale.
export const OWN_GOOD = 0.25;
/// A typical patch's match error, the unit `own` is given in (as printer-match's OWN_BONUS).
const OWN_COST = 250_000;

/// A picture against the Credits that could draw it: every candidate's cost at every slot (likeness, then price, less
/// a bonus for ones the wallet already holds), so the sheet can be designed and each open slot given its best Credit.
export class Guide {
  private constructor(
    readonly cands: Candidate[],
    private cost: Float32Array[],
    private pal: Uint8Array,
    private detail: number[],
    /// How far yours may draw a spot worse than the best for sale (`own`, in cost units).
    private slack: number,
    private px: Uint8ClampedArray,
  ) {}

  /// Each slot → the first slot of its Colors whose patch looks the same (itself when none), so Credits planned for
  /// either draw both: a plain background's spots take its Credits in any order.
  twins(layout: readonly number[]): number[] {
    const out: number[] = [];
    for (let s = 0; s < 80; s++) out.push(!layout[s] ? s : ([...Array(s).keys()].find((r) => layout[r] === layout[s] && out[r] === r && alike(this.px, r, s)) ?? s));
    return out;
  }

  /// `wallets`: whose Credits count as theirs (the viewer's). `held`: the first wallet's Credits that can go in, when
  /// the page knows better than a chain read, and `colours` their Colors as the contract reads them. `detail`: how
  /// much to favour Credits that keep edges (eyes, mouths), 0 to 4, as the Printer's Detail. `own`: how much a Credit
  /// the wallet holds is favoured over a listing, in typical patch errors (1, the Printer's "use ours"; less where only
  /// a close match of yours should win). `look`: the format it's matched in (Consolidated unless the picture says so).
  /// `base`: what to weigh, when not the whole edition and market (sliceBase).
  static async of(px: Uint8ClampedArray, o: { wallets?: Address[]; held?: readonly bigint[]; colours?: (id: bigint) => number; detail?: number; progress?: (f: number) => void; own?: number; look?: Look; base?: Promise<Base> } = {}) {
    const { cands: all, wall, base: b } = await candidates(o.wallets ?? [], new Set(), o.held, o.base);
    const cands = all.filter((c) => c.owner >= 0 || c.price <= MAX_PRICE);
    const cost = await costs(px, cands, wall, { features: o.detail ?? DETAIL, maxPrice: MAX_PRICE, own: o.own ?? 1, look: o.look }, o.progress);
    return new Guide(cands, cost, Uint8Array.from(cands, (c) => (c.owner === 0 && o.colours?.(BigInt(c.id))) || paletteOf(b, c.id)), detailOf(px), (o.own ?? 1) * OWN_COST, px);
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

  /// As fill, with yours first in each Colors where that costs the picture little. A Colors' open slots fill in the
  /// order its Credits go in, so one of yours planned behind a Credit for sale can't go in until that one is bought.
  /// Yours move to that Colors' first open slots, and the ones for sale into the slots yours left, when that draws the
  /// picture about as well (each of yours worse by no more than `slack`); otherwise they stay where they draw best and
  /// go in once the ones ahead of them are in.
  fillYoursFirst(layout: readonly number[], placed: readonly (number | null)[], gone: ReadonlySet<number> = new Set()): (Candidate | null)[] {
    const rec = this.fill(layout, placed, gone);
    const at = new Map(this.cands.map((c, j) => [c, j]));
    for (const m of new Set(layout)) {
      if (!m) continue;
      const slots = [...layout.keys()].filter((t) => layout[t] === m && placed[t] === null && rec[t]);
      const own = slots.filter((t) => rec[t]!.owner >= 0), sale = slots.filter((t) => rec[t]!.owner < 0);
      if (!own.length || own.every((t, i) => t === slots[i])) continue; // none of yours, or yours already first
      // Yours to the first slots, the rest after, each set given its slots in the order that costs least.
      const assign = (who: number[], to: number[]) => {
        const left = [...who], out = new Map<number, number>();
        for (const t of to) {
          let best = 0;
          for (let i = 1; i < left.length; i++) if (this.cost[t][at.get(rec[left[i]]!)!] < this.cost[t][at.get(rec[left[best]]!)!]) best = i;
          out.set(t, left.splice(best, 1)[0]);
        }
        return out;
      };
      const moved = new Map([...assign(own, slots.slice(0, own.length)), ...assign(sale, slots.slice(own.length))]);
      const before = slots.reduce((n, t) => n + this.cost[t][at.get(rec[t]!)!], 0);
      const after = slots.reduce((n, t) => n + this.cost[t][at.get(rec[moved.get(t)!]!)!], 0);
      const next = new Map(slots.map((t) => [t, rec[moved.get(t)!]]));
      if (after - before <= own.length * this.slack) for (const t of slots) rec[t] = next.get(t)!;
    }
    return rec;
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
/// Credits that draw the start of each Colors' run can go in now. Spots whose patches look the same (`twin`, as
/// Guide.twins: a plain background) take any of the Credits planned for them, in any order, so only spots unlike their
/// neighbours hold a Credit to its place.
///   slot    every recommended Credit → its slot
///   mine    the wallet's own (owner 0) that can go in now: deposit these, in the order `landing` gives
///   buy     listings that can go in now with only listings ahead of them: bought together, they land in order
///   colour  every recommended Credit → its slot's Colors
///   twin    each slot → the first slot of its Colors that looks the same (itself when none)
///   open    each Colors → its open slots, in the order they fill
export type Plan = { slot: Map<string, number>; mine: Set<string>; buy: Set<string>; colour: Map<string, number>; twin: number[]; open: Map<number, number[]> };
export function planOf(rec: readonly (Candidate | null)[], layout: readonly number[], placed?: readonly (bigint | number | null)[], twin: readonly number[] = layout.map((_, i) => i)): Plan {
  const plan: Plan = { slot: new Map(), mine: new Set(), buy: new Set(), colour: new Map(), twin: [...twin], open: new Map() };
  for (let i = 0; i < 80; i++) {
    const c = rec[i], m = layout[i];
    if (placed?.[i] != null || !m) continue;
    plan.open.set(m, [...(plan.open.get(m) ?? []), i]);
    if (!c) continue;
    plan.slot.set(String(c.id), i);
    plan.colour.set(String(c.id), m);
  }
  const ids = [...plan.slot.keys()];
  for (const id of landing(plan, ids.filter((id) => rec[plan.slot.get(id)!]!.owner === 0)).keys()) plan.mine.add(id);
  // A Colors yours start goes to yours: a buy meanwhile would land in the spots after the plan's, not the ones it drew.
  const yours = new Set([...plan.mine].map((id) => plan.colour.get(id)));
  for (const id of landing(plan, ids.filter((id) => rec[plan.slot.get(id)!]!.owner !== 0 && !yours.has(plan.colour.get(id)))).keys()) plan.buy.add(id);
  return plan;
}

/// Where `ids` land when they go in together: each Colors' open spots fill one after another, each with a Credit
/// planned for a spot that looks the same (the one planned for it when that's among them). Ids that can't land, because
/// a spot ahead of them has none of its look among `ids`, are left out. `stuck`: each Colors' first spot left unfilled
/// while some of `ids` of that Colors still wait.
export function landing(plan: Plan, ids: Iterable<string>, stuck?: Map<number, number>): Map<string, number> {
  const out = new Map<string, number>(), waiting = new Map<number, Map<number, string[]>>(); // Colors → look → ids
  for (const id of new Set(ids)) {
    const at = plan.slot.get(id), m = plan.colour.get(id);
    if (at === undefined || m === undefined) continue;
    const looks = waiting.get(m) ?? new Map<number, string[]>(), g = plan.twin[at];
    waiting.set(m, looks.set(g, [...(looks.get(g) ?? []), id]));
  }
  for (const [m, looks] of waiting) {
    let left = [...looks.values()].reduce((n, x) => n + x.length, 0);
    for (const t of plan.open.get(m) ?? []) {
      if (!left) break;
      const pool = looks.get(plan.twin[t]) ?? [];
      if (!pool.length) {
        stuck?.set(m, t);
        break;
      }
      const own = pool.findIndex((id) => plan.slot.get(id) === t);
      out.set(pool.splice(own < 0 ? 0 : own, 1)[0], t);
      left--;
    }
  }
  return out;
}

/// `ids` in the order they go in, so each lands in a spot it draws (those that can't land last, by their planned spot).
export function inOrder(plan: Plan, ids: Iterable<string>): string[] {
  const all = [...ids], at = landing(plan, all), key = (id: string) => at.get(id) ?? 100 + (plan.slot.get(id) ?? 99);
  return all.sort((a, b) => key(a) - key(b));
}

/// What a tap on `id` brings along, with `picked` already picked: `ahead`, the Credits of `among` it needs to land in
/// a spot it draws (one for each spot of another look before the first of its own), and `behind`, the picked ones
/// that no longer land without it.
export function runOf(plan: Plan, id: string, among: ReadonlySet<string>, picked: Iterable<string> = []): { ahead: string[]; behind: string[] } {
  const have = new Set(picked), ahead: string[] = [], m = plan.colour.get(id);
  have.delete(id);
  const lands = landing(plan, have);
  const behind = [...have].filter((x) => plan.colour.get(x) === m && !lands.has(x));
  if (m === undefined) return { ahead, behind };
  const going = new Set([...have, id]);
  for (;;) {
    const stuck = new Map<number, number>();
    if (landing(plan, going, stuck).has(id) || !stuck.has(m)) break;
    const next = gapAt(plan, stuck.get(m)!, going, among);
    if (!next) break;
    going.add(next);
    ahead.push(next);
  }
  return { ahead, behind };
}

/// A Credit that must come along with `ids`: one for a spot ahead of some of them in their Colors that none of `ids`
/// draws (else they'd land in spots they don't draw). Null when they all land.
export function gapOf(plan: Plan, ids: Iterable<string>): string | null {
  const have = new Set(ids), stuck = new Map<number, number>();
  landing(plan, have, stuck);
  for (const t of stuck.values()) {
    const next = gapAt(plan, t, have, new Set([...plan.mine, ...plan.buy]));
    if (next) return next;
  }
  return null;
}

/// A Credit of `among`, not in `have`, planned for a spot that looks like `t` (the one planned for `t` first).
function gapAt(plan: Plan, t: number, have: ReadonlySet<string>, among: ReadonlySet<string>): string | null {
  let best: string | null = null;
  for (const o of among) {
    const at = plan.slot.get(o);
    if (at === undefined || have.has(o) || plan.twin[at] !== plan.twin[t]) continue;
    if (at === t) return o;
    if (best === null || at < plan.slot.get(best)!) best = o;
  }
  return best;
}

/// Most two patches may differ, in mean colour difference per pixel (0 to 255), and still count as the same spot:
/// JPEG noise on a plain ground, not a soft edge.
const TWIN = 6;
/// Whether slots `a` and `b` show the same patch of the picture.
function alike(px: Uint8ClampedArray, a: number, b: number) {
  const at = (t: number, c: number) => ((Math.floor(t / 8) * 8 + (c >> 3)) * 64 + (t % 8) * 8 + (c & 7)) * 4;
  let d = 0;
  for (let c = 0; c < 64; c++) {
    const i = at(a, c), j = at(b, c);
    d += Math.max(Math.abs(px[i] - px[j]), Math.abs(px[i + 1] - px[j + 1]), Math.abs(px[i + 2] - px[j + 2]));
  }
  return d / 64 <= TWIN;
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
/// `look`: the format it was matched in, when not Consolidated (the union burns in it too).
export type Stored = { px: string; detail: number; ids?: (number | null)[]; look?: Look };
export const packPicture = (px: Uint8ClampedArray, detail: number, look: Look = 'Consolidated'): Stored => ({ px: btoa(String.fromCharCode(...px)), detail, ...(look !== 'Consolidated' ? { look } : {}) });
export type { Look };
export const unpackPicture = (s: string) => Uint8ClampedArray.from(atob(s), (c) => c.charCodeAt(0));
