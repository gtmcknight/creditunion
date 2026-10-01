/// The mirror: Credit Union's auctions straight on the contracts, through the visitor's own wallet. One static file
/// (scripts/mirror.mjs builds it) that needs nothing from creditunion.fun: reads go through the wallet, or public
/// RPCs until one connects, and every write is the wallet's own transaction. For when the site is down or slow.
import {
  createPublicClient,
  createWalletClient,
  custom,
  fallback,
  formatEther,
  http,
  parseEther,
  type Address,
  type EIP1193Provider,
  type Hash,
} from 'viem';
import { mainnet } from 'viem/chains';
import { batchAbi, factoryAbi } from '../app/abi';

declare const __FACTORY__: Address;
declare const __CHAIN_ID__: number;
declare const __EXPLORER__: string;

const FACTORY = __FACTORY__;
const EXPLORER = __EXPLORER__;
const chain = { ...mainnet, id: __CHAIN_ID__ };
const STATES = ['Open', 'Full', 'Expired', 'Auction', 'Settled'] as const;
const PHASES = ['Open', 'Waiting', 'Countdown', 'Burnable', 'Expired', 'Assembled'] as const;
/// As the site sends it: just under the 16,777,216 gas any mainnet transaction may carry.
const ASSEMBLE_GAS = 16_000_000n;
const PUBLIC_RPCS = ['https://ethereum-rpc.publicnode.com', 'https://eth.llamarpc.com', 'https://cloudflare-eth.com'];
/// Test chains only: ?rpc=http://127.0.0.1:<port> reads from a local node, and nowhere else is accepted.
const testRpc = (() => {
  const r = new URLSearchParams(location.search).get('rpc');
  return r && /^http:\/\/(127\.0\.0\.1|localhost):\d{2,5}$/.test(r) ? r : null;
})();
/// &preview with a local node: a look at a copy of mainnet with no wallet at all, since a wallet would send its
/// transactions to the real chain.
const preview = !!testRpc && new URLSearchParams(location.search).has('preview');
const PREVIEW_OFF = 'Preview: this is a copy of mainnet, so wallet actions are off.';

type Union = {
  address: Address;
  name: string;
  creator: Address;
  /// Jack's Statements contract once burned (zero before).
  statement: Address;
  state: (typeof STATES)[number];
  phase: (typeof PHASES)[number];
  lockAt: number;
  deadline: number;
  auctionEnd: number;
  assembledAt: number;
  highBid: bigint;
  highBidder: Address;
  minBid: bigint;
  statementId: bigint;
};
type Mine = { claimable: bigint; owed: bigint };

/// Wallets in this browser, as they announce themselves (EIP-6963): a name and an icon each, no library.
type Announced = { info: { uuid: string; name: string; icon: string; rdns: string }; provider: EIP1193Provider };
const wallets: Announced[] = [];
window.addEventListener('eip6963:announceProvider', (e) => {
  const d = (e as CustomEvent<Announced>).detail;
  if (d?.provider && !wallets.some((w) => w.info.uuid === d.info.uuid)) wallets.push(d);
});
window.dispatchEvent(new Event('eip6963:requestProvider'));
const injected = () => (window as unknown as { ethereum?: EIP1193Provider }).ethereum;

let provider: EIP1193Provider | undefined;
let account: Address | undefined;
let unions: Union[] = [];
/// Whether the chain has answered once: until then the list says it's reading, not that nothing is there.
let loaded = false;
let picked: Address | null = (location.hash.match(/^#(0x[0-9a-fA-F]{40})$/)?.[1] as Address | undefined) ?? null;
let mine: Mine | null = null;
let busy = false;
/// When the chain last answered a full read, and whether the latest try failed: the panel says how fresh it is.
let readAt = 0;
let readFailed = false;
let status = '';
let statusErr = false;

/// Reads: the wallet's connection while it's on our chain, else public RPCs; a local node on test chains.
function reader() {
  const onChain = (p: EIP1193Provider) =>
    custom({
      async request({ method, params }: { method: string; params?: unknown }) {
        if (Number(await p.request({ method: 'eth_chainId' })) !== chain.id) throw new Error('wallet on another chain');
        return p.request({ method, params } as never);
      },
    });
  const publics = PUBLIC_RPCS.map((u) => http(u, { timeout: 10_000 }));
  const transport = testRpc ? http(testRpc) : provider ? fallback([onChain(provider), ...publics]) : fallback(publics);
  return createPublicClient({ chain, transport });
}
let pub = reader();

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const eth = (wei: bigint) => `${Number(formatEther(wei)).toLocaleString('en-US', { maximumFractionDigits: 4 })} ETH`;
const when = (unix: number) =>
  new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(new Date(unix * 1000));
/// The chain's clock: on a local node it can run ahead of this one (a test chain skips time), so it's read with the
/// unions there. On mainnet the two agree.
let skew = 0;
const nowS = () => Date.now() / 1000 + skew;
function left(unix: number) {
  const s = Math.max(0, Math.floor(unix - nowS()));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h}h ${m}m` : m ? `${m}m ${String(sec).padStart(2, '0')}s` : `${sec}s`;
}
const ended = (u: Union) => u.state === 'Auction' && u.highBid > 0n && nowS() >= u.auctionEnd;
const burnable = (u: Union) => u.state === 'Full' && u.lockAt > 0 && nowS() >= u.lockAt && nowS() < u.deadline;
/// Where a full union stands in its lock cycle, read against the clock.
function fullText(u: Union) {
  const t = nowS();
  if (!u.lockAt) return 'Full, waiting for burning to start';
  if (t < u.lockAt) return `Locks ${when(u.lockAt)}`;
  if (t < u.deadline) return `Locked. Burn by ${when(u.deadline)}, or it unlocks`;
  return 'Unlocked: nobody burned it in its hour';
}

function errText(e: unknown) {
  const x = e as { shortMessage?: string; message?: string; code?: number };
  if (x.code === 4001 || /user (rejected|denied)/i.test(x.message ?? '')) return 'Cancelled in your wallet.';
  return String(x.shortMessage ?? x.message ?? e).split('\n')[0];
}
function say(text: string, err = false) {
  status = text;
  statusErr = err;
  const el = document.getElementById('status');
  if (el) {
    el.innerHTML = status;
    el.classList.toggle('err', statusErr);
    el.hidden = !status;
  }
}

/// The newest block read, shown in the footer so anyone can see the page is live.
let head: { n: bigint; t: number } | null = null;
async function load() {
  const block = await pub.getBlock();
  head = { n: block.number, t: Number(block.timestamp) };
  if (testRpc) skew = head.t - Date.now() / 1000;
  const all = (await pub.readContract({ address: FACTORY, abi: factoryAbi, functionName: 'batches', args: [0n, 2000n] })) as Address[];
  const res = await pub.multicall({ contracts: all.map((address) => ({ address, abi: batchAbi, functionName: 'summary' }) as const), allowFailure: true });
  unions = all.flatMap((address, i) => {
    const r = res[i];
    if (r.status !== 'success') return [];
    const s = r.result as unknown as Record<string, unknown>;
    const state = STATES[Number(s.state)];
    if (state === 'Open' || state === 'Expired') return [];
    return [{
      address,
      name: String(s.name || 'Untitled'),
      creator: s.creator as Address,
      statement: s.statement as Address,
      state,
      phase: PHASES[Number(s.phase)],
      lockAt: Number(s.lockAt),
      deadline: Number(s.deadline),
      auctionEnd: Number(s.auctionEnd),
      assembledAt: Number(s.assembledAt),
      highBid: s.highBid as bigint,
      highBidder: s.highBidder as Address,
      minBid: s.minBid as bigint,
      statementId: s.statementId as bigint,
    }];
  });
  mine = null;
  if (picked && account) {
    const [claimable, owed] = await Promise.all([
      pub.readContract({ address: picked, abi: batchAbi, functionName: 'claimable', args: [account] }).catch(() => 0n),
      pub.readContract({ address: picked, abi: batchAbi, functionName: 'owed', args: [account] }).catch(() => 0n),
    ]);
    mine = { claimable: claimable as bigint, owed: owed as bigint };
  }
}

async function refresh() {
  try {
    await load();
    loaded = true;
    readAt = Date.now();
    readFailed = false;
    render();
    void fillIn();
    const p = unions.find((u) => u.address === picked);
    if (p && burned(p)) void readBids(p);
  } catch (e) {
    readFailed = true;
    freshness();
    if (!loaded) say(`Couldn’t read the chain: ${esc(errText(e))}. ${provider ? 'Check your wallet’s network.' : 'Connect a wallet to read through it.'}`, true);
  }
}

// ---------------------------------------------------------------- previews and names

/// Every Credit's inks (its 4-bit CMYK mask), two to a byte, shipped inside the page (scripts/mirror.mjs cuts them
/// from edition-traits.bin), so a union can be drawn from its Credit numbers alone.
const PAL = (() => {
  const t = document.getElementById('palettes')?.textContent?.trim();
  if (!t) return null;
  const bin = atob(t);
  const a = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
  return a;
})();
const inksOf = (id: bigint) => {
  const i = Number(id) - 1;
  return PAL && i >= 0 && i >> 1 < PAL.length ? (PAL[i >> 1] >> ((i & 1) * 4)) & 15 : 0;
};
/// Jack's four inks, never mixed: a Credit's dot shows each of its inks side by side, as the site marks inks.
const INK = ['#00b5e2', '#e4007c', '#ffd100', '#111111'];
/// A union as its sheet: the 80 Credits in the order they burn (burnOrder, the Statement's cell order), each a dot
/// striped with its inks. With no order yet, the empty sheet.
function sheet(ids: readonly bigint[]) {
  const dots = Array.from({ length: 80 }, (_, i) => {
    const x = 7 + (i % 8) * 8.25 + 1.25, y = 8.75 + Math.floor(i / 8) * 8.25 + 1.25, w = 5.75;
    const inks = ids[i] ? INK.filter((_, b) => inksOf(ids[i]) & (1 << b)) : [];
    if (!inks.length) return `<rect x="${x}" y="${y}" width="${w}" height="${w}" fill="#ececea"/>`;
    return inks.map((c, j) => `<rect x="${(x + (w * j) / inks.length).toFixed(3)}" y="${y}" width="${(w / inks.length).toFixed(3)}" height="${w}" fill="${c}"/>`).join('');
  });
  return `<svg viewBox="0 0 80 100" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="The 80 Credits" shape-rendering="crispEdges"><rect width="80" height="100" fill="#fff"/>${dots.join('')}</svg>`;
}
/// What each union looks like: its Credits as dots (burnOrder, read once per union), then, once burned, the Statement
/// as Jack's contract draws it (statementSVG, read through the wallet or a public RPC).
const orders = new Map<string, readonly bigint[]>();
const statements = new Map<string, string>();
const burned = (u: Union) => u.state === 'Auction' || u.state === 'Settled';
const artOf = (u: Union) => statements.get(u.address) || sheet(orders.get(u.address) ?? []);
const artHtml = (u: Union) => `<span class="art" data-art="${u.address}">${artOf(u)}</span>`;
const statementAbi = [{ type: 'function', name: 'statementSVG', stateMutability: 'view', inputs: [{ type: 'uint256' }], outputs: [{ type: 'string' }] }] as const;
/// Who made each union, by ENS name where it has one.
const names = new Map<string, string>();
const who = (a: Address) => `<span data-who="${a.toLowerCase()}">${esc(names.get(a.toLowerCase()) ?? short(a))}</span>`;

let filling = false;
const tried = new Set<string>(); // Statements asked for, so a failed read isn't retried every pass
/// What a union still needs: its order, its Statement once burned, its creator's name.
const needs = (u: Union) => !orders.has(u.address) || (burned(u) && !tried.has(u.address)) || !names.has(u.creator.toLowerCase());
const nextUp = () => unions.find((x) => x.address === picked && needs(x)) ?? unions.find(needs);
/// Fill in orders, Statements and names one read at a time, so a public RPC isn't hit all at once, each landing on
/// the page as it's read. The picked union goes first, even when it's picked partway through.
async function fillIn() {
  if (filling) return;
  filling = true;
  const redraw = (u: Union) => document.querySelectorAll<HTMLElement>(`[data-art="${u.address}"]`).forEach((el) => (el.innerHTML = artOf(u)));
  try {
    for (let u = nextUp(); u; u = nextUp()) {
      if (!orders.has(u.address)) {
        const ids = (await pub.readContract({ address: u.address, abi: batchAbi, functionName: 'burnOrder' }).catch(() => [])) as readonly bigint[];
        orders.set(u.address, ids);
        if (ids.length && !statements.has(u.address)) redraw(u);
      } else if (burned(u) && !tried.has(u.address)) {
        tried.add(u.address);
        const svg = await pub.readContract({ address: u.statement, abi: statementAbi, functionName: 'statementSVG', args: [u.statementId] }).catch(() => '');
        if (svg.includes('<svg')) {
          statements.set(u.address, `<img src="${URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }))}" alt="Statement #${u.statementId}">`);
          redraw(u);
        }
      } else {
        const c = u.creator.toLowerCase();
        const n = await pub.getEnsName({ address: u.creator }).catch(() => null);
        names.set(c, n ?? short(u.creator));
        if (n) document.querySelectorAll<HTMLElement>(`[data-who="${c}"]`).forEach((el) => (el.textContent = n));
      }
    }
  } finally {
    filling = false;
  }
}

// ---------------------------------------------------------------- drawing

function row(u: Union) {
  // Short here; the panel says it in full.
  const t = nowS();
  const meta =
    u.state === 'Settled' ? `Sold · ${eth(u.highBid)}`
    : u.state === 'Full' ? (!u.lockAt ? 'Waiting' : t < u.lockAt ? `Locks in <span data-left="${u.lockAt}">${left(u.lockAt)}</span>` : t < u.deadline ? 'Ready to burn' : 'Unlocked')
    : ended(u) ? `Settle · ${eth(u.highBid)}`
    : u.highBid ? `${eth(u.highBid)} · <span data-left="${u.auctionEnd}">${left(u.auctionEnd)}</span>`
    : 'No bids yet';
  return `<button type="button" class="row${u.address === picked ? ' on' : ''}" data-pick="${u.address}">${artHtml(u)}<span class="text"><span class="name">${esc(u.name)}</span><span class="by">by ${who(u.creator)}</span></span><span class="meta">${meta}</span></button>`;
}

function group(title: string, list: Union[]) {
  return list.length ? `<section class="group"><h2>${title} <span class="n">${list.length}</span></h2>${list.map(row).join('')}</section>` : '';
}

function panel(u: Union) {
  const link = `${EXPLORER}/address/${u.address}`;
  const head = `<div class="pick-top">${artHtml(u)}<header class="pick-head"><h2>${esc(u.name)}</h2><p class="by">by ${who(u.creator)}</p><span class="links"><a href="${link}" target="_blank" rel="noopener" title="It holds the Credits, then the Statement and the bids, and pays out">Union contract <span class="mono">${short(u.address)}</span> ↗</a>${burned(u) ? `<a href="${EXPLORER}/nft/${u.statement}/${u.statementId}" target="_blank" rel="noopener">Statement NFT #${u.statementId} ↗</a>` : ''}</span><button type="button" class="fresh" id="refresh" title="Refresh now"><i></i><span>${freshText()}</span></button></header></div>`;
  const you = mine && account ? mine : null;
  const extras = [
    you?.claimable ? `<div class="line"><span>Your payout <strong>${eth(you.claimable)}</strong></span><button type="button" class="btn" data-do="claim">Claim</button></div>` : '',
    you?.owed ? `<div class="line"><span>Your refund <strong>${eth(you.owed)}</strong></span><button type="button" class="btn" data-do="withdrawOwed">Withdraw</button></div>` : '',
  ].join('');
  if (u.state === 'Full')
    return `${head}<p class="facts">${fullText(u)}.</p>
      ${burnable(u) ? `<button type="button" class="btn primary" data-do="assemble">Convert Union to Statement</button><p class="hint">Anyone can press it. You pay the gas.</p>` : ''}${extras}`;
  if (u.state === 'Settled')
    return `${head}<div class="now"><span class="k">Sold · Statement #${u.statementId}</span><strong class="big">${eth(u.highBid)}</strong><span class="sub">to ${who(u.highBidder)}</span></div>${extras || '<p class="hint">Nothing to claim here for this wallet.</p>'}<div class="bids" data-bids="${u.address}">${bidsHtml(u)}</div>`;
  const winning = !!account && u.highBid > 0n && u.highBidder.toLowerCase() === account.toLowerCase();
  const now = u.highBid
    ? `<div class="now"><span class="k">${ended(u) ? 'Winning bid' : 'Current bid'}${winning ? ' <span class="chip win">You’re winning</span>' : ''}</span><strong class="big">${eth(u.highBid)}</strong><span class="sub">by ${who(u.highBidder)} · ${ended(u) ? `ended ${when(u.auctionEnd)}` : `<span data-left="${u.auctionEnd}">${left(u.auctionEnd)}</span> left · ends ${when(u.auctionEnd)}`}</span></div>`
    : `<div class="now"><span class="k">Statement #${u.statementId}</span><strong class="big">No bids yet</strong><span class="sub">The 24 hours start with the first bid.</span></div>`;
  const bids = `<div class="bids" data-bids="${u.address}">${bidsHtml(u)}</div>`;
  if (ended(u)) return `${head}${now}<button type="button" class="btn primary" data-do="settle">Settle</button><p class="hint">Pays every member and sends the Statement to the winner.</p>${bids}${extras}`;
  const min = formatEther(u.minBid);
  return `${head}${now}
    <form id="bid-form" class="bid"><label><input id="bid" inputmode="decimal" autocomplete="off" placeholder="${min}" aria-label="Bid in ETH"><span>ETH</span></label><button class="btn primary"${busy ? ' disabled' : ''}>Bid</button></form>
    <p class="hint"><button type="button" class="chip" data-min="${min}">Min ${Number(min).toLocaleString('en-US', { maximumFractionDigits: 4 })}</button> A bid in the last 15 minutes adds 15 minutes. If you’re outbid, your ETH comes back in the same transaction.</p>${bids}${extras}`;
}

/// The last few bids on a union, newest first, from its Bid events.
type BidRow = { bidder: Address; amount: bigint; block: bigint; at?: number };
const blockTimes = new Map<bigint, number>();
const bidLog = new Map<string, BidRow[]>();
function bidsHtml(u: Union) {
  const list = bidLog.get(u.address);
  if (!list?.length) return '';
  const ago = (b: BidRow) => {
    if (b.at === undefined) return '';
    const s = Math.max(0, nowS() - b.at);
    return s < 60 ? 'just now' : s < 3600 ? `${Math.round(s / 60)}m ago` : s < 86_400 ? `${Math.round(s / 3600)}h ago` : `${Math.round(s / 86_400)}d ago`;
  };
  return `<h3>Bids</h3>${list.slice(0, 5).map((b) => `<div class="bidrow"><strong>${eth(b.amount)}</strong><span>${who(b.bidder)}</span><span class="ago">${ago(b)}</span></div>`).join('')}`;
}
async function readBids(u: Union) {
  if (!head || !u.assembledAt || !u.highBid) return;
  const back = BigInt(Math.ceil(Math.max(0, head.t - u.assembledAt) / 12) + 50); // blocks since the burn, and a margin
  const logs = await pub
    .getContractEvents({ address: u.address, abi: batchAbi, eventName: 'Bid', fromBlock: head.n > back ? head.n - back : 0n })
    .catch(() => null);
  if (!logs) return;
  const list: BidRow[] = logs.map((l) => ({ bidder: (l.args as { bidder: Address }).bidder, amount: (l.args as { amount: bigint }).amount, block: l.blockNumber ?? 0n })).reverse();
  // When each shown bid landed: its block's time, read once per block.
  await Promise.all(
    list.slice(0, 5).map(async (b) => {
      if (!blockTimes.has(b.block)) blockTimes.set(b.block, Number((await pub.getBlock({ blockNumber: b.block }).catch(() => null))?.timestamp ?? 0));
      b.at = blockTimes.get(b.block) || undefined;
    }),
  );
  bidLog.set(u.address, list);
  document.querySelectorAll<HTMLElement>(`[data-bids="${u.address}"]`).forEach((el) => (el.innerHTML = bidsHtml(u)));
}

function render() {
  const live = unions.filter((u) => u.state === 'Auction' && !ended(u)).sort((a, b) => (a.highBid && b.highBid ? a.auctionEnd - b.auctionEnd : a.highBid ? -1 : b.highBid ? 1 : 0));
  const toSettle = unions.filter(ended);
  const full = unions.filter((u) => u.state === 'Full');
  const sold = unions.filter((u) => u.state === 'Settled');
  const u = unions.find((x) => x.address.toLowerCase() === picked?.toLowerCase());
  $('acct').innerHTML = account
    ? `<button type="button" class="btn acct" id="disconnect" title="Disconnect"><span class="addr mono">${short(account)}</span><span class="off">Disconnect</span></button>`
    : `<button type="button" class="btn" id="connect">Connect wallet</button>`;
  $('list').innerHTML =
    group('Live auctions', live) + group('Ended, to settle', toSettle) + group('Full', full) + group('Sold', sold) ||
    `<p class="hint">${loaded ? 'No Credit Union is full or at auction yet.' : 'Reading the chain…'}</p>`;
  $('pick').innerHTML = u ? panel(u) : `<p class="hint">${loaded || !picked ? 'Pick a Credit Union, or paste its address.' : 'Reading the chain…'}</p>`;
  $('pick').classList.toggle('empty', !u);
  say(status, statusErr);
}

// ---------------------------------------------------------------- wallet

/// Connect wallet: every wallet this browser has, by name and icon. With none, the wallet apps whose browsers can
/// open this page.
function openPicker() {
  const d = document.createElement('dialog');
  d.className = 'picker';
  const here = location.href;
  const list = wallets.length
    ? wallets.map((w, i) => `<button type="button" class="wallet" data-wallet="${i}"><img src="${esc(w.info.icon)}" alt=""><span>${esc(w.info.name)}</span></button>`).join('')
    : injected()
      ? `<button type="button" class="wallet" data-wallet="injected"><span class="blank"></span><span>Browser wallet</span></button>`
      : `<p class="hint">No wallet in this browser. Open this page in your wallet app:</p>
         ${[['MetaMask', `https://metamask.app.link/dapp/${location.host}${location.pathname}`], ['Coinbase Wallet', `https://go.cb-w.com/dapp?cb_url=${encodeURIComponent(here)}`], ['Trust Wallet', `https://link.trustwallet.com/open_url?coin_id=60&url=${encodeURIComponent(here)}`]]
           .map(([n, u]) => `<a class="wallet" href="${esc(u)}" rel="noopener"><span class="blank"></span><span>${n}</span><span class="go">↗</span></a>`)
           .join('')}`;
  d.innerHTML = `<header><h3>Connect a wallet</h3><button type="button" class="x" aria-label="Close">×</button></header><div class="wallets">${list}</div>`;
  document.body.append(d);
  d.addEventListener('close', () => d.remove());
  d.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    if (t === d || t.closest('.x')) return d.close();
    const b = t.closest<HTMLElement>('[data-wallet]');
    if (!b) return;
    d.close();
    const w = b.dataset.wallet;
    void connect(w === 'injected' ? injected() : wallets[Number(w)]?.provider);
  });
  d.showModal();
}

async function connect(p?: EIP1193Provider) {
  if (!p) return say('No wallet found. Open this page in your wallet app’s browser, or install a browser wallet.', true);
  try {
    const [a] = (await p.request({ method: 'eth_requestAccounts' })) as Address[];
    provider = p;
    account = a;
    try {
      sessionStorage.removeItem('mirror-off');
    } catch {}
    await onOurChain().catch((e) => say(esc(errText(e)), true));
    pub = reader();
    p.on?.('accountsChanged', (accs: Address[]) => ((account = accs[0]), void refresh()));
    p.on?.('chainChanged', () => ((pub = reader()), void refresh()));
    await refresh();
  } catch (e) {
    say(esc(errText(e)), true);
  }
}

function disconnect() {
  provider = account = undefined;
  mine = null;
  pub = reader();
  try {
    sessionStorage.setItem('mirror-off', '1');
  } catch {}
  render();
}

async function onOurChain() {
  if (Number(await provider!.request({ method: 'eth_chainId' })) === chain.id) return;
  await provider!.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: `0x${chain.id.toString(16)}` }] });
}

/// Simulate (so a revert says why before the wallet opens), send from the wallet, wait for it to land.
async function write(label: string, functionName: 'bid' | 'settle' | 'claim' | 'withdrawOwed' | 'assemble', value?: bigint) {
  if (!picked) return;
  if (preview) return say(PREVIEW_OFF);
  if (!account || !provider) return openPicker();
  if (busy) return;
  busy = true;
  say(`${label}: confirm in your wallet…`);
  try {
    await onOurChain();
    const args = functionName === 'claim' ? [account] : undefined;
    const gas = functionName === 'assemble' ? ASSEMBLE_GAS : undefined;
    const call = { address: picked, abi: batchAbi, functionName, args, value, account, ...(gas ? { gas } : {}) } as never;
    await pub.simulateContract(call);
    const wallet = createWalletClient({ account, chain, transport: custom(provider) });
    const hash: Hash = await wallet.writeContract(call);
    say(`${label}: sent, <a href="${EXPLORER}/tx/${hash}" target="_blank" rel="noopener">${short(hash)} ↗</a>. Waiting for it to land…`);
    const r = await pub.waitForTransactionReceipt({ hash });
    say(r.status === 'success' ? `${label}: done. <a href="${EXPLORER}/tx/${hash}" target="_blank" rel="noopener">${short(hash)} ↗</a>` : `${label}: reverted.`, r.status !== 'success');
  } catch (e) {
    say(`${label}: ${esc(errText(e))}`, true);
  } finally {
    busy = false;
    await refresh();
  }
}

document.addEventListener('click', (e) => {
  const t = e.target as HTMLElement;
  if (t.closest('#connect')) return void (preview ? say(PREVIEW_OFF) : openPicker());
  if (t.closest('#disconnect')) return void disconnect();
  if (t.closest('#refresh')) return void refresh();
  const pick = t.closest<HTMLElement>('[data-pick]');
  if (pick) {
    picked = pick.dataset.pick as Address;
    history.replaceState(null, '', `${location.search}#${picked}`);
    say('');
    // On a phone the picked union sits above the list: bring it into view.
    if (matchMedia('(max-width: 760px)').matches) $('pick').scrollIntoView({ block: 'start', behavior: 'smooth' });
    return void refresh();
  }
  const chip = t.closest<HTMLElement>('[data-min]');
  if (chip) {
    const input = document.getElementById('bid') as HTMLInputElement | null;
    if (input) (input.value = chip.dataset.min!), input.focus();
    return;
  }
  const act = t.closest<HTMLElement>('[data-do]');
  if (act) {
    const what = act.dataset.do as 'settle' | 'claim' | 'withdrawOwed' | 'assemble';
    return void write({ settle: 'Settle', claim: 'Claim', withdrawOwed: 'Withdraw', assemble: 'Convert Union to Statement' }[what], what);
  }
});
// A link to another union (#0x…), or Back to one: follow it.
window.addEventListener('hashchange', () => {
  const h = location.hash.match(/^#(0x[0-9a-fA-F]{40})$/)?.[1] as Address | undefined;
  if (h && h !== picked) {
    picked = h;
    say('');
    void refresh();
  }
});
document.addEventListener('submit', (e) => {
  const f = e.target as HTMLFormElement;
  e.preventDefault();
  if (f.id === 'go') {
    const a = ($<HTMLInputElement>('addr').value || '').trim();
    if (!/^0x[0-9a-fA-F]{40}$/.test(a)) return say('That isn’t a contract address.', true);
    picked = a as Address;
    history.replaceState(null, '', `${location.search}#${picked}`);
    return void refresh();
  }
  if (f.id === 'bid-form') {
    const u = unions.find((x) => x.address.toLowerCase() === picked?.toLowerCase());
    let v: bigint;
    try {
      v = parseEther(($<HTMLInputElement>('bid').value || '').trim());
    } catch {
      return say('Enter a bid in ETH, like 1.05.', true);
    }
    if (u && v < u.minBid) return say(`Bid at least ${eth(u.minBid)}.`, true);
    return void write('Bid', 'bid', v);
  }
});
/// How fresh the numbers on screen are: updated seconds ago, or, when the chain stopped answering, how old they are.
const STALE_MS = 40_000;
function freshText() {
  if (!readAt) return 'Reading…';
  const s = Math.round((Date.now() - readAt) / 1000);
  return readFailed || Date.now() - readAt > STALE_MS ? `Last updated ${s}s ago · reconnecting` : `Updated ${s}s ago`;
}
function freshness() {
  const el = document.getElementById('refresh');
  if (!el) return;
  el.classList.toggle('stale', readFailed || Date.now() - readAt > STALE_MS);
  el.querySelector('span')!.textContent = freshText();
}
/// The footer's proof of life: the newest block read, how long ago, and through what.
function liveLine() {
  const el = document.getElementById('live');
  if (!el || !head) return;
  const via = testRpc ? 'a local node' : provider ? 'your wallet' : 'public nodes';
  el.textContent = `Block ${head.n.toLocaleString('en-US')} · ${Math.max(0, Math.round(nowS() - head.t))}s ago · read through ${via}`;
}
setInterval(() => {
  document.querySelectorAll<HTMLElement>('[data-left]').forEach((el) => (el.textContent = left(Number(el.dataset.left))));
  liveLine();
  freshness();
}, 1000);
setInterval(() => document.visibilityState === 'visible' && !busy && !document.querySelector('dialog[open]') && void refresh(), 12_000); // a block

$('factory').innerHTML = `<a href="${EXPLORER}/address/${FACTORY}" target="_blank" rel="noopener" class="mono">${short(FACTORY)} ↗</a>`;
if (preview) $('preview-note').hidden = false;
render();
void (async () => {
  // A wallet already connected to this page answers without a prompt (unless it was disconnected here this visit).
  let off = false;
  try {
    off = sessionStorage.getItem('mirror-off') === '1';
  } catch {}
  await new Promise((r) => setTimeout(r, 50)); // let EIP-6963 wallets announce
  const p = wallets[0]?.provider ?? injected();
  const accs = p && !off && !preview ? ((await p.request({ method: 'eth_accounts' }).catch(() => [])) as Address[]) : [];
  if (accs.length) await connect(p);
  else await refresh();
})();
