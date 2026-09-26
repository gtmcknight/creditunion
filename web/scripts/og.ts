// Draws the link-preview cards (1200×630) into public/og/: the living wall of real Credits as the ground, with a
// white label, like the About page's hero. Needs rsvg-convert (brew install librsvg) and the Geist font installed.
//   node scripts/og.ts
// The worker points each route's og:image at one of these (src/worker/og.ts); /og previews them all.
import { deflateSync } from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const W = 1200, H = 630;
const pub = (f: string) => new URL(`../public/${f}`, import.meta.url);
const cells = new Uint8Array(readFileSync(pub('wall.bin')));
const traits = new Uint32Array(readFileSync(pub('edition-traits.bin')).buffer.slice(0));
const bits = new Uint16Array(readFileSync(pub('bits.bin')).buffer.slice(0));
const n = cells.length / 32;

// Subtractive mixes by 4-bit CMYK mask, as the wall draws them.
const PALETTE = ['#ffffff', '#00b5e2', '#e4007c', '#00006e', '#ffd100', '#009400', '#e40000', '#000000', '#111111', '#000c0f', '#0f0008', '#000007', '#110e00', '#000a00', '#0f0000', '#000000'];
const RGB = PALETTE.map((h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)));

type Order = 'time' | 'color' | 'density';
function order(kind: Order, from = 0) {
  const ids = Array.from({ length: n }, (_, i) => i);
  if (kind === 'color') ids.sort((a, b) => (traits[a] & 15) - (traits[b] & 15) || a - b);
  if (kind === 'density') ids.sort((a, b) => bits[a] - bits[b] || a - b);
  return ids.slice(from).concat(ids.slice(0, from));
}

/// The wall: Credits in columns (top to bottom, then left to right), `k` pixels per cell, 8 cells a Credit.
function wall(kind: Order, k: number, from = 0) {
  const px = new Uint8Array(W * H * 3).fill(255);
  const T = 8 * k, rows = Math.ceil(H / T), cols = Math.ceil(W / T);
  const ids = order(kind, from);
  // Color: one horizontal stripe of rows per ink combination, as on the site.
  const pals = kind === 'color' ? [...new Set(ids.map((i) => traits[i] & 15))] : [];
  const byPal = new Map(pals.map((p) => [p, ids.filter((i) => (traits[i] & 15) === p)]));
  for (let c = 0; c < cols; c++)
    for (let r = 0; r < rows; r++) {
      let id: number;
      if (kind === 'color') {
        const p = pals[Math.min(pals.length - 1, Math.floor((r * pals.length) / rows))];
        const list = byPal.get(p)!;
        id = list[(c * rows + r) % list.length];
      } else id = ids[(c * rows + r) % n];
      for (let cell = 0; cell < 64; cell++) {
        const m = (cells[id * 32 + (cell >> 1)] >> ((cell & 1) * 4)) & 15;
        const [R, G, B] = RGB[m];
        const x0 = c * T + (cell % 8) * k, y0 = r * T + ((cell / 8) | 0) * k;
        for (let y = y0; y < Math.min(H, y0 + k); y++)
          for (let x = x0; x < Math.min(W, x0 + k); x++) {
            const o = (y * W + x) * 3;
            px[o] = R;
            px[o + 1] = G;
            px[o + 2] = B;
          }
      }
    }
  return png(px);
}

/// A minimal RGB PNG encoder.
function png(px: Uint8Array) {
  const raw = Buffer.alloc((W * 3 + 1) * H);
  for (let y = 0; y < H; y++) Buffer.from(px.buffer, y * W * 3, W * 3).copy(raw, y * (W * 3 + 1) + 1);
  const crcTable = Array.from({ length: 256 }, (_, i) => {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Buffer) => {
    let c = 0xffffffff;
    for (const x of b) c = crcTable[(c ^ x) & 255] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

/// One card: the wall, a white label with the headline and a line, the domain in the corner.
function card(name: string, ground: Buffer, title: string[], line: string) {
  const lh = 74, pad = 56;
  const labelW = 760, labelH = pad * 2 + title.length * lh + 44;
  const x = (W - labelW) / 2, y = (H - labelH) / 2;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <image href="data:image/png;base64,${ground.toString('base64')}" width="${W}" height="${H}"/>
  <rect x="${x}" y="${y}" width="${labelW}" height="${labelH}" fill="#fff"/>
  ${title.map((t, i) => `<text x="${W / 2}" y="${y + pad + 58 + i * lh}" text-anchor="middle" font-family="Geist" font-weight="700" font-size="68" letter-spacing="-2" fill="#0a0a0a">${esc(t)}</text>`).join('')}
  <text x="${W / 2}" y="${y + pad + title.length * lh + 30}" text-anchor="middle" font-family="Geist" font-size="28" fill="#555">${esc(line)}</text>
  <rect x="${W - 188}" y="${H - 72}" width="156" height="40" fill="#fff"/>
  <text x="${W - 110}" y="${H - 44}" text-anchor="middle" font-family="Geist" font-weight="700" font-size="22" fill="#0a0a0a">eighty.fun</text>
</svg>`;
  const out = execFileSync('rsvg-convert', ['-w', String(W), '-h', String(H), '-f', 'png'], { input: svg, maxBuffer: 64 << 20 });
  writeFileSync(pub(`og/${name}.png`), out);
  console.log(`og/${name}.png`, out.length, 'bytes');
}

mkdirSync(pub('og'), { recursive: true });
card('home', wall('time', 3), ['Eighty Credits', 'make a Statement.'], 'Pool your Credits with 79 others. Burn, auction, split.');
card('about', wall('density', 3), ['How Eighty works'], 'One wallet nobody owns. Rules nobody can change.');
card('auctions', wall('color', 3), ['Statements', 'at auction'], '24 hours from the first bid, split between the 80.');
card('create', wall('time', 5, 40_000), ['Start a party'], 'Pick who joins and how the 80 are laid out.');
card('party', wall('color', 5, 7), ['Join this party'], '80 Credits. One Statement. Split 80 ways.');
card('mint', wall('density', 5, 90_000), ['Mint test Credits'], 'Real Credits art, on testnet.');
