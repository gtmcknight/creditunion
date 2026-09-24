import { keccak256, toBytes, type Hex } from 'viem';
import type { Summary } from './data';

/// Trait values exactly as Jack's CreditArt.describe returns them.
const LETTERS = 'CMYK';
export const TRAITS = {
  colors: Array.from({ length: 15 }, (_, i) =>
    [...LETTERS].filter((_, b) => (i + 1) & (1 << b)).join(''),
  ),
  print: ['Registered', 'Nudge', 'Slip', 'Skew', 'Drift', 'Loose'],
  weight: ['even', 'lean', 'sparse', 'extreme'],
  eights: ['none', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight'],
} as const;

export const LABEL = { colors: 'Colors', print: 'Print', weight: 'Weight', eights: 'Eights' } as const;
export type TraitKey = keyof typeof TRAITS;

export const ZERO = `0x${'0'.repeat(64)}` as Hex;
export const hashTrait = (v: string): Hex => (v ? keccak256(toBytes(v)) : ZERO);

const reverse = new Map<string, string>();
for (const vals of Object.values(TRAITS)) for (const v of vals) reverse.set(keccak256(toBytes(v)), v);

/// "Colors CMY · Print Registered", or "" for an open batch.
export function describeFilter(f: Summary['filter']) {
  return (Object.keys(LABEL) as TraitKey[])
    .filter((k) => f[k] !== ZERO)
    .map((k) => `${LABEL[k]} ${reverse.get(f[k]) ?? 'custom'}`)
    .join(' · ');
}
