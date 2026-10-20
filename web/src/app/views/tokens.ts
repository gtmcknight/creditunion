/// /tokens: BALANCE bought the best way there is, sold, or made from your own Credits. One box: Buy takes ETH and goes
/// whichever way gets more, Uniswap (BALANCE's pool, at once) or a batch (the cheapest Credits per rating point, swept
/// into a batch of 80 that converts when it fills), and Sell goes to the pool. BALANCE carries the ink of the Statement
/// it comes from (Jack's design), so batches come in five colors: Mixed (any Credit, the cheapest) and pure C, M, Y and
/// K, whose batches only take Credits printed in that one ink; the pool sells its own mix, so a pure color always goes
/// through a batch. The left side is the batch's sheet when the way in is a batch, else the BALANCE you'll hold. Token
/// unions (TokenAdapter): at 80 a batch converts in its own pocket and pays its members by the rating each put in.
/// Before the adapter is active nothing locks: anyone can withdraw. Converting and paying out is the keeper's job
/// (scripts/convert-tokens.mjs); Claim is the fallback.
import { erc20Abi, formatEther, formatUnits, parseEther, parseUnits, zeroAddress, type Address } from 'viem';
import { parseAbi } from 'viem';
import { batchAbi, creditsAbi, factoryAbi, sweeperAbi, tokenAdapterAbi } from '../abi';
import { balanceSvg, PURE, type Palette } from '../balance-art';
import { canBatch, config, pub, send, sendBatch, session } from '../chain';
import { bin } from '../bins';
import { getBatch, myCredits, STATES, type Summary } from '../data';
import { checkQuote, listedById, type Quote } from '../forsale';
import { buyListed, listings, type ForSale } from './statements';
import { registerDeposits } from '../ghosts';
import { buyCall, inkPalette, launchGate, market as swapMarket, opened, poolPalette, quote as swapQuote, sellCalls } from '../swap';
import { balanceArt, balanceHref, balanceSrc, converted } from '../tokens';
import { INK } from '../traits';
import { $$, art, errText, esc, ethNum, openModal, sheet, toast } from '../ui';
import { loadPalette } from '../wall';

const CHUNK = 40; // Credits per create/deposit transaction
const MAX_BUY = 40; // listings per buy (the Worker's quote limit)
const SHOWN = 400; // the cheapest per point an ETH amount picks from, per color
const DURATION = 90n * 86400n; // the longest a batch may stay open (BatchFactory.MAX_DURATION)
/// When $BALANCE starts converting: Jack's launch, 10:20 AM Eastern on October 20 (his auction starts then).
const OPENS_AT = Date.parse('2026-10-20T14:20:00Z');
/// When it trades, until his contract names the opening block: the end of his auction, a day after it starts.
const TRADES_PLANNED = OPENS_AT + 86_400_000;
const TOKEN = '$BALANCE';
/// ?soon on a local copy: see the before-launch notice even where the stand-in token already trades.
const previewSoon = /^(localhost|127\.0\.0\.1)$/.test(location.hostname) && new URLSearchParams(location.search).has('soon'); // always: a fork's stand-in token shows the real name
/// A batch lands later than a swap, so it has to get more than this many times what Uniswap gets to be the way in.
const BATCH_EDGE = 1.01;
/// With nothing typed, the page shows the way this much would go.
const REF = parseEther('0.1');
/// What a batch leaves of the ETH goes to Uniswap when it's at least this much (else it stays in the wallet).
const DUST = parseEther('0.01');

/// The five lines of batches. `palettes` is the Batch filter (bit m for a Credit whose inks make mask m: C=1 M=2
/// Y=4 K=8), so a pure color admits only Credits printed in that one ink. Any admits every Credit.
const LANES = [
  { key: 'any', name: 'Mixed', short: 'Any', palettes: 0, ink: -1 },
  { key: 'c', name: 'Cyan', short: 'C', palettes: 1 << 1, ink: 0 },
  { key: 'm', name: 'Magenta', short: 'M', palettes: 1 << 2, ink: 1 },
  { key: 'y', name: 'Yellow', short: 'Y', palettes: 1 << 4, ink: 2 },
  { key: 'k', name: 'Black', short: 'K', palettes: 1 << 8, ink: 3 },
] as const;
type Lane = (typeof LANES)[number];
const ANY_FILTER = { palettes: 0, prints: 0, weights: 0, eights: 0, paidFrom: 0n, paidTo: 0n, idFrom: 0n, idTo: 0n, minScore: 0, maxScore: 0, layout0: 0n, layout1: 0n, bitsFrom: 0, bitsTo: 0, layoutTrait: 0 };
const filterOf = (l: Lane) => ({ ...ANY_FILTER, palettes: l.palettes });
/// Whether a Credit with inks `mask` goes in this color's batches.
const fitsLane = (l: Lane, mask: number) => l.ink < 0 || mask === 1 << l.ink;
/// The color a batch belongs to: exactly one of the five filters, nothing else set. Anything else isn't ours to show.
function laneOf(s: Summary): Lane | null {
  const f = s.filter;
  const extra = [f.prints, f.weights, f.eights, f.paidFrom, f.paidTo, f.idFrom, f.idTo, f.minScore, f.maxScore, f.layout0, f.layout1, f.bitsFrom, f.bitsTo, f.layoutTrait, s.allowlistSize, s.arrangement].some((v) => Number(v) !== 0);
  return extra ? null : (LANES.find((l) => l.palettes === Number(f.palettes)) ?? null);
}

type Union = Awaited<ReturnType<typeof getBatch>>;
type Listing = { id: string; price: string; source: string; tenths: number };

/// The listings that get the most rating for `wei`, best value first: a 0/1 knapsack over the cost in about 10,000 steps
/// of the amount, each cost rounded up a step so the set always fits; of two sets with the same rating, the cheaper.
function mostRating(ls: Listing[], wei: bigint, cost: (x: Listing) => bigint) {
  const step = wei / 10_000n + 1n, B = Number(wei / step), row = B + 1;
  const fit = ls.filter((x) => cost(x) <= wei);
  const units = fit.map((x) => Number((cost(x) + step - 1n) / step));
  const best = new Float64Array(row), took = new Uint8Array(fit.length * row);
  fit.forEach((x, i) => {
    const c = units[i], v = x.tenths * row - c;
    for (let b = B; b >= c; b--)
      if (best[b - c] + v > best[b]) {
        best[b] = best[b - c] + v;
        took[i * row + b] = 1;
      }
  });
  const out: Listing[] = [];
  for (let i = fit.length - 1, b = B; i >= 0; i--)
    if (took[i * row + b]) {
      out.push(fit[i]);
      b -= units[i];
    }
  out.reverse();
  return { out, spent: out.reduce((a, x) => a + cost(x), 0n) };
}
/// The way a buy goes: BALANCE's Uniswap pool, or Credits swept into a batch.
type Route = 'pool' | 'batch' | 'statement';

const plural = (n: number) => `${n} Credit${n === 1 ? '' : 's'}`;
const pts = (tenths: number) => (tenths / 10).toLocaleString('en-US', { maximumFractionDigits: 1 });
const whole = (n: number) => Math.floor(n).toLocaleString('en-US');
const pct = (bps: bigint | number) => `${Number(bps) / 100}%`;

/// Every Credit's rating in tenths, as the batch's table (LiveRatings) states it: what its payout is weighed by.
/// public/scores-live.bin, one uint16 per Credit, #1 first.
let table: Promise<Uint16Array> | null = null;
const scoreTable = () => (table ??= bin('scores-live.bin').then((b) => new Uint16Array(b)));

let laneKey: Lane['key'] = 'any';
/// Each draw of the page: a timer from an earlier one stops instead of redrawing over this one.
let pageRun = 0;
/// How many Credits each batch's sheet showed last time it was drawn: newer ones drop in.
const shown = new Map<string, number>();
/// What the box does: Buy with ETH, Sell on Uniswap, Convert your own Credits in a batch, or Withdraw yours from one.
/// Kept while you move around the page.
let view: 'buy' | 'sell' | 'credits' | 'out' = 'buy';
/// The batch whose Withdraw opened that view: only its Credits are offered, still after a partial withdraw.
let outFrom: Address | null = null;
/// What's typed: ETH to buy with, or the token to sell.
let typed = '';
/// Your Credits picked when the page last redrew itself (something moved on chain): picked again if still yours.
let keptPicks: string[] = [];
/// The first draw of a visit: holders open on Convert with all theirs picked, everyone else on Buy at 0.1 ETH.
let landed = false;
/// Buy on Uniswap even when a batch gets more: you'd rather have it now.
let instant = false;
/// The way to buy someone tapped (null: the best).
let chosen: Route | null = null;
/// The colors of BALANCE with no history yet: an even mix.
const EVEN: Palette = [0.25, 0.25, 0.25, 0.25];
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function tokensPage(app: HTMLElement, rerun: () => void) {
  if (!config.tokenFactory) {
    app.innerHTML = `<section class="prose"><h1>${TOKEN}</h1><p class="muted">Coming soon.</p></section>`;
    return;
  }
  const factory = config.tokenFactory;
  const thisRun = ++pageRun;
  const asked = new URLSearchParams(location.search).get('color');
  if (asked && LANES.some((l) => l.key === asked)) laneKey = asked as Lane['key'];
  app.innerHTML = `<section class="prose"><p class="muted">Loading…</p></section>`;
  const account = session.account;
  const [n, assembler, feeNow, scores, inks, sweepBps, proposed, proposedFrom] = await Promise.all([
    pub.readContract({ address: factory, abi: factoryAbi, functionName: 'batchCount' }) as Promise<bigint>,
    pub.readContract({ address: factory, abi: factoryAbi, functionName: 'assembler' }) as Promise<Address>,
    pub.readContract({ address: factory, abi: factoryAbi, functionName: 'protocolFeeBps' }) as Promise<bigint>,
    scoreTable(),
    loadPalette(),
    config.tokenSweeper ? (pub.readContract({ address: config.tokenSweeper, abi: sweeperAbi, functionName: 'feeBps' }) as Promise<bigint>).catch(() => 0n) : Promise.resolve(0n),
    // The adapter the Safe has proposed and when it can be switched on (the keeper does it then, once BALANCE is live).
    (pub.readContract({ address: factory, abi: factoryAbi, functionName: 'pendingAssembler' }) as Promise<Address>).catch(() => zeroAddress),
    (pub.readContract({ address: factory, abi: factoryAbi, functionName: 'pendingUntil' }) as Promise<bigint>).catch(() => 0n),
  ]);
  const t = (id: bigint | string) => scores[Number(id) - 1] ?? 0;
  const inkOf = (id: bigint | string) => inks[Number(id) - 1] ?? 0;
  const live = assembler !== zeroAddress && !!config.tokenAdapter;
  const addrs = n ? ((await pub.readContract({ address: factory, abi: factoryAbi, functionName: 'batches', args: [0n, n] })) as readonly Address[]) : [];
  const all = (await Promise.all(addrs.map((a) => getBatch(a)))).filter((u) => laneOf(u.s)); // newest first (BatchFactory.batches)
  const done = (u: Union) => converted(u.s.statement);
  const waiting = all.filter((u) => !done(u) && (u.s.state === 'Open' || u.s.state === 'Full' || u.s.state === 'Expired'));
  const mineIn = (u: Union) => (account ? u.ids.filter((_, i) => u.depositors[i].toLowerCase() === account.toLowerCase()) : []);
  // Yours not converted yet, and which can still come back (not in a batch's burn hour).
  const pending = waiting.flatMap((u) => mineIn(u).map((id) => ({ id, u })));
  const leavable = pending.filter(({ u }) => u.s.phase !== 'Burnable');
  const [owned, approved, got, made, held, ethHeld] = await Promise.all([
    account ? (myCredits(account) as Promise<readonly bigint[]>) : Promise.resolve([] as readonly bigint[]),
    account ? (pub.readContract({ address: config.credits, abi: creditsAbi, functionName: 'isApprovedForAll', args: [account, factory] }) as Promise<boolean>) : Promise.resolve(false),
    account ? received(all.filter(done), account) : Promise.resolve({ amount: 0n, claim: [] as Address[], symbol: TOKEN, decimals: 18 }),
    conversions(all.filter(done)),
    account ? heldBy(account) : Promise.resolve(null),
    account ? pub.getBalance({ address: account }).catch(() => null) : Promise.resolve(null),
  ]);
  // BALANCE's pool: the token, whether it can move yet, how much you hold, the colors the pool sells and yours.
  const m = await swapMarket().catch(() => null);
  const [trade, tokenHeld, poolPal, myPal] = m
    ? await Promise.all([
        opened(m).catch(() => null),
        account ? (pub.readContract({ address: m.token, abi: erc20Abi, functionName: 'balanceOf', args: [account] }) as Promise<bigint>).catch(() => 0n) : Promise.resolve(0n),
        poolPalette(m),
        account ? inkPalette(m, account) : Promise.resolve(null),
      ])
    : [null, 0n, null, null];
  // The launch as it stands: whether BALANCE takes Statements yet (conversions and redeems revert until it does) and
  // the block its transfers open at (payouts and claims wait for it).
  const gate = await (async () => {
    const token = m?.token ?? (config.tokenAdapter ? ((await pub.readContract({ address: config.tokenAdapter, abi: tokenAdapterAbi, functionName: 'token' })) as Address) : null);
    return token ? launchGate(token) : null;
  })().catch(() => null);
  const paying = !!gate && (gate.opensAt === null || gate.block >= gate.opensAt);
  /// When trading opens: the opening block's time once the token names it (12 s a block), until then the planned time.
  const tradesAt = gate?.opensAt != null ? Date.now() + Number(gate.opensAt - gate.block) * 12_000 : TRADES_PLANNED;
  const isOpen = !!trade?.open || paying;
  /// Batches convert (the adapter live, BALANCE taking Statements) but BALANCE doesn't move yet.
  const converting = live && !!gate?.takes && !isOpen;
  const when = (t: number) => new Date(t).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
  /// The same moment for a short row: "Wed 10:39 AM".
  const whenShort = (t: number) => new Date(t).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' });
  /// When full batches start converting: our adapter's switch-on once the Safe has proposed it (no earlier than BALANCE
  /// going live, which Jack's launch time stands for until it has), else Jack's launch.
  const ours = !live && !!config.tokenAdapter && proposed.toLowerCase() === config.tokenAdapter.toLowerCase();
  const convertsAt = ours ? Math.max(Number(proposedFrom) * 1000, gate?.takes ? 0 : OPENS_AT) : OPENS_AT;
  /// Step two's time: now, a time to come, or (past it, still waiting) the reason.
  const convertsWhen = converting ? 'Now' : convertsAt > Date.now() + 60_000 ? when(convertsAt) : ours && gate?.takes ? 'Any minute now' : `Once ${TOKEN} is live`;
  const sym = () => TOKEN;
  const tokAmt = (v: bigint) => Number(formatUnits(v, m?.decimals ?? 18)).toLocaleString('en-US', { maximumFractionDigits: 2 });
  /// Kept back from Max for gas.
  const GAS_KEEP = parseEther('0.003');
  /// The conversion fee that applies: the open batch's own (a batch keeps the fee it opened with), else the factory's for a new one.
  const bpsOf = () => curOf(lane())?.s.protocolFeeBps ?? Number(feeNow);
  // One rating point is one token; the protocol fee comes off the top.
  const est = (tenthsIn: number) => Math.floor((tenthsIn / 10) * (1 - bpsOf() / 10_000));
  /// The conversion fee on that rating, in tokens: its rate of the rating, rounded.
  const feeOn = (tenthsIn: number) => Math.round(((tenthsIn / 10) * bpsOf()) / 10_000);
  const yoursT = pending.reduce((a, p) => a + t(p.id), 0);
  const amount = (v: bigint) => Number(formatUnits(v, got.decimals)).toLocaleString('en-US', { maximumFractionDigits: 0 });
  /// Whether ETH can buy Credits into a batch here (the token factory's Sweeper).
  const sweeps = !!config.tokenSweeper;
  // Per color: the batch filling (the fullest open one) and how many are full.
  const curOf = (l: Lane) => all.filter((u) => laneOf(u.s) === l && u.s.state === 'Open' && u.s.count < 80).sort((a, b) => b.s.count - a.s.count)[0] ?? null;
  /// A batch's name as it opened with ("Mixed 5"), the one the activity feed and its own page show.
  const nameOf = (l: Lane, u: Union) => esc(u.s.name || `${l.name} batch`);
  const fullOf = (l: Lane) => all.filter((u) => laneOf(u.s) === l && u.s.state === 'Full').length;
  // The palette a batch's BALANCE carries: a pure color's own ink; a mixed batch's, about the share of each ink across
  // its Credits (each Credit split evenly over its inks), an even mix while it's empty.
  const paletteOf = (l: Lane): Palette => {
    if (l.ink >= 0) return PURE[l.ink];
    const p: Palette = [0, 0, 0, 0];
    for (const id of curOf(l)?.ids ?? []) {
      const m = inkOf(id), k = [0, 1, 2, 3].filter((b) => m & (1 << b));
      for (const b of k) p[b] += 1 / k.length;
    }
    const sum = p.reduce((a, b) => a + b, 0);
    return sum ? (p.map((v) => v / sum) as Palette) : EVEN;
  };

  // For sale, per color, cheapest per rating point first: the whole market (the book). Filled in once it's read.
  const pools = new Map<Lane['key'], Listing[]>();
  let feeBps = sweepBps;
  let market: 'loading' | 'ready' | 'none' = sweeps ? 'loading' : 'none';
  const picks = new Set<string>(keptPicks.filter((id) => owned.some((o) => o.toString() === id)));
  keptPicks = [];

  let busy = false;
  /// While a transaction is in flight nothing on the page can change what it's doing: batches, picks, amounts.
  const lock = (on: boolean) => {
    busy = on;
    app.querySelector('.tk-form')?.classList.toggle('busy', on);
    for (const el of $$<HTMLButtonElement | HTMLInputElement>('.tokens button, .tokens input', app)) if (on) el.disabled = true;
  };
  const run = async (btn: HTMLElement | null, label: string, fn: () => Promise<unknown>, ok: string) => {
    lock(true);
    if (btn) {
      btn.setAttribute('disabled', '');
      btn.dataset.label = btn.textContent ?? '';
      btn.textContent = label;
    }
    try {
      await fn();
      if (ok) toast(ok, 'ok');
      typed = '';
      rerun();
    } catch (e) {
      // Back to how it was: redrawn, so every control is live again.
      busy = false;
      toast(errText(e), 'err', 8000);
      draw();
    }
  };
  const note = () => toast('Submitted. Waiting for confirmation…', 'info');
  const lane = () => LANES.find((l) => l.key === laneKey)!;
  const ownedHere = () => [...owned].filter((id) => fitsLane(lane(), inkOf(id))).sort((a, b) => t(b) - t(a));
  /// Your Credits waiting in this color's batches that can come back now (not in a burn hour), and the ones picked to.
  const outHere = () => leavable.filter((p) => laneOf(p.u.s) === lane() && (!outFrom || p.u.s.address === outFrom));
  const outPicks = new Set<string>();
  /// Uniswap is a way in for Mixed once trading opens: the pool sells its own mix, never a pure color.
  const poolFor = (l: Lane) => !!m && !!trade?.open && l.ink < 0;
  const poolOk = () => poolFor(lane());
  /// The most Credits one buy takes into a color's batch. With Uniswap there too, only the open spots in the batch filling,
  /// so all of it lands when that one fills and the rest of the ETH buys on Uniswap; else up to one buy's worth, the
  /// rest starting the next batch.
  const capOf = (l: Lane) => (poolFor(l) ? Math.min(80 - (curOf(l)?.s.count ?? 0), MAX_BUY) : MAX_BUY);
  /// The view that applies: Sell only once trading opens, Withdraw only with something to withdraw, and with no way to
  /// spend ETH (no Sweeper, no pool for this color) Buy is your Credits.
  const viewNow = (): typeof view => {
    const v = (view === 'sell' && !trade?.open) || (view === 'out' && !outHere().length) ? 'buy' : view;
    return v === 'buy' && !sweeps && !poolOk() ? 'credits' : v;
  };
  /// ETH in dollars (Coinbase spot through the worker), read once: what a trade is worth, as Uniswap shows it.
  let usd: number | null = null;
  const dollars = (eth: number) => (usd && eth > 0 ? `$${(eth * usd).toLocaleString('en-US', { maximumFractionDigits: eth * usd < 10 ? 2 : 0 })}` : '');
  fetch('/market/eth-usd.json')
    .then((r) => r.json() as Promise<{ usd?: number }>)
    .then((j) => {
      usd = j.usd && j.usd > 0 ? j.usd : null;
      if (usd && app.querySelector('.tk-form')) paint();
    })
    .catch(() => {});
  const amountIn = (): bigint => {
    try {
      return viewNow() === 'sell' ? parseUnits(typed.trim() || '0', m!.decimals) : parseEther(typed.trim() || '0');
    } catch {
      return 0n;
    }
  };

  /// The Credits of a color that get the most rating for the ETH (the Sweeper's fee included), up to `cap` of them. First
  /// the best value down the list while each fits. Many often cost the same per point, so that can stop short with a gap
  /// none of the next fills; unless Uniswap takes what's left, the set that spends the most of the ETH, when it gets more.
  let fitMemo: { ls: Listing[]; wei: bigint; cap: number; fee: bigint; r: { out: Listing[]; spent: bigint } } | null = null;
  const fitBudget = (wei: bigint, key: Lane['key'] = laneKey, cap = MAX_BUY) => {
    const ls = pools.get(key) ?? [];
    if (fitMemo && fitMemo.ls === ls && fitMemo.wei === wei && fitMemo.cap === cap && fitMemo.fee === feeBps) return fitMemo.r;
    const cost = (x: Listing) => BigInt(x.price) + (BigInt(x.price) * feeBps) / 10_000n;
    const out: Listing[] = [];
    let spent = 0n;
    for (const x of ls) {
      if (out.length >= cap) break;
      if (spent + cost(x) > wei) continue;
      spent += cost(x);
      out.push(x);
    }
    let r = { out, spent };
    if (out.length && out.length < cap && !poolFor(LANES.find((l) => l.key === key)!)) {
      const k = mostRating(ls, wei, cost);
      const sum = (o: Listing[]) => o.reduce((a, x) => a + x.tenths, 0);
      if (k.out.length <= cap && (sum(k.out) > sum(out) || (sum(k.out) === sum(out) && k.spent < spent))) r = k;
    }
    fitMemo = { ls, wei, cap, fee: feeBps, r };
    return r;
  };
  /// What `wei` gets through a batch: those Credits, what they cost, and the tokens they pay out (our fee off).
  const viaBatch = (wei: bigint, key: Lane['key'] = laneKey, cap = MAX_BUY) => {
    const f = fitBudget(wei, key, cap);
    return { ...f, tokens: est(f.out.reduce((a, x) => a + t(x.id), 0)) }; // the same score table the batch box and payouts use
  };
  /// What a full batch of this color costs per 1,000 BALANCE received right now: its cheapest 80 per point, the sweep
  /// fee on the ETH and the conversion fee on the tokens included.
  const batchPrice = (l: Lane) => {
    const ls = (pools.get(l.key) ?? []).slice(0, 80);
    const tenths = ls.reduce((a, x) => a + x.tenths, 0);
    if (!tenths) return null;
    const wei = ls.reduce((a, x) => a + BigInt(x.price), 0n);
    const keep = 10_000n - BigInt(curOf(l)?.s.protocolFeeBps ?? Number(feeNow));
    return ((wei + (wei * feeBps) / 10_000n) * 10_000n * 10_000n) / (BigInt(tenths) * keep);
  };
  /// The buy for a color and budget fixed when the button was pressed, re-picked from what's still for sale.
  const pickFor = (l: Lane, wei: bigint, cap: number) => () => fitBudget(wei, l.key, cap).out;

  /// The way the buy typed goes, as last worked out (null: neither way can do it), and, for Mixed with nothing typed,
  /// the way REF would go once both prices are in.
  let route: Route | null = null;
  /// Whether the conversion fee reads as its rate (tapped) instead of the tokens it takes.
  let feeAsRate = false;
  /// Under You get through a batch: the amount is already after the fee (it read as still to come off), then when it converts.
  const feeLine = (tenthsIn: number) =>
    `After the <button type="button" class="link" id="fee-rate" title="${pct(bpsOf())} conversion fee">${feeAsRate ? `${pct(bpsOf())} conversion fee` : `${whole(feeOn(tenthsIn))} ${TOKEN} fee`}</button>`;
  /// Statements listed on OpenSea, read once: a whole Statement is a way in when the amount covers one.
  let stmts: ForSale[] = [];
  listings()
    .then((x) => {
      stmts = x.filter((y) => y.rating);
      if (app.querySelector('.tk-form')) paint();
    })
    .catch(() => {});
  /// The best Statement the amount buys: the most rating per ETH among those it covers.
  const stmtFor = (wei: bigint) =>
    stmts.filter((y) => BigInt(y.price) <= wei).reduce<ForSale | null>((a, y) => (!a || y.rating! / Number(BigInt(y.price)) > a.rating! / Number(BigInt(a.price)) ? y : a), null);
  let st: ForSale | null = null;
  /// The Statements this wallet holds, each with its rating: the Yours panel offers to redeem them.
  let myStmts: { id: bigint; rating: number; ready?: boolean }[] = [];
  const ST_ABI = parseAbi(['function approve(address,uint256)']);
  const VAULT_ABI = parseAbi(['function quote(uint256) view returns (uint256)', 'function withdraw(uint256,uint256) returns (uint256)']);
  if (account)
    fetch(`/statements/owned/${account}.json`)
      .then((r) => r.json() as Promise<{ items?: { id: string; rating: number }[] }>)
      .then((j) => {
        myStmts = (j.items ?? []).map((x) => ({ id: BigInt(x.id), rating: x.rating }));
        if (myStmts.length && app.querySelector('.tk-form')) draw();
        // Redeem only where the token would pay now: once it takes Statements (its quote answers before that), and
        // only Statements its quote takes.
        void (async () => {
          const vault = await vaultOf().catch(() => null);
          if (!vault || !myStmts.length || !gate?.takes) return;
          await Promise.all(
            myStmts.map(async (x) => {
              x.ready = await pub.readContract({ address: vault, abi: VAULT_ABI, functionName: 'quote', args: [x.id] }).then(() => true, () => false);
            }),
          );
          if (app.querySelector('.tk-form')) draw();
        })();
      })
      .catch(() => {});
  /// The contract a Statement redeems in: the token itself, named by the pool vars or by the adapter.
  const vaultOf = async (): Promise<Address | null> =>
    m?.token ?? (config.tokenAdapter ? ((await pub.readContract({ address: config.tokenAdapter, abi: tokenAdapterAbi, functionName: 'token' })) as Address) : null);
  let restMixed: Route | null = null;
  const restWay = (): Route | null => (!poolOk() ? (sweeps ? 'batch' : null) : !sweeps ? 'pool' : restMixed);
  /// The way it goes; with nothing typed, or while neither way can say (prices loading, too little), the way it would.
  const wayNow = () => (amountIn() ? route : null) ?? restWay();
  /// The batch buy as last worked out: the Credits it takes, and the ETH it leaves for Uniswap (0: none).
  let plan: { b: { out: Listing[]; spent: bigint; tokens: number }; left: bigint } | null = null;
  /// The left side: the batch's sheet, unless the way in is Uniswap (or you're selling).
  const viaSheet = () => {
    const v = viewNow();
    return v !== 'sell' && !(v === 'buy' && (wayNow() === 'pool' || wayNow() === 'statement'));
  };
  const lands = () => `Lands when the batch fills${isOpen ? '' : ' and trading opens'}`;

  // ---------------------------------------------------------------- drawing
  const swatch = (l: Lane) => (l.ink < 0 ? INK.map((c) => `<i style="background:${c}"></i>`).join('') : `<i style="background:${(INK as readonly string[])[l.ink]}"></i>`);
  const inkVar = (x: Lane) => (x.ink >= 0 ? `--c:${(INK as readonly string[])[x.ink]}` : '');
  const pure = (mask: number) => LANES.find((x) => x.ink >= 0 && mask === 1 << x.ink) ?? null;
  /// The color, as a chip beside what you get. Its menu: Mixed and the four pure inks, a dot on a pure one you hold
  /// Credits of, and on hover what a batch of it costs and how full it is.
  const colorChip = () => {
    const l = lane();
    const opt = (x: Lane) => {
      const fit = x.ink >= 0 && owned.some((id) => fitsLane(x, inkOf(id)));
      return `<li role="option" tabindex="-1" data-lane="${x.key}" aria-selected="${x.key === laneKey}" style="${inkVar(x)}"><span class="tk-opt"><span class="sw-ink">${swatch(x)}</span>${x.name}${fit ? '<i class="tk-dot" aria-hidden="true"></i>' : ''}</span></li>`;
    };
    return `<div class="sort-pick tk-color"><button type="button" class="sort-btn" id="tk-color" aria-haspopup="listbox" aria-expanded="false" aria-label="Color: ${l.name}"><span class="sw-ink">${swatch(l)}</span>${l.name}</button><div class="sort-menu tk-menu" hidden><ul role="listbox" aria-label="Color">${LANES.map(opt).join('')}</ul><button type="button" class="link small" id="how-color">How color works</button></div></div>`;
  };
  /// The sheet as drawn (the batch's Credits, faded examples of its color in the open cells). The Credits you'd add
  /// (picked, or about to be bought) cover the next open cells in place; a cell you drop goes back to what it showed.
  /// Nothing else on the sheet moves.
  let previewed = '';
  const kept = new Map<HTMLElement, { cls: string; html: string; ghost?: string }>();
  const adding = (): bigint[] => {
    const v = viewNow();
    if (v === 'credits') {
      const here = new Set(ownedHere().map(String));
      return [...picks].filter((id) => here.has(id)).map(BigInt);
    }
    return v === 'buy' && route === 'batch' && plan && amountIn() ? plan.b.out.map((x) => BigInt(x.id)) : [];
  };
  const drawSheet = () => {
    const cur = curOf(lane());
    const count = cur?.s.count ?? 0;
    const add = adding().slice(0, 80 - count);
    const sig = `${laneKey}|${add.join(',')}`;
    if (sig === previewed) return;
    previewed = sig;
    $$<HTMLElement>('#tk-sheet .sheet > .cell', app).forEach((c, i) => {
      const id = i >= count ? add[i - count] : undefined;
      if (id !== undefined) {
        if (!kept.has(c)) kept.set(c, { cls: c.className, html: c.innerHTML, ghost: c.dataset.ghost });
        if (c.dataset.id === String(id)) return;
        c.className = 'cell mine';
        c.dataset.id = String(id);
        c.removeAttribute('data-ghost');
        c.innerHTML = `<img src="${art(id)}" alt="" loading="lazy" decoding="async">`;
      } else if (kept.has(c)) {
        const k = kept.get(c)!;
        kept.delete(c);
        c.className = k.cls;
        c.innerHTML = k.html;
        c.removeAttribute('data-id');
        if (k.ghost) c.dataset.ghost = k.ghost;
      }
    });
    // Yours (in already, or being added) are outlined; the rest is others' Credits and open paper.
    const legend = document.getElementById('tk-legend');
    const yours = (cur ? mineIn(cur).length : 0) + add.length;
    // The bar: yours (in already, or about to be), then others' Credits, then open paper, in the key's order.
    const others = count - (cur ? mineIn(cur).length : 0), open = Math.max(0, 80 - count - add.length);
    const fo = document.getElementById('tk-fo'), fy = document.getElementById('tk-fy'), bn = document.getElementById('tk-bn');
    if (fo) fo.style.width = `${(others / 80) * 100}%`;
    if (fy) fy.style.width = `${(Math.min(yours, 80 - others) / 80) * 100}%`;
    if (bn) bn.textContent = `${count} of 80`; // what's in it now; the bar and the key show yours about to be
    // What you'll be paid when it fills: your Credits' rating in it (in already and about to be), after the fee.
    const bget = document.getElementById('tk-bget');
    const inTenths = (cur ? mineIn(cur) : []).reduce((n, id) => n + t(id), 0), addTenths = add.reduce((n, id) => n + t(id), 0);
    const yoursTenths = inTenths + addTenths;
    // With some of yours in already, the total all of yours will pay; otherwise the box above already says it.
    const inAlready = cur ? mineIn(cur).length : 0;
    if (bget) bget.textContent = yoursTenths ? 'Converts at 80. Until then, withdraw anytime.' : 'Converts at 80, split by the rating each member put in.';
    // Credits a buy would bring in aren't anyone's yet (and signed out there's no "you"), so they say buying.
    const buying = viewNow() === 'buy' ? add.length : 0, mineAll = yours - buying;
    if (legend) legend.innerHTML = `${mineAll ? `<span><i class="y"></i>${mineAll} yours</span>` : ''}${buying ? `<span><i class="y"></i>${buying} buying</span>` : ''}<span><i class="o"></i>${others} others</span><span><i></i>${open} open</span>`;
  };
  /// The BALANCE you'd hold after the buy or sale typed, as Jack's artwork draws a wallet: its balance in its colors.
  /// What comes in mixes in by amount; selling never changes your colors.
  const drawHolding = (delta: number, inPal: Palette | null) => {
    const el = document.getElementById('tk-art');
    if (!el) return;
    const had = Number(formatUnits(tokenHeld, m?.decimals ?? 18));
    const after = Math.max(0, had + delta);
    const mine = myPal ?? EVEN;
    const pal = delta > 0 && inPal ? (had > 0 ? (mine.map((v, i) => (v * had + inPal[i] * delta) / after) as Palette) : inPal) : mine;
    const text = whole(after);
    const sig = `${text}|${pal.join(',')}`;
    if (el.dataset.sig !== sig) {
      el.dataset.sig = sig;
      el.innerHTML = balanceSvg(text, pal, Math.max(3, Math.min(12, Math.floor(73 / text.length)))); // the old 8-wide font fit 55 / length
    }
    const label = document.getElementById('tk-art-label');
    if (label) label.textContent = !account ? sym() : delta ? 'You’ll hold' : 'You hold';
  };
  const showLeft = () => {
    const s = viaSheet();
    const a = document.getElementById('tk-batch');
    if (a) a.hidden = !s;
  };
  /// You get, in the colors it comes in.
  const setGet = (n: number, pal: Palette) => {
    const get = document.getElementById('get');
    const text = whole(n);
    const sig = `${text}|${pal.join(',')}`;
    if (get && get.dataset.sig !== sig) {
      get.dataset.sig = sig;
      get.dataset.n = text;
      get.innerHTML = balanceSvg(text, pal);
    }
  };
  const setText = (id: string, html: string) => {
    const el = document.getElementById(id);
    if (el && el.innerHTML !== html) el.innerHTML = html;
  };
  const setGo = (text: string, on: boolean) => {
    const go = document.getElementById('go') as HTMLButtonElement | null;
    if (go && !busy) {
      go.textContent = text;
      go.disabled = !on;
    }
  };

  const eta = (blocks: bigint) => {
    const s = Number(blocks > 0n ? blocks : 0n) * 12;
    return s < 3600 ? `about ${Math.max(1, Math.round(s / 60))} min` : `about ${Math.round(s / 3600)} h`;
  };
  /// Buy · Sell · Convert. Sell shows once the pool's token is named, greyed until its transfers open; Buy only when
  /// there's a way to buy (a Sweeper or the pool).
  function tabsHtml() {
    const v = viewNow();
    if (v === 'out') return '';
    const tab = (k: 'buy' | 'sell' | 'credits', label: string) => {
      const shut = k === 'sell' && !trade?.open;
      const when = m && m.opensAt !== null ? `Opens at block ${m.opensAt.toLocaleString('en-US')}${trade ? `, ${eta(m.opensAt - trade.block)} from now` : ''}` : 'Not trading yet';
      return `<button type="button" role="tab" data-view="${k}" aria-selected="${v === k}"${shut ? ` disabled title="${when}"` : ''}>${label}</button>`;
    };
    const n = account ? owned.length : 0;
    return `<div class="subtabs tk-modes" role="tablist" aria-label="Buy, sell or convert">${sweeps || poolOk() ? tab('buy', 'Buy') : ''}${m ? tab('sell', 'Sell') : ''}${tab('credits', n ? `Convert <span class="muted num">${n}</span>` : 'Convert')}</div>`;
  }
  /// A token's mark and name, as a chip on the right of a panel: ETH's diamond; $BALANCE as its ink, the batch's colours.
  const ETH_ICON = '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M8 1 3.5 8.2 8 10.8l4.5-2.6z" fill="currentColor" opacity=".9"/><path d="M8 11.7 3.5 9.1 8 15l4.5-5.9z" fill="currentColor" opacity=".6"/></svg>';
  const tokenChip = (eth: boolean) => `<span class="tk-unit">${eth ? ETH_ICON : `<span class="sw-ink tk-coin">${swatch(lane())}</span>`}${eth ? 'ETH' : esc(sym())}</span>`;
  const payHtml = (selling: boolean) => {
    const max = selling
      ? account ? `<span class="tk-bal">You hold <span class="num">${tokAmt(tokenHeld)}</span> <button type="button" class="link small" id="amt-max">Max</button></span>` : ''
      : ethHeld !== null ? `<span class="tk-bal">Wallet <span class="num">${ethNum(ethHeld, 4)}</span> ETH <button type="button" class="link small" id="amt-max">Max</button></span>` : '';
    // Paying ETH: a few amounts a tap away (about 2, 4 and 20 Credits' worth at today's prices).
    const quick = selling ? '' : `<span class="tk-quick">${['0.05', '0.1', '0.5'].map((v) => `<button type="button" class="tk-q num" data-amt="${v}" aria-pressed="${typed === v}">${v}</button>`).join('')}</span>`;
    // Pay mirrors You get: the title with its quick amounts on one line, then the panel with the amount, its unit,
    // what it's worth and, at the bottom right, your balance with Max (as Uniswap does).
    return `
          <div class="tk-gethead"><h2 class="form-title">${selling ? 'Sell' : 'Pay'}</h2>${quick}</div>
          <section class="rule">
            <div class="tk-eth"><input id="amt" class="num" inputmode="decimal" autocomplete="off" placeholder="0" aria-label="${selling ? `${esc(sym())} to sell` : 'ETH to spend'}" value="${esc(typed)}">${tokenChip(!selling)}<span class="tk-usd num" id="amt-usd"></span>${max}</div>
            <p class="term-desc tk-ethrow"><span id="amt-line"></span></p>
          </section>`;
  };
  /// You get, then the way it goes, the other way when it's a real choice, and our fees on this way.
  const getHtml = (selling: boolean) => `
          <div class="tk-gethead"><h2 class="form-title" id="tk-gettitle">You get</h2>${selling ? '' : colorChip()}</div>
          <section class="rule">
            ${selling ? '<div class="tk-get tk-panel"><span class="num tk-out" id="get-eth">0</span>${tokenChip(true)}<span class="tk-usd" id="route"></span></div>' : `<div class="tk-get tk-panel"><span class="tk-getrow"><span class="tk-from" id="get-from"></span><span id="get">${balanceSvg('0', EVEN)}</span></span>${tokenChip(false)}<span class="tk-usd" id="route"></span></div>`}
            <div class="tk-lines term-desc"><p id="route2"></p><p id="alt"></p><p id="fees"></p></div>
          </section>`;
  const goHtml = (label: string) => (account ? `<button type="button" class="btn primary block" id="go" disabled>${label}</button>` : '<button type="button" class="btn primary block" data-connect>Connect wallet</button>');
  const linkHtml = (to: typeof view, text: string) => (text ? `<p class="hint center"><button type="button" class="link small" data-view="${to}">${text}</button></p>` : '');
  function buyHtml() {
    return `${payHtml(false)}${getHtml(false)}
          <div id="tk-batch-home">${batchHtml()}</div><div class="submit">${goHtml('Enter an amount')}<p class="hint center small muted" id="go-note"></p></div>`;
  }
  function creditsHtml() {
    const mineHere = ownedHere();
    const pick = (id: bigint) => {
      const p = lane().ink < 0 ? pure(inkOf(id)) : null; // in Mixed, a single-ink Credit is marked with its ink
      return `<button type="button" class="pick" data-id="${id}" aria-pressed="${picks.has(id.toString())}" aria-label="Credit #${id}" title="Credit #${id} · ${pts(t(id))} rating"><img src="${art(id)}" alt="" loading="lazy">${p ? `<span class="tk-pure" style="${inkVar(p)}" title="${p.name} only"></span>` : ''}<span class="pick-id num">${pts(t(id))}</span></button>`;
    };
    return `
          <div class="tk-gethead"><h2 class="form-title">Your Credits</h2>${account && mineHere.length ? '<button type="button" class="link small" id="pick-all">Select all</button>' : ''}</div>
          <section class="rule">
            ${
              !account
                ? '<p class="term-desc">Connect to add Credits you own.</p>'
                : mineHere.length
                  ? `<p class="tk-sel term-desc"><span id="n-sel">Pick the ones to convert.</span></p>
                     <div class="picker captioned" id="picker">${mineHere.map(pick).join('')}</div>`
                  : `<p class="term-desc">${owned.length ? `None of yours are printed in ${lane().name.toLowerCase()} only.` : 'No Credits in this wallet.'}</p>`
            }
            ${account && lane().ink >= 0 && owned.length > mineHere.length ? `<p class="tk-back small"><button type="button" class="link small" id="tk-back">← Back to Mixed</button> for your other ${plural(owned.length - mineHere.length)}</p>` : ''}
          </section>
          ${getHtml(false)}
          ${batchHtml()}<div class="submit">${goHtml('Pick Credits')}</div>`;
  }
  function outHtml() {
    const ps = outHere();
    const from = outFrom ? waiting.find((u) => u.s.address === outFrom) : undefined;
    return `
          <div class="tk-gethead"><h2 class="form-title">${from ? `Withdraw from ${nameOf(lane(), from)}` : 'Withdraw'}</h2></div>
          <section class="rule">
            <p class="term-desc" id="n-out">${ps.length > 1 ? 'Pick some, or withdraw all.' : ''}</p>
            <div class="picker captioned" id="out-picker">${ps.map((p) => `<button type="button" class="pick" data-id="${p.id}" aria-pressed="${outPicks.has(p.id.toString())}" aria-label="Credit #${p.id}" title="Credit #${p.id} · ${pts(t(p.id))} rating"><img src="${art(p.id)}" alt="" loading="lazy"><span class="pick-id num">${pts(t(p.id))}</span></button>`).join('')}</div>
          </section>
          <div class="submit"><button type="button" class="btn primary block" id="leave">Withdraw ${ps.length > 1 ? 'all ' : ''}${plural(ps.length)}</button>${linkHtml('buy', 'Back')}</div>`;
  }
  /// The batch a buy or a conversion goes into, said plainly above the button: the Credits wait in it, it converts
  /// when the 80th lands, and until then they come back on request.
  function batchHtml() {
    const l = lane();
    const count = curOf(l)?.s.count ?? 0;
    return `<div class="tk-batch" id="tk-batch"${viaSheet() ? '' : ' hidden'}>
            <p class="tk-batch-head"><span>${curOf(l) ? nameOf(l, curOf(l)!) : `New ${l.name} batch`}</span><span class="num" id="tk-bn">${count} of 80</span></p>
            <div class="tk-fill" style="${inkVar(l)}"><i class="y" id="tk-fy" style="width:0"></i><i class="o" id="tk-fo" style="width:${(count / 80) * 100}%"></i></div>
            <div class="tk-keyrow"><p class="tk-key small num" id="tk-legend"></p><span class="small muted" id="tk-bfee"></span></div>
            <p class="small muted"><span id="tk-bget">When it fills to 80, it converts to ${TOKEN}, split by the rating each of you put in. Until then, withdraw anytime.</span></p>
          </div>`;
  }
  const sellHtml = () => `${payHtml(true)}${getHtml(true)}
          <div class="submit">${goHtml('Enter an amount')}</div>`;

  /// Listeners on the document from the last draw, dropped when the page draws again.
  let drawn = new AbortController();
  function draw() {
    drawn.abort();
    drawn = new AbortController();
    const l = lane();
    const cur = curOf(l);
    const v = viewNow();
    const curMine = new Set(cur ? mineIn(cur).map(String) : []);
    const count = cur?.s.count ?? 0;
    // Credits that came in since this batch was last drawn here drop into the sheet, in order.
    const was = cur ? shown.get(cur.s.address) : undefined;
    const fresh = was !== undefined && was < count ? was : undefined;
    if (cur) shown.set(cur.s.address, count);
    // The sheet shows the batch's Credits (their hover cards say whose), and open paper for the rest.
    if (cur) registerDeposits(cur.ids, cur.depositors);
    // The batches yours wait in, by color, oldest first: a full one waiting to convert isn't the one filling now.
    const yourBatches = LANES.flatMap((x) => waiting.filter((u) => laneOf(u.s) === x && mineIn(u).length).reverse());
    // Yours, under the title: only when there's something (BALANCE held, Credits waiting, a payout to claim).
    // Yours: what this wallet holds and has waiting, each with the one thing to do about it. Only when there's something.
    const rows: string[] = [];
    // A small picture leads each row: up to three of the Credits fanned, the Statement, or the coin.
    const fan = (ids: readonly bigint[]) => `<span class="tk-yart tk-fan">${ids.slice(0, 3).map((id) => `<img src="${art(id)}" alt="" loading="lazy">`).join('')}</span>`;
    // The coin: the amount in the BALANCE digits (they have no "$"), whole, shrunk to fit its 40px (8 to the advance).
    const coin = (shown: string) => {
      const text = shown.replace(/\.\d+$/, '');
      return `<span class="tk-yart"><span class="tk-ycoin">${balanceSvg(text, myPal ?? EVEN, Math.min(2, 40 / Math.max(1, text.length * 8 - 1)))}</span></span>`;
    };
    // One shape for every row: its art, a bold line and a grey line under it, and the one action on the right.
    const row = (artHtml: string, title: string, sub: string | string[], action = '') => `<div class="tk-yrow">${artHtml}<div class="tk-ytext"><b>${title}</b>${[sub].flat().filter(Boolean).map((l) => `<span class="muted small">${l}</span>`).join('')}</div>${action}</div>`;
    // Until trading opens, BALANCE in a wallet can't move: the row says until when.
    const inWallet = isOpen ? 'In your wallet' : `In your wallet, locked until ${whenShort(tradesAt)}`;
    if (m && tokenHeld > 0n) rows.push(row(coin(tokAmt(tokenHeld)), `<span class="num">${tokAmt(tokenHeld)}</span> ${TOKEN}`, inWallet));
    else if (!m && held && held.amount > 0n) rows.push(row(coin(amount(held.amount)), `<span class="num">${amount(held.amount)}</span> ${TOKEN}`, inWallet));
    for (const u of yourBatches) {
      const l = laneOf(u.s)!, mine = mineIn(u), p = u.s.phase;
      // What they pay out when it converts, after the fee this batch opened with (the same figure as the batch box).
      const worth = Math.floor((mine.reduce((n, id) => n + t(id), 0) / 10) * (1 - u.s.protocolFeeBps / 10_000));
      // Full: waiting for BALANCE to open, converting (locked), or its hour passed unconverted (withdrawable again).
      const where = p === 'Open' ? `${u.s.count} of 80 so far` : p === 'Waiting' ? (trade?.open || convertsAt <= Date.now() + 60_000 ? 'Full, converting soon' : `Full, converts ${whenShort(convertsAt)}`) : p === 'Expired' ? 'Full, waiting to convert' : 'Full, converting now';
      rows.push(
        row(
          fan(mine),
          `${plural(mine.length)} in ${nameOf(l, u)}`,
          [worth ? `${worth.toLocaleString('en-US')} ${TOKEN} expected` : '', where],
          p === 'Burnable' ? '' : `<button type="button" class="tk-yact quiet" data-out="${l.key}" data-batch="${u.s.address}">Withdraw</button>`,
        ),
      );
    }
    // Credits still in the wallet: what they'd convert into, and the way to do it.
    if (owned.length) {
      const worth = est(owned.reduce((n, id) => n + t(id), 0));
      rows.push(row(fan([...owned].sort((x, y) => t(y) - t(x))), `${plural(owned.length)} to convert`, `≈ ${worth.toLocaleString('en-US')} ${TOKEN}`, viewNow() === 'credits' ? '' : '<button type="button" class="tk-yact go" data-view="credits" data-all>Convert</button>'));
    }
    for (const x of myStmts)
      rows.push(row(`<span class="tk-yart"><img class="st" src="/statement/${x.id}.svg" alt=""></span>`, `Statement #${x.id}`, `${x.rating.toLocaleString('en-US')} ${TOKEN}`, x.ready ? `<button type="button" class="tk-yact go" data-redeem="${x.id}">Redeem</button>` : `<span class="tk-yact tk-ylater">${Date.now() < OPENS_AT ? whenShort(OPENS_AT) : 'Soon'}</span>`));
    // Owed from a converted batch: claimable once the token's transfers open (the keeper usually pays it first).
    if (got.claim.length)
      rows.push(paying ? row(coin(amount(got.amount)), 'Payout ready', `${TOKEN} from a converted batch`, '<button type="button" class="tk-yact go" id="claim">Claim</button>') : row(coin(amount(got.amount)), `<span class="num">${amount(got.amount)}</span> ${TOKEN}`, ['Converted, held for you', `Lands in your wallet ${whenShort(tradesAt)}`]));
    // Yours: a sidebar always beside the card, so what you hold and have waiting never hides. Empty, it says so.
    const wallet = `<aside class="tk-side" aria-label="Yours"><h2 class="form-title">Yours</h2>${
      !account ? '<p class="muted small">Connect to see your $BALANCE, Credits waiting to convert and Statements to redeem.</p>'
        : rows.length ? rows.join('') : '<p class="muted small">Nothing yet. What you buy or convert shows here until it lands.</p>'
    }</aside>`;
    // Until trading opens: one line under the headline, what to do now and when BALANCE unlocks, in the viewer's own
    // time, counting down.
    const stepsHtml = () => {
      const left = '<span id="tk-left"></span>';
      const unlocks = `Jack’s contract unlocks it for trading ${whenShort(tradesAt)}${converting ? left : ''}.`;
      const now = converting
        ? `Convert your Credits into ${TOKEN} now.`
        : convertsWhen === 'Any minute now' ? 'Converting starts any minute.' : convertsWhen.startsWith('Once') ? `Converting starts once ${TOKEN} is live.` : `Converting starts ${convertsWhen}${left}.`;
      return `<p class="tk-when"><b>${now}</b> <span class="muted">${unlocks}</span></p>`;
    };
    kept.clear();
    app.innerHTML = `
    <section class="tokens">
      <header class="create-head"><h1>${isOpen && !previewSoon ? TOKEN : `Get in before ${TOKEN} ${converting ? 'trades' : 'opens'}`}</h1><p class="create-lede"><button type="button" class="link" id="tk-how">What is ${TOKEN}?</button></p></header>
      ${isOpen && !previewSoon ? '' : stepsHtml()}
      <div class="tk-layout">
      <section class="tk-card">
        <form class="design-form tk-form" novalidate style="${inkVar(l)}">
          ${tabsHtml()}
          ${v === 'sell' ? sellHtml() : v === 'credits' ? creditsHtml() : v === 'out' ? outHtml() : buyHtml()}
        </form>
      </section>
      ${wallet}
      </div>
      ${
        made.length
          ? `<section class="tokens-made"><h3>Converted</h3><div class="made-row">${made
              .map((c) => {
                const n = Number(formatUnits(c.amount, got.decimals)).toLocaleString('en-US', { maximumFractionDigits: 0 });
                return c.art
                  ? `<a class="made" href="${balanceHref(c.art)}"><img src="${balanceSrc(c.art)}" alt="Balance #${c.art.id}" decoding="async"><span class="small"><span class="sw-ink">${swatch(c.lane)}</span>Balance #${c.art.id}</span></a>`
                  : `<a class="made" href="/statement/${c.sid}"><img src="/statement/${c.sid}.svg" alt="Statement #${c.sid}" loading="lazy" decoding="async"><span class="small"><span class="sw-ink">${swatch(c.lane)}</span>#${c.sid}<span class="muted num"> · ${n}</span></span></a>`;
              })
              .join('')}</div></section>`
          : ''
      }
    </section>`;
    previewed = ''; // the batch box's bar and key come from drawSheet, so its first run goes through
    bind();
    prices();
    paint();
  }

  /// Everything that follows from what's typed or picked, for the view that's open.
  function paint() {
    const v = viewNow();
    if (v === 'buy') void buySync();
    else if (v === 'sell') void sellSync();
    else if (v === 'credits') creditsSync();
    else outSync();
  }

  let quoteRun = 0;
  /// The buy typed: what a batch gets (at once, from the book; with Uniswap buying what it leaves), and what Uniswap gets
  /// for all of it (a beat after typing stops). It goes through a batch when that gets clearly more, unless you asked for
  /// now.
  async function buySync() {
    const wei = amountIn();
    const run = ++quoteRun;
    const b = sweeps && market === 'ready' ? viaBatch(wei, laneKey, capOf(lane())) : null;
    const left = b?.out.length && poolOk() && wei - b.spent >= DUST ? wei - b.spent : 0n;
    let q: bigint | null = null, qLeft: bigint | null = null;
    if (wei && poolOk()) {
      const go = document.getElementById('go') as HTMLButtonElement | null;
      if (go && !busy) go.disabled = true;
      await wait(250);
      if (run !== quoteRun) return;
      [q, qLeft] = await Promise.all([swapQuote(m!, true, wei).then((r) => r?.net ?? null), left ? swapQuote(m!, true, left).then((r) => r?.net ?? null) : null]);
      if (run !== quoteRun || !app.isConnected) return;
    }
    paintBuy(wei, b, q, qLeft !== null ? left : 0n, qLeft);
  }
  function paintBuy(wei: bigint, b: ReturnType<typeof viaBatch> | null, q: bigint | null, left: bigint, qLeft: bigint | null) {
    const tok = (v: bigint | null) => (v !== null ? Number(formatUnits(v, m!.decimals)) : 0);
    const poolN = tok(q), leftN = tok(qLeft);
    const hasBatch = !!b && b.out.length > 0;
    const withBatch = hasBatch ? b!.tokens + leftN : 0;
    const batchWins = hasBatch && (!poolN || withBatch > poolN * BATCH_EDGE);
    st = lane().ink < 0 ? stmtFor(wei) : null; // a pure colour comes only through its batch
    const stN = st ? st.rating! : 0;
    // The ways, each with what it gets. Waiting (a batch to fill, a Statement to redeem) has to beat instant by 1%.
    const ways = ([['pool', poolN], ['batch', withBatch], ['statement', stN]] as [Route, number][]).filter(([, n]) => n > 0);
    // Compared per ETH spent (a Statement may use only part of the amount); instant gets the 1% edge.
    const spentOn = (r: Route) => Number(formatUnits(r === 'statement' ? BigInt(st!.price) : r === 'batch' ? b!.spent + left : wei, 18)) || 1;
    const score = ([r, n]: [Route, number]) => (n / spentOn(r)) * (r === 'pool' ? BATCH_EDGE : 1);
    const best = ways.length ? ways.reduce((a, x) => (score(x) > score(a) ? x : a))[0] : null;
    route = !wei ? null : chosen && ways.some(([r]) => r === chosen) ? chosen : best;
    void batchWins;
    const split = route === 'batch' && leftN > 0;
    plan = route === 'batch' ? { b: b!, left: split ? left : 0n } : null;
    const way = wayNow();
    const batchPal = paletteOf(lane()), pPal = poolPal ?? EVEN;
    // You get, in the colors it comes in: a split mixes the batch's and the pool's by amount.
    setGet(
      route === 'batch' ? withBatch : route === 'pool' ? poolN : route === 'statement' ? stN : 0,
      split ? (batchPal.map((v, i) => (v * b!.tokens + pPal[i] * leftN) / withBatch) as Palette) : route === 'pool' || (!route && way === 'pool') ? pPal : batchPal,
    );
    // The rate first (what a BALANCE costs on this way), then how it arrives.
    const gets = route === 'batch' ? withBatch : route === 'pool' ? poolN : route === 'statement' ? stN : 0;
    const paid = route === 'statement' ? BigInt(st!.price) : route === 'batch' ? b!.spent + (split ? left : 0n) : wei;
    const per = paid && gets ? Number(formatUnits(paid, 18)) / gets : 0;
    const rate = per ? `${usd ? `$${(per * usd).toPrecision(2)}` : `${per.toPrecision(2)} ETH`} each` : '';
    setText('amt-usd', dollars(Number(formatUnits(wei, 18))));
    // Two lines: what each one costs, then how it arrives and what we take on that way.
    setText('tk-gettitle', way === 'batch' || route === 'statement' ? 'You’ll get' : 'You get');
    // Each fee sits by what it comes out of: the conversion fee under the tokens, the buy fee on the button's ETH.
    // Under the button, what the buy does, and the buy fee it already has in it.
    const n = hasBatch ? b!.out.length : 0;
    setText('route', route === 'batch' && n ? feeLine(b!.out.reduce((a, x) => a + t(x.id), 0)) : rate);
    // Through a batch: the Credits it buys, then what they become.
    const from = document.getElementById('get-from');
    if (from) from.innerHTML = route === 'batch' && n ? `<span class="tk-yart tk-fan">${b!.out.slice(0, 3).map((x) => `<img src="${art(Number(x.id))}" alt="" loading="lazy">`).join('')}</span><span class="tk-arrow" aria-hidden="true">→</span>` : '';
    setText('go-note', route === 'batch' && n && feeBps ? `Includes our ${pct(feeBps)} fee.` : '');
    setText('route2', split ? `${whole(leftN)} via Uniswap · instant` : '');
    const label: Record<Route, [string, string]> = {
      pool: ['Uniswap', `Instant${m?.feeBps ? ` · ${pct(m.feeBps)} fee` : ''}`],
      batch: ['Credits', `In a ${lane().name} batch, lands when it fills`],
      statement: [st ? `Statement #${st.id}` : 'Statement', `On OpenSea · redeems when ${TOKEN} opens`],
    };
    const box = document.getElementById('tk-batch'), home = document.getElementById('tk-batch-home');
    if (box && home && box.parentElement !== home) home.append(box);
    setText(
      'alt',
      wei && ways.length > 1
        ? `<div class="tk-ways" role="radiogroup" aria-label="Way to buy">${ways
            .map(([r, n]) => `<button type="button" class="tk-way" role="radio" data-route="${r}" aria-checked="${r === route}"><span><b>${label[r][0]}</b>${r === best ? '<span class="tag">Best</span>' : ''}<span class="muted small">${label[r][1]}</span></span><span class="num">${whole(n)}<span class="muted small"> for ${ethNum(BigInt(Math.round(spentOn(r) * 1e18)), 3)} ETH</span></span></button>`)
            .join('')}</div>`
        : '',
    );
    // Picked through Credits with other ways on show: the batch box hangs off the Credits row, joined to it.
    const row = document.querySelector<HTMLElement>('.tk-way[data-route="batch"]');
    if (box) box.classList.toggle('attached', !!row && route === 'batch');
    if (box && row && route === 'batch') row.after(box);
    setText(
      'fees',
      way === 'batch'
        ? `${split ? `${whole(b!.tokens)} ${lands().toLowerCase()}${m!.feeBps ? ` · ${pct(m!.feeBps)} on the swap` : ''}` : ''}`
        : wei && ways.length > 1
          ? ''
          : route === 'statement'
          ? `Bought on OpenSea · uses ${ethNum(BigInt(st!.price), 3)} of your ${ethNum(wei, 3)} ETH`
          : way === 'pool'
          ? `Instant via Uniswap${m!.feeBps ? ` · ${pct(m!.feeBps)} fee` : ''}`
          : '',
    );
    setText('tk-bfee', '');
    // Under the amount, only what needs saying: still looking, nothing for sale, too little for one, one buy's limit.
    const ls = pools.get(laneKey) ?? [];
    const cheapest = ls.reduce((a, x) => (BigInt(x.price) < a ? BigInt(x.price) : a), ls.length ? BigInt(ls[0].price) : 0n);
    const which = lane().ink < 0 ? '' : `${lane().name.toLowerCase()} `;
    setText(
      'amt-line',
      way === 'batch' && market === 'loading'
        ? ''
        : route !== 'pool' && sweeps && market === 'ready' && !ls.length && (!poolOk() || (wei && !poolN))
          ? `No ${which}Credits for sale right now.`
          : wei && !route && ls.length
            ? `<button type="button" class="link small" id="amt-min" data-amt="${ethNum(cheapest + (cheapest * feeBps) / 10_000n, 4, true)}">Min ${ethNum(cheapest + (cheapest * feeBps) / 10_000n, 4, true)} ETH for one Credit</button>`
            : route === 'batch' && !split && b!.out.length >= MAX_BUY
              ? `${MAX_BUY} Credits at most per buy`
              : '',
    );
    const cost = route === 'batch' ? b!.spent + (split ? left : 0n) : route === 'statement' ? BigInt(st!.price) : wei;
    const short = ethHeld !== null && cost > ethHeld;
    setGo(
      !wei
        ? 'Enter an amount'
        : short
          ? 'Not enough ETH'
          : route === 'batch'
            ? `Buy ${plural(b!.out.length)}${split ? ` + ${whole(leftN)} ${sym()}` : ''} · ${ethNum(b!.spent + (split ? left : 0n), 4, true)} ETH`
            : route === 'pool'
              ? `Get ${whole(poolN)} ${sym()}`
              : route === 'statement'
                ? `Buy Statement #${st!.id} · ${ethNum(BigInt(st!.price), 3)} ETH`
              : sweeps && market === 'loading'
                ? 'Pricing…'
                : ls.length
                  ? 'Not enough for a Credit'
                  : 'No price right now',
      !!wei && !short && !!route,
    );
    showLeft();
    if (viaSheet()) drawSheet();
    else drawHolding(route === 'pool' ? poolN : 0, pPal);
  }

  /// The sale typed: the ETH it gets (a beat after typing stops) and what you'd hold after.
  async function sellSync() {
    const amt = amountIn();
    const run = ++quoteRun;
    setText('route', '');
    setText('fees', `Instant via Uniswap${m!.feeBps ? ` · ${pct(m!.feeBps)} fee` : ''}`);
    showLeft();
    drawHolding(-Number(formatUnits(amt > tokenHeld ? tokenHeld : amt, m!.decimals)), null);
    const out = (v: bigint) => {
      setText('get-eth', Number(formatEther(v)).toLocaleString('en-US', { maximumFractionDigits: 4 }));
      setText('amt-usd', dollars(Number(formatEther(v))));
    };
    if (!amt) {
      setGo('Enter an amount', false);
      setText('amt-line', '');
      out(0n);
      return;
    }
    const short = amt > tokenHeld;
    setGo(short ? `Not enough ${sym()}` : `Sell ${tokAmt(amt)} ${sym()}`, false);
    await wait(250);
    if (run !== quoteRun) return;
    const q = await swapQuote(m!, false, amt);
    if (run !== quoteRun || !app.isConnected) return;
    setText('amt-line', q ? '' : 'No price right now.');
    out(q?.net ?? 0n);
    if (!short) setGo(q ? `Sell ${tokAmt(amt)} ${sym()}` : 'No price', !!q);
  }

  /// Your Credits picked: what they pay out, which of them would pay their own color, and the button.
  function creditsSync() {
    const here = new Set(ownedHere().map(String));
    const mine = [...picks].filter((id) => here.has(id)).map(BigInt);
    const tenths = mine.reduce((a, id) => a + t(id), 0);
    setGet(tenths ? est(tenths) : 0, paletteOf(lane()));
    setText('route', tenths ? feeLine(tenths) : '');
    // How many wallet confirmations it takes: 40 Credits a transaction, the open batch's room first, then new batches.
    let txs = 0;
    for (let left = mine.length, room = 80 - (curOf(lane())?.s.count ?? 80); left > 0; txs++) {
      const take = Math.min(left, CHUNK, room > 0 ? room : 80);
      left -= take;
      room = room > 0 ? room - take : 80 - take;
    }
    setText('fees', '');
    setText('tk-bfee', txs > 1 ? `${txs} confirmations` : '');
    const all = document.getElementById('pick-all');
    if (all) all.textContent = mine.length ? 'Clear' : 'Select all';
    setText('n-sel', mine.length ? `${mine.length} of your ${ownedHere().length} picked` : `Pick from your ${ownedHere().length}.`);
    setGo(mine.length ? `Convert ${plural(mine.length)}${trade?.open || converting ? '' : ' · converts when it opens'}` : 'Pick Credits', mine.length > 0);
    showLeft();
    drawSheet();
  }

  function outSync() {
    const n = outHere().filter((p) => outPicks.has(p.id.toString())).length, all = outHere().length;
    const btn = document.getElementById('leave');
    if (btn && !busy) btn.textContent = n ? `Withdraw ${plural(n)}` : `Withdraw ${all > 1 ? 'all ' : ''}${plural(all)}`;
    setText('n-out', n ? `${n} of ${all} picked` : all > 1 ? 'Pick some, or withdraw all.' : '');
    showLeft();
    drawSheet();
  }

  /// Each color in the menu says, on hover, what a batch of it costs per 1,000 BALANCE, how full it is, and yours.
  function prices() {
    for (const el of $$<HTMLElement>('.tk-menu [data-lane]', app)) {
      const x = LANES.find((y) => y.key === el.dataset.lane)!;
      const p = market === 'ready' ? batchPrice(x) : null;
      const n = curOf(x)?.s.count ?? 0, f = fullOf(x), fit = owned.filter((id) => fitsLane(x, inkOf(id))).length;
      el.title = [x.ink < 0 ? 'Any Credit, the cheapest' : `${x.name} only`, p ? `${ethNum(p, 4)} ETH per 1,000 ${TOKEN}` : '', `${n} of 80 in`, f ? `${f} full` : '', x.ink >= 0 && fit ? `you have ${fit}` : ''].filter(Boolean).join(' · ');
    }
  }

  /// To another color. In your Credits, a pure one opens with yours of its ink picked (or just `keep`, when they're
  /// moved over).
  function switchLane(key: Lane['key'], keep?: string[]) {
    if (key === laneKey && !keep) return;
    laneKey = key;
    picks.clear();
    if (keep) keep.forEach((id) => picks.add(id));
    else if (lane().ink >= 0 && viewNow() === 'credits') for (const id of ownedHere()) picks.add(id.toString());
    history.replaceState(history.state, '', laneKey === 'any' ? '/balance' : `/balance?color=${laneKey}`);
    draw();
  }

  /// The color chip's menu: arrows move, Enter picks, Escape or a click elsewhere closes.
  function bindColor() {
    const box = app.querySelector<HTMLElement>('.tk-color');
    const btn = box?.querySelector<HTMLButtonElement>('#tk-color');
    const menu = box?.querySelector<HTMLElement>('.tk-menu');
    if (!box || !btn || !menu) return;
    const opts = [...menu.querySelectorAll<HTMLElement>('[data-lane]')];
    const open = (on: boolean) => {
      menu.hidden = !on;
      btn.setAttribute('aria-expanded', String(on));
      if (on) (opts.find((o) => o.getAttribute('aria-selected') === 'true') ?? opts[0]).focus();
    };
    const choose = (o: HTMLElement) => {
      open(false);
      switchLane(o.dataset.lane as Lane['key']);
    };
    btn.addEventListener('click', () => open(menu.hidden === true));
    menu.addEventListener('click', (e) => {
      const o = (e.target as HTMLElement).closest<HTMLElement>('[data-lane]');
      if (o) choose(o);
      else if ((e.target as HTMLElement).closest('#how-color')) open(false);
    });
    menu.addEventListener('keydown', (e) => {
      const i = opts.indexOf(document.activeElement as HTMLElement);
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        opts[(i + (e.key === 'ArrowDown' ? 1 : opts.length - 1)) % opts.length].focus();
      } else if ((e.key === 'Enter' || e.key === ' ') && i >= 0) {
        e.preventDefault();
        choose(opts[i]);
      } else if (e.key === 'Escape') {
        open(false);
        btn.focus();
      }
    });
    box.addEventListener('focusout', (e) => {
      const to = e.relatedTarget as Node | null;
      if (to && !box.contains(to)) open(false);
    });
    document.addEventListener('pointerdown', (e) => !menu.hidden && !box.contains(e.target as Node) && open(false), { signal: drawn.signal });
  }

  function bind() {
    // The views: Buy · Sell, and the links between Buy, your Credits and Withdraw.
    $$<HTMLButtonElement>('[data-view]', app).forEach((b) =>
      b.addEventListener('click', () => {
        const k = b.dataset.view as typeof view;
        if (b.disabled || k === viewNow()) return;
        if (viewNow() === 'credits') picks.clear();
        view = k;
        typed = '';
        // Into Convert from the sidebar, or a pure colour: every Credit of yours that fits is picked already.
        if (k === 'credits' && (lane().ink >= 0 || b.hasAttribute('data-all'))) for (const id of ownedHere()) picks.add(id.toString());
        draw();
      }),
    );
    const amt = document.getElementById('amt') as HTMLInputElement | null;
    amt?.addEventListener('input', () => {
      typed = amt.value;
      $$<HTMLButtonElement>('.tk-q', app).forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.amt === typed.trim())));
      paint();
    });
    document.getElementById('route')?.addEventListener('click', (e) => {
      if (!(e.target as HTMLElement).closest('#fee-rate')) return;
      feeAsRate = !feeAsRate;
      paint();
    });
    document.getElementById('amt-line')?.addEventListener('click', (e) => {
      const min = (e.target as HTMLElement).closest<HTMLElement>('#amt-min')?.dataset.amt;
      if (!min || !amt) return;
      typed = amt.value = min;
      $$<HTMLButtonElement>('.tk-q', app).forEach((x) => x.setAttribute('aria-pressed', 'false'));
      paint();
    });
    $$<HTMLButtonElement>('.tk-q', app).forEach((q) =>
      q.addEventListener('click', () => {
        if (!amt) return;
        typed = q.dataset.amt!;
        amt.value = typed;
        $$<HTMLButtonElement>('.tk-q', app).forEach((x) => x.setAttribute('aria-pressed', String(x === q)));
        paint();
      }),
    );
    document.getElementById('amt-max')?.addEventListener('click', () => {
      if (!amt) return;
      if (viewNow() === 'sell') typed = formatUnits(tokenHeld, m!.decimals);
      else {
        if (ethHeld === null) return;
        const v = ethHeld > GAS_KEEP ? ethHeld - GAS_KEEP : 0n;
        typed = (Number((v * 10_000n) / 10n ** 18n) / 10_000).toString(); // down to 4 places
      }
      amt.value = typed;
      paint();
    });
    // The other way, when it's a real choice: now on Uniswap, or more through a batch.
    document.getElementById('alt')?.addEventListener('click', (e) => {
      const r = (e.target as HTMLElement).closest<HTMLElement>('[data-route]')?.dataset.route;
      if (!r) return;
      chosen = r as Route;
      instant = r === 'pool';
      paint();
    });
    bindColor();
    document.getElementById('picker')?.addEventListener('click', (e) => {
      const el = (e.target as HTMLElement).closest<HTMLElement>('.pick');
      if (!el) return;
      const id = el.dataset.id!;
      picks.has(id) ? picks.delete(id) : picks.add(id);
      el.setAttribute('aria-pressed', String(picks.has(id)));
      paint();
    });
    document.getElementById('pick-all')?.addEventListener('click', () => {
      const here = ownedHere();
      const any = here.some((id) => picks.has(id.toString()));
      here.forEach((id) => (any ? picks.delete(id.toString()) : picks.add(id.toString())));
      $$<HTMLElement>('#picker .pick', app).forEach((p) => p.setAttribute('aria-pressed', String(picks.has(p.dataset.id!))));
      paint();
    });
    document.getElementById('tk-back')?.addEventListener('click', () => switchLane(LANES.find((x) => x.ink < 0)!.key, owned.filter((id) => !ownedHere().includes(id)).map(String)));
    const go = document.getElementById('go') as HTMLButtonElement | null;
    go?.addEventListener('click', () => {
      const v = viewNow(), l = lane(), wei = amountIn();
      if (v === 'sell')
        return run(
          go,
          'Selling…',
          async () => {
            const q = await swapQuote(m!, false, wei);
            if (!q) throw new Error('No price right now. Try again in a moment.');
            const calls = await sellCalls(m!, account!, wei, q.net);
            if (calls.length > 1 && (await canBatch())) await sendBatch(calls, note);
            else for (const c of calls) await send(c, note);
          },
          'Sold.',
        );
      if (v === 'buy' && route === 'statement' && st) {
        const x = st;
        return void buyListed(go, x, () => {
          stmts = stmts.filter((y) => y.id !== x.id);
          toast(`Statement #${x.id} is yours. It redeems for ${x.rating!.toLocaleString('en-US')} ${TOKEN} when it opens.`, 'ok', 8000);
          draw();
        });
      }
      if (v === 'buy' && route === 'pool')
        return run(
          go,
          'Buying…',
          async () => {
            const q = await swapQuote(m!, true, wei);
            if (!q) throw new Error('No price right now. Try again in a moment.');
            await send(await buyCall(m!, wei, q.net), note);
          },
          `Bought ${sym()}.`,
        );
      if (v === 'buy') {
        const split = !!plan?.left;
        return run(
          go,
          'Buying…',
          async () => {
            const spent = await buyIn(pickFor(l, wei, capOf(l)), approved as boolean, l);
            if (!split) return;
            // What the batch left, less what its transaction cost, on Uniswap.
            const bal = await pub.getBalance({ address: account! });
            const left = wei - spent < bal - GAS_KEEP ? wei - spent : bal - GAS_KEEP;
            if (left < DUST) return;
            const q = await swapQuote(m!, true, left);
            if (!q) throw new Error('The batch part went through; Uniswap has no price right now. Try the rest again in a moment.');
            await send(await buyCall(m!, left, q.net), note);
          },
          split ? 'Done. The Uniswap part is in; the batch part lands when it fills.' : 'Done. It lands when the batch fills.',
        );
      }
      return run(
        go,
        'Adding…',
        async () => {
          const here = new Set(ownedHere().map(String));
          const mine = [...picks].filter((id) => here.has(id)).map(BigInt);
          const approve = { address: config.credits, abi: creditsAbi, functionName: 'setApprovalForAll', args: [factory, true] } as const;
          if (!approved && (await canBatch())) {
            const [one] = await depositCalls(factory, await openUnion(factory, l, curOf(l)?.s.address), mine, l);
            await sendBatch([approve, one], note);
            await depositAll(mine.slice(one.ids.length), l);
          } else {
            if (!approved) await send(approve, note);
            await depositAll(mine, l, curOf(l)?.s.address);
          }
          picks.clear();
        },
        'Done. It lands when the batch fills.',
      );
    });
    document.getElementById('out-picker')?.addEventListener('click', (e) => {
      const el = (e.target as HTMLElement).closest<HTMLElement>('.pick');
      if (!el) return;
      const id = el.dataset.id!;
      outPicks.has(id) ? outPicks.delete(id) : outPicks.add(id);
      el.setAttribute('aria-pressed', String(outPicks.has(id)));
      outSync();
    });
    document.getElementById('leave')?.addEventListener('click', (e) =>
      run(e.currentTarget as HTMLElement, 'Withdrawing…', async () => {
        const picked = outHere().filter((p) => outPicks.has(p.id.toString()));
        const out = picked.length ? picked : outHere();
        for (const u of new Set(out.map((p) => p.u))) {
          const ids = out.filter((p) => p.u === u).map((p) => p.id);
          for (let i = 0; i < ids.length; i += CHUNK) await send({ address: u.s.address, abi: batchAbi, functionName: 'withdraw', args: [ids.slice(i, i + CHUNK)] }, note);
        }
        outPicks.clear();
      }, 'Withdrawn. They’re back in your wallet.'),
    );
    // From the line under the title: to the color your Credits wait in, on Withdraw.
    $$<HTMLButtonElement>('[data-out]', app).forEach((x) =>
      x.addEventListener('click', () => {
        view = 'out';
        typed = '';
        outFrom = (x.dataset.batch as Address | undefined) ?? null;
        outPicks.clear();
        const to = x.dataset.out as Lane['key'];
        if (to !== laneKey) switchLane(to);
        else draw();
        document.querySelector('.tk-form')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }),
    );
    // Redeem a Statement you hold: approve the token for that one Statement, then withdraw its exact quote.
    $$<HTMLButtonElement>('[data-redeem]', app).forEach((x) =>
      x.addEventListener('click', () =>
        run(
          x,
          'Redeeming…',
          async () => {
            const id = BigInt(x.dataset.redeem!);
            const vault = await vaultOf();
            if (!vault || !config.statements) throw new Error(`${TOKEN} isn't live yet.`);
            const q = (await pub.readContract({ address: vault, abi: VAULT_ABI, functionName: 'quote', args: [id] })) as bigint;
            await send({ address: config.statements, abi: ST_ABI, functionName: 'approve', args: [vault, id] }, note);
            await send({ address: vault, abi: VAULT_ABI, functionName: 'withdraw', args: [id, q] }, note);
            myStmts = myStmts.filter((y) => y.id !== id);
          },
          'Redeemed.',
        ),
      ),
    );
    document.getElementById('how-color')?.addEventListener('click', howColor);
    document.getElementById('tk-how')?.addEventListener('click', howBalance);
    const left = document.getElementById('tk-left');
    if (left) {
      const tick = () => {
        const ms = (converting ? tradesAt : convertsAt) - Date.now();
        if (ms <= 0) return void (left.textContent = '');
        const d = Math.floor(ms / 86_400_000), h = Math.floor((ms % 86_400_000) / 3_600_000), mn = Math.floor((ms % 3_600_000) / 60_000);
        left.textContent = ` · in ${d ? `${d}d ` : ''}${h}h${d ? '' : ` ${mn}m`}`;
      };
      tick();
      const iv = setInterval(tick, 60_000);
      drawn.signal.addEventListener('abort', () => clearInterval(iv));
    }

    // The keeper pays everyone out; this is the fallback.
    document.getElementById('claim')?.addEventListener('click', (e) =>
      run(e.currentTarget as HTMLElement, 'Claiming…', async () => {
        for (const u of got.claim) await send({ address: config.tokenAdapter!, abi: tokenAdapterAbi, functionName: 'claim', args: [u, account!] }, note);
      }, 'Claimed.'),
    );
  }

  /// How a color gets from a Credit to a wallet, with the real thing at each step: a cyan-only Credit, Statement #16
  /// (Colors C, the C100 in Jack's own Balance previews), its BALANCE, and two wallets' colors mixing.
  /// How it works, the short version, in a modal: the three ways in, and what we take.
  function howBalance() {
    const d = document.createElement('dialog');
    d.className = 'how';
    // The whole idea in one row of real art: a Credit, 80 of them make a Statement, a Statement redeems for its rating.
    const cyan = inks.findIndex((x) => x === 1) + 1;
    const paletteC: Palette = PURE[0];
    d.innerHTML = `<h3>What is ${TOKEN}?</h3>
      <p class="how-lede muted">A coin made from art. Credits are Jack Butcher's onchain NFTs: 80 make a Statement, and a Statement turns into one ${TOKEN} for each point of its rating.</p>
      <div class="how-flow">
        <figure><span class="how-tile"><img src="${art(cyan)}" alt="Credit #${cyan}"></span><figcaption class="small"><b>1 Credit</b><span class="muted">Rated ${pts(t(BigInt(cyan)))}</span></figcaption></figure>
        <span class="how-arrow muted" aria-hidden="true">→</span>
        <figure><span class="how-tile"><img class="st" src="/statement/16.svg" alt="Statement #16"></span><figcaption class="small"><b>1 Statement</b><span class="muted">80 Credits, rated 34,270</span></figcaption></figure>
        <span class="how-arrow muted" aria-hidden="true">→</span>
        <figure><span class="how-tile">${balanceSvg('34,270', paletteC, 1)}</span><figcaption class="small"><b>34,270 ${TOKEN}</b><span class="muted">1 point = 1 ${TOKEN}</span></figcaption></figure>
      </div>
      <h4 class="how-ways">Three ways to get it</h4>
      <ol class="how-steps">
        <li><b>Buy it</b><span class="muted">Pay ETH, get ${TOKEN}. Instant, through Uniswap.</span></li>
        <li><b>Convert your Credits</b><span class="muted">Put them in a batch with other holders. At 80 it turns into ${TOKEN}, split by the rating each of you put in. Take them back anytime before it converts.</span></li>
        <li><b>Redeem a Statement</b><span class="muted">Own one? It redeems for its rating in ${TOKEN} once it opens.</span></li>
      </ol>
      <p class="small muted">${pct(bpsOf())} on conversion, ${pct(feeBps)} sweep fee on Credits bought${m?.feeBps ? `, ${pct(m.feeBps)} on swaps` : ''}. Unofficial: Credit Union isn't run by Jack Butcher. <a href="/docs#balance">Full docs</a></p>`;
    document.body.append(d);
    d.addEventListener('close', () => d.remove());
    openModal(d);
  }
  function howColor() {
    const cyan = inks.findIndex((m) => m === 1) + 1;
    const n = (text: string, p: Palette, unit = 3) => `<span class="how-paper">${balanceSvg(text, p, unit)}</span>`;
    const step = (pic: string, text: string) => `<li><div class="color-art">${pic}</div><p>${text}</p></li>`;
    const d = document.createElement('dialog');
    d.className = 'how how-color';
    d.innerHTML = `<form method="dialog">
      <h3>How ${TOKEN} gets its color</h3>
      <ol class="color-steps">
        ${step(`<img src="${art(cyan)}" alt="Credit #${cyan}">`, 'A Credit is printed in ink, for good. This one is cyan only.')}
        ${step('<img class="st" src="/statement/16.svg" alt="Statement #16">', '80 Credits make a Statement in their ink. Statement #16 is 80 cyan-only Credits.')}
        ${step(n('34,270', PURE[0]), `Converting a Statement releases ${TOKEN} in its ink, one per rating point.`)}
        ${step(`${n('100', PURE[0], 2)}<span class="muted">+</span>${n('100', PURE[1], 2)}<span class="muted">=</span>${n('200', [0.5, 0.5, 0, 0], 2)}`, `Each wallet holds a balance and a color. What arrives mixes in by amount; sending never changes yours.`)}
      </ol>
      <p class="muted small">Colors only get more mixed, so pure ones are made at the start.${gate ? '' : ` This is ${TOKEN} as Jack has announced it; the details are confirmed when his contract launches.`}</p>
    </form>`;
    document.body.append(d);
    d.addEventListener('close', () => d.remove());
    openModal(d);
  }

  /// Off the list for good (sold, or cancelled on OpenSea), so the same amount picks the next cheapest.
  function drop(ids: string[]) {
    const gone = new Set(ids);
    for (const [k, ls] of pools) pools.set(k, ls.filter((x) => !gone.has(x.id)));
    prices();
    paint();
  }

  /// The Credits to buy, re-picked until every one still has a live order and a price: a sold or cancelled listing
  /// drops off and the same choice (the ETH amount) picks the next cheapest. A few rounds, all in one press.
  async function quoteLive(pick: () => Listing[], into: Address | null) {
    for (let round = 0; round < 6; round++) {
      const buy = pick();
      if (!buy.length) break;
      const offers = await listedById(buy.map((x) => x.id), true);
      const alive = new Set(offers.map((o) => o.id));
      const gone = buy.filter((x) => !alive.has(x.id)).map((x) => x.id);
      if (gone.length) {
        drop(gone);
        continue;
      }
      const r = await fetch('/opensea/buyquote', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(into ? { listings: offers, batch: into } : { listings: offers, tokens: true }) });
      const q = (await r.json()) as Quote & { sold?: string[] };
      if (r.ok && !q.error) {
        // A seller who has moved the Credit since listing it would revert the whole buy: it drops off like a sold one.
        const sellers = (q.orders as { parameters?: { offerer?: string } }[]).map((o) => String(o.parameters?.offerer ?? '').toLowerCase());
        const owners = await Promise.all(q.ids.map((id) => pub.readContract({ address: config.credits, abi: creditsAbi, functionName: 'ownerOf', args: [BigInt(id)] }).then((a) => (a as string).toLowerCase(), () => '')));
        const moved = q.ids.filter((_, i) => owners[i] !== sellers[i]);
        if (!moved.length) return { buy, q };
        drop(moved);
        continue;
      }
      if (r.status !== 409 && !/stale|sold/i.test(q.error ?? '')) throw new Error(q.error ?? 'No price right now. Try again.');
      drop(q.sold?.length ? q.sold : buy.map((x) => x.id));
    }
    throw new Error('Credits are selling fast right now. Try again in a moment.');
  }

  /// Buy and put in: swept straight into the color's batch when it has room for all of them (one transaction), else
  /// bought to the wallet and deposited, spilling into the next batch of that color. Returns the ETH it took.
  async function buyIn(pick: () => Listing[], ok: boolean, l: Lane): Promise<bigint> {
    const target = await openUnion(factory, l, curOf(l)?.s.address);
    const room = target ? 80 - target.s.count : 0;
    const into = target && room >= pick().length ? target.s.address : null;
    // A re-pick after a sold listing can come out longer: never more than the batch has room for.
    const { buy, q } = await quoteLive(into ? () => pick().slice(0, room) : pick, into);
    checkQuote(q);
    // Never more than the page showed: a Credit relisted higher stops the buy.
    if (BigInt(q.total) > buy.reduce((a, x) => a + BigInt(x.price), 0n)) throw new Error('Prices moved since this page loaded. Reload, then try again.');
    const sweeper = config.tokenSweeper!;
    const [value, fee] = (await Promise.all([
      pub.readContract({ address: sweeper, abi: sweeperAbi, functionName: 'quote', args: [BigInt(q.total)] }),
      pub.readContract({ address: sweeper, abi: sweeperAbi, functionName: 'feeBps' }),
    ])) as [bigint, bigint];
    const fwa = (q.fwa ?? []).map((f) => ({ listingId: BigInt(f.listingId), price: BigInt(f.price) }));
    const strategy = (q.strategy ?? []).map((f) => ({ tokenId: BigInt(f.id), price: BigInt(f.price) }));
    const ids = [...q.ids, ...(q.fwa ?? []).map((f) => f.id), ...(q.strategy ?? []).map((f) => f.id)];
    if (ids.length < buy.length) toast(`${buy.length - ids.length} sold before you got to them.`, 'info', 8000);
    if (into) {
      await send(
        fwa.length || strategy.length
          ? { address: sweeper, abi: sweeperAbi, functionName: 'sweepAll', args: [into, q.orders, fwa, strategy, 1n, fee], value }
          : { address: sweeper, abi: sweeperAbi, functionName: 'sweep', args: [into, q.orders, 1n, fee], value },
        note,
      );
      return value;
    }
    const receipt = await send({ address: sweeper, abi: sweeperAbi, functionName: 'buy', args: [q.orders, fwa, strategy, 1n, fee], value }, note);
    // What actually arrived (a sold listing is skipped), from the Credits transfers to this wallet.
    const me = account!.toLowerCase();
    const arrived = receipt.logs
      .filter((x) => x.address.toLowerCase() === config.credits.toLowerCase() && x.topics.length === 4 && `0x${x.topics[2]!.slice(26)}` === me)
      .map((x) => BigInt(x.topics[3]!));
    if (!ok) await send({ address: config.credits, abi: creditsAbi, functionName: 'setApprovalForAll', args: [factory, true] }, note);
    await depositAll(arrived, l, into ?? curOf(l)?.s.address);
    return value;
  }

  async function depositAll(ids: bigint[], l: Lane, prefer?: Address) {
    for (let left = ids; left.length; ) {
      const [c] = await depositCalls(factory, await openUnion(factory, l, prefer), left, l);
      await send(c, note);
      left = left.slice(c.ids.length);
    }
  }

  if (!landed) {
    landed = true;
    if (account && owned.length && view === 'buy') {
      view = 'credits';
      for (const id of ownedHere()) picks.add(id.toString());
    } else if (view === 'buy' && !typed) typed = '0.1';
  }
  // Your Credits in a pure color open with yours of that ink picked, however you got here (its card, or a ?color= link).
  if (viewNow() === 'credits' && lane().ink >= 0 && !picks.size) for (const id of ownedHere()) picks.add(id.toString());
  draw();

  // Live: every 20 s while this page is up, and the moment its tab is shown again, look for deposits, withdrawals,
  // new batches and conversions (anyone's), and draw the page again when something moved. What's typed and picked
  // carries over; it waits while a transaction is in flight or the amount is being edited.
  const check = async () => {
    if (thisRun !== pageRun || !app.isConnected) return stop();
    if (busy || document.hidden || document.activeElement?.id === 'amt') return;
    try {
      const read = (u: Union, functionName: 'count' | 'state') => pub.readContract({ address: u.s.address, abi: batchAbi, functionName }) as Promise<bigint | number>;
      const [m, now] = await Promise.all([
        pub.readContract({ address: factory, abi: factoryAbi, functionName: 'batchCount' }) as Promise<bigint>,
        Promise.all(waiting.map((u) => Promise.all([read(u, 'count'), read(u, 'state')]))),
      ]);
      const moved = m !== n || now.some(([c, st], i) => Number(c) !== waiting[i].s.count || Number(st) !== STATES.indexOf(waiting[i].s.state));
      if (moved && thisRun === pageRun && !busy) {
        stop();
        keptPicks = [...picks];
        rerun();
      }
    } catch {}
  };
  const poll = setInterval(check, 20_000);
  const onShow = () => void (!document.hidden && check());
  document.addEventListener('visibilitychange', onShow);
  function stop() {
    clearInterval(poll);
    document.removeEventListener('visibilitychange', onShow);
  }

  // The market, per color, cheapest per rating point first (the book, else the Any batch's cheapest few). Then, for
  // Mixed with nothing typed, which way REF would go.
  if (sweeps)
    void (async () => {
      try {
        const bk = await fetch('/market.json').then((r) => (r.ok ? (r.json() as Promise<{ at?: number; items?: [string, string, string][] }>) : null)).catch(() => null);
        // The book rebuilds every minute. One that stopped for hours lists many orders long gone: then the live scan of
        // the mixed batch's cheapest, and the old book only if that has nothing (a gone order is dropped at quote time).
        const book = (bk?.items ?? []).map(([id, price, source]) => ({ id: String(id), price: String(price), source }));
        const fresh = !!bk?.at && Date.now() - bk.at < 2 * 3600_000;
        let items = fresh ? book : [];
        const anyCur = curOf(LANES[0]);
        if (!items.length && anyCur) {
          const r = await fetch(`/opensea/listings?batch=${anyCur.s.address}`).catch(() => null);
          items = (r?.ok ? ((await r.json()) as { listings?: { id: string; price: string; source: string }[] }).listings : null) ?? [];
        }
        if (!items.length) items = book;
        // Not yours, and not already in a batch (the book can be a few minutes behind a buy).
        const skip = new Set([...owned, ...waiting.flatMap((u) => u.ids)].map(String));
        const ranked = items
          .filter((x) => !skip.has(x.id))
          .map((x) => ({ ...x, tenths: t(x.id) }))
          .filter((x) => x.tenths > 0)
          .sort((a, b) => Number((BigInt(a.price) * 1000n) / BigInt(a.tenths)) - Number((BigInt(b.price) * 1000n) / BigInt(b.tenths)));
        for (const x of LANES) pools.set(x.key, ranked.filter((r) => fitsLane(x, inkOf(r.id))).slice(0, SHOWN));
        market = 'ready';
        if (m && trade?.open) {
          const [q, b] = [await swapQuote(m, true, REF), viaBatch(REF, 'any', capOf(LANES[0]))];
          restMixed = b.out.length && (!q || b.tokens > Number(formatUnits(q.net, m.decimals)) * BATCH_EDGE) ? 'batch' : q ? 'pool' : 'batch';
        }
      } catch {
        market = 'none';
      }
      if (!app.isConnected) return;
      prices();
      paint();
    })();
}

/// The BALANCE a wallet holds now, once the adapter (and so the token) is known.
async function heldBy(you: Address) {
  if (!config.tokenAdapter) return null;
  try {
    const token = (await pub.readContract({ address: config.tokenAdapter, abi: tokenAdapterAbi, functionName: 'token' })) as Address;
    const [amount, symbol, decimals] = await Promise.all([
      pub.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [you] }) as Promise<bigint>,
      pub.readContract({ address: token, abi: erc20Abi, functionName: 'symbol' }).catch(() => TOKEN),
      pub.readContract({ address: token, abi: erc20Abi, functionName: 'decimals' }).catch(() => 18),
    ]);
    return { amount, symbol: String(symbol), decimals: Number(decimals) };
  } catch {
    return null;
  }
}

/// Each converted batch: its Statement, its color, what it converted into, and its Balance (the artwork its pocket got
/// with the BALANCE, which reads the pot until members are paid) when it can be read.
async function conversions(batches: Union[]) {
  if (!batches.length || !config.tokenAdapter) return [];
  const at = config.tokenAdapter;
  return Promise.all(
    batches.map(async (u) => {
      const [c, pocket] = await Promise.all([
        pub.readContract({ address: at, abi: tokenAdapterAbi, functionName: 'conversionOf', args: [u.s.address] }) as Promise<readonly bigint[]>,
        (pub.readContract({ address: at, abi: tokenAdapterAbi, functionName: 'pocketOf', args: [u.s.address] }) as Promise<Address>).catch(() => null),
      ]);
      return { sid: c[0], amount: c[1], lane: laneOf(u.s)!, art: pocket ? await balanceArt(pocket) : null };
    }),
  );
}

/// What converted batches paid you (or owe you, if not paid out yet), and the batches still owing.
async function received(batches: Union[], you: Address) {
  const empty = { amount: 0n, claim: [] as Address[], symbol: TOKEN, decimals: 18 };
  if (!batches.length || !config.tokenAdapter) return empty;
  const at = config.tokenAdapter;
  const rows = await Promise.all(
    batches.map(async (u) => {
      const [[mine, total], c, owed] = await Promise.all([
        pub.readContract({ address: at, abi: tokenAdapterAbi, functionName: 'ratingOf', args: [u.s.address, you] }) as Promise<readonly [bigint, bigint]>,
        pub.readContract({ address: at, abi: tokenAdapterAbi, functionName: 'conversionOf', args: [u.s.address] }) as Promise<readonly bigint[]>,
        pub.readContract({ address: at, abi: tokenAdapterAbi, functionName: 'claimable', args: [u.s.address, you] }) as Promise<bigint>,
      ]);
      const net = c[1] - c[3] - c[4];
      return { u: u.s.address, amount: total > 0n ? (net * mine) / total : 0n, owed };
    }),
  );
  const token = (await pub.readContract({ address: at, abi: tokenAdapterAbi, functionName: 'token' })) as Address;
  const [symbol, decimals] = await Promise.all([
    pub.readContract({ address: token, abi: erc20Abi, functionName: 'symbol' }).catch(() => TOKEN),
    pub.readContract({ address: token, abi: erc20Abi, functionName: 'decimals' }).catch(() => 18),
  ]);
  return { amount: rows.reduce((a, r) => a + r.amount, 0n), claim: rows.filter((r) => r.owed > 0n).map((r) => r.u), symbol: String(symbol), decimals: Number(decimals) };
}

type Call = { address: Address; abi: typeof factoryAbi; functionName: 'create' | 'deposit'; args: readonly unknown[]; ids: bigint[] };

/// The next transaction for `ids`: into `cur` up to its room (one chunk at most), or a new batch of this color.
async function depositCalls(factory: Address, cur: Union | null, ids: bigint[], l: Lane): Promise<Call[]> {
  const room = cur ? 80 - cur.s.count : 0;
  if (cur && room > 0) {
    const take = ids.slice(0, Math.min(room, CHUNK));
    return [{ address: factory, abi: factoryAbi, functionName: 'deposit', args: [cur.s.address, take], ids: take }];
  }
  const read = (functionName: 'protocolFeeBps' | 'creatorFeeBps' | 'ratings' | 'batchCount') => pub.readContract({ address: factory, abi: factoryAbi, functionName });
  const [p, c, t, n] = await Promise.all([read('protocolFeeBps'), read('creatorFeeBps'), read('ratings'), read('batchCount')]);
  const take = ids.slice(0, Math.min(80, CHUNK));
  return [{ address: factory, abi: factoryAbi, functionName: 'create', args: [`${l.name} ${Number(n) + 1}`, filterOf(l), [], 0n, 0, 0, DURATION, take, p, c, t], ids: take }];
}

/// The batch of this color the next chunk goes into: the one the page shows while it's still open with room, else the
/// fullest open one of this color among all of them, read fresh from the chain.
async function openUnion(factory: Address, l: Lane, prefer?: Address): Promise<Union | null> {
  const fits = (u: Union | null) => !!u && laneOf(u.s) === l && u.s.state === 'Open' && u.s.count < 80;
  if (prefer) {
    const u = await getBatch(prefer).catch(() => null);
    if (fits(u)) return u;
  }
  const n = (await pub.readContract({ address: factory, abi: factoryAbi, functionName: 'batchCount' })) as bigint;
  const addrs = n ? ((await pub.readContract({ address: factory, abi: factoryAbi, functionName: 'batches', args: [0n, n] })) as readonly Address[]) : [];
  const us = await Promise.all(addrs.map((a) => getBatch(a)));
  return us.filter(fits).sort((a, b) => b.s.count - a.s.count)[0] ?? null;
}
