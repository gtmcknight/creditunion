/// Statements listed on OpenSea, for the Buy half of /statements (lists.ts), where they share one list with the live
/// auctions, and a Statement's own page. Bought one at a time from the buyer's own wallet (a Seaport fill the Worker
/// asks OpenSea for; no Sweeper: Statements are dear, and one is a decision).
import type { Address, Hex } from 'viem';
import { chain, ensureChain, pub, session } from '../chain';
import { errText, eth, toast } from '../ui';

export type ForSale = { id: string; price: string; hash: string; protocol: string; seller: string; rating: number | null; format: number | null; pages?: number | null };
/// An overprinted Statement that isn't for sale.
export type Standing = { id: string; pages: number; rating: number | null; format: number | null };

/// Every Statement listed on OpenSea, cheapest listing per Statement.
export async function listings(): Promise<ForSale[]> {
  const r = await fetch('/market/statements.json');
  const d = (await r.json()) as { items?: ForSale[]; error?: string };
  if (!r.ok || !d.items) throw new Error(d.error ?? 'Listings unavailable.');
  return d.items;
}

/// The standing overprints (and how many there are), for when none are for sale.
export async function overprintsStanding(): Promise<{ items: Standing[]; total: number }> {
  const d = (await (await fetch('/statements/overprints.json')).json()) as { items?: Standing[]; total?: number };
  const items = d.items ?? [];
  return { items, total: d.total ?? items.length };
}

/// Paper stacked behind an overprinted Statement's drawing, an edge for each page past the first (five at most, so the
/// stack stays inside the grid's gap).
const stack = (pages: number) =>
  Array.from({ length: Math.min(pages, 6) - 1 }, (_, k) => `${(k + 1) * 3}px ${-(k + 1) * 3}px 0 0 #fff, ${(k + 1) * 3}px ${-(k + 1) * 3}px 0 1px rgba(0,0,0,.45)`).join(', ');
/// How far that paper reaches past the drawing's top right: the drawing shrinks by it, so drawing and paper together
/// keep a single Statement's spot.
const reach = (pages: number) => (Math.min(pages, 6) - 1) * 3;
/// The style attribute that stacks an overprint's pages behind it; nothing for a single page.
export const stackStyle = (pages: number) => (pages > 1 ? ` style="--stack:${stack(pages)};--reach:${reach(pages)}px"` : '');
export const OVERPRINTS = '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.25" stroke-linejoin="round" d="M8 2.2 14 5 8 7.8 2 5zM2 8.2l6 2.8 6-2.8M2 11.2 8 14l6-2.8"/></svg>';

/// Click once to see the price on the button, again to buy: a Statement is dear, so the second click is the decision.
/// OpenSea's signed order for this wallet, run first (a stale listing fails here, not in the wallet), then sent.
export async function buyListed(btn: HTMLButtonElement, x: ForSale, done: () => void) {
  if (!session.wallet || !session.account) return;
  if (!btn.dataset.armed) {
    btn.dataset.armed = '1';
    btn.textContent = `Buy for ${eth(BigInt(x.price))}`;
    return;
  }
  btn.disabled = true;
  btn.textContent = 'Buying…';
  try {
    await ensureChain();
    const r = await fetch('/market/statements/buy', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hash: x.hash, protocol: x.protocol, buyer: session.account }) });
    const tx = (await r.json()) as { to?: Address; data?: Hex; value?: string; error?: string };
    if (!r.ok || !tx.to || !tx.data || !tx.value) throw new Error(tx.error ?? 'That listing can’t be bought right now.');
    await pub.call({ account: session.account, to: tx.to, data: tx.data, value: BigInt(tx.value) });
    const hash = await session.wallet.sendTransaction({ account: session.account, chain, to: tx.to, data: tx.data, value: BigInt(tx.value) });
    toast('Submitted. Waiting for confirmation…', 'info');
    const receipt = await pub.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') throw new Error('The purchase reverted.');
    toast(`Statement #${x.id} is yours.`, 'ok');
    done();
  } catch (e) {
    toast(errText(e), 'err', 8000);
    btn.disabled = false;
    delete btn.dataset.armed;
    btn.textContent = 'Buy';
  }
}
