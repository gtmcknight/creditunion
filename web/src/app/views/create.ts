import { go as navigate } from '../main';
import { dice, printGlyph, swatch, weightGlyph } from '../glyphs';
import { decodeEventLog, parseEther, type Address } from 'viem';
import { creditsAbi, factoryAbi, unionFormatsAbi } from '../abi';
import { compose, DIRECTIONS, paint as paintMarks, PAGE, type Direction } from '../../shared/statement';
import { canBatch, config, pub, send, sendBatch, session } from '../chain';
import { tokensOn } from '../tokens';
import { INK, maskInks, maskLabel } from '../traits';
import { earlyWeight, placeOnLayout, SPLITS, creatorFeeBps, factoryRatings, isLiveTable, liveTenths, rulesBin, isApproved, minOpen, myCredits, protocolFeeBps, ratings, type Listed, type Rated, type Summary } from '../data';
import { paletteBit, TRAITS } from '../traits';
import { $$, art, errText, esc, fromTimeText, openModal, sameZoneDay, sheet, toast, toTimeText, typedToMinute, mintEdgeNote, zoned, zoneName, zoneToggle } from '../ui';
import { LAYOUT_TRAITS, keyOf, ruleFor, slotMark, slotName, type LayoutTrait } from '../../shared/layout';
import { bitsPath, ratingPath, setPath, timePath } from '../../shared/trait';
import { editionArt } from '../ghosts';
import { listedById, listedPager, live, priceTag, relist, sweepControls, sweepToWallet, type Listed as Listing, type Sale } from '../forsale';
import { creditCell } from './trait';
import { directionCanvas, directions, mountDirections, rulesView, showDirection } from '../directions';
import { Room, booksOf, noRoomReason } from '../slots';
import { bin } from '../bins';
import { TRAIT_KINDS, eightsName, parseTrait } from '../../shared/trait';
import { WAVE_SHAPES, inkFor, mazeIndex, planMaze, waveColors, type Maze, type MazeIndex, type Pool, type WaveShape } from '../../shared/lab';
import { DETAIL, gapOf, Guide, framer, packPicture, planOf, type Framer, type Plan, OWN_GOOD, runOf, type Look } from '../picture';

const CHUNK = 40;
/// The layouts a new party can pick, by the contract's burn-order number (1 Mint time and 3 Creator's order are retired).
const ARR_OPTS: [number, string, string][] = [
  [0, 'Joined', 'In the order they joined.'],
  [6, 'Picture', 'Your picture, drawn by your Credits and ones for sale.'],
  [4, 'Painted', 'Pick a color, then paint the sheet.'],
  [8, 'Wave', 'Each row as long as its Credit’s ink.'],
  [9, 'Maze', 'One way through, from 80 Credits for sale.'],
];
/// What happens at 80: the Statement is auctioned and the sale split, or it converts into tokens split the same way.
const END_HINTS = {
  auction: 'The Statement is auctioned for 24 hours and the sale is split.',
  tokens: 'The Statement converts into tokens. Each member gets tokens for the rating they put in. No auction.',
};
/// Picture is Painted on-chain: the tile only changes how the paint is made.
const PICTURE = 6;
/// Wave is Painted on-chain too (a Colors per slot, made for you); Maze is these 80 Credits, in order.
const WAVE = 8, MAZE = 9;
const DESIGNED = new Set([WAVE]);
/// A 4×5 thumbnail per layout: shade steps show the order the sheet fills in. Also on /docs.
export const arrIcon = (v: number) => {
  const cells = Array.from({ length: 20 }, (_, i) => {
    const k = v === 2 ? i : v === 5 ? 19 - i : v === 0 ? [3, 11, 7, 15, 0, 18, 9, 5, 13, 1, 16, 6, 10, 2, 19, 8, 14, 4, 17, 12][i] : -1;
    if (v === PICTURE) return `<rect x="${(i % 4) * 7}" y="${((i / 4) | 0) * 7}" width="6" height="6" fill="${PICTURE_ICON[i]}"/>`;
    if (v === WAVE || v === MAZE) {
      const on = (v === WAVE ? '##..###.####.###.##.' : '#.###...###.#.....##')[i] === '#';
      const fill = v === MAZE ? (on ? '#111111' : 'rgba(17,17,17,0.12)') : on ? '#00b5e2' : 'rgba(17,17,17,0.12)';
      return `<rect x="${(i % 4) * 7}" y="${((i / 4) | 0) * 7}" width="6" height="6" fill="${fill}"/>`;
    }
    const fill = v === 4 ? ([0, 3, 5, 6, 9, 10, 13, 14, 16, 19].includes(i) ? '#00b5e2' : '#e4007c') : `rgba(17,17,17,${(0.12 + (0.88 * (19 - k)) / 19).toFixed(2)})`;
    return `<rect x="${(i % 4) * 7}" y="${((i / 4) | 0) * 7}" width="6" height="6" fill="${fill}"/>`;
  }).join('');
  return `<svg viewBox="0 0 27 34" aria-hidden="true">${cells}</svg>`;
};
/// Picture's tile: a sun over a horizon, in Credit tones.
const PICTURE_ICON = ['#80daf1', '#ffe87f', '#ffe87f', '#80daf1', '#80daf1', '#f1745f', '#f1745f', '#80daf1', '#80daf1', '#80daf1', '#80daf1', '#80daf1', '#80c678', '#80c678', '#446a40', '#446a40', '#446a40', '#403a5f', '#446a40', '#403a5f'];
/// Layout presets: which slots take brush A, brush B, or stay open (any palette).
/// A shape drawn on the 8×10 sheet, row by row: # takes brush A, . takes brush B.
const bitmap = (rows: string) => {
  const cells = rows.trim().split(/\s+/).join('');
  return (i: number): 'A' | 'B' => (cells[i] === '#' ? 'A' : 'B');
};
const LAYOUTS: Record<string, (i: number) => 'A' | 'B' | 0> = {
  Checkered: (i) => ((Math.floor(i / 8) + (i % 8)) % 2 === 0 ? 'A' : 'B'),
  Stripes: (i) => (Math.floor(i / 8) % 2 === 0 ? 'A' : 'B'),
  Columns: (i) => (i % 2 === 0 ? 'A' : 'B'),
  Border: (i) => (Math.floor(i / 8) === 0 || Math.floor(i / 8) === 9 || i % 8 === 0 || i % 8 === 7 ? 'A' : 'B'),
  Diagonal: (i) => (Math.abs(Math.floor(i / 8) - (i % 8) - 1) <= 1 ? 'A' : 'B'),
  // Jack's Opepen: head and shoulders.
  Opepen: bitmap(`........ ..####.. .######. .######. .######. ..####.. ...##... .######. ######## ########`),
  Check: bitmap(`........ ........ .......# ......## #....##. ##..##.. .####... ..##.... ........ ........`),
  Eight: bitmap(`.######. ##....## ##....## ##....## .######. .######. ##....## ##....## ##....## .######.`),
  Target: bitmap(`######## #......# #.####.# #.#..#.# #.#..#.# #.#..#.# #.#..#.# #.####.# #......# ########`),
  Diamond: bitmap(`...##... ..####.. .######. ######## ######## ######## ######## .######. ..####.. ...##...`),
  Cross: bitmap(`...##... ...##... ...##... ...##... ######## ######## ...##... ...##... ...##... ...##...`),
  Halves: bitmap(`######## ######## ######## ######## ######## ........ ........ ........ ........ ........`),
  X: bitmap(`##....## .##..##. ..####.. ...##... ...##... ...##... ...##... ..####.. .##..##. ##....##`),
  Stairs: bitmap(`#....... ##...... ###..... ####.... #####... ######.. #######. ######## ######## ########`),
  Heart: bitmap(`........ .##..##. ######## ######## ######## .######. ..####.. ...##... ........ ........`),
  Arrow: bitmap(`...##... ..####.. .######. ######## ...##... ...##... ...##... ...##... ...##... ...##...`),
  Solid: () => 'A',
  Clear: () => 0,
};
/// Ready-made designs for an empty painter: a pattern in two Colors (CMYK masks: C 1, M 2, Y 4, K 8).
const DESIGNS: [string, number, number][] = [
  ['Opepen', 8, 4],
  ['Check', 8, 1],
  ['Eight', 2, 4],
  ['Target', 8, 4],
  ['Diamond', 1, 8],
  ['Cross', 2, 8],
  ['Heart', 2, 1],
  ['Arrow', 8, 2],
  ['Checkered', 1, 2],
  ['Border', 8, 4],
  ['Diagonal', 2, 1],
  ['Stripes', 4, 8],
  ['Columns', 1, 8],
  ['Halves', 1, 4],
  ['X', 8, 2],
  ['Stairs', 2, 8],
];
const fmt = (n: number) => n.toFixed(4).replace(/\.?0+$/, '');
const INKS: Record<string, string> = { C: '#00B5E2', M: '#E4007C', Y: '#FFD100', K: '#111111' };
const PRINTS = TRAITS.print; // Registered … Loose, in contract order
const WEIGHTS = TRAITS.weight; // even lean sparse extreme
const EIGHTS_MAX = 5;
const BITS_LO = 16, BITS_HI = 160; // the fewest and most Bits any Credit in the edition has (public/bits.bin)

type Minutes = [number, number][];

/// The rules being designed. Trait sets are bitmasks in the contract's encoding (0 = any).
type Rules = {
  palettes: number;
  prints: number;
  weights: number;
  eights: number;
  minuteFrom: number; // index into minutes, -1 = any
  minuteTo: number;
  idFrom: number;
  idTo: number;
  minScore: number; // ×10, 0 = any
  maxScore: number;
  bitsFrom: number; // Jack's Bits, 0 = unbounded
  bitsTo: number;
  list: number[];
};

const weightOf = (r: Rated) => {
  const marks = r.traits.activeBits, cap = r.traits.palette.length * 64;
  if (marks * 256 >= 120 * cap && marks * 256 <= 136 * cap) return 'even';
  if (marks * 256 >= 112 * cap && marks * 256 <= 144 * cap) return 'lean';
  if (marks * 256 >= 96 * cap && marks * 256 <= 160 * cap) return 'sparse';
  return 'extreme';
};

// ---------------------------------------------------------------- glyphs





/// Plates as a stack of offset inks: 1 is cyan alone, 4 is cyan, magenta, yellow and black overprinted.
const platesGlyph = (n: number) => {
  const inks = ['#00B5E2', '#E4007C', '#FFD100', '#111111'].slice(0, n);
  const step = 2.5, size = 14, start = 12 - (size + step * (n - 1)) / 2;
  return `<svg viewBox="0 0 24 24" aria-hidden="true">${inks
    .map((c, i) => `<rect x="${start + i * step}" y="${start + i * step}" width="${size}" height="${size}" fill="${c}" style="mix-blend-mode:multiply"/>`)
    .join('')}</svg>`;
};

/// Eights laid out like dice pips on a 3×3 grid: 1 centre, 2 and 3 on the diagonal, 4 corners, 5 corners and centre.
const PIPS: [number, number][][] = [[], [[2, 2]], [[1, 1], [3, 3]], [[1, 1], [2, 2], [3, 3]], [[1, 1], [1, 3], [3, 1], [3, 3]], [[1, 1], [1, 3], [2, 2], [3, 1], [3, 3]]];
const eightsPips = (n: number) => `<span class="pips">${PIPS[n].map(([r, c]) => `<i style="grid-area:${r}/${c}">8</i>`).join('')}</span>`;
/// What each payout means, in one line.
const PAYOUT_HINTS = [
  'All 80 get 1/80',
  'First 1.5× · Last 0.5×',
];
const EIGHT_NAMES = ['none', 'one', 'two', 'three', 'four', 'five'];
/// Each payout as 80 thin bars, one per Credit in deposit order: Equal flat at 1×, Early bird sliding from 1.5× to
/// 0.5× (earlyWeight). Drawn to the same scale, so the two read against each other.
const payoutChart = (split: number) =>
  `<svg class="pay-chart" viewBox="0 0 160 24" preserveAspectRatio="none" aria-hidden="true">${Array.from({ length: 80 }, (_, i) => {
    const h = ((split === 1 ? earlyWeight(i) : 1) / 1.5) * 24;
    return `<rect x="${i * 2}" y="${(24 - h).toFixed(2)}" width="1.4" height="${h.toFixed(2)}"/>`;
  }).join('')}</svg>`;
const eightsChip = (n: number) => (n === 0 ? 'no 8s' : '8'.repeat(n));

/// Palettes by ink count, one row each (C M Y K · the pairs · the triples · CMYK), in CMYK order within a row.
const inkKey = (p: string) => [...p].map((c) => 'CMYK'.indexOf(c)).join('');
const PALETTE_ROWS = [1, 2, 3, 4].map((n) => TRAITS.colors.filter((p) => p.length === n).sort((a, b) => inkKey(a).localeCompare(inkKey(b))));


/// Badge a preview slot with its paint's icon, the same one its brush shows ('' clears it).
function markPaint(cell: HTMLElement, icon: string) {
  cell.querySelector('.paint')?.remove();
  if (icon) cell.insertAdjacentHTML('afterbegin', `<b class="paint">${icon}</b>`);
}

// ---------------------------------------------------------------- page

export async function create(app: HTMLElement) {
  if (!session.account) {
    app.innerHTML = `
    <section class="narrow"><h1>Start a Credit Union</h1><p class="lede">Set the rules, add your Credits, invite everyone. At 80 they burn into a Statement and everyone in splits the sale.</p>
    <button class="btn primary" data-connect>Connect wallet</button></section>`;
    return;
  }

  // The page draws at once. Your Credits come in when the wallet answers (the Deposit picker says so meanwhile), the
  // factory's numbers (the minimum to open, the fees, the score table) behind them; Start waits for both.
  app.innerHTML = `<header class="create-head"><h1>Start a Credit Union</h1><p class="create-lede">Set the rules, add your Credits, invite everyone. At 80 they burn into a Statement and everyone in splits the sale.</p></header>`;
  const account = session.account;
  const walletRead = Promise.all([myCredits(account), isApproved(account)]);
  const factoryRead = Promise.all([minOpen(), protocolFeeBps(), creatorFeeBps(), factoryRatings()]);
  walletRead.catch(() => {});
  factoryRead.catch(() => {});
  const minutes = await fetch('/minutes.json').then((r) => r.json() as Promise<Minutes>).catch(() => [] as Minutes);
  let factoryIn = false;
  let isOk = false; // the factory may move your Credits (read with them)
  let min = 1, protocolBps = 0, creatorBps = 0;
  let table = '0x0000000000000000000000000000000000000000' as Address;
  const owned: bigint[] = []; // yours, once the wallet answers; what you buy on this page joins it
  const pickBtn = (id: bigint) => `<button type="button" class="pick" data-id="${id}" aria-pressed="false" title="Credit #${id}"><img src="${art(id)}" alt="Credit #${id}" loading="lazy"></button>`;
  const rules: Rules = { palettes: 0, prints: 0, weights: 0, eights: 0, minuteFrom: -1, minuteTo: -1, idFrom: 0, idTo: 0, minScore: 0, maxScore: 0, bitsFrom: 0, bitsTo: 0, list: [] };
  const artOf = (id: bigint) => (config.chainId === 1 ? art(id) : `/art/mainnet/${id}.svg`);
  let ghosts: { id: bigint; palette: number; t: number }[] = [];
  let view: 'rules' | 'credits' = 'credits'; // what the sheet shows (see drawPreview)
  let keyGhosts = new Map<number, typeof ghosts>(); // samples per painted value, for the painted preview
  let keySupply = new Map<number, number>(); // how many Credits in the edition fit each painted value under the rules
  /// A painted value asked for in more slots than there are Credits to fill them: the sheet could never fill.
  const overPainted = () => {
    const n = new Map<number, number>();
    for (const m of layout) if (m) n.set(m, (n.get(m) ?? 0) + 1);
    for (const [m, c] of n) {
      const have = keySupply.get(m);
      if (have !== undefined && c > have) return { m, c, have };
    }
    return null;
  };
  const overText = (o: { m: number; c: number; have: number }) =>
    `Only ${o.have.toLocaleString()} ${o.have === 1 ? 'Credit fits' : 'Credits fit'} ${slotName(layoutTrait, o.m)}, but ${o.c} slots ask for it.`;
  let pattern: 'none' | 'checkered' = 'none';
  let pic: Framer | null = null; // the Picture layout's framer, made when it's first picked
  let guide: Guide | null = null; // the framed picture against every Credit that could draw it
  let picPx: Uint8ClampedArray | null = null; // the picture the sheet was designed from (saved with the union)
  let picLook: Look = 'Consolidated'; // the format its Credits are matched in
  let viewing: Direction = 'Consolidated'; // the format the preview shows: a picture burns in it
  const LOOKS: Look[] = ['Consolidated', 'Assessed', 'Reconciled'];
  const picGone = new Set<number>(); // planned Credits found no longer for sale
  let picPlan: Plan | null = null; // what can go in first: yours that are next in their Colors, and listings
  /// Where Credits can be bought here (mainnet), a picture union starts with yours and Credits bought for it: the
  /// picture is the market's best, and one of yours takes a spot only where it draws it about as well (OWN_GOOD).
  /// Testnets can't buy, so there it leans on yours.
  const buyToStart = !!config.sweeper;
  /// Picture is the layout and its sheet is designed: only the picture's own Credits go in, each Colors in order.
  /// Tokens picked under When it burns (only once the token factory is deployed).
  const endingTokens = () => tokensOn() && app.querySelector<HTMLInputElement>('input[name=ending]:checked')?.value === 'tokens';
  let maze: Maze | null = null; // the Maze layout's 80, once planned
  const mazeOn = () => app.querySelector<HTMLInputElement>('input[name=arr]:checked')?.value === String(MAZE);
  const picturing = () => !!picPlan && layout.some(Boolean) && app.querySelector<HTMLInputElement>('input[name=arr]:checked')?.value === String(PICTURE);
  const bySlot = (ids: string[]) => (picPlan ? [...ids].sort((a, b) => (picPlan!.slot.get(a) ?? 99) - (picPlan!.slot.get(b) ?? 99)) : ids);
  const layout: number[] = new Array(80).fill(0); // slot values of the painted trait, 0 = any
  let panesReady = false; // the rule tabs exist (refresh() redraws them once they do)
  let layoutTrait: LayoutTrait = 0; // which trait the sheet is painted with (shared/layout.ts)
  let brushA = 1, brushB = 8; // cyan and black to start
  const picks = new Set<string>();
  const last = Math.max(0, minutes.length - 1);

  // Title and one line across the top; under them the sheet (match count below it) and the form start level.
  app.innerHTML = `
  <header class="create-head"><h1>Start a Credit Union</h1><p class="create-lede">Set the rules, add your Credits, invite everyone. At 80 they burn into a Statement and everyone in splits the sale. <a href="/">How it works →</a></p></header>
  <section class="design">
    <div class="design-preview dir-host">
      <div id="preview">${sheet([])}</div>${directionCanvas}
      <div class="preview-foot">
        <div class="view-toggle" role="radiogroup" aria-label="Show" hidden><label><input type="radio" name="view" value="rules"><span>Painted</span></label><label><input type="radio" name="view" value="credits" checked><span>Credits</span></label></div>
        <div class="muted small">${directions('create', true)}</div>
      </div>
    </div>

    <form id="create" class="design-form" novalidate>
      <label class="name-field"><span>Name</span><input id="name" type="text" maxlength="64" placeholder="e.g. Cyan Minute" autocomplete="off" data-1p-ignore data-lpignore="true" data-bwignore data-form-type="other"></label>
      <h2 class="form-title">Layout</h2>
      <section class="rule layout-opts" data-tab="order" data-pane="order">
        <div class="arr-tiles" role="radiogroup" aria-label="Layout">${ARR_OPTS.map(([v, l, h]) => `<label class="arr-tile" title="${h}"><input type="radio" name="arr" value="${v}" ${v === 0 ? 'checked' : ''}>${arrIcon(v)}<b>${l}</b></label>`).join('')}</div>
        <p class="term-desc muted" id="arr-hint">${ARR_OPTS.find(([v]) => v === 0)![2]}</p>
        <div class="picture-block" id="picture-block" hidden>
          <input type="file" id="pic-file" accept="image/*" hidden>
          <div class="picture-frame">
            <div class="printer-crop" title="Drag to move, pinch or scroll to zoom"><canvas id="pic-crop" width="256" height="320" aria-label="The picture: drag to move, pinch or scroll to zoom"></canvas><div class="printer-zoom"><button type="button" data-zoom="out" aria-label="Zoom out">−</button><button type="button" data-zoom="in" aria-label="Zoom in">+</button></div></div>
            <div class="picture-side">
              <label class="picture-contrast"><span>Brightness</span><input type="range" id="pic-brightness" min="0.5" max="1.3" step="0.05" value="1" aria-label="Brightness"></label>
              <label class="picture-contrast"><span>Contrast</span><input type="range" id="pic-contrast" min="0.8" max="1.8" step="0.05" value="1.2" aria-label="Contrast"></label>
              <label class="picture-contrast"><span>Saturation</span><input type="range" id="pic-saturation" min="0" max="2.5" step="0.05" value="1" aria-label="Saturation"></label>
              <p class="term-desc muted">Shown as the Credits see it, one square each. Drag to frame it, zoom out to shrink it onto white.</p>
              <div class="pic-links" id="pic-links" hidden><button type="button" class="link small" id="pic-replace">Choose another picture</button><button type="button" class="link small" id="pic-reset">Reset</button></div>
              <p class="term-desc muted num" id="pic-status" aria-live="polite"></p>
            </div>
          </div>
        </div>
        <div class="design-block" id="design-block" hidden></div>
        <div class="paint-block" id="paint-block" hidden>
          <div class="brushes" id="brushes"></div>
          <div class="lgrid" id="lgrid" hidden>${Array.from({ length: 80 }, (_, i) => `<button type="button" class="lcell" data-i="${i}" aria-label="Slot ${i + 1}"></button>`).join('')}</div>
        </div>
      </section>

      <h2 class="form-title who-title">Eligible Credits <button type="button" class="link small join-count" id="see-eligible" title="See them"><span class="num" id="st-edition">–</span> <span id="st-edition-label">→</span></button></h2>
      <section class="rule who-bar" data-pane="who">
        <p class="rule-sentence" id="rule-sentence"></p>
        <div class="rule-list" id="add-rule" hidden></div>
        <div class="rule-adds" id="rule-adds" aria-label="Add a rule"></div>
      </section>

      <section class="rule" data-tab="eights" data-pane="who"><div class="rule-head">Eights <span class="muted" id="eights-pick">Any</span></div>
        <p class="rule-desc">How many 8s are in its seed.</p>
        <div class="tiles eights" data-rule="eights">${Array.from({ length: EIGHTS_MAX + 1 }, (_, n) => `<button type="button" class="tile" data-bit="${n}" aria-pressed="false" title="${eightsChip(n)}">${eightsPips(n)}<span>${EIGHT_NAMES[n]}</span></button>`).join('')}</div>
        <a class="rule-see" data-see="eights" target="_blank" rel="noopener" hidden>See these Credits →</a>
      </section>

      <section class="rule" data-tab="weight" data-pane="who"><div class="rule-head">Weight <span class="muted" id="weights-pick">Any</span></div>
        <p class="rule-desc">How much of it is inked.</p>
        <div class="tiles" data-rule="weights">${WEIGHTS.map((w, i) => `<button type="button" class="tile" data-bit="${i}" aria-pressed="false" title="${w}">${weightGlyph(w)}<span>${w}</span></button>`).join('')}</div>
        <a class="rule-see" data-see="weights" target="_blank" rel="noopener" hidden>See these Credits →</a>
      </section>

      <section class="rule" data-tab="print" data-pane="who"><div class="rule-head">Print <span class="muted" id="prints-pick">Any</span></div>
        <p class="rule-desc">How far its inks slipped.</p>
        <div class="tiles" data-rule="prints">${PRINTS.map((p, i) => `<button type="button" class="tile" data-bit="${i}" aria-pressed="false" title="${p}">${printGlyph(p)}<span>${p}</span></button>`).join('')}</div>
        <a class="rule-see" data-see="prints" target="_blank" rel="noopener" hidden>See these Credits →</a>
      </section>


      <section class="rule" data-tab="palette" data-pane="who"><div class="rule-head">Colors <span class="muted" id="palettes-pick">Any</span></div>
        <p class="rule-desc">Which inks it uses.</p>
        <div class="tiles palettes" data-rule="palettes">${PALETTE_ROWS.flat().map((p) => `<button type="button" class="tile" data-bit="${paletteBit(p)}" aria-pressed="false" title="${p}">${swatch(p)}<span>${p}</span></button>`).join('')}</div>
        <a class="rule-see" data-see="palettes" target="_blank" rel="noopener" hidden>See these Credits →</a>
      </section>

      <section class="rule" data-tab="time" data-pane="who"><div class="rule-head">Payment Time <span id="win-text">Any time</span></div>
        <p class="rule-desc">When it was paid for.</p>
        <div class="timeline">
          <svg id="hist" viewBox="0 0 120 28" preserveAspectRatio="none" aria-hidden="true"></svg>
          <div class="dual"><input type="range" id="win-from" min="0" max="${last}" value="0" aria-label="Window start"><input type="range" id="win-to" min="0" max="${last}" value="${last}" aria-label="Window end"></div>
        </div>
        <div class="win-inputs"><label><span>Start</span><input type="text" id="win-start" autocomplete="off" spellcheck="false" placeholder="2026-09-20 22:15"></label><label><span>End</span><input type="text" id="win-end" autocomplete="off" spellcheck="false" placeholder="2026-09-20 23:15"></label>${zoneToggle()}</div>
        <p class="hint" id="win-count" hidden></p>
        <a class="rule-see" data-see="time" target="_blank" rel="noopener" hidden>See these Credits →</a>
      </section>

      <section class="rule" data-tab="rating" data-pane="who"><div class="rule-head">Rating <span id="score-text">Any</span></div>
        <p class="rule-desc">Jack’s rating, 80 to 800.</p>
        <div class="timeline">
          <svg id="score-hist" viewBox="0 0 72 28" preserveAspectRatio="none" aria-hidden="true"></svg>
          <div class="dual"><input type="range" id="min-score" min="80" max="800" step="0.1" value="80" aria-label="Lowest rating"><input type="range" id="max-score" min="80" max="800" step="0.1" value="800" aria-label="Highest rating"></div>
        </div>
        <div class="axis" id="score-axis">${[80, 200, 400, 600, 800].map((v) => `<button type="button" data-v="${v}" style="left:${((v - 80) / 720) * 100}%" aria-label="Move the nearest handle to ${v}">${v}</button>`).join('')}</div>
        <a class="rule-see" data-see="rating" target="_blank" rel="noopener" hidden>See these Credits →</a>
      </section>

      <section class="rule" data-tab="bits" data-pane="who"><div class="rule-head">Bits <span id="bits-text">Any</span></div>
        <p class="rule-desc">How many marks its plates set, ${BITS_LO} to ${BITS_HI}.</p>
        <div class="timeline">
          <svg id="bits-hist" viewBox="0 0 ${BITS_HI - BITS_LO + 1} 28" preserveAspectRatio="none" aria-hidden="true"></svg>
          <div class="dual"><input type="range" id="min-bits" min="${BITS_LO}" max="${BITS_HI}" step="1" value="${BITS_LO}" aria-label="Fewest Bits"><input type="range" id="max-bits" min="${BITS_LO}" max="${BITS_HI}" step="1" value="${BITS_HI}" aria-label="Most Bits"></div>
        </div>
        <div class="axis" id="bits-axis">${[16, 40, 64, 88, 112, 136, 160].map((v) => `<button type="button" data-v="${v}" style="left:${((v - BITS_LO) / (BITS_HI - BITS_LO)) * 100}%" aria-label="Move the nearest handle to ${v}">${v}</button>`).join('')}</div>
        <a class="rule-see" data-see="bits" target="_blank" rel="noopener" hidden>See these Credits →</a>
      </section>

      <section class="rule" data-tab="numbers" data-pane="who"><div class="rule-head">Token # <span class="muted" id="id-hint">Any</span></div>
        <p class="rule-desc">A range like 1-80, or up to 200 like 1, 4, 5.</p>
        <input id="ids" inputmode="text" placeholder="1-80  or  1, 4, 5, 6" autocomplete="off">
      </section>





      <div class="pay-field" role="radiogroup" aria-label="Payout"><span>Payout</span>
        <div class="pay-opts">${SPLITS.map((l, i) => `<label class="pay-opt"><input type="radio" name="split" value="${i}" ${i === 0 ? 'checked' : ''}><span class="pay-head"><b>${l}</b><span class="num">${PAYOUT_HINTS[i]}</span></span>${payoutChart(i)}</label>`).join('')}</div>
      </div>
      <div class="pay-field end-field" role="radiogroup" aria-label="When it burns"><span>When it burns</span>
        <div class="seg end-opts">
          <label><input type="radio" name="ending" value="auction" checked><span>Auction</span></label>
          <label${tokensOn() ? '' : ' class="soon" title="Coming soon"'}><input type="radio" name="ending" value="tokens"${tokensOn() ? '' : ' disabled'}><span>Tokens${tokensOn() ? '' : ' <em>Soon</em>'}</span></label>
        </div>
        <p class="term-desc muted" id="end-hint">${END_HINTS.auction}</p>
      </div>

      <h2 class="form-title"><span id="dep-title">Deposit Credits</span> <span class="muted num" id="n">Min ${min}</span><button type="button" class="link small" id="all">Select all that fit</button></h2>
      <section class="rule" data-tab="credits" data-pane="always">
        <div class="picker lg" id="picker"><p class="muted">Reading your wallet…</p></div>
        <details class="picker-off" id="picker-off-wrap" hidden><summary class="muted small" id="picker-off-sum"></summary><div class="picker lg" id="picker-off"></div></details>
        <div class="picture-callout" id="picture-callout" hidden><b>Its first Credits for sale</b><span>Each draws one spot. Pick any; one of a Colors brings those ahead of it.</span></div>
        <div class="create-buy" id="create-buy" hidden></div>
      </section>


      <div class="submit">
        <p class="gate-warn" id="warn" hidden></p>
        <button class="btn primary block" id="go" disabled>Start Credit Union</button>
        <p class="hint" id="why"></p>
      </div>
    </form>
  </section>`;

  /// The palette set the contract gets: Colors, narrowed by Plates (how many inks). Plates alone means every
  /// palette with that many inks. The contract has no separate Plates field; this is the same thing.
  const pal = () => rules.palettes;

  // ---------------------------------------------------------------- your Credits' traits (for the live preview)
  const mine = new Map<string, Rated>();
  let traitsIn = false;
  /// Once you pick or unpick a Credit yourself, the page stops picking for you.
  let pickedByHand = false;
  (async () => {
    // Your Credits, once the wallet answers (awaiting it also lets the page finish setting up first).
    let held: readonly bigint[];
    try {
      [held, isOk] = await walletRead;
    } catch {
      const p = document.getElementById('picker');
      if (p) p.innerHTML = '<p class="muted">Couldn’t read your wallet. Refresh to try again.</p>';
      return;
    }
    const picker = document.getElementById('picker');
    if (!picker) return; // left the page
    if (!isOk) void canBatch(); // ask early, so Start doesn't wait on the wallet
    owned.push(...held.filter((id) => !owned.includes(id)));
    picker.innerHTML = owned.length ? owned.map(pickBtn).join('') : `<p class="muted">You don’t hold any Credits.${config.chainId !== 1 ? ' <a href="/mint">Mint test Credits →</a>' : ''}</p>`;
    for (let i = 0; i < owned.length; i += 200) {
      try {
        const r = await ratings(owned.slice(i, i + 200));
        for (const [id, v] of Object.entries(r.ratings)) mine.set(id, v);
      } catch {}
    }
    traitsIn = true;
    refresh();
    void paintFromPicture(); // a picture framed while they were read, with yours in it
  })();

  // ---------------------------------------------------------------- buy Credits that fit, when none of yours do
  // The Credits explorer's Buy row, over the cheapest listings these rules take, without its own button: the Start
  // button buys what's picked there ("Buy 4 and start Credit Union"), then opens the union with them. Not for a
  // named list (its Credits are chosen).
  let buyFor = '';
  let buyer: ReturnType<typeof sweepControls> | null = null;
  const buying = () => (buyer && !document.getElementById('create-buy')!.hidden ? buyer.chosen() : []);
  const listedRules = () => {
    const f = filterOf();
    const all: Record<string, number> = { palettes: f.palettes, prints: f.prints, weights: f.weights, eights: f.eights, paidFrom: Number(f.paidFrom), paidTo: Number(f.paidTo), idFrom: Number(f.idFrom), idTo: Number(f.idTo), minScore: f.minScore, maxScore: f.maxScore, bitsFrom: f.bitsFrom, bitsTo: f.bitsTo };
    return Object.fromEntries(Object.entries(all).filter(([, v]) => v));
  };
  async function drawBuy(fits: number) {
    const el = document.getElementById('create-buy')!;
    if (picturing()) return drawPictureBuy(el);
    if (mazeOn()) return void ((el.hidden = true), (buyer = null));
    if (fits || !traitsIn || rules.list.length || !config.sweeper) {
      el.hidden = true;
      buyFor = '';
      buyer = null;
      return;
    }
    const want = listedRules();
    const key = JSON.stringify(want);
    if (key === buyFor) return;
    buyFor = key;
    const pager = listedPager({ rules: want });
    await pager.fill(8, 3);
    if (buyFor !== key || !el.isConnected) return;
    const ls = pager.sale.ls.slice(0, 8);
    el.hidden = !ls.length;
    if (el.hidden) return;
    const tile = (l: Listing) => creditCell(Number(l.id), priceTag(l));
    el.innerHTML = `<div class="jb"><div class="jb-sweep" id="cb-act"></div>
      <div class="trait-grid" id="cb-grid">${ls.map(tile).join('')}</div></div>`;
    const grid = el.querySelector<HTMLElement>('#cb-grid')!;
    const act = el.querySelector<HTMLElement>('#cb-act')!;
    const sale = { ...pager.sale, ls, all: [...ls] };
    const mine = sweepControls(act, sale, grid, { button: false, onPick: () => refresh() });
    buyer = mine;
    // Live: the cheapest eight again every 20 s, and any you picked stay while they're listed.
    const tick = async () => {
      if (buyFor !== key) return;
      const fresh = listedPager({ rules: want });
      await fresh.fill(8, 3);
      if (buyFor !== key || !grid.isConnected || (!fresh.items.length && !fresh.done)) return;
      const picked = new Set(mine.chosen().map((l) => l.id));
      relist(grid, sale, fresh.sale.ls.filter((l, i) => i < 8 || picked.has(l.id)), tile, mine);
    };
    live(grid, tick);
  }
  /// A picture: its first Credits for sale, in the order they go in (only these can start it), when none of yours are.
  async function drawPictureBuy(el: HTMLElement) {
    if (!config.sweeper) {
      el.hidden = true;
      buyFor = '';
      buyer = null;
      return;
    }
    const key = `picture:${picSeq}`;
    if (key === buyFor) return;
    buyFor = key;
    // The market read can be minutes old: a planned Credit that's no longer for sale leaves the plan, and its slot
    // takes the next best, until the first eight are all really for sale.
    let ls: Listing[] = [];
    for (let tries = 0; tries < 5; tries++) {
      const want = bySlot([...picPlan!.buy]).slice(0, 8);
      ls = await listedById(want);
      if (buyFor !== key || !el.isConnected) return;
      const sold = want.filter((id) => !ls.some((l) => l.id === id));
      if (!sold.length) break;
      sold.forEach((id) => picGone.add(Number(id)));
      picPlan = planOf(guide!.fillYoursFirst(layout, layout.map(() => null), picGone), layout);
    }
    ls = bySlot(ls.map((l) => l.id)).map((id) => ls.find((l) => l.id === id)!);
    drawPreview(owned.filter(qualifies));
    el.hidden = !ls.length;
    if (!ls.length) return;
    const tile = (l: Listing) => creditCell(Number(l.id), priceTag(l));
    el.innerHTML = `<div class="jb"><div class="jb-sweep" id="cb-act"></div>
      <div class="trait-grid" id="cb-grid">${ls.map(tile).join('')}</div></div>`;
    const sale: Sale = { ls, all: [...ls], byId: new Map(ls.map((l) => [l.id, l])), mine: new Set(), preview: false };
    // A Colors' Credits go in from its first open slot (yours first): picking one brings those ahead of it.
    const along = (id: string, picking: boolean) => {
      const r = runOf(picPlan!, id, new Set(ls.map((l) => l.id)));
      return picking ? r.ahead : r.behind;
    };
    buyer = sweepControls(el.querySelector<HTMLElement>('#cb-act')!, sale, el.querySelector<HTMLElement>('#cb-grid')!, { button: false, onPick: () => refresh(), along });
  }
  /// Bought here: into the picker, picked.
  async function gotCredits(ids: string[]) {
    const fresh = ids.map(BigInt).filter((id) => !owned.includes(id));
    if (!fresh.length) return;
    try {
      const r = await ratings(fresh);
      for (const [id, v] of Object.entries(r.ratings)) mine.set(id, v);
    } catch {}
    const picker = document.getElementById('picker')!;
    if (!owned.length) picker.innerHTML = '';
    owned.push(...fresh);
    picker.insertAdjacentHTML('beforeend', fresh.map(pickBtn).join(''));
    for (const id of fresh) picks.add(id.toString());
    buyFor = '';
    refresh();
  }

  const qualifies = (id: bigint) => {
    const r = mine.get(id.toString());
    if (rules.list.length && !rules.list.includes(Number(id))) return false;
    if (rules.idFrom && Number(id) < rules.idFrom) return false;
    if (rules.idTo && Number(id) > rules.idTo) return false;
    const sc = r ? (isLiveTable(table) ? liveTenths(r) : r.rule) : 0;
    if (rules.minScore && (!r || sc < rules.minScore)) return false;
    if (rules.maxScore && (!r || sc > rules.maxScore)) return false;
    if (rules.bitsFrom && (!r || r.traits.activeBits < rules.bitsFrom)) return false;
    if (rules.bitsTo && (!r || r.traits.activeBits > rules.bitsTo)) return false;
    if (!r) return !pal() && !rules.prints && !rules.weights && !rules.eights && rules.minuteFrom < 0 && rules.minuteTo < 0;
    if (pal() && !(pal() & (1 << paletteBit(r.traits.palette)))) return false;
    if (rules.prints && !(rules.prints & (1 << PRINTS.indexOf(r.traits.registration as (typeof PRINTS)[number])))) return false;
    if (rules.weights && !(rules.weights & (1 << WEIGHTS.indexOf(weightOf(r) as (typeof WEIGHTS)[number])))) return false;
    if (rules.eights && !(rules.eights & (1 << r.traits.eights))) return false;
    if (rules.minuteFrom >= 0 && r.paidAt < minutes[rules.minuteFrom][0]) return false;
    if (rules.minuteTo >= 0 && r.paidAt > minutes[rules.minuteTo][0] + 59) return false;
    return true;
  };

  /// A Credit's value of the painted trait, as Batch._keyOf reads it (0 while its traits are unknown).
  const keyOfMine = (id: string) => {
    const r = mine.get(id);
    if (!r) return 0;
    if (layoutTrait === 0) return paletteBit(r.traits.palette);
    if (layoutTrait === 1) return Math.min(14, r.traits.eights) + 1;
    if (layoutTrait === 2) return PRINTS.indexOf(r.traits.registration as (typeof PRINTS)[number]) + 1;
    if (layoutTrait === 3) return WEIGHTS.indexOf(weightOf(r) as (typeof WEIGHTS)[number]) + 1;
    return r.traits.palette.length;
  };
  /// Room on the sheet for your opening Credits: 80, and on a painted sheet only so many of each value (plus the
  /// open slots), as the batch books them. Picking past that reverts the open with NoSlot.
  const sheetBooks = () => (layout.some(Boolean) ? booksOf(layoutTrait, layout) : null);
  const capacity = () => new Room(sheetBooks(), 80);

  // ---------------------------------------------------------------- live preview + counts
  const go = document.getElementById('go') as HTMLButtonElement;
  const why = document.getElementById('why')!;
  let editionTimer = 0;
  let editionSeq = 0;
  let eligible = -1; // how many edition Credits pass the rules; under 80 the party can never fill

  const describe = () => {
    const parts: string[] = [];
    if (rules.palettes) parts.push(`Colors ${TRAITS.colors.filter((p) => rules.palettes & (1 << paletteBit(p))).join(', ')}`);
    if (rules.prints) parts.push(`Print ${PRINTS.filter((_, i) => rules.prints & (1 << i)).join(', ')}`);
    if (rules.weights) parts.push(`Weight ${WEIGHTS.filter((_, i) => rules.weights & (1 << i)).join(', ')}`);
    if (rules.eights) parts.push(`Eights ${Array.from({ length: EIGHTS_MAX + 1 }, (_, n) => n).filter((n) => rules.eights & (1 << n)).join(', ')}`);
    if (rules.minuteFrom >= 0 || rules.minuteTo >= 0) parts.push(document.getElementById('win-text')!.textContent!.replace(/^/, 'Paid '));
    if (rules.minScore || rules.maxScore) parts.push(`Rating ${scoreLabel()}`);
    if (rules.bitsFrom || rules.bitsTo) parts.push(`Bits ${bitsLabel()}`);
    if (rules.idFrom || rules.idTo) parts.push(rules.idFrom && rules.idTo ? `#${rules.idFrom}–${rules.idTo}` : rules.idFrom ? `#${rules.idFrom}+` : `up to #${rules.idTo}`);
    if (rules.list.length) parts.push(`${rules.list.length} picked`);
    return parts.length ? parts.join(' · ') : 'Any Credit';
  };

  /// The Name field's placeholder: until you type one, it suggests a name from what you've set.
  function drawSummary() {
    const who = describe();
    // A picture's union is named for the picture until you name it.
    const fromPicture = pic?.ready() && app.querySelector<HTMLInputElement>('input[name=arr]:checked')?.value === String(PICTURE) ? pictureName(pic.label()) : '';
    (document.getElementById('name') as HTMLInputElement).placeholder = fromPicture || (who === 'Any Credit' ? 'All Credits' : who.split(' · ')[0]);
  }

  /// A file name as a union's name: "sunset_beach" → "sunset beach"; one that's mostly a timestamp or camera number
  /// ("IMG_4032", "ChatGPT Image Sep 29, 2026, 08_17_51 AM") → "Picture".
  const pictureName = (file: string) => {
    const n = file.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
    return !n || (n.match(/\d/g) ?? []).length > 3 ? 'Picture' : n.slice(0, 64);
  };
  /// The button says what it does: how many of your Credits go in.
  const startLabel = () => {
    if (mazeOn()) return 'Maze unions coming soon'; // buying all 80 at once isn't ready yet: the preview is there to play with
    const b = buying().length;
    if (b && picks.size) return `Buy ${b} and start with ${picks.size + b} Credits`;
    if (b) return `Buy ${b} and start Credit Union`;
    return picks.size ? `Start Credit Union with ${picks.size} ${picks.size === 1 ? 'Credit' : 'Credits'}` : 'Start Credit Union';
  };
  /// Each rule with a value set links to those Credits in the explorer.
  function drawSee() {
    const href: Record<string, string> = {
      palettes: rules.palettes ? setPath('palette', rules.palettes) : '',
      eights: rules.eights ? setPath('eights', rules.eights) : '',
      prints: rules.prints ? setPath('print', rules.prints) : '',
      weights: rules.weights ? setPath('weight', rules.weights) : '',
      time: minutes.length && (rules.minuteFrom >= 0 || rules.minuteTo >= 0) ? timePath(minutes[Math.max(0, rules.minuteFrom)][0], minutes[rules.minuteTo >= 0 ? rules.minuteTo : last][0] + 59) : '',
      rating: rules.minScore || rules.maxScore ? ratingPath(rules.minScore, rules.maxScore) : '',
      bits: rules.bitsFrom || rules.bitsTo ? bitsPath(rules.bitsFrom, rules.bitsTo) : '',
    };
    app.querySelectorAll<HTMLAnchorElement>('.rule-see').forEach((a) => {
      const h = href[a.dataset.see!];
      a.hidden = !h;
      if (h) a.href = h;
    });
  }

  /// The rules as the factory takes them (Batch.Filter). A picture keeps only its Colors and layout.
  function filterOf() {
    const pic = app.querySelector<HTMLInputElement>('input[name=arr]:checked')?.value === String(PICTURE);
    if (pic) return { palettes: pal(), prints: 0, weights: 0, eights: 0, paidFrom: 0n, paidTo: 0n, idFrom: 0n, idTo: 0n, minScore: 0, maxScore: 0, layout0: layout.slice(0, 64).reduce((acc, m, i) => acc | (BigInt(m) << BigInt(4 * i)), 0n), layout1: layout.slice(64).reduce((acc, m, i) => acc | (BigInt(m) << BigInt(4 * i)), 0n), bitsFrom: 0, bitsTo: 0, layoutTrait: layout.some(Boolean) ? layoutTrait : 0 };
    return {
      palettes: pal(),
      prints: rules.prints,
      weights: rules.weights,
      eights: rules.eights,
      paidFrom: BigInt(rules.minuteFrom >= 0 ? minutes[rules.minuteFrom][0] : 0),
      paidTo: BigInt(rules.minuteTo >= 0 ? minutes[rules.minuteTo][0] + 59 : 0),
      idFrom: BigInt(rules.idFrom),
      idTo: BigInt(rules.idTo),
      minScore: rules.minScore,
      maxScore: rules.maxScore,
      layout0: layout.slice(0, 64).reduce((acc, m, i) => acc | (BigInt(m) << BigInt(4 * i)), 0n),
      layout1: layout.slice(64).reduce((acc, m, i) => acc | (BigInt(m) << BigInt(4 * i)), 0n),
      bitsFrom: rules.bitsFrom,
      bitsTo: rules.bitsTo,
      layoutTrait: layout.some(Boolean) ? layoutTrait : 0,
    };
  }
  function refresh() {
    if (panesReady) applyPanes();
    drawSee();
    // A picture takes only its own Credits: yours that are next in their Colors, and any bought here for it.
    const fit = owned.filter((id) => qualifies(id) && (!picturing() || picPlan!.mine.has(id.toString()) || picPlan!.buy.has(id.toString())));
    // A picture: yours that draw its first spots well, and its first Credits for sale beside them; with none of
    // yours, buying is how it starts (bought ones go in, picked, unseen).
    const buyOnly = picturing() && buyToStart && !picPlan!.mine.size;
    for (const id of ['picker', 'n']) document.getElementById(id)!.hidden = buyOnly;
    document.getElementById('picture-callout')!.hidden = !(picturing() && buyToStart);
    document.getElementById('dep-title')!.textContent = buyOnly ? 'Buy to start' : picturing() ? 'Yours that draw it' : 'Deposit Credits';
    for (const id of [...picks]) if (!fit.some((f) => f.toString() === id)) picks.delete(id);
    // Until you pick yourself, the least it takes to start is picked for you (Min 1: one of yours that fits), so
    // Start is ready as soon as the rules are; picked again if the rules change under it.
    if (!pickedByHand && !picks.size && traitsIn && !picturing()) {
      const take = capacity();
      for (const id of fit) {
        if (picks.size >= min) break;
        if (take.take(keyOfMine(id.toString()))) picks.add(id.toString());
      }
    }
    // Keep the picks the sheet has room for, in the order picked; the rest of a value grey out once it's full.
    const room = capacity();
    for (const id of [...picks]) if (!room.take(keyOfMine(id))) picks.delete(id);
    const bk = sheetBooks();
    drawPreview(fit);
    // Credits that fit the rules stay in the picker; the rest fold away underneath, in the same order.
    const on = document.getElementById('picker')!, offBox = document.getElementById('picker-off')!;
    const fitSet = new Set(fit.map(String));
    let offCount = 0;
    for (const id of owned) {
      const p = app.querySelector<HTMLButtonElement>(`.pick[data-id="${id}"]`);
      if (!p) continue;
      const ok = fitSet.has(id.toString());
      if (!ok) offCount++;
      p.classList.toggle('off', !ok);
      const full = ok && !picks.has(id.toString()) && !room.fits(keyOfMine(id.toString()));
      p.classList.toggle('full', full);
      p.title = full ? (room.n >= 80 ? 'A Credit Union holds 80' : bk ? noRoomReason(bk, keyOfMine(id.toString()), true) : '') : `Credit #${id}`;
      p.setAttribute('aria-pressed', String(picks.has(p.dataset.id!)));
      (ok ? on : offBox).append(p);
    }
    if (owned.length) {

      const wrap = document.getElementById('picker-off-wrap')!;
      wrap.hidden = offCount === 0 || buyOnly;
      document.getElementById('picker-off-sum')!.textContent = fit.length
        ? picturing()
          ? (() => {
              const later = owned.filter((id) => picPlan!.slot.has(id.toString()) && !picPlan!.mine.has(id.toString())).length;
              const loose = offCount - later;
              return [later ? `${later} more of yours fit spots that open later` : '', loose ? `${loose} ${loose === 1 ? 'isn’t a close match' : 'aren’t close matches'}` : ''].filter(Boolean).join(' · ');
            })()
          : `You also have ${offCount} ${offCount === 1 ? 'Credit' : 'Credits'} that don’t fit these rules`
        : picturing()
          ? `None of your ${offCount === 1 ? 'Credit draws' : `${offCount} Credits draw`} its first spots closely enough: buy its first Credits below to start it`
          : `None of your ${offCount === 1 ? 'Credit fits' : `${offCount} Credits fit`} these rules`;
    }
    document.getElementById('n')!.textContent = picks.size ? `${picks.size} selected` : `Min ${min}`;
    document.getElementById('all')!.hidden = !fit.length || buyOnly;
    void drawBuy(fit.length);
    const n = picks.size + buying().length; // Credits being bought here count toward the minimum
    const over = overPainted();
    // The contract refuses rules that can never admit 80.
    const tooNarrow = rules.list.length && rules.list.length < 80 ? 'A named list needs at least 80 Credits.'
      : rules.idTo && rules.idTo - rules.idFrom + 1 < 80 ? 'A number range needs at least 80 numbers.' : '';
    const short = eligible >= 0 && eligible < 80 ? `Only ${eligible} ${eligible === 1 ? 'Credit' : 'Credits'} can ever join, and a Credit Union needs 80. Widen the rules.` : '';
    // A picture: none of its Colors may skip a slot.
    const gap = picturing() ? gapOf(picPlan!, [...picks, ...buying().map((l) => l.id)]) : null;
    const reason = mazeOn() ? (maze ? '' : 'Making a maze…') : tooNarrow || short || (gap ? `Add #${gap} too: it goes in before the ones you picked.` : '') || (n < min && traitsIn ? (picturing() ? (picPlan!.mine.size ? 'Pick one of yours, or buy one of its first Credits.' : 'Buy at least one of the picture’s first Credits to start it.') : `Select at least ${min} of your qualifying Credits.`) : n > 80 ? 'At most 80.' : over ? overText(over) : '');
    // One line under the button: what blocks it, else how it plays out.
    // What blocks Start sits above it as a warning; the line under it always says how it plays out.
    const warn = document.getElementById('warn')!;
    warn.textContent = reason;
    warn.hidden = !reason;
    why.innerHTML = `${n > CHUNK ? `${Math.ceil(n / CHUNK)} transactions. ` : ''}Free to start a Credit Union. ${picturing() && buyToStart ? 'Yours can come back out while you’re its only member.' : 'Withdraw your Credits anytime until it fills and locks.'}<br>${factoryIn ? `${protocolBps / 100}% protocol fee, only if it sells. ` : ''}Unofficial and experimental.`;
    go.disabled = !!reason || !traitsIn || !factoryIn || mazeOn(); // your Credits and their traits are in (traitsIn), and the factory's numbers
    if (!go.dataset.busy) go.textContent = startLabel();
    drawSummary();

    clearTimeout(editionTimer);
    editionTimer = window.setTimeout(async () => {
      const seq = ++editionSeq;
      const el = document.getElementById('st-edition');
      if (!el) return; // left the page
      try {
        const r = await fetch('/edition/match', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            palettes: pal(),
            prints: rules.prints,
            weights: rules.weights,
            eights: rules.eights,
            minuteFrom: rules.minuteFrom,
            minuteTo: rules.minuteTo,
            idFrom: rules.idFrom,
            idTo: rules.idTo,
            minScore: rules.minScore,
            maxScore: rules.maxScore,
            bitsFrom: rules.bitsFrom,
            bitsTo: rules.bitsTo,
            list: rules.list.slice(0, 200),
          }),
        });
        const d = (await r.json()) as { total?: number; count?: number; sample?: number[]; palettes?: number[]; traits?: number[] };
        if (seq !== editionSeq) return;
        if (typeof d.count === 'number') {
          el.textContent = d.count.toLocaleString();
          el.closest('.join-count')!.classList.toggle('short', d.count < 80);
          // Re-run the checks when the count changes (the next fetch returns the same count, so this settles).
          if (eligible !== d.count) {
            eligible = d.count;
            refresh();
          }
          // With no rules it's the whole edition; with rules, how many Credits pass them.
          document.getElementById('st-edition-label')!.textContent = '→';
        }
        ghosts = (d.sample ?? []).map((id, i) => ({ id: BigInt(id), palette: d.palettes?.[i] ?? 0, t: d.traits?.[i] ?? 0 }));
        // A painted sheet needs samples of each painted value, not just whatever the overall sample holds: ask for
        // each value on its own (the party's rules narrowed to that value), so every painted slot has a Credit.
        keyGhosts = new Map();
        keySupply = new Map();
        const keys = [...new Set(layout.filter(Boolean))];
        if (keys.length) {
          const base = { palettes: pal(), prints: rules.prints, weights: rules.weights, eights: rules.eights, minuteFrom: rules.minuteFrom, minuteTo: rules.minuteTo, idFrom: rules.idFrom, idTo: rules.idTo, minScore: rules.minScore, maxScore: rules.maxScore, bitsFrom: rules.bitsFrom, bitsTo: rules.bitsTo, list: rules.list.slice(0, 200) };
          await Promise.all(
            keys.map(async (k) => {
              const narrow = ruleFor(layoutTrait, k);
              const both = (a: number, b?: number) => (b === undefined ? a : a ? a & b : b);
              const body = { ...base, palettes: both(base.palettes, narrow.palettes), eights: both(base.eights, narrow.eights), prints: both(base.prints, narrow.prints), weights: both(base.weights, narrow.weights) };
              const res = await fetch('/edition/match', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
              const e = (await res.json()) as { count?: number; sample?: number[]; palettes?: number[]; traits?: number[] };
              if (typeof e.count === 'number') keySupply.set(k, e.count);
              keyGhosts.set(k, (e.sample ?? []).map((id, i) => ({ id: BigInt(id), palette: e.palettes?.[i] ?? 0, t: e.traits?.[i] ?? 0 })));
            }),
          ).catch(() => {});
          if (seq !== editionSeq) return;
          const o = overPainted();
          if (o) {
            why.textContent = overText(o);
            go.disabled = true;
          }
        }
        if (!el.isConnected) return;
        drawPreview(owned.filter(qualifies));
      } catch {
        if (seq === editionSeq && el.isConnected) el.textContent = '–';
      }
    }, 200);
  }

  // ---------------------------------------------------------------- trait tiles (tap to pick, tap again to clear)
  /// Your qualifying Credits solid, then real matching Credits from the edition, faded, up to 80.
  /// The checkered design alternates the two palettes so the pattern is visible before anyone joins.
  /// A picture's sheet as it stands: yours where the contract will put them, Credits picked to buy in the slots
  /// they'll land in, and in every other slot the Credit that draws it best.
  function pictureSlots(fit: bigint[]) {
    const order = [...picks].filter((id) => fit.some((f) => f.toString() === id)).map(BigInt);
    const placed = placeOnLayout(layout, order, (id) => keyOfMine(id.toString()));
    const toBuy = buying().map((l) => l.id).filter((id) => picPlan?.slot.has(id));
    for (const id of toBuy) placed[picPlan!.slot.get(id)!] ??= BigInt(id);
    const rec = guide!.fillYoursFirst(layout, placed.map((x) => (x === null ? null : Number(x))), picGone);
    return { order, placed, toBuy, rec, ids: placed.map((x, i) => (x !== null ? Number(x) : (rec[i]?.id ?? null))) };
  }
  function drawPreview(fit: bigint[]) {
    if (mazeOn()) {
      document.getElementById('preview')!.innerHTML = sheet([], { mine: new Set(), ghosts: (maze?.ids ?? []).map((id) => ({ id: BigInt(id), src: artOf(BigInt(id)) })) });
      mountDirections(app);
      return;
    }
    // A picture: yours where the contract will put them (each Colors' slots in the order they go in), and in every
    // other slot the Credit that draws it best, as the union page will recommend it.
    if (guide && layout.some(Boolean) && app.querySelector<HTMLInputElement>('input[name=arr]:checked')?.value === String(PICTURE) && view === 'credits') {
      const { order, placed, toBuy, rec } = pictureSlots(fit);
      // The whole picture at full ink, with what's going in framed: yours, and the ones you're buying.
      app.querySelector('.design-preview')!.classList.add('solid-ghosts');
      document.getElementById('preview')!.innerHTML = sheet(order, { mine: new Set([...picks, ...toBuy]), placed, slotGhosts: rec.map((c) => (c ? { id: BigInt(c.id), src: artOf(BigInt(c.id)) } : null)) });
      const going = new Set([...order.map(String), ...toBuy]);
      document.querySelectorAll<HTMLElement>('#preview .cell[data-id]').forEach((c) => c.classList.toggle('chosen', going.has(c.dataset.id!)));
      mountDirections(app);
      return;
    }
    // A Wave shows at full ink, as it will print, until you pick Credits yourself; then the rest fade.
    const arrV = Number(app.querySelector<HTMLInputElement>('input[name=arr]:checked')?.value);
    if (DESIGNED.has(arrV)) app.querySelector('.design-preview')!.classList.toggle('solid-ghosts', !pickedByHand);
    // Only the Credits you've selected go in solid; the rest of yours read like any other possible match.
    const mineIds = fit.filter((id) => picks.has(id.toString())).slice(0, 80);
    const mineSet = new Set(mineIds.map(String));
    let rest = ghosts.filter((g) => !mineSet.has(g.id.toString()));
    const painted = layout.some(Boolean);
    if (painted) {
      const pools = new Map<number, typeof rest>();
      const k = (g: (typeof rest)[number]) => keyOf(layoutTrait, g.t);
      for (const g of rest) pools.set(k(g), [...(pools.get(k(g)) ?? []), g]);
      // Top each painted value's pool up from its own samples, skipping any already on the sheet.
      const seen = new Set([...mineSet, ...rest.map((g) => g.id.toString())]);
      for (const [key, list] of keyGhosts) {
        const extra = list.filter((g) => !seen.has(g.id.toString()));
        extra.forEach((g) => seen.add(g.id.toString()));
        pools.set(key, [...(pools.get(key) ?? []), ...extra]);
      }
      const out: typeof rest = [];
      const leftovers = () => [...pools.values()].flat();
      // A value asked for in more slots than it has samples shows its samples again, so no painted slot is blank.
      const again = new Map([...pools].map(([key, list]) => [key, [...list]]));
      const reused = new Map<number, number>();
      const repeat = (want: number) => {
        const list = again.get(want);
        if (!list?.length) return undefined;
        const n = reused.get(want) ?? 0;
        reused.set(want, n + 1);
        return list[n % list.length];
      };
      for (let i = mineIds.length; i < 80; i++) {
        const want = layout[i];
        const g = want ? (pools.get(want)?.shift() ?? repeat(want)) : leftovers().shift();
        // No sample for this palette at all: keep the slot empty (its paint still shows) rather than stop.
        if (!g) {
          out.push({ id: 0n, palette: 0, t: 0 });
          continue;
        }
        if (!want) pools.set(k(g), (pools.get(k(g)) ?? []).filter((x) => x !== g));
        out.push(g);
      }
      rest = out;
    } else if (pattern === 'checkered') {
      const bits = TRAITS.colors.map(paletteBit).filter((b) => rules.palettes & (1 << b));
      const pools = bits.map((b) => rest.filter((g) => g.palette === b));
      const out: typeof rest = [];
      for (let i = 0; out.length < 80 - mineIds.length; i++) {
        const row = Math.floor(i / 8), col = i % 8;
        const pool = pools[(row + col) % Math.max(1, pools.length)];
        const g = pool?.shift();
        if (!g) break;
        out.push(g);
      }
      rest = out;
    }
    // Two views of the same sheet: Rules shows what each slot takes (its paint's icon, or nothing when any Credit
    // fits); Credits shows real Credits that would fill it.
    const preview = document.getElementById('preview')!;
    if (view === 'rules') {
      preview.innerHTML = `<div class="sheet lg rules-sheet">${layout.map((v) => `<i class="cell rule-cell" data-v="${v}">${v ? glyphFor(layoutTrait, v) : ''}</i>`).join('')}</div>`;
      return;
    }
    preview.innerHTML = sheet(mineIds, {
      mine: picks,
      ghosts: rest.slice(0, 80 - mineIds.length).map((g) => ({ id: g.id, src: g.id ? artOf(g.id) : '' })),
    });
    mountDirections(app);
  }
  function setView(v: 'rules' | 'credits') {
    view = v;
    app.querySelector<HTMLInputElement>(`input[name=view][value=${v}]`)!.checked = true;
    rulesView(app.querySelector<HTMLElement>('.dirs'), v === 'rules');
    drawPreview(owned.filter(qualifies));
  }

  const SET_KEYS = ['palettes', 'prints', 'weights', 'eights'] as const;
  const labelsFor = (key: (typeof SET_KEYS)[number]) => {
    const m = rules[key];
    if (!m) return 'Any';
    if (key === 'palettes') return TRAITS.colors.filter((p) => m & (1 << paletteBit(p))).join(', ');
    if (key === 'prints') return PRINTS.filter((_, i) => m & (1 << i)).join(', ');
    if (key === 'weights') return WEIGHTS.filter((_, i) => m & (1 << i)).join(', ');
    return Array.from({ length: EIGHTS_MAX + 1 }, (_, n) => n).filter((n) => m & (1 << n)).map(eightsChip).join(', ');
  };
  const syncTiles = () => {
    for (const key of SET_KEYS) {
      app.querySelectorAll<HTMLElement>(`[data-rule="${key}"] [data-bit]`).forEach((b) => b.setAttribute('aria-pressed', String(!!(rules[key] & (1 << Number(b.dataset.bit))))));
      document.getElementById(`${key}-pick`)!.textContent = labelsFor(key);
    }
  };
  // ---------------------------------------------------------------- the layout painter
  const lgrid = document.getElementById('lgrid')!;
  const cells = [...lgrid.querySelectorAll<HTMLButtonElement>('.lcell')];
  const arrRadios = [...app.querySelectorAll<HTMLInputElement>('input[name=arr]')];
  const paintCell = (i: number) => {
    const m = layout[i];
    cells[i].innerHTML = slotMark(layoutTrait, m);
    cells[i].classList.toggle('on', !!m);
  };
  /// A painted sheet is a Colors, Eights, Print, Weight or Plates layout (one trait per sheet: each Credit has one
  /// value of each, which keeps every sheet fillable). With Colors and none picked, a fully painted sheet admits
  /// exactly its Colors.
  const syncLayout = () => {
    const painted = layout.some(Boolean);
    const anyOpen = layout.some((m) => !m);
    if (layoutTrait === 0) {
      const used = layout.reduce((s, m) => (m ? s | (1 << m) : s), 0);
      rules.palettes = picked || (painted && !anyOpen ? used : 0);
    } else rules.palettes = picked;
    pattern = 'none';
    syncTiles();
    refresh();
  };
  const paint = (i: number, m: number) => {
    if (layout[i] === m) return;
    const have = m ? keySupply.get(m) : undefined;
    if (have !== undefined && layout.filter((x) => x === m).length >= have) {
      if (!capWarned) toast(`Only ${have.toLocaleString()} ${have === 1 ? 'Credit fits' : 'Credits fit'} ${slotName(layoutTrait, m)}.`, 'info', 3000);
      capWarned = true;
      return;
    }
    layout[i] = m;
    paintCell(i);
  };
  /// Paint one slot of the preview sheet with the current brush, marking it at once (the sheet redraws on release).
  const paintSheet = (i: number) => {
    paint(i, brush);
    const cell = document.querySelector('#preview .sheet')?.children[i];
    if (cell && view === 'rules') (cell as HTMLElement).innerHTML = layout[i] ? glyphFor(layoutTrait, layout[i]) : '';
  };
  let brush = brushA;
  let designAdded = 0; // Colors a design put on Who can join (not ones you picked yourself)
  let capWarned = false; // one toast per stroke
  let picked = 0; // Colors chosen on the tiles (palette bits)

  // Brushes come from the rules you added: each paintable rule is a group of its picked values (all of them when
  // none are picked). With no paintable rule added, Colors are offered. One trait per sheet.
  const PAINTABLE: [string, LayoutTrait][] = [['palette', 0], ['eights', 1], ['print', 2], ['weight', 3]];
  const valuesOf = (t: LayoutTrait): number[] => {
    if (t === 0) {
      // Every Colors value is a brush, unless you picked Colors yourself. What the sheet uses becomes the rule
      // (syncLayout), so the brushes don't narrow as you paint.
      const set = picked;
      return PALETTE_ROWS.flat().map(paletteBit).filter((m) => !set || set & (1 << m));
    }
    if (t === 1) return Array.from({ length: EIGHTS_MAX + 1 }, (_, n) => n).filter((n) => !rules.eights || rules.eights & (1 << n)).map((n) => n + 1);
    if (t === 2) return PRINTS.map((_, i) => i).filter((i) => !rules.prints || rules.prints & (1 << i)).map((i) => i + 1);
    if (t === 3) return WEIGHTS.map((_, i) => i).filter((i) => !rules.weights || rules.weights & (1 << i)).map((i) => i + 1);
    return [1, 2, 3, 4];
  };
  const glyphFor = (t: LayoutTrait, v: number) =>
    t === 0 ? swatch(slotName(0, v)) : t === 1 ? `<b class="n">${v - 1}×8</b>` : t === 2 ? printGlyph(PRINTS[v - 1]) : t === 3 ? weightGlyph(WEIGHTS[v - 1]) : platesGlyph(v);
  const groups = () => {
    const set = isSet();
    // Colors always (every value a brush); Eights, Print and Weight once you've added them above.
    return PAINTABLE.filter(([k, t]) => (t === 0 || set[k]) && valuesOf(t).length);
  };
  /// Once a sheet has paint, it's that trait's sheet: the other traits' brushes wait until it's cleared.
  const locked = (t: number) => t !== layoutTrait && layout.some(Boolean);
  function drawBrushes() {
    const gs = groups();
    // Paint left in a trait you no longer paint with, or in values you took off its rule, is wiped.
    const allowed = gs.some(([, t]) => t === layoutTrait) ? new Set(valuesOf(layoutTrait)) : new Set<number>();
    let wiped = false;
    layout.forEach((m, i) => {
      if (m && !allowed.has(m)) {
        layout[i] = 0;
        paintCell(i);
        wiped = true;
      }
    });
    if (!gs.some(([, t]) => t === layoutTrait)) layoutTrait = gs[0][1];
    if (brush && !valuesOf(layoutTrait).includes(brush)) brush = valuesOf(layoutTrait)[0] ?? 0;
    // One row per trait you picked; erase leads the first row.
    // One category at a time: pick it, then its brushes. A sheet paints with one trait, so the choice is explicit.
    const withSeg = gs.length > 1
      ? `<div class="paint-with"><span class="eyebrow">Paint with</span><div class="seg sm">${gs.map(([, t]) => `<label><input type="radio" name="paint-with" value="${t}" ${t === layoutTrait ? 'checked' : ''}><span>${LAYOUT_TRAITS[t]}</span></label>`).join('')}</div>${layout.some(Boolean) ? '<span class="muted small">Switching clears the sheet.</span>' : ''}</div>`
      : ''; // one trait to paint with: the hint above already says so
    document.getElementById('brushes')!.innerHTML =
      withSeg +
      `<div class="paint-swatches"><span class="brush-group">${valuesOf(layoutTrait)
        .map((v) => `<button type="button" class="brush" data-trait="${layoutTrait}" data-v="${v}" title="${slotName(layoutTrait, v)}" aria-label="${slotName(layoutTrait, v)}" aria-pressed="${v === brush}">${glyphFor(layoutTrait, v)}</button>`)
        .join('')}</span><span class="paint-actions"><button type="button" class="link small" data-shuffle>Shuffle</button><button type="button" class="link small clear-all" data-layout="Clear">Clear all</button></span></div>`;
    if (wiped) syncLayout();
  }
  /// A random design in two values that go together: the designs' own Colors pairs (any two brushes when Colors are
  /// narrowed, or another trait is painted). Picking Painted starts with one; Shuffle deals another.
  let lastDesign = '';
  function shuffleDesign() {
    const vals = valuesOf(layoutTrait);
    const pick = <T,>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)];
    const name = pick(DESIGNS.map(([n]) => n).filter((n) => n !== lastDesign));
    const pairs = DESIGNS.map(([, a, b]) => [a, b]).filter(([a, b]) => layoutTrait === 0 && vals.includes(a) && vals.includes(b));
    let [A, B] = pairs.length ? pick(pairs) : [pick(vals) ?? 0, 0];
    if (!pairs.length && vals.length > 1) B = pick(vals.filter((v) => v !== A));
    if (B && Math.random() < 0.5) [A, B] = [B, A]; // either way round
    lastDesign = name;
    const fn = LAYOUTS[name];
    for (let i = 0; i < 80; i++) {
      const v = fn(i);
      layout[i] = v === 'A' ? A : v === 'B' ? B : 0;
      paintCell(i);
    }
    brush = brushA = A;
    brushB = B;
    drawBrushes();
    syncLayout();
  }
  let painting = false;
  lgrid.addEventListener('pointerdown', (e) => {
    capWarned = false;
    const c = (e.target as HTMLElement).closest<HTMLButtonElement>('.lcell');
    if (!c) return;
    painting = true;
    lgrid.setPointerCapture(e.pointerId);
    paint(Number(c.dataset.i), brush);
  });
  lgrid.addEventListener('pointermove', (e) => {
    if (!painting) return;
    const el = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLButtonElement>('.lcell');
    if (el) paint(Number(el.dataset.i), brush);
  });
  const endPaint = () => {
    if (!painting) return;
    painting = false;
    syncLayout();
  };
  lgrid.addEventListener('pointerup', endPaint);
  lgrid.addEventListener('pointercancel', endPaint);
  document.getElementById('brushes')!.addEventListener('change', (e) => {
    const r = (e.target as HTMLElement).closest<HTMLInputElement>('input[name=paint-with]');
    if (!r) return;
    const t = Number(r.value) as LayoutTrait;
    if (t === layoutTrait) return;
    if (layout.some(Boolean)) {
      layout.fill(0);
      layout.forEach((_, i) => paintCell(i));
    }
    layoutTrait = t;
    brush = valuesOf(t)[0] ?? 0;
    brushA = brush;
    brushB = 0;
    drawBrushes();
    syncLayout();
  });
  document.getElementById('paint-block')!.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).closest('[data-shuffle]')) return shuffleDesign();
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-v]');
    if (!b) return;
    const t = Number(b.dataset.trait) as LayoutTrait, v = Number(b.dataset.v);
    if (t !== layoutTrait) {
      // One trait per sheet: with paint down, switching would wipe it, so say how instead.
      if (layout.some(Boolean)) return toast(`A sheet paints with one trait. Clear all to paint with ${LAYOUT_TRAITS[t]} instead.`, 'info', 4000);
      layoutTrait = t;
      brushB = 0;
    } else if (v !== brush && brush) brushB = brush; // remember the previous value for two-tone patterns
    brush = v;
    if (v) brushA = v;
    drawBrushes();
    syncLayout();
  });
  document.getElementById('paint-block')!.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-layout]');
    if (!b) return;
    // Clear all also takes off the Colors a design added, so you're back to the starting designs.
    if (b.dataset.layout === 'Clear' && designAdded) {
      picked &= ~designAdded;
      rules.palettes = picked;
      designAdded = 0;
      layout.fill(0);
      for (let i = 0; i < 80; i++) paintCell(i);
      drawBrushes();
      syncLayout();
      applyPanes();
      return;
    }
    const fn = LAYOUTS[b.dataset.layout!];
    const A = brush || brushA;
    const B = brushB && brushB !== A ? brushB : layoutTrait === 0 && A !== 8 ? 8 : 0;
    for (let i = 0; i < 80; i++) {
      const v = fn(i);
      layout[i] = v === 'A' ? A : v === 'B' ? B : 0;
      paintCell(i);
    }
    syncLayout();
  });

  for (const key of SET_KEYS) {
    app.querySelector<HTMLElement>(`[data-rule="${key}"]`)!.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-bit]');
      if (!btn) return;
      if (key === 'palettes') {
        picked ^= 1 << Number(btn.dataset.bit);
        designAdded &= ~(1 << Number(btn.dataset.bit)); // touched by hand: yours now
        rules.palettes = picked;
      } else rules[key] ^= 1 << Number(btn.dataset.bit); // tap to add, tap again to remove
      pattern = 'none';
      // A value just added becomes the brush, so you can paint with it straight away: in the trait you're painting,
      // or in this one while the sheet is still blank.
      const bit = Number(btn.dataset.bit);
      const t = ({ palettes: 0, eights: 1, prints: 2, weights: 3 } as Record<string, LayoutTrait | undefined>)[key];
      if (t !== undefined && rules[key] & (1 << bit) && (t === layoutTrait || !layout.some(Boolean))) {
        const v = t === 0 ? bit : bit + 1;
        if (t !== layoutTrait) brushB = 0;
        else if (brush && brush !== v) brushB = brush;
        layoutTrait = t;
        brush = brushA = v;
      }
      // On a picture, the Colors tiles are its palette: what's on them now is yours, and it repaints with just those
      // (any of the 15 when none are left).
      if (key === 'palettes' && app.querySelector<HTMLInputElement>('input[name=arr]:checked')?.value === String(PICTURE)) {
        designAdded = 0;
        paintFromPicture();
        syncTiles();
        return;
      }
      drawBrushes(); // paint in a value you just took off the rule goes with it
      syncTiles();
      refresh();
    });
  }

  // ---------------------------------------------------------------- the mint timeline
  const from = document.getElementById('win-from') as HTMLInputElement;
  const to = document.getElementById('win-to') as HTMLInputElement;
  const winText = document.getElementById('win-text')!;
  const winCount = document.getElementById('win-count')!;
  const hist = document.getElementById('hist')!;
  const BARS = 120;
  const buckets = new Array(BARS).fill(0);
  minutes.forEach(([, c], i) => (buckets[Math.min(BARS - 1, Math.floor((i / Math.max(1, minutes.length)) * BARS))] += c));
  const peak = Math.max(1, ...buckets);
  const drawHist = () => {
    const a = Number(from.value), b = Number(to.value);
    const any = a === 0 && b === last;
    hist.innerHTML = buckets
      .map((c, i) => {
        const h = Math.max(0.6, (c / peak) * 26);
        const inRange = any || (i >= Math.floor((a / Math.max(1, minutes.length)) * BARS) && i <= Math.floor((b / Math.max(1, minutes.length)) * BARS));
        return `<rect x="${i}" y="${28 - h}" width="0.8" height="${h}" class="${inRange ? 'on' : ''}"/>`;
      })
      .join('');
  };
  let typing: HTMLInputElement | null = null; // the box being typed in, left as it is
  const drawWindow = () => {
    const fmtDT = zoned({ month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    const fmtT = zoned({ hour: '2-digit', minute: '2-digit' });
    const a = Number(from.value), b = Number(to.value);
    const any = !minutes.length || (a === 0 && b === last);
    rules.minuteFrom = any ? -1 : a;
    rules.minuteTo = any ? -1 : b;
    if (any) {
      winText.textContent = 'Any time';
      winCount.textContent = minutes.length ? `${minutes.reduce((s, [, c]) => s + c, 0).toLocaleString()} Credits` : '';
    } else {
      const start = new Date(minutes[a][0] * 1000), end = new Date((minutes[b][0] + 60) * 1000);
      winText.textContent = `${fmtDT.format(start)} – ${sameZoneDay(start, end) ? fmtT.format(end) : fmtDT.format(end)} ${zoneName()}`;
      let n = 0;
      for (let i = a; i <= b; i++) n += minutes[i][1];
      winCount.textContent = `${n.toLocaleString()} Credit${n === 1 ? '' : 's'}`;
    }
    if (minutes.length) {
      // Start is the first minute's start; End is where the last minute ends (exclusive), as the heading says.
      if (typing !== startIn) startIn.value = toTimeText(minutes[a][0]);
      if (typing !== endIn) endIn.value = toTimeText(minutes[b][0] + 60);
    }
    drawHist();
  };
  from.addEventListener('input', () => {
    if (Number(from.value) > Number(to.value)) to.value = from.value;
    drawWindow();
    refresh();
  });
  to.addEventListener('input', () => {
    if (Number(to.value) < Number(from.value)) from.value = to.value;
    drawWindow();
    refresh();
  });
  // Start and End, typed to the minute, move the handles; the handles fill them back in (drawWindow).
  const startIn = document.getElementById('win-start') as HTMLInputElement;
  const endIn = document.getElementById('win-end') as HTMLInputElement;
  const onZone = () => (startIn.isConnected ? drawWindow() : document.removeEventListener('zone', onZone));
  document.addEventListener('zone', onZone);
  /// The first minute that ends after `t`; the last minute that starts before `t`.
  const firstFrom = (t: number) => {
    const i = minutes.findIndex(([m]) => m + 59 >= t);
    return i < 0 ? last : i;
  };
  const lastBefore = (t: number) => {
    let i = last;
    while (i > 0 && minutes[i][0] >= t) i--;
    return i;
  };
  /// A window in unix seconds, snapped to the minutes (the ?from=&to= preset uses it too).
  const setWindow = (a: number, b: number, keep: 'a' | 'b') => {
    if (a > b) {
      if (keep === 'a') b = a;
      else a = b;
    }
    from.value = String(a);
    to.value = String(b);
    drawWindow();
  };
  // Applied as you type once a time reaches its minutes; Enter or leaving the box tidies it. A half-typed
  // Start past End waits for Enter rather than dragging End along.
  const typed = (el: HTMLInputElement, span: (t: number) => [number, number], keep: 'a' | 'b') => {
    el.addEventListener('input', () => {
      const t = typedToMinute(el.value) ? fromTimeText(el.value) : null;
      if (t === null) return;
      const [a, b] = span(t);
      if (a > b) return;
      typing = el;
      setWindow(a, b, keep);
      typing = null;
      refresh();
    });
    el.addEventListener('change', () => {
      const t = fromTimeText(el.value);
      if (minutes.length) mintEdgeNote(el.closest('.win-inputs')!, t ?? minutes[0][0], minutes[0][0], minutes[last][0] + 60);
      if (t === null) return drawWindow();
      const [a, b] = span(t);
      setWindow(a, b, keep);
      refresh();
    });
  };
  typed(startIn, (t) => [firstFrom(t), Number(to.value)], 'a');
  typed(endIn, (t) => [Number(from.value), lastBefore(t)], 'b');
  drawWindow();

  // ---------------------------------------------------------------- rating
  const minScoreEl = document.getElementById('min-score') as HTMLInputElement;
  // Rating as a range over its distribution, like the mint window. Ratings are ranks spread over 80–800,
  // so the bars are nearly flat: every 10 points holds about the same number of Credits.
  const maxScoreEl = document.getElementById('max-score') as HTMLInputElement;
  const scoreHist = document.getElementById('score-hist')!;
  const scoreBins = new Array(72).fill(0);
  let scorePeak = 1;
  factoryRead
    .then(([, , , t]) => bin(rulesBin(t)))
    .then((buf) => {
      for (const s of new Uint16Array(buf)) if (s) scoreBins[Math.min(71, Math.floor((s / 10 - 80) / 10))]++;
      scorePeak = Math.max(1, ...scoreBins);
      drawScore();
    })
    .catch(() => {});
  const scoreLabel = () => {
    const lo = rules.minScore / 10, hi = rules.maxScore / 10;
    return lo && hi ? `${lo}–${hi}` : lo ? `${lo} and up` : hi ? `up to ${hi}` : 'Any';
  };
  const drawScore = () => {
    const lo = Number(minScoreEl.value), hi = Number(maxScoreEl.value);
    rules.minScore = lo > 80 ? Math.round(lo * 10) : 0;
    rules.maxScore = hi < 800 ? Math.round(hi * 10) : 0;
    document.getElementById('score-text')!.textContent = scoreLabel();
    scoreHist.innerHTML = scoreBins
      .map((c, i) => {
        const on = 80 + i * 10 + 10 > lo && 80 + i * 10 < hi;
        const h = Math.max(0.6, (c / scorePeak) * 26);
        return `<rect x="${i}" y="${28 - h}" width="0.8" height="${h}" class="${on ? 'on' : ''}"/>`;
      })
      .join('');
  };
  // Tap a number on the scale: the nearer handle jumps to it (ties go to the one that can move there).
  document.getElementById('score-axis')!.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-v]');
    if (!b) return;
    const v = Number(b.dataset.v), lo = Number(minScoreEl.value), hi = Number(maxScoreEl.value);
    const useLo = v < lo || (v <= hi && Math.abs(v - lo) <= Math.abs(v - hi));
    (useLo ? minScoreEl : maxScoreEl).value = String(v);
    drawScore();
    refresh();
  });
  minScoreEl.addEventListener('input', () => {
    if (Number(minScoreEl.value) > Number(maxScoreEl.value)) maxScoreEl.value = minScoreEl.value;
    drawScore();
    refresh();
  });
  maxScoreEl.addEventListener('input', () => {
    if (Number(maxScoreEl.value) < Number(minScoreEl.value)) minScoreEl.value = maxScoreEl.value;
    drawScore();
    refresh();
  });

  // ---------------------------------------------------------------- bits
  const minBitsEl = document.getElementById('min-bits') as HTMLInputElement;
  const maxBitsEl = document.getElementById('max-bits') as HTMLInputElement;
  const bitsHist = document.getElementById('bits-hist')!;
  const bitsBins = new Array(BITS_HI - BITS_LO + 1).fill(0);
  let bitsPeak = 1;
  bin('bits.bin')
    .then((buf) => {
      for (const b of new Uint16Array(buf)) if (b >= BITS_LO && b <= BITS_HI) bitsBins[b - BITS_LO]++;
      bitsPeak = Math.max(1, ...bitsBins);
      drawBits();
    })
    .catch(() => {});
  const bitsLabel = () => {
    const lo = rules.bitsFrom, hi = rules.bitsTo;
    return lo && hi ? `${lo}–${hi}` : lo ? `${lo} and up` : hi ? `up to ${hi}` : 'Any';
  };
  const drawBits = () => {
    const lo = Number(minBitsEl.value), hi = Number(maxBitsEl.value);
    rules.bitsFrom = lo > BITS_LO ? lo : 0;
    rules.bitsTo = hi < BITS_HI ? hi : 0;
    document.getElementById('bits-text')!.textContent = bitsLabel();
    bitsHist.innerHTML = bitsBins
      .map((c, i) => {
        const h = c ? Math.max(0.6, Math.sqrt(c / bitsPeak) * 26) : 0;
        return `<rect x="${i}" y="${28 - h}" width="0.8" height="${h}" class="${i + BITS_LO >= lo && i + BITS_LO <= hi ? 'on' : ''}"/>`;
      })
      .join('');
  };
  document.getElementById('bits-axis')!.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-v]');
    if (!b) return;
    const v = Number(b.dataset.v), lo = Number(minBitsEl.value), hi = Number(maxBitsEl.value);
    const useLo = v < lo || (v <= hi && Math.abs(v - lo) <= Math.abs(v - hi));
    (useLo ? minBitsEl : maxBitsEl).value = String(v);
    drawBits();
    refresh();
  });
  minBitsEl.addEventListener('input', () => {
    if (Number(minBitsEl.value) > Number(maxBitsEl.value)) maxBitsEl.value = minBitsEl.value;
    drawBits();
    refresh();
  });
  maxBitsEl.addEventListener('input', () => {
    if (Number(maxBitsEl.value) < Number(minBitsEl.value)) minBitsEl.value = maxBitsEl.value;
    drawBits();
    refresh();
  });

  // ---------------------------------------------------------------- numbers and list
  // One field for both: a single range ("1-80") is the contract's number range; anything else ("1, 4, 5",
  // "1-10, 50") is expanded into its list of up to 200.
  const idsEl = document.getElementById('ids') as HTMLInputElement;
  const readIds = () => {
    const parts = idsEl.value.split(/[\s,]+/).map((x) => x.replace(/^#/, '')).filter(Boolean);
    const ranges = parts.map((x) => x.match(/^(\d+)\s*[-–]\s*(\d+)$/)).filter((m): m is RegExpMatchArray => !!m);
    const hint = document.getElementById('id-hint')!;
    rules.idFrom = rules.idTo = 0;
    rules.list = [];
    if (parts.length === 1 && ranges.length === 1) {
      const [x, y] = [Number(ranges[0][1]), Number(ranges[0][2])].sort((m, n) => m - n);
      rules.idFrom = x;
      rules.idTo = y;
      hint.textContent = `#${x}–${y} · ${(y - x + 1).toLocaleString()} numbers`;
    } else if (parts.length) {
      const out = new Set<number>();
      for (const x of parts) {
        const m = x.match(/^(\d+)[-–](\d+)$/);
        if (m) {
          const [lo, hi] = [Number(m[1]), Number(m[2])].sort((p, q) => p - q);
          for (let i = lo; i <= hi && out.size <= 200; i++) out.add(i);
        } else if (/^\d+$/.test(x)) out.add(Number(x));
      }
      rules.list = [...out];
      hint.textContent = out.size > 200 ? 'Over 200: use one range, or list fewer' : `${out.size} picked`;
    } else hint.textContent = 'Any';
    refresh();
  };
  idsEl.addEventListener('input', readIds);

  // ---------------------------------------------------------------- picker, order, fee
  const pickerEl = document.getElementById('picker')!;
  pickerEl.classList.toggle('scrolls', pickerEl.scrollHeight > pickerEl.clientHeight + 24);
  pickerEl.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('.pick');
    if (!b || b.classList.contains('off') || b.classList.contains('full')) return;
    // A picture takes only its own Credits, each Colors from its first slot.
    if (picturing() && !picks.has(b.dataset.id!) && !picPlan!.mine.has(b.dataset.id!)) return toast('Not a close match for the next spot of its Colors.', 'info', 4000);
    pickedByHand = true;
    const id = b.dataset.id!;
    // A picture: yours of one Colors go in from its first slot, so one brings those ahead of it, and leaving one out
    // leaves out those behind it.
    const along = picturing() ? runOf(picPlan!, id, picPlan!.mine) : null;
    if (picks.has(id)) [id, ...(along?.behind ?? [])].forEach((x) => picks.delete(x));
    else [id, ...(along?.ahead ?? [])].forEach((x) => picks.add(x));
    refresh();
  });
  document.getElementById('all')!.addEventListener('click', () => {
    pickedByHand = true;
    picks.clear();
    if (picturing()) {
      for (const id of bySlot([...picPlan!.mine])) picks.add(id);
      return refresh();
    }
    const room = capacity();
    for (const id of owned.filter(qualifies)) if (room.take(keyOfMine(id.toString()))) picks.add(id.toString());
    refresh();
  });
  // Name, order, payout and deadline changes update the recap and the step marks.
  document.getElementById('create')!.addEventListener('input', drawSummary);
  document.getElementById('create')!.addEventListener('change', drawSummary);
  // Painted is a layout: picking it opens the painter (brushes from your rules, paint on the sheet itself);
  // leaving it clears the paint.
  const paintBlock = document.getElementById('paint-block')!;
  // ---------------------------------------------------------------- Wave: a sheet painted for you
  // Each slot gets a Colors (layoutTrait 0) from the wave; it burns in Reconciled.
  const design = { wave: 'Wave' as WaveShape, waves: 2, shift: 0 };
  const applyDesign = (kind: number) => {
    const masks = waveColors({ shape: design.wave, waves: design.waves, shift: design.shift });
    layoutTrait = 0;
    masks.forEach((m, i) => ((layout[i] = m), paintCell(i)));
    syncLayout();
    const d: Direction = 'Reconciled';
    showDirection(app.querySelector<HTMLElement>('.dirs'), d);
    viewing = d;
    syncHint();
  };
  function drawDesign(kind: number) {
    const el = document.getElementById('design-block')!;
    const pills = (name: string, items: readonly string[], on: string) =>
      `<div class="lab-pills" role="radiogroup" aria-label="${name}">${items.map((x) => `<button type="button" role="radio" data-${name.toLowerCase()}="${x}" aria-checked="${x === on}">${x}</button>`).join('')}</div>`;
    const slider = (k: 'waves' | 'shift', label: string, min: number, max: number, step: number) =>
      `<label class="lab-slider"><span>${label}</span><input type="range" id="design-${k}" min="${min}" max="${max}" step="${step}" value="${design[k]}"><output class="num">${design[k]}</output></label>`;
    el.innerHTML = `${pills('Wave', WAVE_SHAPES, design.wave)}${slider('waves', 'Waves', 0.5, 6, 0.5)}${slider('shift', 'Shift', 0, 360, 15)}`;
    el.querySelectorAll<HTMLButtonElement>('[role=radio]').forEach((b) =>
      b.addEventListener('click', () => {
        if (b.dataset.wave) design.wave = b.dataset.wave as WaveShape;
        b.parentElement!.querySelectorAll('[role=radio]').forEach((x) => x.setAttribute('aria-checked', String(x === b)));
        applyDesign(kind);
      }),
    );
    el.querySelectorAll<HTMLInputElement>('input[type=range]').forEach((r) =>
      r.addEventListener('input', () => {
        design[r.id === 'design-waves' ? 'waves' : 'shift'] = Number(r.value);
        r.nextElementSibling!.textContent = r.value;
        applyDesign(kind);
      }),
    );
    applyDesign(kind);
  }
  const preview = document.getElementById('preview')!;
  /// The layout's line, ending with the format it's set to: the one the preview shows.
  const syncHint = () => {
    const v = arrRadios.find((r) => r.checked)?.value;
    document.getElementById('arr-hint')!.textContent = `${ARR_OPTS.find(([x]) => String(x) === v)?.[2] ?? ''} Format set to ${viewing}.`;
  };
  const syncOrder = () => {
    const v = arrRadios.find((r) => r.checked)?.value;
    syncHint();
    const isPicture = v === String(PICTURE);
    const isDesigned = DESIGNED.has(Number(v));
    const isMaze = v === String(MAZE);
    const on = v === '4' || isPicture || isDesigned;
    // A picture makes its own rules (its Colors, slot by slot): the rest would turn its Credits away, so only Colors stays.
    app.querySelector('#create')!.classList.toggle('picture-mode', isPicture);
    paintBlock.hidden = !on || isPicture || isDesigned;
    document.getElementById('design-block')!.hidden = !isDesigned && !isMaze;
    document.getElementById('picture-block')!.hidden = !isPicture;
    // A picture previews as it will print: examples at full ink, packed together (Consolidated), as the Printer
    // matches it.
    app.querySelector('.design-preview')!.classList.toggle('solid-ghosts', isPicture || isMaze);
    if (isPicture) (showDirection(app.querySelector<HTMLElement>('.dirs'), picLook), (viewing = picLook));
    // Rules only mean something slot by slot on a painted sheet; otherwise every slot takes the same Credits.
    // The painted view (and its phone toggle) is for a sheet you paint by hand; a picture shows as its Credits.
    app.querySelector<HTMLElement>('.view-toggle')!.hidden = !on || isPicture || isDesigned;
    app.querySelector<HTMLElement>('.dirs [data-dir="Rules"]')!.hidden = !on || isPicture;
    preview.classList.toggle('paintable', on && !isPicture && !isDesigned); // a picture's sheet comes from its Credits, not a brush
    // A picture shows as the Credits that would draw it; a sheet you paint by hand, as its rules.
    setView(on && !isPicture && !isDesigned ? 'rules' : 'credits');
    if (isDesigned) drawDesign(Number(v));
    else if (isPicture) {
      if (!pic) pic = mountPicture(); // paints once its first picture loads
      else paintFromPicture();
    } else if (on) {
      drawBrushes();
      if (!layout.some(Boolean)) shuffleDesign(); // a blank sheet starts from a design
    }
    else if (layout.some(Boolean) || designAdded) {
      // Off the painted layouts: the paint goes, and so do the Colors a design or picture put on Who can join, and
      // the picture's own picks.
      if (picPlan) {
        picPlan = null;
        delete preview.dataset.designed;
        picks.clear();
        pickedByHand = false;
      }
      picked &= ~designAdded;
      rules.palettes = picked;
      designAdded = 0;
      layout.fill(0);
      for (let i = 0; i < 80; i++) paintCell(i);
      drawBrushes();
      syncLayout();
    }
    if (isMaze) void drawMaze();
    else syncRoute();
    syncHint();
  };
  // ---------------------------------------------------------------- Maze: one buyer, 80 Credits for sale
  // Amortized outlines ink, so paper reads as passages: 80 listed Credits whose doors line up, one way through. You
  // buy all 80 and they go in in order (a named list, deposit order), so each lands in its room.
  let mazeData: Promise<{ pool: Pool; index: MazeIndex }> | null = null;
  let mazeSeed = 1 + Math.floor(Math.random() * 1e6);
  const ethOf = (w: bigint) => `${(Number(w) / 1e18).toFixed(3)} ETH`;
  const loadMaze = () =>
    (mazeData ??= Promise.all([
      fetch('/lab/inks.bin').then((r) => r.arrayBuffer()),
      fetch('/market.json').then((r) => r.json() as Promise<{ items?: [string, string][] }>).catch(() => ({ items: [] })),
    ]).then(async ([buf, m]) => {
      const price = new Map((m.items ?? []).map(([id, wei]) => [Number(id), BigInt(wei)]));
      // No book here (a local worker): the lab's snapshot of every listing.
      if (!price.size) for (const [id, v] of Object.entries(await fetch('/lab/listed.json').then((r) => r.json() as Promise<Record<string, { price: string }>>))) price.set(Number(id), BigInt(v.price));
      const pool: Pool = { inks: new Uint8Array(buf), price };
      return { pool, index: mazeIndex(pool) };
    }).catch((e) => {
      mazeData = null;
      throw e;
    }));
  /// The way through, run over the Amortized preview: the maze redrawn with every wall one grey, and a red runner
  /// running down the passage cell by cell, start to exit, then again. Never part of the art: it shows only here, on the
  /// drawn format, while Show path is on. Cells are the lab's field (76 across, the page 95 down, 1.5 down).
  let showRoute = false;
  let runFrame = 0;
  async function syncRoute() {
    const host = app.querySelector<HTMLElement>('.design-preview')!;
    let run = host.querySelector<HTMLCanvasElement>(':scope > .maze-run');
    cancelAnimationFrame(runFrame);
    const on = showRoute && mazeOn() && !!maze && viewing === 'Amortized';
    if (!on) return void run?.remove();
    const m = maze!;
    const { pool } = await loadMaze();
    if (maze !== m || !showRoute || !mazeOn()) return;
    if (!run) {
      run = document.createElement('canvas');
      run.className = 'maze-run';
      run.setAttribute('aria-hidden', 'true');
      host.append(run);
    }
    const W = Math.round((run.clientWidth || 480) * Math.min(3, devicePixelRatio || 1)), H = Math.round((W * PAGE.h) / PAGE.w);
    run.width = W;
    run.height = H;
    // The maze in one grey: each pixel's darkest channel says how much ink it has, whatever its colour.
    const base = document.createElement('canvas');
    base.width = W;
    base.height = H;
    const b = base.getContext('2d')!;
    paintMarks(b, W, compose('Amortized', m.ids.map((id) => inkFor(pool, id))));
    const img = b.getImageData(0, 0, W, H), px = img.data;
    for (let i = 0; i < px.length; i += 4) {
      const v = 255 - ((255 - Math.min(px[i], px[i + 1], px[i + 2])) * 120) / 255;
      px[i] = px[i + 1] = px[i + 2] = v;
    }
    b.putImageData(img, 0, 0);
    const cells = m.path.filter(([x, y], i) => !i || x !== m.path[i - 1][0] || y !== m.path[i - 1][1]);
    const k = W / 76, g = run.getContext('2d')!;
    const draw = (n: number) => {
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.drawImage(base, 0, 0);
      // A thin line down the middle of the passage, about as thick as a wall.
      g.strokeStyle = '#e40000';
      g.lineWidth = Math.max(1.5, k * 0.3);
      g.lineJoin = g.lineCap = 'round';
      g.beginPath();
      for (let i = 0; i < n; i++) (i ? g.lineTo : g.moveTo).call(g, (cells[i][0] + 0.5) * k, (cells[i][1] + 2) * k);
      g.stroke();
    };
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return draw(cells.length);
    const STEP = 18, HOLD = 1600; // ms per cell, and the finished path before it runs again
    const t0 = performance.now();
    const tick = (t: number) => {
      if (!run!.isConnected) return;
      draw(Math.min(cells.length, Math.floor(((t - t0) % (cells.length * STEP + HOLD)) / STEP) + 1));
      runFrame = requestAnimationFrame(tick);
    };
    runFrame = requestAnimationFrame(tick);
  }
  async function drawMaze(again = false) {
    const el = document.getElementById('design-block')!;
    if (!el.querySelector('#maze-new')) {
      el.innerHTML = `<button type="button" class="btn block" id="maze-route" aria-pressed="${showRoute}">${showRoute ? 'Hide path' : 'Show path'}</button>
        <p class="term-desc muted maze-row"><span id="maze-status"></span><span class="maze-note">Path is a preview, not printed.</span><button type="button" class="link small" id="maze-new">Find another maze</button></p>`;
      el.querySelector('#maze-new')!.addEventListener('click', () => void drawMaze(true));
      el.querySelector<HTMLButtonElement>('#maze-route')!.addEventListener('click', (e) => {
        showRoute = !showRoute;
        const b = e.currentTarget as HTMLButtonElement;
        b.setAttribute('aria-pressed', String(showRoute));
        b.textContent = showRoute ? 'Hide path' : 'Show path';
        syncRoute();
      });
    }
    showDirection(app.querySelector<HTMLElement>('.dirs'), 'Amortized');
    viewing = 'Amortized';
    syncHint();
    const status = el.querySelector<HTMLElement>('#maze-status')!;
    if (maze && !again) return void ((status.textContent = `80 for sale · ${ethOf(maze.cost)}`), refresh(), syncRoute());
    status.textContent = mazeData ? 'Making a maze…' : 'Reading every Credit for sale…';
    let d: Awaited<ReturnType<typeof loadMaze>>;
    try {
      d = await loadMaze();
    } catch (e) {
      return void (status.textContent = errText(e));
    }
    status.textContent = 'Making a maze…';
    await new Promise((r) => setTimeout(r, 30)); // let it say so before the planner holds the page
    if (!mazeOn()) return;
    if (again) mazeSeed++;
    maze = planMaze(d.pool, d.index, mazeSeed);
    status.textContent = maze ? `80 for sale · ${ethOf(maze.cost)}` : 'No maze from what’s for sale right now. Try again.';
    refresh();
    syncRoute();
  }
  // ---------------------------------------------------------------- picture
  const mountPicture = () =>
    framer({
      crop: document.getElementById('pic-crop') as HTMLCanvasElement,
      file: document.getElementById('pic-file') as HTMLInputElement,
      contrast: () => +(document.getElementById('pic-contrast') as HTMLInputElement).value,
      brightness: () => +(document.getElementById('pic-brightness') as HTMLInputElement).value,
      saturation: () => +(document.getElementById('pic-saturation') as HTMLInputElement).value,
      pixelate: true,
      settle: () => paintFromPicture(),
    });
  // Brightness, Contrast and Saturation: the picture changes as you drag, the Credits once you let go.
  for (const id of ['pic-brightness', 'pic-contrast', 'pic-saturation']) {
    document.getElementById(id)!.addEventListener('input', () => pic?.frame());
    document.getElementById(id)!.addEventListener('change', () => paintFromPicture());
  }
  document.getElementById('pic-replace')!.addEventListener('click', () => (document.getElementById('pic-file') as HTMLInputElement).click());
  // Reset: the sliders where they started, the whole picture framed again, and the Credits picked for that.
  document.getElementById('pic-reset')!.addEventListener('click', () => {
    for (const el of app.querySelectorAll<HTMLInputElement>('.picture-contrast input')) el.value = el.defaultValue;
    pic?.reset();
    void paintFromPicture();
  });
  /// Design the sheet from the framed picture: the Credits that draw it best (yours, and listings), each slot painted
  /// with its Credit's Colors. Only the Colors you picked on Who can join when you've picked some. Its Colors go on
  /// Who can join the way a design's do (Clear all takes them back off). Your Credits it uses at the front of their
  /// Colors go in with you, in slot order, so each lands in its slot; the union page recommends the rest.
  let picSeq = 0;
  async function paintFromPicture() {
    if (!pic?.ready() || !preview.isConnected || arrRadios.find((r) => r.checked)?.value !== String(PICTURE)) return;
    const seq = ++picSeq;
    if (!traitsIn && session.account) return void (document.getElementById('pic-status')!.textContent = 'Reading your Credits…'); // designed once they're in
    const status = document.getElementById('pic-status')!;
    const px = pic.pixels();
    let g: Guide;
    try {
      status.textContent = guide ? 'Matching…' : 'Reading every Credit for sale…';
      // Only yours the page can put in (the ones it has read the traits of).
      const held = owned.filter((id) => mine.has(id.toString()));
      const progress = (f: number) => seq === picSeq && (status.textContent = `Matching… ${Math.round(f * 100)}%`);
      const detail = DETAIL; // the Printer's tested balance of likeness and edges
      g = session.account
        ? await Guide.of(px, { wallets: [session.account], held, colours: (id) => paletteBit(mine.get(id.toString())!.traits.palette), detail, progress, own: buyToStart ? OWN_GOOD : 1, look: picLook })
        : await Guide.of(px, { detail, progress, look: picLook });
    } catch (e) {
      if (seq === picSeq) status.textContent = errText(e);
      return;
    }
    if (seq !== picSeq || !preview.isConnected) return;
    const yours = picked & ~designAdded; // Colors you picked yourself
    let design: ReturnType<Guide['design']>;
    try {
      design = g.design(yours ? new Set(PALETTE_ROWS.flat().map(paletteBit).filter((m) => yours & (1 << m))) : undefined);
    } catch (e) {
      status.textContent = errText(e);
      return;
    }
    guide = g;
    picPx = px;
    document.getElementById('pic-links')!.hidden = false;
    layoutTrait = 0;
    const used = design.layout.reduce((u, m) => u | (1 << m), 0);
    picked = yours | used;
    designAdded = used & ~yours;
    rules.palettes = picked;
    design.layout.forEach((m, i) => {
      layout[i] = m;
      paintCell(i);
    });
    // Yours that the picture puts first in their Colors' slots go in now, in slot order.
    const rec = g.fillYoursFirst(layout, layout.map(() => null), picGone);
    picPlan = planOf(rec, layout);
    // What draws all 80: how many of yours, and how many for sale.
    const ours = rec.filter((c) => c && c.owner >= 0).length;
    status.textContent = `${ours ? `${ours} of yours and ${80 - ours} for sale draw it.` : 'Credits for sale draw it.'}`;
    picks.clear();
    pickedByHand = false;
    for (const id of bySlot([...picPlan.mine])) picks.add(id);
    buyFor = '';
    const n = new Map<number, number>();
    for (const m of design.layout) n.set(m, (n.get(m) ?? 0) + 1);
    brush = brushA = [...n].sort((a, b) => b[1] - a[1])[0][0];
    brushB = 0;
    drawBrushes();
    syncLayout();
    preview.dataset.designed = String(seq); // the picture is designed (tests wait on this)
  }
  app.querySelectorAll<HTMLInputElement>('input[name=view]').forEach((r) => r.addEventListener('change', () => setView(r.value as 'rules' | 'credits')));
  // On a wide screen Rules sits in the directions row: picking it shows the rules, any direction the Credits.
  app.addEventListener('direction', (e) => {
    const d = (e as CustomEvent<string>).detail;
    if ((d === 'Rules') !== (view === 'rules')) setView(d === 'Rules' ? 'rules' : 'credits');
    // A picture follows the format you look at: it burns in it, and in the formats that keep each Credit in its own
    // spot as a picture (Consolidated, Assessed, Reconciled) its Credits are matched again for it.
    if (d === 'All' || d === 'Rules') return void syncRoute();
    viewing = d as Direction;
    syncRoute();
    syncHint();
    if (LOOKS.includes(d as Look) && d !== picLook && arrRadios.find((r) => r.checked)?.value === String(PICTURE)) {
      picLook = d as Look;
      void paintFromPicture();
    }
  });
  arrRadios.forEach((r) => r.addEventListener('change', syncOrder));
  app.querySelectorAll<HTMLInputElement>('input[name=ending]').forEach((r) =>
    r.addEventListener('change', () => {
      document.getElementById('end-hint')!.textContent = END_HINTS[r.value as keyof typeof END_HINTS];
      // Tokens always pay by rating put in, so Equal and Early don't apply.
      app.querySelector<HTMLElement>('.pay-field:not(.end-field)')!.hidden = r.value === 'tokens';
    }),
  );
  // Paint straight onto the preview sheet: tap or drag across its slots.
  const slotAt = (x: number, y: number) => {
    const c = document.elementFromPoint(x, y)?.closest<HTMLElement>('#preview .cell');
    return c ? [...c.parentElement!.children].indexOf(c) : -1;
  };
  let sheetPainting = false;
  let lastSlot = -1;
  /// Paint from the last slot to this one, so a fast drag doesn't skip the slots in between.
  const strokeTo = (i: number) => {
    if (lastSlot < 0) paintSheet(i);
    else {
      const [r0, c0, r1, c1] = [Math.floor(lastSlot / 8), lastSlot % 8, Math.floor(i / 8), i % 8];
      const steps = Math.max(Math.abs(r1 - r0), Math.abs(c1 - c0));
      for (let k = 1; k <= steps; k++) paintSheet(Math.round(r0 + ((r1 - r0) * k) / steps) * 8 + Math.round(c0 + ((c1 - c0) * k) / steps));
    }
    lastSlot = i;
  };
  preview.addEventListener('pointerdown', (e) => {
    capWarned = false;
    if (!preview.classList.contains('paintable')) return;
    const i = slotAt(e.clientX, e.clientY);
    if (i < 0) return;
    e.preventDefault();
    sheetPainting = true;
    preview.setPointerCapture(e.pointerId);
    lastSlot = -1;
    strokeTo(i);
  });
  preview.addEventListener('pointermove', (e) => {
    if (!sheetPainting) return;
    const i = slotAt(e.clientX, e.clientY);
    if (i >= 0 && i !== lastSlot) strokeTo(i);
  });
  const endSheet = () => {
    if (!sheetPainting) return;
    sheetPainting = false;
    syncLayout();
  };
  preview.addEventListener('pointerup', endSheet);
  preview.addEventListener('pointercancel', endSheet);
  syncOrder();

  // ---------------------------------------------------------------- open
  document.getElementById('create')!.addEventListener('submit', async (e) => {
    e.preventDefault();
    const reserve = 0n; // no reserve: the auction opens at its minimum bid
    if (rules.idTo && rules.idFrom > rules.idTo) return toast('The number range is backwards.', 'err');
    if (rules.list.length > 200) return toast('At most 200 listed Credits.', 'err');
    const nameEl = document.getElementById('name') as HTMLInputElement;
    const name = nameEl.value.trim() || nameEl.placeholder; // left blank: take the suggested name
    const days = 90; // required by the factory, no longer enforced: open parties don't expire, full ones follow the countdown and burn hour
    const chosen = Number((app.querySelector('input[name=arr]:checked') as HTMLInputElement).value);
    if (chosen === MAZE) return; // coming soon
    const painted = chosen === 4 || chosen === PICTURE || DESIGNED.has(chosen);
    // A maze goes in in deposit order (0), so each Credit lands in its room.
    const arr = chosen === MAZE ? 0 : !painted ? chosen : layout.some(Boolean) ? 4 : 0; // Painted with nothing painted burns in deposit order
    const split = Number((app.querySelector('input[name=split]:checked') as HTMLInputElement).value);
    go.disabled = true;
    go.dataset.busy = '1'; // progress labels below own the button until this finishes
    // Credits picked in Buy Credits that fit: bought first (the explorer's price-checked buy, into your wallet),
    // then picked here, then the union opens with them.
    // A maze: all 80 bought in one go (none, if any just sold), then opened as a named list of exactly them.
    let mazeIds: bigint[] | null = null;
    if (chosen === MAZE && maze) {
      const m = maze;
      const stop = (msg?: string) => {
        if (msg) toast(msg, 'err', 8000);
        delete go.dataset.busy;
        refresh();
      };
      const sold = (ids: string[]) => {
        const out = new Set(ids.map(Number));
        mazeData = mazeData?.then(({ pool }) => {
          for (const id of out) pool.price?.delete(id);
          return { pool, index: mazeIndex(pool) };
        }) ?? null;
      };
      go.textContent = 'Checking prices…';
      let ls: Listing[];
      try {
        ls = await listedById(m.ids.map(String), true);
      } catch (x) {
        return stop(errText(x));
      }
      const gone = m.ids.map(String).filter((id) => !ls.some((l) => l.id === id));
      if (gone.length) {
        sold(gone);
        maze = null;
        void drawMaze(true);
        return stop(`${gone.map((id) => `#${id}`).join(', ')} ${gone.length === 1 ? 'is' : 'are'} no longer for sale. Here’s a new maze.`);
      }
      const got = await sweepToWallet(ls, go, undefined, { onSold: (ids) => (sold(ids), (maze = null), void drawMaze(true)) });
      if (!got?.length) return stop();
      await gotCredits(got);
      go.disabled = true;
      mazeIds = m.ids.map(BigInt);
    }
    const toBuy = buying();
    if (toBuy.length) {
      // A picture's first Credits: all or none, so none lands a slot early; a sold one gives its slot to the next best.
      const got = await sweepToWallet(toBuy, go, undefined, picturing() ? { onSold: (ids) => {
        ids.forEach((id) => picGone.add(Number(id)));
        picPlan = planOf(guide!.fillYoursFirst(layout, layout.map(() => null), picGone), layout);
        buyFor = '';
      } } : undefined);
      if (!got?.length) {
        delete go.dataset.busy;
        return refresh();
      }
      await gotCredits(got);
      go.disabled = true;
    }
    // A picture's Credits go in slot order, so each lands in its slot.
    const ids = mazeIds ?? (picturing() ? bySlot([...picks]) : [...picks]).map(BigInt);
    // The picture's 80 Credits as picked now (its list card draws them), before the page moves on.
    const pictureIds = picturing() && guide ? pictureSlots(owned.filter(qualifies)).ids : null;
    // A maze's list is the whole rule: nothing else may turn one of its Credits away.
    const f = mazeIds ? { ...filterOf(), palettes: 0, prints: 0, weights: 0, eights: 0, paidFrom: 0n, paidTo: 0n, idFrom: 0n, idTo: 0n, minScore: 0, maxScore: 0, layout0: 0n, layout1: 0n, bitsFrom: 0, bitsTo: 0, layoutTrait: 0 } : filterOf();
    const list = mazeIds ?? rules.list.map(BigInt);
    // Tokens: the token factory opens it (same Batch, its burn converts the Statement and pays members tokens). Its
    // fees and score table are read now, since create reverts if what it's sent differs.
    const tokens = endingTokens();
    const fac = tokens ? config.tokenFactory! : config.factory;
    const formatsAt = tokens ? config.tokenFormats : config.formats;
    try {
      let [pBps, cBps, tbl, ok] = [protocolBps, creatorBps, table, isOk];
      if (tokens) {
        const read = (functionName: 'protocolFeeBps' | 'creatorFeeBps' | 'ratings') => pub.readContract({ address: fac, abi: factoryAbi, functionName });
        const [p, c, t, a] = await Promise.all([read('protocolFeeBps'), read('creatorFeeBps'), read('ratings'), pub.readContract({ address: config.credits, abi: creditsAbi, functionName: 'isApprovedForAll', args: [session.account!, fac] })]);
        [pBps, cBps, tbl, ok] = [Number(p), Number(c), t as Address, a as boolean];
      }
      const open = {
        address: fac,
        abi: factoryAbi,
        functionName: 'create',
        // The fees and score table shown on this page go along: the open reverts if either changed underneath you.
        args: [name, f, list, reserve, arr, split, BigInt(days * 86400), ids.slice(0, CHUNK), BigInt(pBps), BigInt(cBps), tbl],
      };
      const approve = { address: config.credits, abi: creditsAbi, functionName: 'setApprovalForAll', args: [fac, true] };
      let logs: { address: string; data: `0x${string}`; topics: readonly `0x${string}`[] }[];
      if (!ok && (await canBatch())) {
        // First party from this wallet, and the wallet batches: approve and open in one step.
        go.textContent = 'Opening…';
        const receipts = await sendBatch([approve, open]);
        if (!tokens) isOk = true;
        logs = receipts.flatMap((r) => r.logs);
      } else {
        // First party from this wallet: the factory needs permission to move your Credits, once.
        if (!ok) {
          go.textContent = 'Allow Credit Union to move your Credits…';
          await send(approve);
          if (!tokens) isOk = true;
        }
        go.textContent = 'Opening…';
        logs = (await send(open)).logs;
      }
      // Only the factory's own logs: any contract the call touched could emit a look-alike BatchCreated.
      const ev = logs
        .filter((l) => l.address.toLowerCase() === fac.toLowerCase())
        .map((l) => {
          try {
            return decodeEventLog({ abi: factoryAbi, data: l.data, topics: l.topics as [`0x${string}`, ...`0x${string}`[]] });
          } catch {
            return null;
          }
        })
        .find((x) => x?.eventName === 'BatchCreated');
      const batch = (ev?.args as { batch: `0x${string}` }).batch;
      for (let i = CHUNK; i < ids.length; i += CHUNK) {
        go.textContent = `Depositing ${i}–${Math.min(i + CHUNK, ids.length)}…`;
        await send({ address: fac, abi: factoryAbi, functionName: 'deposit', args: [batch, ids.slice(i, i + CHUNK)] });
      }
      // A Picture union keeps its picture, so its page can recommend the Credit for each open slot.
      if (painted && chosen === PICTURE && picPx && layout.some(Boolean)) {
        await fetch(`/pictures/${batch}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...packPicture(picPx, DETAIL, picLook), ids: pictureIds }) }).catch(() => {});
      }
      // Any layout burns in the format its preview shows (the creator's pick, set as it opens); Consolidated is the default.
      if (viewing !== 'Consolidated' && formatsAt) {
        go.textContent = `Setting it to ${viewing}…`;
        await send({ address: formatsAt, abi: unionFormatsAbi, functionName: 'pick', args: [batch, DIRECTIONS.indexOf(viewing)] }).catch(() => toast(`It burns in Consolidated until it’s set to ${viewing}. Set it from its page.`, 'info', 8000));
      }
      // The party page picks this up and shows the congrats and share dialog, once.
      try {
        sessionStorage.setItem('cu-created', batch);
      } catch {}
      navigate(`/union/${batch}`);
    } catch (x) {
      toast(errText(x), 'err', 8000);
      delete go.dataset.busy;
      go.textContent = startLabel();
      refresh();
    }
  });

  // Sections: who can join, layout, settings. Rules start hidden; you add the ones you want, and each
  // added rule can be removed (which also clears it).
  const RULES: Record<string, string> = { palette: 'Colors', eights: 'Eights', weight: 'Weight', print: 'Print', time: 'Time', rating: 'Rating', bits: 'Bits', numbers: 'Token' };
  const sections = [...app.querySelectorAll<HTMLElement>('.rule[data-pane]')];
  const added = new Set<string>();
  const isSet = (): Record<string, boolean> => ({
    palette: !!rules.palettes, print: !!rules.prints, weight: !!rules.weights, eights: !!rules.eights,
    time: rules.minuteFrom >= 0 || rules.minuteTo >= 0, numbers: !!(rules.idFrom || rules.idTo) || rules.list.length > 0, rating: rules.minScore > 0 || rules.maxScore > 0,
    bits: rules.bitsFrom > 0 || rules.bitsTo > 0,
  });
  // Rules as one list, like a settings page: every rule is a row showing its value ("Any" when unset, a × to
  // clear it when set). Tapping a row opens its editor inside it; one open at a time.
  let tab = ''; // the open row, none to start
  const PICK: Record<string, string> = { eights: 'eights-pick', weight: 'weights-pick', print: 'prints-pick', palette: 'palettes-pick', time: 'win-text', rating: 'score-text', bits: 'bits-text', numbers: 'id-hint' };
  const list = document.getElementById('add-rule')!;
  // Build the rows once and move each rule's editor into its row, so opening one never re-renders the others.
  for (const [k, l] of Object.entries(RULES)) {
    const row = document.createElement('div');
    row.className = 'rrow';
    row.dataset.row = k;
    row.innerHTML = `<div class="rrow-head"><button type="button" class="rrow-toggle" data-tab-btn="${k}" aria-expanded="false"><span class="rrow-name">${l}</span><span class="rrow-value"></span><svg class="chev" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.5"/></svg></button></div>`;
    const sec = sections.find((x) => x.dataset.tab === k && x.dataset.pane === 'who');
    if (sec) {
      // Clearing lives inside the open editor, on the description line, away from the row's chevron.
      const desc = sec.querySelector('.rule-desc');
      desc?.insertAdjacentHTML('afterend', `<button type="button" class="link small rule-clear" data-clear-rule="${k}" hidden>Clear</button>`);
      if (desc) {
        const line = document.createElement('div');
        line.className = 'rule-descline';
        desc.before(line);
        line.append(desc, sec.querySelector('.rule-clear')!);
      }
      row.append(sec);
    }
    list.append(row);
  }
  /// The rules as one plain sentence: any of the picks within a rule (or), every rule at once (and).
  const INK_WORD: Record<string, string> = { C: 'cyan', M: 'magenta', Y: 'yellow', K: 'black' };
  // The sentence is HTML so OR and AND can stand out; every value in it is escaped.
  const OR = ' <b class="conj">OR</b> ', AND = ', <b class="conj">AND</b> it ';
  const or = (xs: string[]) => { const e = xs.map((x) => `<span class="v">${esc(x)}</span>`); return e.length < 2 ? e.join('') : `${e.slice(0, -1).join(', ')}${OR}${e[e.length - 1]}`; };
  const txt = (id: string) => `<span class="v">${esc(document.getElementById(id)?.textContent ?? '')}</span>`;
  const bitsOf = (m: number, n: number) => Array.from({ length: n }, (_, i) => i).filter((i) => m & (1 << i));
  const sentence = () => {
    const parts: string[] = [];
    if (rules.palettes) parts.push(`is ${or(TRAITS.colors.filter((p) => rules.palettes & (1 << paletteBit(p))).map((p) => [...p].map((c) => INK_WORD[c]).join('+')))}`);
    if (rules.eights) parts.push(`has ${or(bitsOf(rules.eights, 9).map(String))} eights`);
    if (rules.weights) parts.push(`has ${or(bitsOf(rules.weights, 4).map((i) => WEIGHTS[i]))} weight`);
    if (rules.prints) parts.push(`has a ${or(bitsOf(rules.prints, 6).map((i) => PRINTS[i]))} print`);
    if (rules.minuteFrom >= 0 || rules.minuteTo >= 0) parts.push(`was paid ${txt('win-text')}`);
    if (rules.minScore || rules.maxScore) parts.push(`is rated ${txt('score-text')}`);
    if (rules.bitsFrom || rules.bitsTo) parts.push(`has ${txt('bits-text')} Bits`);
    if (rules.idFrom || rules.idTo || rules.list.length) parts.push(`is ${txt('id-hint')}`);
    return parts.length ? `A Credit can join if it ${parts.join(AND)}.` : 'Any Credit can join.';
  };
  /// The eligible Credits, 120 at a time, in Credit order: a quiet grid in a dialog, with Show more at the bottom.
  const openEligible = async () => {
    const total = document.getElementById('st-edition')!.textContent;
    const d = document.createElement('dialog');
    d.className = 'eligible';
    d.innerHTML = `<div class="eligible-head"><div><h3>${esc(total ?? '')} eligible</h3><p class="rule-sentence">${sentence()}</p></div></div><div class="eligible-grid"></div><button type="button" class="btn block" data-more hidden>Show more</button>`;
    document.body.append(d);
    openModal(d);
    const grid = d.querySelector<HTMLElement>('.eligible-grid')!, more = d.querySelector<HTMLButtonElement>('[data-more]')!;
    let page = 0, shown = 0;
    const load = async () => {
      more.disabled = true;
      const body = { palettes: pal(), prints: rules.prints, weights: rules.weights, eights: rules.eights, minuteFrom: rules.minuteFrom, minuteTo: rules.minuteTo, idFrom: rules.idFrom, idTo: rules.idTo, minScore: rules.minScore, maxScore: rules.maxScore, bitsFrom: rules.bitsFrom, bitsTo: rules.bitsTo, list: rules.list.slice(0, 200), page };
      const r = (await (await fetch('/edition/match', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json()) as { count?: number; sample?: number[] };
      const ids = r.sample ?? [];
      grid.insertAdjacentHTML('beforeend', ids.map((id) => `<figure title="Credit #${id}"><img src="${editionArt(id)}" alt="" loading="lazy" decoding="async"><figcaption class="num">#${id.toLocaleString()}</figcaption></figure>`).join(''));
      shown += ids.length;
      page++;
      more.hidden = shown >= (r.count ?? 0) || ids.length === 0;
      more.textContent = `Show more (${((r.count ?? 0) - shown).toLocaleString()} left)`;
      more.disabled = false;
    };
    d.addEventListener('close', () => d.remove());
    more.addEventListener('click', () => load());
    await load();
  };
  document.getElementById('see-eligible')!.addEventListener('click', (e) => { e.preventDefault(); openEligible(); });
  /// The picked values as small chips, each with the same glyph its tile uses; null for rules without glyphs.
  const chips = (k: string): string | null => {
    const bits = (m: number, n: number) => Array.from({ length: n }, (_, i) => i).filter((i) => m & (1 << i));
    const chip = (g: string, l: string) => `<span class="vchip">${g}<span>${esc(l)}</span></span>`;
    // Many Colors: just their swatches, on one line (their names are in each swatch's title).
    const many = bits(pal(), 16).length > 4;
    if (k === 'palette') return bits(pal(), 16).map((m) => (many ? `<span class="vchip bare" title="${slotName(0, m)}">${swatch(slotName(0, m))}</span>` : chip(swatch(slotName(0, m)), slotName(0, m)))).join('');
    if (k === 'print') return bits(rules.prints, PRINTS.length).map((i) => chip(printGlyph(PRINTS[i]), PRINTS[i])).join('');
    if (k === 'weight') return bits(rules.weights, WEIGHTS.length).map((i) => chip(weightGlyph(WEIGHTS[i]), WEIGHTS[i])).join('');
    if (k === 'eights') return bits(rules.eights, EIGHTS_MAX + 1).map((n) => chip(dice(n), eightsName(n))).join('');
    return null;
  };
  const applyPanes = () => {
    const set = isSet();
    // The form says "Any Credit can join." until a rule is set; then the rows say it, and the full sentence (OR within
    // a rule, AND across them) opens with the eligible Credits.
    const line = document.getElementById('rule-sentence')!;
    line.innerHTML = sentence();
    line.hidden = Object.values(set).some(Boolean);
    // Rules you haven't set wait as "+ Colors"-style chips under the sentence; tapping one opens its row. Set or
    // open rules show as rows; clearing one sends it back to a chip.
    document.getElementById('rule-adds')!.innerHTML = Object.entries(RULES)
      .filter(([k]) => !set[k] && k !== tab)
      .map(([k, l]) => `<button type="button" class="rule-add" data-tab-btn="${k}">+ ${l}</button>`)
      .join('');
    list.hidden = !Object.keys(RULES).some((k) => set[k] || k === tab);
    for (const row of list.querySelectorAll<HTMLElement>('.rrow')) {
      const k = row.dataset.row!;
      const open = k === tab;
      row.hidden = !set[k] && !open;
      const sec = row.querySelector<HTMLElement>('.rule');
      if (sec) sec.hidden = !open;
      row.classList.toggle('open', open);
      row.classList.toggle('set', !!set[k]);
      row.querySelector('.rrow-toggle')!.setAttribute('aria-expanded', String(open));
      row.querySelector('.rrow-value')!.innerHTML = set[k] ? (chips(k) ?? esc(document.getElementById(PICK[k])?.textContent ?? '')) : 'Any';
      const clr = row.querySelector<HTMLElement>('.rule-clear');
      if (clr) clr.hidden = !set[k];
    }
  };
  const clearRule = (k: string) => {
    if (k === 'palette') {
      picked = 0;
      rules.palettes = 0;
    }
    if (k === 'print') rules.prints = 0;
    if (k === 'weight') rules.weights = 0;
    if (k === 'eights') rules.eights = 0;
    if (k === 'rating') {
      rules.minScore = rules.maxScore = 0;
      minScoreEl.value = '80';
      maxScoreEl.value = '800';
      drawScore();
    }
    if (k === 'bits') {
      rules.bitsFrom = rules.bitsTo = 0;
      minBitsEl.value = String(BITS_LO);
      maxBitsEl.value = String(BITS_HI);
      drawBits();
    }
    if (k === 'time') {
      rules.minuteFrom = rules.minuteTo = -1;
      from.value = '0';
      to.value = String(last);
      drawWindow();
    }
    if (k === 'numbers') {
      idsEl.value = '';
      readIds();
    }
    syncTiles();
    refresh();
  };
  // On the form, not `app`: `app` outlives this render, and a listener left on it by an earlier render would
  // toggle the same rows a second time.
  document.getElementById('create')!.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    const tb = t.closest<HTMLButtonElement>('[data-tab-btn]');
    if (tb) {
      tab = tab === tb.dataset.tabBtn ? '' : tb.dataset.tabBtn!; // tap the open tab to close it
      applyPanes();
      return;
    }
    const clr = t.closest<HTMLButtonElement>('[data-clear-rule]');
    if (clr) {
      clearRule(clr.dataset.clearRule!);
      drawBrushes();
      applyPanes();
    }
  });
  // Each rule's one-line description sits on its heading line.
  app.querySelectorAll<HTMLElement>('.rule[data-pane="who"]').forEach((sec) => {
    const d = sec.querySelector<HTMLElement>(':scope > .rule-desc'), h = sec.querySelector<HTMLElement>('.rule-head');
    if (h && h.firstChild?.nodeType === Node.TEXT_NODE && h.firstChild.textContent!.trim()) {
      const t = document.createElement('span');
      t.className = 'rule-title';
      t.textContent = h.firstChild.textContent!.trim();
      h.replaceChild(t, h.firstChild);
    }
    if (d && h) {
      d.classList.add('inline');
      h.insertBefore(d, h.querySelector('span:not(.rule-title)'));
    }
  });
  // A preset from a trait page: /create?weight=sparse, ?palette=CMYK, ?print=slip, ?eights=3 sets that rule and opens it.
  const q = new URLSearchParams(location.search);
  for (const kind of TRAIT_KINDS) {
    const t = q.has(kind) ? parseTrait(kind, q.get(kind)!) : null;
    if (!t) continue;
    if (kind === 'palette') {
      picked = rules.palettes = 1 << t.v;
    } else if (kind === 'print') rules.prints = t.rules.prints!;
    else if (kind === 'weight') rules.weights = t.rules.weights!;
    else rules.eights = t.rules.eights!;
    tab ||= kind;
  }
  // A window from /time: /create?from=<unix>&to=<unix> (to inclusive), snapped to the minutes.
  const qf = Number(q.get('from')), qt = Number(q.get('to'));
  if (minutes.length && qf > 0 && qt >= qf) {
    setWindow(firstFrom(qf), lastBefore(qt + 1), 'a');
    tab ||= 'time';
  }
  // A range from /rating or /bits: /create?minRating=443.1&maxRating=800, ?minBits=20&maxBits=40.
  const num = (k: string) => (q.has(k) && q.get(k)!.trim() !== '' && Number.isFinite(Number(q.get(k))) ? Number(q.get(k)) : null);
  const [qlo, qhi] = [num('minRating'), num('maxRating')];
  if (qlo !== null || qhi !== null) {
    const lo = Math.max(80, Math.min(800, Math.round((qlo ?? 80) * 10) / 10)), hi = Math.max(lo, Math.min(800, Math.round((qhi ?? 800) * 10) / 10));
    minScoreEl.value = String(lo);
    maxScoreEl.value = String(hi);
    drawScore();
    tab ||= 'rating';
  }
  const [blo, bhi] = [num('minBits'), num('maxBits')];
  if (blo !== null || bhi !== null) {
    const lo = Math.max(BITS_LO, Math.min(BITS_HI, Math.round(blo ?? BITS_LO))), hi = Math.max(lo, Math.min(BITS_HI, Math.round(bhi ?? BITS_HI)));
    minBitsEl.value = String(lo);
    maxBitsEl.value = String(hi);
    drawBits();
    tab ||= 'bits';
  }
  if (tab) {
    syncTiles();
    drawBrushes();
  }

  panesReady = true;
  applyPanes();

  refresh();
  // The factory's numbers: the minimum shown and checked, the fee line, and what Start sends along.
  void factoryRead.then(
    ([m, p, c, t]) => {
      [min, protocolBps, creatorBps, table] = [m, p, c, t];
      factoryIn = true;
      if (go.isConnected) refresh();
    },
    () => {
      const warn = document.getElementById('warn');
      if (warn && go.isConnected) (warn.textContent = 'Couldn’t reach the chain. Refresh to try again.'), (warn.hidden = false);
    },
  );
}
