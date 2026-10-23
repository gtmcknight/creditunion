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
import { getBatch, myCredits, shareOf, STATES, tokenIndex, type Payout, type Summary } from '../data';
import { CC_ROOM_BPS, ccPicks, checkQuote, listedById, MAX_SWEEP, priceTag, SOURCES, sweepFee, sweepToWallet, type Listed, type Quote } from '../forsale';
import { buyListed, listings, type ForSale } from './statements';
import { priceChart, usdPrice } from './price-chart';
import { editionArt, registerDeposits } from '../ghosts';
import { explainers } from './home';
import { buyCall, inkPalette, launchGate, market as swapMarket, opened, poolPalette, quote as swapQuote, sellCalls, SELL_SLIPPAGE_BPS } from '../swap';
import { balanceArt, balanceHref, balanceSrc, converted, type BalanceArt } from '../tokens';
import { INK } from '../traits';
import { $$, art, errText, esc, ethNum, openModal, same, sheet, toast } from '../ui';
import { loadPalette, mountWall } from '../wall';

const CHUNK = 40; // Credits per create/deposit transaction
const MAX_BUY = 40; // listings per buy (the Worker's quote limit)
const SHOWN = 400; // the cheapest per point an ETH amount picks from, per color
const DURATION = 90n * 86400n; // the longest a batch may stay open (BatchFactory.MAX_DURATION)
/// When $BALANCE starts converting: Jack's launch, 10:20 AM Eastern on October 20 (his auction starts then).
const OPENS_AT = Date.parse('2026-10-20T14:20:00Z');
/// When it trades, until his contract names the opening block: the end of his auction, a day after it starts.
const TRADES_PLANNED = OPENS_AT + 86_400_000;
/// When it trades, as last worked out from the opening block (12 s a block): kept ten minutes, so every line on the
/// page says the same minute while blocks tick by.
let tradesEst: { block: bigint; at: number; made: number } | null = null;
const tradesFrom = (opensAt: bigint, block: bigint) => {
  if (!tradesEst || tradesEst.block !== opensAt || Date.now() - tradesEst.made > 600_000) tradesEst = { block: opensAt, at: Date.now() + Number(opensAt - block) * 12_000, made: Date.now() };
  return tradesEst.at;
};
const TOKEN = '$BALANCE';
/// ?soon on a local copy: see the before-launch notice even where the stand-in token already trades.
const previewSoon = /^(localhost|127\.0\.0\.1)$/.test(location.hostname) && new URLSearchParams(location.search).has('soon');
/// ?joined on a local copy: see the batch box as it reads right after you join, without a transaction.
const previewJoined = /^(localhost|127\.0\.0\.1)$/.test(location.hostname) && new URLSearchParams(location.search).has('joined'); // always: a fork's stand-in token shows the real name
/// A Statement redeems at once but takes two transactions, so it has to get more than this many times what Uniswap gets.
const BATCH_EDGE = 1.01;
/// A batch pays out only when it fills, a few minutes when it's the better deal (that's when it fills fast), and a
/// launch-day price moves in that time, so it has to get 3% more.
const WAIT_EDGE = 1.03;
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

/// A token batch, with its payout once it converted when the token index was read (else that's read from the chain).
type Union = Awaited<ReturnType<typeof getBatch>> & { payout?: Payout };
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
/// What the box does: Buy with ETH, Sell on Uniswap, Convert your own Credits in a batch, Redeem a Statement, buy art
/// (Credits or a Statement) with ETH or BALANCE, say the way between two that take more than one step, or Withdraw
/// yours from a batch. Kept while you move around the page.
type View = 'buy' | 'sell' | 'credits' | 'out' | 'redeem' | 'art' | 'via' | 'sellc';
let view: View = 'buy' as View;
/// The four things the box goes between: Jack's three, and ETH, which pays for them or comes out of them.
type Asset = 'credit' | 'statement' | 'balance' | 'eth';
const ASSETS: Asset[] = ['credit', 'statement', 'balance', 'eth'];
/// The box's two sides: what you give and what you get. The view follows from them.
let from: Asset = 'eth';
let to: Asset = 'balance';
/// A Statement redeemed on its way to Credits or ETH: what the BALANCE goes into next.
let then: Asset | null = null;
const viewFor = (a: Asset, b: Asset): View =>
  a === 'eth' && b === 'balance' ? 'buy'
  : a === 'balance' && b === 'eth' ? 'sell'
  : a === 'credit' && b === 'balance' ? 'credits'
  : a === 'statement' && b === 'balance' ? 'redeem'
  : (a === 'eth' || a === 'balance') && (b === 'credit' || b === 'statement') ? 'art'
  : a === 'credit' && b === 'eth' && config.ccCore ? 'sellc'
  : 'via';
const setPair = (a: Asset, b: Asset) => {
  from = a;
  to = b;
  view = viewFor(a, b);
};
/// The sides a view stands for, when something other than the pair picks it (a link, the first visit).
const PAIR_OF: Partial<Record<View, [Asset, Asset]>> = { buy: ['eth', 'balance'], sell: ['balance', 'eth'], credits: ['credit', 'balance'], redeem: ['statement', 'balance'] };
/// The batch whose Withdraw opened that view: only its Credits are offered, still after a partial withdraw.
let outFrom: Address | null = null;
/// What's typed: ETH to buy with, or the token to sell.
let typed = '';
/// Your Credits picked when the page last redrew itself (something moved on chain): picked again if still yours.
let keptPicks: string[] = [];
/// The batch you just bought or converted into (its address, or '' for one your deposit opened) and when: the batch
/// box says you're in, or that you filled it, until you do something else.
let joined: { batch: string; lane: string; at: number; shown?: boolean } | null = null;
/// The first draw of a visit: holders open on Convert with all theirs picked, everyone else on Buy at 0.1 ETH.
let landed = false;
/// Buy on Uniswap even when a batch gets more: you'd rather have it now.
let instant = false;
/// The way to buy someone tapped (null: the best).
let chosen: Route | null = null;
/// The colors of BALANCE with no history yet: an even mix.
const EVEN: Palette = [0.25, 0.25, 0.25, 0.25];
/// Jack's inks with black as the text color: a number drawn on the page's panel rather than on his white paper.
const ON_PANEL = [INK[0], INK[1], INK[2], 'currentColor'] as const;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
/// The wallet and how many converted batches still owed it at the last draw: a draw that finds none owed says it's paid.
let owedLast: { who: string; n: number } | null = null;

/// The homepage says what this is before the box: what you can do here, in plain words.
const HOME_HEAD = `<section class="hero home-hero" id="home-hero"><div id="wall"></div><div class="hero-text"><h1><span>Swap Credits, Statements</span> <span>and ${TOKEN}.</span></h1></div></section><p class="create-lede home-lede">An independent market for Jack Butcher’s art. Swap any one for another, or pool Credits into a Statement.</p>`;
/// Draws `put` into the page and keeps the homepage's wall of Credits as it was (it's alive: redrawing it would start it
/// over), mounting it the first time.
function keepHero(app: HTMLElement, put: () => void) {
  const hero = app.querySelector('#home-hero');
  put();
  const slot = app.querySelector('#home-hero');
  if (hero && slot) slot.replaceWith(hero);
  else if (slot) void mountWall(slot.querySelector<HTMLElement>('#wall')!);
}
/// Which page the box is on: the homepage opens on ETH to Credits (the marketplace, what most people come for),
/// /balance on ETH to BALANCE. Coming from the other one starts the box over on its own pair.
let pageAt: 'home' | 'balance' | '' = '';
export async function tokensPage(app: HTMLElement, rerun: () => void, where: 'home' | 'balance' = 'balance') {
  if (!config.tokenFactory) {
    app.innerHTML = `<section class="prose"><h1>${TOKEN}</h1><p class="muted">Coming soon.</p></section>`;
    return;
  }
  const factory = config.tokenFactory;
  const thisRun = ++pageRun;
  if (pageAt !== where) {
    pageAt = where;
    setPair('eth', where === 'home' ? 'credit' : 'balance');
    typed = '';
    landed = false;
    then = null;
  }
  const atHome = where === 'home';
  const q = new URLSearchParams(location.search), asked = q.get('color');
  // A link to a pair (?from=balance&to=credit) opens the box on it.
  const af = q.get('from') as Asset | null, at = q.get('to') as Asset | null;
  const ownPair = (a: Asset, b: Asset) => where === 'home' || b === 'balance' || (a === 'balance' && b === 'eth');
  if (af && at && af !== at && ASSETS.includes(af) && ASSETS.includes(at) && ownPair(af, at) && !landed) {
    setPair(af, at);
    landed = true;
    if (af === 'eth' && at !== 'statement') typed ||= '0.1';
  }
  if (asked && LANES.some((l) => l.key === asked)) laneKey = asked as Lane['key'];
  // The market starts now, beside the chain reads, so prices are in when the card draws: for Mixed, the Worker's cut of
  // the book (the cheapest per point, all a buy here reaches), else, or if that can't be read, the whole book.
  type Book = { at?: number; items?: [string, string, string][] };
  const readBook = (path: string) => fetch(path).then((r) => (r.ok ? (r.json() as Promise<Book>) : null)).catch(() => null);
  const bookP = config.tokenSweeper ? (laneKey === 'any' ? readBook('/market-top.json').then((b) => (b?.items?.length ? b : readBook('/market.json'))) : readBook('/market.json')) : null;
  if (previewJoined && !joined) joined = { batch: '', lane: laneKey, at: Date.now() };
  // The page’s frame at once (its title, where the launch line goes and the card), filled in as the chain is read.
  keepHero(app, () => (app.innerHTML = `<section class="tokens">
      ${atHome ? HOME_HEAD : `<header class="create-head"><h1>Get ${TOKEN}${Date.now() < TRADES_PLANNED ? ' before it trades' : ''}</h1></header>`}
      <p class="tk-when">&nbsp;</p>
      <div class="tk-layout"><section class="tk-card tk-wait" aria-busy="true"></section></div>
    </section>`));
  const account = session.account;
  // What doesn't wait on the batches starts now, beside them, so the page waits on the slowest read and not on the
  // sum of them: your Credits and ETH, the BALANCE pool, and the launch's state.
  const ownedP = account ? (myCredits(account) as Promise<readonly bigint[]>) : Promise.resolve([] as readonly bigint[]);
  const approvedP = account ? (pub.readContract({ address: config.credits, abi: creditsAbi, functionName: 'isApprovedForAll', args: [account, factory] }) as Promise<boolean>) : Promise.resolve(false);
  const heldP = account ? heldBy(account) : Promise.resolve(null);
  const ethP = account ? pub.getBalance({ address: account }).catch(() => null) : Promise.resolve(null);
  const marketP = swapMarket().catch(() => null);
  type Trade = [Awaited<ReturnType<typeof opened>> | null, bigint, Awaited<ReturnType<typeof poolPalette>>, Awaited<ReturnType<typeof inkPalette>> | null];
  const tradeP: Promise<Trade> = marketP.then((m): Promise<Trade> | Trade =>
    m
      ? Promise.all([
          opened(m).catch(() => null),
          account ? (pub.readContract({ address: m.token, abi: erc20Abi, functionName: 'balanceOf', args: [account] }) as Promise<bigint>).catch(() => 0n) : Promise.resolve(0n),
          poolPalette(m),
          account ? inkPalette(m, account) : Promise.resolve(null),
        ])
      : [null, 0n, null, null],
  );
  const gateP = marketP
    .then(async (m) => {
      const token = m?.token ?? (config.tokenAdapter ? ((await pub.readContract({ address: config.tokenAdapter, abi: tokenAdapterAbi, functionName: 'token' })) as Address) : null);
      return token ? launchGate(token) : null;
    })
    .catch(() => null);
  // Every batch with its payout: the Worker's token index (one read for everyone), else the chain, batch by batch.
  const indexP = tokenIndex();
  const allP: Promise<Union[]> = indexP.then(
    (ix) => ix ?? (pub.readContract({ address: factory, abi: factoryAbi, functionName: 'batches', args: [0n, 10_000n] }) as Promise<readonly Address[]>).then((addrs) => Promise.all(addrs.map((a) => getBatch(a)))),
  );
  for (const p of [ownedP, approvedP, tradeP, allP]) p.catch(() => {}); // awaited below; this only keeps an early failure quiet until then
  const [n, assembler, feeNow, scores, inks, sweepBps, proposed, proposedFrom] = await Promise.all([
    indexP.then((ix) => (ix ? BigInt(ix.length) : (pub.readContract({ address: factory, abi: factoryAbi, functionName: 'batchCount' }) as Promise<bigint>))),
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
  const all = (await allP).filter((u) => laneOf(u.s)); // newest first (BatchFactory.batches)
  const done = (u: Union) => converted(u.s.statement);
  const waiting = all.filter((u) => !done(u) && (u.s.state === 'Open' || u.s.state === 'Full' || u.s.state === 'Expired'));
  const mineIn = (u: Union) => (account ? u.ids.filter((_, i) => u.depositors[i].toLowerCase() === account.toLowerCase()) : []);
  // Yours not converted yet, and which can still come back (not in a batch's burn hour).
  const pending = waiting.flatMap((u) => mineIn(u).map((id) => ({ id, u })));
  const leavable = pending.filter(({ u }) => u.s.phase !== 'Burnable');
  const [owned, approved, got, made, held, ethHeld] = await Promise.all([
    ownedP,
    approvedP,
    account ? received(all.filter(done), account) : Promise.resolve({ amount: 0n, claim: [] as Address[], symbol: TOKEN, decimals: 18 }),
    conversions(all.filter(done)),
    heldP,
    ethP,
  ]);
  // BALANCE's pool: the token, whether it can move yet, how much you hold, the colors the pool sells and yours.
  const m = await marketP;
  const [trade, tokenHeld, poolPal, myPal] = await tradeP;
  // The launch as it stands: whether BALANCE takes Statements yet (conversions and redeems revert until it does) and
  // the block its transfers open at (payouts and claims wait for it).
  const gate = await gateP;
  /// A converted batch's tile: its Balance (the pot until payout) once read, its Statement until then.
  function madeTile(c: (typeof made)[number]) {
    const n = Number(formatUnits(c.amount, got.decimals)).toLocaleString('en-US', { maximumFractionDigits: 0 });
    // Paid out: its Balance shows the pot (empty now) and its Statement reads WITHDRAWN, so the batch is its 80 Credits.
    if (isOpen) return `<a class="made" href="/statement/${c.sid}" title="${Number(formatUnits(c.net, got.decimals)).toLocaleString('en-US', { maximumFractionDigits: 0 })} ${TOKEN} to ${c.members.length} members"><div class="made-art">${sheet(c.ids, { size: 'sm', painted: true })}</div><span class="small"><span class="sw-ink">${swatch(c.lane)}</span><span class="num">${Number(formatUnits(c.net, got.decimals)).toLocaleString('en-US', { maximumFractionDigits: 0 })}</span></span><span class="small muted">${c.members.length === 1 ? '1 member' : `${c.members.length} members`}</span></a>`;
    return c.art
      ? `<a class="made" href="${balanceHref(c.art)}"><img src="${balanceSrc(c.art)}" alt="Balance #${c.art.id}" decoding="async"><span class="small"><span class="sw-ink">${swatch(c.lane)}</span>Balance #${c.art.id}</span></a>`
      : `<a class="made" href="/statement/${c.sid}"><img src="/statement/${c.sid}.svg" alt="Statement #${c.sid}" loading="lazy" decoding="async"><span class="small"><span class="sw-ink">${swatch(c.lane)}</span>#${c.sid}<span class="muted num"> · ${n}</span></span></a>`;
  }
  const paying = !!gate && (gate.opensAt === null || gate.block >= gate.opensAt);
  /// Until they're paid out: how many members the converted batches hold BALANCE for, and how much, as one line.
  const madeLine = () => {
    const who = new Set(made.flatMap((c) => c.members.map((a) => a.toLowerCase()))).size;
    const total = made.reduce((n, c) => n + (c.net > 0n ? c.net : 0n), 0n);
    const tot = Number(formatUnits(total, got.decimals)).toLocaleString('en-US', { maximumFractionDigits: 0 });
    if (!who || !total) return '';
    return isOpen
      ? `<p class="tk-made-line"><span class="num">${who.toLocaleString('en-US')}</span> members have converted <span class="num">${(made.length * 80).toLocaleString('en-US')}</span> Credits into <span class="num">${tot}</span> ${TOKEN}.</p>`
      : `<p class="tk-made-line"><span class="num">${who.toLocaleString('en-US')}</span> members have <span class="num">${tot}</span> ${TOKEN} reserved for ${whenShort(tradesAt)}.</p>`;
  };
  /// When trading opens: the opening block's time once the token names it (12 s a block), until then the planned time.
  const tradesAt = gate?.opensAt != null ? tradesFrom(gate.opensAt, gate.block) : (tradesEst?.at ?? TRADES_PLANNED);
  const isOpen = !!trade?.open || paying;
  /// Batches convert (the adapter live, BALANCE taking Statements) but BALANCE doesn't move yet.
  const converting = live && !!gate?.takes && !isOpen;
  const when = (t: number) => new Date(t).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
  /// The same moment for a short row: "Wed 10:39 AM", held together (no-break spaces) so a wrap never splits it.
  const whenShort = (t: number) => new Date(t).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' }).replace(/^(\w+)\s/, '$1\u00a0').replace(/\s([AP]M)$/, '\u202f$1');
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
  // Paid out since the last draw (the keeper pays at the opening): say so, once.
  if (account && owedLast?.who === account.toLowerCase() && owedLast.n > 0 && !got.claim.length && got.amount > 0n) toast(`Paid. Your ${amount(got.amount)} ${TOKEN} is in your wallet.`, 'ok', 10_000);
  owedLast = account ? { who: account.toLowerCase(), n: got.claim.length } : null;
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
  /// What's typed once a transaction is done (nothing, unless it leads on to the next step).
  let carry = '';
  /// While a transaction is in flight nothing on the page can change what it's doing: batches, picks, amounts.
  const lock = (on: boolean) => {
    busy = on;
    app.querySelector('.tk-form')?.classList.toggle('busy', on);
    for (const el of $$<HTMLButtonElement | HTMLInputElement>('.tokens button, .tokens input', app)) if (on) el.disabled = true;
  };
  /// The button in flight: it asks you to confirm in your wallet, and once you have (note), says what's happening.
  let flying: { btn: HTMLElement; working: string } | null = null;
  const run = async (btn: HTMLElement | null, working: string, fn: () => Promise<unknown>, ok: string) => {
    lock(true);
    if (btn) {
      btn.setAttribute('disabled', '');
      btn.dataset.label = btn.textContent ?? '';
      btn.textContent = 'Confirm in your wallet…';
      flying = { btn, working };
    }
    try {
      await fn();
      flying = null;
      if (ok) toast(ok, 'ok');
      typed = carry;
      carry = '';
      rerun();
    } catch (e) {
      // Back to how it was: redrawn, so every control is live again.
      flying = null;
      busy = false;
      toast(errText(e), 'err', 8000);
      draw();
    }
  };
  const note = () => {
    if (flying?.btn.isConnected) flying.btn.textContent = flying.working;
    toast('Submitted. Waiting for confirmation…', 'info');
  };
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
    // BALANCE moves only once it trades: until then a side that sells it says the way.
    if ((view === 'sell' || (view === 'art' && from === 'balance')) && !trade?.open) return 'via';
    const v = view === 'out' && !outHere().length ? 'buy' : view;
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
  /// Whether the amount typed is BALANCE (a sale, or art bought with it) rather than ETH.
  const paysToken = () => viewNow() === 'sell' || (viewNow() === 'art' && from === 'balance');
  const amountIn = (): bigint => {
    try {
      return paysToken() ? parseUnits(typed.trim() || '0', m!.decimals) : parseEther(typed.trim() || '0');
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
  /// Whether the fee line is open (tapped): what our fees come to, instead of just that they're in.
  let feeFlipped = false;
  /// Under You'll get through a batch: the price is all in (the ETH on the button already has the buy's fee, the amount
  /// is already after the conversion's), so the line only says so. Tapped, it says what Credit Union keeps.
  const feeLine = (tenthsIn: number) =>
    `<button type="button" class="link" id="fee-rate">${feeFlipped ? `${whole(feeOn(tenthsIn))} ${TOKEN} to Credit Union` : 'Fee included'}</button>`;
  const buyFeeLine = (tenthsIn: number, spent: bigint) =>
    `<button type="button" class="link" id="fee-rate">${feeFlipped ? `${ethNum((spent * BigInt(feeBps)) / (10_000n + BigInt(feeBps)), 4, true)} ETH + ${whole(feeOn(tenthsIn))} ${TOKEN} to Credit Union` : 'Fees included'}</button>`;
  /// The Sweeper's fee on Credits bought to the wallet (art bought here), read once.
  let artFee = 200n;
  void sweepFee().then((v) => (artFee = v));
  /// Statements listed on OpenSea, read once: a whole Statement is a way in when the amount covers one.
  let stmts: ForSale[] = [];
  let stmtsRead = false;
  listings()
    .then((x) => {
      stmts = x.filter((y) => y.rating);
      stmtsRead = true;
      fillCheap();
      if (app.querySelector('.tk-form')) paint();
    })
    .catch(() => {});
  /// The best Statement the amount buys: the most rating per ETH among those it covers.
  const stmtFor = (wei: bigint) =>
    stmts.filter((y) => BigInt(y.price) <= wei).reduce<ForSale | null>((a, y) => (!a || y.rating! / Number(BigInt(y.price)) > a.rating! / Number(BigInt(a.price)) ? y : a), null);
  let st: ForSale | null = null;
  /// The Statements this wallet holds, each with its rating: the Convert tab offers to redeem them.
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
    return (v === 'credits' || v === 'out' || v === 'buy') && !(v === 'buy' && (wayNow() === 'pool' || wayNow() === 'statement'));
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
  /// Where the Credits that came in since this batch was last drawn here start: they drop into its sheet.
  let sheetFresh: number | undefined;
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
        c.className = 'cell mine adding';
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
    // Yours (in already, or about to be) are outlined on the sheet; the line under the count says how many.
    const legend = document.getElementById('tk-legend');
    const inAlready = cur ? mineIn(cur).length : 0;
    const buying = viewNow() === 'buy' ? add.length : 0, addingN = viewNow() === 'buy' ? 0 : add.length;
    // The count is what's left after yours: it comes down as you type or pick, and says so when yours fills it.
    const left = 80 - count - add.length, fills = add.length > 0 && left <= 0;
    const togo = fills ? 'You fill it' : `<span class="num">${left}</span> to go`;
    const togoEl = document.getElementById('tk-togo');
    if (togoEl && togoEl.innerHTML !== togo) {
      togoEl.innerHTML = togo;
      togoEl.classList.remove('tick');
      void togoEl.offsetWidth; // restart the roll
      togoEl.classList.add('tick');
    }
    if (legend) legend.textContent = [`${count} of 80`, inAlready ? `${inAlready} yours` : '', buying ? `${buying} buying` : '', addingN ? `${addingN} adding` : ''].filter(Boolean).join(' · ');
    // What you'll be paid when it fills: your Credits' rating in it (in already and about to be), after the fee.
    const bget = document.getElementById('tk-bget');
    const yoursTenths = (cur ? mineIn(cur) : []).reduce((n, id) => n + t(id), 0) + add.reduce((n, id) => n + t(id), 0);
    if (bget)
      bget.innerHTML =
        joinedLine(cur) ||
        (fills
          ? `It converts right away${isOpen ? ' and pays out' : `. Yours lands ${whenShort(tradesAt)}`}.`
          : addingN
              ? `Your ${plural(addingN)} join this batch. At 80 it converts to ${TOKEN}.`
              : yoursTenths
                ? `Converts to ${TOKEN} at 80.`
                : `Converts to ${TOKEN} at 80, split by the rating each member put in.`);
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
    // Beside a trade on Uniswap (a Buy that goes there, or a Sell), the price; beside one into a batch, its sheet.
    const c = document.getElementById('tk-chart');
    if (c) c.hidden = s;
  };
  /// You get, in the colors it comes in, on the panel itself: its black is the text color, so it reads in either theme.
  const setGet = (n: number, pal: Palette) => {
    const get = document.getElementById('get');
    const text = whole(n);
    const sig = `${text}|${pal.join(',')}`;
    if (get && get.dataset.sig !== sig) {
      get.dataset.sig = sig;
      get.dataset.n = text;
      get.innerHTML = balanceSvg(text, pal, 4, text, ON_PANEL);
    }
  };
  const setText = (id: string, html: string) => {
    const el = document.getElementById(id);
    if (el && el.innerHTML !== html.replace(/\u00a0/g, '&nbsp;')) el.innerHTML = html; // innerHTML reads a no-break space back as &nbsp;
  };
  /// The button says what it does. Without a wallet it still does: pressing it connects one (main.ts's data-connect).
  const setGo = (text: string, on: boolean) => {
    const go = document.getElementById('go') as HTMLButtonElement | null;
    if (go && !busy) {
      go.textContent = text;
      go.disabled = !on;
    }
  };

  /// /balance keeps its modes as one big control over the panels: Buy · Sell · Convert, and Redeem for a wallet with
  /// Statements. (The homepage's box goes any way between the four instead: pickChip, flipHtml.) Sell shows once the
  /// token trades; Buy only when there's a way to buy (a Sweeper or the pool).
  function tabsHtml() {
    const v = viewNow();
    if (atHome || v === 'out') return '';
    const tab = (k: 'buy' | 'sell' | 'credits' | 'redeem', label: string) => `<button type="button" role="tab" data-view="${k}" aria-selected="${v === k}">${label}</button>`;
    const n = account ? owned.length : 0;
    // Yours to convert, on its tab: your best three Credits fanned as their art, and how many.
    const fanned = [...owned].sort((x, y) => t(y) - t(x)).slice(0, 3).map((id) => `<img src="${art(id)}" alt="" loading="lazy">`).join('');
    return `<div class="subtabs tk-modes" role="tablist" aria-label="Buy, sell or convert">${sweeps || poolOk() ? tab('buy', 'Buy') : ''}${m && trade?.open ? tab('sell', 'Sell') : ''}${tab('credits', n ? `<span class="tk-tabfan" aria-hidden="true">${fanned}</span>Convert <span class="num">${n}</span>` : 'Convert')}${account && myStmts.length ? tab('redeem', `Redeem <span class="num">${myStmts.length}</span>`) : ''}</div>`;
  }
  /// A side's picker, where its panel names its unit: its mark and name, and a menu of the others. From's menu says what
  /// you hold of each; To's how it gets there, and once it's open, what the amount typed comes to.
  const pickChip = (k: 'from' | 'to') => {
    const a = k === 'from' ? from : to;
    // On /balance the unit is just named: ETH's diamond, BALANCE a tap on its name for what it is.
    if (!atHome)
      return a === 'balance'
        ? `<button type="button" class="tk-unit" data-how title="What is ${TOKEN}?"><span class="sw-ink tk-coin">${swatch(lane())}</span>${esc(sym())}</button>`
        : `<span class="tk-unit">${a === 'eth' ? ETH_ICON : assetIcon(a)}${assetName(a)}</span>`;
    // All four on both sides: the other side's swaps the two (choose), so any start is a tap away.
    const opts = ASSETS.map((x) => `<li role="option" tabindex="-1" data-asset="${x}" aria-selected="${x === a}"><span class="tk-opt">${assetIcon(x)}<span class="tk-aname"><b>${assetName(x)}</b><span class="muted small" data-hint>${x === (k === 'from' ? to : from) ? 'Swaps the two sides' : k === 'from' ? have(x) : how(from, x)}</span></span></span></li>`)
      .join('');
    return `<div class="tk-side" data-side="${k}"><button type="button" class="tk-chip" aria-haspopup="listbox" aria-expanded="false" aria-label="${k === 'from' ? 'Pay with' : 'Get'} ${assetName(a)}">${assetIcon(a)}<span>${assetName(a)}</span></button><div class="sort-menu tk-amenu" hidden><ul role="listbox" aria-label="${k === 'from' ? 'Pay with' : 'Get'}">${opts}</ul><button type="button" class="link small" data-how>What is ${TOKEN}?</button></div></div>`;
  };
  /// Between the two panels: the flip.
  const flipHtml = () =>
    !atHome ? '' : `<div class="tk-flipwrap"><button type="button" class="tk-flip" id="tk-flip" aria-label="Flip: ${assetName(to)} to ${assetName(from)}" title="Flip (F)"><svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M5.5 2.5v10m0 0-3-3m3 3 3-3M10.5 13.5v-10m0 0-3 3m3-3 3 3" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg></button></div>`;
  const assetName = (a: Asset) => (a === 'credit' ? 'Credits' : a === 'statement' ? 'Statement' : a === 'balance' ? TOKEN : 'ETH');
  /// Each one as itself: your best Credit (else a cyan one), Statement #1 (Union Jack, the first one made here),
  /// BALANCE's four inks, ETH's diamond.
  const creditIcon = [...owned].sort((x, y) => t(y) - t(x))[0] ?? BigInt(inks.findIndex((x) => x === 1) + 1);
  const assetIcon = (a: Asset) =>
    a === 'credit'
      ? `<span class="tk-aicon"><img src="${art(creditIcon)}" alt=""></span>`
      : a === 'statement'
        ? `<span class="tk-aicon"><img class="st" src="/statement/${myStmts[0]?.id ?? 1}.svg" alt=""></span>`
        : a === 'balance'
          ? `<span class="tk-aicon tk-inks">${INK.map((c) => `<i style="background:${c}"></i>`).join('')}</span>`
          : `<span class="tk-aicon tk-ethi">${ETH_ICON}</span>`;
  /// How `a` becomes `b`, in a few words: the To menu says it beside each.
  const how = (a: Asset, b: Asset) => {
    const v = viewFor(a, b);
    if (!trade?.open && a === 'balance') return 'Once it trades';
    if (v === 'buy') return 'Uniswap or a batch';
    if (v === 'sell') return 'Uniswap';
    if (v === 'credits') return 'Convert in a batch';
    if (v === 'redeem') return 'Redeem at once';
    if (v === 'art') return a === 'eth' ? 'OpenSea' : 'Uniswap, then OpenSea';
    if (v === 'sellc') return cc.live ? 'Instant, at $CC’s bid' : 'List on OpenSea';
    if (a === 'credit') return b === 'statement' ? '80 in a Credit Union' : 'Convert, then sell';
    return 'Redeem, then swap';
  };
  /// What you hold of it, once a wallet is connected.
  const have = (a: Asset) => {
    if (!account) return '';
    const n = a === 'credit' ? owned.length : a === 'statement' ? myStmts.length : -1;
    if (n >= 0) return n ? `You have ${n.toLocaleString('en-US')}` : 'None yet';
    if (a === 'balance') return tokenHeld ? `You have ${tokAmt(tokenHeld)}` : 'None yet';
    return ethHeld !== null ? `You have ${ethNum(ethHeld, 3)}` : '';
  };
  /// A token's mark and name, as a chip on the right of a panel: ETH's diamond; $BALANCE as its ink, the batch's colours.
  const ETH_ICON = '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M8 1 3.5 8.2 8 10.8l4.5-2.6z" fill="currentColor" opacity=".9"/><path d="M8 11.7 3.5 9.1 8 15l4.5-5.9z" fill="currentColor" opacity=".6"/></svg>';
  const payHtml = (selling: boolean, title = selling ? 'Sell' : 'Pay') => {
    const max = selling
      ? account ? `<span class="tk-bal">You hold <span class="num">${tokAmt(tokenHeld)}</span> <button type="button" class="link small" id="amt-max">Max</button></span>` : ''
      : ethHeld !== null ? `<span class="tk-bal">Wallet <span class="num">${ethNum(ethHeld, 4)}</span> ETH <button type="button" class="link small" id="amt-max">Max</button></span>` : '';
    // Paying ETH: a few amounts a tap away (about 2 and 4 Credits' worth at today's prices), and the amount that fills
    // the batch once the market's read (0.5 until then, or when one buy can't fill it).
    const quick = selling ? '' : `<span class="tk-quick">${['0.05', '0.1', '0.5'].map((v, i) => `<button type="button" class="tk-q num" data-amt="${v}"${i === 2 ? ' id="tk-fill"' : ''} aria-pressed="${typed === v}">${v}</button>`).join('')}</span>`;
    // Pay mirrors You get: the title with its quick amounts on one line, then the panel with the amount, its unit,
    // what it's worth and, at the bottom right, your balance with Max (as Uniswap does).
    return `
          <div class="tk-gethead"><h2 class="form-title">${title}</h2>${quick}</div>
          <section class="rule">
            <div class="tk-eth"><input id="amt" class="num" inputmode="decimal" autocomplete="off" placeholder="0" aria-label="${selling ? `${esc(sym())} to sell` : 'ETH to spend'}" value="${esc(typed)}">${pickChip('from')}<span class="tk-usd num" id="amt-usd"></span>${max}</div>
          </section>`;
  };
  /// You get, then the way it goes, the other way when it's a real choice, and our fees on this way.
  const getHtml = (selling: boolean, extra = '') => `${flipHtml()}
          <div class="tk-gethead"><h2 class="form-title" id="tk-gettitle">You get</h2>${selling || laneKey === 'any' ? '' : colorChip()}</div>
          <section class="rule">
            ${selling ? `<div class="tk-get tk-panel"><span class="num tk-out" id="get-eth">0</span>${pickChip('to')}<span class="tk-usd" id="route"></span></div>` : `<div class="tk-get tk-panel"><span class="tk-getrow"><span id="get">${balanceSvg('0', EVEN, 4, '0', ON_PANEL)}</span></span>${pickChip('to')}<span class="tk-usd" id="route"></span></div>`}
            <div class="tk-lines term-desc"><p id="amt-line"></p><p id="route2"></p><p id="alt"></p><p id="fees"></p>${extra}</div>
          </section>`;
  const goHtml = (label: string) => `<button type="button" class="btn primary block" id="go"${account ? '' : ' data-connect'} disabled>${label}</button>`;
  const linkHtml = (to: typeof view, text: string) => (text ? `<p class="hint center"><button type="button" class="link small" data-view="${to}">${text}</button></p>` : '');
  /// Under the button, what takes the worry out of pressing it (filled in as it changes; nothing when there's nothing).
  const sureHtml = () => '<p class="hint center tk-sure" id="tk-sure"></p>';
  function buyHtml() {
    return `${payHtml(false)}${getHtml(false)}
          <div class="submit">${goHtml('Enter an amount')}${sureHtml()}</div>`;
  }
  function creditsHtml() {
    const mineHere = ownedHere();
    const pick = (id: bigint) => {
      const p = lane().ink < 0 ? pure(inkOf(id)) : null; // in Mixed, a single-ink Credit is marked with its ink
      return `<button type="button" class="pick" data-id="${id}" aria-pressed="${picks.has(id.toString())}" aria-label="Credit #${id}" title="Credit #${id} · ${pts(t(id))} rating"><img src="${art(id)}" alt="" loading="lazy">${p ? `<span class="tk-pure" style="${inkVar(p)}" title="${p.name} only"></span>` : ''}<span class="pick-id num">${pts(t(id))}</span></button>`;
    };
    const back = account && lane().ink >= 0 && owned.length > mineHere.length ? `<p class="tk-back"><button type="button" class="link small" id="tk-back">← Back to Mixed</button> for your other ${plural(owned.length - mineHere.length)}</p>` : '';
    return `
          <div class="tk-gethead"><h2 class="form-title">Pay</h2></div>
          <section class="rule">
            <div class="tk-eth tk-picks">${
              !account
                ? '<span class="tk-none muted">Any Credits you own</span>'
                : mineHere.length
                  ? `<div class="tk-strip capt" id="picker">${mineHere.map(pick).join('')}</div>`
                  : `<span class="tk-none muted">${owned.length ? `None printed in ${lane().name.toLowerCase()} only` : 'None in this wallet'}</span>`
            }${pickChip('from')}<span class="tk-usd" id="n-sel"></span>${account && mineHere.length ? '<span class="tk-bal"><button type="button" class="link small" id="pick-all">Select all</button></span>' : ''}</div>
          </section>
          ${getHtml(false, back)}
          <div class="submit">${goHtml('Pick Credits')}${sureHtml()}</div>`;
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
    const l = lane(), cur = curOf(l);
    const count = cur?.s.count ?? 0;
    return `<div class="tk-batch" id="tk-batch"${viaSheet() ? '' : ' hidden'}>
            <div class="tk-mini" id="tk-sheet">${sheet(cur ? cur.ids : [], { mine: new Set(cur ? mineIn(cur).map(String) : []), size: 'sm', fresh: sheetFresh })}</div>
            <div class="tk-batchinfo">
              <p class="tk-togo" id="tk-togo"><span class="num">${80 - count}</span> to go</p>
              <p class="small muted num" id="tk-legend">${count} of 80</p>
              <p class="small muted" id="tk-bget">${joinedLine(cur) || `Converts to ${TOKEN} at 80, split by the rating each member put in. Until then, withdraw anytime.`}</p>
              <p class="small muted" id="tk-bfee"></p>
            </div>
          </div>`;
  }
  /// After you join: that you're in and when it lands, or that you filled it and it's converting.
  function joinedLine(cur: Union | null) {
    if (!joined || joined.lane !== laneKey || Date.now() - joined.at > 30 * 60_000) return '';
    if (cur && (joined.batch === '' || same(joined.batch, cur.s.address)) && mineIn(cur).length) {
      const worth = Math.floor((mineIn(cur).reduce((n, id) => n + t(id), 0) / 10) * (1 - cur.s.protocolFeeBps / 10_000));
      return `<b class="tk-in">You’re in.</b> Your ≈${worth.toLocaleString('en-US')} ${TOKEN} lands when it fills${isOpen ? '' : `, ${whenShort(tradesAt)} at the earliest`}.`;
    }
    const filled = all.find((u) => same(u.s.address, joined!.batch));
    return filled && filled.s.count >= 80 ? `<b class="tk-in">You filled ${esc(filled.s.name || 'it')}.</b> It converts in a moment${isOpen ? ' and pays out' : `; yours lands ${whenShort(tradesAt)}`}.` : '';
  }
  const sellHtml = () => `${payHtml(true)}${getHtml(true)}
          <div class="submit">${goHtml('Enter an amount')}${sureHtml()}</div>`;
  /// ETH or BALANCE into art: Pay, then You get as the art itself (the Credits fanned, or the Statement), the way it
  /// goes as a row of marks, and the button.
  const artHtml = () => `${payHtml(from === 'balance', 'Pay')}
          ${flipHtml()}
          <div class="tk-gethead"><h2 class="form-title">You get</h2></div>
          <section class="rule">
            <div class="tk-get tk-panel"><span class="tk-getrow" id="art-get"><span class="num tk-out">0</span></span>${pickChip('to')}<span class="tk-usd" id="route"></span></div>
            <div class="tk-lines term-desc"><p id="amt-line"></p><p id="route2"></p><p id="fees"></p></div>
          </section>
          <div class="submit">${goHtml('Enter an amount')}${sureHtml()}</div>`;
  /// Your Statements as a row to pick from (all that redeem now, picked), what they come to, and one button that
  /// redeems them through Jack's contract.
  function redeemHtml() {
    const next = then ? ` Then swap the ${TOKEN} into ${assetName(then)}.` : '';
    const pick = (x: (typeof myStmts)[number]) =>
      `<button type="button" class="pick st${x.ready ? '' : ' off'}" data-sid="${x.id}" aria-pressed="${sPicks.has(String(x.id))}" aria-label="Statement #${x.id}" title="Statement #${x.id} · rated ${x.rating.toLocaleString('en-US')}${x.ready ? '' : ' · not yet'}"${x.ready ? '' : ' disabled'}><img src="/statement/${x.id}.svg" alt="" loading="lazy"></button>`;
    return `
          <div class="tk-gethead"><h2 class="form-title">Pay</h2></div>
          <section class="rule">
            <div class="tk-eth tk-picks">${
              !account
                ? '<span class="tk-none muted">Any Statements you own</span>'
                : myStmts.length
                  ? `<div class="tk-strip" id="s-picker">${myStmts.map(pick).join('')}</div>`
                  : '<span class="tk-none muted">None in this wallet</span>'
            }${pickChip('from')}<span class="tk-usd" id="s-sel"></span></div>
          </section>
          ${flipHtml()}
          <div class="tk-gethead"><h2 class="form-title">You get</h2></div>
          <section class="rule">
            <div class="tk-get tk-panel"><span class="num tk-out" id="s-get">0</span>${pickChip('to')}<span class="tk-usd">One per rating point, at once</span></div>
            <div class="tk-lines term-desc"><p>${account && !myStmts.length ? `<button type="button" class="link" data-pair="eth:statement">Buy one with ETH</button>` : `Through Jack’s contract · No fee.${next}`}</p></div>
          </section>
          <div class="submit">${goHtml('Pick Statements')}${sureHtml()}</div>`;
  }
  /// Credits to ETH: yours as a row to pick from (the best bid first), what they sell for, and the ways to sell: $CC's
  /// engine at its bid (cc.artcoins.art: it pays ETH for any Credit by its score, at once, from its pot), or a listing
  /// on OpenSea at your own price. No fee of ours on either.
  function sellcHtml() {
    const mine = [...owned].sort((x, y) => Number((cc.bids.get(String(y)) ?? 0n) - (cc.bids.get(String(x)) ?? 0n)) || t(y) - t(x));
    const pick = (id: bigint) => {
      const bid = cc.bids.get(String(id));
      return `<button type="button" class="pick" data-id="${id}" aria-pressed="${picks.has(id.toString())}" aria-label="Credit #${id}" title="Credit #${id} · rated ${pts(t(id))}${bid ? ` · $CC pays ${ethNum(bid, 4)} ETH` : ''}"><img src="${art(id)}" alt="" loading="lazy"><span class="pick-id num">${pts(t(id))}</span></button>`;
    };
    const os = account ? `https://opensea.io/${account}` : 'https://opensea.io/collection/credits';
    return `
          <div class="tk-gethead"><h2 class="form-title">Pay</h2></div>
          <section class="rule">
            <div class="tk-eth tk-picks">${
              !account ? '<span class="tk-none muted">Any Credits you own</span>' : mine.length ? `<div class="tk-strip capt" id="picker">${mine.map(pick).join('')}</div>` : '<span class="tk-none muted">None in this wallet</span>'
            }${pickChip('from')}<span class="tk-usd" id="n-sel"></span>${account && mine.length ? '<span class="tk-bal"><button type="button" class="link small" id="pick-all">Select all</button></span>' : ''}</div>
          </section>
          ${flipHtml()}
          <div class="tk-gethead"><h2 class="form-title">You get</h2></div>
          <section class="rule">
            <div class="tk-get tk-panel"><span class="num tk-out" id="sc-get">0</span>${pickChip('to')}<span class="tk-usd" id="sc-sub"></span></div>
            <div class="tk-lines term-desc"><div class="tk-ways" role="radiogroup" aria-label="Way to sell">${config.instantVault ? '<button type="button" class="tk-way" role="radio" aria-checked="false" data-sell="vault"><span><b>Credit Union</b><span class="muted small">Instant · Fees included</span></span><span class="num" id="sc-vault">—</span></button>' : ''}${cc.live ? '<button type="button" class="tk-way" role="radio" aria-checked="false" data-sell="cc"><span><b>$CC bid</b><span class="muted small">Instant · No fee</span></span><span class="num" id="sc-way">—</span></button>' : ''}<a class="tk-way" href="${os}" target="_blank" rel="noopener" id="sc-os"><span><b>List on OpenSea</b><span class="muted small">Your price, when someone buys</span></span><span class="num muted">↗</span></a>${cc.live || config.instantVault ? '' : `<button type="button" class="tk-way" data-pair="credit:balance"><span><b>Convert to ${TOKEN}</b><span class="muted small">Then sell it on Uniswap</span></span><span class="num muted">→</span></button>`}</div><p id="fees"></p></div>
          </section>
          <div class="submit">${goHtml('Pick Credits')}${sureHtml()}</div>`;
  }
  /// $CC's engine as read for this wallet: its bid for each of your Credits, its pot (it can't pay past it) and whether
  /// it may take your Credits yet. Read once a visit, and again after a sale.
  /// `live`: it's bidding at all (a rate and a pot); when it isn't, it isn't shown as a way to sell.
  const cc: { bids: Map<string, bigint>; pot: bigint | null; live: boolean; approved: boolean; read: Promise<void> | null } = { bids: new Map(), pot: null, live: true, approved: false, read: null };
  const CC_ABI = parseAbi(['function bidOf(uint256) view returns (uint256)', 'function ethPot() view returns (uint256)', 'function ethRate() view returns (uint256)', 'function sellForEth(uint256[] ids, uint256 minOut)']);
  const readCC = () =>
    (cc.read ??= (async () => {
      const core = config.ccCore;
      if (!core) return;
      const ids = account ? [...owned] : [];
      const [pot, rate, ok, ...bids] = await Promise.all([
        pub.readContract({ address: core, abi: CC_ABI, functionName: 'ethPot' }) as Promise<bigint>,
        pub.readContract({ address: core, abi: CC_ABI, functionName: 'ethRate' }) as Promise<bigint>,
        account ? (pub.readContract({ address: config.credits, abi: creditsAbi, functionName: 'isApprovedForAll', args: [account, core] }) as Promise<boolean>) : Promise.resolve(false),
        ...ids.map((id) => (pub.readContract({ address: core, abi: CC_ABI, functionName: 'bidOf', args: [id] }) as Promise<bigint>).catch(() => 0n)),
      ]);
      cc.pot = pot;
      cc.live = pot > 0n && rate > 0n;
      cc.approved = ok;
      ids.forEach((id, i) => cc.bids.set(String(id), bids[i]));
    })().catch(() => {}));
  /// Credit Union's InstantVault, read once a visit (again after a sale): the $BALANCE it can pay out now, and whether
  /// it may take this wallet's Credits yet.
  const iv: { stock: bigint | null; approved: boolean; read: Promise<void> | null } = { stock: null, approved: false, read: null };
  const IV_ABI = parseAbi(['function stock() view returns (uint256)', 'function sell(address batch, uint256[] ids, uint256 minOut, address to) returns (uint256)']);
  const readIV = () =>
    (iv.read ??= (async () => {
      const v = config.instantVault;
      if (!v) return;
      const [stock, ok] = await Promise.all([
        pub.readContract({ address: v, abi: IV_ABI, functionName: 'stock' }) as Promise<bigint>,
        account ? (pub.readContract({ address: config.credits, abi: creditsAbi, functionName: 'isApprovedForAll', args: [account, v] }) as Promise<boolean>) : Promise.resolve(false),
      ]);
      iv.stock = stock;
      iv.approved = ok;
    })().catch(() => {}));
  /// What the vault pays now for `ids` going into this color's batch filling now: that batch's own payout (its
  /// fees off, one $BALANCE a point), when there's a vault, a batch with room for all of them, and the $BALANCE to pay.
  const ivFor = (ids: bigint[]) => {
    const v = config.instantVault, b = curOf(lane());
    if (!v || !b || !ids.length || iv.stock === null || 80 - b.s.count < ids.length) return null;
    const tenths = ids.reduce((a, id) => a + t(id), 0);
    const amount = (BigInt(tenths) * 10n ** 17n * BigInt(10_000 - b.s.protocolFeeBps - b.s.creatorFeeBps)) / 10_000n;
    return amount > 0n && amount <= iv.stock ? { vault: v, batch: b.s.address, ids, amount } : null;
  };
  /// A sale to the vault, as calls: its leave to take your Credits (once), then the sale, paid to you.
  const ivCalls = (x: NonNullable<ReturnType<typeof ivFor>>) => [
    ...(iv.approved ? [] : [{ address: config.credits, abi: creditsAbi, functionName: 'setApprovalForAll', args: [x.vault, true] } as const]),
    { address: x.vault, abi: IV_ABI, functionName: 'sell', args: [x.batch, x.ids, x.amount, account!] } as const,
  ];
  /// The way Credits to ETH goes: the vault then Uniswap, or $CC's bid. Picked by what pays more, until tapped.
  let sellWay: 'vault' | 'cc' | null = null;
  let ivEth: { key: string; eth: bigint } | null = null;

  /// The Credits picked that $CC can pay for: the best bids first, while its pot lasts.
  const ccSale = () => {
    const mine = [...owned].filter((id) => picks.has(String(id))).sort((x, y) => Number((cc.bids.get(String(y)) ?? 0n) - (cc.bids.get(String(x)) ?? 0n)));
    const take: bigint[] = [];
    let eth = 0n;
    for (const id of mine) {
      const b = cc.bids.get(String(id)) ?? 0n;
      if (!b || (cc.pot !== null && eth + b > cc.pot)) continue;
      take.push(id);
      eth += b;
    }
    return { mine, take, eth };
  };
  async function sellcSync() {
    const fresh = !cc.read;
    await readCC();
    if (!app.isConnected || viewNow() !== 'sellc') return;
    if (fresh && (account || !cc.live)) return void draw(); // the row now sorts by bid, and $CC shows only if it's bidding
    await readIV();
    if (!app.isConnected || viewNow() !== 'sellc') return;
    const { mine, take, eth: ccEth } = ccSale();
    // The vault's way: what it pays for all of them, sold on Uniswap (a beat after picking stops, priced again per pick).
    const inst = ivFor(mine);
    const key = inst ? `${inst.batch}|${inst.amount}` : '';
    if (inst && m && trade?.open && ivEth?.key !== key) {
      const run = ++quoteRun;
      await wait(250);
      if (run !== quoteRun) return;
      const q = await swapQuote(m, false, inst.amount);
      if (run !== quoteRun || !app.isConnected) return;
      ivEth = { key, eth: q?.net ?? 0n };
    }
    const vEth = inst && ivEth?.key === key ? ivEth.eth : 0n;
    const best: 'vault' | 'cc' | null = vEth || ccEth ? (vEth >= ccEth ? 'vault' : 'cc') : null;
    const way = sellWay && (sellWay === 'vault' ? vEth : ccEth) ? sellWay : best;
    const eth = way === 'vault' ? vEth : way === 'cc' ? ccEth : 0n;
    setText('sc-get', eth ? ethNum(eth, 4) : '0');
    setText('sc-vault', vEth ? `${ethNum(vEth, 4)} ETH` : '—');
    setText('sc-way', ccEth ? `${ethNum(ccEth, 4)} ETH` : '—');
    $$<HTMLElement>('.tk-way[data-sell]', app).forEach((b) => b.setAttribute('aria-checked', String(b.dataset.sell === way && eth > 0n)));
    // What that is per rating point.
    const tenths = (way === 'vault' ? mine : take).reduce((a, id) => a + t(id), 0);
    const per = (wei: bigint, tn: number) => (tn ? ethNum((wei * 10_000n) / BigInt(tn), 4) : '');
    setText('sc-sub', eth ? [dollars(Number(formatEther(eth))), `${per(eth, tenths)} ETH per 1,000 rating`].filter(Boolean).join(' · ') : '');
    const picked = mine.reduce((a, id) => a + t(id), 0);
    setText('n-sel', !account || !owned.length ? '' : mine.length ? `${mine.length} of ${owned.length} · rated ${pts(picked)}` : `Pick from your ${owned.length}`);
    const all = document.getElementById('pick-all');
    if (all) all.textContent = mine.length ? 'Clear' : 'Select all';
    const left = mine.length - take.length;
    const vaultShort = !!config.instantVault && mine.length > 0 && !inst;
    setText('fees', way === 'vault' ? 'Paid in $BALANCE now and sold on Uniswap · Two confirmations the first time' : vaultShort && !ccEth ? 'More than Credit Union can pay for right now. Pick fewer, or list them on OpenSea.' : !cc.live || way !== 'cc' ? '' : left > 0 ? `$CC can take ${plural(take.length)} of these now. List the rest on OpenSea.` : '');
    // With no instant sale at all, the button is the next best thing: listing them on OpenSea.
    if (!cc.live && !config.instantVault) return setGo(account ? 'List on OpenSea' : 'Sell my Credits', true);
    const n = way === 'vault' ? mine.length : take.length;
    setGo(!account ? 'Sell my Credits' : n && eth ? `Sell ${plural(n)} · ${ethNum(eth, 4)} ETH` : mine.length ? 'No price right now' : 'Pick Credits', !account || (n > 0 && eth > 0n));
  }
  /// Your Statements picked to redeem (all that redeem now, until you pick).
  const sPicks = new Set<string>();
  let sPicked = false;
  function redeemSync() {
    if (!sPicked) for (const x of myStmts) if (x.ready) sPicks.add(String(x.id));
    const mine = myStmts.filter((x) => x.ready && sPicks.has(String(x.id)));
    const total = mine.reduce((a, x) => a + x.rating, 0);
    setText('s-get', whole(total));
    setText('s-sel', !account || !myStmts.length ? '' : mine.length ? `${mine.length} of ${myStmts.length} picked` : 'Pick the ones to redeem');
    $$<HTMLElement>('#s-picker .pick', app).forEach((p) => p.setAttribute('aria-pressed', String(sPicks.has(p.dataset.sid!))));
    setGo(!account ? 'Redeem my Statements' : mine.length ? `Redeem ${mine.length === 1 ? `Statement #${mine[0].id}` : `${mine.length} Statements`}` : myStmts.length ? 'Pick Statements' : 'No Statements yet', !account || mine.length > 0);
  }
  /// The pairs one box can't do in one go: the way there, and a button to its first step.
  function viaHtml() {
    const tok = !trade?.open && (from === 'balance' || to === 'balance');
    const [steps, text, btn]: [[Asset, string][], string, string] =
      tok && from === 'balance'
        ? [[['balance', '']], `${TOKEN} trades once it opens.`, '']
        : from === 'credit' && to === 'statement'
          ? [[['credit', ''], ['statement', 'Pool 80 in a Credit Union']], '80 Credits make a Statement. Fill it with other holders, or with your own.', '<a class="btn primary block" href="/create">Start a Credit Union</a>']
          : from === 'credit'
            ? [[['credit', ''], ['balance', 'Convert'], ['eth', 'sell on Uniswap']], 'Or list them on OpenSea.', `<button type="button" class="btn primary block" data-pair="credit:balance">Convert to ${TOKEN}</button>`]
            : [
                [['statement', ''], ['balance', 'Redeem'], ...(to === 'credit' ? ([['eth', 'sell on Uniswap'], ['credit', 'buy on OpenSea']] as [Asset, string][]) : ([['eth', 'sell on Uniswap']] as [Asset, string][]))],
                `Redeeming has no fee. Then the ${TOKEN} is typed in for you.`,
                `<button type="button" class="btn primary block" data-pair="statement:balance" data-then="${to}">Redeem first</button>`,
              ];
    const held = !account ? '' : from === 'credit' ? owned.length : from === 'statement' ? myStmts.length : from === 'balance' ? tokAmt(tokenHeld) : ethHeld !== null ? ethNum(ethHeld, 3) : '';
    return `
          <div class="tk-gethead"><h2 class="form-title">You have</h2></div>
          <section class="rule">
            <div class="tk-get tk-panel">${account ? `<span class="num tk-out">${held}</span>` : '<span class="muted">Any you own</span>'}${pickChip('from')}</div>
          </section>
          ${flipHtml()}
          <div class="tk-gethead"><h2 class="form-title">You get</h2></div>
          <section class="rule">
            <div class="tk-get tk-panel"><span class="tk-getrow tk-steps">${steps.slice(1).map(([, how]) => how).join(', then ')}</span>${pickChip('to')}</div>
            <div class="tk-lines term-desc"><p>${text}</p></div>
          </section>
          ${btn ? `<div class="submit">${btn}</div>` : ''}`;
  }

  /// The homepage under the box: the cheapest ways in side by side, Credits on the left and Statements on the right,
  /// each the most rating per ETH first as the marketplace's tiles (one row of as many as fit), headed by the most
  /// BALANCE an ETH gets that way (one rating point is one BALANCE), and each a tap from its whole market.
  const CHEAP = 24;
  const perEth = (tenths: number, wei: bigint) => (wei ? Math.floor(tenths / 10 / (Number(wei) / 1e18)) : 0);
  const skel = '<div class="cc skel" aria-hidden="true"><span class="cc-art"></span><span class="cc-cap"></span></div>';
  const credBody = () => {
    const ls = (pools.get('any') ?? []).slice(0, CHEAP);
    const cell = (x: Listing) =>
      `<div class="cc listed" data-id="${x.id}"><a class="cc-art" href="/credit/${x.id}"><img src="${editionArt(Number(x.id))}" alt="Credit #${x.id}" loading="lazy" decoding="async"></a><span class="cc-cap"><a class="num" href="/credit/${x.id}">#${Number(x.id).toLocaleString('en-US')}</a>${priceTag(x as unknown as Listed)}</span><span class="cc-line num">Rating ${pts(x.tenths)}</span></div>`;
    return market === 'none' ? '<p class="muted">No Credits for sale right now.</p>' : ls.length ? ls.map(cell).join('') : skel.repeat(8);
  };
  const stBody = () => {
    const ls = [...stmts].sort((a, b) => b.rating! / Number(BigInt(b.price)) - a.rating! / Number(BigInt(a.price))).slice(0, CHEAP);
    const cell = (x: ForSale) =>
      `<div class="cc listed st" data-id="${x.id}"><a class="cc-art" href="/statement/${x.id}"><img src="/statement/${x.id}.svg" alt="Statement #${x.id}" loading="lazy" decoding="async"></a><span class="cc-cap"><a class="num" href="/statement/${x.id}">#${x.id}</a><span class="cc-price num" title="On OpenSea"><img class="src" src="${SOURCES.opensea.icon}" alt="OpenSea">${ethNum(BigInt(x.price))}</span></span><span class="cc-line num">Rating ${whole(x.rating!)}</span></div>`;
    return ls.length ? ls.map(cell).join('') : stmtsRead ? '<p class="muted">No Statements for sale right now.</p>' : skel.repeat(4);
  };
  const credRate = () => {
    const x = (pools.get('any') ?? [])[0];
    return x ? perEth(x.tenths, BigInt(x.price) + (BigInt(x.price) * artFee) / 10_000n) : 0;
  };
  const stRate = () => stmts.reduce((a, x) => Math.max(a, perEth(x.rating! * 10, BigInt(x.price))), 0);
  const rateLine = (n: number) => (n ? `Up to <span class="num">${n.toLocaleString('en-US')}</span> ${TOKEN} per ETH` : '&nbsp;');
  const cheapHtml = () => `<section class="tk-cheap">
      <div class="tk-cheapcol cred"><div class="tk-cheaphead"><div><h3>Credits</h3><p class="muted" id="tk-cred-rate">${rateLine(credRate())}</p></div><a href="/credits">All Credits →</a></div><div class="trait-grid tk-cheaprow" id="tk-cheap">${credBody()}</div></div>
      <div class="tk-cheapcol stmt"><div class="tk-cheaphead"><div><h3>Statements</h3><p class="muted" id="tk-st-rate">${rateLine(stRate())}</p></div><a href="/statements">All Statements →</a></div><div class="trait-grid tk-cheaprow" id="tk-cheap-st">${stBody()}</div></div>
    </section>`;
  const fillCheap = () => {
    if (!atHome) return;
    setText('tk-cheap', credBody());
    setText('tk-cheap-st', stBody());
    setText('tk-cred-rate', rateLine(credRate()));
    setText('tk-st-rate', rateLine(stRate()));
  };
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
    sheetFresh = fresh;
    if (cur) shown.set(cur.s.address, count);
    // The sheet shows the batch's Credits (their hover cards say whose), and open paper for the rest.
    if (cur) registerDeposits(cur.ids, cur.depositors);
    // The batches yours wait in, by color, oldest first: a full one waiting to convert isn't the one filling now.
    const yourBatches = LANES.flatMap((x) => waiting.filter((u) => laneOf(u.s) === x && mineIn(u).length).reverse());
    // Yours, in a box over the card where it's seen first: the BALANCE that's yours (held for you until trading opens,
    // ready to claim, or in your wallet), then Credits you've put in a batch, what they come to and the way back out.
    // Credits still in the wallet are the Convert tab's.
    const left = '<span id="tk-left"></span>';
    const rows: string[] = [];
    // A small picture leads each row: up to three of the Credits fanned, or the coin.
    const fan = (ids: readonly bigint[]) => `<span class="tk-yart tk-fan">${ids.slice(0, 3).map((id) => `<img src="${art(id)}" alt="" loading="lazy">`).join('')}</span>`;
    // The coin: the amount in the BALANCE digits (they have no "$"), whole, shrunk to fit its 40px (8 to the advance).
    const coin = (shown: string) => {
      const text = shown.replace(/\.\d+$/, '');
      return `<span class="tk-yart"><span class="tk-ycoin">${balanceSvg(text, myPal ?? EVEN, Math.min(2, 40 / Math.max(1, text.length * 8 - 1)))}</span></span>`;
    };
    // One shape for every row: its art, a bold line and a grey line under it, and the one action on the right.
    const row = (artHtml: string, title: string, sub: string, action = '') => `<div class="tk-yrow">${artHtml}<div class="tk-ytext"><b>${title}</b>${sub ? `<span class="muted small">${sub}</span>` : ''}</div>${action}</div>`;
    const bal = m && tokenHeld > 0n ? tokAmt(tokenHeld) : !m && held && held.amount > 0n ? amount(held.amount) : '';
    // Once it trades, what you hold shows where you pick it (the $BALANCE side's "You have"): a row only while it's locked.
    if (bal && !isOpen) {
      rows.push(row(coin(bal), `Your <span class="num">${bal}</span> ${TOKEN}`, isOpen ? 'In your wallet' : `In your wallet, unlocks ${whenShort(tradesAt)}`));
    }
    // Owed from a converted batch: claimable once the token's transfers open (the keeper usually pays it first).
    if (got.claim.length) {
      const n = `Your <span class="num">${amount(got.amount)}</span> ${TOKEN}`;
      rows.push(paying ? row(coin(amount(got.amount)), n, 'Ready to claim', '<button type="button" class="tk-yact go" id="claim">Claim</button>') : row(coin(amount(got.amount)), n, `Lands in your wallet ${whenShort(tradesAt)}`));
    }
    for (const u of yourBatches) {
      const l = laneOf(u.s)!, mine = mineIn(u), p = u.s.phase;
      // What they pay out when it converts, after the fee this batch opened with (the same figure as the batch box).
      const worth = Math.floor((mine.reduce((n, id) => n + t(id), 0) / 10) * (1 - u.s.protocolFeeBps / 10_000));
      // Full: waiting for BALANCE to open, converting (locked), or its hour passed unconverted (withdrawable again).
      const where = p === 'Open' ? `${u.s.count} of 80 so far` : p === 'Waiting' ? (trade?.open || convertsAt <= Date.now() + 60_000 ? 'full, converting soon' : `full, converts ${whenShort(convertsAt)}`) : p === 'Expired' ? 'full, waiting to convert' : 'full, converting now';
      rows.push(row(fan(mine), `Your ${plural(mine.length)} in ${nameOf(l, u)}`, [worth ? `≈${worth.toLocaleString('en-US')} ${TOKEN} when it converts` : '', where].filter(Boolean).join(' · '), p === 'Burnable' ? '' : `<button type="button" class="tk-yact quiet" data-out="${l.key}" data-batch="${u.s.address}">Withdraw</button>`));
    }
    const yoursBox = rows.length ? `<section class="tk-yours" aria-label="Yours">${rows.join('')}</section>` : '';
    // Until trading opens: one line under the headline, why now and when it trades, in the viewer's own time, counting
    // down (before converting starts, when that does).
    const stepsHtml = () =>
      `<p class="tk-when">${
        converting
          ? `Trading opens ${whenShort(tradesAt)}${left}.`
          : convertsWhen === 'Any minute now' ? 'Converting starts any minute.' : convertsWhen.startsWith('Once') ? `Converting starts once ${TOKEN} is live.` : `Converting starts ${convertsWhen}${left}.`
      }</p>`;
    const whenLine = isOpen && !previewSoon ? '' : stepsHtml();
    kept.clear();
    keepHero(app, () => (app.innerHTML = `
    <section class="tokens${atHome ? ' home' : ''}">
      ${atHome ? HOME_HEAD : `<header class="create-head"><h1>Get ${TOKEN}${isOpen && !previewSoon ? '' : ' before it trades'}</h1></header>`}
      ${whenLine}
      <div class="tk-layout">
      <section class="tk-card">
        ${yoursBox}
        <form class="design-form tk-form" novalidate style="${inkVar(l)}">
          ${tabsHtml()}
          ${v === 'sell' ? sellHtml() : v === 'credits' ? creditsHtml() : v === 'out' ? outHtml() : v === 'redeem' ? redeemHtml() : v === 'art' ? artHtml() : v === 'via' ? viaHtml() : v === 'sellc' ? sellcHtml() : buyHtml()}
        </form>
      </section>
      <div class="tk-right">${isOpen ? '<div class="pc" id="tk-chart"></div>' : ''}<div id="tk-batch-home">${v === 'buy' || v === 'credits' ? batchHtml() : ''}</div>${isOpen ? '<div class="sp" id="tk-supply"></div>' : ''}</div>
      </div>
      ${atHome ? `${cheapHtml()}${explainers()}` : ''}
      ${
        made.length && !atHome
          ? `<section class="tokens-made"><h3>${isOpen ? 'Paid out' : 'Converted'}</h3>${madeLine()}<div class="made-row${isOpen ? ' paid' : ''}">${made.map(madeTile).join('')}</div></section>`
          : ''
      }
    </section>`));
    previewed = ''; // the batch box's bar and key come from drawSheet, so its first run goes through
    bind();
    prices();
    paint();
    // Trading: the price, atop the right column (on a phone, under the button).
    const chartHost = document.getElementById('tk-chart');
    if (chartHost) priceChart(chartHost);
    const supplyHost = document.getElementById('tk-supply');
    if (supplyHost) void supplyBar(supplyHost);
    // Just joined: the batch comes into view once (on a phone it's under the button), yours in it.
    if (joined && !joined.shown && !previewJoined && Date.now() - joined.at < 60_000) {
      joined.shown = true;
      document.getElementById('tk-batch')?.scrollIntoView({ block: 'nearest', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    }
  }

  /// Everything that follows from what's typed or picked, for the view that's open.
  function paint() {
    const v = viewNow();
    if (v === 'buy') void buySync();
    else if (v === 'sell') void sellSync();
    else if (v === 'credits') creditsSync();
    else if (v === 'art') void artSync();
    else if (v === 'out') outSync();
    else if (v === 'redeem') redeemSync(), showLeft();
    else if (v === 'sellc') void sellcSync(), showLeft();
    else showLeft();
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
    const batchWins = hasBatch && (!poolN || withBatch > poolN * WAIT_EDGE);
    st = lane().ink < 0 ? stmtFor(wei) : null; // a pure colour comes only through its batch
    const stN = st ? st.rating! : 0;
    // The ways, each with what it gets. A batch has to beat instant by 3%, a Statement by 1%.
    const ways = ([['pool', poolN], ['batch', withBatch], ['statement', stN]] as [Route, number][]).filter(([, n]) => n > 0);
    // Compared per ETH spent (a Statement may use only part of the amount); each way that isn't instant pays its edge.
    const spentOn = (r: Route) => Number(formatUnits(r === 'statement' ? BigInt(st!.price) : r === 'batch' ? b!.spent + left : wei, 18)) || 1;
    const score = ([r, n]: [Route, number]) => n / spentOn(r) / (r === 'batch' ? WAIT_EDGE : r === 'statement' ? BATCH_EDGE : 1);
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
    // What a BALANCE costs on the pool's way or a Statement's (a batch's line says its fees are in), then how it arrives.
    const gets = route === 'batch' ? withBatch : route === 'pool' ? poolN : route === 'statement' ? stN : 0;
    const paid = route === 'statement' ? BigInt(st!.price) : route === 'batch' ? b!.spent + (split ? left : 0n) : wei;
    const per = paid && gets ? Number(formatUnits(paid, 18)) / gets : 0;
    // To four decimals, as the chart writes the market price beside it: the gap between them is fees and the price moving.
    const rate = per ? `${usd ? usdPrice(per * usd) : `${per.toPrecision(3)} ETH`} each` : '';
    setText('amt-usd', dollars(Number(formatUnits(wei, 18))));
    // Two lines: what each one costs, then how it arrives and what we take on that way.
    setText('tk-gettitle', way === 'batch' || route === 'statement' ? 'You’ll get' : 'You get');
    // Our fees in one line under the tokens: a buy's (in the ETH it spends) and the conversion's.
    const n = hasBatch ? b!.out.length : 0;
    const tenthsIn = n ? b!.out.reduce((a, x) => a + t(x.id), 0) : 0;
    // Through a batch, one line under the number: what the ETH does, then that our fees are in (a tap says what they come to).
    // Split: the two parts that add up to the number, each with when it arrives, on that one line.
    const fee = feeBps ? buyFeeLine(tenthsIn, b?.spent ?? 0n) : feeLine(tenthsIn);
    setText('route', route === 'batch' && n ? (split ? `${whole(b!.tokens)} when the batch fills + ${whole(leftN)} now on Uniswap. ${fee}.` : `Buys ${plural(n)} to convert. ${fee}.`) : rate);
    // Fill it: the ETH that buys every open spot, so the batch converts as soon as that lands.
    const open = 80 - (curOf(lane())?.s.count ?? 0);
    // Its budget is the open spots' worth of the cheapest Credits per point, fee in, so it fills at the best value
    // rather than with the highest-rated Credits an unlimited budget would pick.
    const fillLs = (pools.get(laneKey) ?? []).slice(0, open);
    let fillCost = 0n;
    for (const x of fillLs) fillCost += BigInt(x.price);
    const budget = fillLs.length >= open ? (fillCost * (10_000n + BigInt(feeBps))) / 10_000n : 0n;
    const fill = open > 0 && open <= MAX_BUY && sweeps && market === 'ready' && budget ? viaBatch(budget, laneKey, capOf(lane())) : null;
    const chip = document.getElementById('tk-fill');
    if (chip) {
      // Only while Credits are the better way in: when Uniswap is, that ETH would buy there and fill nothing.
      const amt = fill && fill.out.length >= open && restWay() === 'batch' ? ethNum(fill.spent, 4, true) : '0.5';
      chip.dataset.amt = amt;
      chip.textContent = amt === '0.5' ? '0.5' : 'Fill it';
      chip.title = amt === '0.5' ? '' : `${amt} ETH buys the ${open} open spots, so it converts right away`;
      chip.setAttribute('aria-pressed', String(typed === amt));
    }
    setText('route2', ''); // a split's Uniswap part is said under the number now
    const label: Record<Route, [string, string]> = {
      pool: ['Uniswap', 'Instant · Fees included'],
      batch: ['Credits', 'When the batch fills · Fees included'],
      statement: [st ? `Statement #${st.id}` : 'Statement', `On OpenSea · ${trade?.open ? 'redeems at once' : `redeems when ${TOKEN} opens`}`],
    };
    const box = document.getElementById('tk-batch'), home = document.getElementById('tk-batch-home');
    if (box && home && box.parentElement !== home) home.append(box);
    // Nothing typed: the ways there are, greyed, so the box shows how it goes before there's a number to compare.
    const idle = ([poolOk() ? 'pool' : null, sweeps ? 'batch' : null].filter(Boolean) as Route[])
      .map((r) => `<button type="button" class="tk-way" role="radio" aria-checked="false" disabled><span><b>${label[r][0]}</b><span class="muted small">${label[r][1]}</span></span><span class="num muted">—</span></button>`)
      .join('');
    // The homepage's box takes the better way and says which; choosing between them is /balance's.
    setText(
      'alt',
      !wei && idle
        ? `<div class="tk-ways idle" role="radiogroup" aria-label="Way to buy" aria-disabled="true">${idle}</div>`
        : wei && ways.length > 1
        ? `<div class="tk-ways" role="radiogroup" aria-label="Way to buy">${ways
            .map(([r, n]) => `<button type="button" class="tk-way" role="radio" data-route="${r}" aria-checked="${r === route}"><span><b>${label[r][0]}</b>${r === best ? '<span class="tag">Best</span>' : ''}<span class="muted small">${label[r][1]}</span></span><span class="num">${whole(n)}<span class="muted small"> for ${ethNum(BigInt(Math.round(spentOn(r) * 1e18)), 3)} ETH</span></span></button>`)
            .join('')}</div>`
        : '',
    );
    // Picked through Credits with other ways on show: on a phone the batch box hangs off the Credits row, joined to
    // it; on a wide screen it stays in the right column, where its sheet has room.
    const row = document.querySelector<HTMLElement>('.tk-way[data-route="batch"]');
    const attach = !!row && route === 'batch' && !matchMedia('(min-width: 901px)').matches;
    if (box) box.classList.toggle('attached', attach);
    if (box && row && attach) row.after(box);
    // Our slice of a swap is taken from what comes out, so the amount shown is already after it; tapped, what it is.
    const poolFee = poolN && m ? (poolN * m.feeBps) / (10_000 - m.feeBps) : 0;
    setText(
      'fees',
      way === 'batch' || (!wei && idle)
        ? ''
        : way === 'pool' && route === 'pool'
          ? wei && ways.length > 1 ? '' : `Instant via Uniswap · <button type="button" class="link" id="fee-rate">${feeFlipped && poolFee ? `${whole(poolFee)} ${TOKEN} to Credit Union` : 'Fees included'}</button>`
          : wei && ways.length > 1
          ? ''
          : route === 'statement'
          ? `Bought on OpenSea · uses ${ethNum(BigInt(st!.price), 3)} of your ${ethNum(wei, 3)} ETH`
          : way === 'pool'
          ? 'Instant via Uniswap'
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
            ? `Get ${sym()}`
            : route === 'pool'
              ? `Get ${sym()}`
              : route === 'statement'
                ? `Buy Statement #${st!.id} · ${ethNum(BigInt(st!.price), 3)} ETH`
              : sweeps && market === 'loading'
                ? 'Pricing…'
                : ls.length
                  ? 'Not enough for a Credit'
                  : 'No price right now',
      !!wei && !short && !!route,
    );
    setText('tk-sure', route === 'batch' && !split && n > 0 && n < 80 - (curOf(lane())?.s.count ?? 0) ? 'Take your Credits back anytime before the batch fills.' : '');
    showLeft();
    if (viaSheet()) drawSheet();
    else drawHolding(route === 'pool' ? poolN : 0, pPal);
  }

  /// The sale typed: the ETH it gets (a beat after typing stops) and what you'd hold after.
  async function sellSync() {
    const amt = amountIn();
    const run = ++quoteRun;
    setText('route', '');
    setText('fees', 'Instant via Uniswap');
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
    const short = !!account && amt > tokenHeld;
    setGo(short ? `Not enough ${sym()}` : `Sell ${tokAmt(amt)} ${sym()}`, false);
    await wait(250);
    if (run !== quoteRun) return;
    const q = await swapQuote(m!, false, amt);
    if (run !== quoteRun || !app.isConnected) return;
    setText('amt-line', q ? '' : 'No price right now.');
    // The ETH shown is after our slice; tapped, the slice.
    if (q && q.out > q.net) setText('fees', `Instant via Uniswap · <button type="button" class="link" id="fee-rate">${feeFlipped ? `${ethNum(q.out - q.net, 4, true)} ETH to Credit Union` : 'Fees included'}</button>`);
    out(q?.net ?? 0n);
    if (!short) setGo(q ? `Sell ${tokAmt(amt)} ${sym()}` : 'No price', !!q);
  }

  /// Art for ETH or BALANCE: the ETH it comes to (BALANCE sold on Uniswap first, counted at the least that sale can
  /// bring), then the Credits with the most rating for it (the cheapest per point first, the Sweeper's fee in), or the
  /// Statement it covers with the most rating per ETH.
  let artPlan: { cred: Listing[]; sts: ForSale[]; amt: bigint; eth: bigint } | null = null;
  /// The Statements `eth` buys: the most rating per ETH first while each fits, up to what one Seaport call fills.
  const stmtsFor = (eth: bigint) => {
    const out: ForSale[] = [];
    let spent = 0n;
    for (const y of [...stmts].sort((a, b) => b.rating! / Number(BigInt(b.price)) - a.rating! / Number(BigInt(a.price)))) {
      if (out.length >= 10) break;
      if (spent + BigInt(y.price) <= eth) out.push(y), (spent += BigInt(y.price));
    }
    return { sts: out, spent };
  };
  /// The Credits `eth` buys to the wallet: the cheapest per point first while each fits, the Sweeper's fee in.
  const credFor = (eth: bigint) => {
    const cost = (x: Listing) => BigInt(x.price) + (BigInt(x.price) * artFee) / 10_000n;
    const cred: Listing[] = [];
    let spent = 0n;
    for (const x of pools.get('any') ?? []) {
      if (cred.length >= MAX_SWEEP) break;
      if (spent + cost(x) <= eth) cred.push(x), (spent += cost(x));
    }
    return { cred, spent };
  };
  /// The To menu, once open: beside each, what the amount typed comes to that way (its ETH first, when it's BALANCE),
  /// then how. Just how, while there's nothing typed or nothing to say.
  async function toHints(menu: HTMLElement) {
    const run = ++hintRun, amt = from === 'eth' || from === 'balance' ? amountIn() : 0n;
    const set = (x: Asset, v: string) => {
      const el = menu.querySelector(`[data-asset="${x}"] [data-hint]`);
      if (el) el.textContent = v ? `${v} · ${how(from, x)}` : how(from, x);
    };
    const eth = from === 'eth' ? amt : from === 'balance' && amt && m && trade?.open ? ((await swapQuote(m, false, amt))?.net ?? 0n) : 0n;
    if (run !== hintRun || menu.hidden) return;
    const minSt = stmts.reduce<bigint | null>((a, y) => (a === null || BigInt(y.price) < a ? BigInt(y.price) : a), null);
    for (const x of ASSETS) {
      if (x === from) continue;
      if (x === 'credit' && eth && market === 'ready') {
        const n = credFor(eth).cred.length;
        set(x, n ? `≈${plural(n)}` : 'Not enough for one');
      } else if (x === 'statement' && eth) {
        const st = stmtFor(eth);
        set(x, st ? `#${st.id}, rated ${whole(st.rating!)}` : minSt ? `From ${ethNum(minSt, 2)} ETH` : '');
      } else if (x === 'eth' && from === 'balance' && eth) set(x, `≈${ethNum(eth, 3)} ETH`);
      else if (x === 'balance' && from === 'credit') {
        const tenths = [...picks].reduce((a, id) => a + t(id), 0);
        set(x, tenths ? `≈${whole(est(tenths))}` : '');
      } else if (x === 'balance' && from === 'statement') {
        const total = myStmts.reduce((a, y) => a + y.rating, 0);
        set(x, total ? whole(total) : '');
      } else if (x === 'balance' && from === 'eth' && eth && m && trade?.open) {
        const q = await swapQuote(m, true, eth);
        if (run !== hintRun || menu.hidden) return;
        set(x, q ? `≈${whole(Number(formatUnits(q.net, m.decimals)))}` : '');
      }
    }
  }
  let hintRun = 0;
  async function artSync() {
    const amt = amountIn(), selling = from === 'balance', run = ++quoteRun;
    showLeft();
    artPlan = null;
    let eth = selling ? 0n : amt;
    if (selling && amt) {
      setGo('Pricing…', false);
      await wait(250);
      if (run !== quoteRun) return;
      const q = await swapQuote(m!, false, amt);
      if (run !== quoteRun || !app.isConnected) return;
      eth = q ? (q.net * (10_000n - SELL_SLIPPAGE_BPS)) / 10_000n : 0n;
    }
    setText('amt-usd', dollars(Number(formatEther(eth))));
    let { cred, spent } = to === 'credit' ? credFor(eth) : { cred: [] as Listing[], spent: 0n };
    const { sts } = to === 'statement' ? stmtsFor(eth) : { sts: [] as ForSale[] };
    if (to === 'statement') spent = sts.reduce((a, y) => a + BigInt(y.price), 0n);
    const n = to === 'credit' ? cred.length : sts.length;
    const tenths = to === 'credit' ? cred.reduce((a, x) => a + x.tenths, 0) : sts.reduce((a, y) => a + y.rating!, 0) * 10;
    if (n) artPlan = { cred, sts, amt, eth };
    // You get: the Credits fanned with how many, or the Statement with its number.
    setText(
      'art-get',
      to === 'credit'
        ? `${cred.length ? `<span class="tk-stack">${cred.slice(0, 5).map((x) => `<img src="${art(BigInt(x.id))}" alt="">`).join('')}</span>` : ''}<span class="num tk-out">${cred.length}</span>`
        : sts.length
          ? `<span class="tk-stack">${sts.slice(0, 5).map((y) => `<img class="st" src="/statement/${y.id}.svg" alt="">`).join('')}</span><span class="num tk-out">${sts.length === 1 ? `#${sts[0].id}` : sts.length}</span>`
          : '<span class="num tk-out">0</span>',
    );
    setText('route', n ? `Rated ${whole(tenths / 10)} · converts to ${whole(tenths / 10)} ${TOKEN}` : '');

    const rest = eth - spent >= parseEther('0.001') && n ? ` · ${ethNum(eth - spent, 3)} ETH left over` : '';
    setText(
      'fees',
      !n
        ? selling
          ? 'Sells on Uniswap, then buys on OpenSea · Fees included.'
          : to === 'credit'
            ? 'Bought on OpenSea, most rating per ETH first · Fees included.'
            : 'Bought on OpenSea, the most rating per ETH it covers.'
        : selling
          ? `Sells on Uniswap for at least ${ethNum(eth, 3)} ETH, then buys on OpenSea. Two confirmations · Fees included.`
          : to === 'credit'
            ? `From OpenSea, most rating per ETH first · Fees included${rest}`
            : `From OpenSea, most rating per ETH first · ${ethNum(spent, 3)} ETH${rest}`,
    );
    const short = selling ? !!account && amt > tokenHeld : ethHeld !== null && amt > ethHeld;
    const loading = market === 'loading' && to === 'credit';
    setText('amt-line', '');
    setGo(
      !amt
        ? 'Enter an amount'
        : short
          ? `Not enough ${selling ? sym() : 'ETH'}`
          : loading
            ? 'Pricing…'
            : n
              ? to === 'credit'
                ? `Get ${plural(n)}`
                : sts.length === 1
                  ? `Get Statement #${sts[0].id}`
                  : `Get ${sts.length} Statements`
              : selling && !eth
                ? 'No price right now'
                : `Not enough for a ${to === 'credit' ? 'Credit' : 'Statement'}`,
      !!amt && !short && n > 0,
    );
  }

  /// Your Credits picked: what they pay out, which of them would pay their own color, and the button.
  function creditsSync() {
    const here = new Set(ownedHere().map(String));
    const mine = [...picks].filter((id) => here.has(id)).map(BigInt);
    const tenths = mine.reduce((a, id) => a + t(id), 0);
    if (config.instantVault && iv.stock === null) void readIV().then(() => viewNow() === 'credits' && app.isConnected && creditsSync());
    // Paid now by the vault when it can (the same amount the batch would pay), else when the batch fills.
    const inst = ivFor(mine);
    setGet(inst ? Number(inst.amount / 10n ** 16n) / 100 : tenths ? est(tenths) : 0, paletteOf(lane()));
    setText('route', tenths ? (inst ? `Paid now · ${feeLine(tenths)}` : feeLine(tenths)) : '');
    setText('tk-gettitle', inst ? 'You get' : 'You’ll get');
    // How many wallet confirmations it takes: 40 Credits a transaction, the open batch's room first, then new batches.
    let txs = 0;
    for (let left = mine.length, room = 80 - (curOf(lane())?.s.count ?? 80); left > 0; txs++) {
      const take = Math.min(left, CHUNK, room > 0 ? room : 80);
      left -= take;
      room = room > 0 ? room - take : 80 - take;
    }
    setText('fees', '');
    setText('tk-sure', mine.length && mine.length < 80 - (curOf(lane())?.s.count ?? 0) ? 'Take your Credits back anytime before the batch fills.' : '');
    setText('tk-bfee', txs > 1 ? `${txs} confirmations` : '');
    const all = document.getElementById('pick-all');
    if (all) all.textContent = mine.length ? 'Clear' : 'Select all';
    setText('n-sel', mine.length ? `${mine.length} of ${ownedHere().length} · rated ${pts(tenths)}` : `Pick from your ${ownedHere().length}`);
    if (inst) setText('tk-sure', ''), setText('tk-bfee', '');
    setGo(!account ? 'Convert my Credits' : mine.length ? `Convert ${plural(mine.length)}${inst ? ' · paid now' : trade?.open || converting ? '' : ' · converts when it opens'}` : 'Pick Credits', !account || mine.length > 0);
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
    history.replaceState(history.state, '', pageUrl());
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

  /// The page's address: the color, and the pair unless it's the usual ETH to BALANCE.
  const pageUrl = () => {
    const p = new URLSearchParams();
    if (laneKey !== 'any') p.set('color', laneKey);
    if (from !== 'eth' || to !== (atHome ? 'credit' : 'balance')) p.set('from', from), p.set('to', to);
    return `${atHome ? '/' : '/balance'}${p.size ? `?${p}` : ''}`;
  };
  /// To another pair: the sides change, and what was typed or picked for the last one goes.
  function goPair(a: Asset, b: Asset) {
    if (a === b) return;
    if (viewNow() === 'credits') picks.clear();
    setPair(a, b);
    history.replaceState(history.state, '', pageUrl());
    if (from !== 'statement') then = null;
    typed = a === 'eth' && b !== 'statement' ? '0.1' : '';
    chosen = null;
    if (view === 'credits' && lane().ink >= 0) for (const id of ownedHere()) picks.add(id.toString());
    draw();
    document.querySelector<HTMLInputElement>('#amt')?.focus({ preventScroll: true });
  }
  /// The two sides' menus (arrows move, Enter picks, Escape or a click elsewhere closes), the flip, and F to flip.
  function bindPair() {
    for (const box of $$<HTMLElement>('.tk-side', app)) {
      const btn = box.querySelector<HTMLButtonElement>('.tk-chip')!, menu = box.querySelector<HTMLElement>('.tk-amenu')!;
      const opts = [...menu.querySelectorAll<HTMLElement>('[data-asset]')];
      const k = box.dataset.side as 'from' | 'to';
      const open = (on: boolean) => {
        menu.hidden = !on;
        btn.setAttribute('aria-expanded', String(on));
        if (on) (opts.find((o) => o.getAttribute('aria-selected') === 'true') ?? opts[0]).focus();
        if (on && k === 'to') void toHints(menu);
      };
      // The other side's pick here swaps the two.
      const choose = (a: Asset) => {
        open(false);
        const other = k === 'from' ? to : from;
        if (k === 'from') goPair(a, a === other ? from : other);
        else goPair(a === other ? to : other, a);
      };
      btn.addEventListener('click', () => open(menu.hidden === true));
      menu.addEventListener('click', (e) => {
        const o = (e.target as HTMLElement).closest<HTMLElement>('[data-asset]');
        if (o) choose(o.dataset.asset as Asset);
        else if ((e.target as HTMLElement).closest('[data-how]')) open(false);
      });
      menu.addEventListener('keydown', (e) => {
        const i = opts.indexOf(document.activeElement as HTMLElement);
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          opts[(i + (e.key === 'ArrowDown' ? 1 : opts.length - 1)) % opts.length].focus();
        } else if ((e.key === 'Enter' || e.key === ' ') && i >= 0) {
          e.preventDefault();
          choose(opts[i].dataset.asset as Asset);
        } else if (e.key === 'Escape') {
          open(false);
          btn.focus();
        }
      });
      document.addEventListener('pointerdown', (e) => !menu.hidden && !box.contains(e.target as Node) && open(false), { signal: drawn.signal });
    }
    document.getElementById('tk-flip')?.addEventListener('click', () => goPair(to, from));
    document.addEventListener(
      'keydown',
      (e) => {
        if (e.key !== 'f' && e.key !== 'F') return;
        if (e.metaKey || e.ctrlKey || e.altKey || busy || (e.target as HTMLElement).closest('input, textarea, select, [contenteditable]')) return;
        if (!document.getElementById('tk-flip')) return;
        e.preventDefault();
        goPair(to, from);
      },
      { signal: drawn.signal },
    );
    $$<HTMLElement>('.tk-way[data-sell]', app).forEach((b) =>
      b.addEventListener('click', () => {
        sellWay = b.dataset.sell as 'vault' | 'cc';
        void sellcSync();
      }),
    );
    $$<HTMLElement>('[data-pair]', app).forEach((x) =>
      x.addEventListener('click', () => {
        const [a, b] = x.dataset.pair!.split(':') as [Asset, Asset];
        goPair(a, b);
        if (x.dataset.then) then = x.dataset.then as Asset;
        if (then) draw();
      }),
    );
  }

  function bind() {
    bindPair();
    // The views: Buy · Sell, and the links between Buy, your Credits and Withdraw.
    $$<HTMLButtonElement>('[data-view]', app).forEach((b) =>
      b.addEventListener('click', () => {
        const k = b.dataset.view as typeof view;
        if (b.disabled || k === viewNow()) return;
        if (viewNow() === 'credits') picks.clear();
        view = k;
        const pair = PAIR_OF[k];
        if (pair) [from, to] = pair;
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
    for (const id of ['route', 'fees'])
      document.getElementById(id)?.addEventListener('click', (e) => {
        if (!(e.target as HTMLElement).closest('#fee-rate')) return;
        feeFlipped = !feeFlipped;
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
      // Down to 4 places, so it fits the box; what's left behind is under 0.0001.
      if (paysToken()) typed = formatUnits(tokenHeld, m!.decimals).replace(/(\.\d{4})\d+$/, '$1'); // Sell, or art bought with BALANCE
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
      if (!account) return; // its data-connect opens the wallet; the page draws again once one connects
      const v = viewNow(), l = lane(), wei = amountIn();
      // Sell the picked Credits $CC pays for: let its engine take Credits (once), then one sale at no less than 98% of
      // its bid now (a bid only moves a little between this read and the block).
      if (v === 'sellc' && !cc.live && !config.instantVault) return void document.getElementById('sc-os')?.click();
      const mineSell = [...owned].filter((id) => picks.has(String(id)));
      const inst = v === 'sellc' ? ivFor(mineSell) : null;
      const vaultWay = inst && (sellWay === 'vault' || (sellWay !== 'cc' && (ivEth?.eth ?? 0n) >= ccSale().eth));
      if (v === 'sellc' && inst && vaultWay) {
        return run(
          go,
          `Selling ${plural(inst.ids.length)}…`,
          async () => {
            // Paid in $BALANCE by the vault, then that $BALANCE sold on Uniswap: one confirmation where the wallet
            // takes a batch, else each in turn.
            const q = await swapQuote(m!, false, inst.amount);
            if (!q) throw new Error('No price on Uniswap right now. Try again in a moment.');
            const calls = [...ivCalls(inst), ...(await sellCalls(m!, account!, inst.amount, q.net))];
            if (await canBatch()) await sendBatch(calls, note);
            else for (const c of calls) await send(c, note);
            inst.ids.forEach((id) => picks.delete(String(id)));
            iv.read = null;
            ivEth = null;
          },
          `Sold ${plural(inst.ids.length)} for about ${ethNum(ivEth?.eth ?? 0n, 4)} ETH.`,
        );
      }
      if (v === 'sellc') {
        const { take, eth } = ccSale();
        const core = config.ccCore;
        if (!take.length || !core) return;
        return run(
          go,
          `Selling ${plural(take.length)}…`,
          async () => {
            const approve = { address: config.credits, abi: creditsAbi, functionName: 'setApprovalForAll', args: [core, true] } as const;
            const sale = { address: core, abi: CC_ABI, functionName: 'sellForEth', args: [take, (eth * 98n) / 100n] } as const;
            if (!cc.approved && (await canBatch())) await sendBatch([approve, sale], note);
            else {
              if (!cc.approved) await send(approve, note);
              await send(sale, note);
            }
            take.forEach((id) => picks.delete(String(id)));
            cc.read = null;
            cc.pot = null;
          },
          `Sold ${plural(take.length)} for about ${ethNum(eth, 4)} ETH.`,
        );
      }
      // Redeem the Statements picked: for each, approve the token for that one Statement, then withdraw its exact quote.
      if (v === 'redeem') {
        const mine = myStmts.filter((x) => x.ready && sPicks.has(String(x.id)));
        if (!mine.length) return;
        return run(
          go,
          'Redeeming…',
          async () => {
            const vault = await vaultOf();
            if (!vault || !config.statements) throw new Error(`${TOKEN} isn't live yet.`);
            let got = 0n;
            for (const x of mine) {
              const q = (await pub.readContract({ address: vault, abi: VAULT_ABI, functionName: 'quote', args: [x.id] })) as bigint;
              await send({ address: config.statements, abi: ST_ABI, functionName: 'approve', args: [vault, x.id] }, note);
              await send({ address: vault, abi: VAULT_ABI, functionName: 'withdraw', args: [x.id, q] }, note);
              myStmts = myStmts.filter((y) => y.id !== x.id);
              sPicks.delete(String(x.id));
              got += q;
            }
            // On the way to Credits or ETH: the box turns to that, with the BALANCE just redeemed typed in.
            if (then) {
              setPair('balance', then);
              then = null;
              carry = formatUnits(got, m?.decimals ?? 18).replace(/(\.\d{4})\d+$/, '$1');
            }
          },
          'Redeemed.',
        );
      }
      if (v === 'art' && artPlan) {
        const p = artPlan, selling = from === 'balance';
        return run(
          go,
          selling ? 'Selling…' : 'Buying…',
          async () => {
            if (selling) {
              const q = await swapQuote(m!, false, p.amt);
              if (!q) throw new Error('No price right now. Try again in a moment.');
              const calls = await sellCalls(m!, account!, p.amt, q.net);
              if (calls.length > 1 && (await canBatch())) await sendBatch(calls, note);
              else for (const c of calls) await send(c, note);
            }
            const after = selling ? ` Your ${TOKEN} sold; the ETH is in your wallet.` : '';
            if (p.sts.length) {
              // Every pick in one Seaport call: a listing that sold first is skipped and its ETH comes back.
              const r = await fetch('/market/statements/buy-many', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ listings: p.sts.map((y) => ({ hash: y.hash, protocol: y.protocol })), buyer: account }) });
              const tx = (await r.json()) as { to?: Address; data?: `0x${string}`; value?: string; error?: string };
              if (!r.ok || !tx.to || !tx.data || !tx.value) throw new Error(`${tx.error ?? 'Those Statements can’t be bought right now.'}${after}`);
              await pub.call({ account: account!, to: tx.to, data: tx.data, value: BigInt(tx.value) });
              const hash = await session.wallet!.sendTransaction({ account: account!, chain: session.wallet!.chain, to: tx.to, data: tx.data, value: BigInt(tx.value) });
              note();
              const receipt = await pub.waitForTransactionReceipt({ hash });
              if (receipt.status !== 'success') throw new Error(`The purchase reverted.${after}`);
              const me = account!.toLowerCase(), st = (config.statements ?? '').toLowerCase();
              const got = receipt.logs.filter((l) => l.address.toLowerCase() === st && l.topics.length === 4 && `0x${l.topics[2]!.slice(26)}` === me).map((l) => String(BigInt(l.topics[3]!)));
              stmts = stmts.filter((y) => !got.includes(y.id));
              if (!got.length) throw new Error(`Those Statements sold before you got to them.${after}`);
              toast(got.length === 1 ? `Statement #${got[0]} is yours.` : `${got.length} Statements are yours.`, 'ok', 8000);
              return;
            }
            // The book's rows name a Credit and its price; a buy needs each one's live order (and drops any gone since).
            const offers = await listedById(p.cred.map((x) => x.id), true);
            const gone = p.cred.filter((x) => !offers.some((o) => o.id === x.id)).map((x) => x.id);
            if (gone.length) drop(gone);
            if (!offers.length) throw new Error(`Those Credits just sold. Pick again.${after}`);
            const got = await sweepToWallet(offers, go, note, undefined, drop);
            if (!got?.length) throw new Error(`The Credits didn’t go through.${after}`);
          },
          '',
        );
      }
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
          `Buying ${plan ? plural(plan.b.out.length) : 'Credits'}…`,
          async () => {
            const into = curOf(l)?.s.address ?? '';
            const spent = await buyIn(pickFor(l, wei, capOf(l)), approved as boolean, l);
            joined = { batch: into, lane: l.key, at: Date.now() };
            if (!split) return;
            // What the batch left, less what its transaction cost, on Uniswap.
            const bal = await pub.getBalance({ address: account! });
            const left = wei - spent < bal - GAS_KEEP ? wei - spent : bal - GAS_KEEP;
            if (left < DUST) return;
            const q = await swapQuote(m!, true, left);
            if (!q) throw new Error('The batch part went through; Uniswap has no price right now. Try the rest again in a moment.');
            await send(await buyCall(m!, left, q.net), note);
          },
          split ? 'Done. The Uniswap part is in; the batch part converts when it fills.' : `Done. Yours lands when the batch fills${isOpen ? '' : `, ${whenShort(tradesAt)} at the earliest`}.`,
        );
      }
      // Convert, paid now: the vault takes them into the batch and pays their $BALANCE in the same transaction.
      const nowIds = [...picks].filter((id) => ownedHere().some((x) => String(x) === id)).map(BigInt);
      const now = v === 'credits' ? ivFor(nowIds) : null;
      if (now)
        return run(
          go,
          `Converting ${plural(now.ids.length)}…`,
          async () => {
            const calls = ivCalls(now);
            if (calls.length > 1 && (await canBatch())) await sendBatch(calls, note);
            else for (const c of calls) await send(c, note);
            picks.clear();
            iv.read = null;
          },
          `Done. ${Number(formatUnits(now.amount, 18)).toLocaleString('en-US', { maximumFractionDigits: 0 })} ${TOKEN} is in your wallet.`,
        );
      return run(
        go,
        `Adding ${plural([...picks].filter((id) => ownedHere().some((x) => String(x) === id)).length)}…`,
        async () => {
          const here = new Set(ownedHere().map(String));
          const mine = [...picks].filter((id) => here.has(id)).map(BigInt);
          const into = curOf(l)?.s.address ?? '';
          const approve = { address: config.credits, abi: creditsAbi, functionName: 'setApprovalForAll', args: [factory, true] } as const;
          if (!approved && (await canBatch())) {
            const [one] = await depositCalls(factory, await openUnion(factory, l, curOf(l)?.s.address), mine, l);
            await sendBatch([approve, one], note);
            await depositAll(mine.slice(one.ids.length), l);
          } else {
            if (!approved) await send(approve, note);
            await depositAll(mine, l, curOf(l)?.s.address);
          }
          joined = { batch: into, lane: l.key, at: Date.now() };
          picks.clear();
        },
        `Done. Yours lands when the batch fills${isOpen ? '' : `, ${whenShort(tradesAt)} at the earliest`}.`,
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
    // From the line under the title or the batch box: to the color your Credits wait in, on Withdraw. Taken where the
    // click lands, since the batch box paints its line again as you type.
    app.addEventListener(
      'click',
      (e) => {
        const x = (e.target as HTMLElement).closest<HTMLElement>('[data-out]');
        if (!x) return;
        view = 'out';
        typed = '';
        outFrom = (x.dataset.batch as Address | undefined) ?? null;
        outPicks.clear();
        const to = x.dataset.out as Lane['key'];
        if (to !== laneKey) switchLane(to);
        else draw();
        document.querySelector('.tk-form')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      },
      { signal: drawn.signal },
    );
    document.getElementById('s-picker')?.addEventListener('click', (e) => {
      const el = (e.target as HTMLElement).closest<HTMLButtonElement>('.pick');
      if (!el || el.disabled) return;
      const id = el.dataset.sid!;
      sPicked = true;
      sPicks.has(id) ? sPicks.delete(id) : sPicks.add(id);
      redeemSync();
    });
    document.getElementById('how-color')?.addEventListener('click', howColor);
    $$<HTMLElement>('[data-how]', app).forEach((x) => x.addEventListener('click', howBalance));
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
        <li><b>Buy it</b><span class="muted">${isOpen ? `Pay ETH, get ${TOKEN}. Instant, through Uniswap.` : `Pay ETH. It buys Credits into a batch, which turns into ${TOKEN} at 80.`}</span></li>
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
      // The $CC pile's Credits aren't listed anywhere: they go to the quote as picked, and the Worker prices them now.
      const pile = buy.filter((x) => x.source === 'cc');
      const offers = [...(await listedById(buy.filter((x) => x.source !== 'cc').map((x) => x.id), true)), ...pile.map((x) => ({ id: x.id, price: x.price, source: 'cc' as const }))];
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
    // Never more than the page showed: a Credit relisted higher stops the buy. The $CC pile's prices move block to
    // block, so theirs may come back up to CC_ROOM_BPS higher (the room the buy sends; the engine charges its price then).
    const shown = buy.reduce((a, x) => a + BigInt(x.price) + (x.source === 'cc' ? (BigInt(x.price) * CC_ROOM_BPS) / 10_000n : 0n), 0n);
    if (BigInt(q.total) > shown) throw new Error('Prices moved since this page loaded. Reload, then try again.');
    const { pile, room: room2 } = ccPicks(q);
    const sweeper = config.tokenSweeper!;
    const [value, fee] = (await Promise.all([
      pub.readContract({ address: sweeper, abi: sweeperAbi, functionName: 'quote', args: [BigInt(q.total) + room2] }),
      pub.readContract({ address: sweeper, abi: sweeperAbi, functionName: 'feeBps' }),
    ])) as [bigint, bigint];
    const fwa = (q.fwa ?? []).map((f) => ({ listingId: BigInt(f.listingId), price: BigInt(f.price) }));
    const strategy = (q.strategy ?? []).map((f) => ({ tokenId: BigInt(f.id), price: BigInt(f.price) }));
    const ids = [...q.ids, ...(q.fwa ?? []).map((f) => f.id), ...(q.strategy ?? []).map((f) => f.id), ...(q.cc ?? []).map((f) => f.id)];
    if (ids.length < buy.length) toast(`${buy.length - ids.length} sold before you got to them.`, 'info', 8000);
    if (into) {
      await send(
        pile.length
          ? { address: sweeper, abi: sweeperAbi, functionName: 'sweepEvery', args: [into, q.orders, fwa, strategy, pile, 1n, fee], value }
          : fwa.length || strategy.length
            ? { address: sweeper, abi: sweeperAbi, functionName: 'sweepAll', args: [into, q.orders, fwa, strategy, 1n, fee], value }
            : { address: sweeper, abi: sweeperAbi, functionName: 'sweep', args: [into, q.orders, 1n, fee], value },
        note,
      );
      return value;
    }
    const receipt = await send(
      pile.length
        ? { address: sweeper, abi: sweeperAbi, functionName: 'buyEvery', args: [q.orders, fwa, strategy, pile, 1n, fee], value }
        : { address: sweeper, abi: sweeperAbi, functionName: 'buy', args: [q.orders, fwa, strategy, 1n, fee], value },
      note,
    );
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
    if (account && owned.length && view === 'buy' && !atHome) {
      setPair('credit', 'balance');
      for (const id of ownedHere()) picks.add(id.toString());
    } else if (from === 'eth' && to !== 'statement' && !typed) typed = '0.1';
  }
  // Your Credits in a pure color open with yours of that ink picked, however you got here (its card, or a ?color= link).
  if (viewNow() === 'credits' && lane().ink >= 0 && !picks.size) for (const id of ownedHere()) picks.add(id.toString());
  draw();
  // Each converted batch's Balance, read once the page is up: its tile turns from the Statement into it.
  // (Not once trading opens: paid out, a Balance shows its empty pot, and the tile is the batch's Credits instead.)
  for (const c of made)
    if (!isOpen && c.pocket && !c.art)
      void balanceArt(c.pocket).then((a) => {
        if (!a || thisRun !== pageRun) return;
        artKept.set(c.pocket!.toLowerCase(), a);
        c.art = a;
        const row = app.querySelector('.tokens-made .made-row');
        if (row) row.innerHTML = made.map(madeTile).join('');
      });

  // Live: every block (12 s) while this page is up, and the moment its tab is shown again, look for deposits, withdrawals,
  // new batches and conversions (anyone's), and draw the page again when something moved. What's typed and picked
  // carries over; it waits while a transaction is in flight or the amount is being edited.
  const drawnAt = Date.now();
  const check = async () => {
    if (thisRun !== pageRun || !app.isConnected) return stop();
    if (busy || document.hidden || document.activeElement?.id === 'amt') return;
    try {
      // From the token index (one read for everyone, a few seconds old at most), else the chain.
      const ix = await tokenIndex();
      const inIx = (a: Address) => ix?.find((b) => same(b.s.address, a));
      const read = (u: Union, functionName: 'count' | 'state') => pub.readContract({ address: u.s.address, abi: batchAbi, functionName }) as Promise<bigint | number>;
      const [m, now] = ix
        ? [BigInt(ix.length), waiting.map((u) => ((b) => [b.count, STATES.indexOf(b.state)] as const)(inIx(u.s.address)?.s ?? u.s))]
        : await Promise.all([
            pub.readContract({ address: factory, abi: factoryAbi, functionName: 'batchCount' }) as Promise<bigint>,
            Promise.all(waiting.map((u) => Promise.all([read(u, 'count'), read(u, 'state')]))),
          ]);
      // Yours paid out, or trading opened since this draw (so "Lands in your wallet" turns into what it is now).
      const owedNow =
        account && got.claim.length
          ? await Promise.all(
              got.claim.map((u) => {
                const p = inIx(u)?.payout;
                return p ? shareOf(p, account).owed : (pub.readContract({ address: config.tokenAdapter!, abi: tokenAdapterAbi, functionName: 'claimable', args: [u, account] }) as Promise<bigint>);
              }),
            )
          : [];
      const opened = !paying && !!gate?.opensAt && (await pub.getBlockNumber()) >= gate.opensAt;
      // What changes what you see (a new batch, one filling or converting, yours paid, trading open) draws the page
      // again. Someone else's deposit only moves a count: that's said in place, and the page draws again for it at
      // most once a minute (the sheet's new Credits come with that draw), so it doesn't flash while you read.
      const big = m !== n || owedNow.some((v) => v === 0n) || opened || now.some(([, st], i) => Number(st) !== STATES.indexOf(waiting[i].s.state));
      const counts = now.some(([c], i) => Number(c) !== waiting[i].s.count);
      if (!big && !counts) return;
      if (!big && Date.now() - drawnAt < 60_000) {
        now.forEach(([c], i) => (waiting[i].s.count = Number(c)));
        paint();
        return;
      }
      if (thisRun === pageRun && !busy) {
        stop();
        keptPicks = [...picks];
        rerun();
      }
    } catch {}
  };
  const poll = setInterval(check, 12_000);
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
        const bk = await bookP;
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
        fillCheap();
        if (m && trade?.open) {
          const [q, b] = [await swapQuote(m, true, REF), viaBatch(REF, 'any', capOf(LANES[0]))];
          restMixed = b.out.length && (!q || b.tokens > Number(formatUnits(q.net, m.decimals)) * WAIT_EDGE) ? 'batch' : q ? 'pool' : 'batch';
        }
      } catch {
        market = 'none';
        fillCheap();
      }
      if (!app.isConnected) return;
      prices();
      paint();
    })();
}

/// Where all the rating sits now (the Worker's /market/supply.json), read once a visit: one line, the share that's
/// BALANCE, over one bar of the three.
type Supply = { total: number; credits: number; statements: number; balance: number };
let supplyRead: Promise<Supply | null> | null = null;
async function supplyBar(host: HTMLElement) {
  supplyRead ??= fetch('/market/supply.json').then((r) => (r.ok ? (r.json() as Promise<Supply>) : null)).catch(() => null);
  const d = await supplyRead;
  if (!d?.total || !host.isConnected) return;
  const pc = (v: number) => (v / d.total) * 100;
  const label = (v: number) => `${pc(v).toFixed(1)}%`;
  const amt = (v: number) => `${(v / 1e6).toFixed(2)}M`;
  const parts: [string, string, number][] = [['Credits', 'sp-c', d.credits], ['Statements', 'sp-s', d.statements], [TOKEN, 'sp-b', d.balance]];
  host.innerHTML = `
    <p class="sp-head"><span class="num">${label(d.balance)}</span> of all rating is now ${TOKEN}</p>
    <div class="sp-bar" role="img" aria-label="${parts.map(([n, , v]) => `${n} ${label(v)}`).join(', ')}">${parts.map(([n, c, v]) => `<span class="${c}" style="flex:${pc(v).toFixed(3)}" title="${n}: ${amt(v)} rating"></span>`).join('')}</div>
    <div class="sp-key">${parts.map(([n, c, v]) => `<span><i class="${c}"></i>${n} <span class="num">${label(v)}</span></span>`).join('')}</div>`;
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

/// Each converted batch's Balances, once read (they only change when a batch is paid out, which redraws the page).
const artKept = new Map<string, BalanceArt>();
/// Each converted batch: its Statement, its color, what it converted into, its pocket, and its Balance (the artwork its
/// pocket got with the BALANCE, which reads the pot until members are paid) when this visit has read it before.
async function conversions(batches: Union[]) {
  if (!batches.length || !config.tokenAdapter) return [];
  const at = config.tokenAdapter;
  return Promise.all(
    batches.map(async (u) => {
      const [c, pocket, members] = u.payout
        ? [u.payout.of as readonly unknown[] as readonly bigint[], u.payout.pocket, u.payout.members]
        : await Promise.all([
            pub.readContract({ address: at, abi: tokenAdapterAbi, functionName: 'conversionOf', args: [u.s.address] }) as Promise<readonly bigint[]>,
            (pub.readContract({ address: at, abi: tokenAdapterAbi, functionName: 'pocketOf', args: [u.s.address] }) as Promise<Address>).catch(() => null),
            (pub.readContract({ address: at, abi: tokenAdapterAbi, functionName: 'membersOf', args: [u.s.address] }) as Promise<readonly Address[]>).catch(() => [] as readonly Address[]),
          ]);
      // What its members share (what it converted into, less our fee and what's set aside, as received() reckons it).
      return { sid: c[0], amount: c[1], net: c[1] - c[3] - c[4], members, lane: laneOf(u.s)!, pocket, ids: u.ids, art: (pocket && artKept.get(pocket.toLowerCase())) || null };
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
      if (u.payout) {
        const { mine, owed } = shareOf(u.payout, you), [, amount, , pFee, cFee] = u.payout.of;
        return { u: u.s.address, amount: u.payout.total > 0n ? ((amount - pFee - cFee) * mine) / u.payout.total : 0n, owed };
      }
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
