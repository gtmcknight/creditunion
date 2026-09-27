import type { Address } from 'viem';
import { dice, printGlyph, swatch, weightGlyph } from '../glyphs';
/// A trait value with the same glyph the create page uses for it, linking to its trait page.
const traitChip = (href: string, g: string, l: string) => `<a class="vchip" href="${href}">${g}<span>${l}</span></a>`;
import { creditsAbi, factoryAbi } from '../abi';
import { config, pub, session } from '../chain';
import { getBatch, listBatches, ratings, type Listed, type Rated } from '../data';
import { hydrate, who } from '../ens';
import { fitIds, weightOf } from '../fit';
import { fillGhosts } from '../ghosts';
import { maskInks, paletteBit } from '../traits';
import { art, esc, eth, same } from '../ui';
import { card } from './lists';

/// Credits ever minted: the same numbers on every network.
const SUPPLY = 122_154;
const fmtScore = (s: number) => (Math.floor(s * 100) / 100).toFixed(2);
const paid = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit' });
/// /rating around a score: a point either side, in the Rating rule's tenths.
const ratingBand = (s: number) => {
  const t = Math.round(s * 10);
  return `/rating?min=${(Math.max(800, t - 10) / 10).toFixed(1)}&max=${(Math.min(8000, t + 10) / 10).toFixed(1)}`;
};
const fact = (k: string, v: string) => `<div><dt>${k}</dt><dd>${v}</dd></div>`;
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/// One Credit: its art and traits, who holds it (or which Credit Union it's in), the open Credit Unions it fits,
/// and its OpenSea price when it's listed.
export async function credit(app: HTMLElement, raw: string) {
  const n = /^\d{1,6}$/.test(raw) ? Number(raw) : 0;
  if (n < 1 || n > SUPPLY) {
    app.innerHTML = `<section class="prose"><h1>Credit not found</h1><p>Credits are numbered 1 to ${SUPPLY.toLocaleString()}.</p></section>`;
    return;
  }
  const id = BigInt(n);
  const [seed, owner, rated, list] = await Promise.all([
    pub.readContract({ address: config.credits, abi: creditsAbi, functionName: 'seedOf', args: [id] }).catch(() => null),
    pub.readContract({ address: config.credits, abi: creditsAbi, functionName: 'ownerOf', args: [id] }).catch(() => null) as Promise<Address | null>,
    ratings([id]).then((r) => ({ r: r.ratings[raw] as Rated | undefined, n: r.n })).catch(() => ({ r: undefined, n: 0 })),
    listBatches().catch(() => [] as Listed[]),
  ]);
  const title = `Credit #${n.toLocaleString()}`;
  if (!seed || /^0x0*$/.test(String(seed))) {
    app.innerHTML = `<section class="prose"><h1>${title}</h1><p class="muted">Not minted${config.chainId !== 1 ? ' on this testnet yet. <a href="/mint">Mint test Credits →</a>' : '.'}</p></section>`;
    return;
  }

  // Where it is: a wallet, one of our Credit Unions, or burned into a Statement.
  let union: Listed | null = null;
  if (owner) {
    union = list.find((b) => same(b.s.address, owner)) ?? null;
    if (!union && (await pub.readContract({ address: config.factory, abi: factoryAbi, functionName: 'isBatch', args: [owner] }).catch(() => false)))
      union = await getBatch(owner).catch(() => null);
  }
  const burnedIn = owner ? null : list.find((b) => (b.s.state === 'Auction' || b.s.state === 'Settled') && b.ids.includes(id)) ?? null;
  const depositor = union ? union.depositors[union.ids.indexOf(id)] : undefined;
  const mine = !!owner && !union && same(owner, session.account);
  const you = (a?: Address) => (a && same(a, session.account) ? ' <span class="tag you">You</span>' : '');
  const unionLink = (b: Listed) => `<a href="/union/${b.s.address}">${esc(b.s.name || 'Untitled')}</a>`;

  const where = union
    ? fact('Deposited in', unionLink(union)) + (depositor ? fact('Deposited by', who(depositor, 'sm', true) + you(depositor)) : '')
    : owner
      ? fact('Owner', who(owner, 'sm', true) + you(owner))
      : burnedIn
        ? fact('Burned into', `Statement #${burnedIn.s.statementId} · ${unionLink(burnedIn)}`)
        : fact('Owner', '<span class="muted">Burned</span>');

  const r = rated.r;
  const inks = r ? maskInks(paletteBit(r.traits.palette)) : [];
  const traits = r
    ? [
        fact('Rating', `<a class="num" href="${ratingBand(r.score)}" title="Credits rated within a point of it">${fmtScore(r.score)}</a> <span class="muted num">· rank ${r.rank.toLocaleString()} of ${rated.n.toLocaleString()}</span>`),
        fact('Palette', traitChip(`/palette/${r.traits.palette}`, swatch(r.traits.palette), r.traits.palette)),
        fact('Eights', traitChip(`/eights/${r.traits.eights}`, dice(r.traits.eights), r.traits.eights ? `${r.traits.eights}×8` : 'None')),
        fact('Print', traitChip(`/print/${r.traits.registration.toLowerCase()}`, printGlyph(r.traits.registration), r.traits.registration)),
        fact('Weight', traitChip(`/weight/${weightOf(r)}`, weightGlyph(weightOf(r)), cap(weightOf(r)))),
        fact('Bits', `<a class="num" href="/bits?min=${r.traits.activeBits}&max=${r.traits.activeBits}" title="Credits with as many Bits">${r.traits.activeBits.toLocaleString()}</a>`),
        fact('Paid', `<span class="num">${paid.format(new Date(r.paidAt * 1000))}</span>`),
      ].join('')
    : fact('Rating', '<span class="muted">Unavailable</span>');

  app.innerHTML = `
  <section class="batch credit-page">
    <div class="credit-art"><img src="${art(id)}" alt="${title}"></div>
    <div class="batch-side">
      <header><h1>${title}</h1></header>
      <dl class="facts">${where}${traits}</dl>
      <div id="credit-buy" hidden></div>
    </div>
  </section>
  ${owner && !union ? `<section class="credit-fits"><div class="section-head"><h3>Invited</h3><span class="muted num" id="fits-n"></span></div><p class="muted section-sub">Credit Unions that this Credit can join.</p><div id="fits"><p class="muted">Checking open Credit Unions…</p></div></section>` : ''}`;
  hydrate(app);

  if (owner && !union) {
    void drawFits(id, r, list, mine);
    if (!mine) void drawBuy(n);
  }
}

/// Open Credit Unions that would take this Credit now, by the same rules the rest of the site uses. The owner's
/// cards open the Credit Union with this Credit already picked.
async function drawFits(id: bigint, r: Rated | undefined, list: Listed[], mine: boolean) {
  const el = document.getElementById('fits');
  if (!el) return;
  const open = list.filter((b) => b.s.state === 'Open');
  const fit = await fitIds(open, [id], new Map(r ? [[id.toString(), r]] : [])).catch(() => new Map<Address, bigint[]>());
  if (!el.isConnected) return;
  const fits = open.filter((b) => fit.has(b.s.address));
  document.getElementById('fits-n')!.textContent = fits.length ? String(fits.length) : '';
  if (!fits.length) {
    el.innerHTML = `<p class="muted">No open Credit Union takes it right now.</p>`;
    return;
  }
  el.innerHTML = `<div class="grid">${fits
    .map((b) => {
      const html = card(b, mine ? [id] : undefined);
      return mine ? html.replace(`href="/union/${b.s.address}"`, `href="/union/${b.s.address}?pick=${id}"`) : html;
    })
    .join('')}</div>`;
  hydrate(el);
  fillGhosts(el);
}

/// OpenSea's best listing for this Credit. Where the site can't buy (testnets), the mainnet price shows as a
/// preview with the button off. Not listed: nothing.
async function drawBuy(n: number) {
  const el = document.getElementById('credit-buy');
  if (!el) return;
  let d: { price?: string | null; preview?: boolean; url?: string };
  try {
    const res = await fetch(`/opensea/credit/${n}`);
    if (!res.ok) return;
    d = await res.json();
  } catch {
    return;
  }
  if (!d.price || !el.isConnected) return;
  const price = eth(BigInt(d.price));
  el.className = 'box';
  el.innerHTML = `<div class="box-head"><h3>Listed</h3><strong class="num">${price}</strong></div>
    ${
      d.preview || !d.url
        ? `<button class="btn primary block" disabled>Buy</button><p class="muted small">Mainnet price, shown as a preview.</p>`
        : `<a class="btn primary block" href="${esc(d.url)}" target="_blank" rel="noopener">Buy on OpenSea ↗</a>`
    }`;
  el.hidden = false;
}
