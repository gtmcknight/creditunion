import { parseAbi, type Address } from 'viem';
import { dice, printGlyph, swatch, weightGlyph } from '../glyphs';
/// A trait value with the same glyph the create page uses for it, linking to its trait page.
const traitChip = (href: string, g: string, l: string) => `<a class="vchip" href="${href}">${g}<span>${l}</span></a>`;
import { batchAbi, creditsAbi, factoryAbi } from '../abi';
import { bin } from '../bins';
import { config, pub, send, session } from '../chain';
import { earlyShare, getBatch, listBatches, ratings, tokenBatches, type Listed, type Rated } from '../data';
import { converted } from '../tokens';
import { needsSave } from './party';
import { hydrate, who } from '../ens';
import { weightOf } from '../fit';
import { maskInks, paletteBit } from '../traits';
import { art, boughtToast, errText, esc, eth, same, sheet, statementArt, toast, utc } from '../ui';
import { creditsHead } from './trait';
import { processOf } from '../../shared/credits';
import { eightsName } from '../../shared/trait';
import { SOURCES, buying, connectToBuy, justBought, live, rememberBought, sweepFee, sweepToWallet, type Source } from '../forsale';

/// Credits ever minted: the same numbers on every network.
const SUPPLY = 122_154;
const fmtScore = (s: number) => (Math.floor(s * 100) / 100).toFixed(2);
/// Payment time in UTC, as Jack's site and "How it was made" show it: the second is what picks the plates.
const paid = utc({ year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
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

  // Where it is: a wallet, one of our Credit Unions or $BALANCE batches, or burned into a Statement.
  const asToken = (b: Awaited<ReturnType<typeof getBatch>>): Listed => ({ ...b, ids: [...b.ids], depositors: [...b.depositors], format: null, token: true });
  const isBatchOf = (factory: Address | null | undefined, a: Address) =>
    factory ? (pub.readContract({ address: factory, abi: factoryAbi, functionName: 'isBatch', args: [a] }) as Promise<boolean>).catch(() => false) : Promise.resolve(false);
  let union: Listed | null = null;
  if (owner) {
    union = list.find((b) => same(b.s.address, owner)) ?? null;
    if (!union && (await isBatchOf(config.factory, owner))) union = await getBatch(owner).catch(() => null);
    if (!union && (await isBatchOf(config.tokenFactory, owner))) union = await getBatch(owner).then(asToken, () => null);
  }
  const burnedIn = owner
    ? null
    : (list.find((b) => (b.s.state === 'Auction' || b.s.state === 'Settled') && b.ids.includes(id)) ??
      (await tokenBatches().catch(() => [] as Listed[])).find((b) => b.ids.includes(id) && converted(b.s.statement)) ??
      null);
  // What a $BALANCE batch pays for it: its rating in the batches' own table, after the fee the batch opened with.
  const tokenHome = union?.token ? union : burnedIn?.token ? burnedIn : null;
  const pays = tokenHome
    ? await bin('scores-live.bin').then((b) => Math.floor(((new Uint16Array(b)[n - 1] ?? 0) / 10) * (1 - tokenHome.s.protocolFeeBps / 10_000)), () => 0)
    : 0;
  const depositor = union ? union.depositors[union.ids.indexOf(id)] : undefined;
  const mine = !!owner && !union && same(owner, session.account);
  const you = (a?: Address) => (a && same(a, session.account) ? ' <span class="tag you">You</span>' : '');

  // Owner is always the first fact. In a Credit Union it's the depositor: the union holds it, but they can take it
  // back until it locks. Burned, there's no owner; the box above says what it became.
  const holder = union ? depositor : owner;
  const where = holder
    ? fact('Owner', `<span${union ? ' title="Held by the Credit Union; the depositor can withdraw it until it locks"' : ''}>${who(holder, 'sm', true)}${you(holder)}</span>`)
    : fact('Owner', '<span class="muted">Burned</span>');
  const home = union ?? burnedIn;
  // Yours to take back from here: deposited by this wallet, in a batch that hasn't locked for its burn.
  const leaveFrom =
    union && same(depositor, session.account) && (union.s.state === 'Open' || union.s.state === 'Full' || union.s.state === 'Expired') && union.s.phase !== 'Burnable' && !converted(union.s.statement)
      ? union
      : null;

  const r = rated.r;
  const inks = r ? maskInks(paletteBit(r.traits.palette)) : [];
  const traits = r
    ? [
        fact('Rating', `<a class="num" href="${ratingBand(r.score)}" title="Credits rated within a point of it">${fmtScore(r.score)}</a> <span class="muted num">· rank ${r.rank.toLocaleString()} of ${rated.n.toLocaleString()}</span>`),
        fact('Palette', traitChip(`/palette/${r.traits.palette}`, swatch(r.traits.palette), r.traits.palette)),
        fact('Eights', traitChip(`/eights/${r.traits.eights}`, dice(r.traits.eights), eightsName(r.traits.eights))),
        fact('Print', traitChip(`/print/${r.traits.registration.toLowerCase()}`, printGlyph(r.traits.registration), r.traits.registration)),
        fact('Weight', traitChip(`/weight/${weightOf(r)}`, weightGlyph(weightOf(r)), cap(weightOf(r)))),
        fact('Bits', `<a class="num" href="/bits?min=${r.traits.activeBits}&max=${r.traits.activeBits}" title="Credits with as many Bits">${r.traits.activeBits.toLocaleString()}</a>`),
        fact('Paid', `<span class="num">${paid.format(new Date(r.paidAt * 1000))} UTC</span>`),
      ].join('')
    : fact('Rating', '<span class="muted">Unavailable</span>');

  app.innerHTML = `
  <div class="jb">${creditsHead('credit', `#${id.toLocaleString('en-US')}`)}</div>
  <section class="batch credit-page">
    <div class="credit-art"><img src="${art(id)}" alt="${title}"></div>
    <div class="batch-side">
      <header><h1>${title}</h1></header>
      ${home ? homeBar(home, id, burnedIn === home, depositor, you, pays) : ''}
      ${leaveFrom ? '<button type="button" class="btn block credit-leave" id="cr-withdraw">Withdraw to your wallet</button>' : ''}
      <dl class="facts">${where}${traits}</dl>
      <div id="credit-buy" hidden></div>
    </div>
  </section>
  ${r ? howMade(seedText(String(seed)), r) : ''}
`;
  hydrate(app);

  if (owner && !union && !mine) void drawBuy(n);

  document.getElementById('cr-withdraw')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget as HTMLButtonElement;
    btn.disabled = true;
    btn.textContent = 'Withdrawing…';
    try {
      // A picture union whose spots must be saved first: its own page saves them and withdraws in one go.
      if (leaveFrom && !leaveFrom.token && (await needsSave(leaveFrom.s.address, leaveFrom))) return void (location.href = `/union/${leaveFrom.s.address}`);
      await send({ address: leaveFrom!.s.address, abi: batchAbi, functionName: 'withdraw', args: [[id]] });
      toast('Withdrawn. It’s back in your wallet.', 'ok');
      await credit(app, raw);
    } catch (err) {
      toast(errText(err), 'err', 8000);
      btn.disabled = false;
      btn.textContent = 'Withdraw to your wallet';
    }
  });
}

/// Where this Credit is when it isn't in a wallet, as a box under its title: a mini sheet of its Credit
/// Union, then who put it in, its place in line and its share of the sale (Early bird unions pay by position).
/// A $BALANCE batch pays by rating, not by place: its line says what this Credit becomes (`pays`, after the fee).
function homeBar(b: Listed, id: bigint, burned: boolean, depositor: Address | undefined, you: (a?: Address) => string, pays = 0) {
  const i = b.ids.indexOf(id);
  const by = depositor ?? (i >= 0 ? b.depositors[i] : undefined);
  const share = b.s.split === 1 && i >= 0 ? earlyShare(i) : 1 / 80;
  const dot = ' <span class="muted">·</span> ';
  // Row 1 says plainly what happened to it: deposited in a union, or burned into a Statement. Row 2: its place.
  const name = `<strong>${esc(b.s.name || 'Untitled')}</strong>`;
  const top = burned
    ? `<span class="tag state settled">Burned</span> into <strong>Statement #${b.s.statementId}</strong>${dot}made by ${name}`
    : `<span class="tag state">Deposited</span> in ${name}${dot}<span class="num">${b.s.count} of 80 in</span>`;
  const paid = b.s.state === 'Settled';
  const sub = [
    i >= 0 && !b.token ? `Position ${i + 1}` : '',
    b.token
      ? burned
        ? 'Converted to $BALANCE'
        : `Becomes ${pays ? `≈ ${pays.toLocaleString('en-US')} ` : ''}$BALANCE`
      : `${paid ? 'got' : 'gets'} ${(share * 100).toFixed(2).replace(/\.?0+$/, '')}% of the sale`,
    burned && by ? `by ${who(by, 'sm', 'nested')}${you(by)}` : '', // a live Credit's depositor is the Owner row
  ]
    .filter(Boolean)
    .join(dot);
  return `<a class="home-bar" href="/union/${b.s.address}">
    <span class="home-mini${burned ? ' statement-host' : ''}">${sheet(b.ids, { size: 'sm' })}${burned ? statementArt(b.s.statementId) : ''}</span>
    <span class="home-text"><span class="home-top">${top}</span><span class="home-sub">${sub}</span></span>
    <span class="home-go" aria-label="View Credit Union">→</span>
  </a>`;
}

/// The seed is 21 bytes of the X Money transaction ID; read it byte for byte, as the contract hashes it.
const seedText = (hex: string) => String.fromCharCode(...(hex.slice(2).match(/../g) ?? []).map((h) => parseInt(h, 16)));

/// The art's inks (CreditDrawing.palette), C M Y K.
const PLATE_INK = ['#00b5e2', '#e4007c', '#ffd100', '#111111'];
const PLATE_NAME = ['Cyan', 'Magenta', 'Yellow', 'Black'];

/// "How it was made": this Credit's own path from payment to picture, step by step, the way Jack's page shows a
/// random one. Every value is recomputed from the seed and payment time with the art contract's own maths.
function howMade(seed: string, r: Rated) {
  const p = processOf(seed, r.paidAt);
  const on = (l: number) => (p.mask & (1 << l)) !== 0;
  const hex = [...p.hash].map((b) => b.toString(16).padStart(2, '0')).join('');
  const plate = (l: number) =>
    `<figure class="plate${on(l) ? '' : ' off'}"><svg viewBox="0 0 8 8" shape-rendering="crispEdges" aria-hidden="true">${p.plates[l]
      .map((bit, i) => (bit ? `<rect x="${i % 8}" y="${i >> 3}" width="1" height="1"/>` : ''))
      .join('')}</svg><figcaption>${'CMYK'[l]}</figcaption></figure>`;
  const step = (k: number, v: number) => (k ? `${Math.abs(k)} ${k < 0 ? (v ? 'up' : 'left') : v ? 'down' : 'right'}` : '');
  const slipped = [0, 1, 2, 3]
    .filter((l) => on(l) && (p.dx[l] || p.dy[l]))
    .map((l) => `${PLATE_NAME[l]} ${[step(p.dx[l], 0), step(p.dy[l], 1)].filter(Boolean).join(', ')}`);
  const arrow = '<div class="proc-arrow" aria-hidden="true"></div>';
  return `<section class="credit-process">
    <div class="proc" style="${PLATE_INK.map((c, i) => `--ink${i}:${c}`).join(';')}">
      <div class="proc-step">
        <p class="proc-k">X Money transaction ID</p>
        <code class="proc-seed">${[...seed].map((ch) => (ch === '8' ? '<b title="Each 8 registers in the art">8</b>' : esc(ch))).join('')}</code>
        <p class="proc-k">SHA-256 · 64 bits per plate</p>
        <code class="proc-hash">${[0, 1, 2, 3].map((l) => `<span class="h${l}">${hex.slice(l * 16, l * 16 + 16)}</span>`).join('')}</code>
      </div>
      ${arrow}
      <div class="proc-step">
        <div class="proc-plates">${[0, 1, 2, 3].map(plate).join('')}</div>
        ${slipped.length ? `<p class="proc-note">${esc(r.traits.registration)}: ${slipped.map((x) => x.charAt(0).toLowerCase() + x.slice(1)).join(', ')}</p>` : ''}
      </div>
      ${arrow}
      <div class="proc-step proc-out">
        <img src="${art(BigInt(r.id))}" alt="" class="proc-art">
        <p class="proc-cap">#${Number(r.id).toLocaleString()}</p>
      </div>
    </div>
  </section>`;
}

const buyAbi = parseAbi(['function sellTargetNFT(uint256 tokenId) payable', 'function buy(uint256 listingId, address recipient) payable']);

type Offer = { price?: string | null; source?: Source; contract?: Address | null; listingId?: string | null; hash?: string | null; protocol?: string | null; preview?: boolean; url?: string };

/// This Credit's cheapest listing: OpenSea, CreditStrategy or FWA, all bought right here. CreditStrategy and FWA sell
/// from their own contracts; an OpenSea order goes through the Sweeper, like a sweep of one (its 2% fee). Where the site can't buy (testnets), the mainnet
/// price shows as a preview with the button off. Not listed: nothing. Live: read again every 20 s, so a sale, a
/// new listing or a new price shows here too.
async function drawBuy(n: number) {
  const el = document.getElementById('credit-buy');
  if (!el) return;
  const read = async (): Promise<Offer | null> => {
    try {
      const res = await fetch(`/opensea/credit/${n}`, { cache: 'no-store' });
      return res.ok ? ((await res.json()) as Offer) : null;
    } catch {
      return null;
    }
  };
  // What the box says (price, where, and how it's bought), so a live read redraws it only when that changes.
  const say = (d: Offer | null) => (d?.price && d.source ? `${d.price}:${d.source}:${d.listingId ?? ''}:${d.hash ?? ''}` : '');
  let said = '';
  const draw = async (d: Offer | null) => {
    said = say(d);
    if (!d?.price || !d.source || !SOURCES[d.source] || justBought(n)) {
      el.hidden = true;
      el.innerHTML = '';
      return;
    }
    await drawOffer(el, n, { ...d, price: d.price, source: d.source });
  };
  await draw(await read());
  live(el, async () => {
    const d = await read();
    if (d && el.isConnected && say(d) !== said) await draw(d);
  });
}

/// The listing's box: where it's listed, its price, and Buy (in-app where the site can buy it, else on its market).
async function drawOffer(el: HTMLElement, n: number, d: Offer & { price: string; source: Source }) {
  const src = SOURCES[d.source];
  const value = BigInt(d.price);
  // An OpenSea order, or a Credit in the $CC engine's pile, goes through the Sweeper (buy / buyEvery); FWA's and the
  // strategy's from their own contracts.
  const viaSweeper = !d.preview && ((d.source === 'opensea' && !!d.hash && !!d.protocol) || d.source === 'cc') && !!config.sweeper;
  const bps = viaSweeper ? await sweepFee() : 0n;
  if (!el.isConnected) return;
  const inApp = viaSweeper || (!d.preview && !!d.contract && (d.source === 'strategy' || (d.source === 'fwa' && !!d.listingId)));
  // Where it's listed, linked for anyone who wants to check, but quietly: buying here is the point.
  const where = `Listed on ${d.url ? `<a class="quiet" href="${esc(d.url)}" target="_blank" rel="noopener">${src.name}</a>` : src.name}.`;
  const fee = bps ? `a ${Number(bps) / 100}% fee` : '';
  const total = value + (value * bps) / 10_000n;
  // Just Buy, the price in it as the wallet will ask it; where it's listed, in the line under it.
  el.className = 'box';
  el.innerHTML = d.preview
    ? `<button class="btn primary block" disabled>Buy · ${eth(value)}</button><p class="muted small">Mainnet price, shown as a preview. ${where}</p>`
    : !inApp
      ? `<a class="btn primary block" href="${esc(d.url ?? '#')}" target="_blank" rel="noopener">Buy on ${src.name} · ${eth(value)} ↗</a>`
      : session.account
        ? `<button class="btn primary block" id="credit-buy-go">Buy · ${eth(total)}</button><p class="muted small">${where}${fee ? ` Price includes ${fee}.` : ''}</p>`
        : `${connectToBuy(true)}<p class="muted small">${eth(total)}${fee ? `, including ${fee}` : ''}. ${where}</p>`;
  el.hidden = false;
  const go = document.getElementById('credit-buy-go') as HTMLButtonElement | null;
  // Bought: back to the union you came from with this Credit picked to deposit, else this page again, now yours.
  const done = () => {
    el.remove();
    let prev = '';
    try {
      // Only the step that brought you to this very page counts (not one from earlier in the session).
      const p = JSON.parse(sessionStorage.getItem('cu-prev') ?? '{}') as { from?: string; to?: string };
      if (p.to === location.pathname) prev = p.from ?? '';
    } catch {}
    if (/^\/(union|party)\/0x[0-9a-fA-F]{40}$/.test(prev)) {
      history.pushState(null, '', `${prev}?pick=${n}`);
    }
    window.dispatchEvent(new PopStateEvent('popstate')); // the router draws whatever the address now says
  };
  go?.addEventListener('click', async () => {
    if (viaSweeper) {
      const got = await sweepToWallet([d.source === 'cc' ? { id: String(n), price: d.price!, source: 'cc' } : { id: String(n), price: d.price!, source: 'opensea', hash: d.hash!, protocol: d.protocol! }], go);
      if (got?.length) done();
      return;
    }
    const label = go.textContent ?? '';
    go.disabled = true;
    go.textContent = 'Buying…';
    buying.n++;
    try {
      await send(
        d.source === 'strategy'
          ? { address: d.contract!, abi: buyAbi, functionName: 'sellTargetNFT', args: [BigInt(n)], value }
          : { address: d.contract!, abi: buyAbi, functionName: 'buy', args: [BigInt(d.listingId!), session.account!], value },
        () => {
          go.classList.add('busy');
          go.textContent = 'Buying';
        },
      );
      boughtToast([n]);
      rememberBought([n]);
      done();
    } catch (e) {
      toast(errText(e), 'err', 8000);
      go.classList.remove('busy');
      go.disabled = false;
      go.textContent = label;
    } finally {
      buying.n--;
    }
  });
}
