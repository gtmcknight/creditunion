/// Magic eye: an autostereogram whose texture is a wall of real Credits (idea from credits.rhps.fun).
/// A strip of Credits repeats every P pixels; where the hidden shape should float the repeat shortens.
/// It's computed per pixel from a smooth depth map, so the shapes keep their curves instead of 16px blocks.
/// Opened from the eye in the footer, full screen, Esc closes.

const PALETTE = ['#ffffff', '#00b5e2', '#e4007c', '#00006e', '#ffd100', '#009400', '#e40000', '#000000', '#111111', '#000c0f', '#0f0008', '#000007', '#110e00', '#000a00', '#0f0000', '#000000'];
const RGB = PALETTE.map((h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]);
const TILE = 16; // px per Credit in the texture: 2px per cell
const P = 128; // the far repeat: 8 Credits wide
const DEPTH = 22; // how many pixels shorter the repeat gets at the shape's nearest point

type Draw = (c: OffscreenCanvasRenderingContext2D, W: number, H: number) => void;

const glyph = (t: string): Draw => (c, W, H) => {
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  let size = Math.floor(H * 0.86);
  do {
    c.font = `800 ${size}px Geist, Helvetica, Arial, sans-serif`;
    if (c.measureText(t).width <= W * 0.8) break;
  } while (--size > 6);
  c.fillText(t, W / 2, H / 2 + size * 0.04);
};

// Opepen, traced from the art on an 8×8 grid of units: the head (two top forms, two quarter-round eyes, the
// jaw) and the top of the body. Yellow forms float forward, the white eyes sit halfway, the black is the wall.
const opepen: Draw = (c, W, H) => {
  const u = Math.min(W / 6.5, H / 8.5), x0 = W / 2 - 2 * u, y0 = H / 2 - 3.1 * u; // ~70% of the wall's height, room above and below
  const X = (k: number) => x0 + k * u, Y = (k: number) => y0 + k * u;
  const near = '#fff', mid = '#999';
  // top left: a square with its top-right corner rounded into a quarter circle
  c.fillStyle = near;
  c.beginPath();
  c.moveTo(X(0), Y(0));
  c.lineTo(X(1), Y(0));
  c.arc(X(1), Y(1), u, -Math.PI / 2, 0);
  c.lineTo(X(0), Y(1));
  c.closePath();
  c.fill();
  // top right: a half dome
  c.beginPath();
  c.moveTo(X(2), Y(1));
  c.arc(X(3), Y(1), u, Math.PI, 0);
  c.closePath();
  c.fill();
  // the eyes: quarter circles hanging down-left from each form
  c.fillStyle = mid;
  for (const cx of [1, 3]) {
    c.beginPath();
    c.moveTo(X(cx), Y(1));
    c.arc(X(cx), Y(1), u, Math.PI / 2, Math.PI);
    c.closePath();
    c.fill();
  }
  // the jaw: a block with rounded bottom corners
  c.fillStyle = near;
  c.beginPath();
  c.moveTo(X(0), Y(2));
  c.lineTo(X(4), Y(2));
  c.lineTo(X(4), Y(3));
  c.arc(X(3), Y(3), u, 0, Math.PI / 2);
  c.lineTo(X(1), Y(4));
  c.arc(X(1), Y(3), u, Math.PI / 2, Math.PI);
  c.closePath();
  c.fill();
  // the shoulders: rounded top corners, cut off by the frame
  c.beginPath();
  c.moveTo(X(0), Y(6.2));
  c.lineTo(X(0), Y(6));
  c.arc(X(1), Y(6), u, Math.PI, -Math.PI / 2);
  c.lineTo(X(3), Y(5));
  c.arc(X(3), Y(6), u, -Math.PI / 2, 0);
  c.lineTo(X(4), Y(6.2));
  c.closePath();
  c.fill();
};

// The Checks badge, traced from Jack's: ten round lobes around a disc, the check cut clean through it.
const check: Draw = (c, W, H) => {
  const R = Math.min(W, H) * 0.44, cx = W / 2, cy = H / 2; // R: centre to the tip of a lobe
  const ring = R * (2 / 3), lobe = R / 3;
  c.beginPath();
  c.arc(cx, cy, ring, 0, Math.PI * 2);
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i / 10) * Math.PI * 2;
    c.moveTo(cx + ring * Math.cos(a) + lobe, cy + ring * Math.sin(a));
    c.arc(cx + ring * Math.cos(a), cy + ring * Math.sin(a), lobe, 0, Math.PI * 2);
  }
  c.fill('nonzero');
  // The check is a hole: back at the wall's depth, so it reads as cut out of the seal.
  const u = R / 270; // the reference art is 540px across
  c.strokeStyle = '#000';
  c.lineWidth = 34 * u;
  c.lineCap = 'round';
  c.lineJoin = 'round';
  c.beginPath();
  c.moveTo(cx - 95 * u, cy + 20 * u);
  c.lineTo(cx - 30 * u, cy + 90 * u);
  c.lineTo(cx + 90 * u, cy - 85 * u);
  c.stroke();
};

/// A picture from a depth image in public/magic (white near, grey mid, black the wall), fit to ~80% height.
const images = new Map<string, Promise<HTMLImageElement>>();
const loadImage = (src: string) => {
  let p = images.get(src);
  if (!p) {
    p = new Promise((ok, no) => {
      const i = new Image();
      i.onload = () => ok(i);
      i.onerror = no;
      i.src = src;
    });
    images.set(src, p);
  }
  return p;
};
const picture = (src: string, stand = false): Draw & { src: string } =>
  Object.assign<Draw, { src: string }>((c, W, H) => {
    const i = imageCache.get(src);
    if (!i) return;
    const k = Math.min((W * 0.8) / i.width, (H * 0.8) / i.height), w = i.width * k, h = i.height * k;
    c.drawImage(i, (W - w) / 2, stand ? H - h : (H - h) / 2, w, h); // a portrait stands on the bottom edge
  }, { src });
const imageCache = new Map<string, HTMLImageElement>();

// The classic: two dolphins leaping over the waves in front of a sunset. Three depths: sun far, sea middle,
// dolphins closest. Each dolphin is an arced body that tapers to the snout and tail, with a fin and flukes.
const grey = (z: number) => `rgb(${z},${z},${z})`;
// A leaping dolphin on a 100×56 box, facing right: tail flukes, arched back and fin, rounded melon, beak.
const DOLPHIN = new Path2D(
  'M13,36 C25,20 40,11 56,11 C69,11 79,15 85,21 C88,24 92,26 99,28 L99,30 C92,31 88,31 84,31 ' +
    'C74,28 60,24 46,27 C34,30 24,37 16,44 L5,54 L8,42 L0,31 Z ' +
    'M44,13 C42,8 39,4 35,1 C44,2 52,6 58,11 Z',
);
function dolphin(c: OffscreenCanvasRenderingContext2D, x: number, y: number, w: number, flip: boolean, tilt: number) {
  c.save();
  c.translate(x, y);
  c.rotate(tilt);
  c.scale((flip ? -1 : 1) * (w / 100), w / 100);
  c.translate(-50, -28);
  c.fill(DOLPHIN);
  c.restore();
}
const dolphins: Draw = (c, W, H) => {
  const u = Math.min(W / 1.6, H);
  c.fillStyle = grey(70); // the sun, far back
  c.beginPath();
  c.arc(W / 2 + u * 0.28, H * 0.34, u * 0.2, 0, Math.PI * 2);
  c.fill();
  c.fillStyle = grey(140); // the sea, rolling
  c.beginPath();
  c.moveTo(0, H);
  for (let x = 0; x <= W; x += 4) c.lineTo(x, H * 0.72 + Math.sin(x / (u * 0.09)) * u * 0.02);
  c.lineTo(W, H);
  c.closePath();
  c.fill();
  c.fillStyle = grey(255); // the dolphins, closest
  dolphin(c, W / 2 - u * 0.18, H * 0.6, u * 0.62, false, -0.18);
  dolphin(c, W / 2 + u * 0.34, H * 0.66, u * 0.46, true, 0.2);
};

// A Statement: its 80 squares as a stepped pyramid, the middle rising highest.
const statementDepth: Draw = (c, W, H) => {
  const s = Math.min(W / 8, H / 10) * 0.8, x0 = W / 2 - 4 * s, y0 = H / 2 - 5 * s, gap = s * 0.14;
  for (let r = 0; r < 10; r++)
    for (let k = 0; k < 8; k++) {
      const ring = Math.min(k, 7 - k, r, 9 - r); // 0 at the edge, 3 in the middle
      c.fillStyle = grey(110 + ring * 48);
      c.fillRect(x0 + k * s + gap / 2, y0 + r * s + gap / 2, s - gap, s - gap);
    }
};

// Named for the code, never shown: the buttons just count, so the picture stays a surprise until it rises.
const SUBJECTS: [string, Draw & { src?: string }][] = [
  ['Opepen', opepen],
  ['Check', check],
  ['Jack', picture('/magic/5.png', true)],
  ['Dolphins', dolphins],
  ['Priced by Thirst', picture('/magic/6.png')],
];

let cells: Promise<Uint8Array> | null = null;
const loadCells = () => (cells ??= fetch('/wall.bin').then((r) => r.arrayBuffer()).then((b) => new Uint8Array(b)));

/// A P-wide strip of random Credits, H tall: the texture that repeats across the wall.
function strip(H: number, data: Uint8Array) {
  const n = data.length / 32, px = new Uint8ClampedArray(P * H * 3), u = TILE / 8;
  for (let ty = 0; ty < H; ty += TILE)
    for (let tx = 0; tx < P; tx += TILE) {
      const idx = (Math.random() * n) | 0;
      for (let y = 0; y < TILE && ty + y < H; y++)
        for (let x = 0; x < TILE; x++) {
          const k = ((y / u) | 0) * 8 + ((x / u) | 0), b = data[idx * 32 + (k >> 1)], m = k & 1 ? b >> 4 : b & 15;
          const o = ((ty + y) * P + tx + x) * 3, [r, g, bl] = RGB[m];
          px[o] = r;
          px[o + 1] = g;
          px[o + 2] = bl;
        }
    }
  return px;
}

/// Depth 0..1 per pixel from a drawing: white is nearest, black is the wall.
function depthMap(draw: Draw, W: number, H: number) {
  const off = new OffscreenCanvas(W, H), c = off.getContext('2d', { willReadFrequently: true })!;
  c.fillStyle = '#000';
  c.fillRect(0, 0, W, H);
  c.fillStyle = '#fff';
  draw(c, W, H);
  const d = c.getImageData(0, 0, W, H).data, z = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) z[i] = d[i * 4] / 255;
  return z;
}

/// Draws the magic eye into `host` (which it fills), with its own shape picker and Reveal. Returns a destroy.
export function mountMagic(host: HTMLElement) {
  const el = document.createElement('div');
  el.className = 'magic-embed';
  el.innerHTML = `
    <canvas></canvas>
    <p class="magic-how">Look through the screen until the two dots become three, then hold: the shape rises.</p>
    <div class="magic-bar">
      <div class="magic-subjects" role="radiogroup" aria-label="Hidden shape">${SUBJECTS.map((_, i) => `<button type="button" role="radio" aria-checked="${i === 0}" data-i="${i}" aria-label="Picture ${i + 1}">${i + 1}</button>`).join('')}</div>
      <button type="button" class="magic-reveal" aria-pressed="false">Reveal</button>
    </div>`;
  host.append(el);
  const cv = el.querySelector('canvas')!;
  const cx = cv.getContext('2d')!;
  let pick = 0, reveal = false, alive = true;

  const draw = async () => {
    const data = await loadCells();
    const src = SUBJECTS[pick][1].src;
    if (src && !imageCache.has(src)) imageCache.set(src, await loadImage(src));
    if (!alive) return;
    const vw = el.clientWidth, vh = el.clientHeight;
    cv.width = vw;
    cv.height = vh;
    cx.fillStyle = '#f4f4f2';
    cx.fillRect(0, 0, vw, vh);
    const top = 96, bottom = 72;
    const W = Math.max(P * 3, Math.floor((vw - 48) / P) * P), H = Math.max(120, vh - top - bottom), x0 = Math.round((vw - W) / 2);
    const z = depthMap(SUBJECTS[pick][1], W, H), tex = strip(H, data);
    const img = cx.createImageData(W, H), out = img.data;
    // Each pixel copies the one a (depth-shortened) repeat to its left; the first repeat is the texture itself.
    for (let y = 0; y < H; y++) {
      const row = y * W;
      for (let x = 0; x < W; x++) {
        const sep = P - Math.round(z[row + x] * DEPTH), o = (row + x) * 4;
        if (x < sep) {
          const t = (y * P + (x % P)) * 3;
          out[o] = tex[t];
          out[o + 1] = tex[t + 1];
          out[o + 2] = tex[t + 2];
        } else {
          const q = (row + x - sep) * 4;
          out[o] = out[q];
          out[o + 1] = out[q + 1];
          out[o + 2] = out[q + 2];
        }
        out[o + 3] = 255;
      }
    }
    if (reveal)
      for (let i = 0; i < W * H; i++) {
        const k = (1 - z[i]) * 0.88, o = i * 4; // mid tones show half-faded, so a face keeps its features
        out[o] += (244 - out[o]) * k;
        out[o + 1] += (244 - out[o + 1]) * k;
        out[o + 2] += (242 - out[o + 2]) * k;
      }
    cx.putImageData(img, x0, top);
    // Two guide dots one repeat apart: merge them into three and the wall is in focus.
    cx.fillStyle = '#111';
    for (const dx of [-P / 2, P / 2]) {
      cx.beginPath();
      cx.arc(vw / 2 + dx, top - 18, 5, 0, Math.PI * 2);
      cx.fill();
    }
  };

  const ro = new ResizeObserver(() => draw());
  ro.observe(el);
  el.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    const r = t.closest<HTMLButtonElement>('.magic-reveal');
    if (r) {
      reveal = !reveal;
      r.setAttribute('aria-pressed', String(reveal));
      r.textContent = reveal ? 'Hide' : 'Reveal';
      return draw();
    }
    const b = t.closest<HTMLButtonElement>('[data-i]');
    if (b) {
      pick = Number(b.dataset.i);
      el.querySelectorAll('[data-i]').forEach((x) => x.setAttribute('aria-checked', String(x === b)));
      draw();
    }
  });
  return () => {
    alive = false;
    ro.disconnect();
    el.remove();
  };
}

/// The footer's eye: the magic eye on its own, full screen. Esc or × closes.
export function openMagic() {
  if (document.querySelector('.magic')) return;
  const el = document.createElement('div');
  el.className = 'magic';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-label', 'Magic eye');
  el.innerHTML = `<button type="button" class="magic-close" aria-label="Close">×</button>`;
  document.body.append(el);
  document.body.style.overflow = 'hidden';
  const destroy = mountMagic(el);
  const close = () => {
    removeEventListener('keydown', onKey);
    destroy();
    document.body.style.overflow = '';
    el.remove();
  };
  const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
  addEventListener('keydown', onKey);
  el.querySelector('.magic-close')!.addEventListener('click', close);
}
