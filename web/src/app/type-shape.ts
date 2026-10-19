/// Balance's shaping, the same rule the font file runs as OpenType: each word picks one of S printings per
/// letter. Left to right, a letter's state is the state before it stepped through that letter's `next`; right to left,
/// its printing mixes its state with the printing of the letter after it. A word starts fresh after anything that
/// isn't a letter in the font (a space, a line break), so a word prints the same wherever it appears.
export type TypeData = { S: number; start: number; glyphs: Record<string, { px: [number, number][]; variants: number[][]; next: number[] }> };

function mix(n: number, k: number, code: number, S: number) {
  let h = 2166136261;
  for (const v of [n, k, code]) {
    h = Math.imul((h ^ v) >>> 0, 16777619) >>> 0;
    h = (h ^ (h >>> 15)) >>> 0;
  }
  return h % S;
}

/// The printing of every character in `text` (already upper-cased), or -1 for one with nothing to print.
export function shape(text: string, D: TypeData): number[] {
  const out = new Array<number>(text.length).fill(-1);
  const inWord = (c: string) => c !== ' ' && c in D.glyphs;
  for (let i = 0; i < text.length; ) {
    if (!inWord(text[i])) {
      i++;
      continue;
    }
    let j = i;
    const state: number[] = [];
    for (let n = D.start; j < text.length && inWord(text[j]); j++) state.push(n), (n = D.glyphs[text[j]].next[n]);
    for (let p = j - 1, k = D.S; p >= i; p--) k = out[p] = mix(state[p - i], k, text.charCodeAt(p), D.S);
    i = j;
  }
  return out;
}

/// The ink of every pixel of every character, printed a word at a time: the word's lit cells in row order across its
/// letters, shuffled by a hash of the word, then dealt out cyan, magenta, yellow, black in four even shares. Each entry follows that glyph's `px` order; null for nothing to print.
export function printWords(text: string, D: TypeData): (number[] | null)[] {
  const out: (number[] | null)[] = new Array(text.length).fill(null);
  const inWord = (c: string) => c !== ' ' && c in D.glyphs && D.glyphs[c].px.length > 0;
  for (let i = 0; i < text.length; ) {
    if (!inWord(text[i])) {
      i++;
      continue;
    }
    let j = i;
    while (j < text.length && inWord(text[j])) j++;
    const word = text.slice(i, j);
    // Lit cells, row by row across the whole word, each remembered as [letter, index into its px].
    const cells: [number, number][] = [];
    const rows = Math.max(...[...word].map((c) => Math.max(...D.glyphs[c].px.map(([, y]) => y)))) + 1;
    for (let y = 0; y < rows; y++)
      for (let l = 0; l < word.length; l++)
        D.glyphs[word[l]].px.map(([x, py], p) => [x, py, p] as const).filter(([, py]) => py === y).sort((a, b) => a[0] - b[0]).forEach(([, , p]) => cells.push([l, p]));
    const n = cells.length;
    const order = new Uint32Array(n).map((_, k) => k);
    let s = 2166136261;
    for (let k = 0; k < word.length; k++) s = Math.imul(s ^ word.charCodeAt(k), 16777619) >>> 0;
    if (s === 0) s = 0x9e3779b9;
    for (let rem = n; rem > 1; rem--) {
      s = (s ^ (s << 13)) >>> 0;
      s = (s ^ (s >>> 17)) >>> 0;
      s = (s ^ (s << 5)) >>> 0;
      const r = s % rem;
      [order[rem - 1], order[r]] = [order[r], order[rem - 1]];
    }
    // Four even shares, the remainder going to cyan first, then magenta, then yellow.
    const share = [0, 1, 2, 3].map((c) => Math.floor(n / 4) + (c < n % 4 ? 1 : 0));
    const cm = share[0] + share[1], cmy = cm + share[2];
    for (let l = 0; l < word.length; l++) out[i + l] = new Array(D.glyphs[word[l]].px.length).fill(3);
    cells.forEach(([l, p], k) => (out[i + l]![p] = order[k] < share[0] ? 0 : order[k] < cm ? 1 : order[k] < cmy ? 2 : 3));
    i = j;
  }
  return out;
}
