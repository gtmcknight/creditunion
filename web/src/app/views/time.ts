import { go } from '../main';
import { listBatches, type Listed } from '../data';
import { fromLocalInput, toLocalInput } from '../ui';
import { loadTimes, mintSpan, paidAtOrAfter, PAL32, printsFor, tile } from '../wall';
import { rangeStrip, stripHTML } from './range';
import { buyGrid, buyRow, creditsHead, pct, unionsLink } from './trait';

const PAGE = 120; // Credits per Show more
const SIZES = [48, 40, 32, 24, 16, 8, 6, 4, 3, 2, 1]; // Stream tile sizes, device pixels; multiples of 8 draw the art

/// /time?from=<unix>&to=<unix>: a window of the mint. A strip of payments per minute with two handles picks it;
/// above it the Stream view of just that window (each second a column, Credits stacked as they landed); below,
/// the Credit Unions that take them and every Credit paid in it. Windows snap to whole minutes, `to` inclusive.
export async function timePage(app: HTMLElement) {
  app.innerHTML = `
  <section class="trait-page time-page jb">
    ${creditsHead('time')}
    <p class="jb-line num"><b id="time-readout">&nbsp;</b><a class="jb-link" id="time-start" href="/create">Start a Credit Union for them</a><a class="jb-link" id="jb-unions" hidden></a></p>
    <div class="time-stream"><canvas aria-label="The Credits paid in this window, each second a column"></canvas><span class="time-scale small muted"></span></div>
    ${stripHTML()}
    <div class="time-controls">
      <div class="win-inputs"><label><span>Start</span><input type="datetime-local" id="time-from" step="60"></label><label><span>End</span><input type="datetime-local" id="time-to" step="60"></label></div>
      <div class="win-presets"><button type="button" data-pick="first">First hour</button><button type="button" data-pick="last">Last hour</button></div>
    </div>
    ${buyRow('Buy Credits paid in this window')}
  </section>`;
  const sv = app.querySelector<HTMLCanvasElement>('.time-stream canvas')!;
  // Payment times drive everything here; prints load only for the window on screen (printsFor).
  const e = await loadTimes().catch(() => null);
  if (!sv.isConnected) return;
  if (!e) {
    document.getElementById('time-readout')!.textContent = 'Couldn’t load the mint.';
    return;
  }

  // ---- the mint in minutes: minute m covers [BASE + 60m, BASE + 60m + 59]
  const span = mintSpan(e);
  const BASE = Math.floor(span.start / 60) * 60;
  const M = Math.floor(span.end / 60) - BASE / 60 + 1;
  const perMin = new Uint16Array(M);
  for (let i = span.first; i < e.n; i++) perMin[Math.floor((e.times[i] - BASE) / 60)]++;
  const clampM = (m: number) => Math.max(0, Math.min(M - 1, m));
  let a = 0, b = Math.min(M - 1, 59); // the first hour
  const q = new URLSearchParams(location.search);
  const qf = Number(q.get('from')), qt = Number(q.get('to'));
  if (qf > 0 && qt > 0) {
    a = clampM(Math.floor((Math.min(qf, qt) - BASE) / 60));
    b = clampM(Math.floor((Math.max(qf, qt) - BASE) / 60));
  }
  const fromT = () => BASE + a * 60;
  const toT = () => BASE + b * 60 + 59;
  const lo = () => paidAtOrAfter(e, fromT());
  const hi = () => paidAtOrAfter(e, toT() + 1);

  const sec = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit' });
  const min = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const at = (t: number) => sec.format(new Date(t * 1000));

  const readout = document.getElementById('time-readout')!;
  const startBtn = document.getElementById('time-start') as HTMLAnchorElement;
  const drawReadout = () => {
    const i0 = lo(), i1 = hi(), n = i1 - i0;
    readout.innerHTML =
      n === 0 ? `No Credits paid between ${min.format(new Date(fromT() * 1000))} and ${min.format(new Date((toT() + 1) * 1000))}`
      : n === 1 ? `<strong>1 Credit</strong> paid at ${at(e.times[i0])} · ${pct(1)}`
      : `<strong>${n.toLocaleString()} Credits</strong> paid between ${at(e.times[i0])} and ${at(e.times[i1 - 1])} · ${pct(n)}`;
    startBtn.href = `/create?from=${fromT()}&to=${toT()}`;
  };

  // ---- the strip: payments per minute across the whole mint, the window drawn dark (views/range.ts)
  const strip = rangeStrip(app.querySelector<HTMLElement>('.time-strip')!, {
    counts: perMin,
    a,
    b,
    big: 60,
    text: (m, edge) => min.format(new Date((BASE + (edge === 'a' ? m : m + 1) * 60) * 1000)),
    onChange: (na, nb) => {
      a = na;
      b = nb;
      update();
    },
  });

  // ---- the stream: x is time, each column a second (or a few, when the window is wide), stacked as they landed
  const stream = app.querySelector<HTMLElement>('.time-stream')!;
  const scaleEl = stream.querySelector<HTMLElement>('.time-scale')!;
  let img: ImageData | null = null, px: Uint32Array | null = null, W = 1, H = 1;
  const sizeStream = () => {
    const dpr = Math.min(2, devicePixelRatio);
    W = sv.width = Math.max(1, Math.round(stream.clientWidth * dpr));
    H = sv.height = Math.max(1, Math.round(stream.clientHeight * dpr));
    img = new ImageData(W, H);
    px = new Uint32Array(img.data.buffer);
  };
  const prints = printsFor(e.n);
  // Below a whole art tile, a Credit is one square of its most-used ink mix.
  const rep = new Uint32Array(e.n);
  const repOf = (i: number) => {
    if (rep[i]) return rep[i];
    const n = new Uint8Array(16);
    for (let c = 0; c < 32; c++) {
      const byte = prints.cells[i * 32 + c];
      n[byte & 15]++;
      n[byte >> 4]++;
    }
    let best = 0;
    for (let m = 1; m < 16; m++) if (n[m] > n[best] || !best) best = n[m] ? m : best;
    return (rep[i] = PAL32[best] || PAL32[8]);
  };
  // How the last frame was laid out, so a pointer can find the Credit under it.
  let lay = { f: 0, bucket: 1, pitch: 1, s: 1, x0: 0, unit: 1, end: 0 };
  const drawStream = () => {
    if (!px) return;
    px.fill(0); // transparent: the page shows through, like the Rating and Bits strips
    const f = fromT(), secs = toT() - f + 1, i0 = lo(), i1 = hi();
    const room = H - Math.round(8 * Math.min(2, devicePixelRatio));
    // The largest tile that fits a column per second; failing that, the largest that fits at all.
    let pick: typeof lay | null = null, fallback: typeof lay | null = null, tallest = 1;
    for (const s of SIZES) {
      const gap = s >= 8 ? Math.max(2, Math.round(s / 12)) : s >= 3 ? 1 : 0;
      const pitch = s + gap;
      const bucket = Math.max(1, Math.ceil(secs / Math.floor(W / pitch)));
      let stack = 0, run = 0, prev = -1;
      for (let i = i0; i < i1; i++) {
        const c = Math.floor((e.times[i] - f) / bucket);
        if (c !== prev) (prev = c), (run = 0);
        if (++run > stack) stack = run;
      }
      const used = Math.ceil(secs / bucket) * pitch;
      const l = { f, bucket, pitch, s, x0: Math.max(0, Math.floor((W - used) / 2)), unit: pitch, end: i1 };
      if (stack * pitch <= room) {
        fallback ??= l;
        if (bucket === 1) {
          pick = l;
          break;
        }
      }
      if (s === 1) tallest = stack;
    }
    // Too many for even one pixel each: squeeze the stacks to the height.
    lay = pick ?? fallback ?? { f, bucket: Math.max(1, Math.ceil(secs / W)), pitch: 1, s: 1, x0: 0, unit: room / tallest, end: i1 };
    const { bucket, pitch, s, x0, unit } = lay;
    const gap = pitch - s;
    let prev = -1, j = 0;
    for (let i = i0; i < i1; i++) {
      const c = Math.floor((e.times[i] - f) / bucket);
      if (c !== prev) (prev = c), (j = 0);
      const x = x0 + c * pitch;
      const y = unit < 1 ? H - 1 - Math.floor(j * unit) : H - (j + 1) * pitch + gap;
      j++;
      if (!prints.has(i)) continue; // its block is still on the way; drawStream runs again when it lands
      if (s >= 8) {
        // Each Credit keeps its own white paper square; tile() draws only the inked cells.
        if (x + s > 0 && x < W) for (let dy = 0; dy < s; dy++) if (y + dy >= 0 && y + dy < H) px.fill(PAL32[0], (y + dy) * W + Math.max(0, x), (y + dy) * W + Math.min(W, x + s));
        tile(px, W, H, prints.cells, i, x, y, s / 8);
      }
      else {
        const color = repOf(i), side = unit < 1 ? 1 : s;
        for (let dy = 0; dy < side; dy++) {
          const row = (y + dy) * W;
          if (y + dy < 0 || y + dy >= H) continue;
          for (let dx = 0; dx < s; dx++) if (x + dx < W) px[row + x + dx] = color;
        }
      }
    }
    sv.getContext('2d')!.putImageData(img!, 0, 0);
    scaleEl.textContent =
      i1 === i0 ? '' : bucket === 1 ? 'Each column is 1 second' : bucket < 120 ? `Each column is ${bucket} seconds` : `Each column is ${Math.round(bucket / 6) / 10} minutes`;
  };
  // Which Credit is under a point of the stream, or -1.
  const creditAt = (clientX: number, clientY: number) => {
    const r = sv.getBoundingClientRect();
    const X = ((clientX - r.left) / r.width) * W, Y = ((clientY - r.top) / r.height) * H;
    const c = Math.floor((X - lay.x0) / lay.pitch);
    if (c < 0 || X - lay.x0 - c * lay.pitch >= lay.s) return -1;
    const t0 = lay.f + c * lay.bucket;
    const i0 = paidAtOrAfter(e, t0), i1 = Math.min(lay.end, paidAtOrAfter(e, t0 + lay.bucket));
    const row = lay.unit < 1 ? Math.floor((H - 1 - Y) / lay.unit) : Math.floor((H - Y) / lay.pitch);
    return row >= 0 && i0 + row < i1 ? i0 + row : -1;
  };
  sv.addEventListener('pointermove', (ev) => {
    const i = creditAt(ev.clientX, ev.clientY);
    sv.style.cursor = i < 0 ? '' : 'pointer';
    sv.title = i < 0 ? '' : `Credit #${(i + 1).toLocaleString()} · ${at(e.times[i])}`;
  });
  sv.addEventListener('click', (ev) => {
    const i = creditAt(ev.clientX, ev.clientY);
    if (i >= 0) go(`/credit/${i + 1}`);
  });

  // ---- Start and End: typed to the minute; End is where the window ends (exclusive), as the readout says
  const fromIn = document.getElementById('time-from') as HTMLInputElement;
  const toIn = document.getElementById('time-to') as HTMLInputElement;
  fromIn.min = toIn.min = toLocalInput(BASE);
  fromIn.max = toIn.max = toLocalInput(BASE + M * 60);
  fromIn.addEventListener('change', () => {
    const t = fromLocalInput(fromIn.value);
    if (t !== null) {
      a = clampM(Math.floor((t - BASE) / 60));
      if (a > b) b = a;
    }
    update();
  });
  toIn.addEventListener('change', () => {
    const t = fromLocalInput(toIn.value);
    if (t !== null) {
      b = clampM(Math.ceil((t - BASE) / 60) - 1);
      if (b < a) a = b;
    }
    update();
  });
  const picks = app.querySelector<HTMLElement>('.win-presets')!;
  const PICKS: Record<string, [number, number]> = { first: [0, Math.min(M - 1, 59)], last: [Math.max(0, M - 60), M - 1] };
  picks.addEventListener('click', (ev) => {
    const btn = (ev.target as HTMLElement).closest<HTMLButtonElement>('[data-pick]');
    if (!btn) return;
    [a, b] = PICKS[btn.dataset.pick!];
    update();
  });

  // ---- what follows the window: the URL, the Credit Unions, the Credits (after a pause while dragging)
  const unions = listBatches();
  unions.catch(() => {});
  // The Credits paid in the window: listed ones first, cheapest first, then the rest in the order they were paid.
  const grid = buyGrid(app, {}, async (page) => {
    const i0 = lo() + page * PAGE, i1 = Math.min(hi(), i0 + PAGE);
    return { ids: Array.from({ length: Math.max(0, i1 - i0) }, (_, k) => i0 + k + 1), total: hi() - lo() };
  });
  const settle = () => {
    if (!app.isConnected) return;
    history.replaceState(null, '', `/time?from=${fromT()}&to=${toT()}`);
    const f = fromT(), t = toT();
    void unionsLink(app, ({ s: { filter: w } }: Listed) => (!w.paidFrom && !w.paidTo) || ((w.paidFrom || 0) <= t && (w.paidTo || Infinity) >= f), unions, `paidFrom=${f}&paidTo=${t}`);
    void grid.start({ rules: { paidFrom: f, paidTo: t } });
  };
  let timer = 0, queued = false;
  const redraw = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      if (sv.isConnected) drawStream();
    });
  };
  function update(now = false) {
    strip.set(a, b);
    drawReadout();
    fromIn.value = toLocalInput(fromT());
    toIn.value = toLocalInput(toT() + 1);
    picks.querySelectorAll<HTMLButtonElement>('[data-pick]').forEach((p) => {
      const [pa, pb] = PICKS[p.dataset.pick!];
      p.setAttribute('aria-pressed', String(pa === a && pb === b));
    });
    redraw();
    // The window's prints; the stream draws again once they're in.
    prints.need(lo(), hi()).then(redraw, () => {});
    clearTimeout(timer);
    if (now) settle();
    else timer = window.setTimeout(settle, 250);
  }

  sizeStream();
  update(true);
  new ResizeObserver(() => {
    if (!sv.isConnected) return;
    strip.resize();
    sizeStream();
    drawStream();
  }).observe(stream);
}
