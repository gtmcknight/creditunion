import { formatEther, type Address } from 'viem';
import { chain, config } from './chain';

export const $ = <T extends Element = HTMLElement>(s: string, root: ParentNode = document) => root.querySelector<T>(s)!;
export const $$ = <T extends Element = HTMLElement>(s: string, root: ParentNode = document) =>
  [...root.querySelectorAll<T>(s)];

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

export const short = (a?: string) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '');
export const same = (a?: string, b?: string) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

export function eth(wei: bigint, digits = 4) {
  const s = formatEther(wei);
  const [i, f = ''] = s.split('.');
  const frac = f.slice(0, digits).replace(/0+$/, '');
  return `${i}${frac ? '.' + frac : ''} ETH`;
}

export function until(ts: number) {
  let s = Math.max(0, ts - Math.floor(Date.now() / 1000));
  const d = Math.floor(s / 86400);
  s -= d * 86400;
  const h = Math.floor(s / 3600);
  s -= h * 3600;
  const m = Math.floor(s / 60);
  s -= m * 60;
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${String(m).padStart(2, '0')}m`;
  return `${m}m ${String(s).padStart(2, '0')}s`;
}

/// "4:12" to a timestamp; hours when it's that far out.
export function clock(ts: number) {
  const left = Math.max(0, Math.ceil(ts - Date.now() / 1000));
  const h = Math.floor(left / 3600), m = Math.floor((left % 3600) / 60), sec = String(left % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

/// Art URL includes the Credits contract, so a new contract (testnets) never shows a browser-cached image.
export const art = (id: bigint | number) => `/art/${config.credits.toLowerCase()}/${id}.svg`;

/// 8×10 sheet on a hairline grid. Filled cells show the Credit; the rest are empty slots.
/// `closed`: no gaps, the 80 read as one image (a Statement). `closing`: animates to closed.
/// `fresh`: cells from this index on drop in, in order.
/// Small ink dots for a palette mask, used for layout slots.

export function sheet(
  ids: readonly bigint[],
  opts: {
    mine?: Set<string>;
    size?: 'sm' | 'lg';
    closed?: boolean;
    closing?: boolean;
    fresh?: number;
    /// Credits shown faded after `ids`: previews of what could fill the rest, with their own art URLs.
    ghosts?: { id: bigint; src: string }[];
    /// Explicit slot → id placement (layout batches before the burn); overrides `ids` order.
    placed?: (bigint | null)[];
    /// Batch address: `fillGhosts` fills the empty slots with example Credits that fit.
    batch?: string;
    /// With `placed`: the Credit to show faded in each empty slot, by slot.
    slotGhosts?: ({ id: bigint; src: string } | null)[];
  } = {},
) {
  const cells = Array.from({ length: 80 }, (_, i) => {
    const id = opts.placed ? (opts.placed[i] ?? undefined) : ids[i];
    if (id === undefined) {
      const g = opts.placed ? opts.slotGhosts?.[i] : opts.ghosts?.[i - ids.length];
      if (g?.src) return `<i class="cell ghost"${g.id ? ` data-ghost="${g.id}"` : ''}><img src="${g.src}" alt="" loading="lazy" decoding="async"></i>`;
      return `<i class="cell empty"></i>`;
    }
    const mine = opts.mine?.has(id.toString()) ? ' mine' : '';
    const fresh = opts.fresh !== undefined && i >= opts.fresh ? ` new" style="--k:${i - opts.fresh}` : '';
    return `<i class="cell${mine}${fresh}" data-id="${id}"><img src="${art(id)}" alt="" loading="lazy" decoding="async"></i>`;
  });
  const cls = ['sheet', opts.size ?? 'lg', opts.closed && 'closed', opts.closing && 'closing'].filter(Boolean).join(' ');
  return `<div class="${cls}"${opts.batch ? ` data-batch="${opts.batch}"` : ''}>${cells.join('')}</div>`;
}

export function toast(msg: string, kind: 'ok' | 'err' | 'info' = 'info', ms = 5000, html = false) {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  if (html) el.innerHTML = msg;
  else el.textContent = msg;
  $('#toasts').append(el);
  requestAnimationFrame(() => el.classList.add('in'));
  setTimeout(() => {
    el.classList.remove('in');
    setTimeout(() => el.remove(), 250);
  }, ms);
}

/// Human message from a viem error: the contract's custom error name, or the wallet's short message.
export function errText(e: unknown): string {
  const err = e as { shortMessage?: string; message?: string; cause?: unknown; data?: { errorName?: string } };
  let c: unknown = err;
  while (c) {
    const x = c as { data?: { errorName?: string; args?: unknown[] }; cause?: unknown };
    if (x.data?.errorName) return ERRORS[x.data.errorName] ?? x.data.errorName;
    c = x.cause;
  }
  const m = err.shortMessage ?? err.message ?? String(e);
  if (/rejected|denied/i.test(m)) return 'Cancelled in wallet.';
  // The node's word for a sender who can't cover value plus gas.
  if (/OutOfFunds|insufficient funds|Transaction creation failed/i.test(`${m} ${err.message ?? ''}`)) return 'Not enough ETH in your wallet to cover this and gas.';
  // A revert with no reason usually means the wallet ran it somewhere else (wrong network, stale page).
  if (/reverted with the following reason:\s*$/.test(m.split('\n').slice(0, 2).join(' ').trim())) return `The network rejected it without a reason. Check your wallet is on ${chain.name}, refresh, and try again.`;
  return m.split('\n')[0];
}

const ERRORS: Record<string, string> = {
  TooFewToOpen: 'Not enough Credits to open a Credit Union.',
  WrongState: 'The Credit Union is not in the right state for that.',
  WrongPhase: 'Not right now. Burning works only in the hour after the 5-minute countdown, and Credits can’t be withdrawn during that hour.',
  NotDepositor: 'Only the member who deposited it can withdraw that Credit.',
  Excluded: "That Credit doesn't match this Credit Union's rules.",
  BidTooLow: 'Bid is below the minimum.',
  AuctionOver: 'The auction has ended.',
  AuctionRunning: 'The auction is still running.',
  NothingToClaim: 'Nothing to claim.',
  NoSlot: 'This painted sheet has no slot left for one of those Credits. Pick fewer of that kind.',
  ReserveTooLow: 'Reserve must be 0 or at least 0.01 ETH.',
  NameTooLong: 'Name is too long (64 bytes max).',
  BadDuration: 'Duration must be 3–90 days.',
  NoSpecifiedOrdersAvailable: 'None of those listings are available any more. Get a new price.',
  TooFewBought: 'Fewer listings were available than expected. Get a new price.',
  FeeNotCovered: 'Not enough ETH sent to cover the fee.',
  NotStray: 'That token is part of the Credit Union.',
  Underpaid: 'Not enough ETH sent for those listings.',
  NotAFWACredit: 'One of those FWA listings isn’t a Credit.',
  NoFWA: 'FWA listings can’t be bought here.',
  NoStrategy: 'CreditStrategy listings can’t be bought here.',
};

export type { Address };

/// Unix seconds ⇄ a datetime-local input's value ("2026-09-21T09:11"), in local time, to the minute.
/// Payment times read the same for everyone: UTC, 24-hour, as Jack's site shows them. (Auction clocks stay local.)
export const utc = (o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en-US', { ...o, timeZone: 'UTC', hourCycle: 'h23' });
export const sameUtcDay = (a: Date, b: Date) => a.toISOString().slice(0, 10) === b.toISOString().slice(0, 10);

/// Payment windows are shown and typed in UTC (as Jack's site) or the viewer's own time. The choice sticks.
type Zone = 'utc' | 'local';
let zone: Zone = 'utc';
try {
  if (localStorage.getItem('zone') === 'local') zone = 'local';
} catch {}
const utcZone = () => zone === 'utc';
/// A formatter in the chosen zone, 24-hour.
export const zoned = (o: Intl.DateTimeFormatOptions) =>
  new Intl.DateTimeFormat('en-US', { ...o, hourCycle: 'h23', ...(utcZone() ? { timeZone: 'UTC' } : {}) });
/// "UTC", or the local zone's short name ("EDT").
export const zoneName = () =>
  utcZone() ? 'UTC' : (new Intl.DateTimeFormat('en-US', { timeZoneName: 'short' }).formatToParts(new Date()).find((p) => p.type === 'timeZoneName')?.value ?? 'local');
export const sameZoneDay = (a: Date, b: Date) => {
  const d = zoned({ year: 'numeric', month: 'numeric', day: 'numeric' });
  return d.format(a) === d.format(b);
};
/// Unix seconds as "2026-09-20 22:15" in the chosen zone: what the Start and End boxes show and take back.
export function toTimeText(unix: number) {
  const d = new Date(unix * 1000);
  if (utcZone()) return d.toISOString().slice(0, 16).replace('T', ' ');
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
/// A typed time in the chosen zone: "2026-09-20 22:15", "9/20/2026 10:15 pm", "Sep 20 2026 22:15". Null if unreadable.
export function fromTimeText(v: string) {
  let s = v.trim().replace(/\s*(utc|gmt|z)$/i, '');
  if (!s) return null;
  if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(s)) s += ' 00:00'; // date alone: midnight, not the parser's UTC
  s = s.replace(/(\d)\s*([ap])\.?m?\.?$/i, '$1 $2m'); // "10:15pm", "10:15 p"
  // Read without a zone (as local), then take those same wall-clock numbers in the chosen zone. The box's own
  // format is read by hand: Safari's parser won't take "2026-09-20 22:15".
  const m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})$/);
  const d = m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) : new Date(s);
  if (!Number.isFinite(d.getTime())) return null;
  const t = utcZone() ? Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes()) : d.getTime();
  return Math.floor(t / 1000);
}
/// A time typed as far as its minutes ("…22:4" isn't yet): safe to apply while the box still has focus.
export const typedToMinute = (v: string) => /\d:\d\d\s*([ap]\.?m?\.?)?\s*(utc|gmt|z)?$/i.test(v.trim());
/// Under Start and End when a typed time fell outside the mint and was pulled in: say where the mint starts or ends.
export function mintEdgeNote(box: HTMLElement, t: number, first: number, end: number) {
  const note = box.querySelector<HTMLElement>('.win-note') ?? box.appendChild(Object.assign(document.createElement('p'), { className: 'win-note' }));
  const f = zoned({ month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  note.textContent = t < first ? `The mint started ${f.format(first * 1000)} ${zoneName()}` : t > end ? `The mint ended ${f.format(end * 1000)} ${zoneName()}` : '';
  note.hidden = !note.textContent;
}
/// The UTC · Local switch beside Start and End. Every open time view redraws on the 'zone' event.
export const zoneToggle = () =>
  `<span class="zone-toggle" role="group" aria-label="Time zone"><button type="button" data-zone="utc" aria-pressed="${utcZone()}">UTC</button><button type="button" data-zone="local" aria-pressed="${!utcZone()}">Local</button></span>`;
document.addEventListener('click', (ev) => {
  const b = (ev.target as HTMLElement).closest?.<HTMLButtonElement>('.zone-toggle [data-zone]');
  if (!b || b.dataset.zone === zone) return;
  zone = b.dataset.zone as Zone;
  try {
    localStorage.setItem('zone', zone);
  } catch {}
  document.querySelectorAll('.zone-toggle [data-zone]').forEach((x) => x.setAttribute('aria-pressed', String((x as HTMLElement).dataset.zone === zone)));
  document.dispatchEvent(new Event('zone'));
});

/// A sub-nav item: a link (`href`, `current` marks the page) or a tab button (`attrs` carries its data-*).
export type SubTab = { label: string; href?: string; current?: boolean; attrs?: string };

/// Every section page opens the same way: the h1, one muted line, then a bar with sub-nav tabs on the left and
/// the page's controls on the right. `title` and `lede` are HTML; callers escape.
/// `action`: the page's one call to action, to the right of the title and lede.
export function pageHead({ title, lede, tabs, tools, action, label = 'Sections', under }: { title: string; lede?: string; tabs?: SubTab[]; tools?: string; action?: string; label?: string; under?: string }) {
  const links = !!tabs?.[0]?.href;
  const items = (tabs ?? [])
    .map((t) =>
      t.href
        ? `<a href="${t.href}"${t.current ? ' aria-current="page"' : ''}>${t.label}</a>`
        : `<button type="button" role="tab" aria-selected="${!!t.current}"${t.attrs ? ' ' + t.attrs : ''}>${t.label}</button>`,
    )
    .join('');
  const nav = !tabs?.length ? '' : links ? `<nav class="subtabs" aria-label="${label}">${items}</nav>` : `<div class="subtabs" role="tablist" aria-label="${label}">${items}</div>`;
  const bar = nav || tools ? `<div class="page-bar">${nav}${tools ? `<div class="page-tools">${tools}</div>` : ''}</div>` : '';
  const words = `<h1>${title}</h1>${lede ? `<p class="page-lede">${lede}</p>` : ''}`;
  return `<header class="page-head">${action ? `<div class="page-top"><div>${words}</div><div class="page-action">${action}</div></div>` : words}${under ?? ''}${bar}</header>`;
}

/// Pickers fade at the bottom only when they scroll (`.overflows`); a short row of tiles gets no dead space.
/// Rechecked when a picker resizes or anything on the page changes (tiles arrive after the picker is drawn).
if (typeof document !== 'undefined') {
  const check = (el: Element) => {
    const pad = el.classList.contains('overflows') ? 21 : 0; // the extra bottom padding .overflows adds
    el.classList.toggle('overflows', el.scrollHeight - pad > el.clientHeight + 1);
  };
  const ro = new ResizeObserver((es) => es.forEach((e) => check(e.target)));
  const seen = new WeakSet<Element>();
  let queued = false;
  const scan = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      document.querySelectorAll('.picker').forEach((p) => {
        if (!seen.has(p)) {
          seen.add(p);
          ro.observe(p);
        }
        check(p);
      });
    });
  };
  new MutationObserver(scan).observe(document.documentElement, { childList: true, subtree: true });
  scan();
}

/// How many to buy: a slider from `min` to `max` with the count beside it. Drag, click the track or use the arrow
/// keys; `setRange` keeps the fill and the count in step when code moves it.
export const rangeHtml = (id: string, min: number, max: number, value: number, count = true) =>
  `<label class="sweep-range"><input type="range" id="${id}" min="${min}" max="${Math.max(min, max)}" step="1" value="${value}" aria-label="How many to buy">${count ? `<output for="${id}" class="num"></output>` : ''}</label>`;
export function setRange(el: HTMLInputElement, value?: number, max?: number) {
  if (max !== undefined) el.max = String(Math.max(Number(el.min), max));
  if (value !== undefined) el.value = String(value);
  const lo = Number(el.min), hi = Number(el.max), v = Number(el.value);
  el.style.setProperty('--p', `${hi > lo ? ((v - lo) / (hi - lo)) * 100 : 0}%`);
  const out = el.parentElement?.querySelector('output');
  if (out) out.textContent = String(v);
  el.disabled = hi <= lo && lo === 0;
}

/// Every modal opens through here: an × in the top right corner, and a click outside it (on the backdrop) closes
/// it. Both close with returnValue '' (the wallet picker reads that as "cancelled"); Esc already does.
export function openModal(d: HTMLDialogElement) {
  if (!d.querySelector(':scope > .dialog-x')) {
    d.insertAdjacentHTML(
      'afterbegin',
      '<button type="button" class="dialog-x" aria-label="Close"><svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg></button>',
    );
    d.querySelector('.dialog-x')!.addEventListener('click', () => d.close(''));
    // A press that starts and ends outside the box. Starting inside (selecting text, dragging) never closes it.
    let outside = false;
    const out = (e: PointerEvent) => {
      const r = d.getBoundingClientRect();
      return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
    };
    d.addEventListener('pointerdown', (e) => (outside = e.target === d && out(e)));
    d.addEventListener('pointerup', (e) => {
      if (outside && e.target === d && out(e)) d.close('');
      outside = false;
    });
  }
  d.returnValue = '';
  d.showModal();
  // The × takes the opening focus without a ring: nobody tabbed here. Tabbing still shows it.
  d.querySelector<HTMLElement>(':scope > .dialog-x')?.focus({ focusVisible: false } as FocusOptions);
}

/// "#45, #48 and #92333": Credit numbers in a sentence, the rest counted past `most`.
export function creditList(ids: (string | number)[], most = 3) {
  const n = ids.map((id) => `#${Number(id)}`); // no thousands commas: three numbers in a row read as one list
  if (n.length > most) return `${n.slice(0, most).join(', ')} and ${n.length - most} more`;
  return n.length > 1 ? `${n.slice(0, -1).join(', ')} and ${n[n.length - 1]}` : (n[0] ?? '');
}

/// A finished purchase: the Credits fanned like cards (up to four), and whose they are now.
export function boughtToast(ids: (string | number)[], note = '') {
  if (!ids.length) return toast(note || 'Nothing was bought.', 'info', 8000);
  const fan = ids
    .slice(0, 4)
    .map((id, i) => `<img src="${art(BigInt(id))}" alt="" style="--i:${i}">`)
    .join('');
  toast(
    `<div class="bought"><span class="bought-fan" style="--n:${Math.min(ids.length, 4)}">${fan}</span><span><b>Purchase successful</b><span>${creditList(ids)} ${ids.length === 1 ? 'is' : 'are'} now yours.${note ? ` ${esc(note)}` : ''}</span></span></div>`,
    'ok',
    9000,
    true,
  );
}
