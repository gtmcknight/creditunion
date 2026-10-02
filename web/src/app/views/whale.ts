/// Auctions → Multibid (/auctions/multibid, and /whale): every live auction in one list. Tick the ones you want,
/// set what you bid on each (or one amount for all of them), and send them together. Where the wallet can bundle calls (EIP-5792) it's one step, all or nothing: if
/// anyone outbids you on one before it lands, none go through. Other wallets get one bid after another, each checked
/// against that auction's next bid right before it's sent. Every bid has to be the new high bid.
import { parseEther, type Address } from 'viem';
import { batchAbi } from '../abi';
import { canBatch, pub, send, sendBatch, session } from '../chain';
import { listBatches, type Listed, type Summary } from '../data';
import { ens, hydrate, who } from '../ens';
import { errText, esc, eth, ethNum, same, statementArt, timeLeft, toast } from '../ui';

/// Biddable now: at auction, and its clock (if a first bid started it) still running.
const biddable = (s: Summary) => s.state === 'Auction' && !(s.highBid && Date.now() / 1000 >= s.auctionEnd);

const LATE = 15 * 60;

/// An amount as typed, in wei; null when it isn't one.
function weiOf(v: string): bigint | null {
  const t = v.trim();
  if (!/^\d*\.?\d+$|^\d+\.$/.test(t)) return null;
  try {
    return parseEther(t);
  } catch {
    return null;
  }
}

let whaleRun = 0;
/// The column the table is sorted by, from its headers: a click picks a column, a second flips it. Each column first
/// sorts the way you'd read it: #1 and A first, the most members, bids and ETH first, the soonest to end first.
type Col = 'name' | 'creator' | 'members' | 'bids' | 'now' | 'by' | 'ends';
const FIRST: Record<Col, 1 | -1> = { name: 1, creator: 1, members: -1, bids: -1, now: -1, by: 1, ends: 1 };
let sortCol: Col = 'ends', sortDir: 1 | -1 = 1;
try {
  const [c, d] = (localStorage.getItem('cu-multibid-sort') ?? '').split(':');
  if (c in FIRST) (sortCol = c as Col), (sortDir = d === '-1' ? -1 : 1);
} catch {}
/// ETH the way a statement prints it: three places, so the points line up down a column (the unit is in the header).
const ledger = (wei: bigint, up = false) => {
  const [i, d = ''] = ethNum(wei, 3, up).split('.');
  return `${i}.${d.padEnd(3, '0')}`;
};
const left = timeLeft; // hours and minutes until the last five minutes
/// Draws into `host` (the Auctions page's tab body) and keeps itself current until `host` shows something else.
export async function whale(host: HTMLElement) {
  const run = ++whaleRun;
  host.innerHTML = `<div id="whale-body" class="whale"><p class="muted">Reading auctions…</p></div>`;

  let list: Listed[] = [];
  const picked = new Set<string>(); // lowercased union addresses
  const amounts = new Map<string, string>();
  let each = '';
  let busy = false;
  // Whether this wallet bundles calls (EIP-5792): one confirmation for all, or one per bid. Null until asked.
  let bundles: boolean | null = null;
  let asked = '';
  // Bids per auction, from the activity feed (a few seconds behind the chain).
  let bidCount = new Map<string, number>();

  const read = async () => {
    const [all, counts] = await Promise.all([
      listBatches(),
      fetch('/activity.json?bids').then((r) => r.json() as Promise<{ bids?: Record<string, number> }>).catch(() => ({}) as { bids?: Record<string, number> }),
    ]);
    if (counts.bids) bidCount = new Map(Object.entries(counts.bids));
    list = all.filter((b) => biddable(b.s));
    await order();
    for (const k of [...picked]) if (!list.some((b) => b.s.address.toLowerCase() === k)) picked.delete(k); // ended since
  };

  const row = (b: Listed) => {
    const s = b.s, k = s.address.toLowerCase();
    const lead = !!session.account && !!s.highBid && same(s.highBidder, session.account);
    // One line each, under the column names: bids so far, the high bid and who holds it, its clock, and your bid,
    // whose box shows the next bid until you type.
    const n = Math.max(bidCount.get(k) ?? 0, s.highBid ? 1 : 0);
    const members = new Set(b.depositors.map((d) => d.toLowerCase())).size;
    const ends = s.highBid
      ? `<span class="ends${s.auctionEnd - Date.now() / 1000 < LATE ? ' late' : ''}" data-ends="${s.auctionEnd}">${left(s.auctionEnd)}</span>`
      : '24h';
    const next = ledger(s.minBid, true);
    return `<label class="whale-row${picked.has(k) ? ' on' : ''}${lead ? ' lead' : ''}" data-union="${k}">
      <input type="checkbox" class="whale-pick"${picked.has(k) ? ' checked' : ''} aria-label="Bid on ${esc(s.name || 'this Statement')}">
      <a class="whale-art statement-host" href="/union/${s.address}" tabindex="-1" aria-hidden="true">${statementArt(s.statementId)}</a>
      <a class="whale-name" href="/union/${s.address}">${esc(s.name || 'Untitled')} <span class="stmt-no num">#${s.statementId}</span></a>
      <span class="whale-creator small">${who(s.creator, 'sm', 'nested')}</span>
      <span class="whale-members muted small num">${members}</span>
      <span class="whale-bids muted small num">${n}</span>
      <strong class="whale-now num">${s.highBid ? ledger(s.highBid) : ''}</strong>
      <span class="whale-by small">${!s.highBid ? '' : lead ? '<span class="meta-win">You</span>' : who(s.highBidder, 'sm', 'nested')}</span>
      <span class="whale-ends muted small num">${ends}</span>
      <input type="text" inputmode="decimal" class="whale-amt num" value="${esc(amounts.get(k) ?? '')}" placeholder="${next}" title="Next bid ${next}" aria-label="Your bid in ETH (next bid ${next})">
    </label>`;
  };

  // What's picked, what it adds up to, and what's wrong with it.
  const check = () => {
    let total = 0n;
    const low: Listed[] = [], blank: Listed[] = [];
    for (const b of list) {
      const k = b.s.address.toLowerCase();
      if (!picked.has(k)) continue;
      const w = weiOf(amounts.get(k) ?? '');
      if (w === null) blank.push(b);
      else {
        total += w;
        if (w < b.s.minBid) low.push(b);
      }
    }
    return { n: picked.size, total, low, blank };
  };

  const bar = () => {
    const { n, total, low, blank } = check();
    const why = !n ? 'Pick the auctions to bid on.' : blank.length ? `Set a bid for ${blank.length === 1 ? esc(blank[0].s.name || 'one') : `${blank.length} of them`}.` : low.length ? `${low.length === 1 ? 'One bid is' : `${low.length} bids are`} under the next bid. Each has to be the new high bid.` : '';
    const ok = !!n && !why && !busy;
    // Before you click, how many times the wallet will ask.
    const asks = !why && n > 1 && bundles !== null ? (bundles ? `One confirmation for all ${n}.` : `${n} confirmations, one per bid: this wallet can’t bundle them.`) : '';
    return `<div class="whale-bar"><span class="whale-sum num">${n ? `${n} ${n === 1 ? 'auction' : 'auctions'} · ${eth(total)}` : ''}</span><span class="whale-why small">${why || asks}</span>${
      session.account
        ? `<button type="button" class="btn primary" id="whale-go"${ok ? '' : ' disabled'}>${busy ? 'Bidding…' : n ? `Bid on ${n}` : 'Bid'}</button>`
        : '<button type="button" class="btn primary" data-connect>Connect to bid</button>'
    }</div>`;
  };

  // A column name sorts by it; the sorted one carries an arrow.
  const head = (col: Col, label: string) => {
    const on = sortCol === col;
    return `<button type="button" class="whale-sort whale-${col}${on ? ' on' : ''}" data-col="${col}" aria-label="Sort by ${label}${on ? (sortDir === 1 ? ', ascending' : ', descending') : ''}">${label}${on ? `<span class="whale-arrow" aria-hidden="true">${sortDir === 1 ? '↑' : '↓'}</span>` : ''}</button>`;
  };

  const draw = () => {
    const body = document.getElementById('whale-body');
    if (!body || run !== whaleRun) return;
    if (!list.length) {
      body.innerHTML = '<p class="muted">Nothing at auction right now. Statements show up here as Credit Unions burn.</p>';
      return;
    }
    askWallet();
    body.innerHTML = `
      <p class="whale-lede muted">Pick the auctions you want and what to bid on each. They go in together, and each has to be the new high bid.</p>
      <div class="whale-each"><label>Bid <input type="text" inputmode="decimal" id="whale-each" class="num" value="${esc(each)}" placeholder="1.0" aria-label="ETH on each"> ETH on each one you pick</label>
        <span class="whale-acts"><button type="button" class="btn sm" id="whale-next">Next bid on each</button><button type="button" class="btn sm" id="whale-all">${picked.size === list.length ? 'Clear' : 'Pick all'}</button></span></div>
      <div class="whale-list"><div class="whale-head small muted"><span></span><span></span>${head('name', 'Statement')}${head('creator', 'Creator')}${head('members', 'Members')}${head('bids', 'Bids')}${head('now', 'High bid (ETH)')}${head('by', 'Bidder')}${head('ends', 'Time left')}<span class="whale-amt">Your bid (ETH)</span></div>${list.map(row).join('')}</div>
      ${bar()}`;
    hydrate(body);
    for (const b of list) {
      const k = b.s.address.toLowerCase();
      const w = weiOf(amounts.get(k) ?? '');
      if (picked.has(k) && w !== null && w < b.s.minBid) body.querySelector(`[data-union="${k}"]`)?.classList.add('low');
    }
  };

  // The table in its column's order. The name columns sort by ENS name where there is one (asked once, kept).
  const names = new Map<string, string>();
  async function order() {
    if (sortCol === 'creator' || sortCol === 'by') {
      const want = [...new Set(list.map((b) => (sortCol === 'creator' ? b.s.creator : b.s.highBidder).toLowerCase()))].filter((a) => !names.has(a));
      const got = await Promise.all(want.map((a) => ens(a as Address).catch(() => ({ name: null }))));
      want.forEach((a, i) => names.set(a, got[i].name?.toLowerCase() ?? '')); // '' for no name: after every name
    }
    const key = (b: Listed): number | bigint | string | null => {
      const s = b.s;
      if (sortCol === 'name') return s.statementId;
      if (sortCol === 'creator') return names.get(s.creator.toLowerCase()) || null;
      if (sortCol === 'members') return new Set(b.depositors.map((d) => d.toLowerCase())).size;
      if (sortCol === 'bids') return bidCount.get(s.address.toLowerCase()) ?? 0;
      if (sortCol === 'now') return s.highBid;
      if (sortCol === 'by') return (s.highBid && names.get(s.highBidder.toLowerCase())) || null;
      return s.highBid ? s.auctionEnd : null; // ends: no clock until a first bid
    };
    list.sort((a, b) => {
      const x = key(a), y = key(b);
      if (x === null || y === null) return x === y ? 0 : x === null ? 1 : -1; // nothing to show sorts last either way
      const n = y as number | bigint;
      const c = typeof x === 'string' ? x.localeCompare(String(y)) : x < n ? -1 : x > n ? 1 : 0;
      return c * sortDir || a.s.auctionEnd - b.s.auctionEnd;
    });
  }

  // Only the bar and the row's marks change while typing, so the field keeps its focus and caret.
  const askWallet = () => {
    const me = session.account?.toLowerCase() ?? '';
    if (!me || asked === me) return;
    asked = me;
    void canBatch().then((b) => {
      bundles = b;
      if (session.account?.toLowerCase() === me) refresh();
    });
  };

  const refresh = (k?: string) => {
    const body = document.getElementById('whale-body');
    if (!body) return;
    askWallet();
    if (k) {
      const r = body.querySelector<HTMLElement>(`[data-union="${k}"]`);
      const b = list.find((x) => x.s.address.toLowerCase() === k);
      if (r && b) {
        const w = weiOf(amounts.get(k) ?? '');
        r.classList.toggle('on', picked.has(k));
        r.classList.toggle('low', picked.has(k) && w !== null && w < b.s.minBid);
        r.querySelector<HTMLInputElement>('.whale-pick')!.checked = picked.has(k);
      }
    }
    body.querySelector('.whale-bar')!.outerHTML = bar();
    const all = body.querySelector('#whale-all');
    if (all) all.textContent = picked.size === list.length ? 'Clear' : 'Pick all';
  };

  // A pick takes the amount for each when there is one, else its next bid: the least that leads.
  const pick = (k: string, on: boolean) => {
    const b = list.find((x) => x.s.address.toLowerCase() === k);
    if (!b) return;
    if (on) {
      picked.add(k);
      if (!amounts.get(k)) amounts.set(k, each || ethNum(b.s.minBid, 3, true));
    } else picked.delete(k);
    const input = document.querySelector<HTMLInputElement>(`[data-union="${k}"] .whale-amt`);
    if (input) input.value = amounts.get(k) ?? '';
    refresh(k);
  };

  const body = document.getElementById('whale-body')!;
  body.addEventListener('change', (e) => {
    const t = e.target as HTMLElement;
    if (t.classList.contains('whale-pick')) pick(t.closest<HTMLElement>('[data-union]')!.dataset.union!, (t as HTMLInputElement).checked);
  });
  body.addEventListener('input', (e) => {
    const t = e.target as HTMLInputElement;
    if (t.id === 'whale-each') {
      each = t.value.trim();
      for (const k of picked) {
        amounts.set(k, each);
        const input = body.querySelector<HTMLInputElement>(`[data-union="${k}"] .whale-amt`);
        if (input) input.value = each;
        refresh(k);
      }
      refresh();
    } else if (t.classList.contains('whale-amt')) {
      const k = t.closest<HTMLElement>('[data-union]')!.dataset.union!;
      amounts.set(k, t.value.trim());
      if (!picked.has(k) && t.value.trim()) picked.add(k);
      refresh(k);
    }
  });
  body.addEventListener('click', async (e) => {
    const t = e.target as HTMLElement;
    const sorter = t.closest<HTMLElement>('.whale-sort');
    if (sorter) {
      const col = sorter.dataset.col as Col;
      sortDir = col === sortCol ? (sortDir === 1 ? -1 : 1) : FIRST[col];
      sortCol = col;
      try {
        localStorage.setItem('cu-multibid-sort', `${sortCol}:${sortDir}`);
      } catch {}
      await order();
      draw();
      return;
    }
    if (t.id === 'whale-all') {
      const on = picked.size !== list.length;
      for (const b of list) pick(b.s.address.toLowerCase(), on);
      return;
    }
    // Each picked auction (all of them when none is) at its next bid: the least that leads.
    if (t.id === 'whale-next') {
      if (!picked.size) for (const b of list) picked.add(b.s.address.toLowerCase());
      each = '';
      const all = body.querySelector<HTMLInputElement>('#whale-each');
      if (all) all.value = '';
      for (const b of list) {
        const k = b.s.address.toLowerCase();
        if (!picked.has(k)) continue;
        amounts.set(k, ledger(b.s.minBid, true));
        const input = body.querySelector<HTMLInputElement>(`[data-union="${k}"] .whale-amt`);
        if (input) input.value = amounts.get(k)!;
        refresh(k);
      }
      refresh();
      return;
    }
    if (t.id === 'whale-go') await go();
  });

  // Every picked bid checked against the chain right now, then sent: bundled where the wallet can, else in turn.
  async function go() {
    const me = session.account;
    const chosen = list.filter((b) => picked.has(b.s.address.toLowerCase()));
    if (!me || !chosen.length || busy) return;
    busy = true;
    refresh();
    try {
      const fresh = await Promise.all(chosen.map((b) => pub.readContract({ address: b.s.address, abi: batchAbi, functionName: 'minBid' }) as Promise<bigint>));
      const bids = chosen.map((b, i) => ({ b, min: fresh[i], value: weiOf(amounts.get(b.s.address.toLowerCase()) ?? '')! }));
      for (const x of bids) x.b.s.minBid = x.min;
      const under = bids.filter((x) => x.value < x.min);
      if (under.length) {
        throw new Error(`${under.map((x) => x.b.s.name || 'One').join(', ')} took a bid since. ${under.length === 1 ? 'Its' : 'Their'} next bid is now ${under.map((x) => eth(x.min)).join(', ')}.`);
      }
      // Each one as the wallet would send it, so a refusal names its auction before anything opens.
      await Promise.all(
        bids.map((x) =>
          pub.simulateContract({ address: x.b.s.address, abi: batchAbi, functionName: 'bid', value: x.value, account: me }).catch((err) => {
            throw new Error(`${x.b.s.name || 'One auction'}: ${errText(err)}`);
          }),
        ),
      );
      if (bids.length > 1 && (await canBatch())) {
        await sendBatch(bids.map((x) => ({ address: x.b.s.address, abi: batchAbi, functionName: 'bid', value: x.value })));
        toast(`${bids.length} bids in. You lead all ${bids.length}.`, 'ok');
      } else {
        let done = 0;
        for (const x of bids) {
          const btn = document.getElementById('whale-go');
          if (btn) btn.textContent = `Bid ${done + 1} of ${bids.length}…`;
          const min = (await pub.readContract({ address: x.b.s.address, abi: batchAbi, functionName: 'minBid' })) as bigint;
          if (x.value < min) throw new Error(`${done} of ${bids.length} in. ${x.b.s.name || 'The next one'} took a bid first: its next bid is now ${eth(min)}.`);
          await send({ address: x.b.s.address, abi: batchAbi, functionName: 'bid', value: x.value });
          done++;
        }
        toast(`${bids.length} ${bids.length === 1 ? 'bid' : 'bids'} in.`, 'ok');
      }
      picked.clear();
      amounts.clear();
    } catch (err) {
      toast(errText(err), 'err', 9000);
    } finally {
      busy = false;
      await read().catch(() => {});
      draw();
    }
  }

  await read();
  if (run !== whaleRun) return;
  draw();

  // Clocks tick between reads; reads come every 10 seconds, and a new next bid shows on its row.
  const tick = setInterval(() => {
    if (run !== whaleRun || !document.getElementById('whale-body')) return clearInterval(tick);
    const now = Date.now() / 1000;
    let out = false;
    document.querySelectorAll<HTMLElement>('#whale-body [data-ends]').forEach((n) => {
      const at = Number(n.dataset.ends);
      if (now >= at) out = true;
      n.textContent = left(at);
      n.classList.toggle('late', at - now < LATE);
    });
    if (out && !busy) void read().then(draw);
  }, 1000);
  const poll = setInterval(async () => {
    if (run !== whaleRun || !document.getElementById('whale-body')) return clearInterval(poll);
    if (busy || document.visibilityState !== 'visible') return;
    // Typing in a field: leave the page alone until it's done.
    if ((document.activeElement as HTMLElement | null)?.closest?.('#whale-body input[type="text"]')) return;
    const before = list.map((b) => `${b.s.address}:${b.s.highBid}`).join('|');
    await read().catch(() => {});
    if (list.map((b) => `${b.s.address}:${b.s.highBid}`).join('|') !== before) draw();
  }, 10_000);
}

