/// Per-party link cards, drawn in the worker: the party's own sheet of Credits on the left (its deposits, with
/// the empty slots waiting), its name and where it stands on the right. Pixels are set by hand and packed as a
/// PNG, with text from pre-rendered Geist glyphs (public/og/font.bin, scripts/og-font.py), so there is no image
/// library or font engine in the worker. Credit art comes from public/wall.bin (scripts/wall.ts).

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

export type PartyCard = {
  name: string;
  state: 'Open' | 'Full' | 'Expired' | 'Auction' | 'Settled';
  count: number;
  ids: number[]; // Credit numbers in sheet order
  early: boolean;
  highBid: bigint;
  auctionEnd: number;
  canBurn: boolean;
};

const eth = (wei: bigint) => {
  const s = (Number(wei) / 1e18).toFixed(4).replace(/\.?0+$/, '');
  return `${s} ETH`;
};

export async function drawParty(fetcher: Fetcher, origin: string, p: PartyCard): Promise<Uint8Array> {
  const { cells, faces } = await load(fetcher, origin);
  const c = new Canvas(faces);

  // The sheet: 8 across, 10 down, as the Statement is laid out.
  const k = 6, T = 8 * k, gap = 6, sx = 48, sy = 48;
  for (let slot = 0; slot < 80; slot++) {
    const x = sx + (slot % 8) * (T + gap), y = sy + Math.floor(slot / 8) * (T + gap);
    const id = p.ids[slot];
    if (!id || id > cells.length / 32) {
      c.rect(x, y, T, T, SLOT);
      continue;
    }
    for (let cell = 0; cell < 64; cell++) {
      const m = (cells[(id - 1) * 32 + (cell >> 1)] >> ((cell & 1) * 4)) & 15;
      if (m) c.rect(x + (cell % 8) * k, y + Math.floor(cell / 8) * k, k, k, MIX[m]);
    }
  }

  const x0 = 522, colW = 630;
  const now = Date.now() / 1000;
  const live = p.state === 'Auction' && p.highBid > 0n && now < p.auctionEnd;
  const label =
    p.state === 'Settled' ? 'Sold'
    : p.state === 'Auction' ? (p.highBid > 0n ? (live ? 'At auction' : 'Auction ended') : 'At auction')
    : p.state === 'Full' ? 'Full party'
    : 'Party';
  c.text(LABEL, label, x0, 92, MUTED);

  const name = c.wrap(TITLE, p.name || 'Untitled', colW, 2);
  name.forEach((l, i) => c.text(TITLE, l, x0, 166 + i * 72, INK));

  const statY = 452;
  if (p.state === 'Open' || p.state === 'Full' || p.state === 'Expired') {
    const w = c.text(BIG, String(p.count), x0, statY, INK);
    c.text(BIG, '/80', x0 + w + 4, statY, FAINT);
    const sub =
      p.state === 'Full' ? (p.canBurn ? 'Full. Ready to burn into a Statement.' : 'Full. Waiting to burn into a Statement.')
      : `${80 - p.count} to go · ${p.early ? 'early bird' : 'equal'} payout`;
    c.text(BODY, sub, x0, statY + 50, MUTED);
    c.rect(x0, statY + 78, colW, 10, TRACK);
    c.rect(x0, statY + 78, Math.round((colW * p.count) / 80), 10, INK);
  } else {
    const big = p.highBid > 0n ? eth(p.highBid) : 'No bids yet';
    c.text(c.width(BIG, big) <= colW ? BIG : TITLE, big, x0, statY, INK);
    const sub =
      p.state === 'Settled' ? 'Split between the 80 Credits that made it.'
      : p.highBid === 0n ? 'The 24-hour clock starts with the first bid.'
      : live ? 'High bid. 24 hours from the first bid.'
      : 'Winning bid. Ready to settle.';
    c.text(BODY, sub, x0, statY + 50, MUTED);
  }

  c.text(LABEL, 'creditunion.party', x0, H - 44, INK);
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

/// Made-up parties for /og, so every state's card can be judged before real ones exist.
export function sample(kind: string): PartyCard | null {
  const ids = (n: number, from: number) => Array.from({ length: n }, (_, i) => from + i * 1471);
  const base = { early: false, highBid: 0n, auctionEnd: 0, canBurn: false };
  switch (kind) {
    case 'open':
      return { ...base, name: 'Early risers', state: 'Open', count: 43, ids: ids(43, 311) };
    case 'full':
      return { ...base, name: 'First minute of the mint', state: 'Full', count: 80, ids: ids(80, 3), early: true, canBurn: true };
    case 'auction':
      return { ...base, name: 'Checkerboard', state: 'Auction', count: 80, ids: ids(80, 911), highBid: 1_250_000_000_000_000_000n, auctionEnd: Date.now() / 1000 + 5 * 3600 + 720 };
    case 'nobids':
      return { ...base, name: 'Eights only', state: 'Auction', count: 80, ids: ids(80, 5001) };
    case 'sold':
      return { ...base, name: 'Border of blacks', state: 'Settled', count: 80, ids: ids(80, 20_000), highBid: 3_200_000_000_000_000_000n };
    default:
      return null;
  }
}
