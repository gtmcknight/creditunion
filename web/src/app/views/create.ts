import { go as navigate } from '../main';
import { dice, printGlyph, swatch, weightGlyph } from '../glyphs';
import { decodeEventLog, parseEther } from 'viem';
import { creditsAbi, factoryAbi } from '../abi';
import { canBatch, config, send, sendBatch, session } from '../chain';
import { INK, maskInks, maskLabel } from '../traits';
import { SPLITS, creatorFeeBps, isApproved, minOpen, myCredits, protocolFeeBps, ratings, type Rated } from '../data';
import { paletteBit, TRAITS } from '../traits';
import { $$, art, errText, esc, fromLocalInput, sheet, toast, toLocalInput } from '../ui';
import { LAYOUT_TRAITS, keyOf, ruleFor, slotMark, slotName, type LayoutTrait } from '../../shared/layout';
import { bitsPath, ratingPath, setPath, timePath } from '../../shared/trait';
import { editionArt } from '../ghosts';
import { Room, booksOf, noRoomReason } from '../slots';
import { bin } from '../bins';
import { TRAIT_KINDS, parseTrait } from '../../shared/trait';

const CHUNK = 40;
/// The layouts a new party can pick, by the contract's burn-order number (1 Mint time and 3 Creator's order are retired).
const ARR_OPTS: [number, string, string][] = [
  [0, 'Deposit', 'In the order they were deposited.'],
  [2, 'Number ↑', 'By Credit number (token ID), lowest to highest.'],
  [5, 'Number ↓', 'By Credit number (token ID), highest to lowest.'],
  [4, 'Painted', 'You paint the sheet; each Credit goes to its slot.'],
];
/// A 4×5 thumbnail per layout: shade steps show the order the sheet fills in.
const arrIcon = (v: number) => {
  const cells = Array.from({ length: 20 }, (_, i) => {
    const k = v === 2 ? i : v === 5 ? 19 - i : v === 0 ? [3, 11, 7, 15, 0, 18, 9, 5, 13, 1, 16, 6, 10, 2, 19, 8, 14, 4, 17, 12][i] : -1;
    const fill = v === 4 ? ([0, 3, 5, 6, 9, 10, 13, 14, 16, 19].includes(i) ? '#00b5e2' : '#e4007c') : `rgba(17,17,17,${(0.12 + (0.88 * (19 - k)) / 19).toFixed(2)})`;
    return `<rect x="${(i % 4) * 7}" y="${((i / 4) | 0) * 7}" width="6" height="6" fill="${fill}"/>`;
  }).join('');
  return `<svg viewBox="0 0 27 34" aria-hidden="true">${cells}</svg>`;
};
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
    <section class="narrow"><h1>Start a Credit Union</h1><p class="lede">Set the rules, add your Credits, invite everyone. At 80 they burn into a Statement and everyone in splits the sale.</p>
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
    <div class="design-preview">
      <div id="preview">${sheet([])}</div>
      <div class="preview-foot">
        <div class="view-toggle" role="radiogroup" aria-label="Show" hidden><label><input type="radio" name="view" value="rules"><span>Rules</span></label><label><input type="radio" name="view" value="credits" checked><span>Credits</span></label></div>
        <span class="muted small num" id="layout-pick"></span>
      </div>
    </div>

    <form id="create" class="design-form" novalidate>
      <h2 class="form-title">Who can join <button type="button" class="link small join-count" id="see-eligible"><span class="num" id="st-edition">–</span> <span id="st-edition-label">eligible</span></button></h2>
      <section class="rule who-bar" data-pane="who">
        <p class="rule-sentence" id="rule-sentence"></p>
        <div class="rule-list" id="add-rule"></div>
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
        <div class="win-inputs"><label><span>Start</span><input type="datetime-local" id="win-start" step="60"></label><label><span>End</span><input type="datetime-local" id="win-end" step="60"></label></div>
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





      <h2 class="form-title">Layout</h2>
      <section class="rule layout-opts" data-tab="order" data-pane="order">
        <div class="arr-tiles" role="radiogroup" aria-label="Layout">${ARR_OPTS.map(([v, l, h]) => `<label class="arr-tile" title="${h}"><input type="radio" name="arr" value="${v}" ${v === 0 ? 'checked' : ''}>${arrIcon(v)}<b>${l}</b></label>`).join('')}</div>
        <p class="term-desc muted" id="arr-hint">${ARR_OPTS[0][2]}</p>
        <div class="paint-block" id="paint-block" hidden>
          <div class="brushes" id="brushes"></div>
          <div class="paint-bar">
            <p class="term-desc muted" id="paint-hint">Pick a color, then click or drag on the sheet.</p>
          </div>
          <div id="designs"></div>
          <div class="lgrid" id="lgrid" hidden>${Array.from({ length: 80 }, (_, i) => `<button type="button" class="lcell" data-i="${i}" aria-label="Slot ${i + 1}"></button>`).join('')}</div>
        </div>
      </section>

      <h2 class="form-title">Settings</h2>
      <div class="rule-list party-list">
        <div class="rrow">
          <label class="rrow-head name-row"><span class="rrow-name">Name</span><input id="name" type="text" maxlength="64" placeholder="e.g. Cyan Minute" autocomplete="off" data-1p-ignore data-lpignore="true" data-bwignore data-form-type="other"></label>
        </div>
        <div class="rrow" data-prow="terms">
          <div class="rrow-head"><button type="button" class="rrow-toggle" data-party-btn="terms" aria-expanded="false"><span class="rrow-name">Payout</span><span class="rrow-value" id="split-value">Equal</span><svg class="chev" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.5"/></svg></button></div>
          <section class="rule" data-tab="terms" data-pane="terms" hidden>
            <div class="opt-list">${SPLITS.map((l, i) => `<label class="opt"><input type="radio" name="split" value="${i}" ${i === 0 ? 'checked' : ''}><span class="opt-body"><b>${l}</b><span>${PAYOUT_HINTS[i]}</span></span></label>`).join('')}</div>
          </section>
        </div>
      </div>

      <h2 class="form-title">Deposit Credits <span class="muted num" id="n">Min ${min}</span><button type="button" class="link small" id="all">Select all that fit</button></h2>
      <section class="rule" data-tab="credits" data-pane="always">
        <div class="picker lg" id="picker">${
          owned.length
            ? owned.map((id) => `<button type="button" class="pick" data-id="${id}" aria-pressed="false" title="Credit #${id}"><img src="${art(id)}" alt="Credit #${id}" loading="lazy"></button>`).join('')
            : `<p class="muted">You don’t hold any Credits.${config.chainId !== 1 ? ' <a href="/mint">Mint test Credits →</a>' : ''}</p>`
        }</div>
        <p class="muted small" id="picker-none" hidden>None of your Credits fit these rules.</p>
        <details class="picker-off" id="picker-off-wrap" hidden><summary class="muted small" id="picker-off-sum"></summary><div class="picker lg" id="picker-off"></div></details>
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
  let isOk = approved;
  if (!approved) void canBatch(); // ask early, so Start doesn't wait on the wallet
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
    if (rules.list.length) parts.push(`${rules.list.length} listed`);
    return parts.length ? parts.join(' · ') : 'Any Credit';
  };

  /// The Name field's placeholder: until you type one, it suggests a name from what you've set.
  function drawSummary() {
    const who = describe();
    (document.getElementById('name') as HTMLInputElement).placeholder = who === 'Any Credit' ? 'All Credits' : who.split(' · ')[0];
  }

  /// The button says what it does: how many of your Credits go in.
  const startLabel = () => (picks.size ? `Start Credit Union with ${picks.size} ${picks.size === 1 ? 'Credit' : 'Credits'}` : 'Start Credit Union');
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

  function refresh() {
    if (panesReady) applyPanes();
    drawSee();
    const fit = owned.filter(qualifies);
    for (const id of [...picks]) if (!fit.some((f) => f.toString() === id)) picks.delete(id);
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
      document.getElementById('picker-none')!.hidden = fit.length > 0;
      const wrap = document.getElementById('picker-off-wrap')!;
      wrap.hidden = offCount === 0;
      document.getElementById('picker-off-sum')!.textContent = `You also have ${offCount} ${offCount === 1 ? 'Credit' : 'Credits'} that don’t fit these rules`;
    }
    document.getElementById('n')!.textContent = picks.size ? `${picks.size} selected` : `Min ${min}`;
    document.getElementById('all')!.hidden = !fit.length;
    const n = picks.size;
    const over = overPainted();
    // The contract refuses rules that can never admit 80.
    const tooNarrow = rules.list.length && rules.list.length < 80 ? 'A named list needs at least 80 Credits.'
      : rules.idTo && rules.idTo - rules.idFrom + 1 < 80 ? 'A number range needs at least 80 numbers.' : '';
    const short = eligible >= 0 && eligible < 80 ? `Only ${eligible} ${eligible === 1 ? 'Credit' : 'Credits'} can ever join, and a Credit Union needs 80. Widen the rules.` : '';
    const reason = tooNarrow || short || (n < min ? `Select at least ${min} of your qualifying Credits.` : n > 80 ? 'At most 80.' : over ? overText(over) : '');
    // One line under the button: what blocks it, else how it plays out.
    // What blocks Start sits above it as a warning; the line under it always says how it plays out.
    const warn = document.getElementById('warn')!;
    warn.textContent = reason;
    warn.hidden = !reason;
    why.innerHTML = `${n > CHUNK ? `${Math.ceil(n / CHUNK)} transactions. ` : ''}Free to start a Credit Union. Withdraw your Credits anytime until it fills and locks.<br>${Number(protocolBps) / 100}% protocol fee, only if it sells. Unofficial and experimental.`;
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
          document.getElementById('st-edition-label')!.textContent = d.count === d.total ? 'Credits, all eligible' : d.count === 1 ? 'eligible Credit' : 'eligible Credits';
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
      return `<button type="button" class="paint-design" data-design="${i}" aria-label="${n}" title="${n}">${designIcon(n, ca, cb)}</button>`;
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
      document.getElementById('brushes')!.innerHTML = `<p class="term-desc">Pick Colors, Eights, Print or Weight above to paint with them, or start from a design.</p>
        ${gallery((a, b) => [MIX_HEX[a], MIX_HEX[b]])}`;
      app.querySelector<HTMLElement>('.paint-bar')!.hidden = true;
      document.getElementById('designs')!.innerHTML = '';
      if (wiped) syncLayout();
      return;
    }
    app.querySelector<HTMLElement>('.paint-bar')!.hidden = false;
    if (!gs.some(([, t]) => t === layoutTrait)) layoutTrait = gs[0][1];
    if (brush && !valuesOf(layoutTrait).includes(brush)) brush = valuesOf(layoutTrait)[0] ?? 0;
    // One row per trait you picked; erase leads the first row.
    // One category at a time: pick it, then its brushes. A sheet paints with one trait, so the choice is explicit.
    const withSeg = gs.length > 1
      ? `<div class="paint-with"><span class="eyebrow">Paint with</span><div class="seg sm">${gs.map(([, t]) => `<label><input type="radio" name="paint-with" value="${t}" ${t === layoutTrait ? 'checked' : ''}><span>${LAYOUT_TRAITS[t]}</span></label>`).join('')}</div>${layout.some(Boolean) ? '<span class="muted small">Switching clears the sheet.</span>' : ''}</div>`
      : `<div class="paint-with"><span class="eyebrow">Paint with ${LAYOUT_TRAITS[gs[0][1]]}</span></div>`;
    document.getElementById('brushes')!.innerHTML =
      withSeg +
      `<div class="paint-swatches"><span class="brush-group">${valuesOf(layoutTrait)
        .map((v) => `<button type="button" class="brush" data-trait="${layoutTrait}" data-v="${v}" title="${slotName(layoutTrait, v)}" aria-label="${slotName(layoutTrait, v)}" aria-pressed="${v === brush}">${glyphFor(layoutTrait, v)}</button>`)
        .join('')}</span><button type="button" class="link small clear-all" data-layout="Clear">Clear all</button></div>`;
    document.getElementById('designs')!.innerHTML =
      `<span class="eyebrow">Or start from a design</span>` + gallery(() => { const [A, B] = pair(); return [paintHex(A), B ? paintHex(B) : '']; });
    if (wiped) syncLayout();
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
    const d = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-design]');
    if (d) {
      // A design paints the sheet in two Colors and adds them to Who can join, so their brushes appear.
      const [name, dA, dB] = DESIGNS[Number(d.dataset.design)];
      let A = dA, B = dB;
      if (groups().length) [A, B] = pair(); // fill with what you picked
      else {
        layoutTrait = 0;
        designAdded |= ((1 << A) | (1 << B)) & ~picked; // remembered so Clear all can take them back off
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
    if (minutes.length) {
      // Start is the first minute's start; End is where the last minute ends (exclusive), as the heading says.
      startIn.value = toLocalInput(minutes[a][0]);
      endIn.value = toLocalInput(minutes[b][0] + 60);
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
  if (minutes.length) {
    startIn.min = endIn.min = toLocalInput(minutes[0][0]);
    startIn.max = endIn.max = toLocalInput(minutes[last][0] + 60);
  }
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
  startIn.addEventListener('change', () => {
    const t = fromLocalInput(startIn.value);
    if (t === null) return drawWindow();
    setWindow(firstFrom(t), Number(to.value), 'a');
    refresh();
  });
  endIn.addEventListener('change', () => {
    const t = fromLocalInput(endIn.value);
    if (t === null) return drawWindow();
    setWindow(Number(from.value), lastBefore(t), 'b');
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
  bin('scores.bin')
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
    if (!b || b.classList.contains('off') || b.classList.contains('full')) return;
    picks.has(b.dataset.id!) ? picks.delete(b.dataset.id!) : picks.add(b.dataset.id!);
    refresh();
  });
  document.getElementById('all')!.addEventListener('click', () => {
    picks.clear();
    const room = capacity();
    for (const id of owned.filter(qualifies)) if (room.take(keyOfMine(id.toString()))) picks.add(id.toString());
    refresh();
  });
  app.querySelectorAll<HTMLInputElement>('input[name=split]').forEach((r) =>
    r.addEventListener('change', () => (document.getElementById('split-value')!.textContent = SPLITS[Number(r.value)])),
  );
  // Name, order, payout and deadline changes update the recap and the step marks.
  document.getElementById('create')!.addEventListener('input', drawSummary);
  document.getElementById('create')!.addEventListener('change', drawSummary);
  // Painted is a layout: picking it opens the painter (brushes from your rules, paint on the sheet itself);
  // leaving it clears the paint.
  const paintBlock = document.getElementById('paint-block')!;
  const preview = document.getElementById('preview')!;
  const syncOrder = () => {
    const v = arrRadios.find((r) => r.checked)?.value;
    document.getElementById('arr-hint')!.textContent = ARR_OPTS.find(([x]) => String(x) === v)?.[2] ?? '';
    const on = v === '4';
    paintBlock.hidden = !on;
    // Rules only mean something slot by slot on a painted sheet; otherwise every slot takes the same Credits.
    app.querySelector<HTMLElement>('.view-toggle')!.hidden = !on;
    preview.classList.toggle('paintable', on);
    setView(on ? 'rules' : 'credits');
    if (on) drawBrushes();
    else if (layout.some(Boolean)) {
      layout.fill(0);
      for (let i = 0; i < 80; i++) paintCell(i);
      syncLayout();
    }
  };
  app.querySelectorAll<HTMLInputElement>('input[name=view]').forEach((r) => r.addEventListener('change', () => setView(r.value as 'rules' | 'credits')));
  arrRadios.forEach((r) => r.addEventListener('change', syncOrder));
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
      bitsFrom: rules.bitsFrom,
      bitsTo: rules.bitsTo,
      layoutTrait: layout.some(Boolean) ? layoutTrait : 0,
    };
    go.disabled = true;
    go.dataset.busy = '1'; // progress labels below own the button until this finishes
    try {
      const open = {
        address: config.factory,
        abi: factoryAbi,
        functionName: 'create',
        // The fees shown on this page go along: the open reverts if they changed underneath you.
        args: [name, f, rules.list.map(BigInt), reserve, arr, split, BigInt(days * 86400), ids.slice(0, CHUNK), BigInt(protocolBps), BigInt(creatorBps)],
      };
      const approve = { address: config.credits, abi: creditsAbi, functionName: 'setApprovalForAll', args: [config.factory, true] };
      let logs: { address: string; data: `0x${string}`; topics: readonly `0x${string}`[] }[];
      if (!isOk && (await canBatch())) {
        // First party from this wallet, and the wallet batches: approve and open in one step.
        go.textContent = 'Opening…';
        const receipts = await sendBatch([approve, open]);
        isOk = true;
        logs = receipts.flatMap((r) => r.logs);
      } else {
        // First party from this wallet: the factory needs permission to move your Credits, once.
        if (!isOk) {
          go.textContent = 'Allow Credit Union to move your Credits…';
          await send(approve);
          isOk = true;
        }
        go.textContent = 'Opening…';
        logs = (await send(open)).logs;
      }
      // Only the factory's own logs: any contract the call touched could emit a look-alike BatchCreated.
      const ev = logs
        .filter((l) => l.address.toLowerCase() === config.factory.toLowerCase())
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
        await send({ address: config.factory, abi: factoryAbi, functionName: 'deposit', args: [batch, ids.slice(i, i + CHUNK)] });
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
  const RULES: Record<string, string> = { eights: 'Eights', weight: 'Weight', print: 'Print', palette: 'Colors', time: 'Time', rating: 'Rating', bits: 'Bits', numbers: 'Token' };
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
    d.innerHTML = `<div class="eligible-head"><div><h3>${esc(total ?? '')} eligible</h3><p class="rule-sentence">${sentence()}</p></div><button type="button" class="btn sm" data-close>Close</button></div><div class="eligible-grid"></div><button type="button" class="btn block" data-more hidden>Show more</button>`;
    document.body.append(d);
    d.showModal();
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
    const close = () => { d.close(); d.remove(); };
    d.addEventListener('click', (e) => {
      const t = e.target as HTMLElement;
      if (t === d || t.closest('[data-close]')) close();
      else if (t.closest('[data-more]')) load();
    });
    d.addEventListener('cancel', (e) => { e.preventDefault(); close(); });
    await load();
  };
  document.getElementById('see-eligible')!.addEventListener('click', (e) => { e.preventDefault(); openEligible(); });
  /// The picked values as small chips, each with the same glyph its tile uses; null for rules without glyphs.
  const chips = (k: string): string | null => {
    const bits = (m: number, n: number) => Array.from({ length: n }, (_, i) => i).filter((i) => m & (1 << i));
    const chip = (g: string, l: string) => `<span class="vchip">${g}<span>${esc(l)}</span></span>`;
    if (k === 'palette') return bits(pal(), 16).map((m) => chip(swatch(slotName(0, m)), slotName(0, m))).join('');
    if (k === 'print') return bits(rules.prints, PRINTS.length).map((i) => chip(printGlyph(PRINTS[i]), PRINTS[i])).join('');
    if (k === 'weight') return bits(rules.weights, WEIGHTS.length).map((i) => chip(weightGlyph(WEIGHTS[i]), WEIGHTS[i])).join('');
    if (k === 'eights') return bits(rules.eights, EIGHTS_MAX + 1).map((n) => chip(dice(n), `${n}×8`)).join('');
    return null;
  };
  const applyPanes = () => {
    document.getElementById('rule-sentence')!.innerHTML = sentence();
    const set = isSet();
    for (const row of list.querySelectorAll<HTMLElement>('.rrow')) {
      const k = row.dataset.row!;
      const open = k === tab;
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
}
