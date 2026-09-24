import { parseEther, type Address } from 'viem';
import { batchAbi, creditsAbi, factoryAbi } from '../abi';
import { config, explorer, send, session } from '../chain';
import { eligible, getBatch, me } from '../data';
import { describeFilter } from '../traits';
import { $$, art, errText, esc, eth, same, sheet, short, toast, until } from '../ui';

const CHUNK = 40; // Credits per transaction; keeps each one well under the block gas limit

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
  const f = describeFilter(s.filter);
  const burned = s.state === 'Auction' || s.state === 'Settled';
  const depositors = new Set(b.depositors.map((d) => d.toLowerCase())).size;

  // Cells added since this browser last saw the batch drop in, in deposit order.
  const seenKey = `eighty-seen-${address}`;
  let seen = s.count;
  try {
    seen = Number(sessionStorage.getItem(seenKey) ?? s.count);
    sessionStorage.setItem(seenKey, String(s.count));
  } catch {}

  const artHtml = burned
    ? `<figure class="statement">${sheet(b.ids, { closed: true })}<figcaption class="legend muted small"><span>Statement #${s.statementId}</span><span>80 Credits, burned in deposit order</span></figcaption></figure>`
    : `${sheet(b.ids, { mine: myIds, fresh: seen < s.count ? seen : undefined, closing: s.state === 'Full' })}
       <div class="legend muted small">${myIds.size ? `<button type="button" class="spot" aria-pressed="false"><i class="dot mine"></i>Yours: ${myIds.size}</button>` : ''}<span>In deposit order</span></div>`;

  app.innerHTML = `
  <a class="back" href="#/">← Batches</a>
  <section class="batch">
    <div class="batch-art">${artHtml}</div>
    <div class="batch-side">
      <header>
        <span class="tag ${s.state.toLowerCase()}">${s.state}</span>
        <h1>${esc(s.name || 'Untitled')}</h1>
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
        ${s.reserve && (s.state === 'Open' || s.state === 'Full' || (s.state === 'Auction' && s.minBid === s.reserve && !s.highBid)) ? fact('Reserve', eth(s.reserve)) : ''}
        ${fact('Opened by', link(s.creator))}
        ${fact('Contract', link(s.address))}
      </dl>
      <div id="panel">${panel(b, m, myIds)}</div>
    </div>
  </section>`;

  bind(b, m, myIds, rerender);
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
    if (!m) return `<div class="box"><h3>Add Credits</h3><p class="muted">Connect to see which of yours fit.</p>${connect}</div>`;
    return `<div class="box">
      <div class="box-head"><h3>Add Credits</h3><span class="muted small num" id="pick-count"></span></div>
      <div class="picker" id="picker"><p class="muted small">Checking your Credits…</p></div>
      <div class="stack" id="deposit-actions"></div>
      ${withdraw()}
      <p class="muted small">Withdraw any time before 80.</p>
    </div>`;
  }

  if (s.state === 'Full') {
    const by = new Date(s.deadline * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    return `<div class="box">
      <h3>Locked</h3>
      <p class="muted">Anyone can burn. Caller pays ~4–5M gas. Unburned by ${by}, everyone withdraws.</p>
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
      <div class="bid-now"><div><span>Sold</span><strong class="num">${eth(s.highBid)}</strong></div><div><span>Per Credit</span><strong class="num">${eth(per)}</strong></div></div>
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

  if (!m.owned.length) {
    el.outerHTML = `<p class="muted">You don’t hold any Credits. <a href="https://opensea.io/collection/credits" target="_blank" rel="noopener">Find some ↗</a></p>`;
    return;
  }
  if (!fits.length) {
    el.outerHTML = `<p class="muted">None of your ${m.owned.length} Credits match this batch’s filter.</p>`;
    return;
  }

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
