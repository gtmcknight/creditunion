/// /lab: the Format Lab. Picture unions make Consolidated draw a picture; this picks 80 real Credits so that another
/// format draws something on purpose, previewed exactly as the Statement contract draws it (shared/statement.ts):
///   Maze   Amortized outlines ink, so paper reads as passages: 80 Credits as rooms whose doors line up, one way through.
///   Wave   Reconciled is a bar per Credit as long as its ink: 80 lengths draw a wave, a skyline, a heartbeat.
///   Shape  Accrued draws the line where ink density crosses its level: dense Credits inside a shape, light outside.
/// Data: public/lab/inks.bin (every Credit's raster, scripts/lab-inks.ts) and public/lab/listed.json (a snapshot of
/// every Credit for sale). Local only for now.
import { compose, paint as paintMarks, PAGE, type Direction } from '../../shared/statement';
import {
  FIELD, SHAPES, inkFor, mazeIndex, planMaze, planShape, planWave, shapeIndex, waveIndex, waveRange, WAVE_COLORS, WAVE_SHAPES,
  type Maze, type MazeIndex, type Pool, type ShapeIndex, type WaveColor, type WaveIndex, type WaveParams, type WaveShape,
} from '../../shared/lab';
import { art, esc, pageHead, toast } from '../ui';

type Tab = 'maze' | 'wave' | 'shape';
const TABS: [Tab, string][] = [['maze', 'Maze'], ['wave', 'Wave'], ['shape', 'Shape']];
const FORMAT: Record<Tab, Direction> = { maze: 'Amortized', wave: 'Reconciled', shape: 'Accrued' };
const eth = (w: bigint) => `${(Number(w) / 1e18).toFixed(3)} ETH`;

// ---------------------------------------------------------------- data, read once
type Pools = { all: Pool; sale: Pool; at: string };
let pools: Promise<Pools> | null = null;
const load = () =>
  (pools ??= Promise.all([fetch('/lab/inks.bin').then((r) => r.arrayBuffer()), fetch('/lab/listed.json').then((r) => r.json() as Promise<Record<string, { price: string }>>)]).then(([buf, listed]) => {
    const inks = new Uint8Array(buf);
    const price = new Map(Object.entries(listed).map(([id, v]) => [Number(id), BigInt(v.price)]));
    return { all: { inks }, sale: { inks, price }, at: 'Oct 2, 1:00 AM ET' };
  }));
const indexes = new WeakMap<Pool, { maze?: MazeIndex; wave?: WaveIndex; shape?: ShapeIndex }>();
const ix = (pool: Pool) => indexes.get(pool) ?? (indexes.set(pool, {}), indexes.get(pool)!);

// ---------------------------------------------------------------- drawing
function drawStatement(canvas: HTMLCanvasElement, d: Direction, pool: Pool, ids: number[]) {
  const w = canvas.clientWidth || 480;
  const W = Math.round(w * Math.min(3, devicePixelRatio || 1)), H = Math.round((W * PAGE.h) / PAGE.w);
  if (canvas.width !== W) canvas.width = W;
  if (canvas.height !== H) canvas.height = H;
  const g = canvas.getContext('2d')!;
  paintMarks(g, W, compose(d, ids.map((id) => (id ? inkFor(pool, id) : null))));
  return { g, W };
}
/// The way through on top of Amortized: its drawing is the 76-wide field, 1.5 lower (its own translate).
function drawPath(g: CanvasRenderingContext2D, W: number, path: [number, number][]) {
  const k = W / FIELD.w;
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.strokeStyle = '#e40000';
  g.globalAlpha = 0.85;
  g.lineWidth = Math.max(2, k * 0.6);
  g.lineJoin = 'round';
  g.beginPath();
  path.forEach(([x, y], i) => (i ? g.lineTo : g.moveTo).call(g, (x + 0.5) * k, (y + 2) * k));
  g.stroke();
  g.globalAlpha = 1;
}
const creditsGrid = (ids: number[]) =>
  `<div class="lab-credits">${ids.map((id) => (id ? `<a href="/credit/${id}" title="Credit #${id}"><img src="${art(id)}" alt="" loading="lazy" decoding="async"></a>` : '<span></span>')).join('')}</div>`;

// ---------------------------------------------------------------- page
export async function lab(app: HTMLElement) {
  let tab: Tab = (['maze', 'wave', 'shape'] as Tab[]).find((t) => location.pathname.endsWith(`/${t}`)) ?? 'maze';
  app.innerHTML = `<section class="lab">
    ${pageHead({
      title: 'Lab',
      lede: 'Picture unions make Consolidated draw a picture. Here, 80 real Credits make another format draw something on purpose, shown exactly as the Statement will print it.',
      tabs: TABS.map(([k, l]) => ({ label: l, attrs: `data-lab-tab="${k}"`, current: k === tab })),
      label: 'Formats',
    })}
    <div class="lab-body"><p class="muted">Reading all 122,154 Credits…</p></div>
  </section>`;
  const data = await load();
  if (!app.isConnected) return;
  const body = app.querySelector<HTMLElement>('.lab-body')!;
  let sale = true;
  const pool = () => (sale ? data.sale : data.all);

  const show = () => {
    app.querySelectorAll<HTMLElement>('[data-lab-tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.labTab === tab)));
    history.replaceState(history.state, '', `/lab/${tab}`);
    body.innerHTML = `<div class="lab-grid">
      <figure class="lab-art"><canvas class="lab-canvas" aria-label="${FORMAT[tab]} preview"></canvas><figcaption class="small muted lab-caption"></figcaption></figure>
      <div class="lab-side">
        <div class="lab-controls"></div>
        <label class="lab-check small"><input type="checkbox" id="lab-sale"${sale ? ' checked' : ''}> Only Credits for sale <span class="muted">(prices as of ${esc(data.at)})</span></label>
        <div class="lab-out"></div>
      </div>
    </div>`;
    body.querySelector<HTMLInputElement>('#lab-sale')!.addEventListener('change', (e) => ((sale = (e.target as HTMLInputElement).checked), run()));
    const controls = body.querySelector<HTMLElement>('.lab-controls')!;
    if (tab === 'maze') mazeControls(controls);
    if (tab === 'wave') waveControls(controls);
    if (tab === 'shape') shapeControls(controls);
    run();
  };
  app.querySelectorAll<HTMLElement>('[data-lab-tab]').forEach((b) => b.addEventListener('click', () => ((tab = b.dataset.labTab as Tab), show())));
  // Keys, for the trackpad: N a new maze, S the way through (not while typing).
  const keys = (e: KeyboardEvent) => {
    if (!app.isConnected) return document.removeEventListener('keydown', keys);
    if (tab !== 'maze' || e.metaKey || e.ctrlKey || e.altKey || (e.target as HTMLElement).closest('input, textarea, select')) return;
    if (e.key === 'n' || e.key === 'N') body.querySelector<HTMLButtonElement>('#lab-new')?.click();
    if (e.key === 's' || e.key === 'S') body.querySelector<HTMLButtonElement>('#lab-solve')?.click();
  };
  document.addEventListener('keydown', keys);

  const canvas = () => body.querySelector<HTMLCanvasElement>('.lab-canvas')!;
  const caption = (html: string) => (body.querySelector<HTMLElement>('.lab-caption')!.innerHTML = html);
  const out = (ids: number[], line: string) => {
    body.querySelector<HTMLElement>('.lab-out')!.innerHTML = `<p class="small">${line}</p>${creditsGrid(ids)}<button type="button" class="btn sm" id="lab-copy">Copy the 80 Credit numbers</button>`;
    body.querySelector('#lab-copy')?.addEventListener('click', () => void navigator.clipboard.writeText(ids.join(',')).then(() => toast('Copied.', 'ok')));
  };
  let run = () => {};

  // ---------------------------------------------------------------- maze
  let seed = 11, solved = false, maze: Maze | null = null;
  function mazeControls(el: HTMLElement) {
    el.innerHTML = `<p class="small">Amortized outlines every inked shape, so its paper reads as passages. Each Credit is a room; their doors line up into one maze with one way through, top to bottom.</p>
      <div class="lab-row"><button type="button" class="btn primary" id="lab-new" aria-keyshortcuts="N">New maze</button><button type="button" class="btn" id="lab-solve" aria-pressed="${solved}" aria-keyshortcuts="S">Show the way through</button><span class="small muted num" id="lab-seed"></span></div>`;
    el.querySelector('#lab-new')!.addEventListener('click', () => ((seed = 1 + Math.floor(Math.random() * 1e6)), run()));
    el.querySelector('#lab-solve')!.addEventListener('click', (e) => {
      solved = !solved;
      (e.currentTarget as HTMLElement).setAttribute('aria-pressed', String(solved));
      paintMaze();
    });
  }
  function paintMaze() {
    if (!maze) return;
    const { g, W } = drawStatement(canvas(), 'Amortized', pool(), maze.ids);
    if (solved) drawPath(g, W, maze.path);
  }

  // ---------------------------------------------------------------- wave
  const wave: WaveParams = { shape: 'Wave', color: 'C M Y K', middle: 32, height: 10, waves: 3, shift: 90 };
  function waveControls(el: HTMLElement) {
    const slider = (k: keyof WaveParams, label: string, min: number, max: number, step: number) =>
      `<label class="lab-slider"><span>${label}</span><input type="range" data-k="${k}" min="${min}" max="${max}" step="${step}" value="${wave[k]}"><output class="num">${wave[k]}</output></label>`;
    el.innerHTML = `<p class="small">Reconciled draws one row per Credit, as long as its ink, lights to darks. Eighty lengths draw the shape.</p>
      <div class="lab-pills" role="radiogroup" aria-label="Shape">${WAVE_SHAPES.map((s) => `<button type="button" role="radio" aria-checked="${s === wave.shape}" data-shape="${s}">${s}</button>`).join('')}</div>
      <div class="lab-pills" role="radiogroup" aria-label="Colour">${WAVE_COLORS.map((c) => `<button type="button" role="radio" aria-checked="${c === wave.color}" data-color="${c}">${c}</button>`).join('')}</div>
      ${slider('middle', 'Middle', 12, 64, 1)}${slider('height', 'Height', 0, 30, 1)}${slider('waves', 'Waves', 0.5, 8, 0.5)}${slider('shift', 'Shift', 0, 360, 15)}
      <p class="small muted" id="lab-range"></p>`;
    el.querySelectorAll<HTMLButtonElement>('[data-shape]').forEach((b) =>
      b.addEventListener('click', () => {
        wave.shape = b.dataset.shape as WaveShape;
        el.querySelectorAll('[data-shape]').forEach((x) => x.setAttribute('aria-checked', String(x === b)));
        run();
      }),
    );
    el.querySelectorAll<HTMLButtonElement>('[data-color]').forEach((b) =>
      b.addEventListener('click', () => {
        wave.color = b.dataset.color as WaveColor;
        el.querySelectorAll('[data-color]').forEach((x) => x.setAttribute('aria-checked', String(x === b)));
        run();
      }),
    );
    el.querySelectorAll<HTMLInputElement>('input[type=range]').forEach((r) =>
      r.addEventListener('input', () => {
        (wave as unknown as Record<string, number>)[r.dataset.k!] = Number(r.value);
        r.nextElementSibling!.textContent = r.value;
        run();
      }),
    );
  }

  // ---------------------------------------------------------------- shape
  const mask = new Uint8Array(64 * 80);
  let preset = 'Spades';
  const PRESETS = SHAPES;
  const usePreset = (name: string) => { preset = name; for (let y = 0; y < 80; y++) for (let x = 0; x < 64; x++) mask[y * 64 + x] = PRESETS[name](x, y) ? 1 : 0; };
  usePreset(preset);
  function shapeControls(el: HTMLElement) {
    el.innerHTML = `<p class="small">Accrued draws the line where the page's ink gets dense. Light Credits go inside your shape and dense ones around it, so the line traces it. It reads cleanest at about half the page; a smaller shape gets a light band round the edge to balance it, and the line draws that too.</p>
      <div class="lab-pills" role="radiogroup" aria-label="Shape">${Object.keys(PRESETS).map((s) => `<button type="button" role="radio" aria-checked="${s === preset}" data-preset="${s}">${s}</button>`).join('')}<button type="button" data-clear>Clear</button></div>
      <canvas class="lab-pad" width="256" height="320" aria-label="Draw the shape: drag to paint, Alt-drag to erase"></canvas>
      <p class="small muted">Drag to paint, hold Alt (Option) to erase. The preview updates when you let go.</p>`;
    const pad = el.querySelector<HTMLCanvasElement>('.lab-pad')!, pg = pad.getContext('2d')!;
    const paintPad = () => {
      pg.fillStyle = '#fff';
      pg.fillRect(0, 0, 256, 320);
      pg.fillStyle = '#111';
      for (let i = 0; i < mask.length; i++) if (mask[i]) pg.fillRect((i % 64) * 4, Math.floor(i / 64) * 4, 4, 4);
    };
    paintPad();
    el.querySelectorAll<HTMLButtonElement>('[data-preset]').forEach((b) =>
      b.addEventListener('click', () => {
        usePreset(b.dataset.preset!);
        el.querySelectorAll('[data-preset]').forEach((x) => x.setAttribute('aria-checked', String(x === b)));
        paintPad();
        run();
      }),
    );
    el.querySelector('[data-clear]')!.addEventListener('click', () => {
      mask.fill(0);
      el.querySelectorAll('[data-preset]').forEach((x) => x.setAttribute('aria-checked', 'false'));
      paintPad();
      run();
    });
    let down = false;
    const brush = (e: PointerEvent) => {
      const r = pad.getBoundingClientRect(), x = Math.floor(((e.clientX - r.left) / r.width) * 64), y = Math.floor(((e.clientY - r.top) / r.height) * 80);
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
        const X = x + dx, Y = y + dy;
        if (X >= 0 && Y >= 0 && X < 64 && Y < 80 && dx * dx + dy * dy <= 5) mask[Y * 64 + X] = e.altKey ? 0 : 1;
      }
      paintPad();
    };
    pad.addEventListener('pointerdown', (e) => ((down = true), pad.setPointerCapture(e.pointerId), brush(e)));
    pad.addEventListener('pointermove', (e) => down && brush(e));
    pad.addEventListener('pointerup', () => ((down = false), run()));
  }

  // ---------------------------------------------------------------- planning, then the preview
  let pending = 0;
  run = () => {
    const ticket = ++pending;
    caption('Working…');
    // let the caption paint before the planner takes the thread
    setTimeout(() => {
      if (ticket !== pending || !app.isConnected) return;
      const p = pool(), x = ix(p);
      if (tab === 'maze') {
        x.maze ??= mazeIndex(p);
        maze = planMaze(p, x.maze, seed);
        body.querySelector('#lab-seed')!.textContent = `Maze ${seed}`;
        if (!maze) return caption('No maze from these Credits this time. Try New maze.');
        paintMaze();
        caption(`Amortized · 80 Credits · the way through is ${maze.path.length} pixels${maze.leaks ? ` · ${maze.leaks} leaks` : ''}`);
        out(maze.ids, sale ? `Buying all 80 costs about <strong>${eth(maze.cost)}</strong>.` : 'From the whole edition, for sale or not.');
      }
      if (tab === 'wave') {
        x.wave ??= waveIndex(p);
        const w = planWave(p, x.wave, wave), range = waveRange(x.wave, wave.color);
        body.querySelector('#lab-range')!.textContent = `${wave.color} rows run ${range.lo} to ${range.hi} pixels in this pool; longer or shorter rows come out as close as it allows.`;
        drawStatement(canvas(), 'Reconciled', p, w.ids);
        caption(`Reconciled · 80 Credits${w.off ? ` · ${w.off} pixels off the shape in all` : ' · every row exact'}`);
        out(w.ids, sale ? `Buying all 80 costs about <strong>${eth(w.cost)}</strong>.` : 'From the whole edition, for sale or not.');
      }
      if (tab === 'shape') {
        x.shape ??= shapeIndex(p);
        if (!mask.some(Boolean)) return caption('Draw a shape, or pick one.');
        const s = planShape(p, x.shape, mask);
        drawStatement(canvas(), 'Accrued', p, s.ids);
        caption('Accrued · 80 Credits');
        out(s.ids, sale ? `Buying all 80 costs about <strong>${eth(s.cost)}</strong>.` : 'From the whole edition, for sale or not.');
      }
    }, 30);
  };
  show();
}
