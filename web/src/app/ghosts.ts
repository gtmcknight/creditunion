import type { Address } from 'viem';
import { config, session } from './chain';
import { hydrate, who } from './ens';
import { earlyShare, hasLayout, layoutSlot, sharePct as pct, type Summary } from './data';
import { describeFilter, inkName, maskInks } from './traits';
import { art, esc, same } from './ui';
import { ruleFor, slotName } from '../shared/layout';

/// Empty slots show a faded real Credit from the edition, so every sheet reads as a Statement in progress.
/// Hovering a slot opens a card: an empty one says what it takes and how many Credits in the edition could fill
/// it; a filled one says which Credit it is and who put it in.

type Filter = Summary['filter'];

/// Edition art: mainnet ids render from the mainnet contract on any network.
export const editionArt = (id: bigint | number) => (config.chainId === 1 ? art(id) : `/art/mainnet/${id}.svg`);

const filters = new Map<string, Filter>();
/// Who deposited each Credit and in what order, per party, for the hover card on filled slots.
const deposits = new Map<string, { by: Address; pos: number; early: boolean }>();
export function registerDeposits(ids: readonly bigint[], by: readonly Address[], early = false) {
  ids.forEach((id, i) => deposits.set(id.toString(), { by: by[i], pos: i + 1, early }));
}
/// A Picture union's recommended Credit for each slot (null: none for sale), so its open slots show the picture.
const plans = new Map<string, readonly (number | null)[]>();
export const planGhosts = (address: string, ids: readonly (number | null)[]) => plans.set(address.toLowerCase(), ids);

/// Remember a batch's filter so `fillGhosts` can find it from the sheet's `data-batch`.
export const registerFilter = (address: string, f: Filter) => filters.set(address.toLowerCase(), f);

type Match = { count: number; sample: number[] };
const cache = new Map<string, Promise<Match>>();
/// How many edition Credits pass `f` (narrowed to `palettes`), and up to 80 of them spread across the edition.
function match(f: Filter, palettes: number, extra: { eights?: number; prints?: number; weights?: number } = {}) {
  const body = JSON.stringify({
    palettes,
    prints: extra.prints ?? f.prints,
    weights: extra.weights ?? f.weights,
    eights: extra.eights ?? f.eights,
    idFrom: Number(f.idFrom),
    idTo: Number(f.idTo),
    minScore: f.minScore,
    maxScore: f.maxScore,
  });
  let p = cache.get(body);
  if (!p) {
    p = fetch('/edition/match', { method: 'POST', headers: { 'content-type': 'application/json' }, body })
      .then((r) => r.json() as Promise<Partial<Match>>)
      .then((d) => ({ count: d.count ?? 0, sample: d.sample ?? [] }))
      .catch(() => {
        cache.delete(body);
        return { count: 0, sample: [] };
      });
    cache.set(body, p);
  }
  return p;
}

/// Up to 80 edition Credits that pass a party's rules, spread across the edition.
export const examples = (f: Filter) => match(f, f.palettes).then((m) => m.sample);

type Slot = { i: number; want: number; f: Filter; fit: Match };
const slotOf = new WeakMap<Element, Slot>();

/// Fill every empty cell of every registered sheet under `root` with a faded example Credit.
export async function fillGhosts(root: ParentNode = document) {
  tip();
  await Promise.all([...root.querySelectorAll<HTMLElement>('.sheet[data-batch]')].map(fillSheet));
}

/// What fits each of a picture's open slots, for their hover cards, read after its Credits are drawn.
async function fitsFor(el: HTMLElement, f: Summary['filter'], cells: HTMLElement[], open: number[]) {
  const want = cells.map((_, i) => layoutSlot(f, i));
  const keys = [...new Set(open.map((i) => want[i]))];
  const fits = new Map(await Promise.all(keys.map(async (k) => [k, k ? await match(f, ruleFor(f.layoutTrait ?? 0, k).palettes ?? f.palettes, ruleFor(f.layoutTrait ?? 0, k)) : await match(f, f.palettes)] as const)));
  for (const i of open) if (cells[i].isConnected) slotOf.set(cells[i], { i, want: want[i], f, fit: fits.get(want[i])! });
}

async function fillSheet(el: HTMLElement) {
  const f = filters.get(el.dataset.batch!.toLowerCase());
  if (!f) return;
  const cells = [...el.children] as HTMLElement[];
  const want = cells.map((_, i) => (hasLayout(f) ? layoutSlot(f, i) : 0));
  const plan = plans.get(el.dataset.batch!.toLowerCase());
  // With a picture, every slot not yet filled takes its recommended Credit, placeholders included.
  const empties = cells.map((c, i) => [c, i] as const).filter(([c]) => (plan ? !c.dataset.id : c.classList.contains('empty')));
  if (!empties.length) return;
  // An Eights rule is what these Credits are about: keep their marks (the bottom row) on the placeholders too.
  el.classList.toggle('eights-rule', !!f.eights || (hasLayout(f) && f.layoutTrait === 1));
  // A picture's planned Credits go in at once, without waiting on what fits (that only feeds the hover cards):
  // the picture draws from them.
  if (plan && empties.every(([, i]) => plan[i] != null)) {
    empties.forEach(([c, i]) => {
      if (c.dataset.ghost === String(plan[i])) return;
      c.className = 'cell ghost planned';
      c.dataset.ghost = String(plan[i]);
      c.removeAttribute('title');
      c.innerHTML = `<img src="${editionArt(plan[i]!)}" alt="" loading="lazy" decoding="async">`;
    });
    el.dispatchEvent(new Event('ghosts', { bubbles: true }));
    void fitsFor(el, f, cells, empties.map(([, i]) => i));
    return;
  }
  // An Eights rule is what these Credits are about: keep their marks (the bottom row) on the placeholders too.
  el.classList.toggle('eights-rule', !!f.eights || (hasLayout(f) && f.layoutTrait === 1));
  // Each empty slot shows an example that fits it: a painted slot one of its own value, an open slot a mix
  // of whatever the batch accepts. The same rule feeds the hover card.
  const keys = [...new Set([0, ...empties.map(([, i]) => want[i])])];
  // A painted slot admits exactly the Credits with its value of the painted trait (on top of the party's rules).
  const slotFit = (k: number) => {
    if (!k) return match(f, f.palettes);
    const r = ruleFor(f.layoutTrait ?? 0, k);
    return match(f, r.palettes ?? f.palettes, r);
  };
  const fits = new Map(await Promise.all(keys.map(async (k) => [k, await slotFit(k)] as const)));
  const pool = fits.get(0)!.sample;
  if (!pool.length) return;
  // Different batches with the same rules shouldn't look identical: start each at its own offset.
  const seed = parseInt(el.dataset.batch!.slice(2, 8), 16) || 0;
  const used = new Map<number, number>();
  empties.forEach(([c, i]) => {
    const own = fits.get(want[i])!.sample;
    const from = own.length ? own : pool;
    const n = used.get(want[i]) ?? 0;
    used.set(want[i], n + 1);
    const id = plan?.[i] ?? from[(seed + n) % from.length];
    c.className = plan?.[i] ? 'cell ghost planned' : 'cell ghost';
    c.dataset.ghost = String(id);
    c.removeAttribute('title');
    c.innerHTML = `<img src="${editionArt(id)}" alt="" loading="lazy" decoding="async">`;
    slotOf.set(c, { i, want: want[i], f, fit: fits.get(want[i])! });
  });
  el.dispatchEvent(new Event('ghosts', { bubbles: true }));
}

// ---------------------------------------------------------------- hover card

let tipEl: HTMLElement | null = null;
function tip() {
  if (tipEl) return;
  tipEl = document.createElement('div');
  tipEl.className = 'slot-tip';
  tipEl.setAttribute('role', 'tooltip');
  document.body.append(tipEl);
  let shown: Element | null = null;
  document.addEventListener('pointerover', (e) => {
    // List cards are one link into the Credit Union: no per-cell cards there, only on its own page.
    const cell = (e.target as Element).closest?.('.card') ? null : (e.target as Element).closest?.('.cell.ghost, .cell[data-id]');
    const s = cell && slotOf.get(cell);
    const d = cell && !s ? deposits.get((cell as HTMLElement).dataset.id ?? '') : undefined;
    if (!cell || (!s && !d)) {
      if (shown) tipEl!.classList.remove('in');
      shown = null;
      return;
    }
    if (cell === shown) return;
    shown = cell;
    tipEl!.innerHTML = s ? card(s) : creditCard((cell as HTMLElement).dataset.id!, { rating: (cell as HTMLElement).dataset.rating, pos: d!.pos, early: d!.early, by: d!.by });
    tipEl!.classList.add('compact');
    hydrate(tipEl!);
    // A union sheet's cell zooms 1.2× on hover (style.css): place the card beside where it will end up.
    place(grown(cell as HTMLElement, cell.closest('.batch-art') && (cell as HTMLElement).dataset.id ? 1.2 : 1));
    tipEl!.classList.add('in');
  });
  addEventListener('scroll', () => {
    tipEl!.classList.remove('in');
    shown = null;
  }, { passive: true });
}

function card({ want, f, fit }: Slot) {
  // Two lines: what goes here, and how many could.
  const rules = describeFilter({ ...f, layout0: 0n, layout1: 0n });
  const trait = f.layoutTrait ?? 0;
  const takes = want
    ? trait === 0
      ? `<span class="swatches">${maskInks(want).map((c) => `<i style="background:${c}"></i>`).join('')}</span>${inkName(want)}${rules ? ` · ${esc(rules)}` : ''}`
      : `${slotName(trait, want)}${rules ? ` · ${esc(rules)}` : ''}`
    : rules
      ? esc(rules)
      : 'Any Credit';
  return `<p class="takes">${takes}</p>
    <p class="muted small"><span class="num">${fit.count.toLocaleString()}</span> can fill it</p>`;
}

const ordinal = (n: number) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`;

/// One Credit's hover card, the same wherever a Credit is hovered (the sheet's cells, your pickers): text only (the
/// hovered Credit itself zooms), its number and rating, where it sits in this union (and its early-bird share), and whose it is. One small size.
export function creditCard(id: string, o: { rating?: string; pos?: number; early?: boolean; by?: Address | null }) {
  const yours = !o.by || same(o.by, session.account);
  const where = o.pos ? `${ordinal(o.pos)} in${o.early ? ` · ${pct(earlyShare(o.pos - 1))} of the payout` : ''}` : '';
  return `<div class="filled credit-card">
    <div><p><span class="num">#${Number(id).toLocaleString()}</span>${o.rating ? ` <span class="muted">· rating ${o.rating}</span>` : ''}</p>
    ${where ? `<p class="muted">${where}</p>` : ''}
    <p class="muted">${yours ? 'Yours' : who(o.by!)}</p></div></div>`;
}

/// Beside the cell, flipping to the other side or below when it would leave the viewport.
const grown = (el: HTMLElement, k: number) => {
  const r = el.getBoundingClientRect();
  if (k === 1) return r;
  const w = el.offsetWidth * k, h = el.offsetHeight * k, cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  return new DOMRect(cx - w / 2, cy - h / 2, w, h);
};

function place(r: DOMRect) {
  const t = tipEl!;
  const w = t.offsetWidth, h = t.offsetHeight, pad = 12;
  let x = r.right + pad;
  if (x + w > innerWidth - pad) x = r.left - w - pad;
  if (x < pad) x = Math.min(Math.max(pad, r.left + r.width / 2 - w / 2), innerWidth - w - pad);
  let y = r.top + r.height / 2 - h / 2;
  y = Math.min(Math.max(pad, y), innerHeight - h - pad);
  t.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
}
