import type { Address } from 'viem';
import { decodeEventLog } from 'viem';
import { go as navigate } from '../main';
import { bin } from '../bins';
import { config, pub, send, session } from '../chain';
import { creditsAbi, factoryAbi } from '../abi';
import { creatorFeeBps, factoryRatings, forgetBatches, getBatch, isApproved, myCredits, protocolFeeBps, ratings } from '../data';
import { hydrate, who } from '../ens';
import { sweepToWallet, type Listed } from '../forsale';
import { errText, esc, pageHead, same, toast } from '../ui';
import { compose, DIRECTIONS, inkOf, paint as paintMarks, PAGE, type Ink } from '../../shared/statement';
import { print, replace, type Candidate, type Pick, type Printed } from '../printer-match';
import { creditCell } from './trait';

/// The Printer: a picture in, a Statement out, drawn by 80 Credits you and your friends own or can buy.
///   /printer       frame a picture, add friends' wallets with the most each will bring, print
///   /printer/<id>  the plan everyone shares: each friend buys theirs, then deposits whenever. The union opens once
///                  all 80 are held (these 80 as its allowlist, Number order, so deposits can come in any order) and
///                  stays off the site's lists until it fills.
type Wallet = { address: Address; label: string; cap: number };
/// `order`: 'deposit' for a solo plan (its one wallet deposits all 80 in slot order), 'number' for a group.
type Plan = { id: string; name: string; target: string; wallets: Wallet[]; slots: { id: string; wallet: number; owned: boolean }[]; order?: 'deposit' | 'number'; union: Address | null };

const CHUNK = 40; // Credits per create/deposit transaction
const BUY_AT_ONCE = 40; // Credits per buy transaction
const LIVE_MS = 12_000;
const NUMBER_ORDER = 2; // Batch.Arrangement.Number
const DEPOSIT_ORDER = 0; // Batch.Arrangement.Deposit
/// Pictures to start from: a few faces, space photos (NASA; the black hole is the Event Horizon Telescope's, CC-BY 4.0)
/// and geometric designs in the Credits' own inks, with shapes at least a Credit wide so they survive the print.
/// Five at a time, a different five per visit.
const EXAMPLES = [
  ['Jack', '/examples/jack.jpg'],
  ['Mona Lisa', '/examples/mona-lisa.jpg'],
  ['Girl with a Pearl Earring', '/examples/pearl-earring.jpg'],
  ['The Sun', '/examples/sun.jpg'],
  ['Black hole', '/examples/black-hole.jpg'],
  ['Blue Marble', '/examples/blue-marble.jpg'],
  ['Jupiter', '/examples/jupiter.jpg'],
  ['Saturn', '/examples/saturn.jpg'],
  ['Rings', '/examples/rings.png'],
  ['Sunburst', '/examples/sunburst.png'],
  ['Waves', '/examples/waves.png'],
  ['Spiral', '/examples/spiral.png'],
  ['CMYK', '/examples/cmyk.png'],
  ['Dot', '/examples/dot.png'],
] as const;
let live: ReturnType<typeof setInterval> | null = null;

export async function printer(app: HTMLElement, id: string | undefined, rerender: () => void) {
  if (live) clearInterval(live), (live = null);
  if (id === 'mine') return mine(app);
  return id ? planPage(app, id) : maker(app, rerender);
}

// ---------------------------------------------------------------- shared

/// Everything the matcher reads: every Credit's print, which ones are registered (a misprint's ink spills into the
/// next patch), and the market. Read once per visit.
let base: Promise<{ wall: Uint8Array; traits: Uint32Array; registered: (id: number) => boolean; market: Map<number, number> }> | null = null;
function loadBase() {
  return (base ??= Promise.all([bin('wall.bin'), bin('edition-traits.bin'), fetch('/market.json').then((r) => r.json() as Promise<{ items?: [string, string, string][] }>)]).then(([w, t, m]) => {
    const traits = new Uint32Array(t);
    const market = new Map<number, number>();
    for (const [id, price] of m.items ?? []) market.set(Number(id), Number(price) / 1e18);
    return { wall: new Uint8Array(w), traits, registered: (id: number) => ((traits[id - 1] >> 4) & 7) === 0, market };
  })).catch((e) => {
    base = null;
    throw e;
  });
}

/// Candidates: the wallets' own registered Credits (free), then every registered listing nobody here owns.
async function candidates(wallets: Address[]) {
  const b = await loadBase();
  const owned = await Promise.all(wallets.map((a) => myCredits(a).catch(() => [] as readonly bigint[])));
  const cands: Candidate[] = [];
  const mine = new Set<number>();
  owned.forEach((ids, w) =>
    ids.forEach((x) => {
      const id = Number(x);
      if (b.registered(id)) cands.push({ id, price: 0, owner: w }), mine.add(id);
    }),
  );
  for (const [id, price] of b.market) if (!mine.has(id) && b.registered(id)) cands.push({ id, price, owner: -1 });
  return { cands, wall: b.wall, owned: owned.map((x) => x.length) };
}

/// One direction of the sheet, cells snapped to device pixels. `ghosts` draw faded.
function paint(c: HTMLCanvasElement, d: (typeof DIRECTIONS)[number], inks: (Ink | null)[], ghosts: ReadonlySet<number> = new Set()) {
  const w = c.clientWidth || 240;
  const W = Math.round(w * Math.min(3, devicePixelRatio || 1)), H = Math.round((W * PAGE.h) / PAGE.w);
  c.width = W;
  c.height = H;
  paintMarks(c.getContext('2d')!, W, compose(d, inks, ghosts));
}
const sheets = (key: string) => `<div class="printer-sheets" id="${key}">${DIRECTIONS.map((d) => `<figure><canvas data-dir="${d}" aria-label="${d}"></canvas><figcaption>${d}</figcaption></figure>`).join('')}</div>`;
/// A registered Credit's ink, straight from the edition files: its print (wall.bin) is exactly its plates, since
/// nothing slipped, and its eights come from its packed traits. The Printer only ever picks registered Credits;
/// anything else is read from its seed.
async function inksOf(ids: string[]): Promise<(Ink | null)[]> {
  const b = await loadBase().catch(() => null);
  const slipped = b ? ids.filter((x) => !b.registered(Number(x))) : ids;
  const r = slipped.length ? await ratings(slipped.map(BigInt)).catch(() => null) : null;
  return ids.map((x) => {
    const id = Number(x);
    if (b && b.registered(id)) {
      const px = new Uint8Array(144);
      for (let c = 0; c < 64; c++) {
        const byte = b.wall[(id - 1) * 32 + (c >> 1)];
        px[((c >> 3) + 2) * 12 + (c & 7) + 2] = c & 1 ? byte >> 4 : byte & 15;
      }
      return { px, eights: (b.traits[id - 1] >> 9) & 31 };
    }
    const s = r?.ratings[x];
    return s?.seed ? inkOf(s.seed, s.paidAt) : null;
  });
}
async function drawSheets(root: HTMLElement, ids: string[], ghosts?: ReadonlySet<number>) {
  const inks = await inksOf(ids);
  root.querySelectorAll<HTMLCanvasElement>('canvas[data-dir]').forEach((c) => paint(c, c.dataset.dir as (typeof DIRECTIONS)[number], inks, ghosts));
}
const eth = (v: number) => `${v.toFixed(3)} ETH`;

/// The picture as the matcher sees it: 64 × 80 pixels.
function pixelsOf(src: HTMLCanvasElement | HTMLImageElement): Uint8ClampedArray {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 80;
  const g = c.getContext('2d')!;
  g.imageSmoothingQuality = 'high';
  g.drawImage(src, 0, 0, 64, 80);
  return g.getImageData(0, 0, 64, 80).data;
}

// ---------------------------------------------------------------- /printer

function maker(app: HTMLElement, rerender: () => void) {
  app.innerHTML = `
  <section class="printer">
    <div class="printer-grid">
      <div class="printer-form">
        <div class="design-form printer-rows">
          <h2 class="form-title">Picture<button type="button" class="link small" id="shuffle">Shuffle</button>${session.account ? '<a class="link small" href="/printer/mine">Your plans</a>' : ''}</h2>
          <input type="file" id="file" accept="image/*" hidden>
          <div class="printer-strip" id="strip"></div>
          <div class="printer-crop" title="Drag to move, pinch or scroll to zoom"><canvas id="crop" width="256" height="320" aria-label="The picture: drag to move, pinch or scroll to zoom"></canvas><div class="printer-zoom"><button type="button" data-zoom="out" aria-label="Zoom out">−</button><button type="button" data-zoom="in" aria-label="Zoom in">+</button></div></div>
          <div class="rule-list">
            ${row('contrast', 'Contrast', '<span id="contrast-v">1.10×</span>', '<label class="printer-range printer-max"><input type="range" id="contrast" min="0.8" max="1.8" step="0.05" value="1.1" aria-label="Contrast"></label><p class="muted small">Punches up the picture before it’s matched.</p>')}
            ${row('detail', 'Detail', '<span id="features-v">Medium</span>', '<label class="printer-range printer-max"><input type="range" id="features" min="0" max="4" step="0.5" value="2" aria-label="Detail"></label><p class="muted small">Favours Credits that keep eyes, mouths and edges.</p>')}
            ${row('bg', 'Background', '<span class="printer-dot" id="bg-v" style="background:#ffffff"></span>', `<div class="printer-bg">${[['#ffffff', 'White'], ['#111111', 'Black'], ['#00b5e2', 'Cyan'], ['#e4007c', 'Magenta'], ['#ffd100', 'Yellow']].map(([c, n], i) => `<button type="button" data-bg="${c}" style="background:${c}" aria-label="${n}" title="${n}" aria-pressed="${i === 0}"></button>`).join('')}</div><p class="muted small">Fills around the picture when you zoom out.</p>`)}
          </div>
        </div>
          <canvas id="target" width="64" height="80" hidden></canvas>
      </div>
      <div class="printer-out" id="out">${sheets('result')}<p class="muted small" id="status">Reading every listing…</p></div>
    </div>
  </section>`;

  let img: HTMLImageElement | null = null, zoom = 1, cx = 0.5, cy = 0.5, label = 'Untitled';
  let schedule = () => {}; // print again soon (set once printing is wired, below)
  const crop = document.getElementById('crop') as HTMLCanvasElement, target = document.getElementById('target') as HTMLCanvasElement;
  // The 4:5 window onto the picture. Zoomed out past 1× the window is bigger than the picture, which then sits
  // inside it on the background colour; either way it can be dragged, as far as keeps it in view.
  let bg = '#ffffff';
  const win = () => {
    const ir = img!.width / img!.height, r = 4 / 5;
    const w = (ir > r ? img!.height * r : img!.width) / zoom, h = w / r;
    const clamp = (v: number, span: number, size: number) => Math.min(Math.max(v, Math.min(0, size - span)), Math.max(0, size - span));
    return [clamp(cx * img!.width - w / 2, w, img!.width), clamp(cy * img!.height - h / 2, h, img!.height), w, h] as const;
  };
  const frame = () => {
    if (!img) return;
    const [x, y, w] = win(), g = crop.getContext('2d')!, k = 256 / w;
    g.filter = 'none';
    g.fillStyle = bg;
    g.fillRect(0, 0, 256, 320);
    g.filter = `contrast(${(document.getElementById('contrast') as HTMLInputElement).value})`;
    g.imageSmoothingQuality = 'high';
    g.drawImage(img, -x * k, -y * k, img.width * k, img.height * k);
    const t = target.getContext('2d')!;
    t.imageSmoothingQuality = 'high';
    t.drawImage(crop, 0, 0, 64, 80);
  };
  const load = (src: string, name: string) => {
    const i = new Image();
    i.onload = () => ((img = i), (label = name), (zoom = 1), (cx = cy = 0.5), exValue(name), frame(), schedule());
    i.src = src;
  };
  // Five examples at a time, plus Upload; Shuffle deals five others.
  const strip = document.getElementById('strip')!;
  let shown: (typeof EXAMPLES)[number][] = [];
  const deal = () => {
    const rest = EXAMPLES.filter((e) => !shown.includes(e));
    shown = [...rest].sort(() => Math.random() - 0.5).slice(0, 5);
    strip.innerHTML =
      shown.map(([n, src]) => `<button type="button" class="printer-thumb" data-ex="${src}" title="${n}" aria-label="${n}" aria-pressed="${img?.src.endsWith(src) ?? false}"><img src="${src}" alt=""></button>`).join('') +
      '<button type="button" class="printer-thumb printer-upload" id="upload" title="Upload your own" aria-label="Upload your own">+</button>';
    strip.querySelectorAll<HTMLButtonElement>('[data-ex]').forEach((b) => b.addEventListener('click', () => load(b.dataset.ex!, b.title)));
    document.getElementById('upload')!.addEventListener('click', () => file.click());
  };
  const exValue = (name: string) => strip.querySelectorAll<HTMLButtonElement>('[data-ex]').forEach((b) => b.setAttribute('aria-pressed', String(b.title === name)));
  document.getElementById('shuffle')!.addEventListener('click', deal);
  const file = document.getElementById('file') as HTMLInputElement;
  deal();
  load(shown[0][1], shown[0][0]); // open on one of the five, framed and ready
  const fromFile = (f?: File | null) => f?.type.startsWith('image/') && load(URL.createObjectURL(f), f.name.replace(/\.\w+$/, ''));
  const drop = crop.parentElement!; // drop an image straight onto the picture
  file.addEventListener('change', () => fromFile(file.files?.[0]));
  drop.addEventListener('dragover', (e) => (e.preventDefault(), drop.classList.add('over')));
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => (e.preventDefault(), drop.classList.remove('over'), fromFile(e.dataTransfer?.files[0])));
  const onPaste = (e: ClipboardEvent) => (app.isConnected ? fromFile(e.clipboardData?.files[0]) : document.removeEventListener('paste', onPaste));
  document.addEventListener('paste', onPaste);
  // Frame on the image itself: drag to move, scroll or pinch to zoom (1× to 4×).
  const setZoom = (z: number) => ((zoom = Math.min(4, Math.max(0.25, z))), frame(), schedule());
  const down = new Map<number, { x: number; y: number }>();
  let drag: { x: number; y: number; cx: number; cy: number } | null = null, pinch: { d: number; zoom: number } | null = null;
  const spread = () => {
    const [a, b] = [...down.values()];
    return Math.hypot(a.x - b.x, a.y - b.y);
  };
  crop.addEventListener('pointerdown', (e) => {
    if (!img) return;
    crop.setPointerCapture(e.pointerId);
    down.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (down.size === 2) (pinch = { d: spread(), zoom }), (drag = null);
    else drag = { x: e.clientX, y: e.clientY, cx, cy };
  });
  crop.addEventListener('pointermove', (e) => {
    if (!img || !down.has(e.pointerId)) return;
    down.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch && down.size === 2) return setZoom((pinch.zoom * spread()) / pinch.d);
    if (!drag) return;
    const [, , w, h] = win(), s = w / crop.clientWidth;
    cx = Math.min(Math.max(drag.cx - ((e.clientX - drag.x) * s) / img.width, -2), 3);
    cy = Math.min(Math.max(drag.cy - ((e.clientY - drag.y) * s * (h / w) * 1.25) / img.height, -2), 3);
    frame();
  });
  const up = (e: PointerEvent) => (down.delete(e.pointerId), down.size < 2 && (pinch = null), !down.size && drag && ((drag = null), schedule()));
  crop.addEventListener('pointerup', up);
  crop.addEventListener('pointercancel', up);
  // Trackpad pinch arrives as ctrl+wheel with small steps (Chrome, Firefox) or as gesture events (Safari).
  crop.addEventListener('wheel', (e) => img && (e.preventDefault(), setZoom(zoom * Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.002)))), { passive: false });
  let gesture = 1;
  crop.addEventListener('gesturestart', (e) => (e.preventDefault(), (gesture = zoom)));
  crop.addEventListener('gesturechange', (e) => (e.preventDefault(), setZoom(gesture * (e as unknown as { scale: number }).scale)));
  app.querySelectorAll<HTMLButtonElement>('[data-zoom]').forEach((b) => b.addEventListener('click', () => setZoom(zoom * (b.dataset.zoom === 'in' ? 1.25 : 0.8))));
  document.getElementById('contrast')!.addEventListener('input', frame);
  document.getElementById('contrast')!.addEventListener('change', () => schedule());
  app.querySelectorAll<HTMLButtonElement>('[data-bg]').forEach((b) =>
    b.addEventListener('click', () => {
      bg = b.dataset.bg!;
      document.getElementById('bg-v')!.style.background = bg;
      app.querySelectorAll('[data-bg]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      frame();
      schedule();
    }),
  );
  document.getElementById('features')!.addEventListener('change', () => schedule());
  bindRows(app.querySelector('.printer-form')!);
  const detailWord = (v: number) => (v === 0 ? 'Off' : v < 1.5 ? 'Low' : v < 2.5 ? 'Medium' : v < 3.5 ? 'High' : 'Most');
  document.getElementById('contrast')!.addEventListener('input', (e) => (document.getElementById('contrast-v')!.textContent = `${(+(e.target as HTMLInputElement).value).toFixed(2)}×`));
  document.getElementById('features')!.addEventListener('input', (e) => (document.getElementById('features-v')!.textContent = detailWord(+(e.target as HTMLInputElement).value)));
  let maxPrice = 0.08, budget: number | null = null, limit: Limit = 'total';

  // Who's in: you (once connected), then friends added under the result. Each brings what they own; the 80 split
  // evenly between them until someone sets their own share.
  const members: Member[] = session.account ? [{ address: session.account, owns: 0, cap: 100 }] : [];
  let evenCaps = true, own = 1;
  const rebalance = () => evenCaps && members.forEach((m, i) => (m.cap = Math.floor(100 / members.length) + (i < 100 % members.length ? 1 : 0)));
  if (members[0]) void myCredits(members[0].address).then((ids) => (members[0].owns = ids.length), () => {});
  const people: People = {
    members,
    own,
    async add(v) {
      v = v.trim();
      let a = /^0x[0-9a-fA-F]{40}$/.test(v) ? v : null;
      if (!a && /\.[a-z]{2,}$/i.test(v)) a = ((await fetch(`/ens/name/${encodeURIComponent(v.toLowerCase())}`).then((r) => r.json()).catch(() => null)) as { address?: string | null } | null)?.address ?? null;
      if (!a) return toast(`${v || 'That'} isn’t a wallet or ENS name we can find.`, 'err');
      if (members.some((m) => same(m.address, a as Address))) return toast('Already in.', 'info');
      if (members.length >= 8) return toast('Up to 8 wallets.', 'err');
      members.push({ address: a as Address, owns: (await myCredits(a as Address).catch(() => [])).length, cap: 0 });
      rebalance();
      void run();
    },
    remove(i) {
      members.splice(i, 1);
      rebalance();
      void run();
    },
    setCap(i, v) {
      evenCaps = false;
      members[i].cap = Math.min(100, Math.max(1, Math.round(v) || 1));
      void run();
    },
    setOwn(v) {
      own = people.own = v;
      void run();
    },
  };

  // Printing runs on its own: on open, and a moment after the picture or the wallets change. One at a time; a change
  // while one runs prints again right after.
  const out = document.getElementById('out')!;
  let running = false, again = false, timer: ReturnType<typeof setTimeout> | undefined;
  const status = (t: string) => {
    const el = document.getElementById('status');
    if (el) el.textContent = t;
  };
  const run = async (): Promise<void> => {
    if (!img) return;
    if (running) return void (again = true);
    if (members.length > 1 && members.reduce((n, m) => n + m.cap, 0) < 100) return toast('The shares add up to less than 100%.', 'err');
    running = true;
    const rows: Wallet[] = members.map((m) => ({ address: m.address, label: '', cap: members.length === 1 ? 100 : m.cap }));
    out.classList.add('busy');
    try {
      status(base ? 'Printing…' : 'Reading every listing…');
      const { cands, wall } = await candidates(rows.map((r) => r.address));
      const caps = rows.map((r) => Math.ceil((r.cap * 80) / 100));
      // Solo (one wallet, or none yet): no rising-number rule, deposited in slot order. A group keeps numbers rising
      // so anyone can deposit any time.
      const params = { features: +(document.getElementById('features') as HTMLInputElement).value, maxPrice, own, budget, free: rows.length <= 1 };
      const printed = await print(pixelsOf(crop), cands, wall, caps, params, (f) => status(`Printing… ${Math.round(f * 100)}%`));
      if (!out.isConnected) return; // the page was redrawn meanwhile (a wallet reconnecting): this print is stale
      showResult(out, printed, rows, label, target, people, {
        limit,
        maxPrice,
        budget,
        mode: (m) => (limit = m),
        setMax: (v) => ((maxPrice = v), (budget = null), void run()),
        setBudget: (v) => ((budget = v), void run()),
      });
    } catch (x) {
      if (out.isConnected) toast(errText(x), 'err', 8000);
    }
    out.classList.remove('busy');
    status('');
    running = false;
    if (again) (again = false), void run();
  };
  schedule = () => (clearTimeout(timer), (timer = setTimeout(() => void run(), 350)));
  schedule();
  void rerender;
}

type Member = { address: Address; owns: number; cap: number };
type People = { members: Member[]; own: number; add(v: string): Promise<void>; remove(i: number): void; setCap(i: number, v: number): void; setOwn(v: number): void };

type Limit = 'total' | 'each';
type Limits = { limit: Limit; maxPrice: number; budget: number | null; mode(m: Limit): void; setMax(v: number): void; setBudget(v: number): void };

/// Rows the viewer opened stay open across re-prints.
const openRows = new Set<string>();
const CHEV = '<svg class="chev" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>';
/// A settings row as /create draws them: name, value on the right, and an editor that opens inside the row.
const row = (key: string, name: string, value: string, pane: string, set = false) =>
  `<div class="rrow${set ? ' set' : ''}${openRows.has(key) ? ' open' : ''}" data-row="${key}"><div class="rrow-head"><button type="button" class="rrow-toggle" aria-expanded="${openRows.has(key)}"><span class="rrow-name">${name}</span><span class="rrow-value">${value}</span>${CHEV}</button></div><section class="rule printer-pane"${openRows.has(key) ? '' : ' hidden'}>${pane}</section></div>`;

/// Open and close rows in place, remembering which are open.
function bindRows(root: ParentNode) {
  root.querySelectorAll<HTMLElement>('.rrow[data-row]').forEach((r) =>
    r.querySelector('.rrow-toggle')!.addEventListener('click', () => {
      const open = !r.classList.contains('open');
      r.classList.toggle('open', open);
      r.querySelector<HTMLElement>('.printer-pane')!.hidden = !open;
      r.querySelector('.rrow-toggle')!.setAttribute('aria-expanded', String(open));
      if (open) openRows.add(r.dataset.row!);
      else openRows.delete(r.dataset.row!);
    }),
  );
}

function showResult(out: HTMLElement, printed: Printed, wallets: Wallet[], label: string, target: HTMLCanvasElement, people: People, lim: Limits) {
  const { picks } = printed;
  const FEE = 1.02;
  const many = people.members.length > 1;
  const ownWord = (v: number) => (v === 0 ? 'Off' : v < 1 ? 'Some' : v < 2 ? 'More' : 'Most');
  const buy = picks.filter((p) => !p.owned), spend = buy.reduce((n, p) => n + p.price, 0);
  const range = `From ${eth(printed.floor * FEE)}, the cheapest it can be, to ${eth(printed.top * FEE)} for the best likeness.`;
  const budgetPane = `
    <div class="printer-seg" role="radiogroup" aria-label="Limit by"><button type="button" role="radio" data-limit="total" aria-checked="${lim.limit === 'total'}">Total</button><button type="button" role="radio" data-limit="each" aria-checked="${lim.limit === 'each'}">Per Credit</button></div>
    <label class="printer-range printer-max" data-pane="total"${lim.limit === 'total' ? '' : ' hidden'}><input type="range" id="budget" min="${(printed.floor * FEE).toFixed(3)}" max="${Math.max(printed.top, printed.floor + 0.001) * FEE}" step="0.001" value="${(printed.spend * FEE).toFixed(3)}" aria-label="Most to spend in total"><span class="num small" id="budget-o">${eth(printed.spend * FEE)}</span></label>
    <label class="printer-range printer-max" data-pane="each"${lim.limit === 'each' ? '' : ' hidden'}><input type="range" id="maxPrice" min="0.03" max="0.2" step="0.005" value="${lim.maxPrice}" aria-label="Most to pay for one Credit"><span class="num small" id="maxPrice-o">${lim.maxPrice.toFixed(3)} ETH</span></label>
    <p class="muted small" id="limit-note">${lim.limit === 'total' ? range : 'Leaves out any Credit priced above this.'}</p>`;
  const creditsPane = `<div class="trait-grid">${picks.map((p) => creditCell(p.id, p.owned ? '<span class="muted small">Owned</span>' : `<span class="num small">${p.price.toFixed(3)}</span>`)).join('')}</div>`;
  const personPane = (m: Member, i: number, used: number) => `
    <p class="muted small">Owns ${m.owns} Credit${m.owns === 1 ? '' : 's'}${used ? `, ${used} in the picture` : ''}.</p>
    ${many ? `<label class="printer-share">Share of the 80 <span><input type="number" min="1" max="100" value="${m.cap}" data-cap="${i}" aria-label="Share of the 80, percent">%</span></label>` : ''}
    <button type="button" class="link small" data-remove="${i}">Remove</button>`;
  const people_ = people.members
    .map((m, i) => {
      const mine = picks.filter((p) => p.wallet === i), used = mine.filter((p) => p.owned).length, cost = mine.reduce((n, p) => n + p.price, 0);
      return row(`p:${m.address.toLowerCase()}`, who(m.address), `${mine.length - used} to buy · ${eth(cost * FEE)}`, personPane(m, i, used), true);
    })
    .join('');
  out.innerHTML = `
    ${sheets('result')}
    <p class="muted small printer-status" id="status"></p>
    <div class="design-form printer-rows">
      <h2 class="form-title">Statement</h2>
      <div class="rule-list">
        <div class="rrow set"><div class="rrow-head"><span class="rrow-toggle static"><span class="rrow-name">Cost</span><span class="rrow-value num">${eth(spend * FEE)}</span></span></div></div>
        ${row('budget', lim.limit === 'total' ? 'Budget' : 'Most per Credit', lim.limit === 'total' ? (printed.spend * FEE >= printed.top * FEE - 0.0005 ? 'Best likeness' : eth(printed.spend * FEE)) : `${lim.maxPrice.toFixed(3)} ETH`, budgetPane)}
        ${row('credits', 'Credits', `${buy.length} to buy${picks.length - buy.length ? ` · ${picks.length - buy.length} owned` : ''}`, creditsPane)}
      </div>
      <h2 class="form-title">Who’s in <span class="muted num">${people.members.length || ''}</span></h2>
      <div class="rule-list">
        ${people_}
        ${session.account ? '' : '<div class="rrow"><div class="rrow-head"><button type="button" class="rrow-toggle" data-connect><span class="rrow-name">You</span><span class="rrow-value">Connect to use your Credits</span></button></div></div>'}
        ${row('add', 'Add a friend', '<span class="printer-plus" aria-hidden="true">+</span>', '<form class="printer-add" id="add-friend"><input id="friend" placeholder="Wallet or ENS name" autocomplete="off" spellcheck="false" aria-label="Friend’s wallet or ENS name"><button class="btn sm primary">Add</button></form><p class="muted small">Their Credits join the picture, and the 80 split between you.</p>')}
        ${people.members.some((m) => m.owns) ? row('own', 'Use owned', ownWord(people.own), `<label class="printer-range printer-max"><input type="range" id="own" min="0" max="3" step="0.25" value="${people.own}" aria-label="How much to favour Credits already owned over buying"><span class="num small" id="own-o">${ownWord(people.own)}</span></label><p class="muted small">How much likeness to trade for using Credits you already hold.</p>`) : ''}
      </div>
      <h2 class="form-title">Settings</h2>
      <div class="rule-list">
        <div class="rrow"><label class="rrow-head name-row"><span class="rrow-name">Name</span><input id="name" maxlength="64" value="${esc(label)}" autocomplete="off"></label></div>
      </div>
      <div class="submit">
        <button class="btn primary block" id="save"${wallets.length ? '' : ' disabled'}>Save and share</button>
        <p class="muted small hint">${wallets.length ? 'Makes a link for everyone in. Each buys their part, then the union opens.' : 'Connect or add a wallet to save a plan.'}</p>
      </div>
    </div>`;
  bindRows(out); // rows stay as left across re-prints
  out.querySelector('[data-row="add"] .rrow-toggle')!.addEventListener('click', () => (out.querySelector('#friend') as HTMLInputElement).focus());
  const max = out.querySelector('#maxPrice') as HTMLInputElement, total = out.querySelector('#budget') as HTMLInputElement;
  max.addEventListener('input', () => (out.querySelector('#maxPrice-o')!.textContent = `${(+max.value).toFixed(3)} ETH`));
  max.addEventListener('change', () => lim.setMax(+max.value)); // re-print once it's let go
  total.addEventListener('input', () => (out.querySelector('#budget-o')!.textContent = eth(+total.value)));
  total.addEventListener('change', () => lim.setBudget(+total.value / FEE));
  out.querySelectorAll<HTMLButtonElement>('[data-limit]').forEach((b) =>
    b.addEventListener('click', () => {
      const m = b.dataset.limit as Limit;
      lim.mode(m);
      out.querySelectorAll('[data-limit]').forEach((x) => x.setAttribute('aria-checked', String(x === b)));
      out.querySelectorAll<HTMLElement>('.printer-pane [data-pane]').forEach((x) => (x.hidden = x.dataset.pane !== m));
      out.querySelector('#limit-note')!.textContent = m === 'total' ? range : 'Leaves out any Credit priced above this.';
    }),
  );
  const ownEl = out.querySelector('#own') as HTMLInputElement | null;
  ownEl?.addEventListener('input', () => (out.querySelector('#own-o')!.textContent = ownWord(+ownEl.value)));
  ownEl?.addEventListener('change', () => people.setOwn(+ownEl.value));
  out.querySelectorAll<HTMLInputElement>('[data-cap]').forEach((c) => c.addEventListener('change', () => people.setCap(+c.dataset.cap!, +c.value)));
  out.querySelectorAll<HTMLButtonElement>('[data-remove]').forEach((b) => b.addEventListener('click', () => people.remove(+b.dataset.remove!)));
  out.querySelector('#add-friend')!.addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = out.querySelector('#friend') as HTMLInputElement;
    if (!input.value.trim()) return input.focus();
    input.disabled = true;
    openRows.delete('add'); // close it once they're in
    await people.add(input.value);
    input.disabled = false;
  });
  hydrate(out);
  void drawSheets(out, picks.map((p) => String(p.id)));
  out.querySelector('#save')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget as HTMLButtonElement;
    btn.disabled = true;
    const body = {
      name: (out.querySelector('#name') as HTMLInputElement).value.trim() || label,
      target: target.toDataURL('image/png'),
      wallets,
      slots: picks.map((p) => ({ id: String(p.id), wallet: p.wallet, owned: p.owned })),
      order: wallets.length === 1 ? 'deposit' : 'number',
    };
    const r = await fetch('/plans', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (!r.ok) {
      btn.disabled = false;
      return toast(`Couldn’t save: ${await r.text()}`, 'err');
    }
    navigate(`/printer/${((await r.json()) as Plan).id}`);
  });
}

// ---------------------------------------------------------------- /printer/mine

/// Your plans. They're private until their union fills, so the list comes with your signature (one a day, kept for
/// the visit).
async function mine(app: HTMLElement) {
  type Row = { id: string; name: string; createdAt: number; union: string | null; people: number };
  const draw = (rows?: Row[]) => {
    app.innerHTML = `<section class="narrow printer-mine">${pageHead({ title: 'Your plans' })}${
      !session.account
        ? '<button class="btn primary" data-connect>Connect wallet</button>'
        : rows === undefined
          ? '<button class="btn primary" id="plans-sign">Show my plans</button><p class="muted small">Sign once to see them: free, no transaction.</p>'
          : rows.length
            ? `<ol class="plan-list">${rows
                .map((x) => `<li><a href="/printer/${esc(x.id)}">${esc(x.name)}</a><span class="muted small num">${x.people} ${x.people === 1 ? 'wallet' : 'wallets'} · ${x.union ? 'union open' : 'buying'} · ${new Date(x.createdAt).toLocaleDateString()}</span></li>`)
                .join('')}</ol>`
            : '<p class="muted">No plans yet. <a href="/printer">Print one</a></p>'
    }</section>`;
    document.getElementById('plans-sign')?.addEventListener('click', () => void load(true));
  };
  const load = async (sign: boolean) => {
    const account = session.account;
    if (!account) return;
    const day = Math.floor(Date.now() / 86_400_000), key = `cu-plans-sig:${account.toLowerCase()}:${day}`;
    let sig: string | null = null;
    try {
      sig = sessionStorage.getItem(key);
    } catch {}
    if (!sig && !sign) return;
    try {
      sig ??= await session.wallet!.signMessage({ account, message: `Credit Union: my plans ${day}` });
      const r = await fetch('/plans/mine', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ address: account, day, sig }) });
      if (!r.ok) throw new Error(await r.text());
      try {
        sessionStorage.setItem(key, sig);
      } catch {}
      if (app.isConnected) draw(((await r.json()) as { plans: Row[] }).plans);
    } catch (e) {
      toast(errText(e), 'err');
    }
  };
  draw();
  void load(false); // signed already this visit: show them straight away
}

// ---------------------------------------------------------------- /printer/<id>

async function planPage(app: HTMLElement, id: string) {
  const r = await fetch(`/plans/${id}.json`);
  if (!r.ok) {
    app.innerHTML = `<section class="narrow">${pageHead({ title: 'No such plan', lede: 'Check the link, or <a href="/printer">print a new one</a>.' })}</section>`;
    return;
  }
  const p = (await r.json()) as Plan;
  const addrs = p.wallets.map((w) => w.address.toLowerCase());
  const read = async () => {
    const [owners, u, b] = await Promise.all([
      Promise.all(p.slots.map((s) => pub.readContract({ address: config.credits, abi: creditsAbi, functionName: 'ownerOf', args: [BigInt(s.id)] }).then((a) => (a as string).toLowerCase(), () => ''))),
      p.union ? getBatch(p.union) : null,
      loadBase().catch(() => null),
    ]);
    return { owners, inUnion: new Set((u?.ids ?? []).map(String)), market: b?.market ?? new Map<number, number>() };
  };
  let st = await read();

  const draw = () => {
    const me = session.account?.toLowerCase();
    const mineIdx = me ? addrs.indexOf(me) : -1;
    const held = p.slots.map((s, k) => st.inUnion.has(s.id) || addrs.includes(st.owners[k]));
    const gone = p.slots.map((s, k) => !held[k] && !st.market.has(Number(s.id)));
    const allHeld = held.every(Boolean);
    const filled = p.slots.filter((s) => st.inUnion.has(s.id)).length;
    const ghosts = new Set(p.slots.flatMap((s, k) => ((p.union ? st.inUnion.has(s.id) : held[k]) ? [] : [k])));
    const card = (w: Wallet, i: number) => {
      const ks = p.slots.flatMap((s, k) => (s.wallet === i ? [k] : []));
      const have = ks.filter((k) => held[k]).length, inU = ks.filter((k) => st.inUnion.has(p.slots[k].id)).length;
      const toBuy = ks.filter((k) => !held[k] && !gone[k]), lost = ks.filter((k) => gone[k]);
      const heldNotIn = p.slots.filter((s, k) => st.owners[k] === w.address.toLowerCase() && !st.inUnion.has(s.id));
      const mine = i === mineIdx;
      let status = '', action = '';
      if (p.union) {
        status = heldNotIn.length ? `${inU} of ${ks.length} in` : inU === ks.length ? 'All in' : `${inU} of ${ks.length} in`;
        if (mine && heldNotIn.length) action = `<button class="btn primary" data-deposit>Deposit my ${heldNotIn.length}</button>`;
      } else {
        status = have === ks.length ? 'Has all theirs' : `Has ${have} of ${ks.length}`;
        if (mine && toBuy.length) {
          const cost = toBuy.slice(0, BUY_AT_ONCE).reduce((n, k) => n + (st.market.get(Number(p.slots[k].id)) ?? 0), 0); // this batch
          action += `<button class="btn primary" data-buy>Buy ${Math.min(toBuy.length, BUY_AT_ONCE)}${toBuy.length > BUY_AT_ONCE ? ` of ${toBuy.length}` : ''} · about ${eth(cost * 1.02)}</button>`;
        }
        if (lost.length) action += `${mineIdx >= 0 ? `<button class="btn" data-replace="${i}">Replace ${lost.length} sold</button>` : `<span class="muted small">${lost.length} sold, needs a replacement</span>`}`;
      }
      const tag = (k: number) => {
        const id = p.slots[k].id, price = st.market.get(Number(id));
        if (st.inUnion.has(id)) return '<span class="muted small">In</span>';
        if (held[k]) return '<span class="muted small">Held</span>';
        if (gone[k]) return '<span class="small printer-sold">Sold</span>';
        return price ? `<span class="num small">${price.toFixed(3)}</span>` : '';
      };
      const open = openRows.has(`plan:${i}`);
      return `<li class="printer-step${mine ? ' mine' : ''}"><div>${who(w.address, 'sm', true)}<span class="muted small">${esc(w.label)}</span></div><div class="num">${ks.length} Credits<span class="muted small">${status}</span></div><div class="printer-act">${action}</div>
        <details class="printer-grid80 printer-theirs" data-plan-row="${i}"${open ? ' open' : ''}><summary><span class="small">${mine ? 'Your Credits' : 'Their Credits'}</span><span class="muted small">${toBuy.length} to buy · ${have} held${lost.length ? ` · ${lost.length} sold` : ''}</span></summary>
          <div class="trait-grid">${ks.map((k) => creditCell(Number(p.slots[k].id), tag(k))).join('')}</div>
        </details></li>`;
    };
    const next = p.union
      ? filled === 80
        ? `Full. <a href="/union/${p.union}">See the union →</a>`
        : `<a href="/union/${p.union}">The union</a> is open. Everyone deposits whenever, in any order.`
      : allHeld
        ? mineIdx >= 0
          ? `<button class="btn primary" id="open">Open the union</button><span class="muted small">Only these 80 can join, ${p.order === 'deposit' ? 'placed exactly as printed' : 'in number order'}, and the sale splits equally per Credit. ${p.order === 'deposit' ? 'All 80 go in, in slot order.' : 'You sign once; your Credits go in first.'}</span>`
          : 'All 80 are held. Anyone in the plan can open the union.'
        : 'Everyone buys their part. The union opens once all 80 are held.';
    app.innerHTML = `
    <section class="printer">
      ${pageHead({ title: esc(p.name), lede: `A Printer plan for ${p.wallets.length} ${p.wallets.length === 1 ? 'wallet' : 'wallets'}. The union stays off the site until it fills; share this link with the others.` })}
      ${sheets('plan')}
      <div class="box">
        <div class="box-head"><h3>${p.union ? 'In the union' : 'Held'}</h3><span class="num">${p.union ? filled : held.filter(Boolean).length} of 80</span></div>
        <ol class="printer-steps">${p.wallets.map(card).join('')}</ol>
        <p class="printer-next">${next}</p>
        ${!session.account ? '<button class="btn primary" data-connect>Connect wallet</button>' : mineIdx < 0 ? '<p class="muted small">Your wallet isn’t in this plan.</p>' : ''}
      </div>
    </section>`;
    hydrate(app);
    void drawSheets(app, p.slots.map((s) => s.id), ghosts);
    // Expanded grids stay open across the page's live redraws.
    app.querySelectorAll<HTMLDetailsElement>('[data-plan-row]').forEach((d) => d.addEventListener('toggle', () => (d.open ? openRows.add(`plan:${d.dataset.planRow}`) : openRows.delete(`plan:${d.dataset.planRow}`))));

    app.querySelector<HTMLButtonElement>('[data-buy]')?.addEventListener('click', (e) => buy(e.currentTarget as HTMLButtonElement, mineIdx, held, gone));
    app.querySelector<HTMLButtonElement>('[data-replace]')?.addEventListener('click', (e) => swap(e.currentTarget as HTMLButtonElement, gone));
    app.querySelector<HTMLButtonElement>('#open')?.addEventListener('click', (e) => open(e.currentTarget as HTMLButtonElement));
    app.querySelector<HTMLButtonElement>('[data-deposit]')?.addEventListener('click', (e) => deposit(e.currentTarget as HTMLButtonElement));
  };
  const refresh = async () => ((st = await read()), draw());

  async function buy(btn: HTMLButtonElement, w: number, held: boolean[], gone: boolean[]) {
    const ids = p.slots.flatMap((s, k) => (s.wallet === w && !held[k] && !gone[k] ? [s.id] : [])).slice(0, BUY_AT_ONCE);
    btn.disabled = true;
    btn.textContent = 'Pricing…';
    const listed = (
      await Promise.all(
        ids.map((x) =>
          fetch(`/opensea/credit/${x}`)
            .then((r) => (r.ok ? r.json() : null))
            .then((l: { price: string | null; source?: Listed['source']; hash?: string | null; protocol?: string | null; listingId?: string | null; preview?: boolean } | null) =>
              l?.price && !l.preview ? ({ id: x, price: l.price, source: l.source!, hash: l.hash ?? undefined, protocol: l.protocol ?? undefined, listingId: l.listingId ?? undefined } as Listed) : null,
            )
            .catch(() => null),
        ),
      )
    ).filter((l): l is Listed => !!l);
    if (!listed.length) {
      toast('None of these are for sale anymore. Replace them.', 'err');
      return refresh();
    }
    await sweepToWallet(listed, btn);
    await refresh();
  }

  async function swap(btn: HTMLButtonElement, gone: boolean[]) {
    const account = session.account!;
    btn.disabled = true;
    btn.textContent = 'Finding replacements…';
    try {
      const { cands, wall } = await candidates(p.wallets.map((w) => w.address));
      const img = new Image();
      img.src = p.target;
      await img.decode();
      const target = pixelsOf(img);
      for (let k = 0; k < 80; k++) {
        if (!gone[k]) continue;
        const used = new Set(p.slots.map((s) => Number(s.id)));
        // A group plan keeps numbers rising, so a replacement fits between its neighbours; a solo plan takes any.
        const free = p.order === 'deposit';
        const lo = !free && k > 0 ? Number(p.slots[k - 1].id) : 0, hi = !free && k < 79 ? Number(p.slots[k + 1].id) : Infinity;
        const c = await replace(target, k, lo, hi, used, cands, wall, { features: 2, maxPrice: 0.12 });
        if (!c) {
          toast(`Nothing fits slot ${k + 1} right now.`, 'err');
          continue;
        }
        const message = `Credit Union plan ${p.id}: slot ${k + 1} takes #${c.id} instead of #${p.slots[k].id}`;
        btn.textContent = `Sign to swap slot ${k + 1}…`;
        const sig = await session.wallet!.signMessage({ account, message });
        const r = await fetch(`/plans/${p.id}/swap`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ slot: k, id: String(c.id), by: account, sig }) });
        if (!r.ok) throw new Error(await r.text());
        Object.assign(p, (await r.json()) as Plan);
      }
      toast('Replaced. Buy the new ones.', 'ok');
    } catch (x) {
      toast(errText(x), 'err', 8000);
    }
    await refresh();
  }

  async function approve(account: Address, btn: HTMLButtonElement) {
    if (await isApproved(account)) return;
    btn.textContent = 'Allow Credit Union to move your Credits…';
    await send({ address: config.credits, abi: creditsAbi, functionName: 'setApprovalForAll', args: [config.factory, true] });
  }

  /// The union: these 80 as its allowlist, Number order, equal split, opened with the opener's own.
  async function open(btn: HTMLButtonElement) {
    const account = session.account!;
    const mine = p.slots.filter((s, k) => st.owners[k] === account.toLowerCase()).map((s) => BigInt(s.id));
    if (!mine.length) return toast('Open it from a wallet holding at least one of the 80.', 'err');
    btn.disabled = true;
    try {
      await approve(account, btn);
      btn.textContent = 'Opening…';
      const [protocolBps, creatorBps, table] = await Promise.all([protocolFeeBps(), creatorFeeBps(), factoryRatings()]);
      const any = { palettes: 0, prints: 0, weights: 0, eights: 0, paidFrom: 0n, paidTo: 0n, idFrom: 0n, idTo: 0n, minScore: 0, maxScore: 0, layout0: 0n, layout1: 0n, bitsFrom: 0, bitsTo: 0, layoutTrait: 0 };
      const receipt = await send({
        address: config.factory,
        abi: factoryAbi,
        functionName: 'create',
        args: [p.name, any, p.slots.map((s) => BigInt(s.id)), 0n, p.order === 'deposit' ? DEPOSIT_ORDER : NUMBER_ORDER, 0, BigInt(90 * 86400), mine.slice(0, CHUNK), BigInt(protocolBps), BigInt(creatorBps), table],
      });
      const ev = receipt.logs
        .filter((l) => l.address.toLowerCase() === config.factory.toLowerCase())
        .map((l) => {
          try {
            return decodeEventLog({ abi: factoryAbi, data: l.data, topics: l.topics as [`0x${string}`, ...`0x${string}`[]] });
          } catch {
            return null;
          }
        })
        .find((x) => x?.eventName === 'BatchCreated');
      const union = (ev?.args as { batch: Address }).batch;
      const saved = await fetch(`/plans/${p.id}/union`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ union }) });
      if (saved.ok) p.union = ((await saved.json()) as Plan).union;
      else toast(`The union is open (${union}), but the plan couldn’t record it: ${await saved.text()}`, 'err', 12000);
      for (let i = CHUNK; i < mine.length; i += CHUNK) {
        btn.textContent = `Depositing ${i + 1}–${Math.min(i + CHUNK, mine.length)}…`;
        await send({ address: config.factory, abi: factoryAbi, functionName: 'deposit', args: [union, mine.slice(i, i + CHUNK)] });
      }
      forgetBatches();
      toast('The union is open, with yours in.', 'ok');
    } catch (x) {
      toast(errText(x), 'err', 8000);
    }
    await refresh();
  }

  async function deposit(btn: HTMLButtonElement) {
    const account = session.account!;
    if (!p.union || !p.wallets.some((w) => same(w.address, account))) return;
    const ids = p.slots.filter((s, k) => st.owners[k] === account.toLowerCase() && !st.inUnion.has(s.id)).map((s) => BigInt(s.id));
    btn.disabled = true;
    try {
      await approve(account, btn);
      for (let i = 0; i < ids.length; i += CHUNK) {
        btn.textContent = `Depositing ${i + 1}–${Math.min(i + CHUNK, ids.length)}…`;
        await send({ address: config.factory, abi: factoryAbi, functionName: 'deposit', args: [p.union, ids.slice(i, i + CHUNK)] });
      }
      forgetBatches();
      toast(`Your ${ids.length} are in.`, 'ok');
    } catch (x) {
      toast(errText(x), 'err', 8000);
    }
    await refresh();
  }

  draw();
  // Keep up with the others: someone buys, swaps or deposits, the page redraws.
  const path = location.pathname;
  let was = JSON.stringify([st.owners, [...st.inUnion], p.slots]);
  live = setInterval(async () => {
    if (location.pathname !== path || !app.isConnected) return void (clearInterval(live!), (live = null));
    if (document.hidden || document.querySelector('dialog[open]') || app.querySelector('button:disabled')) return;
    const again = (await fetch(`/plans/${p.id}.json`).then((r) => r.json()).catch(() => null)) as Plan | null;
    if (again) Object.assign(p, again);
    const now = await read().catch(() => null);
    const key = now && JSON.stringify([now.owners, [...now.inUnion], p.slots]);
    if (now && key !== was) (st = now), (was = key!), draw();
  }, LIVE_MS);
}
