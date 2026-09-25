import { go as navigate } from '../main';
import { decodeEventLog, parseEther } from 'viem';
import { creditsAbi, factoryAbi } from '../abi';
import { config, send, session } from '../chain';
import { pct } from '../ens';
import { INK, maskInks, maskLabel } from '../traits';
import { ARRANGEMENTS, SPLITS, creatorFeeBps, isApproved, minOpen, myCredits, protocolFeeBps, ratings, type Rated } from '../data';
import { paletteBit, TRAITS } from '../traits';
import { $$, art, errText, esc, sheet, toast } from '../ui';

const CHUNK = 40;
const ARR_HINTS = [
  'In the order Credits are deposited.',
  'Earliest mint first.',
  'Lowest number first.',
  'You arrange the sheet once it fills. You have one day.',
  'Follows your painted layout.',
];
/// Layout presets: which slots take brush A, brush B, or stay open (any palette).
const LAYOUTS: Record<string, (i: number) => 'A' | 'B' | 0> = {
  Checkered: (i) => ((Math.floor(i / 8) + (i % 8)) % 2 === 0 ? 'A' : 'B'),
  Stripes: (i) => (Math.floor(i / 8) % 2 === 0 ? 'A' : 'B'),
  Columns: (i) => (i % 2 === 0 ? 'A' : 'B'),
  Border: (i) => (Math.floor(i / 8) === 0 || Math.floor(i / 8) === 9 || i % 8 === 0 || i % 8 === 7 ? 'A' : 'B'),
  Diagonal: (i) => (Math.abs(Math.floor(i / 8) - (i % 8) - 1) <= 1 ? 'A' : 'B'),
  Solid: () => 'A',
  Clear: () => 0,
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

/// Tint a preview slot with the palette painted there (0 clears it).
function markPaint(cell: HTMLElement, m: number) {
  cell.querySelector('.paint')?.remove();
  if (m) cell.insertAdjacentHTML('afterbegin', `<b class="paint">${maskInks(m).map((c) => `<i style="background:${c}"></i>`).join('')}</b>`);
}

// ---------------------------------------------------------------- page

export async function create(app: HTMLElement) {
  if (!session.account) {
    app.innerHTML = `<a class="back" href="/">← Parties</a>
    <section class="narrow"><h1>Make Statement Party</h1><p class="lede">Set the rules, the order and the payout.</p>
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
  let plates = 0; // Plates rule: bit n for n inks; narrows Colors (see pal())
  const rules: Rules = { palettes: 0, prints: 0, weights: 0, eights: 0, minuteFrom: -1, minuteTo: -1, idFrom: 0, idTo: 0, minScore: 0, maxScore: 0, list: [] };
  const artOf = (id: bigint) => (config.chainId === 1 ? art(id) : `/art/mainnet/${id}.svg`);
  let ghosts: { id: bigint; palette: number }[] = [];
  let pattern: 'none' | 'checkered' = 'none';
  const layout: number[] = new Array(80).fill(0); // palette mask per slot, 0 = any
  let brushA = 1, brushB = 8; // cyan and black to start
  const picks = new Set<string>();
  const last = Math.max(0, minutes.length - 1);

  // The title sits over the sheet, the match count under it; the form's first heading lines up with the
  // sheet's top edge.
  app.innerHTML = `
  <section class="design">
    <div class="design-preview">
      <div class="preview-title"><h1>Make Statement Party</h1></div>
      <div id="preview">${sheet([])}</div>
      <p class="muted small preview-count">Possible matches: <span class="num" id="st-edition">–</span></p>
    </div>

    <form id="create" class="design-form" novalidate>
      <h2 class="form-title">Who can join</h2>
      <section class="rule who-bar" data-pane="who">
        <div class="chips presets" id="add-rule"></div>
        <p class="rule-desc" id="and-hint" hidden>A Credit must match every rule. Within a rule, any selected option counts.</p>
      </section>

      <section class="rule" data-tab="eights" data-pane="who"><div class="rule-head">Eights <span class="muted" id="eights-pick">Any</span></div>
        <p class="rule-desc">How many 8s are in the Credit’s seed.</p>
        <div class="tiles eights" data-rule="eights">${Array.from({ length: EIGHTS_MAX + 1 }, (_, n) => `<button type="button" class="tile" data-bit="${n}" aria-pressed="false" title="${eightsChip(n)}">${eightsPips(n)}<span>${EIGHT_NAMES[n]}</span></button>`).join('')}</div>
      </section>

      <section class="rule" data-tab="weight" data-pane="who"><div class="rule-head">Weight <span class="muted" id="weights-pick">Any</span></div>
        <p class="rule-desc">How close a Credit is to half inked: even is closest, extreme is nearly empty or nearly full.</p>
        <div class="chips presets" data-rule="weights">${WEIGHTS.map((w, i) => `<button type="button" data-bit="${i}" aria-pressed="false">${w}</button>`).join('')}</div>
      </section>

      <section class="rule" data-tab="print" data-pane="who"><div class="rule-head">Print <span class="muted" id="prints-pick">Any</span></div>
        <p class="rule-desc">Misprints: how far the ink layers slipped out of line.</p>
        <div class="tiles" data-rule="prints">${PRINTS.map((p, i) => `<button type="button" class="tile" data-bit="${i}" aria-pressed="false" title="${p}">${printGlyph(p)}<span>${p}</span></button>`).join('')}</div>
      </section>

      <section class="rule" data-tab="plates" data-pane="who"><div class="rule-head">Plates <span class="muted" id="plates-pick">Any</span></div>
        <p class="rule-desc">How many inks a Credit is printed with.</p>
        <div class="chips presets" id="plates">${[1, 2, 3, 4].map((n) => `<button type="button" data-plates="${n}" aria-pressed="false">${n}</button>`).join('')}</div>
      </section>

      <section class="rule" data-tab="palette" data-pane="who"><div class="rule-head">Colors <span class="muted" id="palettes-pick">Any</span></div>
        <p class="rule-desc">The inks a Credit is printed in: cyan, magenta, yellow, black.</p>
        <div class="tiles palettes" data-rule="palettes">${PALETTE_ROWS.map((row) => `<div class="tile-row">${row.map((p) => `<button type="button" class="tile" data-bit="${paletteBit(p)}" aria-pressed="false" title="${p}">${swatch(p)}<span>${p}</span></button>`).join('')}</div>`).join('')}</div>
      </section>

      <section class="rule" data-tab="time" data-pane="who"><div class="rule-head">Payment Time <span id="win-text">Any time</span></div>
        <p class="rule-desc">When the Credit was paid for during the mint.</p>
        <div class="timeline">
          <svg id="hist" viewBox="0 0 120 28" preserveAspectRatio="none" aria-hidden="true"></svg>
          <div class="dual"><input type="range" id="win-from" min="0" max="${last}" value="0" aria-label="Window start"><input type="range" id="win-to" min="0" max="${last}" value="${last}" aria-label="Window end"></div>
        </div>
        <div class="chips presets" id="win-presets"></div>
        <p class="hint" id="win-count" hidden></p>
      </section>

      <section class="rule" data-tab="rating" data-pane="who"><div class="rule-head">Rating <span id="score-text">Any</span></div>
        <p class="rule-desc">Jack’s official rating, 80–800.</p>
        <div class="timeline">
          <svg id="score-hist" viewBox="0 0 72 28" preserveAspectRatio="none" aria-hidden="true"></svg>
          <div class="dual"><input type="range" id="min-score" min="80" max="800" step="1" value="80" aria-label="Lowest rating"><input type="range" id="max-score" min="80" max="800" step="1" value="800" aria-label="Highest rating"></div>
        </div>
        <div class="axis" id="score-axis">${[80, 200, 400, 600, 800].map((v) => `<button type="button" data-v="${v}" style="left:${((v - 80) / 720) * 100}%" aria-label="Move the nearest handle to ${v}">${v}</button>`).join('')}</div>
      </section>

      <section class="rule" data-tab="numbers" data-pane="who"><div class="rule-head">Token # <span class="muted" id="id-hint">Any</span></div>
        <p class="rule-desc">A range like 1-80, or a list like 1, 4, 5, 6 (up to 200).</p>
        <input id="ids" inputmode="text" placeholder="1-80  or  1, 4, 5, 6" autocomplete="off">
      </section>





      <h2 class="form-title">Order</h2>
      <section class="rule terms" data-tab="order" data-pane="order">
        <div class="seg sm">${ARRANGEMENTS.map((l, i) => (i === 3 ? '' : `<label><input type="radio" name="arr" value="${i}" ${i === 0 ? 'checked' : ''}><span>${l}</span></label>`)).join('')}</div>
        <p class="term-desc" id="arr-hint">${ARR_HINTS[0]}</p>
      </section>

      <section class="rule" data-tab="layout" data-pane="order" hidden><div class="rule-head">Paint <span class="muted" id="layout-pick">None</span></div>
        <p class="rule-desc">Paint the sheet on the left. Each painted slot only takes that palette, and the Statement burns as painted.</p>
        <div class="chips presets" id="layout-presets">${Object.keys(LAYOUTS).map((k) => `<button type="button" data-layout="${k}">${k}</button>`).join('')}</div>
        <div class="brushes" id="brushes">${[0, ...TRAITS.colors.map(paletteBit)].map((m) => `<button type="button" class="brush" data-brush="${m}" title="${maskLabel(m)}" aria-pressed="${m === 1}">${m ? maskInks(m).map((c) => `<i style="background:${c}"></i>`).join('') : '<span>any</span>'}</button>`).join('')}</div>
        <div class="lgrid" id="lgrid" hidden>${Array.from({ length: 80 }, (_, i) => `<button type="button" class="lcell" data-i="${i}" aria-label="Slot ${i + 1}"></button>`).join('')}</div>
      </section>

      <h2 class="form-title">Terms</h2>
      <section class="rule terms" data-tab="terms" data-pane="terms">
        <div class="seg sm">${SPLITS.map((l, i) => `<label><input type="radio" name="split" value="${i}" ${i === 0 ? 'checked' : ''}><span>${l} payout</span></label>`).join('')}</div>
        <p class="term-desc" id="split-hint">${PAYOUT_HINTS[0]}</p>
      </section>

      <h2 class="form-title">Your Credits <span class="muted num" id="n">Min ${min}</span><button type="button" class="link small" id="all">Select all that fit</button></h2>
      <section class="rule" data-tab="credits" data-pane="always">
        <div class="picker lg" id="picker">${
          owned.length
            ? owned.map((id) => `<button type="button" class="pick" data-id="${id}" aria-pressed="false" title="Credit #${id}"><img src="${art(id)}" alt="Credit #${id}" loading="lazy"></button>`).join('')
            : `<p class="muted">You don’t hold any Credits.${config.chainId !== 1 ? ' <a href="/mint">Mint test Credits →</a>' : ''}</p>`
        }</div>
      </section>

      <h2 class="form-title"><label for="name">Name</label></h2>
      <section class="rule" data-tab="name" data-pane="always"><input id="name" maxlength="64" placeholder="e.g. Cyan Minute" autocomplete="off"></section>

      <div class="submit">
        <p class="summary" id="summary"></p>
        <button class="btn primary" id="go" disabled>Start party</button>
        <p class="hint" id="why"></p>
        <p class="hint next">Others join until there are 80. Anyone can leave until then. At 80 it locks for up to 7 days while it burns into a Statement → 24h auction → the sale is split 80 ways. Not burned in 7 days? Anyone can take their Credits back.</p>
        <p class="hint">Sale split: ${protocolBps ? `${pct(protocolBps)} protocol · ` : ''}${creatorBps ? `${pct(creatorBps)} creator · ` : ''}${pct(10_000 - protocolBps - creatorBps)} to depositors.</p>
      </div>
    </form>
  </section>`;

  /// The palette set the contract gets: Colors, narrowed by Plates (how many inks). Plates alone means every
  /// palette with that many inks. The contract has no separate Plates field; this is the same thing.
  const pal = () => {
    if (!plates) return rules.palettes;
    const byPlates = TRAITS.colors.filter((p) => plates & (1 << p.length)).reduce((m, p) => m | (1 << paletteBit(p)), 0);
    return rules.palettes ? rules.palettes & byPlates : byPlates;
  };

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
    if (plates) parts.push(`Plates ${[1, 2, 3, 4].filter((n) => plates & (1 << n)).join(', ')}`);
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

  /// The recap above the button and the preview's title card.
  function drawSummary() {
    const name = (document.getElementById('name') as HTMLInputElement).value.trim();
    const arr = Number((app.querySelector('input[name=arr]:checked') as HTMLInputElement | null)?.value ?? 0);
    const split = Number((app.querySelector('input[name=split]:checked') as HTMLInputElement | null)?.value ?? 0);
    const who = describe();
    // Named last: until you type one, the field suggests a name from what you've set.
    const suggestion = who === 'Any Credit' ? 'Open house' : who.split(' · ')[0];
    (document.getElementById('name') as HTMLInputElement).placeholder = suggestion;
    document.getElementById('summary')!.innerHTML = [
      `<strong>${esc(name || suggestion)}</strong>`,
      who === 'Any Credit' ? 'any Credit can join' : esc(who.charAt(0).toLowerCase() + who.slice(1)),
      `burned ${['in deposit order', 'by mint time', 'by Credit number', 'in your order', 'as painted'][arr]}`,
      `${SPLITS[split].toLowerCase()} payout`,
      picks.size ? `you deposit ${picks.size}` : 'pick your Credits',
    ].join(' · ');
  }

  function refresh() {
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
    why.textContent = reason || (n > CHUNK ? `${Math.ceil(n / CHUNK)} transactions` : '');
    go.disabled = !!reason;
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
        const d = (await r.json()) as { count?: number; sample?: number[]; palettes?: number[] };
        if (seq !== editionSeq) return;
        if (typeof d.count === 'number') el.textContent = d.count.toLocaleString();
        ghosts = (d.sample ?? []).map((id, i) => ({ id: BigInt(id), palette: d.palettes?.[i] ?? 0 }));
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
      for (const g of rest) pools.set(g.palette, [...(pools.get(g.palette) ?? []), g]);
      const out: typeof rest = [];
      const leftovers = () => [...pools.values()].flat();
      for (let i = mineIds.length; i < 80; i++) {
        const want = layout[i];
        const g = want ? pools.get(want)?.shift() : leftovers().shift();
        // No sample left for this palette: keep the slot empty (its paint still shows) rather than stop.
        if (!g) {
          out.push({ id: 0n, palette: 0 });
          continue;
        }
        if (!want) pools.set(g.palette, (pools.get(g.palette) ?? []).filter((x) => x !== g));
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
    document.getElementById('preview')!.innerHTML = sheet(mineIds, {
      mine: picks,
      ghosts: rest.slice(0, 80 - mineIds.length).map((g) => ({ id: g.id, src: g.id ? artOf(g.id) : '' })),
    });
    // Painted slots show their palette behind the art, so the layout reads on the sheet itself.
    if (painted) document.querySelectorAll<HTMLElement>('#preview .sheet > *').forEach((c, k) => markPaint(c, layout[k]));
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
    cells[i].innerHTML = m ? maskInks(m).map((c) => `<i style="background:${c}"></i>`).join('') : '';
    cells[i].classList.toggle('on', !!m);
  };
  /// A painted layout sets the palette rule to the union of its colours (the contract enforces the slots
  /// themselves) and forces the Layout arrangement; clearing it hands both back.
  const syncLayout = () => {
    const painted = layout.some(Boolean);
    const anyOpen = layout.some((m) => !m);
    const used = layout.reduce((s, m) => (m ? s | (1 << paletteBit([...'CMYK'].filter((_, b) => m & (1 << b)).join(''))) : s), 0);
    rules.palettes = painted && !anyOpen ? used : 0;
    const counts = new Map<number, number>();
    for (const m of layout) if (m) counts.set(m, (counts.get(m) ?? 0) + 1);
    document.getElementById('layout-pick')!.textContent = painted
      ? [...counts.entries()].map(([m, n]) => `${n} ${maskLabel(m)}`).join(' · ') + (anyOpen ? ` · ${layout.filter((m) => !m).length} open` : '')
      : 'None';
    if (painted) arrRadios.find((r) => r.value === '4')!.checked = true;
    document.getElementById('arr-hint')!.textContent = ARR_HINTS[Number(arrRadios.find((r) => r.checked)!.value)];
    app.querySelector<HTMLElement>('[data-rule="palettes"]')!.classList.toggle('locked', painted);
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
    if (cell) markPaint(cell as HTMLElement, layout[i]);
  };
  let brush = brushA;
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
  document.getElementById('brushes')!.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-brush]');
    if (!b) return;
    const m = Number(b.dataset.brush);
    if (m !== brush && brush) brushB = brush; // remember the previous colour for two-tone presets
    brush = m;
    if (m) brushA = m;
    document.querySelectorAll<HTMLButtonElement>('#brushes [data-brush]').forEach((x) => x.setAttribute('aria-pressed', String(Number(x.dataset.brush) === m)));
  });
  document.getElementById('layout-presets')!.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-layout]');
    if (!b) return;
    const fn = LAYOUTS[b.dataset.layout!];
    for (let i = 0; i < 80; i++) {
      const v = fn(i);
      layout[i] = v === 'A' ? brushA : v === 'B' ? (brushB === brushA ? 8 : brushB) : 0;
      paintCell(i);
    }
    syncLayout();
  });

  for (const key of SET_KEYS) {
    app.querySelector<HTMLElement>(`[data-rule="${key}"]`)!.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-bit]');
      if (!btn) return;
      if (key === 'palettes' && layout.some(Boolean)) return toast('Palettes are set by your layout. Clear it to pick freely.', 'info');
      rules[key] ^= 1 << Number(btn.dataset.bit); // tap to add, tap again to remove
      pattern = 'none';
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
  presets.innerHTML = `<button type="button" data-i="any">Any time</button>${eighty
    .map(([m, i]) => `<button type="button" data-i="${i}" title="Exactly 80 Credits were paid for in this minute">80 · ${fmtT.format(new Date(m[0] * 1000))}</button>`)
    .join('')}`;
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

  // ---------------------------------------------------------------- plates
  const drawPlates = () => {
    app.querySelectorAll<HTMLButtonElement>('[data-plates]').forEach((b) => b.setAttribute('aria-pressed', String(!!(plates & (1 << Number(b.dataset.plates))))));
    document.getElementById('plates-pick')!.textContent = plates ? [1, 2, 3, 4].filter((n) => plates & (1 << n)).join(', ') : 'Any';
  };
  document.getElementById('plates')!.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-plates]');
    if (!b) return;
    plates ^= 1 << Number(b.dataset.plates);
    drawPlates();
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
  document.getElementById('picker')!.addEventListener('click', (e) => {
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
    r.addEventListener('change', () => (document.getElementById('split-hint')!.textContent = PAYOUT_HINTS[Number(r.value)])),
  );
  // Name, order, payout and deadline changes update the recap and the step marks.
  app.addEventListener('input', drawSummary);
  app.addEventListener('change', drawSummary);
  // Layout is an order: picking it opens the painter (on the sheet itself); leaving it clears the paint.
  const layoutSec = app.querySelector<HTMLElement>('.rule[data-tab="layout"]')!;
  const preview = document.getElementById('preview')!;
  const syncOrder = () => {
    const isLayout = arrRadios.find((r) => r.checked)?.value === '4';
    layoutSec.dataset.show = String(isLayout);
    layoutSec.hidden = !isLayout;
    preview.classList.toggle('paintable', isLayout);
  };
  app.querySelectorAll<HTMLInputElement>('input[name=arr]').forEach((r) =>
    r.addEventListener('change', () => {
      document.getElementById('arr-hint')!.textContent = ARR_HINTS[Number(r.value)];
      if (r.value !== '4' && layout.some(Boolean)) app.querySelector<HTMLButtonElement>('[data-layout="Clear"]')?.click();
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
    const arr = Number((app.querySelector('input[name=arr]:checked') as HTMLInputElement).value);
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
    };
    go.disabled = true;
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
      go.textContent = 'Start party';
      refresh();
    }
  });

  // Sections: who can join, order, terms. Rules start hidden; you add the ones you want, and each
  // added rule can be removed (which also clears it).
  const RULES: Record<string, string> = { eights: 'Eights', weight: 'Weight', print: 'Print', plates: 'Plates', palette: 'Colors', time: 'Payment Time', rating: 'Rating', numbers: 'Token #' };
  const sections = [...app.querySelectorAll<HTMLElement>('.rule[data-pane]')];
  const added = new Set<string>();
  const isSet = (): Record<string, boolean> => ({
    palette: !!rules.palettes, plates: !!plates, print: !!rules.prints, weight: !!rules.weights, eights: !!rules.eights,
    time: rules.minuteFrom >= 0 || rules.minuteTo >= 0, numbers: !!(rules.idFrom || rules.idTo) || rules.list.length > 0, rating: rules.minScore > 0 || rules.maxScore > 0,
  });
  const applyPanes = () => {
    sections.forEach((sec) => {
      const p = sec.dataset.pane!;
      sec.hidden =
        (p === 'who' && sec.dataset.tab !== undefined && !sec.classList.contains('who-bar') && !added.has(sec.dataset.tab)) || (sec.dataset.tab === 'layout' && sec.dataset.show !== 'true');
    });
    document.getElementById('and-hint')!.hidden = added.size < 2;
    const n = app.querySelector<HTMLElement>('[data-pane-count="who"]');
    if (n) n.textContent = added.size ? String(added.size) : '';
    // Every rule keeps its chip: tap to turn it on (its editor opens below, in the same order), tap again to
    // turn it off and clear it. Nothing jumps or disappears.
    document.getElementById('add-rule')!.innerHTML = Object.entries(RULES)
      .map(([k, l]) => `<button type="button" data-add-rule="${k}" aria-pressed="${added.has(k)}">${l}</button>`)
      .join('');
  };
  const clearRule = (k: string) => {
    if (k === 'palette') rules.palettes = 0;
    if (k === 'plates') {
      plates = 0;
      drawPlates();
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
  app.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    const add = t.closest<HTMLButtonElement>('[data-add-rule]');
    if (add) {
      const k = add.dataset.addRule!;
      if (added.has(k)) {
        added.delete(k);
        clearRule(k);
      } else added.add(k);
      applyPanes();
      if (added.has(k)) app.querySelector(`.rule[data-tab="${k}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      return;
    }
  });
  applyPanes();

  refresh();
}
