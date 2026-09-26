import { formatEther, type Address } from 'viem';
import { config } from './chain';

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
  if (/reverted with the following reason:\s*$/.test(m.split('\n').slice(0, 2).join(' ').trim())) return 'The network rejected it without a reason. Check your wallet is on Sepolia, refresh, and try again.';
  return m.split('\n')[0];
}

const ERRORS: Record<string, string> = {
  TooFewToOpen: 'Not enough Credits to open a credit union.',
  WrongState: 'The credit union is not in the right state for that.',
  WrongPhase: 'Not right now. Burning works only in the hour after the 5-minute countdown, and Credits can’t be withdrawn during that hour.',
  NotDepositor: 'Only the member who deposited it can withdraw that Credit.',
  Excluded: "That Credit doesn't match this credit union's rules.",
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
  NotStray: 'That token is part of the credit union.',
};

export type { Address };
