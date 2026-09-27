/// Trait glyphs shared by the create page and Credit pages: palette swatch, print plates, weight coverage, eights die.
const INKS: Record<string, string> = { C: '#00B5E2', M: '#E4007C', Y: '#FFD100', K: '#111111' };

export const swatch = (p: string) => {
  const inks = [...p].map((ch) => INKS[ch]);
  const stops = inks.map((c, i) => `${c} ${(i / inks.length) * 100}% ${((i + 1) / inks.length) * 100}%`).join(', ');
  return `<i class="ink" style="background:linear-gradient(90deg, ${stops})"></i>`;
};

/// A plate stack: Registered is one square; each misprint kind pushes plates further out of register.
export const printGlyph = (name: string) => {
  const offsets: Record<string, [number, number][]> = {
    Registered: [],
    Nudge: [[1, 0]],
    Slip: [[1.5, 0], [0, 1.5]],
    Skew: [[1.5, 0], [-1.5, 1], [0, -1.5]],
    Drift: [[3, 0], [0, 3]],
    Loose: [[3, 1], [-2, 3], [1, -3], [-3, -1]],
  };
  const plates = ['#00B5E2', '#E4007C', '#FFD100', '#111111'];
  const ghosts = (offsets[name] ?? []).map(([x, y], i) => `<rect x="${4 + x}" y="${4 + y}" width="16" height="16" fill="${plates[i]}" opacity=".85"/>`).join('');
  return `<svg viewBox="0 0 24 24" aria-hidden="true">${ghosts}<rect x="4" y="4" width="16" height="16" fill="${offsets[name]?.length ? 'none' : '#111'}" stroke="#111" stroke-width="1.4"/></svg>`;
};

/// Weight as ink coverage: a 6×6 print with even about half inked, lean and sparse lighter, extreme nearly full.
const WEIGHT_FILL: Record<string, number> = { even: 18, lean: 12, sparse: 6, extreme: 33 };
const WEIGHT_ORDER = [14, 21, 3, 28, 9, 34, 0, 17, 25, 6, 31, 12, 19, 1, 26, 8, 33, 15, 22, 4, 29, 10, 35, 2, 18, 27, 7, 32, 13, 20, 5, 24, 11, 30, 16, 23];
export const weightGlyph = (name: string) =>
  `<svg viewBox="0 0 24 24" aria-hidden="true">${WEIGHT_ORDER.slice(0, WEIGHT_FILL[name] ?? 0)
    .map((k) => `<rect x="${3 + (k % 6) * 3}" y="${3 + Math.floor(k / 6) * 3}" width="3" height="3" fill="#111"/>`)
    .join('')}<rect x="3" y="3" width="18" height="18" fill="none" stroke="#111" stroke-opacity=".25" stroke-width=".6"/></svg>`;

/// The eights tile in miniature: a die face with one dot per 8, laid out like the tile's pips.
const DICE: Record<number, [number, number][]> = { 0: [], 1: [[1, 1]], 2: [[0, 0], [2, 2]], 3: [[0, 0], [1, 1], [2, 2]], 4: [[0, 0], [2, 0], [0, 2], [2, 2]], 5: [[0, 0], [2, 0], [1, 1], [0, 2], [2, 2]] };
export const dice = (n: number) =>
  `<svg viewBox="0 0 24 24" aria-hidden="true">${(DICE[n] ?? []).map(([x, y]) => `<circle cx="${6 + x * 6}" cy="${6 + y * 6}" r="2.2" fill="#111"/>`).join('')}</svg>`;
