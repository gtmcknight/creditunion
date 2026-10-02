/// One Statement (/statement/123): Jack's drawing of it, who holds it, its Credit Rating and format as the contract
/// states them, the Credit Union that made it (if one did), its OpenSea price with Buy when it's listed, and the 80
/// Credits it was made from, in its own 8 × 10 order.
import { parseAbi, type Address } from 'viem';
import { config, pub, session } from '../chain';
import { listBatches, type Listed } from '../data';
import { hydrate, who } from '../ens';
import { connectToBuy } from '../forsale';
import { esc, eth, same, statementArt } from '../ui';
import { creditsHead, creditTiles } from './trait';
import { buyListed, type ForSale } from './statements';

const ABI = parseAbi([
  'function ownerOf(uint256) view returns (address)',
  'function creditScoreOf(uint256) view returns (uint256)',
  'function formatOf(uint256) view returns (uint8)',
  'function formatName(uint8) view returns (string)',
  'function overprintsOf(uint256) view returns (uint256)',
  'function overprintedWith(uint256) view returns (uint256[])',
  'function composedFrom(uint256) view returns (uint32[80])',
]);
const fact = (k: string, v: string) => `<div><dt>${k}</dt><dd>${v}</dd></div>`;

export async function statement(app: HTMLElement, raw: string, rerender: () => void) {
  const n = /^\d{1,7}$/.test(raw) ? Number(raw) : 0;
  const at = config.statements;
  if (!n || !at) {
    app.innerHTML = `<section class="prose"><h1>Statement not found</h1></section>`;
    return;
  }
  const id = BigInt(n);
  const read = <T,>(functionName: string, args: readonly unknown[] = [id]) => pub.readContract({ address: at, abi: ABI, functionName, args } as never).catch(() => null) as Promise<T | null>;
  const [owner, score, format, overprints, withPages, from, list, sale] = await Promise.all([
    read<Address>('ownerOf'),
    read<bigint>('creditScoreOf'),
    read<number>('formatOf'),
    read<bigint>('overprintsOf'),
    read<readonly bigint[]>('overprintedWith'),
    read<readonly number[]>('composedFrom'),
    listBatches().catch(() => [] as Listed[]),
    fetch('/market/statements.json').then((r) => r.json() as Promise<{ items?: ForSale[] }>).catch(() => ({}) as { items?: ForSale[] }),
  ]);
  const title = `Statement #${n.toLocaleString()}`;
  if (!owner) {
    app.innerHTML = `<div class="jb">${creditsHead('statement', `#${n}`)}</div><section class="prose"><h1>${title}</h1><p class="muted">Not made yet.</p></section>`;
    return;
  }
  const fname = format != null ? await read<string>('formatName', [format]) : null;
  const union = list.find((b) => b.s.statementId === id) ?? null;
  // At auction the union holds it; the high bidder takes it at settle.
  const atAuction = !!union && same(union.s.address, owner);
  const listing = sale.items?.find((x) => x.id === raw) ?? null;
  const mine = !!session.account && same(owner, session.account);
  const name = union ? esc(union.s.name || 'Untitled') : title;
  const os = `https://opensea.io/item/ethereum/${at.toLowerCase()}/${n}`;

  const facts = [
    fact('Owner', atAuction ? `<a href="/union/${union!.s.address}">At auction</a>` : `${who(owner, 'sm', true)}${mine ? ' <span class="tag you">You</span>' : ''}`),
    union ? fact('Made by', `<a href="/union/${union.s.address}">${esc(union.s.name || 'Untitled')}</a> <span class="muted">· a Credit Union</span>`) : '',
    score != null ? fact('Rating', `<span class="num">${Number(score / 10_000n).toLocaleString()}</span>`) : '',
    fname ? fact('Format', esc(fname)) : '',
    overprints ? fact('Overprints', `<span class="num">${overprints}</span>${withPages?.length ? ` <span class="muted">·</span> ${withPages.map((p) => `<a class="num" href="/statement/${p}">#${p}</a>`).join(' ')}` : ''}`) : '',
    fact('OpenSea', `<a href="${os}" target="_blank" rel="noopener">View ↗</a>`),
  ].join('');
  const buyBox = listing
    ? `<div class="st-buy st-buy-page"><strong class="num">${eth(BigInt(listing.price))}</strong>${mine ? '<span class="muted small">Yours</span>' : session.account ? `<button type="button" class="btn primary" data-buy>Buy</button>` : connectToBuy()}</div>`
    : atAuction
      ? `<a class="btn primary block" href="/union/${union!.s.address}">Bid at auction</a>`
      : '';

  app.innerHTML = `
  <div class="jb">${creditsHead('statement', `#${n}`)}</div>
  <section class="batch credit-page">
    <div class="credit-art st-page-art statement-host">${statementArt(id)}</div>
    <div class="batch-side">
      <header>${union ? `<h3 class="side-label">${title}</h3>` : ''}<h1>${name}</h1></header>
      <dl class="facts">${facts}</dl>
      ${buyBox}
    </div>
  </section>
  ${from?.some(Boolean) ? `<section class="st-from"><div class="section-head"><h3>Made from</h3><span class="muted num">80 Credits</span></div><div class="trait-grid">${creditTiles(from.map(Number))}</div></section>` : ''}`;
  hydrate(app);
  const btn = app.querySelector<HTMLButtonElement>('[data-buy]');
  if (btn && listing) btn.addEventListener('click', () => void buyListed(btn, listing, rerender));
}
