import { parseEther, type Address } from 'viem';
import { batchAbi, creditsAbi, factoryAbi, sweeperAbi } from '../abi';
import { config, explorer, pub, send, session } from '../chain';
import { ARRANGEMENTS, earlyShare, earlyWeight, sharePct, eligible, getBatch, hasLayout, layoutSlot, me, placeOnLayout, ratings, type Rated } from '../data';
import { filterRules, maskInks, maskLabel, paletteBit, type Rule } from '../traits';
import { hydrate, pct, who } from '../ens';
import { editionArt, examples, fillGhosts, registerDeposits, registerFilter } from '../ghosts';
import { $$, art, errText, esc, eth, same, sheet, short, toast, until } from '../ui';
import { stamp } from '../../shared/stamp';

const CHUNK = 40; // Credits per transaction; keeps each one well under the block gas limit
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
    app.innerHTML = `<section class="prose"><h1>Party not found</h1><p><a href="/parties">← Parties</a></p></section>`;
    return;
  }
  const account = session.account;
  const m: Mine = account ? await me(address, account) : null;
  const myIds = new Set(b.ids.filter((_, i) => same(b.depositors[i], account)).map(String));
  const s = b.s;
  const rules = filterRules(s.filter, s.allowlistSize, (i) => layoutSlot(s.filter, i));
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
        b.ids.map((id) => pub.readContract({ address: s.address, abi: batchAbi, functionName: 'keyOf', args: [id] })),
      )) as number[];
      const byId = new Map(b.ids.map((id, i) => [id.toString(), Number(pal[i])]));
      placed = placeOnLayout(slots, b.ids, (id) => byId.get(id.toString()) ?? 0);
    } catch {}
  }
  registerFilter(s.address, s.filter);
  registerDeposits(b.ids, b.depositors, b.s.split === 1);
  const artHtml = burned
    ? `<figure class="statement">${sheet(b.ids, { closed: true })}<figcaption class="legend muted small"><span>Statement #${s.statementId}</span></figcaption></figure>`
    : `${sheet(b.ids, { mine: myIds, fresh: placed ? undefined : seen < s.count ? seen : undefined, closing: s.state === 'Full', placed, batch: s.state === 'Open' ? s.address : undefined })}
       <div class="legend muted small">${myIds.size ? `<button type="button" class="spot" aria-pressed="false"><i class="dot mine"></i><span>Highlight yours</span><span class="num muted">${myIds.size}</span></button>` : ''}</div>`;

  app.innerHTML = `
  
  <section class="batch">
    <div class="batch-art">${artHtml}</div>
    <div class="batch-side">
      <header>
        <div class="row"><span class="tag ${s.state.toLowerCase()}">${s.state}</span><button type="button" class="link small" id="share">Share</button></div>
        <h1>${esc(s.name || 'Untitled')}</h1>
        <div class="byline">${who(s.creator, 'lg', true)}${s.creatorFeeBps ? `<span class="fee">${pct(s.creatorFeeBps)} creator fee</span>` : ''}</div>
      </header>
      ${
        s.state === 'Open' || s.state === 'Full' || s.state === 'Expired'
          ? `<div class="progress">
          <div class="row"><span class="num"><strong>${s.count}</strong>/80</span><span class="muted small num">${s.state === 'Open' ? `${80 - s.count} to go` : s.state === 'Full' ? (Date.now() / 1000 >= s.deadline ? 'Unlocked' : `Unlocks in ${until(s.deadline)}`) : 'Expired'}</span></div>
          <div class="bar"><i style="width:${(s.count / 80) * 100}%"></i></div>
        </div>`
          : ''
      }
      <div class="takes"><span class="eyebrow">Who can join</span><div class="rule-chips">${rules.length ? rules.map(rule).join('') : '<span class="rule-chip">Any Credit</span>'}</div></div>
      <div id="panel">${panel(b, m, myIds)}</div>
      <div class="folds">
      ${s.state === 'Auction' || s.state === 'Settled' ? `<details class="more" id="bids" open>
        <summary><span>Bids</span><span class="muted small" id="bids-count">…</span></summary>
        <ol class="bid-list" id="bid-list"><li class="muted small">Loading…</li></ol>
      </details>` : ''}
      <details class="more">
        <summary><span>Details</span><span class="muted small">${ARRANGEMENTS[s.arrangement]} · ${s.split === 1 ? 'Early bird' : 'Equal'} payout</span></summary>
        <dl class="facts">
          ${fact('Burn order', ARRANGEMENTS[s.arrangement])}
          ${fact('Payout', payout(b, myIds))}
          ${fact('Depositors', `<button type="button" class="link num" id="depositors-btn" title="Who is in">${depositors}</button>`)}
          ${s.count ? fact('Rating', `<span id="rating" class="muted">…</span>`) : ''}
          ${s.reserve && (s.state === 'Open' || s.state === 'Full' || (s.state === 'Auction' && s.minBid === s.reserve && !s.highBid)) ? fact('Reserve', eth(s.reserve)) : ''}
          ${fact('Sale split', split(s))}
          ${fact('Contract', link(s.address))}
        </dl>
      </details>
      </div>
    </div>
  </section>`;

  hydrate(app);
  document.getElementById('depositors-btn')?.addEventListener('click', () => openDepositors(b, account ?? null));
  loadBids(s.address, account ?? null);
  // Chrome keeps a focus ring on <summary> after a mouse click; drop it for pointer use only.
  app.querySelectorAll<HTMLElement>('.more summary').forEach((el) => el.addEventListener('pointerup', () => setTimeout(() => el.blur(), 0)));
  fillGhosts(app);
  // Share a link stamped with where the party stands, so X, Telegram and the rest fetch a fresh card for it
  // instead of showing the one they cached for an earlier state.
  document.getElementById('share')?.addEventListener('click', async () => {
    const url = `${location.origin}/party/${s.address}?s=${stamp(s.state, s.count, s.highBid)}`;
    try {
      if (navigator.share && matchMedia('(pointer: coarse)').matches) await navigator.share({ title: s.name || 'A party on Eighty', url });
      else {
        await navigator.clipboard.writeText(url);
        toast('Link copied', 'ok', 2500);
      }
    } catch {}
  });
  const art = app.querySelector<HTMLElement>('.batch-art');
  app.querySelectorAll<HTMLElement>('.rule-chip[data-slots]').forEach((row) => {
    row.addEventListener('pointerenter', () => {
      const cells = [...(art?.querySelector('.sheet')?.children ?? [])];
      const on = row.dataset.slots === 'all' ? null : new Set(row.dataset.slots!.split(',').map(Number));
      cells.forEach((c, i) => c.classList.toggle('lit', !on || on.has(i)));
      art?.classList.add('lighting');
    });
    row.addEventListener('pointerleave', () => {
      art?.classList.remove('lighting');
      art?.querySelectorAll('.cell.lit').forEach((c) => c.classList.remove('lit'));
    });
  });
  bind(b, m, myIds, rerender);
}

/// "Early bird · 1st 1.88% → 80th 0.63%" of the depositors' payout, plus the connected wallet's own positions and what they add up to.
function payout(b: Ctx, myIds: Set<string>) {
  if (b.s.split !== 1) return 'Equal · 1/80 each';
  const mine = b.ids.map((id, i) => [String(id), i] as const).filter(([id]) => myIds.has(id));
  const shares = mine.reduce((n, [, i]) => n + earlyShare(i), 0);
  const yours = mine.length
    ? ` <span class="muted">· yours ${mine.map(([, i]) => `#${i + 1}`).slice(0, 4).join(' ')}${mine.length > 4 ? '…' : ''} = ${sharePct(shares)}</span>`
    : '';
  return `Early bird · <span class="num">1st ${sharePct(earlyShare(0))} → 80th ${sharePct(earlyShare(79))}</span>${yours}`;
}

/// "1% protocol · 5% creator · 94% to depositors"
function split(s: Ctx['s']) {
  const rest = 10_000 - s.protocolFeeBps - s.creatorFeeBps;
  return [`${pct(s.protocolFeeBps)} protocol`, s.creatorFeeBps ? `${pct(s.creatorFeeBps)} creator` : '', `${pct(rest)} depositors`]
    .filter(Boolean)
    .join(' · ');
}

const fact = (k: string, v: string) => `<div><dt>${k}</dt><dd>${v}</dd></div>`;
/// A rule row; hovering it lights the slots it governs on the sheet (every slot unless it's a layout row).
const rule = (r: Rule) =>
  `<span class="rule-chip" data-slots="${r.slots ? r.slots.join(',') : 'all'}">${r.swatch ? `<span class="swatches">${maskInks(r.swatch).map((c) => `<i style="background:${c}"></i>`).join('')}</span>` : ''}${esc(r.label)} <span class="num">${esc(r.value)}</span></span>`;
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
    // Two ways in, one box: your own Credits, or OpenSea listings that fit. Buy leads when you hold none.
    const start = !m || !m.owned.length ? 'buy' : 'mine';
    return `<div class="box add">
      <div class="box-head"><h3>Add Credits</h3><span class="muted small num" id="pick-count"></span></div>
      <div class="subtabs" role="tablist">
        <button type="button" role="tab" data-add="mine" aria-selected="${start === 'mine'}">Your Credits <span class="num" id="n-mine"></span></button>
        <button type="button" role="tab" data-add="buy" aria-selected="${start === 'buy'}">Buy on OpenSea</button>
      </div>
      <div data-pane="mine"${start === 'mine' ? '' : ' hidden'}>
        ${
          m
            ? `<p class="small" id="fit-line">Checking your Credits…</p>
        <div class="picker" id="picker"></div>
        <div class="stack" id="deposit-actions"></div>
        ${withdraw()}`
            : `<p class="muted small">Connect to see which of your Credits fit.</p>${connect}`
        }
      </div>
      <div data-pane="buy"${start === 'buy' ? '' : ' hidden'}>${buyPane(!!m)}</div>
      <p class="muted small pane-note"><span id="buy-line">Finding the cheapest listings that fit… </span>Withdraw anytime until the party fills. Eighty is unofficial and experimental, so use it at your own risk.</p>
    </div>`;
  }

  if (s.state === 'Full') {
    // A full party is locked for 7 days after filling (summary.deadline = when it unlocks). Unburned by then,
    // anyone may take their Credits back; whoever stays keeps it burnable.
    const unlocked = Date.now() / 1000 >= s.deadline;
    const on = new Date(s.deadline * 1000).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric' });
    const lock = unlocked
      ? `<p class="muted small">Unlocked: take your Credits back, or stay for the burn.</p>${withdraw()}`
      : `<p class="muted small">Locked until ${on}. If it isn’t burned by then, anyone can take their Credits back.</p>`;
    if (s.exitWindow) {
      const until = new Date(s.exitWindowUntil * 1000).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
      return `<div class="box">
        <h3>Burning switches on at ${until}</h3>
        <p class="muted">Until then anyone can take their Credits out of any party, even a full one.</p>
        ${m ? withdraw(true) || '<p class="small muted">You have no Credits here.</p>' : connect}
      </div>`;
    }
    if (!s.canAssemble) {
      return `<div class="box">
        <h3>Full</h3>
        <p class="muted">Burning opens when Jack’s Statement contract ships.</p>
        ${lock}
      </div>`;
    }
    return `<div class="box">
      <h3>${unlocked ? 'Full' : 'Locked'}</h3>
      <p class="muted">Anyone can burn it.</p>
      ${m ? `<button class="btn primary block" id="assemble">Burn 80 → Statement</button>` : connect}
      ${lock}
    </div>`;
  }

  if (s.state === 'Expired') {
    return `<div class="box">
      <h3>Expired</h3>
      <p class="muted">Not burned in time. Credits can be withdrawn.</p>
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
      <div><span>${s.highBid ? 'Current bid' : hasMin ? 'Reserve' : 'Opening bid'}</span><strong class="num">${s.highBid ? eth(s.highBid) : hasMin ? eth(s.minBid) : 'Any'}</strong><em class="sub">${s.highBid ? `by ${who(s.highBidder, 'sm', true)}` : 'The clock starts at the first bid.'}</em></div>
      <div><span>${ended ? 'Ended' : 'Ends in'}</span><strong class="num"${s.highBid && !ended ? ` data-countdown="${s.auctionEnd}"` : ''}>${!s.highBid ? '24h' : ended ? '—' : until(s.auctionEnd)}</strong>${!ended ? '<em class="sub">Late bids add 15 min</em>' : ''}</div>
    </div>
    ${
      ended
        ? `<button class="btn primary block" id="settle">Settle</button>`
        : m
          ? `<form class="bid-form" id="bid-form"><label class="field"><input id="bid" inputmode="decimal" autocomplete="off" placeholder="${hasMin ? minEth(s.minBid) : '0.1'}" aria-label="Bid in ETH"><span>ETH</span></label><button class="btn primary">Bid</button></form>
             <p class="small muted">${hasMin ? `Min ${minEth(s.minBid)}. ` : ''}Outbid ETH returns instantly. Eighty is unofficial and experimental, so use it at your own risk.</p>`
          : connect
    }
    ${m?.shares ? `<p class="small">Your share <strong class="num">${m.shares}/80</strong>${s.highBid ? ` · <span class="num">≈${eth(net * BigInt(m.shares))}</span> now` : ''}</p>` : ''}
    ${owed}
  </div>`;
}

const BUY_COUNTS = [1, 5, 10];

function buyPane(connected: boolean) {
  // How many and the running total on one line; the Credits; then one button that carries the price.
  return `<div class="buy-head"><div class="seg sm" role="radiogroup" aria-label="How many">${BUY_COUNTS.map((n) => `<label><input type="radio" name="buy-n" value="${n}" ${n === 5 ? 'checked' : ''}><span>${n}</span></label>`).join('')}</div><span class="num" id="buy-sub"></span></div>
    <div class="listings" id="listings">${'<span class="listing skel" aria-hidden="true"><span class="art"></span><span class="price"></span></span>'.repeat(5)}</div>
    <div id="buy-quote" class="quote small"></div>
    ${connected || !config.sweeper ? `<button class="btn primary block" id="buy-go" disabled>Buy</button>` : '<button class="btn primary block" data-connect>Connect to buy</button>'}
`;
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
  if (s.state === 'Open') {
    document.querySelectorAll<HTMLButtonElement>('[data-add]').forEach((t) =>
      t.addEventListener('click', () => {
        document.querySelectorAll('[data-add]').forEach((x) => x.setAttribute('aria-selected', String(x === t)));
        document.querySelectorAll<HTMLElement>('[data-pane]').forEach((p) => (p.hidden = p.dataset.pane !== t.dataset.add));
      }),
    );
    bindBuy(b, !!m, run, txNote);
  }
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
  const mineCount = document.getElementById('n-mine');
  if (mineCount) mineCount.textContent = fits.length ? String(fits.length) : '';
  // Nothing of yours fits: lead with buying.
  if (!fits.length) document.querySelector<HTMLButtonElement>('[data-add="buy"]:not([aria-selected="true"])')?.click();
  if (!fits.length) {
    // Nothing to deposit: say so, and point at the other ways in.
    if (line)
      line.outerHTML = `<div class="empty-mine">
        <p>${m.owned.length ? `None of your ${m.owned.length} Credits fit this party’s rules.` : 'You don’t hold any Credits yet.'}</p>
        <button type="button" class="btn block" data-go-buy>Buy on OpenSea</button>
        ${config.chainId !== 1 ? '<a class="small" href="/mint">Mint test Credits</a>' : ''}
      </div>`;
    document.querySelector('[data-go-buy]')?.addEventListener('click', () => document.querySelector<HTMLButtonElement>('[data-add="buy"]')?.click());
    el.remove();
    return;
  }
  if (line) line.innerHTML = `<strong class="num">${fits.length}</strong> of your ${m.owned.length} Credits fit this party.`;

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

/// The Buy tab: pick 1, 5 or 10 and the cheapest live OpenSea listings that fit fill in, with prices; then a
/// signed price for exactly those. Where buy-in is off (testnets), it previews edition Credits that fit, disabled.
async function bindBuy(
  b: Ctx,
  connected: boolean,
  run: (btn: HTMLElement | null, label: string, fn: () => Promise<unknown>, ok: string) => Promise<void>,
  txNote: (h: string) => void,
) {
  const batch = b.s.address;
  const line = document.getElementById('buy-line');
  const grid = document.getElementById('listings');
  const out = document.getElementById('buy-quote');
  const go = document.getElementById('buy-go') as HTMLButtonElement | null;
  if (!line || !grid || !out) return;
  const room = 80 - b.s.count;
  const tile = (id: string | number, src: string, price: string | null) =>
    `<button type="button" class="listing" data-id="${id}" aria-pressed="false" title="Credit #${id}${price === null ? '' : ' · tap to skip'}"${price === null ? ' disabled' : ''}><span class="art"><img src="${src}" alt="" loading="lazy" decoding="async"></span><span class="price num">${price === null ? `#${id}` : `${minEth(BigInt(price))} ETH`}</span></button>`;

  let listings: { id: string; price: string }[] = [];
  // preview: no OpenSea key here, so edition Credits stand in. mainnetOnly: real mainnet listings and prices,
  // but this party is on a testnet and can't take them.
  let preview = false;
  let mainnetOnly = false;
  try {
    const r = await fetch(`/opensea/listings?batch=${batch}`);
    if (r.status === 501) preview = true;
    else {
      const d = (await r.json()) as { listings?: typeof listings; preview?: boolean; error?: string };
      if (!r.ok || d.error) throw new Error(d.error ?? 'OpenSea is unavailable right now.');
      listings = d.listings ?? [];
      mainnetOnly = !!d.preview;
    }
  } catch (e) {
    line.textContent = "Couldn’t load OpenSea listings right now. "; console.warn("[buy] listings", e);
    return;
  }
  if (!grid.isConnected) return;

  // Pick how many; the cheapest that fit fill the row. Tap one to skip it and the next cheapest takes its place.
  const pool: { id: string; price: string | null }[] = preview
    ? (await examples(b.s.filter)).map((id) => ({ id: String(id), price: null }))
    : listings;
  const skipped = new Set<string>();
  let q: Quote | null = null;
  let value = 0n;
  let timer: ReturnType<typeof setInterval> | null = null;
  const stopTimer = () => {
    if (timer) clearInterval(timer);
    timer = null;
  };
  const want = () => Math.min(Number((document.querySelector('input[name=buy-n]:checked') as HTMLInputElement | null)?.value ?? 5), room, 40);
  const chosen = () => pool.filter((l) => !skipped.has(l.id)).slice(0, want());
  const draw = () => {
    stopTimer();
    q = null;
    const pick = chosen();
    grid.classList.toggle('preview', preview);
    grid.innerHTML = pick.map((l) => tile(l.id, preview || mainnetOnly ? editionArt(Number(l.id)) : art(BigInt(l.id)), l.price)).join('');
    const sub = pick.reduce((a, l) => a + (l.price ? BigInt(l.price) : 0n), 0n);
    const subEl = document.getElementById('buy-sub');
    if (subEl) subEl.textContent = pick.length && !preview ? eth(sub) : '';
    line.textContent = (preview || mainnetOnly
      ? '' // testnet: the banner already says it's a preview
      : !pool.length
        ? 'No listings fit right now.'
        : pick.length < want()
          ? `Only ${pick.length} listed that fit.`
          : '') + ' ';
    line.hidden = !line.textContent.trim();
    out.innerHTML = '';
    if (go) {
      go.disabled = preview || mainnetOnly || !pick.length || !connected;
      go.textContent = pick.length && !preview ? `Buy ${plural(pick.length)} · ${eth(sub)}` : 'Buy';
    }
  };
  document.querySelectorAll('input[name=buy-n]').forEach((r) => r.addEventListener('change', draw));
  grid.addEventListener('click', (e) => {
    const t = (e.target as HTMLElement).closest<HTMLElement>('.listing');
    if (!t || preview) return;
    skipped.add(t.dataset.id!);
    draw();
  });
  // OpenSea signs each fill for ~90 s; past that the sweep would revert, so the price is shown with its clock.
  const countdown = (expires: number) => {
    stopTimer();
    const el = document.getElementById('buy-expiry');
    const tick = () => {
      const left = Math.floor(expires - Date.now() / 1000);
      if (left <= 0) {
        stopTimer();
        q = null;
        if (go) go.textContent = `Buy ${plural(chosen().length)}`;
        out.innerHTML = '<p>That price has expired. Get a fresh one.</p>';
        return;
      }
      if (el) el.textContent = `Price good for ${left}s`;
    };
    tick();
    timer = setInterval(tick, 1000);
  };
  draw();
  if (!go || !connected || preview || mainnetOnly) return;

  go.addEventListener('click', async () => {
    if (!q) {
      go.disabled = true;
      go.textContent = 'Getting price…';
      try {
        const r = await fetch(`/opensea/quote?batch=${batch}&ids=${chosen().map((l) => l.id).join(',')}`);
        q = (await r.json()) as Quote;
        if (!r.ok || q.error) throw new Error(q.error ?? 'No quote');
        checkQuote(q);
        const total = BigInt(q.total);
        [value, quotedFeeBps] = (await Promise.all([
          pub.readContract({ address: config.sweeper!, abi: sweeperAbi, functionName: 'quote', args: [total] }),
          pub.readContract({ address: config.sweeper!, abi: sweeperAbi, functionName: 'feeBps' }),
        ])) as [bigint, bigint];
        out.innerHTML = `<div class="quote-row"><span>${plural(q.ids.length)}</span><span class="num">${eth(total)}</span></div>
          <div class="quote-row"><span>Eighty fee</span><span class="num">${eth(value - total)}</span></div>
          <div class="quote-row total"><span>Total</span><span class="num">${eth(value)}</span></div>
          ${chosen().length > q.ids.length ? `<p>${chosen().length - q.ids.length} no longer available.</p>` : ''}
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
    if (r) c.dataset.rating = fmtScore(r.score); // shown in the slot tooltip (no native title: it would cover the tooltip)
  });

  document.querySelector<HTMLElement>('.batch-art .sheet')?.classList.remove('closing');
}


/// Who is in: every depositor, most Credits first, with their share of the sale and a few of their Credits.
/// Hovering a row lights their cells on the sheet.
function openDepositors(b: Ctx, account: string | null) {
  const s = b.s;
  const rows = new Map<string, { addr: Address; ids: bigint[]; shares: number }>();
  b.ids.forEach((id, i) => {
    const addr = b.depositors[i];
    const key = addr.toLowerCase();
    const r = rows.get(key) ?? { addr, ids: [], shares: 0 };
    r.ids.push(id);
    r.shares += s.split === 1 ? earlyWeight(i) : 1;
    rows.set(key, r);
  });
  const list = [...rows.values()].sort((x, y) => y.shares - x.shares || y.ids.length - x.ids.length);
  const total = list.reduce((n, r) => n + r.shares, 0) || 1;
  const d = document.createElement('dialog');
  d.className = 'people';
  d.innerHTML = `<form method="dialog">
    <header class="row"><h3>Who’s in <span class="muted num">${list.length}</span></h3><button type="submit" class="btn sm" aria-label="Close">Close</button></header>
    <ol class="people-list">${list
      .map(
        (r) => `<li class="person" data-owner="${esc(r.addr.toLowerCase())}">
          <div class="row">${who(r.addr, 'sm', true)}<span class="tags">${same(r.addr, s.creator) ? '<span class="tag">Creator</span>' : ''}${account && same(r.addr, account) ? '<span class="tag you">You</span>' : ''}</span></div>
          <div class="row muted small"><span class="num">${r.ids.length} Credit${r.ids.length === 1 ? '' : 's'}</span><span class="num">${s.split === 1 ? `${r.shares.toFixed(2)} shares · ` : ''}${((r.shares / total) * 100).toFixed(1)}% of the sale</span></div>
          <div class="person-art">${r.ids.slice(0, 8).map((id) => `<img src="${art(id)}" alt="" title="Credit #${id}" loading="lazy">`).join('')}${r.ids.length > 8 ? `<span class="muted small num">+${r.ids.length - 8}</span>` : ''}</div>
        </li>`,
      )
      .join('')}</ol>
  </form>`;
  document.body.append(d);
  hydrate(d);
  const cells = [...document.querySelectorAll<HTMLElement>('.batch-art .cell[data-id]')];
  const owner = new Map(b.ids.map((id, i) => [id.toString(), b.depositors[i].toLowerCase()]));
  d.querySelectorAll<HTMLElement>('.person').forEach((li) => {
    const lit = () => cells.forEach((c) => c.classList.toggle('lit', owner.get(c.dataset.id!) === li.dataset.owner));
    li.addEventListener('pointerenter', lit);
    li.addEventListener('focusin', lit);
    li.addEventListener('pointerleave', () => cells.forEach((c) => c.classList.remove('lit')));
  });
  d.addEventListener('close', () => {
    cells.forEach((c) => c.classList.remove('lit'));
    d.remove();
  });
  d.showModal();
}


/// The auction's bids, newest first: amount, who, when, and the transaction.
async function loadBids(address: Address, account: string | null) {
  const list = document.getElementById('bid-list');
  const count = document.getElementById('bids-count');
  if (!list || !count) return;
  type Row = { bidder: Address; amount: string; end: number; block: number; tx: string; time: number };
  let rows: Row[] = [];
  try {
    const r = await fetch(`/bids/${address}`);
    const j = (await r.json()) as { bids?: Row[]; error?: string };
    if (!r.ok || j.error) throw new Error(j.error ?? 'No bids');
    rows = j.bids ?? [];
  } catch {
    count.textContent = 'unavailable';
    list.innerHTML = '';
    return;
  }
  count.textContent = rows.length ? `${rows.length} bid${rows.length === 1 ? '' : 's'}` : 'None yet';
  const ago = (t: number) => {
    const d = Math.max(0, Math.floor(Date.now() / 1000 - t));
    return d < 60 ? 'just now' : d < 3600 ? `${Math.floor(d / 60)}m ago` : d < 86400 ? `${Math.floor(d / 3600)}h ago` : `${Math.floor(d / 86400)}d ago`;
  };
  list.innerHTML = rows.length
    ? rows
        .map(
          (r, i) => `<li class="bid${i === 0 ? ' high' : ''}">
            <span class="num bid-amt">${eth(BigInt(r.amount))}</span>
            <span class="bid-who">${who(r.bidder, 'sm', true)}${account && same(r.bidder, account) ? '<span class="tag you">You</span>' : ''}</span>
            ${explorer('tx', r.tx)
              ? `<a class="muted small num bid-when" href="${explorer('tx', r.tx)}" target="_blank" rel="noopener" title="View transaction">${r.time ? ago(r.time) : 'tx'} ↗</a>`
              : `<span class="muted small num bid-when">${r.time ? ago(r.time) : ''}</span>`}
          </li>`,
        )
        .join('')
    : '';
  hydrate(list);
}
