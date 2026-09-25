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

const utc = (t: number) => {
  const d = new Date(t * 1000);
  return `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' })} ${d.toISOString().slice(11, 16)} UTC`;
};

/// "Colors CMY · Paid Sep 21 13:49–13:50 UTC · #1000–2000 · 80 listed", or "" for an open batch.
export function describeFilter(f: Summary['filter'], allowlistSize = 0) {
  const parts = (Object.keys(LABEL) as TraitKey[])
    .filter((k) => f[k] !== ZERO)
    .map((k) => `${LABEL[k]} ${reverse.get(f[k]) ?? 'custom'}`);
  if (f.paidFrom || f.paidTo) {
    parts.push(
      f.paidFrom && f.paidTo ? `Paid ${utc(f.paidFrom)}–${utc(f.paidTo).replace(/^.* (\d\d:\d\d UTC)$/, '$1')}` : f.paidFrom ? `Paid after ${utc(f.paidFrom)}` : `Paid before ${utc(f.paidTo)}`,
    );
  }
  if (f.idFrom || f.idTo) parts.push(f.idFrom && f.idTo ? `#${f.idFrom}–${f.idTo}` : f.idFrom ? `#${f.idFrom}+` : `up to #${f.idTo}`);
  if (allowlistSize) parts.push(`${allowlistSize} listed`);
  return parts.join(' · ');
}
