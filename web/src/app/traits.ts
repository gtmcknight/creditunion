import { slotName } from '../shared/layout';
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

const INK_NAMES = ['Cyan', 'Magenta', 'Yellow', 'Black'];
/// "Black", "Cyan + black" for a palette mask.
export const inkName = (m: number) => INK_NAMES.filter((_, b) => m & (1 << b)).join(' + ').replace(/ \+ (\w)/g, (_, c) => ` + ${c.toLowerCase()}`);

export type Rule = { label: string; value: string; swatch?: number; slots?: number[] };
/// A batch's rules one per row, for the batch page. `slots`: the sheet slots a row governs (all when absent).
export function filterRules(f: Summary['filter'], allowlistSize: number, slotOf: (i: number) => number): Rule[] {
  const rows: Rule[] = [];
  if (f.layout0 || f.layout1) {
    const by = new Map<number, number[]>();
    for (let i = 0; i < 80; i++) {
      const m = slotOf(i);
      if (m) by.set(m, [...(by.get(m) ?? []), i]);
    }
    const t = f.layoutTrait ?? 0;
    for (const [m, slots] of by)
      rows.push(t === 0 ? { label: `${inkName(m)} slots`, value: String(slots.length), swatch: m, slots } : { label: `${slotName(t, m)} slots`, value: String(slots.length), slots });
    const open = Array.from({ length: 80 }, (_, i) => i).filter((i) => !slotOf(i));
    if (open.length) rows.push({ label: 'Open slots', value: String(open.length), slots: open });
  }
  if (f.palettes) rows.push({ label: 'Palette', value: setLabels(f.palettes, TRAITS.colors, (l) => paletteBit(l)).join(', ') });
  if (f.prints) rows.push({ label: 'Print', value: setLabels(f.prints, TRAITS.print, (_, i) => i).join(', ') });
  if (f.weights) rows.push({ label: 'Weight', value: setLabels(f.weights, TRAITS.weight, (_, i) => i).join(', ') });
  if (f.eights) rows.push({ label: 'Eights', value: Array.from({ length: 32 }, (_, n) => n).filter((n) => f.eights & (1 << n)).join(', ') });
  if (f.paidFrom || f.paidTo) rows.push({ label: 'Paid', value: window(f.paidFrom, f.paidTo).replace(/^Paid /, '') });
  if (f.minScore || f.maxScore)
    rows.push(f.minScore && f.maxScore ? { label: 'Rating range', value: `${f.minScore / 10}–${f.maxScore / 10}` } : f.minScore ? { label: 'Min rating', value: `${f.minScore / 10}` } : { label: 'Max rating', value: `${f.maxScore / 10}` });
  if (f.idFrom || f.idTo) rows.push({ label: 'Credit #', value: f.idFrom && f.idTo ? `${f.idFrom}–${f.idTo}` : f.idFrom ? `${f.idFrom}+` : `up to ${f.idTo}` });
  if (allowlistSize) rows.push({ label: 'Listed', value: `${allowlistSize} Credits` });
  return rows;
}

/// "Palette C, K · Print Registered · Paid Sep 21, 3:05–3:06 PM · #1000–2000 · 80 listed", or "" for an open batch.
/// Ink colours for a palette mask, C=1 M=2 Y=4 K=8.
export const INK = ['#00aeef', '#ec008c', '#fff200', '#111111'] as const;
export const maskInks = (m: number) => INK.filter((_, b) => m & (1 << b));
export const maskLabel = (m: number) => [...'CMYK'].filter((_, b) => m & (1 << b)).join('') || 'Any';

export function describeFilter(f: Summary['filter'], allowlistSize = 0) {
  const parts: string[] = []; // a layout shows as the arrangement ('Order · Layout'), not as a rule
  if (f.palettes) parts.push(`Palette ${setLabels(f.palettes, TRAITS.colors, (l) => paletteBit(l)).join(', ')}`);
  if (f.prints) parts.push(`Print ${setLabels(f.prints, TRAITS.print, (_, i) => i).join(', ')}`);
  if (f.weights) parts.push(`Weight ${setLabels(f.weights, TRAITS.weight, (_, i) => i).join(', ')}`);
  if (f.eights) parts.push(`Eights ${Array.from({ length: 32 }, (_, n) => n).filter((n) => f.eights & (1 << n)).join(', ')}`);
  if (f.paidFrom || f.paidTo) parts.push(window(f.paidFrom, f.paidTo));
  if (f.minScore || f.maxScore) parts.push(f.minScore && f.maxScore ? `Rating ${f.minScore / 10}–${f.maxScore / 10}` : f.minScore ? `Rating ≥ ${f.minScore / 10}` : `Rating ≤ ${f.maxScore / 10}`);
  if (f.idFrom || f.idTo) parts.push(f.idFrom && f.idTo ? `#${f.idFrom}–${f.idTo}` : f.idFrom ? `#${f.idFrom}+` : `up to #${f.idTo}`);
  if (allowlistSize) parts.push(`${allowlistSize} listed`);
  return parts.join(' · ');
}
