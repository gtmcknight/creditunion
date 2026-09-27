/// A Credit exactly as its contract draws it: the rects of CreditArt.svg(seed, paidAt), in paint order, on the
/// SVG's 320-unit canvas. Ported line for line from CreditDrawing.body (contracts/src/vendor/credits, unmodified
/// from the verified mainnet source), misprints included: sha256(seed ‖ "/misprint") can slip up to four plates by
/// one or two cells, and the print is then re-centred on its paper. wall.bin keeps only the registered grid.

/// [x, y, w, h, 0xRRGGBB] in canvas units.
export type Rect = [number, number, number, number, number];

const INKS = [0x00b5e2, 0xe4007c, 0xffd100, 0x111111]; // C, M, Y, K

/// Subtractive mixes by 4-bit plate mask, rounded as CreditDrawing.palette does.
export const MIXES: number[] = Array.from({ length: 16 }, (_, mask) => {
  let r = 255, g = 255, b = 255;
  for (let layer = 0; layer < 4; layer++) {
    if (!(mask & (1 << layer))) continue;
    const ink = INKS[layer];
    r = Math.floor((r * ((ink >> 16) & 255) + 127) / 255);
    g = Math.floor((g * ((ink >> 8) & 255) + 127) / 255);
    b = Math.floor((b * (ink & 255) + 127) / 255);
  }
  return (r << 16) | (g << 8) | b;
});

const sha256 = async (bytes: Uint8Array) => new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
const MISPRINT = new TextEncoder().encode('/misprint');

/// Per-plate slips in cells. Registered prints (h[0] >= 32) don't move.
function slips(h: Uint8Array): [number[], number[]] {
  const dxs = [0, 0, 0, 0], dys = [0, 0, 0, 0];
  if (h[0] >= 32) return [dxs, dys];
  const dice = h[1];
  let maxStep = 1, movers = 1, kMoves = false;
  if (dice < 80) movers = 1;
  else if (dice < 160) movers = 2;
  else if (dice < 210) movers = 3;
  else if (dice < 240) (maxStep = 2), (movers = 2 + (h[2] % 2));
  else (maxStep = 2), (movers = 3 + (h[2] % 2)), (kMoves = true);

  const pool = kMoves ? [0, 1, 2, 3] : [0, 1, 2];
  const selected: number[] = [];
  let cursor = 3;
  while (selected.length < movers && pool.length > 0) selected.push(pool.splice(h[cursor++ % 32] % pool.length, 1)[0]);
  // All selections finish before offsets use the final cursor.
  const ux = [-1, 1, 0, 0, -1, -1, 1, 1], uy = [0, 0, -1, 1, -1, 1, -1, 1];
  for (const layer of selected) {
    const b = h[(layer + cursor) % 32], c = h[(layer + cursor + 4) % 32];
    let dx: number, dy: number;
    if (maxStep === 1) (dx = ux[b % 8]), (dy = uy[b % 8]);
    else {
      dx = (b % 5) - 2;
      dy = (c % 5) - 2;
      if (dx === 0 && dy === 0) dx = b & 1 ? 2 : -2;
    }
    dxs[layer] = dx;
    dys[layer] = dy;
  }
  return [dxs, dys];
}

/// Four 8x8 plates on a 12x12 raster, each set bit OR-ed in as 1 << layer at its slipped position.
function raster(hash: Uint8Array, dx: number[], dy: number[], enabled: boolean[]) {
  const px = new Uint8Array(144);
  for (let layer = 0; layer < 4; layer++) {
    if (!enabled[layer]) continue;
    for (let y = 0; y < 8; y++)
      for (let x = 0; x < 8; x++) {
        const bit = layer * 64 + y * 8 + x;
        if ((hash[bit >> 3] >> (7 - (bit & 7))) & 1) px[(y + 2 + dy[layer]) * 12 + x + 2 + dx[layer]] |= 1 << layer;
      }
  }
  return px;
}

/// Where the grid sits once the plates slip: all four plates' ink, printed or not, centred on the paper.
function center(hash: Uint8Array, dx: number[], dy: number[]): [number, number] {
  const px = raster(hash, dx, dy, [true, true, true, true]);
  let minX = 12, minY = 12, maxX = 0, maxY = 0;
  for (let i = 0; i < 144; i++) {
    if (!px[i]) continue;
    const x = i % 12, y = (i / 12) | 0;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + 1);
    maxY = Math.max(maxY, y + 1);
  }
  return minX < 12 ? [80 + (12 - minX - maxX) * 10, 80 + (12 - minY - maxY) * 10] : [80, 80];
}

/// `seed` is the Credit's 21 bytes (Credits.seedOf), `paidAt` its payment second (Credits.timestampOf).
export async function printOf(seed: Uint8Array, paidAt: number): Promise<Rect[]> {
  const hash = await sha256(seed);
  const withTag = new Uint8Array(seed.length + MISPRINT.length);
  withTag.set(seed);
  withTag.set(MISPRINT, seed.length);
  const [dx, dy] = slips(await sha256(withTag));
  const mask = (paidAt % 15) + 1; // the second of payment picks the inks
  const enabled = [0, 1, 2, 3].map((i) => (mask & (1 << i)) !== 0);

  const pad = Math.max(...dx.map(Math.abs), ...dy.map(Math.abs));
  const [ox, oy] = pad ? center(hash, dx, dy) : [80, 80];
  const eights = seed.reduce((n, b) => n + (b === 0x38 ? 1 : 0), 0);

  const out: Rect[] = [[0, 0, 320, 320, eights >= 5 ? 0x111111 : 0xffffff], [ox, oy, 160, 160, 0xffffff]];
  const px = raster(hash, dx, dy, enabled);
  for (let y = -pad; y < 8 + pad; y++)
    for (let x = -pad; x < 8 + pad; x++) {
      const m = px[(y + 2) * 12 + x + 2];
      if (m) out.push([ox + x * 20, oy + y * 20, 20, 20, MIXES[m]]);
    }
  // One mark per literal 8 in the seed, up to four, ending in the bottom-right corner (K there, then Y, M, C leftward).
  const n = Math.min(eights, 4);
  for (let i = 0; i < n; i++) out.push([(16 - n + i) * 20, 300, 20, 20, MIXES[1 << (4 - n + i)]]);
  return out;
}
