/// $BALANCE's market cap for /balance's right column: now (or where the pointer is) and its change over the range shown,
/// the line, and the ranges its history has reached (the Worker's /market/balance-price.json, a point a minute from the
/// pool's swaps, to the latest trade). Read again each block (12 s) while the page is up, and each read eases in, as
/// Benji Taylor's Liveline does: the line grows into the new point, the scale and the number glide to theirs, and the
/// live dot pulses. No motion for those who ask for none. One chart a page: what it has drawn outlives the page's own
/// redraws, so a redraw picks the glide up where it was.

type Point = [number, number]; // unix seconds, USD
type Data = { at: number; first: number; price: { eth: number; usd: number } | null; supply: number | null; ranges: Record<string, Point[]> };
/// What's drawn: the time and value the chart spans, and the headline's value.
type View = { t0: number; t1: number; lo: number; hi: number; v: number };
type Els = { path: SVGPathElement; base: SVGLineElement; hair: SVGLineElement; dot: SVGCircleElement; pulse: SVGCircleElement; num: HTMLElement; change: HTMLElement };
const ORDER = ['1H', '1D', '1W', 'All'];
const SINCE: Record<string, string> = { '1H': 'past hour', '1D': 'past day', '1W': 'past week', All: 'since open' };
let H = 150; // shorter on the homepage, beside the swap box
const PAD = 10;
const EASE = 0.14; // of the way to the new state each frame: settled in about half a second

let data: Data | null = null;
let readAt = 0;
let reading: Promise<void> | null = null;
let picked = '';
let host: HTMLElement | null = null;
let el: Els | null = null;
let built = ''; // the range, ranges and width `el` were made for
let range = '';
let pts: Point[] = [];
let W = 0;
let view: View | null = null; // drawn now
let viewKey = ''; // the range and width it's drawn at
let goal: View | null = null; // easing toward
let frameId = 0;
let pointer: number | null = null; // the point under the pointer
let timer = 0;
const still = matchMedia('(prefers-reduced-motion: reduce)');
// A new width (the window resized, the column moved under the button) draws it again to fit.
const fit = new ResizeObserver(() => host?.isConnected && host.clientWidth && Math.max(200, host.clientWidth) !== W && update());

/// A $BALANCE price in dollars, four decimals under $1: You get's "each", and the chart's number while the supply
/// can't be read.
export const usdPrice = (v: number) => `$${v >= 1 ? v.toFixed(2) : v >= 0.01 ? v.toFixed(4) : v.toPrecision(3)}`;
/// A market cap to three figures: $5.78M, $12.3M.
const cap = (v: number) => {
  const [d, u] = v >= 1e9 ? [1e9, 'B'] : v >= 1e6 ? [1e6, 'M'] : [1e3, 'K'];
  return `$${(v / d).toPrecision(3)}${u}`; // $6.00M, not $6M, so the number keeps its width as it counts
};
const when = (t: number, long: boolean) =>
  new Date(t * 1000).toLocaleString('en-US', long ? { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' } : { hour: 'numeric', minute: '2-digit' });
const show = (v: number) => (data?.supply ? cap(v * data.supply) : usdPrice(v));
const x = (t: number) => ((t - view!.t0) / Math.max(1, view!.t1 - view!.t0)) * (W - 4); // the dot at the end fits inside
const y = (v: number) => PAD + (1 - (v - view!.lo) / (view!.hi - view!.lo || 1)) * (H - 2 * PAD);

function read(): Promise<void> {
  reading ??= fetch('/market/balance-price.json', { signal: AbortSignal.timeout(15_000) })
    .then((r) => (r.ok ? (r.json() as Promise<Data>) : null))
    .then((d) => {
      if (d?.ranges) (data = d), (readAt = Date.now());
    })
    .catch(() => {})
    .finally(() => (reading = null));
  return reading;
}

/// The chart in `host` (empty until there are two points to draw), kept up to date while it's on the page.
export function priceChart(h: HTMLElement) {
  host = h;
  el = null;
  built = '';
  pointer = null;
  fit.disconnect();
  fit.observe(h);
  update();
  if (Date.now() - readAt > 10_000) void read().then(update);
  timer ||= window.setInterval(() => {
    if (!host?.isConnected) return void (clearInterval(timer), (timer = 0));
    if (!document.hidden && pointer === null) void read().then(update);
  }, 12_000);
}

/// One frame of `view`: the line up to its right edge (a newer point grows in from there), the dot at its end or under
/// the pointer, and the number.
function paint() {
  if (!el || !view) return;
  // The line's tip is the gliding value, so a new price moves it there rather than jumping.
  const at_ = (i: number): Point => (i === pts.length - 1 ? [pts[i][0], view!.v] : pts[i]);
  let d = '', end: Point = pts[0];
  for (let i = 0; i < pts.length; i++) {
    let p = at_(i);
    if (p[0] > view.t1 && i > 0) {
      const q = at_(i - 1), k = (view.t1 - q[0]) / Math.max(1, p[0] - q[0]);
      p = [view.t1, q[1] + (p[1] - q[1]) * k];
    }
    d += `${i ? 'L' : 'M'}${x(p[0]).toFixed(1)} ${y(p[1]).toFixed(1)}`;
    end = p;
    if (p[0] >= view.t1) break;
  }
  el.path.setAttribute('d', d);
  const by = y(pts[0][1]).toFixed(1);
  el.base.setAttribute('y1', by), el.base.setAttribute('y2', by);
  const at: Point = pointer === null ? end : pts[pointer];
  for (const c of [el.dot, el.pulse]) c.setAttribute('cx', x(at[0]).toFixed(1)), c.setAttribute('cy', y(at[1]).toFixed(1));
  el.pulse.style.display = pointer === null ? '' : 'none';
  el.hair.style.display = pointer === null ? 'none' : ''; // SVG has no hidden attribute
  if (pointer !== null) el.hair.setAttribute('x1', x(at[0]).toFixed(1)), el.hair.setAttribute('x2', x(at[0]).toFixed(1));
  el.num.textContent = show(pointer === null ? view.v : at[1]);
  if (pointer === null) {
    const pct = ((view.v - pts[0][1]) / pts[0][1]) * 100;
    el.change.textContent = `${pct >= 0 ? '+' : '−'}${Math.abs(pct).toFixed(1)}% ${SINCE[range]}`;
    el.change.className = `pc-change ${pct >= 0 ? 'up' : 'down'}`;
  } else {
    el.change.textContent = when(at[0], view.t1 - view.t0 > 86_400);
    el.change.className = 'pc-change';
  }
}

/// Toward `goal`, a share of the way each frame, until within a thousandth of the span (under half a pixel).
function glide() {
  frameId = 0;
  if (!view || !goal || !host?.isConnected) return;
  const tol = { t: (goal.t1 - goal.t0) / 1000 + 1e-6, v: (goal.hi - goal.lo) / 1000 + 1e-12 };
  let moving = false;
  for (const k of ['t0', 't1', 'lo', 'hi', 'v'] as const) {
    const gap = goal[k] - view[k];
    const near = Math.abs(gap) <= (k[0] === 't' ? tol.t : tol.v);
    view[k] = near ? goal[k] : view[k] + gap * EASE;
    moving ||= !near;
  }
  paint();
  if (moving) frameId = requestAnimationFrame(glide);
}

/// The elements, once per range and width, with what the pointer does on them.
function build(ranges: string[]) {
  const h = host!;
  h.innerHTML = `
    <div class="pc-head"><span class="pc-price num"></span><span class="pc-label">${data?.supply ? 'market cap' : ''}</span><span class="pc-change"></span></div>
    <svg class="pc-line" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="$BALANCE market cap, ${SINCE[range]}">
      <clipPath id="pc-clip"><rect x="0" y="-4" width="${W}" height="${H + 8}"/></clipPath>
      <line class="pc-base" x1="0" x2="${W}"/>
      <path clip-path="url(#pc-clip)"/>
      <line class="pc-hair" y1="0" y2="${H}" style="display: none"/>
      <circle class="pc-pulse" r="2.5"/>
      <circle class="pc-dot" r="2.5"/>
    </svg>
    ${ranges.length > 1 ? `<div class="pc-ranges">${ranges.map((r) => `<button type="button" data-range="${r}"${r === range ? ' aria-pressed="true"' : ''}>${r}</button>`).join('')}</div>` : ''}`;
  const q = <T extends Element>(s: string) => h.querySelector<T>(s)!;
  el = { path: q('path'), base: q('.pc-base'), hair: q('.pc-hair'), dot: q('.pc-dot'), pulse: q('.pc-pulse'), num: q('.pc-price'), change: q('.pc-change') };
  // Under the pointer (or a finger dragged sideways): that minute's market cap and time.
  const svg = q<SVGSVGElement>('svg');
  const under = (e: PointerEvent) => {
    if (!view) return;
    const px = e.clientX - svg.getBoundingClientRect().left;
    let best = 0;
    for (let i = 1; i < pts.length; i++) if (pts[i][0] <= view.t1 && Math.abs(x(pts[i][0]) - px) < Math.abs(x(pts[best][0]) - px)) best = i;
    pointer = best;
    paint();
  };
  const leave = () => {
    pointer = null;
    paint();
  };
  svg.addEventListener('pointermove', under);
  svg.addEventListener('pointerdown', under);
  svg.addEventListener('pointerleave', leave);
  svg.addEventListener('pointerup', (e) => e.pointerType !== 'mouse' && leave());
  h.querySelectorAll<HTMLButtonElement>('[data-range]').forEach((b) =>
    b.addEventListener('click', () => {
      picked = b.dataset.range!;
      update();
    }),
  );
}

/// The latest read, drawn: at once for a new range or width, eased in otherwise.
function update() {
  const h = host;
  if (!h?.isConnected) return;
  const ranges = ORDER.filter((r) => (data?.ranges[r]?.length ?? 0) > 1);
  if (!data || !ranges.length) return void ((h.innerHTML = ''), (el = null), (built = ''));
  range = ranges.includes(picked) ? picked : ranges.includes('1D') ? '1D' : ranges[ranges.length - 1];
  pts = [...data.ranges[range]];
  // The price now ends the line, past the last minute's point.
  if (data.price && Math.floor(data.at / 1000) > pts[pts.length - 1][0]) pts.push([Math.floor(data.at / 1000), data.price.usd]);
  const vs = pts.map((p) => p[1]);
  goal = { t0: pts[0][0], t1: pts[pts.length - 1][0], lo: Math.min(...vs), hi: Math.max(...vs), v: pts[pts.length - 1][1] };
  W = Math.max(200, h.clientWidth || 340);
  H = h.closest('.home') ? 80 : 150;
  const key = `${range}|${ranges.join()}|${W}|${H}`;
  if (key !== built) (built = key), build(ranges);
  if (!view || viewKey !== `${range}|${W}` || still.matches) {
    view = { ...goal };
    viewKey = `${range}|${W}`;
    return paint();
  }
  paint();
  if (!frameId) frameId = requestAnimationFrame(glide);
}
