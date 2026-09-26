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

const ALT: Record<string, [string, string, string]> = {
  /* ---------------------------------------------------------------- 1 · lifecycle */
  lifecycle: [
    // A · storyboard: the sheet through its five states.
    (() => {
      // A 4×5 sheet: fewer, bigger cells, the Statement's 4:5 shape.
      const cell = 11.5, gap = 3, w = 4 * cell + 3 * gap, h = 5 * cell + 4 * gap;
      const rand = rng(4);
      const inks = Array.from({ length: 20 }, () => randomInk(rand));
      const grid = (x: number, y: number, fill: (i: number) => string) =>
        Array.from({ length: 20 }, (_, i) => r(x + (i % 4) * (cell + gap), y + ((i / 4) | 0) * (cell + gap), cell, cell, fill(i))).join('');
      const y1 = 38, y2 = 168;
      const frames: [number, number, string, string][] = [
        [22, y1, 'Party', grid(22, y1, (i) => (i === 0 ? C : GREY))],
        [122, y1, 'Credits', grid(122, y1, (i) => inks[i])],
        [222, y1, 'Statement', statement(222, y1 + (h - statementH(w)) / 2, w, 'none')],
        [56, y2, 'Auction', statement(56, y2 + (h - statementH(w)) / 2, w, 'gallery')],
        [182, y2, 'Split', grid(182, y2, () => G)],
      ];
      return fig(
        svg(
          frames.map(([x, y, a, art]) => art + t(x + w / 2, y + h + 20, a, { weight: 600, size: 13 })).join('') +
            arrow(84, y1 + h / 2, 114, y1 + h / 2) + arrow(184, y1 + h / 2, 213, y1 + h / 2) + arrow(135, y2 + h / 2, 163, y2 + h / 2),
        ),
      );
    })(),
    // B · what flows: 80 Credits in, one Statement, ETH back to the same 80.
    (() => {
      const rand = rng(9);
      const cell = 9, gap = 2, w = sheetW(cell, gap), h = sheetH(cell, gap);
      const segs = 80, total = 252, share = (total * 0.98) / segs;
      let bar = '';
      for (let i = 0; i < segs; i++) bar += r(24 + i * share, 214, share - 0.8, 20, G);
      bar += r(24 + segs * share, 214, total * 0.02, 20, M);
      return fig(
        svg(
          sheet(24, 32, cell, gap, () => randomInk(rand)) +
            t(24 + w / 2, 32 + h + 17, '80 Credits', { weight: 600, size: 12 }) +
            arrow(118, 86, 180, 86) + t(149, 78, 'burn', { size: 10, fill: MUTE }) +
            r(190, 32, w, h, K) +
            t(190 + w / 2, 32 + h + 17, '1 Statement', { weight: 600, size: 12 }) +
            arrow(233, 170, 233, 204) + t(240, 190, 'auction', { size: 10, fill: MUTE, anchor: 'start' }) +
            bar +
            t(24, 252, '98% split between the 80', { size: 10.5, anchor: 'start' }) +
            t(276, 252, '2% fee', { size: 10.5, anchor: 'end', fill: M }) +
            t(24, 270, 'the sale, in ETH', { size: 9.5, anchor: 'start', fill: MUTE }),
        ),
      );
    })(),
    // C · staircase: each step starts when the one before ends.
    (() => {
      const x0 = 108;
      const lanes: [string, string, number, number, string][] = [
        ['Start', 'with one Credit', x0, 10, C],
        ['Fill', 'until 80 are in', x0 + 14, 70, C],
        ['Burn', 'anyone triggers', x0 + 88, 10, K],
        ['Auction', '24 hours', x0 + 102, 54, Y],
        ['Split', '98% · 2% fee', x0 + 160, 10, G],
      ];
      return fig(
        svg(
          lanes
            .map(([a, b, x, w, f], i) => {
              const y = 40 + i * 46;
              const next = lanes[i + 1];
              return (
                t(20, y + 4, a, { weight: 600, size: 12, anchor: 'start' }) +
                t(20, y + 18, b, { size: 9.5, fill: MUTE, anchor: 'start' }) +
                r(x, y - 5, w, 10, f) +
                (next ? ln(x + w, y + 5, x + w, y + 41, FAINT, 1, '2 3') : '')
              );
            })
            .join('') +
            ln(x0, 268, 282, 268, K, 1) + arrow(250, 268, 284, 268, K, 1) +
            t(x0, 284, 'time', { size: 9.5, fill: MUTE, anchor: 'start' }) +
            r(x0 + 170, 219, 2, 10, M),
        ),
      );
    })(),
  ],

  /* ---------------------------------------------------------------- 2 · eligibility */
  eligibility: [
    // A · the gate: a rule lets some Credits through; or a list of names.
    (() => {
      const masks = [1, 8, 2, 5, 3, 1, 4, 2, 6, 1];
      const ok = (m: number) => m === 1 || m === 2;
      const xs = masks.map((_, i) => 24 + i * 26);
      let gate = '';
      let from = 16;
      xs.forEach((x, i) => {
        if (ok(masks[i])) {
          gate += ln(from, 104, x - 2, 104, K, 3);
          from = x + 22;
        }
      });
      gate += ln(from, 104, 284, 104, K, 3);
      return fig(
        svg(
          t(16, 24, 'Rule: Colors is C or M', { size: 10.5, anchor: 'start', weight: 600 }) +
            t(16, 38, 'or Eights · Print · Weight · Paid · Rating', { size: 9.5, anchor: 'start', fill: MUTE }) +
            masks
              .map((m, i) => {
                const x = xs[i];
                return ok(m)
                  ? print(x, 150, 20, m, i + 3) + ln(x + 10, 74, x + 10, 142, FAINT, 1, '2 3')
                  : `<g opacity=".3">${print(x, 50, 20, m, i + 3)}</g>` + ln(x + 10, 74, x + 10, 98, FAINT, 1, '2 3');
              })
              .join('') +
            masks.map((m, i) => (ok(m) ? print(xs[i], 50, 20, m, i + 3) : '')).join('') +
            gate +
            t(16, 188, 'In the party', { size: 10.5, anchor: 'start', weight: 600 }) +
            ln(16, 212, 284, 212, GREY, 1) +
            t(16, 236, 'Or by name, up to 200', { size: 10.5, anchor: 'start', weight: 600 }) +
            ['#12', '#480', '#3301', '#9020', '#40417', '…'].map((s, i) => {
              const x = 16 + i * 46;
              return (s === '…' ? '' : box(x, 248, 40, 20, K, 1)) + t(x + 20, 262, s, { size: 9.5 });
            }).join(''),
        ),
      );
    })(),
    // B · the rulebook: every trait a party can filter on, with its values.
    (() => {
      const row = (i: number) => 40 + i * 33;
      const lx = 16, cx = 80;
      const on = new Set([1, 2, 4]);
      const words = (y: number, list: string[], pick: Set<number>, size = 9) => {
        let x = cx;
        return list
          .map((w, i) => {
            const s = t(x, y, w, { size, anchor: 'start', fill: pick.has(i) ? K : FAINT, weight: pick.has(i) ? 600 : 400 });
            x += w.length * size * 0.56 + 7;
            return s;
          })
          .join('');
      };
      let list = '';
      const listed = new Set([3, 17, 21, 40, 66, 67, 92, 118, 131, 150, 177, 190]);
      for (let i = 0; i < 200; i++) list += r(cx + (i % 40) * 5, row(6) - 12 + ((i / 40) | 0) * 5, 4, 4, listed.has(i) ? K : GREY);
      const label = (i: number, s: string) => t(lx, row(i), s, { size: 10.5, weight: 600, anchor: 'start' });
      return fig(
        svg(
          label(0, 'Colors') +
            Array.from({ length: 15 }, (_, i) => r(cx + i * 13.5, row(0) - 10, 11, 11, MIX[[1, 2, 3, 4, 5, 6, 7, 8, 8, 8, 8, 8, 8, 8, 8][i]], on.has(i + 1) ? '' : ' opacity=".15"')).join('') +
            label(1, 'Eights') +
            Array.from({ length: 9 }, (_, i) => (i === 1 ? r(cx + i * 15, row(1) - 10, 13, 13, K) : '') + t(cx + i * 15 + 6.5, row(1), String(i), { size: 9.5, fill: i === 1 ? '#fff' : FAINT, weight: i === 1 ? 600 : 400 })).join('') +
            label(2, 'Print') + words(row(2), ['Registered', 'Nudge', 'Slip', 'Skew', 'Drift', 'Loose'], new Set([0])) +
            label(3, 'Weight') + words(row(3), ['even', 'lean', 'sparse', 'extreme'], new Set([0, 1]), 9.5) +
            label(4, 'Paid') + ln(cx, row(4) - 4, 284, row(4) - 4, GREY, 3) + r(cx + 40, row(4) - 8, 46, 8, K) + t(cx, row(4) + 9, 'mint', { size: 8.5, fill: MUTE, anchor: 'start' }) +
            label(5, 'Rating') +
            Array.from({ length: 10 }, (_, i) => r(cx + i * 20.4, row(5) - 8, 18.4, 8, i >= 7 ? K : GREY)).join('') + t(cx + 7 * 20.4, row(5) + 9, '7+', { size: 8.5, fill: MUTE, anchor: 'start' }) +
            ln(lx, row(5) + 20, 284, row(5) + 20, K, 1) +
            label(6, 'or Listed') + list +
            t(cx, row(6) + 24, 'by Credit number, up to 200', { size: 9, fill: MUTE, anchor: 'start' }),
        ),
      );
    })(),
    // C · the numbers: each rule narrows the whole edition. Squares to scale (area = Credits).
    (() => {
      const all = 122154;
      const steps: [number, string, string, string][] = [
        [all, 'All Credits', '122,154', '#fff'],
        [24374, 'C, M or Y', '24,374', GREY],
        [21385, 'Registered', '21,385', FAINT],
        [9935, 'even weight', '9,935', K],
        [80, 'one party', '80', M],
      ];
      const S = 190, x0 = 16, base = 250;
      const side = (v: number) => S * Math.sqrt(v / all);
      return fig(
        svg(
          steps.map(([v, , , f]) => r(x0, base - side(v), side(v), side(v), f, f === '#fff' ? ` stroke="${FAINT}" stroke-width="1"` : '')).join('') +
            steps
              .map(([v, a, b], i) => {
                const y = base - side(v) + (i === 0 ? 0 : 0);
                if (i === 0) return t(x0 + S - 6, base - S + 16, b, { size: 11, weight: 600, anchor: 'end' }) + t(x0 + S - 6, base - S + 29, a, { size: 9.5, fill: MUTE, anchor: 'end' });
                const lx = x0 + S + 8;
                const ly = [0, 132, 170, 208, 246][i];
                return ln(x0 + side(v), y + 0.5, lx - 2, ly - 4, FAINT, 0.75) + t(lx, ly - 1, b, { size: 10.5, weight: 600, anchor: 'start' }) + t(lx, ly + 11, a.replace('+ ', ''), { size: 8.5, fill: MUTE, anchor: 'start' });
              })
              .join('') +
            t(x0, 274, 'Each rule narrows who can join. Area to scale.', { size: 9.5, anchor: 'start', fill: MUTE }),
        ),
      );
    })(),
  ],

  /* ---------------------------------------------------------------- 3 · order */
  order: [
    // A · the same eight Credits sorted four ways; lines follow each Credit.
    (() => {
      const masks = [1, 2, 4, 8, 3, 5, 6, 1];
      const orders: [string, number[], string[]][] = [
        ['Deposit', [0, 1, 2, 3, 4, 5, 6, 7], ['1st', '2nd', '3rd', '4th', '5th', '6th', '7th', '8th']],
        ['Mint time', [3, 0, 6, 1, 5, 7, 2, 4], ['9:00', '9:02', '9:07', '9:11', '9:15', '9:20', '9:31', '9:48']],
        ['Credit #', [5, 2, 7, 0, 4, 1, 6, 3], ['#12', '#57', '#203', '#311', '#480', '#702', '#955', '#990']],
        ['Painted', [0, 7, 1, 4, 2, 5, 6, 3], ['C', 'C', 'M', 'CM', 'Y', 'CY', 'MY', 'K']],
      ];
      const X = (j: number) => 86 + j * 26, Y0 = (i: number) => 38 + i * 62, S = 20;
      let out = t(86, 24, 'burns first', { size: 9.5, fill: MUTE, anchor: 'start' }) + arrow(140, 21, 280, 21, FAINT, 1);
      orders.forEach(([name, ord, keys], i) => {
        const y = Y0(i);
        out += t(16, y + 14, name, { size: 10.5, weight: 600, anchor: 'start' });
        ord.forEach((id, j) => {
          out += print(X(j), y, S, masks[id], id + 11) + box(X(j), y, S, S, GREY, 0.75);
          out += t(X(j) + S / 2, y + 31, keys[j], { size: 8, fill: MUTE });
          const next = orders[i + 1];
          if (next) {
            const k = next[1].indexOf(id);
            out += ln(X(j) + S / 2, y + 36, X(k) + S / 2, Y0(i + 1) - 3, FAINT, 0.75);
          }
        });
      });
      return fig(svg(out));
    })(),
    // B · a painted sheet: each slot asks for a Color; slot 1 burns first.
    (() => {
      const cell = 17, gap = 3, x0 = 20, y0 = 40;
      const paint = (c: number, row: number) => {
        const d = Math.abs(c - 3.5) + Math.abs(row - 4.5);
        return d < 2 ? 2 : d < 4 ? 1 : d < 5.5 ? 4 : 8;
      };
      const empty = new Set([61, 62, 63, 69, 70, 77, 78, 79]);
      const counts: Record<number, number> = {};
      for (let i = 0; i < 80; i++) counts[paint(i % 8, (i / 8) | 0)] = (counts[paint(i % 8, (i / 8) | 0)] ?? 0) + 1;
      const cx = (i: number) => x0 + (i % 8) * (cell + gap), cy = (i: number) => y0 + ((i / 8) | 0) * (cell + gap);
      const w = sheetW(cell, gap);
      const lx = x0 + w + 18;
      const slot = (i: number, s: string, light: boolean) => t(cx(i) + cell / 2, cy(i) + cell / 2 + 3.5, s, { size: 8.5, weight: 600, fill: light ? '#fff' : K });
      return fig(
        svg(
          sheet(x0, y0, cell, gap, (i, c, row) => (empty.has(i) ? '' : MIX[paint(c, row)])) +
            [...empty].map((i) => box(cx(i) + 0.5, cy(i) + 0.5, cell - 1, cell - 1, MIX[paint(i % 8, (i / 8) | 0)], 1)).join('') +
            slot(0, '1', true) + slot(1, '2', true) + slot(79, '80', false) +
            t(x0, y0 - 10, 'slot 1 burns first, then across', { size: 9.5, fill: MUTE, anchor: 'start' }) +
            t(lx, 52, 'Painted by Colors', { size: 10.5, weight: 600, anchor: 'start' }) +
            ([8, 4, 1, 2] as const).map((m, i) => r(lx, 66 + i * 20, 11, 11, MIX[m]) + t(lx + 18, 75 + i * 20, `${'CMYK'[[1, 2, 4, 8].indexOf(m)]} · ${counts[m]} slots`, { size: 9.5, anchor: 'start' })).join('') +
            t(lx, 168, 'A Credit joins', { size: 10.5, weight: 600, anchor: 'start' }) +
            t(lx, 181, 'the slot of its Color', { size: 9.5, fill: MUTE, anchor: 'start' }) +
            print(lx + 30, 196, 17, 8, 5) + box(lx + 30, 196, 17, 17, GREY, 0.75) + arrow(lx + 27, 204.5, cx(63) + cell + 4, cy(63) + cell / 2) +
            t(lx, 254, 'or by Eights,', { size: 9, fill: MUTE, anchor: 'start' }) +
            t(lx, 266, 'Print, Weight', { size: 9, fill: MUTE, anchor: 'start' }),
        ),
      );
    })(),
    // C · reading order: the sheet is read into Jack's contract slot by slot.
    (() => {
      const cell = 19, gap = 2, x0 = 16, y0 = 36;
      const cx = (i: number) => x0 + (i % 8) * (cell + gap), cy = (i: number) => y0 + ((i / 8) | 0) * (cell + gap);
      const w = sheetW(cell, gap);
      let nums = '';
      for (let i = 0; i < 80; i++) nums += t(cx(i) + cell / 2, cy(i) + cell / 2 + 3, String(i + 1), { size: i < 99 ? 7.5 : 7, fill: i < 3 ? '#fff' : MUTE });
      const rx = x0 + w + 16;
      return fig(
        svg(
          sheet(x0, y0, cell, gap, (i) => (i < 3 ? K : GREY)) + nums +
            r(rx, 36, 56, 56, K) + t(rx + 28, 60, 'Jack’s', { size: 9.5, fill: '#fff' }) + t(rx + 28, 73, 'contract', { size: 9.5, fill: '#fff' }) +
            arrow(x0 + w + 2, cy(0) + cell / 2, rx - 2, cy(0) + cell / 2) +
            t(rx, 110, 'Slot 1 first,', { size: 10.5, weight: 600, anchor: 'start' }) +
            t(rx, 124, 'slot 80 last', { size: 10.5, weight: 600, anchor: 'start' }) +
            t(rx, 158, 'Filled by', { size: 9.5, fill: MUTE, anchor: 'start' }) +
            ['deposit order', 'mint time', 'Credit number', 'a painted sheet'].map((s, i) => r(rx, 168 + i * 19, 7, 7, i === 0 ? K : FAINT) + t(rx + 13, 175 + i * 19, s, { size: 10, anchor: 'start', fill: i === 0 ? K : MUTE })).join(''),
        ),
      );
    })(),
  ],

  /* ---------------------------------------------------------------- 4 · buying */
  buying: [
    // A · the listings, cheapest first: buy the cheapest five that fit.
    (() => {
      const prices = [0.03, 0.031, 0.033, 0.034, 0.036, 0.037, 0.039, 0.041, 0.042, 0.045, 0.047, 0.05, 0.052, 0.055, 0.058, 0.062];
      const masks = [4, 1, 1, 2, 1, 8, 5, 1, 1, 1, 6, 1, 3, 1, 2, 1];
      const fits = (m: number) => m === 1;
      const bought = new Set<number>();
      masks.forEach((m, i) => fits(m) && bought.size < 5 && bought.add(i));
      const base = 232, X = (i: number) => 26 + i * 16;
      const H = (p: number) => (p - 0.02) * 3600;
      const lastBought = Math.max(...bought);
      return fig(
        svg(
          t(16, 26, 'Party wants Colors C', { size: 10.5, weight: 600, anchor: 'start' }) + r(130, 17, 11, 11, C) +
            prices
              .map((p, i) => {
                const h = H(p), f = fits(masks[i]);
                return r(X(i), base - h, 12, h, bought.has(i) ? C : f ? K : GREY) + print(X(i), base - h - 16, 12, masks[i], i + 2, 0.55) + (f ? '' : `<rect x="${X(i)}" y="${n(base - h - 16)}" width="12" height="12" fill="#f5f5f3" opacity=".55"/>`);
              })
              .join('') +
            ln(20, base, 284, base, K, 1) +
            t(26, base + 14, `${prices[0]} ETH`, { size: 9, fill: MUTE, anchor: 'start' }) +
            t(X(15) + 12, base + 14, `${prices[15]} ETH`, { size: 9, fill: MUTE, anchor: 'end' }) +
            ln(X(1), base + 24, X(lastBought) + 12, base + 24, C, 3) +
            t(X(1), base + 40, 'cheapest 5 that fit, bought and', { size: 9.5, anchor: 'start' }) +
            t(X(1), base + 52, 'deposited in one transaction, +2%', { size: 9.5, anchor: 'start' }),
          300,
        ),
      );
    })(),
    // B · one transaction: ETH in, five listings bought, five Credits deposited.
    (() => {
      const cell = 10, gap = 2, sx = 170, sy = 92;
      const prices = ['0.031', '0.033', '0.034', '0.038', '0.040'];
      return fig(
        svg(
          t(20, 30, 'You pay', { size: 10.5, weight: 600, anchor: 'start' }) +
            t(20, 44, '0.176 ETH + 2% = 0.1795 ETH', { size: 10, anchor: 'start', fill: MUTE }) +
            box(16, 62, 268, 196, K, 1, '3 3') +
            r(16, 55, 88, 14, '#f5f5f3') + t(22, 66, 'one transaction', { size: 10, weight: 600, anchor: 'start' }) +
            prices.map((p, i) => print(32, 88 + i * 30, 20, 1, i + 30) + box(32, 88 + i * 30, 20, 20, GREY, 0.75) + t(60, 102 + i * 30, p, { size: 9.5, anchor: 'start' })).join('') +
            t(32, 250, 'OpenSea', { size: 9.5, fill: MUTE, anchor: 'start' }) +
            arrow(98, 160, 158, 160) + t(128, 150, 'buy', { size: 9.5, fill: MUTE }) + t(128, 176, 'deposit', { size: 9.5, fill: MUTE }) +
            sheet(sx, sy, cell, gap, (i) => (i < 58 ? FAINT : i < 63 ? C : GREY)) +
            t(sx + sheetW(cell, gap) / 2, sy + sheetH(cell, gap) + 16, '58 → 63 of 80', { size: 9.5, fill: MUTE }),
        ),
      );
    })(),
    // C · the receipt.
    (() => {
      const items: [string, string][] = [['#4211', '0.031'], ['#18090', '0.033'], ['#56', '0.034'], ['#77502', '0.038'], ['#1024', '0.040']];
      const x0 = 56, x1 = 244, y = (i: number) => 86 + i * 22;
      return fig(
        svg(
          r(40, 20, 220, 264, '#fff') +
            t(x0, 46, 'Buy in · 5 Credits', { size: 12, weight: 600, anchor: 'start' }) +
            t(x0, 61, 'cheapest on OpenSea that fit', { size: 9.5, fill: MUTE, anchor: 'start' }) +
            items.map(([id, p], i) => print(x0, y(i) - 10, 13, 1, i + 50, 0.5) + box(x0, y(i) - 10, 13, 13, GREY, 0.75) + t(x0 + 22, y(i), id, { size: 10, anchor: 'start' }) + t(x1, y(i), p, { size: 10, anchor: 'end' })).join('') +
            ln(x0, 196, x1, 196, K, 1) +
            t(x0, 214, 'Listings', { size: 10, anchor: 'start' }) + t(x1, 214, '0.176', { size: 10, anchor: 'end' }) +
            t(x0, 231, 'Eighty fee, 2%', { size: 10, anchor: 'start', fill: M }) + t(x1, 231, '0.0035', { size: 10, anchor: 'end', fill: M }) +
            ln(x0, 241, x1, 241, K, 1) +
            t(x0, 259, 'Total, one transaction', { size: 10.5, weight: 600, anchor: 'start' }) + t(x1, 259, '0.1795 ETH', { size: 10.5, weight: 600, anchor: 'end' }),
        ),
      );
    })(),
  ],

  /* ---------------------------------------------------------------- 5 · exit */
  exit: [
    // A · a timeline of the door: open, shut for 7 days, open again.
    (() => {
      const y = 140, a = 20, b = 104, c = 230, d = 282;
      const day = (c - b) / 7;
      let ticks = '';
      for (let i = 1; i < 7; i++) ticks += r(b + i * day - 0.75, y, 1.5, 12, '#f5f5f3');
      const out = (x: number) => arrow(x, y + 16, x, y + 44, K, 1.25) + r(x - 5, y + 50, 10, 10, C);
      return fig(
        svg(
          t((a + b) / 2, y - 26, 'Filling', { size: 12, weight: 600 }) +
            t((b + c) / 2, y - 26, 'Full', { size: 12, weight: 600 }) +
            t((c + d) / 2, y - 26, 'After', { size: 12, weight: 600 }) +
            t((b + c) / 2, y - 12, 'locked 7 days', { size: 9.5, fill: MUTE }) +
            t((c + d) / 2, y - 12, 'day 7, unburned', { size: 9.5, fill: MUTE }) +
            r(a, y, b - a, 12, C) + r(b, y, c - b, 12, K) + ticks + r(c, y, d - c, 12, Y) +
            out(62) +
            ln((b + c) / 2, y + 16, (b + c) / 2, y + 30, K, 1.25) + ln((b + c) / 2 - 7, y + 30, (b + c) / 2 + 7, y + 30, K, 2) +
            out(240) + out(256) + out(272) +
            t((a + b) / 2, y + 86, 'leave any time', { size: 10 }) +
            t((b + c) / 2, y + 86, 'no one leaves', { size: 10 }) +
            t((c + d) / 2, y + 86, 'anyone leaves', { size: 10 }),
        ),
      );
    })(),
    // B · the states: filling, full and locked, then burned or opened.
    (() => {
      const cell = 5, gap = 1, w = sheetW(cell, gap), h = sheetH(cell, gap);
      const rand = rng(21);
      const inks = Array.from({ length: 80 }, () => randomInk(rand));
      const x1 = 16, x2 = 118, x3 = 230, ym = 116, yt = 26, yb = 180;
      return fig(
        svg(
          sheet(x1, ym, cell, gap, (i) => (i < 44 ? inks[i] : GREY)) +
            r(x1 + w + 10, ym - 10, 10, 10, inks[3]) + arrow(x1 + w - 8, ym + 6, x1 + w + 7, ym - 6, K, 1.25) +
            t(x1 + w / 2, ym + h + 16, 'Filling', { size: 11.5, weight: 600 }) + t(x1 + w / 2, ym + h + 29, 'leave any time', { size: 9.5, fill: MUTE }) +
            arrow(x1 + w + 16, ym + h / 2, x2 - 8, ym + h / 2) +
            sheet(x2, ym, cell, gap, (i) => inks[i]) + box(x2 - 4, ym - 4, w + 8, h + 8, K, 2) +
            t(x2 + w / 2, ym + h + 20, 'Full', { size: 11.5, weight: 600 }) + t(x2 + w / 2, ym + h + 33, 'locked up to 7 days', { size: 9.5, fill: MUTE }) +
            arrow(x2 + w + 10, ym + 8, x3 - 8, yt + h / 2) + arrow(x2 + w + 10, ym + h - 8, x3 - 8, yb + h / 2) +
            r(x3, yt, w, h, K) + t(x3 + w / 2, yt + h + 16, 'Burned', { size: 11.5, weight: 600 }) + t(x3 + w / 2, yt + h + 29, 'a Statement', { size: 9.5, fill: MUTE }) +
            sheet(x3, yb, cell, gap, (i) => ([6, 21, 22, 40, 53, 67].includes(i) ? '' : inks[i])) + box(x3 - 4, yb - 4, w + 8, h + 8, K, 2, '4 4') +
            [6, 22, 53].map((i, k) => arrow(x3 + w + 2, yb + 10 + k * 20, x3 + w + 16, yb + 4 + k * 20, K, 1)).join('') +
            t(x3 + w / 2, yb + h + 20, 'Not burned', { size: 11.5, weight: 600 }) + t(x3 + w / 2, yb + h + 33, 'anyone can leave', { size: 9.5, fill: MUTE }),
        ),
      );
    })(),
    // C · a calendar: days filling, seven locked days, then open.
    (() => {
      const S = 28, G2 = 4, x0 = 38, y0 = 30;
      const fill = 9;
      let out = '';
      for (let d = 0; d < 21; d++) {
        const x = x0 + (d % 7) * (S + G2), y = y0 + ((d / 7) | 0) * (S + G2);
        const locked = d >= fill && d < fill + 7;
        const f = d < fill ? C : locked ? K : Y;
        out += r(x, y, S, S, f);
        if (locked) out += t(x + S / 2, y + S / 2 + 4, String(d - fill + 1), { size: 10, fill: '#fff', weight: 600 });
      }
      const legend: [string, string, string][] = [
        [C, 'Filling', 'take your Credits back any day'],
        [K, 'Full', 'locked 7 days so it can be burned'],
        [Y, 'Still not burned', 'anyone can take theirs back'],
      ];
      return fig(
        svg(
          out +
            legend.map(([f, a, b], i) => r(x0, 150 + i * 40, 12, 12, f) + t(x0 + 22, 160 + i * 40, a, { size: 11, weight: 600, anchor: 'start' }) + t(x0 + 22, 174 + i * 40, b, { size: 9.5, fill: MUTE, anchor: 'start' })).join('') +
            t(x0 + 7 * (S + G2) - G2, y0 - 8, 'one square = one day', { size: 9, fill: MUTE, anchor: 'end' }),
        ),
      );
    })(),
  ],

  /* ---------------------------------------------------------------- 6 · auction */
  auction: [
    // A · the clock: 24 hours from the first bid, the last 15 minutes magnified.
    (() => {
      const y = 104, a = 20, b = 260;
      const bids: [number, number, string][] = [[0, 22, '0.10'], [0.2, 30, '0.11'], [0.45, 38, '0.12'], [0.7, 48, '0.15'], [0.97, 60, '0.16']];
      const X = (f: number) => a + f * (b - a);
      const zx = 70, zw = 180;
      return fig(
        svg(
          bids.map(([f, h, v], i) => r(X(f) - 3, y - h, 6, h, i === bids.length - 1 ? M : K) + t(X(f), y - h - 5, v, { size: 8.5, fill: MUTE })).join('') +
            r(a, y, b - a, 8, K) + r(b - 8, y, 8, 8, M) +
            t(a, y + 22, 'first bid', { size: 9.5, fill: MUTE, anchor: 'start' }) + t(b, y + 22, '24h', { size: 9.5, fill: MUTE, anchor: 'end' }) +
            ln(b - 8, y + 10, zx, 166, FAINT, 0.75) + ln(b, y + 10, zx + zw, 166, FAINT, 0.75) +
            t(zx, 196, 'the last 15 min', { size: 9.5, fill: MUTE, anchor: 'start' }) +
            r(zx, 170, zw, 10, GREY) + r(zx + zw, 170, 30, 10, M) +
            r(zx + zw * 0.7 - 3, 146, 6, 24, M) +
            t(zx + zw * 0.7, 140, 'a bid here', { size: 9.5 }) +
            t(zx + zw + 15, 198, '+15 min', { size: 10, weight: 600, fill: M }) +
            t(16, 242, 'Each bid beats the last by 5% or 0.01 ETH.', { size: 10, anchor: 'start' }) +
            t(16, 258, 'Outbid? Your ETH comes straight back.', { size: 10, anchor: 'start' }) +
            t(16, 34, 'Bids, ETH', { size: 9.5, fill: MUTE, anchor: 'start' }),
        ),
      );
    })(),
    // B · the minimum raise: 0.01 ETH until 0.2 ETH, then 5%.
    (() => {
      const x0 = 50, x1 = 276, y0 = 220, y1 = 60;
      const X = (v: number) => x0 + (v / 0.6) * (x1 - x0);
      const Yv = (v: number) => y0 - (v / 0.03) * (y0 - y1);
      const raise = (v: number) => Math.max(0.05 * v, 0.01);
      return fig(
        svg(
          [0, 0.01, 0.02, 0.03].map((v) => ln(x0, Yv(v), x1, Yv(v), v ? GREY : K, 1) + t(x0 - 6, Yv(v) + 3.5, v.toFixed(2), { size: 8.5, fill: MUTE, anchor: 'end' })).join('') +
            [0, 0.2, 0.4, 0.6].map((v) => t(X(v), y0 + 14, v.toFixed(1), { size: 8.5, fill: MUTE })).join('') +
            ln(X(0.2), Yv(0.01), X(0.2), y0, K, 1, '2 3') +
            `<polyline points="${X(0)},${Yv(0.01)} ${X(0.2)},${Yv(0.01)} ${X(0.6)},${Yv(raise(0.6))}" fill="none" stroke="${M}" stroke-width="2.5"/>` +
            t(X(0.1), Yv(0.01) - 8, '0.01 ETH', { size: 10, weight: 600 }) +
            t(X(0.42) + 8, Yv(raise(0.42)) + 14, '5% of the bid', { size: 10, weight: 600, anchor: 'start' }) +
            t(x0 - 34, 34, 'Minimum raise, ETH', { size: 9.5, fill: MUTE, anchor: 'start' }) +
            t(x1, y0 + 30, 'current bid, ETH', { size: 9.5, fill: MUTE, anchor: 'end' }) +
            t(x0 - 34, 268, '0.10 → next bid at least 0.11', { size: 9.5, anchor: 'start' }) +
            t(x0 - 34, 282, '1.00 → next bid at least 1.05', { size: 9.5, anchor: 'start' }),
        ),
      );
    })(),
    // C · the exchange: who sends what, and when the Statement changes hands.
    (() => {
      const A = 44, S = 150, B = 256;
      const msg = (from: number, to: number, y: number, label: string, fill = K) => arrow(from, y, to + (to > from ? -3 : 3), y, fill, 1.5) + t((from + to) / 2, y - 6, label, { size: 9.5, fill, weight: 600 });
      return fig(
        svg(
          [[A, 'Bidder A'], [S, 'Auction'], [B, 'Bidder B']].map(([x, s]) => t(x as number, 30, s as string, { size: 11, weight: 600 })).join('') +
            ln(A, 40, A, 262, FAINT, 1, '2 3') + ln(B, 40, B, 262, FAINT, 1, '2 3') +
            r(S - 3, 64, 6, 176, Y) + t(S + 8, 156, '24h', { size: 9.5, anchor: 'start', fill: MUTE }) +
            msg(A, S, 64, '1.00 ETH') +
            t(S + 8, 80, 'clock starts', { size: 8.5, anchor: 'start', fill: MUTE }) +
            msg(B, S, 118, '1.05 ETH') +
            t(B - 2, 132, 'at least +5%', { size: 8.5, anchor: 'end', fill: MUTE }) +
            msg(S, A, 132, '1.00 back', M) +
            t(A + 2, 146, 'same moment', { size: 8.5, anchor: 'start', fill: M }) +
            ln(S - 16, 226, S + 16, 226, K, 1) + t(S - 20, 229, 'last 15 min', { size: 8.5, anchor: 'end', fill: MUTE }) + r(S - 3, 240, 6, 14, M) + t(S + 8, 250, '+15 per bid', { size: 8.5, anchor: 'start', fill: M }) +
            r(S + 30, 258, 12, 12, K) + arrow(S + 46, 264, B - 3, 264) + t(B, 284, 'wins the Statement', { size: 9.5, anchor: 'end', weight: 600 }),
        ),
      );
    })(),
  ],

  /* ---------------------------------------------------------------- 7 · early bird */
  early: [
    // A · two sheets, each square's area is that Credit's share.
    (() => {
      const cell = 13, gap = 2, w = sheetW(cell, gap);
      const x1 = 22, x2 = 300 - 22 - w, y0 = 48;
      const cellAt = (x: number, i: number, side: number, fill: string) => {
        const cx = x + (i % 8) * (cell + gap) + (cell - side) / 2, cy = y0 + ((i / 8) | 0) * (cell + gap) + (cell - side) / 2;
        return r(cx, cy, side, side, fill);
      };
      const early = (i: number) => cell * Math.sqrt((3 - (2 * i) / 79) / 3);
      const equal = cell * Math.sqrt(2 / 3);
      let a = '', b = '';
      for (let i = 0; i < 80; i++) {
        a += cellAt(x1, i, early(i), i === 0 ? M : K);
        b += cellAt(x2, i, equal, i === 0 ? C : K);
      }
      const hh = y0 + sheetH(cell, gap);
      return fig(
        svg(
          t(x1 + w / 2, 32, 'Early bird', { size: 12, weight: 600 }) + t(x2 + w / 2, 32, 'Equal', { size: 12, weight: 600 }) +
            a + b +
            t(x1 + w / 2, hh + 18, '1st gets 3× the 80th', { size: 10 }) +
            t(x2 + w / 2, hh + 18, 'all the same', { size: 10 }) +
            t(x1 + w / 2, hh + 34, '0.0735 → 0.0245', { size: 9.5, fill: MUTE }) +
            t(x2 + w / 2, hh + 34, '0.049 each', { size: 9.5, fill: MUTE }) +
            t(150, hh + 60, 'area = share · ETH on a 4 ETH sale', { size: 9, fill: MUTE }),
        ),
      );
    })(),
    // B · stacks: the 1st, 40th and 80th Credit's share, in blocks.
    (() => {
      const S = 16, g = 3, base = 214;
      const stack = (x: number, count: number, fill: string) => Array.from({ length: count }, (_, i) => r(x, base - (i + 1) * (S + g) + g, S, S, fill)).join('');
      const group = (x0: number, counts: number[], fill: string, title: string, tags: string[]) =>
        counts.map((c, i) => stack(x0 + i * 38, c, i === 0 && fill === M ? M : K) + t(x0 + i * 38 + S / 2, base + 16, ['1st', '40th', '80th'][i], { size: 9.5, fill: MUTE }) + t(x0 + i * 38 + S / 2, base - c * (S + g) - 4, tags[i], { size: 10, weight: 600 })).join('') +
        t(x0 + 38 + S / 2, base + 44, title, { size: 12, weight: 600 });
      return fig(
        svg(
          group(26, [6, 4, 2], M, 'Early bird', ['3×', '2×', '1×']) +
            group(182, [4, 4, 4], K, 'Equal', ['2×', '2×', '2×']) +
            ln(20, base + 1, 280, base + 1, K, 1) +
            t(150, base + 70, 'same pot: 12 blocks each', { size: 9.5, fill: MUTE }),
        ),
      );
    })(),
    // C · the chart: ETH per Credit on a 4 ETH sale, both kinds.
    (() => {
      const x0 = 52, x1 = 276, y0 = 230, y1 = 62;
      const X = (i: number) => x0 + ((i - 1) / 79) * (x1 - x0);
      const Yv = (v: number) => y0 - (v / 0.08) * (y0 - y1);
      return fig(
        svg(
          [0, 0.02, 0.04, 0.06, 0.08].map((v) => ln(x0, Yv(v), x1, Yv(v), v ? GREY : K, 1) + t(x0 - 6, Yv(v) + 3.5, v ? v.toFixed(2) : '0', { size: 8.5, fill: MUTE, anchor: 'end' })).join('') +
            `<polygon points="${X(1)},${Yv(0.0735)} ${X(80)},${Yv(0.0245)} ${X(80)},${Yv(0.049)} ${X(1)},${Yv(0.049)}" fill="${M}" opacity=".12"/>` +
            ln(X(1), Yv(0.049), X(80), Yv(0.049), C, 2.5) +
            ln(X(1), Yv(0.0735), X(80), Yv(0.0245), M, 2.5) +
            t(X(1) + 4, Yv(0.0735) - 8, '1st 0.0735', { size: 10, weight: 600, anchor: 'start', fill: M }) +
            t(X(80), Yv(0.0245) + 16, '80th 0.0245', { size: 10, weight: 600, anchor: 'end', fill: M }) +
            t(X(80), Yv(0.049) - 8, 'Equal 0.049', { size: 10, weight: 600, anchor: 'end', fill: C }) +
            t(X(1), y0 + 14, '1st', { size: 8.5, fill: MUTE }) + t(X(80), y0 + 14, '80th', { size: 8.5, fill: MUTE }) +
            t(150, y0 + 14, 'Credit, in order', { size: 8.5, fill: MUTE }) +
            t(16, 36, 'ETH per Credit, 4 ETH sale', { size: 9.5, fill: MUTE, anchor: 'start' }) +
            t(16, 272, 'Both split the same 3.92 ETH.', { size: 10, anchor: 'start' }),
        ),
      );
    })(),
  ],

  /* ---------------------------------------------------------------- 8 · launch */
  launch: [
    // A · the timeline, now to burning.
    (() => {
      const y = 146, a = 20, e1 = 96, e2 = 150, e3 = 214, d = 282;
      const above = (x: number, s1: string, s2: string) => ln(x, y - 4, x, y - 20, K, 1) + t(x, y - 40, s1, { size: 10.5, weight: 600 }) + t(x, y - 27, s2, { size: 9.5, fill: MUTE });
      const below = (x: number, s1: string, s2: string) => ln(x, y + 16, x, y + 30, K, 1) + t(x, y + 46, s1, { size: 10.5, weight: 600 }) + t(x, y + 59, s2, { size: 9.5, fill: MUTE });
      return fig(
        svg(
          r(a, y, e1 - a, 12, C) + r(e1, y, e2 - e1, 12, GREY) + r(e2, y, e3 - e2, 12, Y) + r(e3, y, d - e3, 12, G) +
            above(a + 30, 'Now', 'parties fill') +
            below(e1, 'Jack ships', 'his contract') +
            above(e2, 'Adapter', 'proposed') +
            below((e2 + e3) / 2, '30 min', 'anyone can leave') +
            above(e3 + 22, 'Switched on', 'burns open') +
            t(150, 270, 'The 30 minutes apply to every party.', { size: 9.5, fill: MUTE }),
        ),
      );
    })(),
    // B · the plug: party, adapter, Jack's contract, in three frames.
    (() => {
      const cell = 4, gap = 1, w = sheetW(cell, gap), h = sheetH(cell, gap);
      const rand = rng(33);
      const inks = Array.from({ length: 80 }, () => randomInk(rand));
      const rows = [22, 112, 202];
      const cx = 100;
      const frame = (y: number, adapter: string, contract: string, a: string, b: string) =>
        sheet(18, y, cell, gap, (i) => inks[i]) + adapter + contract + t(166, y + 20, a, { size: 11, weight: 600, anchor: 'start' }) + t(166, y + 34, b, { size: 9.5, fill: MUTE, anchor: 'start' });
      return fig(
        svg(
          frame(rows[0], '', box(cx, rows[0], w, h, K, 1.5, '3 3'), 'Today', 'Jack’s contract not out') +
            frame(rows[1], box(64, rows[1] + h / 2 - 6, 30, 12, K, 1.5, '3 3') + r(64, rows[1] + h / 2 + 12, 30, 5, Y), r(cx, rows[1], w, h, K), 'Adapter proposed', '30 min: anyone can leave') +
            frame(rows[2], r(64, rows[2] + h / 2 - 6, 30, 12, G), r(cx, rows[2], w, h, K), 'Switched on', 'parties can burn') +
            t(cx + w / 2, rows[0] + h / 2 + 4, '?', { size: 12, weight: 600 }),
        ),
      );
    })(),
    // C · thirty squares, thirty minutes.
    (() => {
      const S = 16, g = 3, x0 = 26, y0 = 92;
      let grid = '';
      for (let i = 0; i < 30; i++) grid += r(x0 + (i % 6) * (S + g), y0 + ((i / 6) | 0) * (S + g), S, S, Y);
      const gw = 6 * (S + g) - g, gh = 5 * (S + g) - g;
      const cell = 5, gap = 1, sx = 196, sy = 98;
      const rand = rng(51);
      const inks = Array.from({ length: 80 }, () => randomInk(rand));
      const gone = [7, 30, 61];
      return fig(
        svg(
          r(x0, 36, 12, 12, K) + t(x0 + 20, 46, 'Burn adapter proposed', { size: 11, weight: 600, anchor: 'start' }) +
            ln(x0 + 6, 52, x0 + 6, y0 - 6, K, 1) +
            grid +
            t(x0 + gw + 14, y0 + gh / 2 - 4, '30', { size: 20, weight: 600, anchor: 'start' }) + t(x0 + gw + 14, y0 + gh / 2 + 10, 'minutes', { size: 9.5, fill: MUTE, anchor: 'start' }) +
            ln(x0 + 6, y0 + gh + 6, x0 + 6, 238, K, 1) +
            r(x0, 240, 12, 12, G) + t(x0 + 20, 250, 'Switched on, burns open', { size: 11, weight: 600, anchor: 'start' }) +
            sheet(sx, sy, cell, gap, (i) => (gone.includes(i) ? '' : inks[i])) +
            gone.map((i, k) => arrow(sx + sheetW(cell, gap) + 3, sy + 12 + k * 18, sx + sheetW(cell, gap) + 20, sy + 4 + k * 18, K, 1)).join('') +
            t(sx + sheetW(cell, gap) / 2 + 6, sy + sheetH(cell, gap) + 16, 'anyone can', { size: 9.5, fill: MUTE }) +
            t(sx + sheetW(cell, gap) / 2 + 6, sy + sheetH(cell, gap) + 29, 'leave any party', { size: 9.5, fill: MUTE }),
        ),
      );
    })(),
  ],
};


/* ================================================================ round 2 */

/// A frame drawn as four sides, with an optional gap (a door) in the right side from y `d0` to `d1`.
const frameWithDoor = (x: number, y: number, w: number, h: number, d0?: number, d1?: number, sw = 2) =>
  ln(x, y, x + w, y, K, sw) + ln(x, y + h, x + w, y + h, K, sw) + ln(x, y - sw / 2, x, y + h + sw / 2, K, sw) +
  (d0 === undefined || d1 === undefined ? ln(x + w, y - sw / 2, x + w, y + h + sw / 2, K, sw) : ln(x + w, y - sw / 2, x + w, d0, K, sw) + ln(x + w, d1, x + w, y + h + sw / 2, K, sw));
/// Speed lines trailing to the left of (x, y).
const speed = (x: number, y: number, len = 18, gap = 7, n = 3) => Array.from({ length: n }, (_, i) => ln(x - len - (i % 2) * 6, y + i * gap, x - 4 - (i % 2) * 6, y + i * gap, K, 1.5)).join('');
const creditOut = (x: number, y: number, s: number, mask: number, seed: number) => print(x, y, s, mask, seed, 0.5) + box(x, y, s, s, K, 1);

const NEW: Record<string, string[]> = {
  /* ---------------------------------------------------------------- 2 · who joins */
  eligibility: [
    // A · two groups side by side.
    (() => {
      const S = 36;
      const cellX = (x: number, k: number) => x + 18 + (k % 2) * (S + 12);
      const cellY = (k: number) => 104 + ((k / 2) | 0) * (S + 10);
      const inn = [1, 1, 1, 1, 1, 1], out = [2, 4, 8, 3, 6, 5];
      return fig(
        svg(
          t(150, 42, 'Rule: Colors is C', { size: 16, weight: 600 }) +
            box(16, 62, 128, 190, K, 2) + t(80, 88, 'In', { size: 15, weight: 600 }) +
            inn.map((m, k) => print(cellX(16, k), cellY(k), S, m, k + 60, 0.5) + box(cellX(16, k), cellY(k), S, S, GREY, 0.75)).join('') +
            box(156, 62, 128, 190, FAINT, 1.5, '4 4') + t(220, 88, 'Not in', { size: 15, weight: 600, fill: MUTE }) +
            `<g opacity=".35">${out.map((m, k) => print(cellX(156, k), cellY(k), S, m, k + 70, 0.5)).join('')}</g>`,
        ),
      );
    })(),
    // B · the party sheet: C Credits fill it, the rest stay outside.
    (() => {
      const { cell } = SHEET, w = SW, x0 = SX, cx = (i: number) => slotX(i), cy = slotY;
      const cells = partySheet((i) => (i < 30 ? C : GREY));
      const outside: [number, number, number][] = [[24, SY + 8, 2], [24, 139, 4], [24, SY + SH - 30, 8], [254, 139, 6], [254, SY + SH - 30, 3]];
      return fig(
        svg(
          cells +
            r(x0 + w + 26, cy(30) - 34, 22, 22, C) + arrow(x0 + w + 24, cy(30) - 18, cx(30) + cell + 3, cy(30) + cell / 2, K, 1.5) +
            `<g opacity=".3">${outside.map(([x, y, m]) => r(x, y, 22, 22, MIX[m])).join('')}</g>`,
        ),
      );
    })(),
    // C · a line-up by Rating, cut at 7.
    (() => {
      const X = (v: number) => 24 + v * 25.2, base = 176;
      const cut = 7;
      const credits: [number, number, number][] = [[0.8, 2, 0], [2.4, 4, 0], [4.0, 8, 0], [5.6, 6, 0], [7.8, 1, 0], [8.9, 5, 0], [10, 2, 0]];
      return fig(
        svg(
          t(X(cut), 100, 'Rule: Rating 7+', { size: 16, weight: 600 }) +
            ln(X(cut), 112, X(cut), base + 10, K, 2) +
            credits.map(([v, m, lift], k) => {
              const s = 22, x = X(v) - s / 2, y = base - 36 - lift;
              const body = print(x, y, s, m, k + 40, 0.5) + box(x, y, s, s, GREY, 0.75);
              return v >= cut ? body : `<g opacity=".3">${body}</g>`;
            }).join('') +
            ln(24, base, 276, base, K, 1.5) +
            [0, 5, 10].map((v) => ln(X(v), base, X(v), base + 5, K, 1) + t(X(v), base + 20, String(v), { size: 13, fill: MUTE })).join('') +
            t((24 + X(cut)) / 2, 236, 'Not in', { size: 15, weight: 600, fill: MUTE }) +
            t((X(cut) + 276) / 2, 236, 'In', { size: 15, weight: 600 }),
        ),
      );
    })(),
  ],

  /* ---------------------------------------------------------------- 3 · painted sheet, simpler */
  order: [
    // B1 · two colors, one empty slot, one Credit.
    (() => {
      const { cell } = SHEET, cx = (i: number) => slotX(i), cy = slotY;
      const paint = (c: number, row: number) => (c + row < 8 ? 1 : 2);
      const hole = 39;
      return fig(
        svg(
          partySheet((i, c, row) => (i === hole ? '' : MIX[paint(c, row)])) +
            box(cx(hole) + 1, cy(hole) + 1, cell - 2, cell - 2, M, 2) +
            r(256, cy(hole) + cell / 2 - 15, 30, 30, M) +
            arrow(250, cy(hole) + cell / 2, cx(hole) + cell + 5, cy(hole) + cell / 2, K, 1.5),
        ),
      );
    })(),
    // B2 · the sheet painted in solid inks, one black slot still open.
    (() => {
      const { cell } = SHEET, cx = (i: number) => slotX(i), cy = slotY;
      const ring = (c: number, row: number) => Math.min(c, 7 - c, row, 9 - row);
      const paint = (c: number, row: number) => [8, 1, 2, 4, 4][ring(c, row)];
      const hole = 15;
      const cells = partySheet((i, c, row) => (i === hole ? '' : MIX[paint(c, row)]));
      return fig(
        svg(
          cells + box(cx(hole) + 1, cy(hole) + 1, cell - 2, cell - 2, K, 2) +
            r(256, cy(hole) + cell / 2 - 15, 30, 30, MIX[8]) +
            arrow(250, cy(hole) + cell / 2, cx(hole) + cell + 5, cy(hole) + cell / 2, K, 1.5),
        ),
      );
    })(),
    // B3 · paint a picture: an 8 in black on yellow; a black Credit drops into the gap.
    (() => {
      const cell = 20, gap = 3, w = sheetW(cell, gap), x0 = (300 - w) / 2 - 24, y0 = 48;
      const rows = ['........', '..KKKK..', '.K....K.', '.K....K.', '..KKKK..', '.K....K.', '.K....K.', '.K....K.', '..KKKK..', '........'];
      const paint = (c: number, row: number) => (rows[row][c] === 'K' ? 8 : 4);
      const hole = 13;
      const cx = (i: number) => x0 + (i % 8) * (cell + gap), cy = (i: number) => y0 + ((i / 8) | 0) * (cell + gap);
      return fig(
        svg(
          sheet(x0, y0, cell, gap, (i, c, row) => (i === hole ? '' : MIX[paint(c, row)])) +
            box(cx(hole) + 1, cy(hole) + 1, cell - 2, cell - 2, K, 2) +
            creditOut(x0 + w + 16, 14, 36, 8, 12) +
            `<path d="M${x0 + w + 34} 54 V${cy(hole) + cell / 2} H${cx(hole) + cell + 5}" fill="none" stroke="${K}" stroke-width="1.5"/>` +
            arrow(cx(hole) + cell + 14, cy(hole) + cell / 2, cx(hole) + cell + 5, cy(hole) + cell / 2, K, 1.5),
        ),
      );
    })(),
  ],

  /* ---------------------------------------------------------------- 5 · leaving, the Credit runs out */
  exit: [
    // D · out through a door in the party's frame.
    (() => {
      const cell = 10, gap = 3, w = sheetW(cell, gap), h = sheetH(cell, gap), x0 = 44, y0 = 60;
      const rand = rng(77);
      const inks = Array.from({ length: 80 }, () => randomInk(rand));
      const fx = x0 - 10, fy = y0 - 10, fw = w + 20, fh = h + 20;
      const d0 = 150, d1 = 184, hx = fx + fw;
      return fig(
        svg(
          partySheet((i) => (i < 46 && i !== 39 ? inks[i] : GREY), x0) +
            frameWithDoor(fx, fy, fw, fh, d0, d1) +
            ln(hx, d0, hx + (d1 - d0), d0, K, 2) +
            `<path d="M${hx + (d1 - d0)} ${d0} A${d1 - d0} ${d1 - d0} 0 0 1 ${hx} ${d1}" fill="none" stroke="${K}" stroke-width="1" stroke-dasharray="2 3"/>` +
            speed(226, 160) + creditOut(230, 152, 34, 1, 5) +
            t(150, 262, 'Not full yet? Walk out any time.', { size: 15, weight: 600 }),
        ),
      );
    })(),
    // E · the exit sign.
    (() => {
      const dx = 104, dy = 92, dw = 72, dh = 150;
      return fig(
        svg(
          r(dx + 8, 44, dw - 16, 24, G) + t(dx + dw / 2, 61, 'EXIT', { size: 14, weight: 700, fill: '#fff' }) +
            r(dx, dy, dw, dh, K) + box(dx - 6, dy - 6, dw + 12, dh + 6, K, 2) +
            ln(20, dy + dh, 280, dy + dh, K, 1.5) +
            speed(dx + 118, dy + dh - 50, 22, 9) +
            creditOut(dx + 118, dy + dh - 66, 44, 6, 21) +
            t(150, 274, 'Leave any time before it fills.', { size: 15, weight: 600 }),
        ),
      );
    })(),
    // F · three doors: open, shut for 7 days, open to all.
    (() => {
      const cell = 4.5, gap = 1.5, w = sheetW(cell, gap), h = sheetH(cell, gap);
      const rand = rng(88);
      const inks = Array.from({ length: 80 }, () => randomInk(rand));
      const col = (k: number) => 20 + k * 92;
      const y0 = 100;
      const panel = (k: number, filled: (i: number) => boolean, door: boolean, a: string, b: string) => {
        const x = col(k), fx = x - 8, fw = w + 16, fh = h + 16, fy = y0 - 8;
        return sheet(x, y0, cell, gap, (i) => (filled(i) ? inks[i] : GREY)) +
          frameWithDoor(fx, fy, fw, fh, door ? fy + fh - 30 : undefined, door ? fy + fh - 6 : undefined, 2) +
          t(fx + fw / 2 + 6, fy + fh + 26, a, { size: 14, weight: 600 }) + t(fx + fw / 2 + 6, fy + fh + 42, b, { size: 12, fill: MUTE });
      };
      const out = (x: number, y: number, m: number, s: number) => speed(x, y + s / 2 - 5, 10, 5, 2) + creditOut(x, y, s, m, x);
      return fig(
        svg(
          panel(0, (i) => i < 44 && i !== 43, true, 'Filling', 'door open') +
            out(col(0) + w + 14, y0 + h - 18, 1, 16) +
            panel(1, () => true, false, 'Full', 'shut 7 days') +
            t(col(1) + w / 2, y0 - 20, '7 days', { size: 12, weight: 600 }) +
            panel(2, (i) => i % 9 !== 0, true, 'Unburned', 'everyone free') +
            out(col(2) + w + 14, y0 + h - 18, 2, 14) + out(col(2) + w + 24, y0 + h - 42, 4, 14),
        ),
      );
    })(),
  ],

  /* ---------------------------------------------------------------- 6 · auction, simple */
  auction: [
    // A · bids climb, the top one wins the Statement.
    (() => {
      const bids: [number, string][] = [[40, '0.5'], [62, '0.6'], [92, '0.8'], [132, '1.2']];
      const base = 220;
      return fig(
        svg(
          bids.map(([h, v], i) => r(24 + i * 44, base - h, 30, h, i === 3 ? M : K) + t(39 + i * 44, base - h - 8, v, { size: 14, weight: 600, fill: i === 3 ? M : K })).join('') +
            ln(18, base, 200, base, K, 1.5) + t(24, base + 22, 'bids, ETH', { size: 13, fill: MUTE, anchor: 'start' }) +
            arrow(206, base - 110, 226, base - 110) +
            r(230, base - 150, 52, 65, K) +
            t(256, base - 66, 'top bid', { size: 13, weight: 600 }) + t(256, base - 50, 'wins it', { size: 13, weight: 600 }) +
            ln(24, 262, 186, 262, K, 1.5) + ln(24, 256, 24, 268, K, 1.5) + ln(186, 256, 186, 268, K, 1.5) +
            t(105, 284, '24 hours', { size: 14, weight: 600 }),
        ),
      );
    })(),
    // B · the auction card: the Statement, the top bid, the clock.
    (() => {
      const sw = 104, sh = 130, sx = 20, sy = 44;
      const hours = 24, left = 3;
      return fig(
        svg(
          r(sx, sy, sw, sh, K) +
            t(146, 62, 'Top bid', { size: 13, fill: MUTE, anchor: 'start' }) +
            t(146, 90, '1.20 ETH', { size: 24, weight: 600, anchor: 'start' }) +
            t(146, 128, 'Ends in', { size: 13, fill: MUTE, anchor: 'start' }) +
            t(146, 156, '3h 12m', { size: 24, weight: 600, anchor: 'start' }) +
            Array.from({ length: hours }, (_, i) => r(20 + i * 11, 212, 9, 20, i < hours - left ? GREY : K)).join('') +
            t(20, 252, 'bidding opened', { size: 13, fill: MUTE, anchor: 'start' }) +
            t(282, 252, 'ends', { size: 13, fill: MUTE, anchor: 'end' }) +
            t(150, 282, 'Highest bid when the clock runs out wins.', { size: 13, weight: 600 }),
        ),
      );
    })(),
    // C · three steps, big.
    (() => {
      const row = (i: number) => 34 + i * 88;
      const label = (i: number, a: string, b: string) => t(128, row(i) + 28, a, { size: 17, weight: 600, anchor: 'start' }) + t(128, row(i) + 48, b, { size: 13, fill: MUTE, anchor: 'start' });
      return fig(
        svg(
          [16, 30, 46, 64].map((h, k) => r(28 + k * 20, row(0) + 64 - h, 14, h, k === 3 ? M : K)).join('') + label(0, 'Bids go up', 'in ETH, each beats the last') +
            Array.from({ length: 24 }, (_, k) => r(28 + (k % 6) * 13, row(1) + ((k / 6) | 0) * 13 + 8, 11, 11, k < 23 ? GREY : K)).join('') + label(1, 'The clock runs', '24 hours from the first bid') +
            r(28, row(2) + 4, 44, 55, K) + arrow(78, row(2) + 32, 104, row(2) + 32) + label(2, 'Top bid wins', 'the Statement is theirs'),
        ),
      );
    })(),
  ],

  /* ---------------------------------------------------------------- 7 · early bird, in percent */
  early: [
    // A2 · A's two sheets, labelled in share of the pot.
    (() => {
      const cell = 12, gap = 2, w = sheetW(cell, gap), hgt = sheetH(cell, gap);
      const x1 = 24, x2 = 300 - 24 - w, y0 = 50;
      const at = (x: number, i: number, side: number, fill: string) =>
        r(x + (i % 8) * (cell + gap) + (cell - side) / 2, y0 + ((i / 8) | 0) * (cell + gap) + (cell - side) / 2, side, side, fill);
      let a = '', b = '';
      for (let i = 0; i < 80; i++) {
        a += at(x1, i, cell * Math.sqrt((3 - (2 * i) / 79) / 3), i === 0 || i === 79 ? M : K);
        b += at(x2, i, cell * Math.sqrt(2 / 3), K);
      }
      const hh = y0 + hgt;
      return fig(
        svg(
          t(x1 + w / 2, 34, 'Early bird', { size: 15, weight: 600 }) + t(x2 + w / 2, 34, 'Equal', { size: 15, weight: 600 }) +
            a + b +
            t(x1 + w / 2, hh + 22, '1st 1.875%', { size: 14, weight: 600, fill: M }) +
            t(x1 + w / 2, hh + 40, '80th 0.625%', { size: 14, weight: 600, fill: M }) +
            t(x2 + w / 2, hh + 22, 'each 1.25%', { size: 14, weight: 600 }) +
            t(150, hh + 68, '% of the pot after the 2% fee', { size: 13, fill: MUTE }),
        ),
      );
    })(),
    // A3 · A's two sheets with a size key.
    (() => {
      const cell = 12, gap = 2, w = sheetW(cell, gap), hgt = sheetH(cell, gap);
      const x1 = 24, x2 = 300 - 24 - w, y0 = 40;
      const at = (x: number, i: number, side: number) =>
        r(x + (i % 8) * (cell + gap) + (cell - side) / 2, y0 + ((i / 8) | 0) * (cell + gap) + (cell - side) / 2, side, side, K);
      let a = '', b = '';
      for (let i = 0; i < 80; i++) {
        a += at(x1, i, cell * Math.sqrt((3 - (2 * i) / 79) / 3));
        b += at(x2, i, cell * Math.sqrt(2 / 3));
      }
      const hh = y0 + hgt;
      const keyY = hh + 34, K2 = 18;
      const key: [number, string][] = [[3, '1.875%'], [2, '1.25%'], [1, '0.625%']];
      return fig(
        svg(
          t(x1 + w / 2, 28, 'Early bird', { size: 15, weight: 600 }) + t(x2 + w / 2, 28, 'Equal', { size: 15, weight: 600 }) +
            a + b +
            key.map(([p, s], k) => {
              const side = K2 * Math.sqrt(p / 3), x = 24 + k * 94;
              return r(x + (K2 - side) / 2, keyY + (K2 - side) / 2, side, side, K) + t(x + K2 + 8, keyY + 14, s, { size: 14, weight: 600, anchor: 'start' });
            }).join('') +
            t(24, keyY + 44, 'square = share of the pot, after the fee', { size: 13, fill: MUTE, anchor: 'start' }),
        ),
      );
    })(),
  ],

  /* ---------------------------------------------------------------- 8 · share your party */
  share: [
    // A · a phone: the link in a chat, the card under it.
    (() => {
      const px = 70, py = 16, pw = 160, ph = 276;
      const cell = 7, gap = 1.5, sw = sheetW(cell, gap);
      return fig(
        svg(
          box(px, py, pw, ph, K, 2) + r(px + pw / 2 - 16, py + 10, 32, 4, K) +
            r(px + 24, 50, pw - 36, 30, C) + t(px + pw - 20, 70, 'eighty.fun/party/…', { size: 11.5, fill: '#fff', anchor: 'end', weight: 600 }) +
            r(px + 12, 92, pw - 24, 150, '#fff') + box(px + 12, 92, pw - 24, 150, GREY, 1) +
            sheet(px + 12 + (pw - 24 - sw) / 2, 102, cell, gap, (i) => (i < 43 ? C : GREY)) +
            t(px + 22, 205, 'Cyan Only', { size: 13, weight: 600, anchor: 'start' }) +
            t(px + pw - 22, 205, '43/80', { size: 13, weight: 600, anchor: 'end' }) +
            t(px + 22, 224, 'eighty.fun', { size: 11.5, fill: MUTE, anchor: 'start' }) +
            r(px + 24, 254, 70, 24, GREY) + t(px + 34, 270, 'I’m in', { size: 12, anchor: 'start' }),
        ),
      );
    })(),
    // B · the card itself, big.
    (() => {
      const cx = 10, cy = 74, cw = 280, ch = 147;
      const cell = 10, gap = 2, sw = sheetW(cell, gap), sh = sheetH(cell, gap);
      return fig(
        svg(
          t(10, 50, 'eighty.fun/party/0x3f…', { size: 14, fill: C, anchor: 'start', weight: 600 }) +
            r(cx, cy, cw, ch, '#fff') +
            sheet(cx + 14, cy + (ch - sh) / 2, cell, gap, (i) => (i < 43 ? C : GREY)) +
            t(cx + sw + 30, cy + 36, 'Cyan Only', { size: 16, weight: 600, anchor: 'start' }) +
            t(cx + sw + 30, cy + 84, '43/80', { size: 34, weight: 600, anchor: 'start' }) +
            r(cx + sw + 30, cy + 100, 124, 6, GREY) + r(cx + sw + 30, cy + 100, 124 * 43 / 80, 6, C) +
            t(cx + sw + 30, cy + 130, 'eighty.fun', { size: 13, fill: MUTE, anchor: 'start' }) +
            t(150, 256, 'The preview is the live sheet.', { size: 14, weight: 600 }),
        ),
      );
    })(),
    // C · one link, many places, one party filling.
    (() => {
      const cell = 6, gap = 1.5, sw = sheetW(cell, gap);
      const sx = 150 - sw / 2, sy = 190;
      const dest: [number, string][] = [[52, 'X'], [150, 'Telegram'], [248, 'iMessage']];
      return fig(
        svg(
          r(60, 18, 180, 30, K) + t(150, 38, 'eighty.fun/party/0x3f…', { size: 12.5, fill: '#fff', weight: 600 }) +
            dest.map(([x, s]) => arrow(150, 50, x, 96) + box(x - 42, 100, 84, 30, K, 1.5) + t(x, 120, s, { size: 13, weight: 600 }) + arrow(x, 134, 150 + (x - 150) * 0.3, sy - 6)).join('') +
            sheet(sx, sy, cell, gap, (i) => (i < 36 ? K : i < 43 ? C : GREY)) +
            t(sx + sw + 12, sy + 40, '43/80', { size: 15, weight: 600, anchor: 'start' }),
        ),
      );
    })(),
  ],
};


/* ================================================================ round 3: wordless, solid inks */

const MIX16 = ['#fff', '#00b5e2', '#e4007c', '#00006e', '#ffd100', '#009400', '#e40000', '#000', '#111', '#000c0f', '#0f0008', '#000007', '#110e00', '#000a00', '#0f0000', '#000'];

const R3 = {
  // 1A · the five steps as the homepage draws them, one word each.
  lifecycle: (() => {
    const steps: [string, string][] = [['Open', C], ['Full', M], ['Burn', K], ['Auction', Y], ['Split', G]];
    const y = (i: number) => 38 + i * 56, sx = 92, S = 28;
    return fig(svg(ln(sx + S / 2, y(0) + S / 2, sx + S / 2, y(4) + S / 2, K, 1.5) +
      steps.map(([a, f], i) => r(sx, y(i), S, S, f) + t(sx + S + 20, y(i) + S / 2 + 6, a, { size: 17, weight: 600, anchor: 'start' })).join('')));
  })(),

  // 2A · all fifteen Colors; the party takes three.
  eligibility: (() => {
    const on = new Set([1, 5, 6]);
    const S = 44, g = 10, x0 = (300 - (5 * S + 4 * g)) / 2, y0 = (300 - (3 * S + 2 * g)) / 2;
    return fig(svg(Array.from({ length: 15 }, (_, i) => r(x0 + (i % 5) * (S + g), y0 + ((i / 5) | 0) * (S + g), S, S, MIX16[i + 1], on.has(i + 1) ? '' : ' opacity=".15"')).join('')));
  })(),

  // 4A · listings in, one arrow, the party sheet.
  buying: fig(svg(
    [0, 1, 2, 3, 4].map((i) => r(18, 150 - 48 + i * 20, 16, 16, C)).join('') +
      arrow(42, 150, 72, 150) +
      partySheet((i) => (i < 58 ? '#9a9a9a' : i < 63 ? C : GREY)),
  )),

  // 4D · the receipt as a waterfall: five listings end to end, then the 2%, then the total.
  receipt: (() => {
    const prices = [0.031, 0.033, 0.034, 0.038, 0.04];
    const total = 0.176 * 1.02, x0 = 56, span = 218, k = span / total;
    let at = x0, out = '';
    prices.forEach((p, i) => {
      const y = 44 + i * 30;
      out += r(22, y, 18, 18, C) + r(at, y + 3, p * k, 12, K);
      at += p * k;
    });
    const fee = 0.176 * 0.02 * k;
    out += r(at, 44 + 5 * 30 + 3, fee, 12, M) + t(at - 6, 44 + 5 * 30 + 13, '2%', { size: 14, weight: 600, fill: M, anchor: 'end' });
    out += ln(22, 226, x0 + span, 226, K, 1.5);
    out += r(x0, 242, span - fee, 16, K) + r(x0 + span - fee, 242, fee, 16, M);
    return fig(svg(out));
  })(),

  // 5A · filling, locked, open: squares walk out where they can.
  exit: (() => {
    const bx = 96, bw = 30;
    const segs: [number, number, string][] = [[36, 144, C], [144, 204, K], [204, 264, Y]];
    const out = (y: number, s = 18) => arrow(bx + bw + 8, y, bx + bw + 54, y, K, 1.5) + r(bx + bw + 62, y - s / 2, s, s, C);
    return fig(svg(
      segs.map(([a, b, f]) => r(bx, a, bw, b - a, f)).join('') +
        out(90) +
        ln(bx + bw + 8, 174, bx + bw + 34, 174, K, 1.5) + ln(bx + bw + 34, 165, bx + bw + 34, 183, K, 2.5) +
        t(bx + bw + 46, 179, '7 days', { size: 15, weight: 600, anchor: 'start' }) +
        out(213, 14) + out(234, 14) + out(255, 14),
    ));
  })(),

  // 5E · out through a door in the party's frame.
  door: (() => {
    // Same sheet and top edge as the others; shifted left so the door and the runner fit on the right.
    const w = SW, h = SH, x0 = 40, y0 = SY;
    const rand = rng(77);
    const inks = Array.from({ length: 80 }, () => randomInk(rand));
    const fx = x0 - 8, fy = y0 - 8, fw = w + 16, fh = h + 16;
    const d0 = fy + fh - 52, d1 = fy + fh - 18, hx = fx + fw, dw = d1 - d0;
    return fig(svg(
      partySheet((i) => (i < 46 && i !== 39 ? inks[i] : GREY), x0) +
        frameWithDoor(fx, fy, fw, fh, d0, d1) +
        ln(hx, d0, hx + dw, d0, K, 2) +
        `<path d="M${hx + dw} ${d0} A${dw} ${dw} 0 0 1 ${hx} ${d1}" fill="none" stroke="${K}" stroke-width="1" stroke-dasharray="2 3"/>` +
        speed(242, (d0 + d1) / 2 - 7) + r(246, (d0 + d1) / 2 - 15, 30, 30, C),
    ));
  })(),

  // 5G · three doors: open, shut for 7 days, open to all.
  doors: (() => {
    const cell = 5, gap = 1.5, w = sheetW(cell, gap), h = sheetH(cell, gap);
    const rand = rng(88);
    const inks = Array.from({ length: 80 }, () => randomInk(rand));
    const col = (k: number) => 12 + k * 96;
    const y0 = (300 - h) / 2 + 6;
    const panel = (k: number, filled: (i: number) => boolean, door: boolean) => {
      const x = col(k), fx = x - 8, fw = w + 16, fh = h + 16, fy = y0 - 8;
      return sheet(x, y0, cell, gap, (i) => (filled(i) ? inks[i] : GREY)) +
        frameWithDoor(fx, fy, fw, fh, door ? fy + fh - 30 : undefined, door ? fy + fh - 6 : undefined, 2);
    };
    const out = (x: number, y: number, f: string) => speed(x, y + 2, 10, 5, 2) + r(x, y - 5, 14, 14, f);
    const bottom = y0 + h + 8;
    return fig(svg(
      panel(0, (i) => i < 44 && i !== 43, true) + out(col(0) + w + 16, bottom - 18, C) +
        panel(1, () => true, false) + t(col(1) + w / 2, y0 - 22, '7 days', { size: 14, weight: 600 }) +
        panel(2, (i) => i % 9 !== 0, true) + out(col(2) + w + 16, bottom - 18, M) + out(col(2) + w + 20, bottom - 42, Y),
    ));
  })(),

};


/* ================================================================ round 4: auction, with the framed Statement */

const AUCTION = [
  // A · paddles: three bidders raise, the highest in magenta.
  (() => {
    const sw = 96, sx = 150 - sw / 2, sy = 22, base = 280;
    const paddle = (x: number, top: number, f: string) => ln(x, top + 26, x, base, K, 2.5) + r(x - 14, top, 28, 28, f);
    return fig(svg(statement(sx, sy, sw) + paddle(66, 212, K) + paddle(150, 186, K) + paddle(234, 158, M)));
  })(),
  // B · ladder: each bid a wider block than the last, the top one magenta.
  (() => {
    const sw = 104, sh = statementH(sw), sx = 20, sy = (300 - sh) / 2;
    const widths = [48, 70, 94, 122], bh = 22, g = 8, x0 = 152, bottom = 150 + (widths.length * (bh + g) - g) / 2;
    return fig(svg(statement(sx, sy, sw) +
      widths.map((w, i) => r(x0, bottom - (i + 1) * bh - i * g, w, bh, i === widths.length - 1 ? M : K)).join('')));
  })(),
  // C · clock: the Statement inside a 24h ring; bids land on it, growing, the last magenta.
  (() => {
    const cx = 150, cy = 150, R = 118, gone = 0.72;
    const pt = (f: number) => [cx + R * Math.sin(f * 2 * Math.PI), cy - R * Math.cos(f * 2 * Math.PI)];
    const [ex, ey] = pt(gone);
    const sw = 92, sh = statementH(sw);
    const bids: [number, number][] = [[0.05, 5.5], [0.22, 7], [0.41, 8.5], [0.58, 10], [gone, 12.5]];
    return fig(svg(
      `<circle cx="${cx}" cy="${cy}" r="${R}" fill="none" stroke="${GREY}" stroke-width="8"/>` +
        `<path d="M${cx} ${cy - R} A${R} ${R} 0 1 1 ${n(ex)} ${n(ey)}" fill="none" stroke="${K}" stroke-width="8"/>` +
        bids.map(([f, rad], i) => { const [x, y] = pt(f); return `<circle cx="${n(x)}" cy="${n(y)}" r="${rad}" fill="${i === bids.length - 1 ? M : K}" stroke="#f5f5f3" stroke-width="2"/>`; }).join('') +
        statement(cx - sw / 2, cy - sh / 2 - 8, sw) +
        t(cx, cy + sh / 2 + 22, '24h', { size: 14, weight: 600 }),
    ));
  })(),
  // D · sold: the gavel falls, the Statement goes to the top bidder.
  (() => {
    const sw = 96, sx = 22, sy = 24;
    const sh = statementH(sw);
    const gx = 70, gy = 222;
    const gavel = `<g transform="rotate(-28 ${gx} ${gy})">${r(gx - 26, gy - 30, 52, 20, K)}${r(gx - 3, gy - 12, 6, 44, K)}</g>` + r(gx - 30, 262, 60, 10, K);
    return fig(svg(
      statement(sx, sy, sw) + gavel +
        `<path d="M${sx + sw + 12} ${sy + sh / 2} C 230 ${sy + sh / 2}, 238 150, 238 196" fill="none" stroke="${K}" stroke-width="1.5"/>` +
        `<path d="M232 190 L238 197 L244 190" fill="none" stroke="${K}" stroke-width="1.5"/>` +
        r(214, 206, 48, 48, M),
    ));
  })(),
];


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


/* ================================================================ chapter 4: the OpenSea mark in cells */
const OS_BLUE = '#2081E2';
/// Pixel OpenSea mark: B blue circle, W white boat, '.' paper.
const OS8 = ['........', '..BBBB..', '.BBWBBB.', 'BBBWWBBB', 'BBWWWBBB', 'BWWWWBBB', 'BBBBWBBB', '.WWWWWW.', '..BBBB..', '........'];
const OS5 = ['.BBB.', 'BBWBB', 'BWWBB', 'BBBBB', '.WWW.'];
const osFill = (ch: string) => (ch === 'B' ? OS_BLUE : ch === 'W' ? '#fff' : EMPTY);

export const OPENSEA = {
  // 4B · the party sheet itself drawn as the OpenSea mark.
  // The whole sheet is OpenSea blue; the boat is white, one cell of mast joining sail to hull.
  sheet: fig(svg(partySheet((_, c, row) => (OS8[row][c] === 'W' ? '#fff' : OS_BLUE)))),
  // 4C · a small OpenSea mark as the source, one arrow, five slots just filled.
  source: (() => {
    // Shifted right so a 5×5 mark at the standard cell fits on the left.
    const x0 = 300 - 16 - SW, markW = 5 * PITCH - GAP, mx = 16, my = 150 - markW / 2;
    const mark = OS5.map((row, r) => [...row].map((ch, c) => (ch === '.' ? '' : cellSq(mx + c * PITCH, my + r * PITCH, osFill(ch)))).join('')).join('');
    return fig(svg(mark + arrow(mx + markW + 6, 150, x0 - 6, 150, K, LINE) + partySheet((i) => (i < 58 ? MID : i < 63 ? C : EMPTY), x0)));
  })(),
};
