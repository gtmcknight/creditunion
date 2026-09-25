import { config } from './chain';
import { hasLayout, layoutSlot, type Summary } from './data';
import { describeFilter, inkName, maskInks } from './traits';
import { art, esc } from './ui';

/// Empty slots show a faded real Credit from the edition, so every sheet reads as a Statement in progress.
/// Hovering an empty slot opens a card: what the slot takes, how many Credits fit, and a few that do.

type Filter = Summary['filter'];

/// Edition art: mainnet ids render from the mainnet contract on any network.
export const editionArt = (id: bigint | number) => (config.chainId === 1 ? art(id) : `/art/mainnet/${id}.svg`);

const filters = new Map<string, Filter>();
/// Remember a batch's filter so `fillGhosts` can find it from the sheet's `data-batch`.
export const registerFilter = (address: string, f: Filter) => filters.set(address.toLowerCase(), f);

type Match = { count: number; sample: number[] };
const cache = new Map<string, Promise<Match>>();
/// How many edition Credits pass `f` (narrowed to `palettes`), and up to 80 of them spread across the edition.
function match(f: Filter, palettes: number) {
  const body = JSON.stringify({
    palettes,
    prints: f.prints,
    weights: f.weights,
    eights: f.eights,
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

type Slot = { i: number; want: number; f: Filter; fit: Match };
const slotOf = new WeakMap<Element, Slot>();

/// Fill every empty cell of every registered sheet under `root` with a faded example Credit.
export async function fillGhosts(root: ParentNode = document) {
  tip();
  await Promise.all([...root.querySelectorAll<HTMLElement>('.sheet[data-batch]')].map(fillSheet));
}

async function fillSheet(el: HTMLElement) {
  const f = filters.get(el.dataset.batch!.toLowerCase());
  if (!f) return;
  const cells = [...el.children] as HTMLElement[];
  const want = cells.map((_, i) => (hasLayout(f) ? layoutSlot(f, i) : 0));
  const empties = cells.map((c, i) => [c, i] as const).filter(([c]) => c.classList.contains('empty'));
  if (!empties.length) return;
  // The sheet shows a mix of whatever the batch accepts; each slot's own rule (a layout palette,
  // value v = set bit 1 << v) is fetched for the hover card.
  const keys = [...new Set([0, ...empties.map(([, i]) => want[i])])];
  const fits = new Map(await Promise.all(keys.map(async (k) => [k, await match(f, k ? 1 << k : f.palettes)] as const)));
  const pool = fits.get(0)!.sample;
  if (!pool.length) return;
  // Different batches with the same rules shouldn't look identical: start each at its own offset.
  const seed = parseInt(el.dataset.batch!.slice(2, 8), 16) || 0;
  empties.forEach(([c, i], n) => {
    c.className = 'cell ghost';
    c.removeAttribute('title');
    c.innerHTML = `<img src="${editionArt(pool[(seed + n) % pool.length])}" alt="" loading="lazy" decoding="async">`;
    slotOf.set(c, { i, want: want[i], f, fit: fits.get(want[i])! });
  });
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
    const cell = (e.target as Element).closest?.('.cell.ghost');
    const s = cell && slotOf.get(cell);
    if (!s) {
      if (shown) tipEl!.classList.remove('in');
      shown = null;
      return;
    }
    if (cell === shown) return;
    shown = cell;
    tipEl!.innerHTML = card(s);
    place(cell.getBoundingClientRect());
    tipEl!.classList.add('in');
  });
  addEventListener('scroll', () => {
    tipEl!.classList.remove('in');
    shown = null;
  }, { passive: true });
}

function card({ i, want, f, fit }: Slot) {
  const rules = describeFilter({ ...f, layout0: 0n, layout1: 0n });
  const takes = want
    ? `<span class="swatches">${maskInks(want).map((c) => `<i style="background:${c}"></i>`).join('')}</span>${inkName(want)} only`
    : rules
      ? 'Any Credit that fits'
      : 'Any Credit';
  const examples = fit.sample.filter((_, k) => k % Math.max(1, Math.floor(fit.sample.length / 4)) === 0).slice(0, 4);
  return `<p class="eyebrow">Slot ${i + 1} · open</p>
    <p class="takes">${takes}</p>
    ${rules ? `<p class="muted small">${esc(rules)}</p>` : ''}
    <p class="muted small"><span class="num">${fit.count.toLocaleString()}</span> Credits in the edition fit</p>
    ${examples.length ? `<div class="examples">${examples.map((id) => `<figure><span class="art"><img src="${editionArt(id)}" alt=""></span><figcaption class="num">#${id}</figcaption></figure>`).join('')}</div>` : ''}`;
}

/// Beside the cell, flipping to the other side or below when it would leave the viewport.
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
