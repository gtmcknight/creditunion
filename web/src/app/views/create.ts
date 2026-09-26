import { go as navigate } from '../main';
import { decodeEventLog, parseEther } from 'viem';
import { creditsAbi, factoryAbi } from '../abi';
import { config, send, session } from '../chain';
import { INK, maskInks, maskLabel } from '../traits';
import { ARRANGEMENTS, SPLITS, creatorFeeBps, isApproved, minOpen, myCredits, protocolFeeBps, ratings, type Rated } from '../data';
import { paletteBit, TRAITS } from '../traits';
import { $$, art, errText, sheet, toast } from '../ui';
import { LAYOUT_TRAITS, keyOf, ruleFor, slotMark, slotName, type LayoutTrait } from '../../shared/layout';

const CHUNK = 40;
const ARR_HINTS = [
  'In the order they were deposited.',
  'Earliest mint first.',
  'Lowest number first.',
  '',
  'You paint the sheet; the 80 go to Jack’s contract slot by slot.',
];
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
/// A pattern as a tiny 8×10 sheet: brush A dark, brush B light, open slots empty.
const patternIcon = (name: string) => {
  const fn = LAYOUTS[name];
  let r = '';
  for (let i = 0; i < 80; i++) {
    const v = fn(i);
    if (v) r += `<rect x="${(i % 8) * 3}" y="${Math.floor(i / 8) * 3}" width="2.4" height="2.4" fill="${v === 'A' ? 'currentColor' : 'var(--line-strong)'}"/>`;
  }
  return `<svg viewBox="0 0 24 30" aria-hidden="true">${r}</svg>`;
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
const INK_OF = (m: number) => [...'CMYK'].filter((_, b) => m & (1 << b)).map((c) => INKS[c])[0] ?? '#111';
/// A design as a tiny sheet in two colours (B '' leaves those slots open).
const designIcon = (name: string, a: string, b: string) => {
  const fn = LAYOUTS[name];
  let r = '';
  for (let i = 0; i < 80; i++) {
    const v = fn(i);
    const c = v === 'A' ? a : v === 'B' ? b : '';
    r += `<rect x="${(i % 8) * 3}" y="${Math.floor(i / 8) * 3}" width="2.6" height="2.6" fill="${c || '#e9e9e7'}"/>`;
  }
  return `<svg viewBox="0 0 24 30" aria-hidden="true">${r}</svg>`;
};
const fmt = (n: number) => n.toFixed(4).replace(/\.?0+$/, '');
const INKS: Record<string, string> = { C: '#00B5E2', M: '#E4007C', Y: '#FFD100', K: '#111111' };
const PRINTS = TRAITS.print; // Registered … Loose, in contract order
const WEIGHTS = TRAITS.weight; // even lean sparse extreme
const EIGHTS_MAX = 5;

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

const swatch = (p: string) => {
  const inks = [...p].map((ch) => INKS[ch]);
  const stops = inks.map((c, i) => `${c} ${(i / inks.length) * 100}% ${((i + 1) / inks.length) * 100}%`).join(', ');
  return `<i class="ink" style="background:linear-gradient(90deg, ${stops})"></i>`;
};

/// A plate stack: Registered is one square; each misprint kind pushes plates further out of register.
const printGlyph = (name: string) => {
  const offsets: Record<string, [number, number][]> = {
    Registered: [],
    Nudge: [[1, 0]],
    Slip: [[1.5, 0], [0, 1.5]],
    Skew: [[1.5, 0], [-1.5, 1], [0, -1.5]],
    Drift: [[3, 0], [0, 3]],
    Loose: [[3, 1], [-2, 3], [1, -3], [-3, -1]],
  };
  const plates = ['#00B5E2', '#E4007C', '#FFD100', '#111111'];
  const ghosts = (offsets[name] ?? []).map(([x, y], i) => `<rect x="${4 + x}" y="${4 + y}" width="16" height="16" fill="${plates[i]}" opacity=".85"/>`).join('');
  return `<svg viewBox="0 0 24 24" aria-hidden="true">${ghosts}<rect x="4" y="4" width="16" height="16" fill="${offsets[name]?.length ? 'none' : '#111'}" stroke="#111" stroke-width="1.4"/></svg>`;
};

/// Weight as ink coverage: a 6×6 print with even about half inked, lean and sparse lighter, extreme nearly full.
const WEIGHT_FILL: Record<string, number> = { even: 18, lean: 12, sparse: 6, extreme: 33 };
const WEIGHT_ORDER = [14, 21, 3, 28, 9, 34, 0, 17, 25, 6, 31, 12, 19, 1, 26, 8, 33, 15, 22, 4, 29, 10, 35, 2, 18, 27, 7, 32, 13, 20, 5, 24, 11, 30, 16, 23];
const weightGlyph = (name: string) =>
  `<svg viewBox="0 0 24 24" aria-hidden="true">${WEIGHT_ORDER.slice(0, WEIGHT_FILL[name] ?? 0)
    .map((k) => `<rect x="${3 + (k % 6) * 3}" y="${3 + Math.floor(k / 6) * 3}" width="3" height="3" fill="#111"/>`)
    .join('')}<rect x="3" y="3" width="18" height="18" fill="none" stroke="#111" stroke-opacity=".25" stroke-width=".6"/></svg>`;

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
  'When the Statement sells, every Credit gets an equal 1/80 of the sale.',
  'When the Statement sells, earlier deposits get more: the first Credit 1.5×, sliding to 0.5× for the last.',
];
const EIGHT_NAMES = ['none', 'one', 'two', 'three', 'four', 'five'];
const eightsChip = (n: number) => (n === 0 ? 'no 8s' : '8'.repeat(n));

/// Palettes by ink count, one row each (C M Y K · the pairs · the triples · CMYK), in CMYK order within a row.
const inkKey = (p: string) => [...p].map((c) => 'CMYK'.indexOf(c)).join('');
const PALETTE_ROWS = [1, 2, 3, 4].map((n) => TRAITS.colors.filter((p) => p.length === n).sort((a, b) => inkKey(a).localeCompare(inkKey(b))));

/// Paint key: every painted value gets its own colour, used as a ring on its slots and on its brush, so the
/// layout reads at a glance even with real Credits in the slots. Deliberately not the CMYK inks.
const KEY_COLORS = ['#2f6bff', '#ff6a00', '#12a150', '#a24dff', '#00a3a3', '#c79100', '#e11d48', '#0ea5e9', '#7c3aed', '#65a30d', '#db2777', '#0f766e', '#b45309', '#4f46e5', '#15803d', '#be123c'];
const keyColor = (v: number) => KEY_COLORS[(v - 1) % KEY_COLORS.length];
/// How a Colors value prints: the subtractive mix of its inks, as the art draws it.
const MIX_HEX = ['#ffffff', '#00b5e2', '#e4007c', '#00006e', '#ffd100', '#009400', '#e40000', '#111111', '#111111', '#0b1a1f', '#1f0b14', '#0b0b1f', '#1f1b0b', '#0b1f0b', '#1f0b0b', '#111111'];

/// Badge a preview slot with its paint's icon, the same one its brush shows ('' clears it).
function markPaint(cell: HTMLElement, icon: string) {
  cell.querySelector('.paint')?.remove();
  if (icon) cell.insertAdjacentHTML('afterbegin', `<b class="paint">${icon}</b>`);
}

// ---------------------------------------------------------------- page

export async function create(app: HTMLElement) {
  if (!session.account) {
    app.innerHTML = `
    <section class="narrow"><h1>Make Statement Party</h1><p class="lede">Invite everyone to pool their Credits. At 80 they burn into a Statement, it goes to auction, and the sale is split among everyone in.</p>
    <button class="btn primary" data-connect>Connect wallet</button></section>`;
    return;
  }

  const [owned, approved, min, protocolBps, creatorBps, minutes] = await Promise.all([
    myCredits(session.account),
    isApproved(session.account),
    minOpen(),
    protocolFeeBps(),
    creatorFeeBps(),
    fetch('/minutes.json').then((r) => r.json() as Promise<Minutes>).catch(() => [] as Minutes),
  ]);
  const rules: Rules = { palettes: 0, prints: 0, weights: 0, eights: 0, minuteFrom: -1, minuteTo: -1, idFrom: 0, idTo: 0, minScore: 0, maxScore: 0, list: [] };
  const artOf = (id: bigint) => (config.chainId === 1 ? art(id) : `/art/mainnet/${id}.svg`);
  let ghosts: { id: bigint; palette: number; t: number }[] = [];
  let view: 'rules' | 'credits' = 'credits'; // what the sheet shows (see drawPreview)
  let keyGhosts = new Map<number, typeof ghosts>(); // samples per painted value, for the painted preview
  let pattern: 'none' | 'checkered' = 'none';
  const layout: number[] = new Array(80).fill(0); // slot values of the painted trait, 0 = any
  let panesReady = false; // the rule tabs exist (refresh() redraws them once they do)
  let layoutTrait: LayoutTrait = 0; // which trait the sheet is painted with (shared/layout.ts)
  let brushA = 1, brushB = 8; // cyan and black to start
  const picks = new Set<string>();
  const last = Math.max(0, minutes.length - 1);

  // Title and one line across the top; under them the sheet (match count below it) and the form start level.
  app.innerHTML = `
  <header class="create-head"><h1>Make Statement Party</h1><p class="create-lede">Invite everyone to pool their Credits. At 80 they burn into a Statement, it goes to auction, and the sale is split among everyone in. <a href="/">How it works →</a></p></header>
  <section class="design">
    <div class="design-preview">
      <div id="preview">${sheet([])}</div>
      <div class="preview-foot">
        <p class="muted small preview-count">Possible matches: <span class="num" id="st-edition">–</span></p>
        <div class="view-toggle" role="radiogroup" aria-label="Show"><label><input type="radio" name="view" value="rules"><span>Rules</span></label><label><input type="radio" name="view" value="credits" checked><span>Credits</span></label></div>
      </div>
    </div>

    <form id="create" class="design-form" novalidate>
      <h2 class="form-title">Who can join</h2>
      <section class="rule who-bar" data-pane="who">
        <p class="rule-sentence" id="rule-sentence"></p>
        <div class="rule-list" id="add-rule"></div>
      </section>

      <section class="rule" data-tab="eights" data-pane="who"><div class="rule-head">Eights <span class="muted" id="eights-pick">Any</span></div>
        <p class="rule-desc">How many 8s are in its seed.</p>
        <div class="tiles eights" data-rule="eights">${Array.from({ length: EIGHTS_MAX + 1 }, (_, n) => `<button type="button" class="tile" data-bit="${n}" aria-pressed="false" title="${eightsChip(n)}">${eightsPips(n)}<span>${EIGHT_NAMES[n]}</span></button>`).join('')}</div>
      </section>

      <section class="rule" data-tab="weight" data-pane="who"><div class="rule-head">Weight <span class="muted" id="weights-pick">Any</span></div>
        <p class="rule-desc">How much of it is inked.</p>
        <div class="tiles" data-rule="weights">${WEIGHTS.map((w, i) => `<button type="button" class="tile" data-bit="${i}" aria-pressed="false" title="${w}">${weightGlyph(w)}<span>${w}</span></button>`).join('')}</div>
      </section>

      <section class="rule" data-tab="print" data-pane="who"><div class="rule-head">Print <span class="muted" id="prints-pick">Any</span></div>
        <p class="rule-desc">How far its inks slipped.</p>
        <div class="tiles" data-rule="prints">${PRINTS.map((p, i) => `<button type="button" class="tile" data-bit="${i}" aria-pressed="false" title="${p}">${printGlyph(p)}<span>${p}</span></button>`).join('')}</div>
      </section>


      <section class="rule" data-tab="palette" data-pane="who"><div class="rule-head">Colors <span class="muted" id="palettes-pick">Any</span></div>
        <p class="rule-desc">Which inks it uses.</p>
        <div class="tiles palettes" data-rule="palettes">${PALETTE_ROWS.flat().map((p) => `<button type="button" class="tile" data-bit="${paletteBit(p)}" aria-pressed="false" title="${p}">${swatch(p)}<span>${p}</span></button>`).join('')}</div>
      </section>

      <section class="rule" data-tab="time" data-pane="who"><div class="rule-head">Payment Time <span id="win-text">Any time</span></div>
        <p class="rule-desc">When it was paid for.</p>
        <div class="timeline">
          <svg id="hist" viewBox="0 0 120 28" preserveAspectRatio="none" aria-hidden="true"></svg>
          <div class="dual"><input type="range" id="win-from" min="0" max="${last}" value="0" aria-label="Window start"><input type="range" id="win-to" min="0" max="${last}" value="${last}" aria-label="Window end"></div>
        </div>
        <div class="win-presets" id="win-presets"></div>
        <p class="hint" id="win-count" hidden></p>
      </section>

      <section class="rule" data-tab="rating" data-pane="who"><div class="rule-head">Rating <span id="score-text">Any</span></div>
        <p class="rule-desc">Jack’s rating, 80 to 800.</p>
        <div class="timeline">
          <svg id="score-hist" viewBox="0 0 72 28" preserveAspectRatio="none" aria-hidden="true"></svg>
          <div class="dual"><input type="range" id="min-score" min="80" max="800" step="1" value="80" aria-label="Lowest rating"><input type="range" id="max-score" min="80" max="800" step="1" value="800" aria-label="Highest rating"></div>
        </div>
        <div class="axis" id="score-axis">${[80, 200, 400, 600, 800].map((v) => `<button type="button" data-v="${v}" style="left:${((v - 80) / 720) * 100}%" aria-label="Move the nearest handle to ${v}">${v}</button>`).join('')}</div>
      </section>

      <section class="rule" data-tab="numbers" data-pane="who"><div class="rule-head">Token # <span class="muted" id="id-hint">Any</span></div>
        <p class="rule-desc">A range like 1-80, or up to 200 like 1, 4, 5.</p>
        <input id="ids" inputmode="text" placeholder="1-80  or  1, 4, 5, 6" autocomplete="off">
      </section>





      <h2 class="form-title">Settings</h2>
      <div class="rule-list party-list">
        <div class="rrow">
          <label class="rrow-head name-row"><span class="rrow-name">Party name</span><input id="name" type="text" maxlength="64" placeholder="e.g. Cyan Minute" autocomplete="off" data-1p-ignore data-lpignore="true" data-bwignore data-form-type="other"></label>
        </div>
        <div class="rrow" data-prow="terms">
          <div class="rrow-head"><button type="button" class="rrow-toggle" data-party-btn="terms" aria-expanded="false"><span class="rrow-name">Payout</span><span class="rrow-value" id="split-value">Equal</span><svg class="chev" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.5"/></svg></button></div>
          <section class="rule" data-tab="terms" data-pane="terms" hidden>
            <div class="opt-list">${SPLITS.map((l, i) => `<label class="opt"><input type="radio" name="split" value="${i}" ${i === 0 ? 'checked' : ''}><span class="opt-body"><b>${l}</b><span>${PAYOUT_HINTS[i]}</span></span></label>`).join('')}</div>
          </section>
        </div>
        <div class="rrow" data-prow="order">
          <div class="rrow-head"><button type="button" class="rrow-toggle" data-party-btn="order" aria-expanded="false"><span class="rrow-name">Burn order</span><span class="rrow-value" id="order-value">Deposit order</span><svg class="chev" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.5"/></svg></button></div>
      <section class="rule" data-tab="order" data-pane="order" hidden>
        <div class="opt-list">${[0, 1, 2, 4].map((i) => `<label class="opt"><input type="radio" name="arr" value="${i}" ${i === 0 ? 'checked' : ''}><span class="opt-body"><b>${i === 4 ? 'Painted' : ARRANGEMENTS[i]}</b><span>${ARR_HINTS[i]}</span></span></label>`).join('')}</div>
        <div class="paint-block" id="paint-block" hidden>
          <div class="brushes" id="brushes"></div>
          <div class="patterns" id="layout-presets">${['Clear']
          .map((k) => (k === 'Clear' ? `<button type="button" class="link small clear-all" data-layout="Clear">Clear all</button>` : `<button type="button" class="pattern" data-layout="${k}" title="Fill as ${k}" aria-label="${k}">${patternIcon(k)}</button>`))
          .join('')}</div>
          <p class="term-desc muted" id="layout-pick"></p>
          <div class="lgrid" id="lgrid" hidden>${Array.from({ length: 80 }, (_, i) => `<button type="button" class="lcell" data-i="${i}" aria-label="Slot ${i + 1}"></button>`).join('')}</div>
        </div>
      </section>
        </div>
      </div>

      <h2 class="form-title">Your Credits <span class="muted num" id="n">Min ${min}</span><button type="button" class="link small" id="all">Select all that fit</button></h2>
      <section class="rule" data-tab="credits" data-pane="always">
        <div class="picker lg" id="picker">${
          owned.length
            ? owned.map((id) => `<button type="button" class="pick" data-id="${id}" aria-pressed="false" title="Credit #${id}"><img src="${art(id)}" alt="Credit #${id}" loading="lazy"></button>`).join('')
            : `<p class="muted">You don’t hold any Credits.${config.chainId !== 1 ? ' <a href="/mint">Mint test Credits →</a>' : ''}</p>`
        }</div>
      </section>


      <div class="submit">
        <button class="btn primary block" id="go" disabled>Start party</button>
        <p class="hint" id="why"></p>
      </div>
    </form>
  </section>`;

  /// The palette set the contract gets: Colors, narrowed by Plates (how many inks). Plates alone means every
  /// palette with that many inks. The contract has no separate Plates field; this is the same thing.
  const pal = () => rules.palettes;

  // ---------------------------------------------------------------- your Credits' traits (for the live preview)
  const mine = new Map<string, Rated>();
  (async () => {
    // Yield first: with no Credits the loop never awaits, and refresh() would run before it's defined.
    await Promise.resolve();
    for (let i = 0; i < owned.length; i += 200) {
      try {
        const r = await ratings(owned.slice(i, i + 200));
        for (const [id, v] of Object.entries(r.ratings)) mine.set(id, v);
      } catch {}
    }
    refresh();
  })();

  const qualifies = (id: bigint) => {
    const r = mine.get(id.toString());
    if (rules.list.length && !rules.list.includes(Number(id))) return false;
    if (rules.idFrom && Number(id) < rules.idFrom) return false;
    if (rules.idTo && Number(id) > rules.idTo) return false;
    if (rules.minScore && (!r || Math.round(r.score * 10) < rules.minScore)) return false;
    if (rules.maxScore && (!r || Math.round(r.score * 10) > rules.maxScore)) return false;
    if (!r) return !pal() && !rules.prints && !rules.weights && !rules.eights && rules.minuteFrom < 0 && rules.minuteTo < 0;
    if (pal() && !(pal() & (1 << paletteBit(r.traits.palette)))) return false;
    if (rules.prints && !(rules.prints & (1 << PRINTS.indexOf(r.traits.registration as (typeof PRINTS)[number])))) return false;
    if (rules.weights && !(rules.weights & (1 << WEIGHTS.indexOf(weightOf(r) as (typeof WEIGHTS)[number])))) return false;
    if (rules.eights && !(rules.eights & (1 << r.traits.eights))) return false;
    if (rules.minuteFrom >= 0 && r.paidAt < minutes[rules.minuteFrom][0]) return false;
    if (rules.minuteTo >= 0 && r.paidAt > minutes[rules.minuteTo][0] + 59) return false;
    return true;
  };

  // ---------------------------------------------------------------- live preview + counts
  const go = document.getElementById('go') as HTMLButtonElement;
  const why = document.getElementById('why')!;
  let isOk = approved;
  let editionTimer = 0;
  let editionSeq = 0;

  const describe = () => {
    const parts: string[] = [];
    if (rules.palettes) parts.push(`Colors ${TRAITS.colors.filter((p) => rules.palettes & (1 << paletteBit(p))).join(', ')}`);
    if (rules.prints) parts.push(`Print ${PRINTS.filter((_, i) => rules.prints & (1 << i)).join(', ')}`);
    if (rules.weights) parts.push(`Weight ${WEIGHTS.filter((_, i) => rules.weights & (1 << i)).join(', ')}`);
    if (rules.eights) parts.push(`Eights ${Array.from({ length: EIGHTS_MAX + 1 }, (_, n) => n).filter((n) => rules.eights & (1 << n)).join(', ')}`);
    if (rules.minuteFrom >= 0 || rules.minuteTo >= 0) parts.push(document.getElementById('win-text')!.textContent!.replace(/^/, 'Paid '));
    if (rules.minScore || rules.maxScore) parts.push(`Rating ${scoreLabel()}`);
    if (rules.idFrom || rules.idTo) parts.push(rules.idFrom && rules.idTo ? `#${rules.idFrom}–${rules.idTo}` : rules.idFrom ? `#${rules.idFrom}+` : `up to #${rules.idTo}`);
    if (rules.list.length) parts.push(`${rules.list.length} listed`);
    return parts.length ? parts.join(' · ') : 'Any Credit';
  };

  /// The Name field's placeholder: until you type one, it suggests a name from what you've set.
  function drawSummary() {
    const who = describe();
    (document.getElementById('name') as HTMLInputElement).placeholder = who === 'Any Credit' ? 'All Credits' : who.split(' · ')[0];
  }

  /// The button says what it does: how many of your Credits go in.
  const startLabel = () => (picks.size ? `Start party with ${picks.size} ${picks.size === 1 ? 'Credit' : 'Credits'}` : 'Start party');
  function refresh() {
    if (panesReady) applyPanes();
    const fit = owned.filter(qualifies);
    for (const id of [...picks]) if (!fit.some((f) => f.toString() === id)) picks.delete(id);
    drawPreview(fit);
    $$<HTMLButtonElement>('.pick', app).forEach((p) => {
      const ok = fit.some((f) => f.toString() === p.dataset.id);
      p.classList.toggle('off', !ok);
      p.setAttribute('aria-pressed', String(picks.has(p.dataset.id!)));
    });
    document.getElementById('n')!.textContent = picks.size ? `${picks.size} selected` : `Min ${min}`;
    document.getElementById('all')!.hidden = !fit.length;
    const n = picks.size;
    const reason = n < min ? `Select at least ${min} of your qualifying Credits.` : n > 80 ? 'At most 80.' : '';
    // One line under the button: what blocks it, else how it plays out.
    why.innerHTML = reason || `${n > CHUNK ? `${Math.ceil(n / CHUNK)} transactions. ` : ''}Free to start. Take your Credits back anytime before it fills.<br>${Number(protocolBps) / 100}% protocol fee, only if it sells.`;
    go.disabled = !!reason;
    if (!go.dataset.busy) go.textContent = startLabel();
    drawSummary();

    clearTimeout(editionTimer);
    editionTimer = window.setTimeout(async () => {
      const seq = ++editionSeq;
      const el = document.getElementById('st-edition')!;
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
            list: rules.list.slice(0, 200),
          }),
        });
        const d = (await r.json()) as { count?: number; sample?: number[]; palettes?: number[]; traits?: number[] };
        if (seq !== editionSeq) return;
        if (typeof d.count === 'number') el.textContent = d.count.toLocaleString();
        ghosts = (d.sample ?? []).map((id, i) => ({ id: BigInt(id), palette: d.palettes?.[i] ?? 0, t: d.traits?.[i] ?? 0 }));
        // A painted sheet needs samples of each painted value, not just whatever the overall sample holds: ask for
        // each value on its own (the party's rules narrowed to that value), so every painted slot has a Credit.
        keyGhosts = new Map();
        const keys = [...new Set(layout.filter(Boolean))];
        if (keys.length) {
          const base = { palettes: pal(), prints: rules.prints, weights: rules.weights, eights: rules.eights, minuteFrom: rules.minuteFrom, minuteTo: rules.minuteTo, idFrom: rules.idFrom, idTo: rules.idTo, minScore: rules.minScore, maxScore: rules.maxScore, list: rules.list.slice(0, 200) };
          await Promise.all(
            keys.map(async (k) => {
              const narrow = ruleFor(layoutTrait, k);
              const both = (a: number, b?: number) => (b === undefined ? a : a ? a & b : b);
              const body = { ...base, palettes: both(base.palettes, narrow.palettes), eights: both(base.eights, narrow.eights), prints: both(base.prints, narrow.prints), weights: both(base.weights, narrow.weights) };
              const res = await fetch('/edition/match', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
              const e = (await res.json()) as { sample?: number[]; palettes?: number[]; traits?: number[] };
              keyGhosts.set(k, (e.sample ?? []).map((id, i) => ({ id: BigInt(id), palette: e.palettes?.[i] ?? 0, t: e.traits?.[i] ?? 0 })));
            }),
          ).catch(() => {});
          if (seq !== editionSeq) return;
        }
        drawPreview(owned.filter(qualifies));
      } catch {
        if (seq === editionSeq) el.textContent = '–';
      }
    }, 200);
  }

  // ---------------------------------------------------------------- trait tiles (tap to pick, tap again to clear)
  /// Your qualifying Credits solid, then real matching Credits from the edition, faded, up to 80.
  /// The checkered design alternates the two palettes so the pattern is visible before anyone joins.
  function drawPreview(fit: bigint[]) {
    const mineIds = fit.slice(0, 80);
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
      for (let i = mineIds.length; i < 80; i++) {
        const want = layout[i];
        const g = want ? pools.get(want)?.shift() : leftovers().shift();
        // No sample left for this palette: keep the slot empty (its paint still shows) rather than stop.
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
      preview.innerHTML = `<div class="sheet lg rules-sheet">${layout.map((v) => `<i class="cell rule-cell">${v ? glyphFor(layoutTrait, v) : ''}</i>`).join('')}</div>`;
      return;
    }
    preview.innerHTML = sheet(mineIds, {
      mine: picks,
      ghosts: rest.slice(0, 80 - mineIds.length).map((g) => ({ id: g.id, src: g.id ? artOf(g.id) : '' })),
    });
  }
  function setView(v: 'rules' | 'credits') {
    view = v;
    app.querySelector<HTMLInputElement>(`input[name=view][value=${v}]`)!.checked = true;
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
    const counts = new Map<number, number>();
    for (const m of layout) if (m) counts.set(m, (counts.get(m) ?? 0) + 1);
    document.getElementById('layout-pick')!.textContent = painted
      ? [...counts.entries()].map(([m, n]) => `${n} ${slotName(layoutTrait, m)}`).join(' · ') + (anyOpen ? ` · ${layout.filter((m) => !m).length} open` : '')
      : '';
    pattern = 'none';
    syncTiles();
    refresh();
  };
  const paint = (i: number, m: number) => {
    if (layout[i] === m) return;
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
  let picked = 0; // Colors chosen on the tiles (palette bits)

  // Brushes come from the rules you added: each paintable rule is a group of its picked values (all of them when
  // none are picked). With no paintable rule added, Colors are offered. One trait per sheet.
  const PAINTABLE: [string, LayoutTrait][] = [['palette', 0], ['eights', 1], ['print', 2], ['weight', 3]];
  const valuesOf = (t: LayoutTrait): number[] => {
    if (t === 0) {
      const set = pal();
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
    return PAINTABLE.filter(([k, t]) => set[k] && valuesOf(t).length); // only what you picked above, with something in it
  };
  /// Key colours are handed out across every brush on screen, in order, so no two brushes share one.
  function keyOfPaint(t: number, v: number) {
    let n = 0;
    for (const [, g] of groups()) {
      for (const x of valuesOf(g)) {
        if (g === t && x === v) return KEY_COLORS[n % KEY_COLORS.length];
        n++;
      }
    }
    return KEY_COLORS[(v - 1) % KEY_COLORS.length];
  }
  /// The two values a design fills with: your brush and the one before it (or the next picked value), else open.
  const pair = (): [number, number] => {
    const vals = valuesOf(layoutTrait);
    const A = brush && vals.includes(brush) ? brush : vals[0] ?? 0;
    const B = brushB && brushB !== A && vals.includes(brushB) ? brushB : vals.find((v) => v !== A) ?? 0;
    return [A, B];
  };
  const paintHex = (v: number) => (layoutTrait === 0 ? MIX_HEX[v] : keyOfPaint(layoutTrait, v));
  /// Two rows of ready-made designs, drawn in the colours they'd paint with.
  const gallery = (colours: (a: number, b: number) => [string, string]) =>
    `<div class="paint-designs">${DESIGNS.map(([n, a, b], i) => {
      const [ca, cb] = colours(a, b);
      return `<button type="button" class="paint-design" data-design="${i}" aria-label="${n}">${designIcon(n, ca, cb)}<span>${n}</span></button>`;
    }).join('')}</div>`;
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
    if (!gs.length) {
      document.getElementById('brushes')!.innerHTML = `<p class="term-desc">Pick Colors, Eights, Print, Weight or Plates above to paint with them, or start from a design.</p>
        ${gallery((a, b) => [MIX_HEX[a], MIX_HEX[b]])}`;
      app.querySelector<HTMLElement>('#layout-presets')!.hidden = true;
      if (wiped) syncLayout();
      return;
    }
    app.querySelector<HTMLElement>('#layout-presets')!.hidden = false;
    if (!gs.some(([, t]) => t === layoutTrait)) layoutTrait = gs[0][1];
    if (brush && !valuesOf(layoutTrait).includes(brush)) brush = valuesOf(layoutTrait)[0] ?? 0;
    const erase = `<button type="button" class="brush erase" data-trait="${layoutTrait}" data-v="0" title="Paint slots back to any Credit" aria-pressed="${brush === 0}">Erase</button>`;
    // One row per trait you picked; erase leads the first row.
    // One category at a time: pick it, then its brushes. A sheet paints with one trait, so the choice is explicit.
    const withSeg = gs.length > 1
      ? `<div class="paint-with"><span class="eyebrow">Paint with</span><div class="seg sm">${gs.map(([, t]) => `<label><input type="radio" name="paint-with" value="${t}" ${t === layoutTrait ? 'checked' : ''}><span>${LAYOUT_TRAITS[t]}</span></label>`).join('')}</div>${layout.some(Boolean) ? '<span class="muted small">Switching clears the sheet.</span>' : ''}</div>`
      : `<div class="paint-with"><span class="eyebrow">Paint with ${LAYOUT_TRAITS[gs[0][1]]}</span></div>`;
    document.getElementById('brushes')!.innerHTML =
      withSeg +
      `<span class="brush-group">${valuesOf(layoutTrait)
        .map((v) => `<button type="button" class="brush" data-trait="${layoutTrait}" data-v="${v}" title="${slotName(layoutTrait, v)}" aria-label="${slotName(layoutTrait, v)}" aria-pressed="${v === brush}">${glyphFor(layoutTrait, v)}</button>`)
        .join('')}</span>` +
      gallery(() => { const [A, B] = pair(); return [paintHex(A), B ? paintHex(B) : '']; }) + `<div class="paint-tools">${erase}</div>`;
    if (wiped) syncLayout();
  }
  let painting = false;
  lgrid.addEventListener('pointerdown', (e) => {
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
  document.getElementById('brushes')!.addEventListener('click', (e) => {
    const d = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-design]');
    if (d) {
      // A design paints the sheet in two Colors and adds them to Who can join, so their brushes appear.
      const [name, dA, dB] = DESIGNS[Number(d.dataset.design)];
      let A = dA, B = dB;
      if (groups().length) [A, B] = pair(); // fill with what you picked
      else {
        layoutTrait = 0;
        picked |= (1 << A) | (1 << B);
        rules.palettes = picked;
      }
      const fn = LAYOUTS[name];
      for (let i = 0; i < 80; i++) {
        const v = fn(i);
        layout[i] = v === 'A' ? A : v === 'B' ? B : 0;
        paintCell(i);
      }
      brush = brushA = A;
      if (B) brushB = B;
      drawBrushes();
      syncLayout();
      return;
    }
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
  document.getElementById('layout-presets')!.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-layout]');
    if (!b) return;
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
        rules.palettes = picked;
      } else rules[key] ^= 1 << Number(btn.dataset.bit); // tap to add, tap again to remove
      pattern = 'none';
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
  const fmtDT = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const fmtT = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
  const tz = new Intl.DateTimeFormat(undefined, { timeZoneName: 'short' }).formatToParts(new Date()).find((p) => p.type === 'timeZoneName')?.value ?? '';
  const drawWindow = () => {
    const a = Number(from.value), b = Number(to.value);
    const any = !minutes.length || (a === 0 && b === last);
    rules.minuteFrom = any ? -1 : a;
    rules.minuteTo = any ? -1 : b;
    if (any) {
      winText.textContent = 'Any time';
      winCount.textContent = minutes.length ? `${minutes.reduce((s, [, c]) => s + c, 0).toLocaleString()} Credits` : '';
    } else {
      const start = new Date(minutes[a][0] * 1000), end = new Date((minutes[b][0] + 60) * 1000);
      winText.textContent = `${fmtDT.format(start)} – ${start.toDateString() === end.toDateString() ? fmtT.format(end) : fmtDT.format(end)} ${tz}`;
      let n = 0;
      for (let i = a; i <= b; i++) n += minutes[i][1];
      winCount.textContent = `${n.toLocaleString()} Credit${n === 1 ? '' : 's'}`;
    }
    document.querySelectorAll<HTMLButtonElement>('#win-presets [data-i]').forEach((btn) =>
      btn.setAttribute('aria-pressed', String(btn.dataset.i === 'any' ? any : Number(btn.dataset.i) === a && a === b)),
    );
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
  const presets = document.getElementById('win-presets')!;
  const eighty = minutes.map((m, i) => [m, i] as const).filter(([m]) => m[1] === 80);
  // Shortcuts to the minutes when exactly 80 Credits were paid for: one party's worth. Clearing is the row's ×.
  presets.innerHTML = eighty.length
    ? `<span class="muted small">80 paid in one minute:</span>${eighty
        .map(([m, i]) => `<button type="button" data-i="${i}" title="Exactly 80 Credits were paid for in this minute">${fmtT.format(new Date(m[0] * 1000))}</button>`)
        .join('')}`
    : '';
  presets.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-i]');
    if (!btn) return;
    if (btn.dataset.i === 'any') {
      from.value = '0';
      to.value = String(last);
    } else from.value = to.value = btn.dataset.i!;
    drawWindow();
    refresh();
  });
  drawWindow();

  // ---------------------------------------------------------------- rating
  const minScoreEl = document.getElementById('min-score') as HTMLInputElement;
  // Rating as a range over its distribution, like the mint window. Ratings are ranks spread over 80–800,
  // so the bars are nearly flat: every 10 points holds about the same number of Credits.
  const maxScoreEl = document.getElementById('max-score') as HTMLInputElement;
  const scoreHist = document.getElementById('score-hist')!;
  const scoreBins = new Array(72).fill(0);
  let scorePeak = 1;
  fetch('/scores.bin')
    .then((r) => r.arrayBuffer())
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
    rules.minScore = lo > 80 ? lo * 10 : 0;
    rules.maxScore = hi < 800 ? hi * 10 : 0;
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
      hint.textContent = out.size > 200 ? 'Over 200: use one range, or list fewer' : `${out.size} listed`;
    } else hint.textContent = 'Any';
    refresh();
  };
  idsEl.addEventListener('input', readIds);

  // ---------------------------------------------------------------- picker, order, fee
  const pickerEl = document.getElementById('picker')!;
  pickerEl.classList.toggle('scrolls', pickerEl.scrollHeight > pickerEl.clientHeight + 24);
  pickerEl.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('.pick');
    if (!b || b.classList.contains('off')) return;
    picks.has(b.dataset.id!) ? picks.delete(b.dataset.id!) : picks.add(b.dataset.id!);
    refresh();
  });
  document.getElementById('all')!.addEventListener('click', () => {
    picks.clear();
    owned.filter(qualifies).slice(0, 80).forEach((id) => picks.add(id.toString()));
    refresh();
  });
  app.querySelectorAll<HTMLInputElement>('input[name=split]').forEach((r) =>
    r.addEventListener('change', () => (document.getElementById('split-value')!.textContent = SPLITS[Number(r.value)])),
  );
  // Name, order, payout and deadline changes update the recap and the step marks.
  document.getElementById('create')!.addEventListener('input', drawSummary);
  document.getElementById('create')!.addEventListener('change', drawSummary);
  // Painted is a burn order: picking it opens the painter (brushes from your rules, paint on the sheet itself);
  // leaving it clears the paint.
  const paintBlock = document.getElementById('paint-block')!;
  const preview = document.getElementById('preview')!;
  const syncOrder = () => {
    const on = arrRadios.find((r) => r.checked)?.value === '4';
    paintBlock.hidden = !on;
    preview.classList.toggle('paintable', on);
    setView(on ? 'rules' : 'credits');
    if (on) drawBrushes();
    else if (layout.some(Boolean)) app.querySelector<HTMLButtonElement>('[data-layout="Clear"]')?.click();
  };
  app.querySelectorAll<HTMLInputElement>('input[name=view]').forEach((r) => r.addEventListener('change', () => setView(r.value as 'rules' | 'credits')));
  app.querySelectorAll<HTMLInputElement>('input[name=arr]').forEach((r) =>
    r.addEventListener('change', () => {
      document.getElementById('order-value')!.textContent = r.value === '4' ? 'Painted' : ARRANGEMENTS[Number(r.value)];
      syncOrder();
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
    const days = 90; // required by the factory, no longer enforced: open parties don't expire, full ones unlock after 7 days
    const chosen = Number((app.querySelector('input[name=arr]:checked') as HTMLInputElement).value);
    const arr = chosen === 4 && !layout.some(Boolean) ? 0 : chosen; // Painted with nothing painted burns in deposit order
    const split = Number((app.querySelector('input[name=split]:checked') as HTMLInputElement).value);
    const ids = [...picks].map(BigInt);
    const f = {
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
      bitsFrom: 0, // Bits rule: supported by the contract, not offered here yet
      bitsTo: 0,
      layoutTrait: layout.some(Boolean) ? layoutTrait : 0,
    };
    go.disabled = true;
    go.dataset.busy = '1'; // progress labels below own the button until this finishes
    try {
      // First party from this wallet: the factory needs permission to move your Credits, once.
      if (!isOk) {
        go.textContent = 'Allow Eighty to move your Credits…';
        await send({ address: config.credits, abi: creditsAbi, functionName: 'setApprovalForAll', args: [config.factory, true] });
        isOk = true;
      }
      go.textContent = 'Opening…';
      const receipt = await send({
        address: config.factory,
        abi: factoryAbi,
        functionName: 'create',
        // The fees shown on this page go along: the open reverts if they changed underneath you.
        args: [name, f, rules.list.map(BigInt), reserve, arr, split, BigInt(days * 86400), ids.slice(0, CHUNK), BigInt(protocolBps), BigInt(creatorBps)],
      });
      const ev = receipt.logs
        .map((l) => {
          try {
            return decodeEventLog({ abi: factoryAbi, ...l });
          } catch {
            return null;
          }
        })
        .find((x) => x?.eventName === 'BatchCreated');
      const batch = (ev?.args as { batch: `0x${string}` }).batch;
      for (let i = CHUNK; i < ids.length; i += CHUNK) {
        go.textContent = `Depositing ${i}–${Math.min(i + CHUNK, ids.length)}…`;
        await send({ address: config.factory, abi: factoryAbi, functionName: 'deposit', args: [batch, ids.slice(i, i + CHUNK)] });
      }
      toast('Party opened.', 'ok');
      navigate(`/party/${batch}`);
    } catch (x) {
      toast(errText(x), 'err', 8000);
      delete go.dataset.busy;
      go.textContent = startLabel();
      refresh();
    }
  });

  // Sections: who can join, order, terms. Rules start hidden; you add the ones you want, and each
  // added rule can be removed (which also clears it).
  const RULES: Record<string, string> = { eights: 'Eights', weight: 'Weight', print: 'Print', palette: 'Colors', time: 'Time', rating: 'Rating', numbers: 'Token' };
  const sections = [...app.querySelectorAll<HTMLElement>('.rule[data-pane]')];
  const added = new Set<string>();
  const isSet = (): Record<string, boolean> => ({
    palette: !!rules.palettes, print: !!rules.prints, weight: !!rules.weights, eights: !!rules.eights,
    time: rules.minuteFrom >= 0 || rules.minuteTo >= 0, numbers: !!(rules.idFrom || rules.idTo) || rules.list.length > 0, rating: rules.minScore > 0 || rules.maxScore > 0,
  });
  // Rules as one list, like a settings page: every rule is a row showing its value ("Any" when unset, a × to
  // clear it when set). Tapping a row opens its editor inside it; one open at a time.
  let tab = ''; // the open row, none to start
  const PICK: Record<string, string> = { eights: 'eights-pick', weight: 'weights-pick', print: 'prints-pick', palette: 'palettes-pick', time: 'win-text', rating: 'score-text', numbers: 'id-hint' };
  const list = document.getElementById('add-rule')!;
  // Build the rows once and move each rule's editor into its row, so opening one never re-renders the others.
  for (const [k, l] of Object.entries(RULES)) {
    const row = document.createElement('div');
    row.className = 'rrow';
    row.dataset.row = k;
    row.innerHTML = `<div class="rrow-head"><button type="button" class="rrow-toggle" data-tab-btn="${k}" aria-expanded="false"><span class="rrow-name">${l}</span><span class="rrow-value"></span><svg class="chev" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.5"/></svg></button><button type="button" class="rrow-clear" data-clear-rule="${k}" aria-label="Clear ${l}" hidden>×</button></div>`;
    const sec = sections.find((x) => x.dataset.tab === k && x.dataset.pane === 'who');
    if (sec) row.append(sec);
    list.append(row);
  }
  /// The rules as one plain sentence: any of the picks within a rule (or), every rule at once (and).
  const INK_WORD: Record<string, string> = { C: 'cyan', M: 'magenta', Y: 'yellow', K: 'black' };
  const or = (xs: string[]) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} or ${xs[xs.length - 1]}`);
  const bitsOf = (m: number, n: number) => Array.from({ length: n }, (_, i) => i).filter((i) => m & (1 << i));
  const sentence = () => {
    const parts: string[] = [];
    if (rules.palettes) parts.push(`is ${or(TRAITS.colors.filter((p) => rules.palettes & (1 << paletteBit(p))).map((p) => [...p].map((c) => INK_WORD[c]).join('+')))}`);
    if (rules.eights) parts.push(`has ${or(bitsOf(rules.eights, 9).map(String))} eights`);
    if (rules.weights) parts.push(`has ${or(bitsOf(rules.weights, 4).map((i) => WEIGHTS[i]))} weight`);
    if (rules.prints) parts.push(`has a ${or(bitsOf(rules.prints, 6).map((i) => PRINTS[i]))} print`);
    if (rules.minuteFrom >= 0 || rules.minuteTo >= 0) parts.push(`was paid ${document.getElementById('win-text')?.textContent ?? ''}`);
    if (rules.minScore || rules.maxScore) parts.push(`is rated ${document.getElementById('score-text')?.textContent ?? ''}`);
    if (rules.idFrom || rules.idTo || rules.list.length) parts.push(`is ${document.getElementById('id-hint')?.textContent ?? ''}`);
    return parts.length ? `A Credit can join if it ${parts.join(', and it ')}.` : 'Any Credit can join.';
  };
  const applyPanes = () => {
    document.getElementById('rule-sentence')!.textContent = sentence();
    const set = isSet();
    for (const row of list.querySelectorAll<HTMLElement>('.rrow')) {
      const k = row.dataset.row!;
      const open = k === tab;
      const sec = row.querySelector<HTMLElement>('.rule');
      if (sec) sec.hidden = !open;
      row.classList.toggle('open', open);
      row.classList.toggle('set', !!set[k]);
      row.querySelector('.rrow-toggle')!.setAttribute('aria-expanded', String(open));
      row.querySelector('.rrow-value')!.textContent = set[k] ? (document.getElementById(PICK[k])?.textContent ?? '') : 'Any';
      row.querySelector<HTMLElement>('.rrow-clear')!.hidden = !set[k];
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
    const pb = t.closest<HTMLButtonElement>('[data-party-btn]');
    if (pb) {
      // The party's rows open like the rules do, one at a time.
      const k = pb.dataset.partyBtn!;
      app.querySelectorAll<HTMLElement>('[data-prow]').forEach((row) => {
        const open = row.dataset.prow === k && !row.classList.contains('open');
        row.classList.toggle('open', open);
        row.querySelector('.rrow-toggle')!.setAttribute('aria-expanded', String(open));
        row.querySelector<HTMLElement>(':scope > .rule')!.hidden = !open;
      });
      return;
    }
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
  panesReady = true;
  applyPanes();

  refresh();
}
