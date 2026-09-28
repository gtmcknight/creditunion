// Draws the link-preview cards (1200×630) into public/og/: the living wall of real Credits as the ground, with a
// headline on black bars, like the home hero. Drawn in Chrome (playwright-core; CHROME= to point at it).
//   node scripts/og.ts
// The worker points each route's og:image at one of these (src/worker/og.ts); /og previews them all.
import { deflateSync } from 'node:zlib';
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

/// The site's pixel bank, as index.html draws it.
const MARK = `<svg viewBox="0 0 9 8" fill="#0a0a0a" shape-rendering="crispEdges"><rect x="4" y="0" width="1" height="1"/><rect x="2" y="1" width="5" height="1"/><rect x="0" y="2" width="9" height="1"/>${[1, 3, 5, 7]
  .map((x, i) => `<rect x="${x}" y="4" width="1" height="3"${i < 3 ? ` fill="${['#00b5e2', '#e4007c', '#ffd100'][i]}"` : ''}/>`)
  .join('')}<rect x="0" y="7" width="9" height="1"/></svg>`;

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

/// One card: the wall edge to edge, the mark top left and the headline on white bars fitted to each line. Nothing
/// else. Drawn by Chrome, which sizes each bar to its words.
const cards: { name: string; ground: Buffer; title: string[] }[] = [];
const card = (name: string, ground: Buffer, title: string[]) => cards.push({ name, ground, title });

async function draw() {
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({ executablePath: process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
  const page = await browser.newPage({ viewport: { width: W, height: H } });
  for (const c of cards) {
    await page.setContent(`<html><head><link href="https://fonts.googleapis.com/css2?family=Geist:wght@400;600&display=swap" rel="stylesheet"><style>
      body{margin:0;width:${W}px;height:${H}px;background:url(data:image/png;base64,${c.ground.toString('base64')}) 0 0/${W}px ${H}px;font-family:Geist,sans-serif;position:relative}
      .t{position:absolute;left:64px;top:50%;translate:0 -50%}
      .t span{display:block;width:fit-content;background:#fff;color:#0a0a0a;font-weight:600;font-size:64px;line-height:1;letter-spacing:-0.035em;padding:.16em .3em .2em}
      .b{position:absolute;left:32px;top:32px;display:flex;align-items:center;gap:12px;background:#fff;color:#0a0a0a;font-weight:600;font-size:24px;letter-spacing:-0.01em;padding:12px 18px}
      .b svg{width:36px;height:32px;display:block}
    </style></head><body><div class="b">${MARK}Credit Union</div><div class="t">${c.title.map((t) => `<span>${esc(t)}</span>`).join('')}</div></body></html>`);
    await page.evaluate(() => document.fonts.ready);
    const out = await page.screenshot({ type: 'png' });
    writeFileSync(pub(`og/${c.name}.png`), out);
    console.log(`og/${c.name}.png`, out.length, 'bytes');
  }
  await browser.close();
}

mkdirSync(pub('og'), { recursive: true });
card('home', wall('time', 3), ['Join a Credit Union', 'to make a Statement together.']);
card('about', wall('density', 3), ['How it works']);
card('auctions', wall('color', 3), ['Statements', 'at auction']);
card('create', wall('time', 5, 40_000), ['Start a Credit Union']);
card('party', wall('color', 5, 7), ['Join this Credit Union']);
card('mint', wall('density', 5, 90_000), ['Mint test Credits']);

await draw();
