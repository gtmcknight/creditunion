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

/// Bit for a palette string ("CMY" → 7); the set bit is 1 << that.
export const paletteBit = (p: string) => [...'CMYK'].reduce((m, ch, b) => (p.includes(ch) ? m | (1 << b) : m), 0);
/// Labels a set selects, in display order.
export const setLabels = (mask: number, labels: readonly string[], bitOf: (label: string, i: number) => number) =>
  labels.filter((l, i) => mask & (1 << bitOf(l, i)));

/// "Palette C, K · Print Registered · Paid Sep 21, 3:05–3:06 PM · #1000–2000 · 80 listed", or "" for an open batch.
export function describeFilter(f: Summary['filter'], allowlistSize = 0) {
  const parts: string[] = [];
  if (f.palettes) parts.push(`Palette ${setLabels(f.palettes, TRAITS.colors, (l) => paletteBit(l)).join(', ')}`);
  if (f.prints) parts.push(`Print ${setLabels(f.prints, TRAITS.print, (_, i) => i).join(', ')}`);
  if (f.weights) parts.push(`Weight ${setLabels(f.weights, TRAITS.weight, (_, i) => i).join(', ')}`);
  if (f.eights) parts.push(`Eights ${Array.from({ length: 32 }, (_, n) => n).filter((n) => f.eights & (1 << n)).join(', ')}`);
  if (f.paidFrom || f.paidTo) parts.push(window(f.paidFrom, f.paidTo));
  if (f.idFrom || f.idTo) parts.push(f.idFrom && f.idTo ? `#${f.idFrom}–${f.idTo}` : f.idFrom ? `#${f.idFrom}+` : `up to #${f.idTo}`);
  if (allowlistSize) parts.push(`${allowlistSize} listed`);
  return parts.join(' · ');
}
