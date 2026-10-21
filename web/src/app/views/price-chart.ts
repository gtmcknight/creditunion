/// $BALANCE's price for /balance's right column: the price now (or where the pointer is) and its change over the range
/// shown, the line, and the ranges its history has reached (the Worker's /market/balance-price.json, a point a minute
/// from the pool's swaps). Kept between the page's redraws, so a redraw shows it at once; read again each minute
/// while the page is up.

type Point = [number, number]; // unix seconds, USD
type Data = { at: number; first: number; price: { eth: number; usd: number } | null; supply: number | null; ranges: Record<string, Point[]> };
const ORDER = ['1H', '1D', '1W', 'All'];
const SINCE: Record<string, string> = { '1H': 'past hour', '1D': 'past day', '1W': 'past week', All: 'since open' };
const H = 150;
const PAD = 10;

let data: Data | null = null;
let readAt = 0;
let picked = '';
let reading: Promise<void> | null = null;

/// A $BALANCE price in dollars: four decimals under $1, as the chart and You get's "each" both write it.
export const usdPrice = (v: number) => `$${v >= 1 ? v.toFixed(2) : v >= 0.01 ? v.toFixed(4) : v.toPrecision(3)}`;
/// A market cap to three figures: $5.78M.
const cap = (v: number) => {
  const [d, u] = v >= 1e9 ? [1e9, 'B'] : v >= 1e6 ? [1e6, 'M'] : [1e3, 'K'];
  return `$${Number((v / d).toPrecision(3))}${u}`;
};
const when = (t: number, long: boolean) =>
  new Date(t * 1000).toLocaleString('en-US', long ? { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' } : { hour: 'numeric', minute: '2-digit' });

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
export function priceChart(host: HTMLElement) {
  const draw = () => {
    const ranges = ORDER.filter((r) => (data?.ranges[r]?.length ?? 0) > 1);
    if (!data || !ranges.length) return void (host.innerHTML = '');
    const range = ranges.includes(picked) ? picked : ranges.includes('1D') ? '1D' : ranges[ranges.length - 1];
    const pts = [...data.ranges[range]];
    // The pool's price now ends the line, past the last minute's point.
    if (data.price && Math.floor(data.at / 1000) > pts[pts.length - 1][0]) pts.push([Math.floor(data.at / 1000), data.price.usd]);
    const W = Math.max(200, host.clientWidth || 340);
    const t0 = pts[0][0], t1 = pts[pts.length - 1][0];
    const vs = pts.map((p) => p[1]);
    const lo = Math.min(...vs), hi = Math.max(...vs);
    const x = (t: number) => ((t - t0) / Math.max(1, t1 - t0)) * (W - 4); // the dot at the end fits inside
    const y = (v: number) => PAD + (1 - (v - lo) / (hi - lo || 1)) * (H - 2 * PAD);
    const line = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p[0]).toFixed(1)} ${y(p[1]).toFixed(1)}`).join(' ');
    const [lx, ly] = [x(t1), y(pts[pts.length - 1][1])];
    host.innerHTML = `
      <div class="pc-head"><span class="pc-price num"></span><span class="pc-mc"></span><span class="pc-change"></span></div>
      <svg class="pc-line" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="$BALANCE price, ${SINCE[range]}">
        <line class="pc-base" x1="0" x2="${W}" y1="${y(pts[0][1]).toFixed(1)}" y2="${y(pts[0][1]).toFixed(1)}"/>
        <path d="${line}"/>
        <line class="pc-hair" y1="0" y2="${H}" style="display: none"/>
        <circle class="pc-dot" cx="${lx.toFixed(1)}" cy="${ly.toFixed(1)}" r="3"/>
      </svg>
      ${ranges.length > 1 ? `<div class="pc-ranges">${ranges.map((r) => `<button type="button" data-range="${r}"${r === range ? ' aria-pressed="true"' : ''}>${r}</button>`).join('')}</div>` : ''}`;
    const price = host.querySelector<HTMLElement>('.pc-price')!, change = host.querySelector<HTMLElement>('.pc-change')!, mc = host.querySelector<HTMLElement>('.pc-mc')!;
    const dot = host.querySelector<SVGCircleElement>('.pc-dot')!, hair = host.querySelector<SVGLineElement>('.pc-hair')!;
    const head = (i: number | null) => {
      const p = pts[i ?? pts.length - 1];
      price.textContent = usdPrice(p[1]);
      // The price times every $BALANCE there is, as DexScreener counts it.
      mc.innerHTML = data?.supply ? `<span class="num">${cap(p[1] * data.supply)}</span> market cap` : '';
      if (i === null) {
        const pct = ((p[1] - pts[0][1]) / pts[0][1]) * 100;
        change.textContent = `${pct >= 0 ? '+' : '−'}${Math.abs(pct).toFixed(1)}% ${SINCE[range]}`;
        change.className = `pc-change ${pct >= 0 ? 'up' : 'down'}`;
      } else {
        change.textContent = when(p[0], t1 - t0 > 86_400);
        change.className = 'pc-change';
      }
      dot.setAttribute('cx', x(p[0]).toFixed(1));
      dot.setAttribute('cy', y(p[1]).toFixed(1));
      hair.style.display = i === null ? 'none' : ''; // SVG has no hidden attribute
      if (i !== null) hair.setAttribute('x1', x(p[0]).toFixed(1)), hair.setAttribute('x2', x(p[0]).toFixed(1));
    };
    head(null);
    // Under the pointer (or a finger dragged sideways): that minute's price and time.
    const svg = host.querySelector<SVGSVGElement>('svg')!;
    const at = (e: PointerEvent) => {
      const px = ((e.clientX - svg.getBoundingClientRect().left) / svg.getBoundingClientRect().width) * W;
      let best = 0;
      for (let i = 1; i < pts.length; i++) if (Math.abs(x(pts[i][0]) - px) < Math.abs(x(pts[best][0]) - px)) best = i;
      head(best);
    };
    svg.addEventListener('pointermove', at);
    svg.addEventListener('pointerdown', at);
    svg.addEventListener('pointerleave', () => head(null));
    svg.addEventListener('pointerup', (e) => e.pointerType !== 'mouse' && head(null));
    host.querySelectorAll<HTMLButtonElement>('[data-range]').forEach((b) =>
      b.addEventListener('click', () => {
        picked = b.dataset.range!;
        draw();
      }),
    );
  };
  draw();
  // A new width (the window resized, the column moved under the button) draws it again to fit.
  let width = host.clientWidth;
  const fit = new ResizeObserver(() => {
    if (!host.isConnected) return fit.disconnect();
    if (host.clientWidth !== width) (width = host.clientWidth), draw();
  });
  fit.observe(host);
  if (Date.now() - readAt > 20_000) void read().then(() => host.isConnected && draw());
  const timer = setInterval(() => {
    if (!host.isConnected) return clearInterval(timer);
    if (!document.hidden && !host.matches(':hover')) void read().then(() => host.isConnected && draw());
  }, 60_000);
}
