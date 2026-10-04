/// Share for the Statement views: the picture as you see it, large, then Copy image and Download image, and for a
/// view that moves, Download video (MP4) and Download GIF of its animation. Everything is drawn and encoded in this
/// browser, frame by frame from the view's own drawing, so a file is exactly the view.
import type { Film } from './overprint';
import { openModal, toast } from './ui';

const PNG = [2160, 2700] as const; // the picture at 2x
const MP4 = [1080, 1350] as const;
const GIF = [720, 900] as const;
const FPS = 30;
const GIF_FPS = 20;

const tick = () => new Promise((r) => setTimeout(r, 0));
const save = (blob: Blob, name: string) => {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 20_000);
};
function frame(film: Film, [W, H]: readonly [number, number], t: number, moving: boolean) {
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  film.draw(c.getContext('2d')!, W, H, t, moving);
  return c;
}
const png = (c: HTMLCanvasElement) => new Promise<Blob>((ok, no) => c.toBlob((b) => (b ? ok(b) : no(new Error('no image'))), 'image/png'));

/// The first H.264 profile this browser can encode at this size, or null.
async function codec(W: number, H: number) {
  if (typeof VideoEncoder === 'undefined') return null;
  for (const c of ['avc1.640028', 'avc1.4d0028', 'avc1.420028'])
    try {
      if ((await VideoEncoder.isConfigSupported({ codec: c, width: W, height: H, bitrate: 10_000_000, framerate: FPS })).supported) return c;
    } catch {}
  return null;
}

/// The film as an MP4: every frame drawn, encoded with WebCodecs and muxed in memory.
export async function mp4(film: Film, progress: (f: number) => void): Promise<Blob> {
  const [W, H] = MP4;
  const c = await codec(W, H);
  if (!c) throw new Error('This browser can’t make video. Try Chrome or Safari.');
  const { Muxer, ArrayBufferTarget } = await import('mp4-muxer');
  const target = new ArrayBufferTarget();
  const muxer = new Muxer({ target, video: { codec: 'avc', width: W, height: H, frameRate: FPS }, fastStart: 'in-memory', firstTimestampBehavior: 'offset' });
  let failed: unknown = null;
  const enc = new VideoEncoder({ output: (chunk, meta) => muxer.addVideoChunk(chunk, meta), error: (e) => (failed = e) });
  enc.configure({ codec: c, width: W, height: H, bitrate: 10_000_000, framerate: FPS, avc: { format: 'avc' } });
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const g = canvas.getContext('2d')!;
  const frames = Math.max(1, Math.round(film.length * FPS));
  for (let i = 0; i < frames; i++) {
    if (failed) throw failed;
    film.draw(g, W, H, i / FPS, true);
    const f = new VideoFrame(canvas, { timestamp: Math.round((i * 1e6) / FPS), duration: Math.round(1e6 / FPS) });
    enc.encode(f, { keyFrame: i % (FPS * 2) === 0 });
    f.close();
    while (enc.encodeQueueSize > 6) await new Promise((r) => setTimeout(r, 2));
    if (i % 4 === 0) {
      progress(i / frames);
      await tick();
    }
  }
  await enc.flush();
  enc.close();
  if (failed) throw failed;
  muxer.finalize();
  return new Blob([target.buffer], { type: 'video/mp4' });
}

/// The film as a looping GIF. One palette for the whole film, made from frames across it, so colours hold still from
/// frame to frame and each frame only has to be mapped onto it. A frame the same as the one before only lengthens that
/// one's delay, so the still moments cost nothing.
export async function gif(film: Film, progress: (f: number) => void): Promise<Blob> {
  const [W, H] = GIF;
  const { GIFEncoder, quantize, applyPalette } = await import('gifenc');
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const g = canvas.getContext('2d', { willReadFrequently: true })!;
  const frames = Math.max(1, Math.round(film.length * GIF_FPS));
  // Every fourth pixel of eight frames spread over the film: enough to find its colours, quick to quantize.
  const SAMPLES = 8, pool = new Uint8ClampedArray(SAMPLES * Math.ceil((W * H) / 4) * 4);
  let o = 0;
  for (let k = 0; k < SAMPLES; k++) {
    film.draw(g, W, H, (k / SAMPLES) * film.length, true);
    const d = g.getImageData(0, 0, W, H).data;
    for (let i = 0; i < d.length; i += 16) (pool[o++] = d[i]), (pool[o++] = d[i + 1]), (pool[o++] = d[i + 2]), (pool[o++] = d[i + 3]);
  }
  const palette = quantize(pool.subarray(0, o), 256, { format: 'rgb444' });
  const enc = GIFEncoder();
  let prev: Uint32Array | null = null;
  let held: Uint8Array | null = null;
  let delay = 0, first = true;
  const flush = () => {
    if (!held) return;
    enc.writeFrame(held, W, H, { palette: first ? palette : undefined, delay: Math.round(delay), repeat: 0 });
    first = false;
  };
  for (let i = 0; i < frames; i++) {
    film.draw(g, W, H, i / GIF_FPS, true);
    const data = g.getImageData(0, 0, W, H).data;
    const words = new Uint32Array(data.buffer);
    if (prev && prev.length === words.length && prev.every((v, k) => v === words[k])) {
      delay += 1000 / GIF_FPS;
      continue;
    }
    flush();
    held = applyPalette(data, palette, 'rgb444');
    delay = 1000 / GIF_FPS;
    prev = words;
    progress(i / frames);
    await tick();
  }
  flush();
  enc.finish();
  return new Blob([enc.bytes() as Uint8Array<ArrayBuffer>], { type: 'image/gif' });
}

/// The Share modal for a view's film.
export function openExport(film: Film) {
  const moves = film.length > 0;
  const d = document.createElement('dialog');
  d.className = 'share st-export';
  d.innerHTML = `<form method="dialog">
    <h3>Share</h3>
    <canvas class="share-preview" aria-label="The picture"></canvas>
    <div class="share-go">
      ${moves ? '<button type="button" class="btn primary" data-act="mp4">Download video</button><button type="button" class="btn" data-act="gif">Download GIF</button>' : ''}
      <button type="button" class="btn${moves ? '' : ' primary'}" data-act="copy">Copy image</button>
      <button type="button" class="btn" data-act="png">Download image</button>
    </div>
    <p class="st-export-note muted small" aria-live="polite"></p>
  </form>`;
  document.body.append(d);
  const preview = d.querySelector<HTMLCanvasElement>('.share-preview')!;
  const note = d.querySelector<HTMLElement>('.st-export-note')!;
  let open = true, raf = 0;
  d.addEventListener('close', () => {
    open = false;
    cancelAnimationFrame(raf);
    d.remove();
  });
  openModal(d);
  // The preview plays the animation the files will hold; a still shows the moment you opened it on.
  const sized = () => {
    const W = Math.round((preview.clientWidth || 440) * Math.min(2, devicePixelRatio || 1));
    if (preview.width !== W) (preview.width = W), (preview.height = Math.round(W * 1.25));
  };
  const t0 = performance.now();
  const loop = (now: number) => {
    if (!open) return;
    sized();
    const t = ((now - t0) / 1000) % film.length;
    film.draw(preview.getContext('2d')!, preview.width, preview.height, t, true);
    raf = requestAnimationFrame(loop);
  };
  if (moves) raf = requestAnimationFrame(loop);
  else {
    sized();
    film.draw(preview.getContext('2d')!, preview.width, preview.height, film.at, false);
  }

  const busy = (on: boolean) => d.querySelectorAll<HTMLButtonElement>('[data-act]').forEach((b) => (b.disabled = on));
  d.addEventListener('click', async (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
    if (!b) return;
    const act = b.dataset.act;
    if (act === 'png' || act === 'copy') {
      // A promise, not a blob: the clipboard takes it while the click still counts, even while the picture draws.
      const image = Promise.resolve().then(() => png(frame(film, PNG, film.at, false)));
      if (act === 'png') return void save(await image, `${film.name}.png`);
      return void navigator.clipboard.write([new ClipboardItem({ 'image/png': image })]).then(
        () => toast('Image copied', 'ok', 2500),
        async () => (save(await image, `${film.name}.png`), toast('Couldn’t copy, downloaded it instead', 'info', 3500)),
      );
    }
    busy(true);
    const what = act === 'mp4' ? 'video' : 'GIF';
    try {
      const blob = await (act === 'mp4' ? mp4 : gif)(film, (f) => open && (note.textContent = `Making the ${what} · ${Math.round(f * 100)}%`));
      if (!open) return;
      note.textContent = '';
      save(blob, `${film.name}.${act}`);
    } catch (err) {
      note.textContent = err instanceof Error ? err.message : `Couldn’t make the ${what}`;
    } finally {
      busy(false);
    }
  });
}
