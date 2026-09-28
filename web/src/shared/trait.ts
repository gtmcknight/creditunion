/// Trait pages (/palette/CMYK, /eights/3, /print/slip, /weight/sparse): which trait a path names, and its value.
/// `trait` and `v` are the painted-layout encoding (shared/layout.ts), so ruleFor(trait, v) is the page's rule.
import { ruleFor } from './layout';

/// How many eights a Credit has, in words: "No eights", "One eight", "Five eights". Lowercase for use mid-sentence.
const EIGHT_WORDS = ['No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten'];
export const eightsName = (n: number, lower = false) => {
  const w = `${EIGHT_WORDS[n] ?? n} ${n === 1 ? 'eight' : 'eights'}`;
  return lower ? w.toLowerCase() : w;
};

export const TRAIT_KINDS = ['palette', 'eights', 'print', 'weight'] as const;
export type TraitKind = (typeof TRAIT_KINDS)[number];

const PRINTS = ['Registered', 'Nudge', 'Slip', 'Skew', 'Drift', 'Loose'];
const WEIGHTS = ['even', 'lean', 'sparse', 'extreme'];
export const EIGHTS_TOP = 5; // the most eights any Credit in the edition has

export type TraitValue = {
  kind: TraitKind;
  label: string; // "Weight"
  name: string; // "Sparse", "3×8", "No eights", "CMYK", "Registered"
  slug: string; // canonical URL value: "sparse", "3", "CMYK", "registered"
  trait: number; // layout trait: 0 Colors, 1 Eights, 2 Print, 3 Weight
  v: number; // slot value: 1 + the trait's value (the palette mask for Colors)
  rules: ReturnType<typeof ruleFor>;
};

const LABEL: Record<TraitKind, string> = { palette: 'Palette', eights: 'Eights', print: 'Print', weight: 'Weight' };

/// The value a path segment names, or null when it isn't one.
export function parseTrait(kind: string, raw: string): TraitValue | null {
  if (!(TRAIT_KINDS as readonly string[]).includes(kind)) return null;
  const k = kind as TraitKind;
  const s = decodeURIComponent(raw ?? '').trim();
  const make = (name: string, slug: string, trait: number, v: number): TraitValue => ({ kind: k, label: LABEL[k], name, slug, trait, v, rules: ruleFor(trait, v) });
  if (k === 'palette') {
    const up = s.toUpperCase();
    if (!/^[CMYK]{1,4}$/.test(up) || new Set(up).size !== up.length) return null;
    const mask = [...'CMYK'].reduce((m, ch, b) => (up.includes(ch) ? m | (1 << b) : m), 0);
    const name = [...'CMYK'].filter((ch) => up.includes(ch)).join('');
    return make(name, name, 0, mask);
  }
  if (k === 'eights') {
    if (!/^\d{1,2}$/.test(s) || Number(s) > EIGHTS_TOP) return null;
    const n = Number(s);
    return make(eightsName(n), String(n), 1, n + 1);
  }
  const list = k === 'print' ? PRINTS : WEIGHTS;
  const i = list.findIndex((x) => x.toLowerCase() === s.toLowerCase());
  if (i < 0) return null;
  const name = list[i].charAt(0).toUpperCase() + list[i].slice(1);
  return make(name, list[i].toLowerCase(), k === 'print' ? 2 : 3, i + 1);
}

export const traitPath = (t: TraitValue) => `/${t.kind}/${t.slug}`;

/// The page for slot value `v` of layout trait `trait` (1 + the value; the mask for Colors). Plates, an ink
/// count, has no page of its own: the Palette index.
export function slotPath(trait: number, v: number): string {
  const kind = TRAIT_KINDS[trait];
  if (!kind) return '/palette';
  const raw = trait === 0 ? [...'CMYK'].filter((_, b) => v & (1 << b)).join('') : trait === 1 ? String(v - 1) : ((trait === 2 ? PRINTS : WEIGHTS)[v - 1] ?? '');
  const t = parseTrait(kind, raw);
  return t ? traitPath(t) : `/${kind}`;
}

/// The page for a rule's set (contract bits: palettes by mask, the rest by index): the value's page when the set
/// is one value, else the trait's index.
export function setPath(kind: TraitKind, set: number): string {
  const on = Array.from({ length: 16 }, (_, i) => i).filter((i) => set & (1 << i));
  if (on.length !== 1) return `/${kind}`;
  return kind === 'palette' ? slotPath(0, on[0]) : slotPath(TRAIT_KINDS.indexOf(kind), on[0] + 1);
}

/// The range pages for a window; 0 on either side leaves that side open.
export const ratingPath = (min: number, max: number) => `/rating?${[min ? `min=${(min / 10).toFixed(1)}` : '', max ? `max=${(max / 10).toFixed(1)}` : ''].filter(Boolean).join('&')}`;
export const bitsPath = (min: number, max: number) => `/bits?${[min ? `min=${min}` : '', max ? `max=${max}` : ''].filter(Boolean).join('&')}`;
export const timePath = (from: number, to: number) => `/time?from=${from || 1}&to=${to || 4_294_967_295}`;
