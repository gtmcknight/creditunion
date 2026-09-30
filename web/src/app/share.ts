/// Share, under a union's sheet: a modal with the picture it will save, large, and the formats to flip through
/// (All or one, as Now · Finished · Yours shows the Credits), a size, a ground, and Copy or Download. Drawn in this
/// browser from the sheet's own ink; nothing is drawn or cached server side.
import { pickRow, sheetInks } from './directions';
import { BG, drawPicture, keepPrefs, prefs, SIZES, sizeFor, type Bg, type Pick, type Size } from './pictures';
import { openModal, toast } from './ui';

const ICON = '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.25" d="M8 10.5V2.2M5.1 5.1 8 2.2l2.9 2.9M3.1 8.6v5.8h9.8V8.6"/></svg>';

/// The Share button, for the bar under the sheet: icon and word, in full ink so it's noticed.
export const shareButton = () => `<button type="button" class="share-pick">${ICON}<span>Share</span></button>`;

const blobOf = (c: HTMLCanvasElement) => new Promise<Blob>((ok, no) => c.toBlob((b) => (b ? ok(b) : no(new Error('no image'))), 'image/png'));

async function open(host: HTMLElement) {
  const name = host.dataset.name ?? '';
  const { list, ghosts } = await sheetInks(host);
  let pick: Pick = 'All'; // opens on all eight, Jack's 8-up
  const d = document.createElement('dialog');
  d.className = 'share';
  d.innerHTML = `<form method="dialog">
    <h3>Share</h3>
    <canvas class="share-preview" aria-label="The picture"></canvas>
    <div class="share-controls">
    ${pickRow(pick)}
    <div class="share-opts">
      <div class="share-seg" role="radiogroup" aria-label="Size"><button type="button" role="radio" data-size="wide">Wide</button><button type="button" role="radio" data-size="square">Square</button></div>
      <div class="share-swatches" role="radiogroup" aria-label="Background">${(Object.keys(BG) as Bg[])
        .map((b) => `<button type="button" role="radio" data-bg="${b}" aria-label="${b}" data-tip="${b[0].toUpperCase() + b.slice(1)}" style="background:${BG[b]}"></button>`)
        .join('')}</div>
    </div>
    </div>
    <div class="share-go">
      <button type="button" class="btn primary" data-act="copy">Copy image</button>
      <button type="button" class="btn" data-act="save">Download image</button>
    </div>
  </form>`;
  document.body.append(d);
  d.addEventListener('close', () => d.remove());
  const preview = d.querySelector<HTMLCanvasElement>('.share-preview')!;

  /// The full-size picture for the current settings.
  const full = () => {
    const p = prefs();
    const [W, H] = SIZES[sizeFor(p, pick)];
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    drawPicture(c.getContext('2d')!, W, H, pick, list, ghosts, p.bg, name);
    return c;
  };
  const render = () => {
    const p = prefs(), size = sizeFor(p, pick);
    d.querySelectorAll<HTMLElement>('[data-pick]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.pick === pick)));
    d.querySelectorAll<HTMLElement>('[data-size]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.size === size)));
    d.querySelectorAll<HTMLElement>('[data-bg]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.bg === p.bg)));
    const [EW, EH] = SIZES[size];
    preview.style.aspectRatio = `${EW} / ${EH}`;
    const W = Math.round((preview.clientWidth || 520) * Math.min(3, devicePixelRatio || 1)), H = Math.round((W * EH) / EW);
    preview.width = W;
    preview.height = H;
    drawPicture(preview.getContext('2d')!, W, H, pick, list, ghosts, p.bg, name);
  };
  openModal(d);
  render();

  d.addEventListener('click', async (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-pick], [data-size], [data-bg], [data-act]');
    if (!b) return;
    if (b.dataset.pick) {
      pick = b.dataset.pick as Pick;
      return render();
    }
    if (b.dataset.size || b.dataset.bg) {
      const p = prefs();
      if (b.dataset.size) p[pick === 'All' ? 'all' : 'one'] = b.dataset.size as Size;
      if (b.dataset.bg) p.bg = b.dataset.bg as Bg;
      keepPrefs(p);
      return render();
    }
    const png = Promise.resolve().then(() => blobOf(full()));
    const save = async () => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(await png);
      a.download = `${name.replace(/[^\w-]+/g, '-').replace(/^-|-$/g, '').toLowerCase() || 'statement'}-${pick.toLowerCase()}.png`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
    };
    if (b.dataset.act === 'save') return void save();
    // A promise, not a blob: the clipboard takes it while the click still counts, even while the picture draws.
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]).then(
      () => toast('Image copied', 'ok', 2500),
      () => (void save(), toast('Couldn’t copy, downloaded it instead', 'info', 3500)),
    );
  });
  // ← and → flip through the formats.
  d.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const all = [...d.querySelectorAll<HTMLElement>('[data-pick]')].map((b) => b.dataset.pick as Pick);
    const at = all.indexOf(pick);
    pick = all[(at + (e.key === 'ArrowRight' ? 1 : all.length - 1)) % all.length];
    e.preventDefault();
    render();
  });
}

document.addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest('.share-pick');
  const host = b?.closest<HTMLElement>('.dir-host');
  if (host) void open(host);
});
