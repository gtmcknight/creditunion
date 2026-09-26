/// Painted layouts: which trait a party's sheet is painted with, and what each slot value means.
/// Mirrors Batch.Filter.layoutTrait and Batch._keyOf: a slot value is 1 + the trait's value, 0 = any.

export const LAYOUT_TRAITS = ['Colors', 'Eights', 'Print', 'Weight', 'Plates'] as const;
export type LayoutTrait = 0 | 1 | 2 | 3 | 4;

const PRINTS = ['Registered', 'Nudge', 'Slip', 'Skew', 'Drift', 'Loose'];
const WEIGHTS = ['even', 'lean', 'sparse', 'extreme'];
const INK = ['#00b5e2', '#e4007c', '#ffd100', '#111111'];

/// Highest slot value each trait can take.
export const TOP: Record<LayoutTrait, number> = { 0: 15, 1: 9, 2: 6, 3: 4, 4: 4 };

/// The slot value a Credit has for `trait`, from its packed edition traits (edition-traits.bin:
/// palette = v & 15, print = (v >> 4) & 7, weight = (v >> 7) & 3, eights = (v >> 9) & 31).
export function keyOf(trait: number, packed: number): number {
  const palette = packed & 15;
  if (trait === 0) return palette;
  if (trait === 1) return Math.min(14, (packed >> 9) & 31) + 1;
  if (trait === 2) return ((packed >> 4) & 7) + 1;
  if (trait === 3) return ((packed >> 7) & 3) + 1;
  return [0, 1, 2, 3].filter((b) => palette & (1 << b)).length;
}

/// A slot value in words: "CM", "2 eights", "Nudge", "lean", "3 inks".
export function slotName(trait: number, v: number): string {
  if (!v) return 'Any';
  if (trait === 0) return [...'CMYK'].filter((_, b) => v & (1 << b)).join('');
  if (trait === 1) return v === 1 ? 'No eights' : `${v - 1} ${v === 2 ? 'eight' : 'eights'}`;
  if (trait === 2) return PRINTS[v - 1] ?? '?';
  if (trait === 3) return WEIGHTS[v - 1] ?? '?';
  return `${v} ${v === 1 ? 'ink' : 'inks'}`;
}

/// A slot value as a small mark: ink stripes for Colors, a short label for the rest.
export function slotMark(trait: number, v: number): string {
  if (!v) return '';
  if (trait === 0) return [0, 1, 2, 3].filter((b) => v & (1 << b)).map((b) => `<i style="background:${INK[b]}"></i>`).join('');
  if (trait === 1) return `<em>${v - 1}×8</em>`;
  if (trait === 4) return `<em>${v}</em>`;
  return `<em>${slotName(trait, v).slice(0, 3)}</em>`;
}

/// The rule (as Batch.Filter set bits) that admits exactly Credits with slot value `v` of `trait`.
export function ruleFor(trait: number, v: number): { palettes?: number; eights?: number; prints?: number; weights?: number } {
  if (trait === 0) return { palettes: 1 << v };
  if (trait === 1) return { eights: 1 << (v - 1) };
  if (trait === 2) return { prints: 1 << (v - 1) };
  if (trait === 3) return { weights: 1 << (v - 1) };
  let palettes = 0;
  for (let m = 1; m < 16; m++) if ([0, 1, 2, 3].filter((b) => m & (1 << b)).length === v) palettes |= 1 << m;
  return { palettes };
}
