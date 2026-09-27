/// A range strip: a histogram with two square handles that pick a window [a, b] of whole units (minutes on
/// /time, tenths of a rating point on /rating, Bits on /bits). Drag a handle to move its edge, the window's middle
/// to move the window, anywhere else to jump the nearer edge; arrow keys move a unit (Shift or Page keys `big`),
/// Home and End go to the ends. The page owns everything around it and hears each change through `onChange`.

/// The strip's markup: a canvas, the window, two handles.
export const stripHTML = (from = 'Start', to = 'End') => `<div class="time-strip">
      <canvas aria-hidden="true"></canvas>
      <div class="time-sel"></div>
      <div class="time-handle" data-h="a" role="slider" tabindex="0" aria-label="${from}"></div>
      <div class="time-handle" data-h="b" role="slider" tabindex="0" aria-label="${to}"></div>
    </div>`;

export type Strip = {
  /// Move the window (clamped, a <= b) and redraw; no onChange.
  set(a: number, b: number): void;
  /// Re-measure after a resize, then redraw.
  resize(): void;
};

export function rangeStrip(
  strip: HTMLElement,
  o: {
    counts: ArrayLike<number>; // how many per unit; the strip spans counts.length units
    a: number;
    b: number;
    big: number; // units per Shift+arrow or Page key
    bars?: number; // draw this many bars (each an even share of the units); default one per pixel
    text: (unit: number, edge: 'a' | 'b') => string; // aria-valuetext for an edge
    onChange: (a: number, b: number) => void;
  },
): Strip {
  const M = o.counts.length;
  const clamp = (m: number) => Math.max(0, Math.min(M - 1, m));
  let a = clamp(Math.min(o.a, o.b)), b = clamp(Math.max(o.a, o.b));
  const sc = strip.querySelector('canvas')!;
  const sel = strip.querySelector<HTMLElement>('.time-sel')!;
  const [ha, hb] = [...strip.querySelectorAll<HTMLElement>('.time-handle')];

  // Columns: the mean count per unit under each pixel (or each bar), and the tallest, for the scale.
  let cols = new Float32Array(0), span: [number, number][] = [], peak = 1;
  const measure = () => {
    const dpr = Math.min(2, devicePixelRatio);
    sc.width = Math.max(1, Math.round(strip.clientWidth * dpr));
    sc.height = Math.max(1, Math.round(strip.clientHeight * dpr));
    const n = o.bars ? Math.min(o.bars, M) : sc.width;
    cols = new Float32Array(n);
    span = [];
    for (let x = 0; x < n; x++) {
      const m0 = Math.floor((x * M) / n), m1 = Math.max(m0 + 1, Math.floor(((x + 1) * M) / n));
      let s = 0;
      for (let m = m0; m < m1; m++) s += o.counts[m];
      cols[x] = s / (m1 - m0);
      span.push([m0, m1]);
    }
    peak = Math.max(1, ...cols);
  };
  const draw = () => {
    const g = sc.getContext('2d')!;
    const css = getComputedStyle(document.documentElement);
    const on = css.getPropertyValue('--fg').trim() || '#0a0a0a', off = css.getPropertyValue('--faint').trim() || '#a3a3a3';
    g.clearRect(0, 0, sc.width, sc.height);
    const room = sc.height - 2, n = cols.length, w = sc.width / n;
    const gap = o.bars && w >= 4 ? Math.max(1, Math.round(w / 5)) : 0;
    for (let x = 0; x < n; x++) {
      if (!cols[x]) continue;
      const h = Math.max(1, Math.round(Math.sqrt(cols[x] / peak) * room)); // square root, so the quiet stretches still read
      const [m0, m1] = span[x];
      g.fillStyle = m1 > a && m0 <= b ? on : off;
      const x0 = Math.round(x * w), x1 = Math.round((x + 1) * w) - gap;
      g.fillRect(x0, sc.height - h, Math.max(1, x1 - x0), h);
    }
    const pa = (a / M) * 100, pb = ((b + 1) / M) * 100;
    sel.style.left = `${pa}%`;
    sel.style.width = `${pb - pa}%`;
    ha.style.left = `${pa}%`;
    hb.style.left = `${pb}%`;
    ha.setAttribute('aria-valuemin', '0');
    ha.setAttribute('aria-valuemax', String(b));
    ha.setAttribute('aria-valuenow', String(a));
    ha.setAttribute('aria-valuetext', o.text(a, 'a'));
    hb.setAttribute('aria-valuemin', String(a));
    hb.setAttribute('aria-valuemax', String(M - 1));
    hb.setAttribute('aria-valuenow', String(b));
    hb.setAttribute('aria-valuetext', o.text(b, 'b'));
  };
  const changed = () => {
    draw();
    o.onChange(a, b);
  };

  const edgeAt = (clientX: number) => {
    const r = strip.getBoundingClientRect();
    return Math.round(Math.max(0, Math.min(1, (clientX - r.left) / r.width)) * M);
  };
  let drag: { kind: 'a' | 'b' | 'pan'; at: number; a0: number; b0: number } | null = null;
  const dragTo = (clientX: number) => {
    if (!drag) return;
    const x = edgeAt(clientX);
    if (drag.kind === 'a') a = Math.min(b, clamp(x));
    else if (drag.kind === 'b') b = Math.max(a, clamp(x - 1));
    else {
      const d = Math.max(-drag.a0, Math.min(M - 1 - drag.b0, x - drag.at));
      a = drag.a0 + d;
      b = drag.b0 + d;
    }
    changed();
  };
  strip.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0) return;
    const h = (ev.target as HTMLElement).closest<HTMLElement>('.time-handle');
    const x = edgeAt(ev.clientX);
    let kind: 'a' | 'b' | 'pan';
    // A handle is picked by which side of the window's middle the pointer is on: in a narrow window the two
    // finger-sized targets overlap, and this still takes the one drawn on that side.
    if (h) {
      const r = strip.getBoundingClientRect();
      kind = ev.clientX < r.left + ((a + b + 1) / 2 / M) * r.width ? 'a' : 'b';
    }
    else if (x > a && x <= b && b - a < M - 1) kind = 'pan';
    else kind = Math.abs(x - a) <= Math.abs(x - (b + 1)) ? 'a' : 'b';
    drag = { kind, at: x, a0: a, b0: b };
    strip.setPointerCapture(ev.pointerId);
    strip.classList.add('dragging');
    (kind === 'b' ? hb : ha).focus({ preventScroll: true });
    if (kind !== 'pan') dragTo(ev.clientX);
    ev.preventDefault();
  });
  strip.addEventListener('pointermove', (ev) => {
    if (drag) dragTo(ev.clientX);
    else {
      const x = edgeAt(ev.clientX);
      strip.style.cursor = (ev.target as HTMLElement).closest('.time-handle') ? '' : x > a && x <= b ? 'grab' : '';
    }
  });
  const endDrag = () => {
    drag = null;
    strip.classList.remove('dragging');
  };
  strip.addEventListener('pointerup', endDrag);
  strip.addEventListener('pointercancel', endDrag);
  for (const h of [ha, hb]) {
    h.addEventListener('keydown', (ev) => {
      const big = ev.shiftKey ? o.big : 1;
      const step =
        ev.key === 'ArrowLeft' || ev.key === 'ArrowDown' ? -big
        : ev.key === 'ArrowRight' || ev.key === 'ArrowUp' ? big
        : ev.key === 'PageDown' ? -o.big
        : ev.key === 'PageUp' ? o.big
        : ev.key === 'Home' ? -M
        : ev.key === 'End' ? M
        : 0;
      if (!step) return;
      ev.preventDefault();
      if (h === ha) a = Math.max(0, Math.min(b, a + step));
      else b = Math.min(M - 1, Math.max(a, b + step));
      changed();
    });
  }

  measure();
  draw();
  return {
    set(na, nb) {
      a = clamp(Math.min(na, nb));
      b = clamp(Math.max(na, nb));
      draw();
    },
    resize() {
      measure();
      draw();
    },
  };
}
