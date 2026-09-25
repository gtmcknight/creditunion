import Sortable from 'sortablejs';
import { parseEther, type Address } from 'viem';
import { batchAbi, creditsAbi, factoryAbi, sweeperAbi } from '../abi';
import { config, explorer, pub, send, session } from '../chain';
import { ARRANGEMENTS, earlyWeight, eligible, getBatch, hasLayout, layoutSlot, me, placeOnLayout, ratings, type Rated } from '../data';
import { maskLabel, paletteBit } from '../traits';
import { hydrate, pct, who } from '../ens';
import { describeFilter } from '../traits';
import { $$, art, errText, esc, eth, same, sheet, short, toast, until } from '../ui';

const CHUNK = 40; // Credits per transaction; keeps each one well under the block gas limit
const CREATOR_GRACE = 86400; // matches Batch.CREATOR_ORDER_GRACE
const RATING_URL = 'https://jack.art/credits/rating';
const fmtScore = (s: number) => (Math.floor(s * 100) / 100).toFixed(2);

type Ctx = Awaited<ReturnType<typeof getBatch>>;
type Mine = Awaited<ReturnType<typeof me>> | null;

let picks = new Set<string>();

export async function batch(app: HTMLElement, address: Address, rerender: () => void) {
  let b: Ctx;
  try {
    b = await getBatch(address);
  } catch {
    app.innerHTML = `<section class="prose"><h1>Batch not found</h1><p><a href="#/">← Batches</a></p></section>`;
    return;
  }
  const account = session.account;
  const m: Mine = account ? await me(address, account) : null;
  const myIds = new Set(b.ids.filter((_, i) => same(b.depositors[i], account)).map(String));
  const s = b.s;
  const f = describeFilter(s.filter, s.allowlistSize);
  const burned = s.state === 'Auction' || s.state === 'Settled';
  const depositors = new Set(b.depositors.map((d) => d.toLowerCase())).size;

  // Cells added since this browser last saw the batch drop in, in deposit order.
  const seenKey = `eighty-seen-${address}`;
  let seen = s.count;
  try {
    seen = Number(sessionStorage.getItem(seenKey) ?? s.count);
    sessionStorage.setItem(seenKey, String(s.count));
  } catch {}

  // On a layout batch the sheet shows every Credit in the slot it will burn into, not in deposit order.
  const slots = hasLayout(s.filter) ? Array.from({ length: 80 }, (_, i) => layoutSlot(s.filter, i)) : null;
  let placed: (bigint | null)[] | undefined;
  if (slots && !burned && b.ids.length) {
    try {
      const pal = (await Promise.all(
        b.ids.map((id) => pub.readContract({ address: s.address, abi: batchAbi, functionName: 'paletteOf', args: [id] })),
      )) as number[];
      const byId = new Map(b.ids.map((id, i) => [id.toString(), Number(pal[i])]));
      placed = placeOnLayout(slots, b.ids, (id) => byId.get(id.toString()) ?? 0);
    } catch {}
  }
  const artHtml = burned
    ? `<figure class="statement">${sheet(b.ids, { closed: true })}<figcaption class="legend muted small"><span>Statement #${s.statementId}</span><span>80 Credits, burned in deposit order</span></figcaption></figure>`
    : `${sheet(b.ids, { mine: myIds, fresh: placed ? undefined : seen < s.count ? seen : undefined, closing: s.state === 'Full', layout: slots ?? undefined, placed })}
       <div class="legend muted small">${myIds.size ? `<button type="button" class="spot" aria-pressed="false"><i class="dot mine"></i><span>Highlight yours</span><span class="num muted">${myIds.size}</span></button>` : ''}<span id="legend-order">${s.arrangement === 0 ? 'In deposit order' : s.arrangement === 4 ? (placed ? 'Shown as laid out' : 'Burned as laid out') : `Shown in deposit order · burned by ${ARRANGEMENTS[s.arrangement].toLowerCase()}`}</span></div>`;

  app.innerHTML = `
  <a class="back" href="#/">← Batches</a>
  <section class="batch">
    <div class="batch-art">${artHtml}</div>
    <div class="batch-side">
      <header>
        <span class="tag ${s.state.toLowerCase()}">${s.state}</span>
        <h1>${esc(s.name || 'Untitled')}</h1>
        <div class="byline">${who(s.creator, 'lg')}${s.creatorFeeBps ? `<span class="fee">${pct(s.creatorFeeBps)} creator fee</span>` : ''}</div>
        ${f ? `<p class="filter">${esc(f)}</p>` : ''}
      </header>
      ${
        s.state === 'Open' || s.state === 'Expired'
          ? `<div class="count"><p class="num">${s.count}<span>/80</span></p><div class="bar"><i style="width:${(s.count / 80) * 100}%"></i></div></div>`
          : ''
      }
      <dl class="facts">
        ${s.state === 'Open' ? fact('Deadline', `<span class="num">${until(s.deadline)}</span>`) : ''}
        ${s.state === 'Full' ? fact('Burn by', `<span class="num">${until(s.deadline)}</span>`) : ''}
        ${fact('Depositors', `<span class="num">${depositors}</span>`)}
        ${fact('Order', ARRANGEMENTS[s.arrangement])}
        ${fact('Payout', payout(b, myIds))}
        ${s.count ? fact('Rating', `<span id="rating" class="muted">…</span>`) : ''}
        ${s.reserve && (s.state === 'Open' || s.state === 'Full' || (s.state === 'Auction' && s.minBid === s.reserve && !s.highBid)) ? fact('Reserve', eth(s.reserve)) : ''}
        ${fact('Sale split', split(s))}
        ${fact('Contract', link(s.address))}
      </dl>
      <div id="panel">${panel(b, m, myIds)}</div>
    </div>
  </section>`;

  hydrate(app);
  bind(b, m, myIds, rerender);
}

/// "Early bird · 1.5× → 0.5×", plus the connected wallet's own positions and what they add up to.
function payout(b: Ctx, myIds: Set<string>) {
  if (b.s.split !== 1) return 'Equal · 1/80 each';
  const mine = b.ids.map((id, i) => [String(id), i] as const).filter(([id]) => myIds.has(id));
  const shares = mine.reduce((n, [, i]) => n + earlyWeight(i), 0);
  const yours = mine.length
    ? ` <span class="muted">· yours ${mine.map(([, i]) => `#${i + 1}`).slice(0, 4).join(' ')}${mine.length > 4 ? '…' : ''} = ${shares.toFixed(2)} shares</span>`
    : '';
  return `Early bird · <span class="num">1.5× → 0.5×</span>${yours}`;
}

/// "1% protocol · 5% creator · 94% to depositors"
function split(s: Ctx['s']) {
  const rest = 10_000 - s.protocolFeeBps - s.creatorFeeBps;
  return [`${pct(s.protocolFeeBps)} protocol`, s.creatorFeeBps ? `${pct(s.creatorFeeBps)} creator` : '', `${pct(rest)} depositors`]
    .filter(Boolean)
    .join(' · ');
}

const fact = (k: string, v: string) => `<div><dt>${k}</dt><dd>${v}</dd></div>`;
const link = (a: string) => {
  const u = explorer('address', a);
  return u ? `<a href="${u}" target="_blank" rel="noopener" class="mono">${short(a)} ↗</a>` : `<span class="mono">${short(a)}</span>`;
};
const plural = (n: number) => `${n} Credit${n === 1 ? '' : 's'}`;

function panel(b: Ctx, m: Mine, myIds: Set<string>) {
  const s = b.s;
  const connect = `<button class="btn primary block" data-connect>Connect wallet</button>`;
  const withdraw = (primary = false) =>
    myIds.size ? `<button class="btn block${primary ? ' primary' : ''}" id="withdraw">Withdraw ${plural(myIds.size)}</button>` : '';

  if (s.state === 'Open') {
    if (!m)
      return `<div class="box"><h3>Add Credits</h3><p class="muted">Connect to see which of yours fit${config.sweeper ? ', or buy in from OpenSea' : ''}.</p>${connect}</div>`;
    return `<div class="box">
      <div class="box-head"><h3>Add Credits</h3><span class="muted small num" id="pick-count"></span></div>
      <p class="small" id="fit-line">Checking which of yours fit…</p>
      <div class="picker" id="picker"></div>
      <div class="stack" id="deposit-actions"></div>
      ${withdraw()}
      <p class="muted small">Withdraw any time before 80.${s.canAssemble ? '' : ' Burning opens once Jack’s Statement contract ships.'}</p>
    </div>
    ${config.sweeper ? buyPanel(80 - s.count) : ''}`;
  }

  if (s.state === 'Full') {
    const by = new Date(s.deadline * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    if (s.exitWindow) {
      const until = new Date(s.exitWindowUntil * 1000).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric' });
      return `<div class="box">
        <h3>Exit window</h3>
        <p class="muted">A Statement adapter has been proposed. Until ${until}, anyone can take their Credits out of any batch, this one included. After that the adapter is fixed forever and burning opens.</p>
        ${m ? withdraw(true) || '<p class="small muted">You have no Credits here.</p>' : connect}
      </div>`;
    }
    if (!s.canAssemble) {
      return `<div class="box">
        <h3>Locked · waiting for Jack</h3>
        <p class="muted">All 80 are in. Burning opens once Jack’s Statement contract ships and the adapter is activated; this batch then has at least 7 days to burn. If an adapter is ever proposed, a 3-day exit window opens first.</p>
      </div>`;
    }
    if ((s.arrangement === 3 || s.arrangement === 4) && Date.now() / 1000 < s.filledAt + CREATOR_GRACE) {
      const until = new Date((s.filledAt + CREATOR_GRACE) * 1000).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric' });
      if (same(s.creator, session.account)) {
        return `<div class="box" id="arrange">
          <div class="box-head"><h3>Arrange the sheet</h3><span class="muted small">Drag to reorder, or tap two to swap</span></div>
          <div class="chips presets">${(s.arrangement === 4 ? [['layout', 'As laid out']] : [['rating', 'Rarest first'], ['mint', 'Mint time'], ['number', 'Credit number'], ['deposit', 'Deposit order']]).map(([k, l]) => `<button type="button" data-preset="${k}">${l}</button>`).join('')}</div>
          <button class="btn primary block" id="burn-ordered">Burn with this order</button>
          <p class="muted small">Until ${until} only you can burn, with your order. After that anyone can, in deposit order.</p>
        </div>`;
      }
      return `<div class="box">
        <h3>Locked · creator arranging</h3>
        <p class="muted">${who(s.creator)} chose to arrange the sheet by hand and has until ${until}. After that anyone can burn in deposit order.</p>
      </div>`;
    }
    return `<div class="box">
      <h3>Locked</h3>
      <p class="muted">Anyone can burn${s.arrangement === 4 ? ', as laid out' : s.arrangement ? `, ordered by ${ARRANGEMENTS[s.arrangement === 3 ? 0 : s.arrangement].toLowerCase()}` : ''}. Caller pays ~4–7M gas. Unburned by ${by}, everyone withdraws.</p>
      ${m ? `<button class="btn primary block" id="assemble">Burn 80 → Statement</button>` : connect}
    </div>`;
  }

  if (s.state === 'Expired') {
    return `<div class="box">
      <h3>Expired</h3>
      <p class="muted">Never burned. Everyone takes their Credits back.</p>
      ${myIds.size ? withdraw(true) : m ? '<p class="small muted">You have no Credits here.</p>' : connect}
    </div>`;
  }

  // Auction or Settled
  const ended = s.highBid > 0n && Date.now() / 1000 >= s.auctionEnd;
  const per = s.payoutPerShare;
  const owed = m && m.owed > 0n ? `<button class="btn block" id="owed">Collect ${eth(m.owed)} refund</button>` : '';

  if (s.state === 'Settled') {
    const mine = m?.shares
      ? m.claimable > 0n
        ? `<div class="stack"><button class="btn primary block" id="claim">Claim ${eth(m.claimable)}</button><p class="small muted center num">${m.shares} of 80</p></div>`
        : `<p class="small muted num">Claimed · ${m.shares} of 80</p>`
      : '';
    return `<div class="box">
      <div class="bid-now"><div><span>Sold</span><strong class="num">${eth(s.highBid)}</strong></div><div><span>${s.split === 1 ? "Avg per Credit" : "Per Credit"}</span><strong class="num">${eth(per)}</strong></div></div>
      <p class="small muted">To ${link(s.highBidder)}</p>
      ${mine}${owed}
    </div>`;
  }

  const hasMin = s.highBid > 0n || s.minBid > 1n;
  const net = (s.highBid * 99n) / 100n / 80n;
  return `<div class="box">
    <div class="bid-now">
      <div><span>${s.highBid ? 'Current bid' : hasMin ? 'Reserve' : 'Opening bid'}</span><strong class="num">${s.highBid ? eth(s.highBid) : hasMin ? eth(s.minBid) : 'Any'}</strong></div>
      <div><span>${ended ? 'Ended' : 'Ends in'}</span><strong class="num"${s.highBid && !ended ? ` data-countdown="${s.auctionEnd}"` : ''}>${!s.highBid ? '24h' : ended ? '—' : until(s.auctionEnd)}</strong></div>
    </div>
    ${s.highBid ? `<p class="small muted">by ${link(s.highBidder)}</p>` : `<p class="small muted">The clock starts at the first bid.</p>`}
    ${
      ended
        ? `<button class="btn primary block" id="settle">Settle</button>`
        : m
          ? `<form class="bid-form" id="bid-form"><label class="field"><input id="bid" inputmode="decimal" autocomplete="off" placeholder="${hasMin ? minEth(s.minBid) : '0.1'}" aria-label="Bid in ETH"><span>ETH</span></label><button class="btn primary">Bid</button></form>
             <p class="small muted">${hasMin ? `Min ${minEth(s.minBid)}. ` : ''}Outbid ETH returns instantly. Late bids add 15 min.</p>`
          : connect
    }
    ${m?.shares ? `<p class="small">Your share <strong class="num">${m.shares}/80</strong>${s.highBid ? ` · <span class="num">≈${eth(net * BigInt(m.shares))}</span> now` : ''}</p>` : ''}
    ${owed}
  </div>`;
}

const BUY_STEPS = [1, 5, 10, 20, 40];

function buyPanel(room: number) {
  const steps = BUY_STEPS.filter((n) => n <= room);
  if (!steps.includes(Math.min(room, 40))) steps.push(Math.min(room, 40));
  const def = steps.includes(10) ? 10 : steps[steps.length - 1];
  return `<div class="box" id="buy">
    <div class="box-head"><h3>Buy Credits from OpenSea</h3><span class="muted small">Cheapest that fit</span></div>
    <div class="seg" role="radiogroup" aria-label="How many">${steps.map((n) => `<label><input type="radio" name="buy-n" value="${n}" ${n === def ? 'checked' : ''}><span>${n}</span></label>`).join('')}</div>
    <div id="buy-quote" class="quote muted small">Pick how many, then get a price.</div>
    <button class="btn primary block" id="buy-go">Get price</button>
    <p class="muted small">One transaction buys them and deposits them in your name. Listings that sell first are skipped and refunded.</p>
  </div>`;
}

const minEth = (wei: bigint) => (Number(wei) / 1e18).toFixed(4).replace(/\.?0+$/, '');

function bind(b: Ctx, m: Mine, myIds: Set<string>, rerender: () => void) {
  const s = b.s;
  const run = async (btn: HTMLElement | null, label: string, fn: () => Promise<unknown>, ok: string) => {
    if (btn) {
      btn.setAttribute('disabled', '');
      btn.dataset.label = btn.textContent ?? '';
      btn.textContent = label;
    }
    try {
      await fn();
      toast(ok, 'ok');
      rerender();
    } catch (e) {
      toast(errText(e), 'err', 8000);
      if (btn) {
        btn.removeAttribute('disabled');
        btn.textContent = btn.dataset.label ?? '';
      }
    }
  };
  const txNote = (h: string) => {
    const u = explorer('tx', h);
    toast(u ? 'Submitted. Waiting for confirmation…' : 'Submitted…', 'info');
  };

  document.getElementById('withdraw')?.addEventListener('click', (e) =>
    run(e.currentTarget as HTMLElement, 'Withdrawing…', async () => {
      const ids = [...myIds].map(BigInt);
      for (let i = 0; i < ids.length; i += CHUNK)
        await send({ address: s.address, abi: batchAbi, functionName: 'withdraw', args: [ids.slice(i, i + CHUNK)] }, txNote);
    }, 'Credits returned to your wallet.'),
  );

  document.getElementById('assemble')?.addEventListener('click', (e) =>
    run(e.currentTarget as HTMLElement, 'Burning…', () =>
      send({ address: s.address, abi: batchAbi, functionName: 'assemble', gas: 12_000_000n }, txNote),
    'The Statement exists. Auction is open.'),
  );

  document.getElementById('settle')?.addEventListener('click', (e) =>
    run(e.currentTarget as HTMLElement, 'Settling…', () =>
      send({ address: s.address, abi: batchAbi, functionName: 'settle' }, txNote),
    'Settled. Depositors can claim.'),
  );

  document.getElementById('claim')?.addEventListener('click', (e) =>
    run(e.currentTarget as HTMLElement, 'Claiming…', () =>
      send({ address: s.address, abi: batchAbi, functionName: 'claim', args: [session.account!] }, txNote),
    'Claimed.'),
  );

  document.getElementById('owed')?.addEventListener('click', (e) =>
    run(e.currentTarget as HTMLElement, 'Collecting…', () =>
      send({ address: s.address, abi: batchAbi, functionName: 'withdrawOwed' }, txNote),
    'Refund collected.'),
  );

  document.getElementById('bid-form')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const input = document.getElementById('bid') as HTMLInputElement;
    let value: bigint;
    try {
      value = parseEther(input.value.trim() || '0');
    } catch {
      return toast('Enter an amount in ETH.', 'err');
    }
    if (value <= 0n) return toast('Enter an amount in ETH.', 'err');
    run((e.currentTarget as HTMLElement).querySelector('button'), 'Bidding…', () =>
      send({ address: s.address, abi: batchAbi, functionName: 'bid', value }, txNote),
    'You’re the high bidder.');
  });

  // Spotlight your Credits (tap on touch; hover handled in CSS)
  document.querySelector('.spot')?.addEventListener('click', (e) => {
    const btn = e.currentTarget as HTMLElement;
    const on = btn.getAttribute('aria-pressed') !== 'true';
    btn.setAttribute('aria-pressed', String(on));
    btn.closest('.batch-art')?.classList.toggle('spotlight', on);
  });

  // A full batch's sheet closes its gaps: 80 become one image.
  const closing = document.querySelector('.sheet.closing');
  if (closing) requestAnimationFrame(() => requestAnimationFrame(() => closing.classList.add('closed')));

  // Live countdown
  const cd = document.querySelector<HTMLElement>('[data-countdown]');
  if (cd) {
    const t = setInterval(() => {
      if (!cd.isConnected) return clearInterval(t);
      cd.textContent = until(Number(cd.dataset.countdown));
    }, 1000);
  }

  if (s.state === 'Open' && m) drawPicker(b, m, rerender, run, txNote);
  if (b.ids.length) loadRatings(b, run, txNote);
  if (s.state === 'Open' && m && config.sweeper) bindBuy(s.address, run, txNote);
}

async function drawPicker(
  b: Ctx,
  m: NonNullable<Mine>,
  rerender: () => void,
  run: (btn: HTMLElement | null, label: string, fn: () => Promise<unknown>, ok: string) => Promise<void>,
  txNote: (h: string) => void,
) {
  const s = b.s;
  const el = document.getElementById('picker');
  if (!el) return;
  const room = 80 - s.count;
  const fits = await eligible(s.address, m.owned);
  if (!el.isConnected) return;
  picks = new Set([...picks].filter((p) => fits.some((f) => f.toString() === p)));

  const line = document.getElementById('fit-line');
  if (!m.owned.length) {
    if (line) line.innerHTML = `You don’t hold any Credits. <a href="https://opensea.io/collection/credits" target="_blank" rel="noopener">Find some ↗</a>`;
    el.remove();
    return;
  }
  if (!fits.length) {
    if (line) line.textContent = `None of your ${m.owned.length} Credits fit this batch’s rules.`;
    el.remove();
    return;
  }
  if (line) line.innerHTML = `<strong class="num">${fits.length}</strong> of your ${m.owned.length} Credits fit this batch.`;

  el.innerHTML = fits
    .map((id) => `<button type="button" class="pick" data-id="${id}" aria-pressed="${picks.has(id.toString())}" title="Credit #${id}"><img src="${art(id)}" alt="Credit #${id}" loading="lazy"></button>`)
    .join('');

  const actions = document.getElementById('deposit-actions')!;
  const count = document.getElementById('pick-count')!;
  const draw = () => {
    const n = picks.size;
    count.textContent = n ? `${n} of ${room}` : `${room} open`;
    const over = n > room;
    const txs = Math.ceil(n / CHUNK);
    actions.innerHTML = `
      <div class="row small"><button type="button" class="link small" id="pick-all">Select ${Math.min(fits.length, room) === fits.length ? 'all' : Math.min(fits.length, room)}</button>${n ? '<button type="button" class="link small" id="pick-none">Clear</button>' : ''}</div>
      ${
        !m.approved
          ? `<button class="btn primary block" id="approve">Approve Eighty · once</button>`
          : n
            ? `<button class="btn primary block" id="deposit" ${over ? 'disabled' : ''}>${over ? `Only ${room} open` : `Deposit ${plural(n)}${txs > 1 ? ` · ${txs} transactions` : ''}`}</button>`
            : ''
      }`;
    document.getElementById('pick-all')?.addEventListener('click', () => {
      picks = new Set(fits.slice(0, room).map(String));
      sync();
    });
    document.getElementById('pick-none')?.addEventListener('click', () => {
      picks.clear();
      sync();
    });
    document.getElementById('approve')?.addEventListener('click', (e) =>
      run(e.currentTarget as HTMLElement, 'Approving…', () =>
        send({ address: config.credits, abi: creditsAbi, functionName: 'setApprovalForAll', args: [config.factory, true] }, txNote),
      'Approved. Pick and deposit.'),
    );
    document.getElementById('deposit')?.addEventListener('click', (e) =>
      run(e.currentTarget as HTMLElement, 'Depositing…', async () => {
        const ids = [...picks].map(BigInt);
        for (let i = 0; i < ids.length; i += CHUNK)
          await send({ address: config.factory, abi: factoryAbi, functionName: 'deposit', args: [s.address, ids.slice(i, i + CHUNK)] }, txNote);
        picks.clear();
      }, 'Deposited.'),
    );
  };
  const sync = () => {
    $$<HTMLButtonElement>('.pick', el).forEach((p) => p.setAttribute('aria-pressed', String(picks.has(p.dataset.id!))));
    draw();
  };
  el.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('.pick');
    if (!btn) return;
    const id = btn.dataset.id!;
    picks.has(id) ? picks.delete(id) : picks.add(id);
    sync();
  });
  draw();
  void rerender;
}

type Quote = { orders: unknown[]; ids: string[]; prices: string[]; total: string; expires?: number | null; error?: string };
let quotedFeeBps = 0n; // the Sweeper's rate at quote time; the sweep reverts if it has been raised since

/// The orders are what gets sent to the chain; the ids/prices/total are what gets shown. Make sure they agree,
/// so a bad quote (or a tampered one) can't show ten Credits and buy one.
function checkQuote(q: Quote) {
  type Order = { parameters?: { offer?: { token?: string; identifierOrCriteria?: string; itemType?: number }[]; consideration?: { itemType?: number; startAmount?: string; endAmount?: string }[] } };
  const orders = q.orders as Order[];
  if (!Array.isArray(orders) || orders.length !== q.ids.length || q.prices.length !== q.ids.length) throw new Error('Bad quote.');
  let sum = 0n;
  orders.forEach((o, i) => {
    const offer = o.parameters?.offer ?? [];
    const cons = o.parameters?.consideration ?? [];
    if (offer.length !== 1 || Number(offer[0].itemType) !== 2 || String(offer[0].identifierOrCriteria) !== q.ids[i]) throw new Error('Bad quote.');
    if (String(offer[0].token).toLowerCase() !== config.credits.toLowerCase()) throw new Error('Bad quote.');
    const price = cons.reduce((a, c) => {
      if (Number(c.itemType) !== 0 || c.startAmount !== c.endAmount) throw new Error('Bad quote.');
      return a + BigInt(c.endAmount ?? '0');
    }, 0n);
    if (price !== BigInt(q.prices[i])) throw new Error('Bad quote.');
    sum += price;
  });
  if (sum !== BigInt(q.total)) throw new Error('Bad quote.');
}

function bindBuy(
  batch: Address,
  run: (btn: HTMLElement | null, label: string, fn: () => Promise<unknown>, ok: string) => Promise<void>,
  txNote: (h: string) => void,
) {
  const go = document.getElementById('buy-go') as HTMLButtonElement | null;
  const out = document.getElementById('buy-quote');
  if (!go || !out) return;
  let q: Quote | null = null;
  let value = 0n;
  let timer: ReturnType<typeof setInterval> | null = null;
  const stopTimer = () => {
    if (timer) clearInterval(timer);
    timer = null;
  };
  const reset = () => {
    stopTimer();
    q = null;
    go.textContent = 'Get price';
    out.textContent = 'Pick how many, then get a price.';
  };
  // OpenSea signs each fill for ~90 s; past that the sweep would revert, so the price is shown with its clock.
  const countdown = (expires: number) => {
    stopTimer();
    const el = document.getElementById('buy-expiry');
    const tick = () => {
      const left = Math.floor(expires - Date.now() / 1000);
      if (left <= 0) {
        stopTimer();
        q = null;
        go.textContent = 'Get price';
        out.innerHTML = '<p>That price has expired. Get a fresh one.</p>';
        return;
      }
      if (el) el.textContent = `Price good for ${left}s`;
    };
    tick();
    timer = setInterval(tick, 1000);
  };
  document.querySelectorAll('input[name=buy-n]').forEach((r) => r.addEventListener('change', reset));

  go.addEventListener('click', async () => {
    if (!q) {
      const n = (document.querySelector('input[name=buy-n]:checked') as HTMLInputElement | null)?.value ?? '10';
      go.disabled = true;
      go.textContent = 'Finding listings…';
      try {
        const r = await fetch(`/opensea/quote?batch=${batch}&n=${n}`);
        q = (await r.json()) as Quote;
        if (!r.ok || q.error) throw new Error(q.error ?? 'No quote');
        checkQuote(q);
        const total = BigInt(q.total);
        [value, quotedFeeBps] = (await Promise.all([
          pub.readContract({ address: config.sweeper!, abi: sweeperAbi, functionName: 'quote', args: [total] }),
          pub.readContract({ address: config.sweeper!, abi: sweeperAbi, functionName: 'feeBps' }),
        ])) as [bigint, bigint];
        out.innerHTML = `<div class="quote-row"><span>${q.ids.length} Credit${q.ids.length === 1 ? '' : 's'}</span><span class="num">${eth(total)}</span></div>
          <div class="quote-row"><span>Eighty fee</span><span class="num">${eth(value - total)}</span></div>
          <div class="quote-row total"><span>Total</span><span class="num">${eth(value)}</span></div>
          ${Number(n) > q.ids.length ? `<p>Only ${q.ids.length} listed that fit.</p>` : ''}
          ${q.expires ? '<p class="muted small num" id="buy-expiry"></p>' : ''}`;
        go.textContent = `Buy ${q.ids.length} & deposit`;
        if (q.expires) countdown(q.expires);
      } catch (e) {
        q = null;
        out.textContent = errText(e);
        go.textContent = 'Try again';
      }
      go.disabled = false;
      return;
    }
    const quote = q;
    stopTimer();
    await run(go, 'Buying…', () =>
      send({ address: config.sweeper!, abi: sweeperAbi, functionName: 'sweep', args: [batch, quote.orders, 1n, quotedFeeBps], value }, txNote),
    'Bought and deposited.');
    reset();
  });
}


/// Official ratings for the sheet: the facts row, cell tooltips, and the creator's arranger presets.
async function loadRatings(
  b: Ctx,
  run: (btn: HTMLElement | null, label: string, fn: () => Promise<unknown>, ok: string) => Promise<void>,
  txNote: (h: string) => void,
) {
  let rated: Record<string, Rated>;
  let n = 0;
  try {
    const r = await ratings(b.ids);
    rated = r.ratings;
    n = r.n;
  } catch {
    document.getElementById('rating')?.replaceChildren('unavailable');
    return;
  }
  const el = document.getElementById('rating');
  if (!el) return;
  const scores = b.ids.map((id) => rated[id.toString()]?.score).filter((x): x is number => typeof x === 'number');
  if (scores.length) {
    const avg = scores.reduce((a, x) => a + x, 0) / scores.length;
    const top = Math.max(...scores);
    el.classList.remove('muted');
    el.innerHTML = `<span class="num">avg ${fmtScore(avg)}</span> · <span class="num">top ${fmtScore(top)}</span> <a href="${RATING_URL}" target="_blank" rel="noopener" class="muted small" title="Jack Butcher’s official rating, v3.4.0, over all ${n.toLocaleString()} Credits">official ↗</a>`;
  }
  document.querySelectorAll<HTMLElement>('.batch-art .cell[data-id]').forEach((c) => {
    const r = rated[c.dataset.id!];
    if (r) c.title = `Credit #${c.dataset.id} · ${fmtScore(r.score)} · rank ${r.rank.toLocaleString()} · ${r.traits.palette} · ${r.traits.eights} eights · ${r.traits.registration}`;
  });

  const arrange = document.getElementById('arrange');
  if (!arrange) return;
  const slots = hasLayout(b.s.filter) ? Array.from({ length: 80 }, (_, i) => layoutSlot(b.s.filter, i)) : null;
  let order = [...b.ids];
  if (slots) {
    try {
      order = [...((await pub.readContract({ address: b.s.address, abi: batchAbi, functionName: 'layoutOrder' })) as readonly bigint[])];
    } catch {}
  }
  const maskOf = (id: bigint) => paletteBit(rated[id.toString()]?.traits.palette ?? '');
  /// Under a layout every painted slot must keep its palette; say which one is wrong before spending gas.
  const layoutProblem = () => {
    if (!slots) return null;
    for (let i = 0; i < 80; i++) if (slots[i] && maskOf(order[i]) !== slots[i]) return `Slot ${i + 1} needs ${maskLabel(slots[i])}.`;
    return null;
  };
  let picked: HTMLElement | null = null;
  let sortable: Sortable | null = null;
  const fromDom = (el: HTMLElement) => [...el.querySelectorAll<HTMLElement>('.cell[data-id]')].map((c) => BigInt(c.dataset.id!));
  /// Render once per preset; drags and taps then move cells in place, so Sortable can animate them.
  const draw = () => {
    sortable?.destroy();
    const holder = document.querySelector<HTMLElement>('.batch-art .sheet')!;
    holder.outerHTML = sheet(order, { closing: true, layout: slots ?? undefined });
    const sheetEl = document.querySelector<HTMLElement>('.batch-art .sheet')!;
    picked = null;
    sheetEl.querySelectorAll<HTMLElement>('.cell[data-id]').forEach((c) => {
      c.classList.add('swap');
      const r = rated[c.dataset.id!];
      if (r) c.title = `Credit #${c.dataset.id} · ${fmtScore(r.score)}`;
      // Tap one Credit, then another: they swap places.
      c.addEventListener('click', () => {
        if (!picked) {
          picked = c;
          c.classList.add('sel');
          return;
        }
        if (picked !== c) {
          const a = picked, bEl = c;
          const aNext = a.nextSibling;
          if (aNext === bEl) sheetEl.insertBefore(bEl, a);
          else {
            sheetEl.insertBefore(a, bEl);
            sheetEl.insertBefore(bEl, aNext);
          }
          order = fromDom(sheetEl);
        }
        picked.classList.remove('sel');
        picked = null;
      });
    });
    // Drag a Credit to any slot: the others shift along, animated. Fallback mode so mouse and touch match.
    sortable = Sortable.create(sheetEl, {
      animation: 150,
      forceFallback: true,
      fallbackTolerance: 6,
      draggable: '.cell[data-id]',
      ghostClass: 'drop-slot',
      dragClass: 'lifted',
      onStart: () => {
        picked?.classList.remove('sel');
        picked = null;
      },
      onEnd: () => {
        order = fromDom(sheetEl);
      },
    });
  };
  const key = {
    layout: (id: bigint) => order.indexOf(id),
    rating: (id: bigint) => -(rated[id.toString()]?.score ?? 0),
    mint: (id: bigint) => rated[id.toString()]?.paidAt ?? 0,
    number: (id: bigint) => Number(id),
  } as const;
  arrange.querySelectorAll<HTMLButtonElement>('[data-preset]').forEach((btn) =>
    btn.addEventListener('click', () => {
      const p = btn.dataset.preset as keyof typeof key | 'deposit';
      if (p === 'layout') pub.readContract({ address: b.s.address, abi: batchAbi, functionName: 'layoutOrder' }).then((o) => { order = [...(o as readonly bigint[])]; draw(); }).catch(() => {});
      else order = p === 'deposit' ? [...b.ids] : [...b.ids].sort((x, y) => key[p](x) - key[p](y) || Number(x - y));
      picked = null;
      arrange.querySelectorAll('[data-preset]').forEach((x) => x.setAttribute('aria-pressed', String(x === btn)));
      draw();
    }),
  );
  document.getElementById('burn-ordered')?.addEventListener('click', (e) => {
    const problem = layoutProblem();
    if (problem) return toast(problem, 'err');
    return run(e.currentTarget as HTMLElement, 'Burning…', () =>
      send({ address: b.s.address, abi: batchAbi, functionName: 'assembleOrdered', args: [order], gas: 12_000_000n }, txNote),
    'The Statement exists, in your order. Auction is open.');
  });
  draw();
  document.querySelector<HTMLElement>('.batch-art .sheet')?.classList.remove('closing');
}
