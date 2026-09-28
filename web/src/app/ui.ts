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
  } = {},
) {
  const cells = Array.from({ length: 80 }, (_, i) => {
    const id = opts.placed ? (opts.placed[i] ?? undefined) : ids[i];
    if (id === undefined) {
      const g = opts.ghosts?.[i - ids.length];
      if (g?.src) return `<i class="cell ghost"><img src="${g.src}" alt="" loading="lazy" decoding="async"></i>`;
      return `<i class="cell empty"></i>`;
    }
    const mine = opts.mine?.has(id.toString()) ? ' mine' : '';
    const fresh = opts.fresh !== undefined && i >= opts.fresh ? ` new" style="--k:${i - opts.fresh}` : '';
    return `<i class="cell${mine}${fresh}" data-id="${id}"><img src="${art(id)}" alt="" loading="lazy" decoding="async"></i>`;
  });
  const cls = ['sheet', opts.size ?? 'lg', opts.closed && 'closed', opts.closing && 'closing'].filter(Boolean).join(' ');
  return `<div class="${cls}"${opts.batch ? ` data-batch="${opts.batch}"` : ''}>${cells.join('')}</div>`;
}

export function toast(msg: string, kind: 'ok' | 'err' | 'info' = 'info', ms = 5000) {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
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
/// datetime-local inputs for payment windows, read and written as UTC (their label says so).
export function toUtcInput(unix: number) {
  return new Date(unix * 1000).toISOString().slice(0, 16);
}
export function fromUtcInput(v: string) {
  const t = Date.parse(`${v}Z`);
  return Number.isFinite(t) ? Math.floor(t / 1000) : null;
}

/// A sub-nav item: a link (`href`, `current` marks the page) or a tab button (`attrs` carries its data-*).
export type SubTab = { label: string; href?: string; current?: boolean; attrs?: string };

/// Every section page opens the same way: the h1, one muted line, then a bar with sub-nav tabs on the left and
/// the page's controls on the right. `title` and `lede` are HTML; callers escape.
export function pageHead({ title, lede, tabs, tools, label = 'Sections' }: { title: string; lede?: string; tabs?: SubTab[]; tools?: string; label?: string }) {
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
  return `<header class="page-head"><h1>${title}</h1>${lede ? `<p class="page-lede">${lede}</p>` : ''}${bar}</header>`;
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
}
