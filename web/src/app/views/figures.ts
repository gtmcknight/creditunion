/// Homepage explainer figures (FAMILY) and the lab's alternatives. One visual system: solid inks on paper,
/// 15/3 cells, 8×10 sheets, one stroke, Jack-style open-chevron arrows.
/// Same vocabulary as docs.ts: the Credits' own inks on paper, squares and 8×10 sheets.

const MIX = ['#fff', '#00b5e2', '#e4007c', '#00006e', '#ffd100', '#009400', '#e40000', '#000', '#111'];
const K = '#111', C = '#00b5e2', M = '#e4007c', Y = '#ffd100', G = '#009400';
const GREY = '#e6e6e3', MUTE = '#777', FAINT = '#b5b5b0';
const INKS = [1, 2, 4, 3, 5, 6, 8];

type TextOpts = { size?: number; anchor?: 'start' | 'middle' | 'end'; fill?: string; weight?: number };
const n = (v: number) => +v.toFixed(2);
const r = (x: number, y: number, w: number, h: number, fill: string, extra = '') =>
  `<rect x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(h)}" fill="${fill}"${extra}/>`;
const box = (x: number, y: number, w: number, h: number, stroke = K, sw = 1.5, dash = '') =>
  `<rect x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(h)}" fill="none" stroke="${stroke}" stroke-width="${sw}"${dash ? ` stroke-dasharray="${dash}"` : ''}/>`;
const t = (x: number, y: number, s: string, o: TextOpts = {}) =>
  `<text x="${n(x)}" y="${n(y)}" font-size="${o.size ?? 11}" font-weight="${o.weight ?? 400}" text-anchor="${o.anchor ?? 'middle'}" fill="${o.fill ?? K}">${s}</text>`;
const ln = (x1: number, y1: number, x2: number, y2: number, stroke = K, w = 1.5, dash = '') =>
  `<line x1="${n(x1)}" y1="${n(y1)}" x2="${n(x2)}" y2="${n(y2)}" stroke="${stroke}" stroke-width="${w}"${dash ? ` stroke-dasharray="${dash}"` : ''}/>`;
/// Visualize Value arrow: a thin straight shaft running into an open 45° chevron of two short strokes,
/// same weight as the shaft, butt caps and a mitred apex. Turns, when needed, are right-angle elbows (elbow()).
const arrow = (x1: number, y1: number, x2: number, y2: number, stroke = K, w = 1.5) => {
  const len = Math.hypot(x2 - x1, y2 - y1), ux = (x2 - x1) / len, uy = (y2 - y1) / len, arm = 6.5 / Math.SQRT2;
  const p = (s: number) => `${n(x2 - ux * arm + -uy * arm * s)} ${n(y2 - uy * arm + ux * arm * s)}`;
  return `<path d="M${n(x1)} ${n(y1)} L${n(x2)} ${n(y2)} M${p(1)} L${n(x2)} ${n(y2)} L${p(-1)}" fill="none" stroke="${stroke}" stroke-width="${w}" stroke-linecap="butt" stroke-linejoin="miter" stroke-miterlimit="10"/>`;
};
/// An arrow that turns once at a right angle: horizontal first, then vertical.
const elbow = (x1: number, y1: number, x2: number, y2: number, stroke = K, w = 1.5) =>
  `<path d="M${n(x1)} ${n(y1)} H${n(x2)}" fill="none" stroke="${stroke}" stroke-width="${w}" stroke-linecap="butt"/>` + arrow(x2, y1, x2, y2, stroke, w);
const svg = (inner: string, h = 300) => `<svg viewBox="0 0 300 ${h}" role="img">${inner}</svg>`;
const fig = (inner: string) => `<figure class="fig"><div class="viz">${inner}</div></figure>`;

/// Deterministic noise so every reload draws the same pictures.
const rng = (s: number) => () => (s = (s * 16807) % 2147483647) / 2147483647;

/// An 8-wide, 10-tall Statement sheet.
const sheet = (x: number, y: number, cell: number, gap: number, fill: (i: number, c: number, row: number) => string) => {
  let out = '';
  for (let i = 0; i < 80; i++) {
    const f = fill(i, i % 8, (i / 8) | 0);
    if (f) out += r(x + (i % 8) * (cell + gap), y + ((i / 8) | 0) * (cell + gap), cell, cell, f);
  }
  return out;
};
const sheetW = (cell: number, gap: number) => 8 * cell + 7 * gap;
const sheetH = (cell: number, gap: number) => 10 * cell + 9 * gap;

/// One Credit's print: an 8×8 grid of marks in its inks on white paper.
const print = (x: number, y: number, s: number, mask: number, seed: number, density = 0.42) => {
  const rand = rng(seed * 7919 + 17);
  const bits = [1, 2, 4, 8].filter((b) => mask & b);
  const k = s / 8;
  let out = r(x, y, s, s, '#fff');
  for (let i = 0; i < 64; i++) {
    if (rand() > density) continue;
    let m = 0;
    for (const b of bits) if (rand() < 0.6) m |= b;
    if (!m) m = bits[(rand() * bits.length) | 0];
    out += r(x + (i % 8) * k, y + ((i / 8) | 0) * k, k, k, MIX[m & 8 ? 8 : m]);
  }
  return out;
};
const randomInk = (rand: () => number) => MIX[INKS[(rand() * INKS.length) | 0]];

/// The party sheet, one size everywhere: 8×10 cells of 15 with 3 gaps (141 × 177), top edge and center shared.
const SHEET = { cell: 15, gap: 3 };
const SW = 8 * SHEET.cell + 7 * SHEET.gap, SH = 10 * SHEET.cell + 9 * SHEET.gap;
const SX = (300 - SW) / 2, SY = (300 - SH) / 2;
const slotX = (i: number, x0 = SX) => x0 + (i % 8) * (SHEET.cell + SHEET.gap);
const slotY = (i: number) => SY + ((i / 8) | 0) * (SHEET.cell + SHEET.gap);
const partySheet = (fill: (i: number, c: number, row: number) => string, x0 = SX) => sheet(x0, SY, SHEET.cell, SHEET.gap, fill);

/// The Statement as a framed print: an 8×10 composition of solid ink squares (calm rings, lots of paper)
/// on a white mat inside a thin black frame. `w` is the outer width; the height follows the 8:10 sheet.
const artPlan = (c: number, row: number) => [1, 0, 2, 4][Math.min(c, 7 - c, row, 9 - row)];
function statementH(w: number) {
  const pad = w * 0.15, pitch = (w - 2 * pad) / 8;
  return 2 * pad + pitch * 10;
}
/// frame: 'thin' (default), 'none' (just the art on its mat), or 'gallery' (a heavy frame, as hung in an auction house).
function statement(x: number, y: number, w: number, frame: 'thin' | 'none' | 'gallery' = 'thin') {
  const pad = w * 0.15, pitch = (w - 2 * pad) / 8, s = pitch * 0.78, h = statementH(w);
  const fw = frame === 'gallery' ? Math.max(3, w / 9) : Math.max(1, w / 60);
  let out = r(x, y, w, h, '#fff') + (frame === 'none' ? '' : box(x - (frame === 'gallery' ? fw / 2 : 0), y - (frame === 'gallery' ? fw / 2 : 0), w + (frame === 'gallery' ? fw : 0), h + (frame === 'gallery' ? fw : 0), K, fw));
  for (let i = 0; i < 80; i++) {
    const m = artPlan(i % 8, (i / 8) | 0);
    if (m) out += r(x + pad + (i % 8) * pitch + (pitch - s) / 2, y + pad + ((i / 8) | 0) * pitch + (pitch - s) / 2, s, s, MIX[m]);
  }
  return out;
}

const frameWithDoor = (x: number, y: number, w: number, h: number, d0?: number, d1?: number, sw = 2) =>
  ln(x, y, x + w, y, K, sw) + ln(x, y + h, x + w, y + h, K, sw) + ln(x, y - sw / 2, x, y + h + sw / 2, K, sw) +
  (d0 === undefined || d1 === undefined ? ln(x + w, y - sw / 2, x + w, y + h + sw / 2, K, sw) : ln(x + w, y - sw / 2, x + w, d0, K, sw) + ln(x + w, d1, x + w, y + h + sw / 2, K, sw));
const MIX16 = ['#fff', '#00b5e2', '#e4007c', '#00006e', '#ffd100', '#009400', '#e40000', '#000', '#111', '#000c0f', '#0f0008', '#000007', '#110e00', '#000a00', '#0f0000', '#000'];

/* ================================================================ round 6: one family
   Rules, shared by every surviving figure:
   · cells: CELL 15, GAP 3 everywhere (party sheet, 4×5 sheets, loose Credits); BIG = two cells + a gap (33) for markers
   · strokes: LINE 1.5 for every line, arrow and frame (the gallery frame on the Statement is the only heavy stroke)
   · words: 13px, weight 600, black; only where the picture can't say it
   · inks mean a Credit's Colors; EMPTY grey for open slots; MID grey for Credits set aside; K for structure only
   · faded (not in / outside): FADE opacity
   · composition: main object centred on (150, 150) of the 300 grid, 24 margin */
const CELL = 15, GAP = 3, PITCH = CELL + GAP, BIG = 2 * CELL + GAP, LINE = 1.5, FADE = 0.3;
const EMPTY = GREY, MID = '#b5b5b0';
const label = (x: number, y: number, s: string, anchor: 'start' | 'middle' | 'end' = 'middle') => t(x, y, s, { size: 13, weight: 600, anchor });
const cellSq = (x: number, y: number, f: string, extra = '') => r(x, y, CELL, CELL, f, extra);
const faded = (inner: string) => `<g opacity="${FADE}">${inner}</g>`;
/// A 4×5 sheet of standard cells (69 × 87).
const G4W = 4 * CELL + 3 * GAP, G4H = 5 * CELL + 4 * GAP;
const grid4 = (x: number, y: number, fill: (i: number) => string) => Array.from({ length: 20 }, (_, i) => cellSq(x + (i % 4) * PITCH, y + ((i / 4) | 0) * PITCH, fill(i))).join('');
/// Speed lines trailing left of (x, y), in the standard stroke.
const trail = (x: number, y: number) => [0, 1, 2].map((i) => ln(x - 16 - (i % 2) * 5, y + i * 5, x - 4 - (i % 2) * 5, y + i * 5, K, LINE)).join('');
/// A frame (K, standard stroke) with a door gap on its right side and the door swung open.
const doorFrame = (x: number, y: number, w: number, h: number, open: boolean, dh = 24) => {
  const d1 = y + h - 6, d0 = d1 - dh, hx = x + w;
  return frameWithDoor(x, y, w, h, open ? d0 : undefined, open ? d1 : undefined, LINE) +
    (open ? ln(hx, d0, hx + dh, d0, K, LINE) + `<path d="M${hx + dh} ${d0} A${dh} ${dh} 0 0 1 ${hx} ${d1}" fill="none" stroke="${K}" stroke-width="1" stroke-dasharray="2 3"/>` : '');
};
const inks80 = (seed: number) => { const rand = rng(seed); return Array.from({ length: 80 }, () => randomInk(rand)); };

export const FAMILY = {
  // 1A · the five steps, one word each.
  steps: (() => {
    const steps: [string, string][] = [['Open', C], ['Full', M], ['Burn', K], ['Auction', Y], ['Split', G]];
    const step = 52, y0 = 150 - (4 * step + BIG) / 2, x0 = 104;
    return fig(svg(ln(x0 + BIG / 2, y0 + BIG / 2, x0 + BIG / 2, y0 + 4 * step + BIG / 2, K, LINE) +
      steps.map(([a, f], i) => r(x0, y0 + i * step, BIG, BIG, f) + label(x0 + BIG + 16, y0 + i * step + BIG / 2 + 4.5, a, 'start')).join('')));
  })(),

  // 1B · Party, Credits, Statement, Auction, Split.
  story: (() => {
    const rand = rng(4);
    const inks = Array.from({ length: 20 }, () => randomInk(rand));
    const gapX = (300 - 32 - 3 * G4W) / 2, row1 = [16, 16 + G4W + gapX, 16 + 2 * (G4W + gapX)];
    const row2 = [150 - G4W - gapX / 2, 150 + gapX / 2];
    const y1 = 150 - (2 * G4H + 2 * 30 + 22) / 2, y2 = y1 + G4H + 30 + 22;
    const sW = 64, sInset = (G4W - sW) / 2, sY = (y: number) => y + (G4H - statementH(sW)) / 2;
    const frames: [number, number, string, string][] = [
      [row1[0], y1, 'Party', grid4(row1[0], y1, (i) => (i === 0 ? C : EMPTY))],
      [row1[1], y1, 'Credits', grid4(row1[1], y1, (i) => inks[i])],
      [row1[2], y1, 'Statement', statement(row1[2] + sInset, sY(y1), sW, 'none')],
      [row2[0], y2, 'Auction', statement(row2[0] + sInset + 2, sY(y2), sW - 4, 'gallery')],
      [row2[1], y2, 'Split', grid4(row2[1], y2, () => G)],
    ];
    const mid = (y: number) => y + G4H / 2;
    return fig(svg(
      frames.map(([x, y, a, art]) => art + label(x + G4W / 2, y + G4H + 22, a)).join('') +
        arrow(row1[0] + G4W + 5, mid(y1), row1[1] - 5, mid(y1), K, LINE) + arrow(row1[1] + G4W + 5, mid(y1), row1[2] - 5, mid(y1), K, LINE) +
        arrow(row2[0] + G4W + 5, mid(y2), row2[1] - 5, mid(y2), K, LINE),
    ));
  })(),

  // 2A · all fifteen Colors; the party takes three.
  colors: (() => {
    const on = new Set([1, 5, 6]);
    const sp = BIG + CELL, x0 = 150 - (4 * sp + BIG) / 2, y0 = 150 - (2 * sp + BIG) / 2;
    return fig(svg(Array.from({ length: 15 }, (_, i) => {
      const sq = r(x0 + (i % 5) * sp, y0 + ((i / 5) | 0) * sp, BIG, BIG, MIX16[i + 1]);
      return on.has(i + 1) ? sq : faded(sq);
    }).join('')));
  })(),

  // 2C · the rule lets cyan in; the rest wait outside.
  invited: (() => {
    const inX = SX + SW + 2 * PITCH, target = 31;
    const out: [number, number][] = [[SX - 2 * PITCH - CELL, 1], [SX - 2 * PITCH - CELL, 5], [SX - 2 * PITCH - CELL, 9], [inX, 5], [inX, 9]];
    const outInks = [M, Y, K, MIX[6], MIX[3]];
    return fig(svg(
      partySheet((i) => (i < target ? C : EMPTY)) +
        cellSq(inX, slotY(target), C) + arrow(inX - 5, slotY(target) + CELL / 2, slotX(target) + CELL + 5, slotY(target) + CELL / 2, K, LINE) +
        faded(out.map(([x, row], k) => cellSq(x, SY + row * PITCH, outInks[k])).join('')),
    ));
  })(),

  // 3C · a painted sheet; a black Credit goes to its black slot.
  painted: (() => {
    const ring = (c: number, row: number) => Math.min(c, 7 - c, row, 9 - row);
    const paint = (c: number, row: number) => [8, 1, 2, 4, 4][ring(c, row)];
    const hole = 15, inX = SX + SW + 2 * PITCH;
    return fig(svg(
      partySheet((i, c, row) => (i === hole ? '' : MIX[paint(c, row)])) +
        box(slotX(hole) + 0.75, slotY(hole) + 0.75, CELL - LINE, CELL - LINE, K, LINE) +
        cellSq(inX, slotY(hole), K) + arrow(inX - 5, slotY(hole) + CELL / 2, slotX(hole) + CELL + 5, slotY(hole) + CELL / 2, K, LINE),
    ));
  })(),

  // 4A · five cheapest listings, one arrow, into the sheet.
  buy: (() => {
    const colX = SX - 3 * PITCH, y0 = 150 - (5 * PITCH - GAP) / 2;
    return fig(svg(
      [0, 1, 2, 3, 4].map((i) => cellSq(colX, y0 + i * PITCH, C)).join('') +
        arrow(colX + CELL + 6, 150, SX - 6, 150, K, LINE) +
        partySheet((i) => (i < 58 ? MID : i < 63 ? C : EMPTY)),
    ));
  })(),

  // 5E · the mirror of 3C: a Credit leaves its slot and runs out.
  door: (() => {
    const inks = inks80(77), hole = 15, outX = SX + SW + 2 * PITCH, y = slotY(hole), cy = y + CELL / 2;
    return fig(svg(
      partySheet((i) => (i === hole ? '' : i < 46 ? inks[i] : EMPTY)) +
        box(slotX(hole) + 0.75, y + 0.75, CELL - LINE, CELL - LINE, K, LINE) +
        arrow(slotX(hole) + CELL + 5, cy, outX - 4, cy, K, LINE) +
        cellSq(outX, y, inks[hole]),
    ));
  })(),

  // 5G · three doors: open while filling, shut for 7 days, open to all after.
  doors: (() => {
    // Three sheets side by side can't use the standard sheet; 4×5 at a smaller cell, same stroke and rules.
    const c = 7, g = 3, w = 4 * c + 3 * g, h = 5 * c + 4 * g, pad = 6, fw = w + 2 * pad, fh = h + 2 * pad;
    const rand = rng(88);
    const inks = Array.from({ length: 20 }, () => randomInk(rand));
    const lane = 46, step = fw + lane, x0 = 150 - (3 * fw + 3 * lane) / 2, fy = 150 - fh / 2;
    const mini = (x: number, fill: (i: number) => string) => Array.from({ length: 20 }, (_, i) => r(x + pad + (i % 4) * (c + g), fy + pad + ((i / 4) | 0) * (c + g), c, c, fill(i))).join('');
    const run = (x: number, y: number, f: string) => trail(x, y + 2) + r(x, y, c, c, f);
    const X = (k: number) => x0 + k * step;
    return fig(svg(
      mini(X(0), (i) => (i < 11 && i !== 9 ? inks[i] : EMPTY)) + doorFrame(X(0), fy, fw, fh, true, 14) + run(X(0) + fw + 14 + 22, fy + fh - 16, inks[9]) +
        mini(X(1), (i) => inks[i]) + doorFrame(X(1), fy, fw, fh, false) + label(X(1) + fw / 2, fy - 12, '7 days') +
        mini(X(2), (i) => ([6, 13].includes(i) ? EMPTY : inks[i])) + doorFrame(X(2), fy, fw, fh, true, 14) +
        run(X(2) + fw + 14 + 22, fy + fh - 16, inks[13]) + run(X(2) + fw + 14 + 22, fy + fh - 34, inks[6]),
    ));
  })(),

  // 6A · paddles: three bidders raise, the highest in magenta.
  paddles: (() => {
    const sw = 88, sh = statementH(sw), sy = 30, base = 150 + 118;
    const paddle = (x: number, top: number, f: string) => ln(x, top + BIG, x, base, K, LINE) + r(x - BIG / 2, top, BIG, BIG, f);
    return fig(svg(statement(150 - sw / 2, sy, sw, 'gallery') + paddle(78, sy + sh + 60, K) + paddle(150, sy + sh + 42, K) + paddle(222, sy + sh + 24, M)));
  })(),

  // 6B · ladder: each bid a longer bar than the last, the top one magenta.
  ladder: (() => {
    const sw = 88, sh = statementH(sw), widths = [2, 3, 4, 5].map((k) => k * PITCH - GAP);
    const total = sw + 2 * PITCH + widths[3], x0 = 150 - total / 2, bx = x0 + sw + 2 * PITCH;
    const stackH = 4 * CELL + 3 * GAP * 2, by = 150 + stackH / 2;
    return fig(svg(statement(x0, 150 - sh / 2, sw, 'gallery') +
      widths.map((w, i) => r(bx, by - (i + 1) * CELL - i * 2 * GAP, w, CELL, i === 3 ? M : K)).join('')));
  })(),
};
