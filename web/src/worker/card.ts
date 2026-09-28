/// Link cards drawn in the worker: a Credit Union's (its name and rule over a wall of Credits it takes) and a
/// Credit's (its art large, its traits). Pixels are set by hand and packed as a
/// PNG, with text from pre-rendered Geist glyphs (public/og/font.bin, scripts/og-font.py), so there is no image
/// library or font engine in the worker. Credits are drawn exactly as their contract draws them (print.ts, misprints
/// included); public/wall.bin's registered grid (scripts/wall.ts) is the fallback when the chain can't be read.
import { MIXES, type Rect } from './print';
import { eightsName } from '../shared/trait';

const W = 1200, H = 630;

// Subtractive mixes by 4-bit CMYK mask, as the wall draws them.
const MIX = ['#ffffff', '#00b5e2', '#e4007c', '#00006e', '#ffd100', '#009400', '#e40000', '#000000', '#111111', '#000c0f', '#0f0008', '#000007', '#110e00', '#000a00', '#0f0000', '#000000'].map(rgb);

function rgb(h: string): [number, number, number] {
  return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
}

type Glyph = { adv: number; x: number; y: number; w: number; h: number; a: Uint8Array };
type Face = Map<number, Glyph>;
type Assets = { cells: Uint8Array; faces: Face[] };

let assets: Promise<Assets> | null = null;
function load(fetcher: Fetcher, origin: string): Promise<Assets> {
  assets ??= Promise.all(
    ['/wall.bin', '/og/font.bin'].map(async (p) => {
      const r = await fetcher.fetch(new Request(origin + p));
      if (!r.ok) throw new Error(`${p} missing`);
      return new Uint8Array(await r.arrayBuffer());
    }),
  )
    .then(([cells, font]) => ({ cells, faces: parseFont(font) }))
    .catch((e) => {
      assets = null;
      throw e;
    });
  return assets;
}

function parseFont(b: Uint8Array): Face[] {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let o = 0;
  const faces: Face[] = [];
  const n = b[o++];
  for (let f = 0; f < n; f++) {
    o++; // size
    const count = v.getUint16(o, true);
    o += 2;
    const face: Face = new Map();
    for (let g = 0; g < count; g++) {
      const cp = v.getUint16(o, true), adv = v.getUint16(o + 2, true) / 16;
      const x = v.getInt16(o + 4, true), y = v.getInt16(o + 6, true), w = v.getUint16(o + 8, true), h = v.getUint16(o + 10, true);
      o += 12;
      face.set(cp, { adv, x, y, w, h, a: b.subarray(o, o + w * h) });
      o += w * h;
    }
    faces.push(face);
  }
  return faces;
}

// Faces in font.bin, in order.
const TITLE = 0, BIG = 1, BODY = 2, LABEL = 3;
const INK = rgb('#0a0a0a'), MUTED = rgb('#6b6b6b'), FAINT = rgb('#b4b4b0'), SLOT = rgb('#ecece9'), TRACK = rgb('#e6e6e3');

class Canvas {
  px = new Uint8Array(W * H * 3).fill(255);
  constructor(private faces: Face[]) {}

  rect(x: number, y: number, w: number, h: number, [r, g, b]: [number, number, number]) {
    // Whole pixels only: a fractional x (from a text width) would index between pixels and write nothing.
    w = Math.round(x + w) - Math.round(x);
    h = Math.round(y + h) - Math.round(y);
    x = Math.round(x);
    y = Math.round(y);
    for (let j = Math.max(0, y); j < Math.min(H, y + h); j++)
      for (let i = Math.max(0, x); i < Math.min(W, x + w); i++) {
        const o = (j * W + i) * 3;
        this.px[o] = r;
        this.px[o + 1] = g;
        this.px[o + 2] = b;
      }
  }

  width(face: number, s: string) {
    let w = 0;
    for (const ch of s) w += this.faces[face].get(ch.codePointAt(0)!)?.adv ?? 0;
    return w;
  }

  /// Sets `s` with its baseline at y; returns the width.
  text(face: number, s: string, x: number, y: number, [r, g, b]: [number, number, number]) {
    let pen = x;
    for (const ch of s) {
      const gl = this.faces[face].get(ch.codePointAt(0)!);
      if (!gl) continue;
      const gx = Math.round(pen + gl.x), gy = y + gl.y;
      for (let j = 0; j < gl.h; j++) {
        const yy = gy + j;
        if (yy < 0 || yy >= H) continue;
        for (let i = 0; i < gl.w; i++) {
          const xx = gx + i, a = gl.a[j * gl.w + i];
          if (!a || xx < 0 || xx >= W) continue;
          const o = (yy * W + xx) * 3, t = a / 255;
          this.px[o] += (r - this.px[o]) * t;
          this.px[o + 1] += (g - this.px[o + 1]) * t;
          this.px[o + 2] += (b - this.px[o + 2]) * t;
        }
      }
      pen += gl.adv;
    }
    return pen - x;
  }

  /// Up to `lines` lines within `max` px, word-wrapped, the last one cut with an ellipsis.
  wrap(face: number, s: string, max: number, lines: number) {
    const words = s.split(/\s+/).filter(Boolean);
    const out: string[] = [];
    let line = '';
    for (const w of words) {
      const next = line ? `${line} ${w}` : w;
      if (this.width(face, next) <= max || !line) line = next;
      else {
        out.push(line);
        line = w;
      }
    }
    if (line) out.push(line);
    if (out.length > lines) {
      out.length = lines;
      out[lines - 1] += '…';
    }
    return out.map((l) => {
      while (this.width(face, l) > max && l.length > 1) l = `${l.slice(0, -2)}…`;
      return l;
    });
  }
}

/// The site's pixel bank (index.html's .mark: roof, three inked columns and a black one, floor) and its name
/// top left, the domain top right: the same header on every drawn card.
const MARK: [number, number, number, number, [number, number, number]][] = [
  [4, 0, 1, 1, INK], [2, 1, 5, 1, INK], [0, 2, 9, 1, INK],
  [1, 4, 1, 3, MIX[1]], [3, 4, 1, 3, MIX[2]], [5, 4, 1, 3, MIX[4]], [7, 4, 1, 3, INK],
  [0, 7, 9, 1, INK],
];
function header(c: Canvas) {
  const s = 4, x = 48, y = 36;
  for (const [mx, my, w, h, col] of MARK) c.rect(x + mx * s, y + my * s, w * s, h * s, col);
  c.text(LABEL, 'Credit Union', x + 9 * s + 14, y + 8 * s - 4, INK);
  c.text(LABEL, 'creditunion.fun', W - 48 - c.width(LABEL, 'creditunion.fun'), y + 8 * s - 4, MUTED);
}

/// A Credit Union's link card shows only what never changes, since platforms cache a link's preview for days:
/// its name, its join rule, and a wall of Credits the rule lets in. No count, no state.
export type UnionCard = {
  name: string;
  rule: string; // "Palette Y · Print Registered", or "" for any Credit
  ids: number[]; // Credits the rule lets in (any number; the wall samples them)
};

/// Paints a print's rects at `s` px per 10 canvas units, cropped to [from, to) of its 320-unit canvas. Every edge in
/// a Credit sits on the 10-unit grid, so edges are rounded the same way everywhere and a cell keeps one width.
function paint(c: Canvas, rects: Rect[], x: number, y: number, s: number, from = 0, to = 320) {
  const at = (o: number, u: number) => Math.round(o + ((u - from) / 10) * s);
  for (const [rx, ry, rw, rh, col] of rects) {
    const x0 = Math.max(rx, from), y0 = Math.max(ry, from), x1 = Math.min(rx + rw, to), y1 = Math.min(ry + rh, to);
    if (x0 >= x1 || y0 >= y1) continue;
    const px = at(x, x0), py = at(y, y0);
    c.rect(px, py, at(x, x1) - px, at(y, y1) - py, [col >> 16, (col >> 8) & 255, col & 255]);
  }
}

/// The registered grid from wall.bin, for when the chain can't be read: no slips, no eight marks.
function gridPrint(cells: Uint8Array, id: number): Rect[] | null {
  if (!id || id > cells.length / 32) return null;
  const out: Rect[] = [[0, 0, 320, 320, 0xffffff], [80, 80, 160, 160, 0xffffff]];
  for (let cell = 0; cell < 64; cell++) {
    const m = (cells[(id - 1) * 32 + (cell >> 1)] >> ((cell & 1) * 4)) & 15;
    if (m) out.push([80 + (cell % 8) * 20, 80 + Math.floor(cell / 8) * 20, 20, 20, MIXES[m]]);
  }
  return out;
}

const WHITE = rgb('#ffffff');

/// Like the fixed cards (scripts/og.ts): the wall edge to edge, the name on black bars fitted to each line, the rule
/// on a white bar under it, the mark top left and the domain bottom right on white boxes. The wall is the registered
/// grid from wall.bin (it's texture), 5 px a cell, grouped by palette so mixed rules read as bands.
export async function drawUnion(fetcher: Fetcher, origin: string, u: UnionCard): Promise<Uint8Array> {
  const { cells, faces } = await load(fetcher, origin);
  const c = new Canvas(faces);
  const n = cells.length / 32;
  const k = 5, T = 8 * k, rows = Math.ceil(H / T), cols = Math.ceil(W / T), need = rows * cols;
  const pool = u.ids.filter((id) => id >= 1 && id <= n);
  const from = pool.length ? pool : Array.from({ length: n }, (_, i) => i + 1);
  // An even sample across the matches, the same every time for the same rule.
  const pick = Array.from({ length: need }, (_, i) => from[Math.floor((i * from.length) / need)]);
  const mask = (id: number) => {
    let m = 0;
    for (let b = 0; b < 32; b++) m |= cells[(id - 1) * 32 + b] | (cells[(id - 1) * 32 + b] >> 4);
    return m & 15;
  };
  pick.sort((a, b) => mask(a) - mask(b) || a - b);
  // Row by row, so palettes lie in horizontal bands, as on the fixed cards.
  for (let row = 0; row < rows; row++)
    for (let col = 0; col < cols; col++) {
      const id = pick[(row * cols + col) % pick.length];
      for (let cell = 0; cell < 64; cell++) {
        const m = (cells[(id - 1) * 32 + (cell >> 1)] >> ((cell & 1) * 4)) & 15;
        if (m) c.rect(col * T + (cell % 8) * k, row * T + Math.floor(cell / 8) * k, k, k, MIX[m]);
      }
    }

  // Mark and name, top left.
  const s = 4, bx = 32, by = 32, bw = 18 + 9 * s + 12 + c.width(LABEL, 'Credit Union') + 18, bh = 56;
  c.rect(bx, by, bw, bh, WHITE);
  for (const [mx, my, w, h, col] of MARK) c.rect(bx + 18 + mx * s, by + 12 + my * s, w * s, h * s, col);
  c.text(LABEL, 'Credit Union', bx + 18 + 9 * s + 12, by + 37, INK);
  // Domain, bottom right.
  const dw = c.width(LABEL, 'creditunion.fun') + 32, dh = 44;
  c.rect(W - 32 - dw, H - 32 - dh, dw, dh, WHITE);
  c.text(LABEL, 'creditunion.fun', W - 32 - dw + 16, H - 32 - 14, INK);

  // Name on black bars, one per line, then the rule on a white bar; the block centred top to bottom.
  const lines = c.wrap(TITLE, u.name || 'A Credit Union', W - 64 - 64 - 38, 2);
  const barH = 88, lineGap = 0, ruleH = 58;
  const rule = c.wrap(BODY, u.rule || 'Any Credit can join', W - 64 - 64 - 36, 1)[0];
  const total = lines.length * barH + (lines.length - 1) * lineGap + 16 + ruleH;
  let y = Math.round((H - total) / 2);
  for (const l of lines) {
    c.rect(64, y, c.width(TITLE, l) + 38, barH, INK);
    c.text(TITLE, l, 64 + 19, y + 62, WHITE);
    y += barH + lineGap;
  }
  y += 16;
  c.rect(64, y, c.width(BODY, rule) + 36, ruleH, WHITE);
  c.text(BODY, rule, 64 + 18, y + 39, INK);
  return png(c.px);
}

export type CreditFacts = {
  palette: number; // CMYK mask, C=1 M=2 Y=4 K=8
  eights: number;
  print: string;
  weight: string;
  score: number | null; // the official rating, e.g. 612.3
  rank: number | null;
  of: number;
};

/// One Credit: the header, its art large on the left, whole (paper, print and eight marks, 1.45 px a canvas unit,
/// as its contract draws it: `print`, or wall.bin's grid when that's null), its number and traits on the right.
export async function drawCredit(fetcher: Fetcher, origin: string, id: number, f: CreditFacts | null, print: Rect[] | null): Promise<Uint8Array> {
  const { cells, faces } = await load(fetcher, origin);
  const c = new Canvas(faces);
  header(c);
  const T = 464, sx = 48, sy = 118;
  c.rect(sx - 1, sy - 1, T + 2, T + 2, TRACK);
  const art = print ?? gridPrint(cells, id);
  if (art) paint(c, art, sx, sy, 14.5);
  else c.rect(sx, sy, T, T, rgb('#ffffff'));

  const x0 = 576, col2 = x0 + 300;
  c.text(LABEL, 'Credit', x0, 176, MUTED);
  c.text(BIG, `#${id.toLocaleString('en-US')}`, x0, 272, INK);
  if (!f) return png(c.px);

  // Six facts in two columns, label over value, the last row's baseline level with the art's foot.
  const fact = (x: number, y: number, label: string, value: string, lead = 0) => {
    c.text(LABEL, label, x, y, MUTED);
    c.text(BODY, value, x + lead, y + 40, INK);
  };
  // Palette: its inks as swatches, then the letters.
  const inks = [1, 2, 4, 8].filter((b) => f.palette & b);
  inks.forEach((b, i) => {
    c.rect(x0 + i * 28, 368 - 22, 22, 22, MIX[b]);
    if (b === 8) c.rect(x0 + i * 28, 368 - 22, 22, 22, rgb('#111111'));
  });
  fact(x0, 328, 'Palette', inks.map((b) => 'CMYK'[Math.log2(b)]).join(''), inks.length * 28 + 6);
  fact(col2, 328, 'Eights', eightsName(f.eights));
  fact(x0, 434, 'Print', f.print);
  fact(col2, 434, 'Weight', f.weight.charAt(0).toUpperCase() + f.weight.slice(1));
  fact(x0, 540, 'Rating', f.score === null ? '–' : f.score.toFixed(1));
  fact(col2, 540, 'Rank', f.rank === null ? '–' : `${f.rank.toLocaleString('en-US')} of ${f.of.toLocaleString('en-US')}`);
  return png(c.px);
}

/// RGB PNG. CompressionStream('deflate') writes the zlib stream PNG wants.
async function png(px: Uint8Array): Promise<Uint8Array> {
  const raw = new Uint8Array((W * 3 + 1) * H);
  for (let y = 0; y < H; y++) raw.set(px.subarray(y * W * 3, (y + 1) * W * 3), y * (W * 3 + 1) + 1);
  const z = new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new CompressionStream('deflate'))).arrayBuffer());
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, W);
  dv.setUint32(4, H);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', z), chunk('IEND', new Uint8Array(0))];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

const CRC = Array.from({ length: 256 }, (_, i) => {
  let c = i;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function chunk(type: string, data: Uint8Array) {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  let c = 0xffffffff;
  for (let i = 4; i < 8 + data.length; i++) c = CRC[(c ^ out[i]) & 255] ^ (c >>> 8);
  dv.setUint32(8 + data.length, (c ^ 0xffffffff) >>> 0);
  return out;
}

/// Made-up unions for /og, to judge the card before real ones exist. `rules` picks the wall's Credits.
export function sample(kind: string): (Omit<UnionCard, 'ids'> & { rules: Record<string, number> }) | null {
  switch (kind) {
    case 'open':
      return { name: 'Just Yellow', rule: 'Palette Y', rules: { palettes: 1 << 4 } };
    case 'full':
      return { name: 'First minute of the mint', rule: 'Paid Sep 21, 15:05–15:06 UTC', rules: { idTo: 400 } };
    case 'auction':
      return { name: 'Checkerboard', rule: 'Print Registered · Weight even', rules: { prints: 1, weights: 1 } };
    case 'nobids':
      return { name: 'Eights only', rule: 'Three or four eights', rules: { eights: (1 << 3) | (1 << 4) } };
    case 'sold':
      return { name: 'Anyone', rule: '', rules: {} };
    default:
      return null;
  }
}
