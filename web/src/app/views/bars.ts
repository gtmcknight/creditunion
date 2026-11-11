/// /bars: every Bar listed on OpenSea, the way /credits lists Credits: its art, its number, its price and the $BALANCE
/// inside. Tap Bars to pick them, then buy them together from your own wallet (one Seaport fill the Worker asks OpenSea
/// for, up to 10 at a time). Minting goes through the swap box, or the edition's own page while only its list can mint.
import type { Address, Hex } from 'viem';
import { barArt } from '../../shared/bars';
import { chain, config, ensureChain, pub, session } from '../chain';
import { connectToBuy, SOURCES, YOURS } from '../forsale';
import { bindSort, errText, esc, eth, ethNum, sortMenu, toast } from '../ui';

type Listed = { id: string; price: string; hash: string; protocol: string; holds: string };
const ORDERS = [
  ['cheap', 'Lowest price'],
  ['number', 'Lowest number'],
  ['most', 'Most $BALANCE for your ETH'],
] as const;
type Order = (typeof ORDERS)[number][0];
/// The most one buy takes: the Worker fills at most 10 listings in one call.
const MAX = 10;
const ONE = 10n ** 18n;
const EDITION_PAGE = 'https://jack.art/exchange/bars';
const WINDOW_ABI = [
  { type: 'function', name: 'publicStart', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint64' }] },
  { type: 'function', name: 'mintEnd', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint64' }] },
] as const;

const whole = (wei: bigint) => Number(wei / ONE).toLocaleString('en-US');
const perEth = (l: Listed) => (BigInt(l.holds) * ONE) / (BigInt(l.price) || 1n);
const sorted = (ls: Listed[], order: Order) =>
  [...ls].sort((a, b) => {
    if (order === 'number') return Number(a.id) - Number(b.id);
    if (order === 'most') return perEth(b) > perEth(a) ? 1 : perEth(b) < perEth(a) ? -1 : 0;
    const d = BigInt(a.price) - BigInt(b.price);
    return d > 0n ? 1 : d < 0n ? -1 : Number(a.id) - Number(b.id);
  });
const day = (s: number) => new Date(s * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

/// What a signed-out Buy had picked, kept over its sign-in (the page draws again once a wallet connects).
let carried: string[] = [];

export async function barsPage(app: HTMLElement) {
  const bars = config.bars;
  if (!bars) {
    app.innerHTML = `<section class="prose"><h1>Bars</h1><p class="muted">Not here yet.</p></section>`;
    return;
  }
  const q = new URLSearchParams(location.search).get('order');
  let order: Order = ORDERS.some(([k]) => k === q) ? (q as Order) : 'cheap';
  app.innerHTML = `
  <section class="trait-page jb jb-deals">
    <header class="page-head">
      <nav class="jb-crumb" aria-label="Where"><b>Bars</b><span class="jb-total num" id="bars-n"></span></nav>
      <p class="page-lede" id="bars-lede">Jack Butcher’s Bars. Each one holds its number in $BALANCE and melts back into it after minting closes.</p>
    </header>
    <div class="jb-controls">
      <div class="jb-sorter">${sortMenu(ORDERS, order)}</div>
      <div class="jb-sweep buy-row" id="bars-act"></div>
    </div>
    <div class="trait-grid" id="bars-grid"><p class="muted">Loading Bars…</p></div>
  </section>`;
  const grid = app.querySelector<HTMLElement>('#bars-grid')!;
  const act = app.querySelector<HTMLElement>('#bars-act')!;
  const count = app.querySelector<HTMLElement>('#bars-n')!;
  const lede = app.querySelector<HTMLElement>('#bars-lede')!;

  // Where a new Bar comes from: the edition's page while only its wallet list can mint, then the swap box; once minting
  // closes, the box melts them instead.
  void Promise.all([
    pub.readContract({ address: bars.edition, abi: WINDOW_ABI, functionName: 'publicStart' }).then(Number, () => bars.publicAt),
    pub.readContract({ address: bars.edition, abi: WINDOW_ABI, functionName: 'mintEnd' }).then(Number, () => 0),
  ]).then(([open, end]) => {
    const now = Date.now() / 1000;
    const head = 'Jack Butcher’s Bars. Each one holds its number in $BALANCE';
    lede.innerHTML =
      end && now >= end
        ? `${head} and melts back into it any time. <a href="/?from=bar&to=balance">Melt yours</a>.`
        : open && now < open
          ? `${head} and melts back into it from ${day(end)}. Until ${day(open)} only <a href="${EDITION_PAGE}" target="_blank" rel="noopener">its wallet list</a> can mint.`
          : `${head} and melts back into it from ${day(end)}. <a href="/?from=eth&to=bar">Mint the next one</a>.`;
  });

  let all: Listed[] = [];
  const picked = new Set<string>(carried.filter(Boolean));
  carried = [];
  const os = (id: string) => `https://opensea.io/item/ethereum/${bars.edition}/${id}`;
  const tile = (l: Listed) =>
    `<div class="cc listed${picked.has(l.id) ? ' sel' : ''}" data-id="${esc(l.id)}"><a class="cc-art" href="${os(l.id)}" title="Tap to pick"><img src="${barArt(l.id)}" alt="Bar #${esc(l.id)}" loading="lazy" decoding="async"></a><span class="cc-cap"><a class="num" href="${os(l.id)}" target="_blank" rel="noopener">#${Number(l.id).toLocaleString('en-US')}</a><span class="cc-price num" title="On OpenSea"><img class="src" src="${SOURCES.opensea.icon}" alt="OpenSea">${ethNum(BigInt(l.price))}</span></span><span class="cc-line num">${whole(BigInt(l.holds))} $BALANCE</span></div>`;

  const chosen = () => all.filter((l) => picked.has(l.id));
  const drawAct = () => {
    const ls = chosen();
    const sum = ls.reduce((s, l) => s + BigInt(l.price), 0n);
    const total = ls.length ? `<span>${eth(sum)}</span>` : `<span class="muted">Tap Bars to pick, up to ${MAX}</span>`;
    act.innerHTML = `<span class="sweep-total num">${total}</span>${
      !session.account
        ? connectToBuy()
        : `<button class="btn primary" id="bars-go"${ls.length ? '' : ' disabled'}>${ls.length ? `Buy ${ls.length === 1 ? `Bar #${ls[0].id}` : `${ls.length} Bars`}` : 'Buy'}</button>`
    }`;
    act.querySelector('[data-connect]')?.addEventListener('click', () => (carried = [...picked]));
    act.querySelector<HTMLButtonElement>('#bars-go')?.addEventListener('click', (e) => void buy(e.currentTarget as HTMLButtonElement));
  };
  const draw = () => {
    if (!all.length) {
      grid.innerHTML = `<p class="muted">None for sale right now. <a href="https://opensea.io/collection/balancebars" target="_blank" rel="noopener">OpenSea</a></p>`;
      return;
    }
    grid.innerHTML = sorted(all, order).map(tile).join('');
  };

  // A tap on a Bar's art picks it (its number still opens it on OpenSea).
  grid.addEventListener('click', (e) => {
    const art = (e.target as HTMLElement).closest<HTMLElement>('.cc-art');
    const cell = art?.closest<HTMLElement>('.cc.listed');
    if (!art || !cell) return;
    e.preventDefault();
    const id = cell.dataset.id!;
    if (picked.has(id)) picked.delete(id);
    else if (picked.size >= MAX) return void toast(`Up to ${MAX} Bars at a time.`, 'info');
    else picked.add(id);
    cell.classList.toggle('sel', picked.has(id));
    drawAct();
  });
  bindSort(app, (k) => {
    order = k as Order;
    const u = new URL(location.href);
    if (order === 'cheap') u.searchParams.delete('order');
    else u.searchParams.set('order', order);
    history.replaceState(null, '', u.pathname + u.search);
    draw();
  });

  async function load() {
    const r = await fetch('/market/bars.json');
    const d = (await r.json().catch(() => ({}))) as { items?: Listed[]; error?: string };
    if (!r.ok || !d.items) throw new Error(d.error ?? 'Listings unavailable.');
    all = d.items;
    for (const id of [...picked]) if (!all.some((l) => l.id === id)) picked.delete(id);
    count.textContent = `${all.length.toLocaleString('en-US')} for sale`;
    draw();
    drawAct();
  }

  /// The picked Bars in one fill to this wallet: OpenSea's signed orders, run first (a stale listing fails here, not in
  /// the wallet), then sent.
  async function buy(btn: HTMLButtonElement) {
    const ls = chosen();
    if (!ls.length || !session.wallet || !session.account) return;
    btn.disabled = true;
    btn.textContent = 'Buying…';
    const cells = ls.map((l) => grid.querySelector<HTMLElement>(`.cc[data-id="${l.id}"]`)).filter((c): c is HTMLElement => !!c);
    cells.forEach((c) => c.classList.add('buying'));
    try {
      await ensureChain();
      const r = await fetch('/market/bars/buy-many', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ listings: ls.map((l) => ({ hash: l.hash, protocol: l.protocol })), buyer: session.account }) });
      const tx = (await r.json().catch(() => ({}))) as { to?: Address; data?: Hex; value?: string; error?: string };
      if (!r.ok || !tx.to || !tx.data || !tx.value) throw new Error(tx.error ?? 'Those Bars can’t be bought right now.');
      await pub.call({ account: session.account, to: tx.to, data: tx.data, value: BigInt(tx.value) });
      const hash = await session.wallet.sendTransaction({ account: session.account, chain, to: tx.to, data: tx.data, value: BigInt(tx.value) });
      toast('Submitted. Waiting for confirmation…', 'info');
      const receipt = await pub.waitForTransactionReceipt({ hash });
      if (receipt.status !== 'success') throw new Error('The purchase reverted.');
      toast(ls.length === 1 ? `Bar #${ls[0].id} is yours.` : `${ls.length} Bars are yours.`, 'ok', 8000);
      // Bought: off the market here at once, each square saying it's yours.
      for (const c of cells) {
        c.classList.remove('listed', 'sel', 'buying');
        c.classList.add('got');
        c.querySelector('.cc-price')?.insertAdjacentHTML('afterend', YOURS);
        c.querySelector('.cc-price:not(.yours)')?.remove();
      }
      const got = new Set(ls.map((l) => l.id));
      all = all.filter((l) => !got.has(l.id));
      picked.clear();
      count.textContent = `${all.length.toLocaleString('en-US')} for sale`;
      drawAct();
    } catch (e) {
      cells.forEach((c) => c.classList.remove('buying'));
      toast(errText(e), 'err', 8000);
      drawAct();
      // Sellers relist all the time: fresh listings, and picks still for sale stay picked at their new price.
      void load().catch(() => {});
    }
  }

  drawAct();
  try {
    await load();
  } catch (e) {
    grid.innerHTML = `<p class="muted">${esc(errText(e))}</p>`;
  }
}
