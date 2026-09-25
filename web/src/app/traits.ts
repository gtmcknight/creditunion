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
/// The label a filter hash stands for, if it is one of the known trait values.
export const traitLabel = (hash: string) => reverse.get(hash as Hex);

const dayTime = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const timeOnly = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
/// "Sep 21, 3:05–3:06 PM" in the viewer's own time zone; the window's end is shown as the next minute.
function window(from: number, to: number) {
  if (from && to) {
    const a = new Date(from * 1000), b = new Date((to + 1) * 1000);
    return `Paid ${dayTime.format(a)}–${a.toDateString() === b.toDateString() ? timeOnly.format(b) : dayTime.format(b)}`;
  }
  return from ? `Paid after ${dayTime.format(new Date(from * 1000))}` : `Paid before ${dayTime.format(new Date((to + 1) * 1000))}`;
}

/// "Colors CMY · Paid Sep 21 13:49–13:50 UTC · #1000–2000 · 80 listed", or "" for an open batch.
export function describeFilter(f: Summary['filter'], allowlistSize = 0) {
  const parts = (Object.keys(LABEL) as TraitKey[])
    .filter((k) => f[k] !== ZERO)
    .map((k) => `${LABEL[k]} ${reverse.get(f[k]) ?? 'custom'}`);
  if (f.paidFrom || f.paidTo) parts.push(window(f.paidFrom, f.paidTo));
  if (f.idFrom || f.idTo) parts.push(f.idFrom && f.idTo ? `#${f.idFrom}–${f.idTo}` : f.idFrom ? `#${f.idFrom}+` : `up to #${f.idTo}`);
  if (allowlistSize) parts.push(`${allowlistSize} listed`);
  return parts.join(' · ');
}
