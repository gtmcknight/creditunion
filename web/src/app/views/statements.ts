/// Market → Statements (/statements): every Statement listed on OpenSea, with its art, price, Credit Rating and format,
/// cheapest first or the most rating per ETH first. Bought one at a time from the buyer's own wallet (a Seaport fill
/// the Worker asks OpenSea for; no Sweeper: Statements are dear, and one is a decision).
import type { Address, Hex } from 'viem';
import { chain, ensureChain, pub, session } from '../chain';
import { listBatches } from '../data';
import { bindSort, errText, esc, eth, same, sortMenu, statementArt, toast } from '../ui';
import { DIRECTIONS } from '../../shared/statement';
import { creditsHead } from './trait';

export type ForSale = { id: string; price: string; hash: string; protocol: string; seller: string; rating: number | null; format: number | null };
const ORDERS = [['cheap', 'Lowest price'], ['dear', 'Highest price'], ['rating', 'Top rated'], ['value', 'Most rating per ETH']] as const;
type Order = (typeof ORDERS)[number][0];

export async function statementsMarket(app: HTMLElement, rerender: () => void) {
  let order: Order = 'cheap';
  try {
    const v = localStorage.getItem('cu-statements-order');
    if (ORDERS.some(([k]) => k === v)) order = v as Order;
  } catch {}
  app.innerHTML = `<section class="trait-page jb">${creditsHead('statements')}<p class="muted">Reading listings…</p></section>`;
  let items: ForSale[] = [];
  try {
    const r = await fetch('/market/statements.json');
    const d = (await r.json()) as { items?: ForSale[]; error?: string };
    if (!r.ok || !d.items) throw new Error(d.error ?? 'Listings unavailable.');
    items = d.items;
  } catch (e) {
    app.innerHTML = `<section class="trait-page jb">${creditsHead('statements')}<p class="error">${esc(errText(e))}</p></section>`;
    return;
  }
  if (!app.isConnected) return;
  // Which union made each Statement, for its name and a link to its page.
  const unions = new Map<string, { name: string; address: Address }>();
  void listBatches()
    .then((list) => {
      for (const b of list) if (b.s.statementId) unions.set(b.s.statementId.toString(), { name: b.s.name || 'Untitled', address: b.s.address });
      draw();
    })
    .catch(() => {});

  const perEth = (x: ForSale) => (x.rating ?? 0) / (Number(BigInt(x.price) / 1_000_000_000_000n) / 1e6 || 1);
  const byPrice = (a: ForSale, b: ForSale) => (BigInt(a.price) < BigInt(b.price) ? -1 : BigInt(a.price) > BigInt(b.price) ? 1 : 0);
  const sorted = () =>
    [...items].sort((a, b) =>
      order === 'value' ? perEth(b) - perEth(a)
      : order === 'rating' ? (b.rating ?? 0) - (a.rating ?? 0) || byPrice(a, b)
      : order === 'dear' ? byPrice(b, a)
      : byPrice(a, b),
    );
  const card = (x: ForSale) => {
    const u = unions.get(x.id);
    const mine = !!session.account && same(x.seller as Address, session.account);
    const href = `/statement/${x.id}`;
    return `<div class="st-card" data-id="${x.id}">
      <a class="st-art statement-host" href="${href}">${statementArt(BigInt(x.id))}</a>
      <div class="st-meta">
        <a class="st-name" href="${href}">${esc(u?.name ?? 'Statement')} <span class="stmt-no num">#${x.id}</span></a>
        <span class="st-line muted small num">${x.rating != null ? `Rating ${x.rating.toLocaleString()}` : ''}${x.format != null && DIRECTIONS[x.format] ? ` · ${DIRECTIONS[x.format]}` : ''}</span>
        <div class="st-buy"><strong class="num">${eth(BigInt(x.price))}</strong>${mine ? '<span class="muted small">Yours</span>' : session.account ? `<button type="button" class="btn sm primary" data-buy="${x.id}">Buy</button>` : '<button type="button" class="btn sm" data-connect>Connect to buy</button>'}</div>
      </div>
    </div>`;
  };
  const draw = () => {
    if (!app.isConnected) return;
    app.innerHTML = `<section class="trait-page jb">
      ${creditsHead('statements')}
      <div class="jb-controls">
        <p class="jb-buy jb-count num"><b>${items.length.toLocaleString()} ${items.length === 1 ? 'Statement' : 'Statements'} listed</b></p>
        ${sortMenu(ORDERS, order)}
      </div>
      ${items.length ? `<div class="st-grid">${sorted().map(card).join('')}</div>` : '<p class="muted">No Statement is listed right now.</p>'}
    </section>`;
    bindSort(app, (k) => {
      order = k as Order;
      try {
        localStorage.setItem('cu-statements-order', order);
      } catch {}
      draw();
    });
    app.querySelectorAll<HTMLButtonElement>('[data-buy]').forEach((b) => b.addEventListener('click', () => void buy(b)));
  };

  const buy = (btn: HTMLButtonElement) => {
    const x = items.find((i) => i.id === btn.dataset.buy);
    if (x) void buyListed(btn, x, () => ((items = items.filter((i) => i.id !== x.id)), rerender()));
  };
  draw();
}

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
