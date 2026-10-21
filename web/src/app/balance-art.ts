/// A BALANCE amount drawn the way Jack's Balance previews draw it: a 7×9 pixel font (8 to the advance, the comma one
/// row lower), each pixel of the number one ink, the inks in the palette's proportions. Until his contract is live this
/// is our drawing of his announced design; after, a wallet's own artwork comes from his contract.
import { INK } from './traits';

const G: Record<string, string[]> = {
  '0': ['.#####.', '##...##', '##...##', '##..###', '##.#.##', '###..##', '##...##', '##...##', '.#####.'],
  '1': ['...##..', '..###..', '.####..', '...##..', '...##..', '...##..', '...##..', '...##..', '.#####.'],
  '2': ['.#####.', '##...##', '.....##', '.....##', '...###.', '..##...', '.##....', '##.....', '#######'],
  '3': ['.#####.', '##...##', '.....##', '.....##', '..####.', '.....##', '.....##', '##...##', '.#####.'],
  '4': ['....##.', '...###.', '..####.', '.##.##.', '##..##.', '#######', '....##.', '....##.', '....##.'],
  '5': ['#######', '##.....', '##.....', '##.....', '######.', '.....##', '.....##', '##...##', '.#####.'],
  '6': ['..####.', '.##....', '##.....', '##.....', '######.', '##...##', '##...##', '##...##', '.#####.'],
  '7': ['#######', '.....##', '.....##', '....##.', '...##..', '..##...', '..##...', '..##...', '..##...'],
  '8': ['.#####.', '##...##', '##...##', '##...##', '.#####.', '##...##', '##...##', '##...##', '.#####.'],
  ',': ['.......', '.......', '.......', '.......', '.......', '.......', '.......', '...##..', '...##..', '..##...'],
  '.': ['.......', '.......', '.......', '.......', '.......', '.......', '.......', '...##..', '...##..'],
};
G['9'] = [...G['6']].reverse().map((r) => [...r].reverse().join(''));

/// Ink shares, C M Y K, summing to 1 (or all 0: the number draws in the page's text color).
export type Palette = [number, number, number, number];
export const PURE: Palette[] = [
  [1, 0, 0, 0],
  [0, 1, 0, 0],
  [0, 0, 1, 0],
  [0, 0, 0, 1],
];

/// A palette in Jack's notation: C100, M63.7 K36.3.
export const paletteName = (p: Palette) =>
  p
    .map((v, k) => [v, k] as const)
    .filter(([v]) => v > 0.0005)
    .map(([v, k]) => `${'CMYK'[k]}${Math.round(v * 1000) / 10}`)
    .join(' ');

/// Largest-remainder counts of `n` pixels by share.
function counts(n: number, p: Palette): number[] {
  const raw = p.map((v) => v * n);
  const base = raw.map(Math.floor);
  let left = n - base.reduce((a, b) => a + b, 0);
  const order = raw.map((v, k) => [v - base[k], k] as const).sort((a, b) => b[0] - a[0]);
  for (const [, k] of order) if (left-- > 0) base[k]++;
  return base;
}

/// A small seeded shuffle, so the same number in the same palette always draws the same way.
function shuffle<T>(xs: T[], seed: number): T[] {
  let s = seed >>> 0 || 1;
  for (let i = xs.length - 1; i > 0; i--) {
    s = (s * 1664525 + 1013904223) >>> 0;
    const j = s % (i + 1);
    [xs[i], xs[j]] = [xs[j], xs[i]];
  }
  return xs;
}

/// The number as an SVG: one square per lit pixel, `unit` px each. `inks`: Jack's, unless a page draws one differently
/// (black as the text color, say, off his white paper).
export function balanceSvg(text: string, p: Palette, unit = 4, label = text, inks: readonly string[] = INK): string {
  const px: [number, number][] = [];
  [...text].forEach((ch, i) => (G[ch] ?? []).forEach((row, y) => [...row].forEach((v, x) => v === '#' && px.push([i * 8 + x, y]))));
  const w = Math.max(1, text.length * 8 - 1);
  const h = 10;
  const total = p.reduce((a, b) => a + b, 0);
  let fills: string[];
  if (!total) fills = px.map(() => 'currentColor');
  else {
    const c = counts(px.length, p.map((v) => v / total) as Palette);
    fills = shuffle(c.flatMap((n, k) => Array<string>(n).fill(inks[k])), [...text].reduce((a, ch) => a * 31 + ch.charCodeAt(0), 7) ^ Math.round(p[0] * 97 + p[1] * 89 + p[2] * 83 + p[3] * 79));
  }
  const rects = px.map(([x, y], i) => `<rect x="${x}" y="${y}" width="1" height="1" fill="${fills[i]}"/>`).join('');
  return `<svg class="balance-num" viewBox="0 0 ${w} ${h}" width="${w * unit}" height="${h * unit}" shape-rendering="crispEdges" role="img" aria-label="${label}">${rects}</svg>`;
}
