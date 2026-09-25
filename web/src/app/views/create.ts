import { decodeEventLog, parseEther } from 'viem';
import { creditsAbi, factoryAbi } from '../abi';
import { config, send, session } from '../chain';
import { ARRANGEMENTS, isApproved, minOpen, myCredits, protocolFeeBps, ratings, type Rated } from '../data';
import { hashTrait, TRAITS } from '../traits';
import { $$, art, errText, esc, sheet, toast } from '../ui';

const CHUNK = 40;
const ARR_HINTS = [
  'The 80 appear on the Statement in the order they were deposited.',
  'Sorted by when each Credit was paid for, earliest first.',
  'Sorted by Credit number, lowest first.',
  'You arrange the sheet once it’s full: by rating, mint time, number, or by hand. If you haven’t burned within a day of filling, anyone can burn in deposit order.',
];
const fmt = (n: number) => n.toFixed(4).replace(/\.?0+$/, '');
const DURATIONS = [7, 14, 30, 60, 90];
const INKS: Record<string, string> = { C: '#00B5E2', M: '#E4007C', Y: '#FFD100', K: '#111111' };
const PRINTS = TRAITS.print; // Registered … Loose, in contract order
const WEIGHTS = TRAITS.weight; // even lean sparse extreme
const EIGHTS_MAX = 5;

type Minutes = [number, number][];

/// The rules being designed. Traits hold the contract's label strings ('' = any).
type Rules = {
  palette: string;
  print: string;
  weight: string;
  eights: string;
  minuteFrom: number; // index into minutes, -1 = any
  minuteTo: number;
  idFrom: number;
  idTo: number;
  list: number[];
};

const paletteMask = (p: string) => [...'CMYK'].reduce((m, ch, b) => (p.includes(ch) ? m | (1 << b) : m), 0);
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
  const ghosts = (offsets[name] ?? []).map(([x, y], i) => `<rect x="${7 + x}" y="${7 + y}" width="10" height="10" fill="${plates[i]}" opacity=".85"/>`).join('');
  return `<svg viewBox="0 0 24 24" aria-hidden="true">${ghosts}<rect x="7" y="7" width="10" height="10" fill="${offsets[name]?.length ? 'none' : '#111'}" stroke="#111" stroke-width="1.2"/></svg>`;
};

/// Dot density: a fixed 6×6 pattern at each weight's share of marks.
const weightGlyph = (name: string) => {
  const share = { sparse: 0.34, lean: 0.45, even: 0.5, extreme: 0.72 }[name] ?? 0.5;
  let s = '';
  for (let i = 0; i < 36; i++) {
    const h = ((i * 2654435761) >>> 0) % 1000; // deterministic scatter
    if (h / 1000 < share) s += `<rect x="${(i % 6) * 4}" y="${Math.floor(i / 6) * 4}" width="3" height="3" fill="#111"/>`;
  }
  return `<svg viewBox="-0.5 -0.5 24 24" aria-hidden="true">${s}</svg>`;
};

const eightsChip = (n: number) => (n === 0 ? 'no 8s' : '8'.repeat(n));

// ---------------------------------------------------------------- page

export async function create(app: HTMLElement) {
  if (!session.account) {
    app.innerHTML = `<a class="back" href="#/">← Batches</a>
    <section class="narrow"><h1>Design a batch</h1><p class="lede">Decide who can join, how the sheet is ordered, and what you charge. Start with 10 or more of your Credits; anyone can leave until 80.</p>
    <button class="btn primary" data-connect>Connect wallet</button></section>`;
    return;
  }

  const [owned, approved, min, protocolBps, minutes] = await Promise.all([
    myCredits(session.account),
    isApproved(session.account),
    minOpen(),
    protocolFeeBps(),
    fetch('/minutes.json').then((r) => r.json() as Promise<Minutes>).catch(() => [] as Minutes),
  ]);
  const rules: Rules = { palette: '', print: '', weight: '', eights: '', minuteFrom: -1, minuteTo: -1, idFrom: 0, idTo: 0, list: [] };
  const picks = new Set<string>();
  const last = Math.max(0, minutes.length - 1);

  app.innerHTML = `<a class="back" href="#/">← Batches</a>
  <section class="design">
    <div class="design-preview">
      <div id="preview">${sheet([])}</div>
      <div class="design-stats">
        <div><strong class="num" id="st-mine">–</strong><span class="muted small">of your ${owned.length} qualify</span></div>
        <div><strong class="num" id="st-edition">–</strong><span class="muted small">across the edition</span></div>
      </div>
      <p class="design-rules muted small" id="rules-text">Any Credit</p>
    </div>

    <form id="create" class="design-form" novalidate>
      <header><h1>Design a batch</h1><p class="lede">Tap rules to see who fits. Everything here is fixed once the batch opens, and shown to everyone before they join.</p></header>

      <section class="rule"><label class="rule-head" for="name">Name</label><input id="name" maxlength="64" placeholder="e.g. Cyan Minute" autocomplete="off"></section>

      <section class="rule"><div class="rule-head">Palette <span class="muted" id="palette-pick">Any</span></div>
        <div class="tiles" data-rule="palette">${TRAITS.colors.map((p) => `<button type="button" class="tile" data-v="${p}" aria-pressed="false" title="${p}">${swatch(p)}<span>${p}</span></button>`).join('')}</div>
      </section>

      <section class="rule"><div class="rule-head">Print <span class="muted" id="print-pick">Any</span></div>
        <div class="tiles" data-rule="print">${PRINTS.map((p) => `<button type="button" class="tile" data-v="${p}" aria-pressed="false" title="${p}">${printGlyph(p)}<span>${p}</span></button>`).join('')}</div>
      </section>

      <section class="rule"><div class="rule-head">Weight <span class="muted" id="weight-pick">Any</span></div>
        <div class="tiles" data-rule="weight">${WEIGHTS.map((w) => `<button type="button" class="tile" data-v="${w}" aria-pressed="false" title="${w}">${weightGlyph(w)}<span>${w}</span></button>`).join('')}</div>
      </section>

      <section class="rule"><div class="rule-head">Eights <span class="muted" id="eights-pick">Any</span></div>
        <div class="chips presets" data-rule="eights">${Array.from({ length: EIGHTS_MAX + 1 }, (_, n) => `<button type="button" data-v="${TRAITS.eights[n]}" aria-pressed="false">${eightsChip(n)}</button>`).join('')}</div>
      </section>

      <section class="rule"><div class="rule-head">Paid during <span id="win-text">Any time</span></div>
        <div class="timeline">
          <svg id="hist" viewBox="0 0 120 28" preserveAspectRatio="none" aria-hidden="true"></svg>
          <div class="dual"><input type="range" id="win-from" min="0" max="${last}" value="0" aria-label="Window start"><input type="range" id="win-to" min="0" max="${last}" value="${last}" aria-label="Window end"></div>
        </div>
        <div class="chips presets" id="win-presets"></div>
        <p class="hint" id="win-count">Drag the handles over the mint. Each bar is a minute.</p>
      </section>

      <section class="rule"><div class="rule-head">Credit numbers <span class="muted" id="id-hint">Any</span></div>
        <div class="pair"><label class="select"><span>From</span><input id="id-from" inputmode="numeric" placeholder="1"></label><label class="select"><span>To</span><input id="id-to" inputmode="numeric" placeholder="122154"></label></div>
      </section>

      <section class="rule"><div class="rule-head">Only these Credits <span class="muted" id="allow-hint">No list</span></div>
        <textarea id="allow" rows="2" placeholder="Credit numbers, separated by spaces or commas · up to 200"></textarea>
      </section>

      <section class="rule"><div class="rule-head">Order on the Statement</div>
        <div class="seg wrap">${ARRANGEMENTS.map((l, i) => `<label><input type="radio" name="arr" value="${i}" ${i === 0 ? 'checked' : ''}><span>${l}</span></label>`).join('')}</div>
        <p class="hint" id="arr-hint">${ARR_HINTS[0]}</p>
      </section>

      <section class="rule split3">
        <div><div class="rule-head">Your fee</div><div class="field"><input id="cfee" inputmode="decimal" placeholder="0" autocomplete="off"><span>%</span></div><p class="hint" id="cfee-hint">0–10 % of the sale.</p></div>
        <div><div class="rule-head">Reserve</div><div class="field"><input id="reserve" inputmode="decimal" placeholder="0" autocomplete="off"><span>ETH</span></div><p class="hint">Minimum first bid, for 7 days.</p></div>
        <div><div class="rule-head">Deadline</div><div class="seg">${DURATIONS.map((d) => `<label><input type="radio" name="dur" value="${d}" ${d === 30 ? 'checked' : ''}><span>${d}d</span></label>`).join('')}</div><p class="hint">Then everyone withdraws.</p></div>
      </section>

      <section class="rule"><div class="rule-head">Your Credits <span class="muted num" id="n">Min ${min}</span><button type="button" class="link small" id="all">Select all that fit</button></div>
        <div class="picker lg" id="picker">${
          owned.length
            ? owned.map((id) => `<button type="button" class="pick" data-id="${id}" aria-pressed="false" title="Credit #${id}"><img src="${art(id)}" alt="Credit #${id}" loading="lazy"></button>`).join('')
            : `<p class="muted">You don’t hold any Credits.${config.chainId !== 1 ? ' <a href="#/mint">Mint test Credits →</a>' : ''}</p>`
        }</div>
      </section>

      <div class="submit">
        ${approved ? '' : `<button type="button" class="btn primary" id="approve">Approve Eighty · once</button>`}
        <button class="btn primary" id="go" disabled ${approved ? '' : 'hidden'}>Open batch</button>
        <p class="hint" id="why"></p>
      </div>
    </form>
  </section>`;

  // ---------------------------------------------------------------- your Credits' traits (for the live preview)
  const mine = new Map<string, Rated>();
  (async () => {
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
    if (!r) return !rules.palette && !rules.print && !rules.weight && !rules.eights && rules.minuteFrom < 0 && rules.minuteTo < 0;
    if (rules.palette && r.traits.palette !== rules.palette) return false;
    if (rules.print && r.traits.registration !== rules.print) return false;
    if (rules.weight && weightOf(r) !== rules.weight) return false;
    if (rules.eights && TRAITS.eights[r.traits.eights] !== rules.eights) return false;
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
    if (rules.palette) parts.push(`Palette ${rules.palette}`);
    if (rules.print) parts.push(`Print ${rules.print}`);
    if (rules.weight) parts.push(`Weight ${rules.weight}`);
    if (rules.eights) parts.push(`Eights ${rules.eights}`);
    if (rules.minuteFrom >= 0 || rules.minuteTo >= 0) parts.push(document.getElementById('win-text')!.textContent!.replace(/^/, 'Paid '));
    if (rules.idFrom || rules.idTo) parts.push(rules.idFrom && rules.idTo ? `#${rules.idFrom}–${rules.idTo}` : rules.idFrom ? `#${rules.idFrom}+` : `up to #${rules.idTo}`);
    if (rules.list.length) parts.push(`${rules.list.length} listed`);
    return parts.length ? parts.join(' · ') : 'Any Credit';
  };

  function refresh() {
    const fit = owned.filter(qualifies);
    for (const id of [...picks]) if (!fit.some((f) => f.toString() === id)) picks.delete(id);
    document.getElementById('preview')!.innerHTML = sheet(fit.slice(0, 80), { mine: picks });
    document.getElementById('st-mine')!.textContent = String(fit.length);
    document.getElementById('rules-text')!.textContent = describe();
    $$<HTMLButtonElement>('.pick', app).forEach((p) => {
      const ok = fit.some((f) => f.toString() === p.dataset.id);
      p.classList.toggle('off', !ok);
      p.setAttribute('aria-pressed', String(picks.has(p.dataset.id!)));
    });
    document.getElementById('n')!.textContent = picks.size ? `${picks.size} selected` : `Min ${min}`;
    const n = picks.size;
    const reason = !isOk ? 'Approve first.' : n < min ? `Select at least ${min} of your qualifying Credits.` : n > 80 ? 'At most 80.' : '';
    why.textContent = reason || (n > CHUNK ? `${Math.ceil(n / CHUNK)} transactions: open with ${CHUNK}, then deposit the rest.` : '');
    go.disabled = !!reason;

    clearTimeout(editionTimer);
    editionTimer = window.setTimeout(async () => {
      const seq = ++editionSeq;
      const el = document.getElementById('st-edition')!;
      try {
        const r = await fetch('/edition/match', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            palette: paletteMask(rules.palette),
            print: rules.print ? PRINTS.indexOf(rules.print as (typeof PRINTS)[number]) : -1,
            weight: rules.weight ? WEIGHTS.indexOf(rules.weight as (typeof WEIGHTS)[number]) : -1,
            eights: rules.eights ? TRAITS.eights.indexOf(rules.eights as (typeof TRAITS.eights)[number]) : -1,
            minuteFrom: rules.minuteFrom,
            minuteTo: rules.minuteTo,
            idFrom: rules.idFrom,
            idTo: rules.idTo,
            list: rules.list.slice(0, 200),
          }),
        });
        const d = (await r.json()) as { count?: number };
        if (seq === editionSeq && typeof d.count === 'number') el.textContent = d.count.toLocaleString();
      } catch {
        if (seq === editionSeq) el.textContent = '–';
      }
    }, 200);
  }

  // ---------------------------------------------------------------- trait tiles (tap to pick, tap again to clear)
  for (const key of ['palette', 'print', 'weight', 'eights'] as const) {
    const group = app.querySelector<HTMLElement>(`[data-rule="${key}"]`)!;
    group.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-v]');
      if (!btn) return;
      rules[key] = rules[key] === btn.dataset.v ? '' : btn.dataset.v!;
      group.querySelectorAll('[data-v]').forEach((b) => b.setAttribute('aria-pressed', String((b as HTMLElement).dataset.v === rules[key])));
      document.getElementById(`${key}-pick`)!.textContent = rules[key] || 'Any';
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
      winCount.textContent = minutes.length ? `The whole mint: ${minutes.reduce((s, [, c]) => s + c, 0).toLocaleString()} Credits over ${minutes.length.toLocaleString()} minutes.` : '';
    } else {
      const start = new Date(minutes[a][0] * 1000), end = new Date((minutes[b][0] + 60) * 1000);
      winText.textContent = `${fmtDT.format(start)} – ${start.toDateString() === end.toDateString() ? fmtT.format(end) : fmtDT.format(end)} ${tz}`;
      let n = 0;
      for (let i = a; i <= b; i++) n += minutes[i][1];
      winCount.textContent = `${n.toLocaleString()} Credit${n === 1 ? '' : 's'} were paid for in this window${a === b ? ' (one minute)' : ''}.`;
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

  // ---------------------------------------------------------------- numbers and list
  const idFromEl = document.getElementById('id-from') as HTMLInputElement;
  const idToEl = document.getElementById('id-to') as HTMLInputElement;
  const readIds = () => {
    rules.idFrom = Number(idFromEl.value) || 0;
    rules.idTo = Number(idToEl.value) || 0;
    const a = rules.idFrom, b = rules.idTo;
    document.getElementById('id-hint')!.textContent = a && b && b >= a ? `${(b - a + 1).toLocaleString()} numbers` : a ? `#${a} and up` : b ? `up to #${b}` : 'Any';
    refresh();
  };
  idFromEl.addEventListener('input', readIds);
  idToEl.addEventListener('input', readIds);
  const allowEl = document.getElementById('allow') as HTMLTextAreaElement;
  allowEl.addEventListener('input', () => {
    rules.list = [...new Set(allowEl.value.split(/[\s,#]+/).filter((x) => /^\d+$/.test(x)).map(Number))];
    const n = rules.list.length;
    document.getElementById('allow-hint')!.textContent = n ? `${n} listed${n > 200 ? ' · limit is 200' : ''}` : 'No list';
    refresh();
  });

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
  app.querySelectorAll<HTMLInputElement>('input[name=arr]').forEach((r) =>
    r.addEventListener('change', () => (document.getElementById('arr-hint')!.textContent = ARR_HINTS[Number(r.value)])),
  );
  const cfee = document.getElementById('cfee') as HTMLInputElement;
  const feeBps = () => {
    const v = cfee.value.trim();
    if (!v) return 0;
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 && n <= 10 ? Math.round(n * 100) : NaN;
  };
  cfee.addEventListener('input', () => {
    const bps = feeBps();
    const hint = document.getElementById('cfee-hint')!;
    if (Number.isNaN(bps)) hint.textContent = 'Between 0 and 10.';
    else if (!bps) hint.textContent = '0–10 % of the sale.';
    else hint.textContent = `3 ETH sale: ${fmt((3 * bps) / 10_000)} ETH to you, ${fmt((3 * (1 - (protocolBps + bps) / 10_000)) / 80)} ETH per Credit.`;
  });

  document.getElementById('approve')?.addEventListener('click', async (e) => {
    const b = e.currentTarget as HTMLButtonElement;
    b.disabled = true;
    b.textContent = 'Approving…';
    try {
      await send({ address: config.credits, abi: creditsAbi, functionName: 'setApprovalForAll', args: [config.factory, true] });
      isOk = true;
      b.remove();
      go.hidden = false;
      refresh();
    } catch (x) {
      toast(errText(x), 'err');
      b.disabled = false;
      b.textContent = 'Approve Eighty · once';
    }
  });

  // ---------------------------------------------------------------- open
  document.getElementById('create')!.addEventListener('submit', async (e) => {
    e.preventDefault();
    let reserve = 0n;
    try {
      reserve = parseEther((document.getElementById('reserve') as HTMLInputElement).value.trim() || '0');
    } catch {
      return toast('Reserve must be an ETH amount.', 'err');
    }
    const bps = feeBps();
    if (Number.isNaN(bps)) return toast('Your fee must be between 0 and 10%.', 'err');
    if (rules.idTo && rules.idFrom > rules.idTo) return toast('The number range is backwards.', 'err');
    if (rules.list.length > 200) return toast('At most 200 listed Credits.', 'err');
    const name = (document.getElementById('name') as HTMLInputElement).value.trim();
    const days = Number((app.querySelector('input[name=dur]:checked') as HTMLInputElement).value);
    const arr = Number((app.querySelector('input[name=arr]:checked') as HTMLInputElement).value);
    const ids = [...picks].map(BigInt);
    const f = {
      colors: hashTrait(rules.palette),
      print: hashTrait(rules.print),
      weight: hashTrait(rules.weight),
      eights: hashTrait(rules.eights),
      paidFrom: BigInt(rules.minuteFrom >= 0 ? minutes[rules.minuteFrom][0] : 0),
      paidTo: BigInt(rules.minuteTo >= 0 ? minutes[rules.minuteTo][0] + 59 : 0),
      idFrom: BigInt(rules.idFrom),
      idTo: BigInt(rules.idTo),
    };
    go.disabled = true;
    go.textContent = 'Opening…';
    try {
      const receipt = await send({
        address: config.factory,
        abi: factoryAbi,
        functionName: 'create',
        args: [name, f, rules.list.map(BigInt), reserve, BigInt(bps), arr, BigInt(days * 86400), ids.slice(0, CHUNK)],
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
      toast('Batch opened.', 'ok');
      location.hash = `#/b/${batch}`;
    } catch (x) {
      toast(errText(x), 'err', 8000);
      go.textContent = 'Open batch';
      refresh();
    }
  });

  refresh();
}
