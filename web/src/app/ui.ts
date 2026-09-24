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

/// Art URL includes the Credits contract, so a new contract (testnets) never shows a browser-cached image.
export const art = (id: bigint | number) => `/art/${config.credits.toLowerCase()}/${id}.svg`;

/// 8×10 sheet on a hairline grid. Filled cells show the Credit; the rest are empty slots.
/// `closed`: no gaps, the 80 read as one image (a Statement). `closing`: animates to closed.
/// `fresh`: cells from this index on drop in, in order.
export function sheet(
  ids: readonly bigint[],
  opts: { mine?: Set<string>; size?: 'sm' | 'lg'; closed?: boolean; closing?: boolean; fresh?: number } = {},
) {
  const cells = Array.from({ length: 80 }, (_, i) => {
    const id = ids[i];
    if (id === undefined) return `<i class="cell empty"></i>`;
    const mine = opts.mine?.has(id.toString()) ? ' mine' : '';
    const fresh = opts.fresh !== undefined && i >= opts.fresh ? ` new" style="--k:${i - opts.fresh}` : '';
    return `<i class="cell${mine}${fresh}" title="Credit #${id}"><img src="${art(id)}" alt="" loading="lazy" decoding="async"></i>`;
  });
  const cls = ['sheet', opts.size ?? 'lg', opts.closed && 'closed', opts.closing && 'closing'].filter(Boolean).join(' ');
  return `<div class="${cls}">${cells.join('')}</div>`;
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
  return m.split('\n')[0];
}

const ERRORS: Record<string, string> = {
  TooFewToOpen: 'You need at least 10 Credits to open a batch.',
  WrongState: 'The batch is not in the right state for that.',
  NotDepositor: 'Only the depositor can withdraw that Credit.',
  Excluded: "That Credit doesn't match this batch's filter.",
  BidTooLow: 'Bid is below the minimum.',
  AuctionOver: 'The auction has ended.',
  AuctionRunning: 'The auction is still running.',
  NothingToClaim: 'Nothing to claim.',
  NameTooLong: 'Name is too long (64 bytes max).',
  BadDuration: 'Duration must be 3–90 days.',
  NoSpecifiedOrdersAvailable: 'None of those listings are available any more. Get a new price.',
  TooFewBought: 'Fewer listings were available than expected. Get a new price.',
  FeeNotCovered: 'Not enough ETH sent to cover the fee.',
  NotStray: 'That token is part of the batch.',
};

export type { Address };
