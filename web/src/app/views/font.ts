import type { Film } from '../overprint';
import { FPS, PNG, frame, gif, mp4, png, save, soundCodec, type Sounded } from '../media-export';
import { esc } from '../ui';
import { printWords, type TypeData } from '../type-shape';
import { Keys, noteOf, score, type Cue, type Style } from '../type-sound';
import DATA from '../type-data.json';

const D = DATA as unknown as TypeData;
const INK = ['#00b5e2', '#e4007c', '#ffd100'];
const LINE = 'MADE\nFROM\nACTS\nOF\nTRUST';
const CHARS = [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.,:;!?\'"-_/()[]{}<>+×÷=*&@#$%^~`|\\…'].filter((c) => c in D.glyphs);
/// The film's clock, in video frames: a beat on the empty sheet, then a letter every sixteenth note (112.5 BPM at
/// 30 fps, so every letter lands on a frame), the line committed an eighth note later, then a hold while it rings.
const LEAD_F = 16;
const KEY_F = 4;
const HOLD = 3.0;

// The sheet's icons, drawn like the header's: a 24 grid, 2px round strokes.
const svg = (body: string) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
const SPEAKER = '<path d="M11 5 6 9H2v6h4l5 4z"/>';
const ICON = {
  paper: svg('<circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor"/>'),
  back: svg('<path d="M18 6 6 18M6 6l12 12"/>'),
  share: svg('<path d="M12 3v12M8 7l4-4 4 4"/><path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7"/>'),
  muted: svg(`${SPEAKER}<path d="m22 9-6 6M16 9l6 6"/>`),
  soft: svg(`${SPEAKER}<path d="M15.5 8.5a5 5 0 0 1 0 7"/>`),
  loud: svg(`${SPEAKER}<path d="M15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14"/>`),
};

type Paper = 'black' | 'white';
const kInk = (p: Paper) => (p === 'black' ? '#fff' : '#000');
/// What apps type for you (smart quotes, dashes, a non-breaking space), as the plain forms the font prints them as.
const PLAIN: Record<string, string> = { '‘': "'", '’': "'", '“': '"', '”': '"', '–': '-', '—': '-', '−': '-', '\u00a0': ' ' };
/// Letters the font file prints as another: ß as ẞ, Đ as Ð, the comma-below Ș and Ț as Ş and Ţ, two lowercase-only letters
/// as their capital.
const SAME: Record<string, string> = { ß: 'ẞ', Đ: 'Ð', đ: 'Ð', Ș: 'Ş', ș: 'Ş', Ț: 'Ţ', ț: 'Ţ', ĸ: 'K', ŉ: 'N' };
/// Capitals print as themselves, accented ones included; an accented letter the font doesn't draw prints as its plain
/// letter, as the font file prints it: Ạ as A.
const plain = (c: string) => {
  if (PLAIN[c] ?? SAME[c]) return PLAIN[c] ?? SAME[c];
  const up = c.toUpperCase();
  if (up.length !== 1) return c;
  if (up in D.glyphs) return up;
  const base = up.normalize('NFD')[0];
  return base in D.glyphs ? base : up;
};
/// Upper-cased one UTF-16 unit at a time, so every index in the box is the same index on the sheet.
const clean = (s: string) => s.slice(0, 280).split('').map(plain).join('');

/// /font: Receipt. Type on the sheet you'll download, save it as a video or picture of the typing, get the font.
export function fontPage(app: HTMLElement) {
  const q = new URLSearchParams(location.search).get('t');
  let paper: Paper = 'black';
  try {
    if (localStorage.getItem('cu-type-paper') === 'white') paper = 'white';
  } catch {}
  // Two columns: the font file with everything about it, and the sheet with what it makes.
  app.innerHTML = `
  <section class="ft">
    <header class="create-head ft-title">
      <h1>Receipt</h1>
      <p class="create-lede">Drawn from <a href="https://x.com/jackbutcher" target="_blank" rel="noopener">Jack Butcher</a>’s $BALANCE lettering. Each letter’s colors come from the word it’s in.</p>
    </header>
    <div class="ft-print">
      <header class="ft-head">
        <h2>Type</h2>
      </header>
      <div class="ft-paper ft-sheet" data-paper="${paper}">
        <canvas class="ft-canvas" aria-hidden="true"></canvas>
        <textarea class="ft-input" id="ft-type" spellcheck="false" autocomplete="off" autocapitalize="characters" maxlength="280" aria-label="Type on the sheet">${esc(clean(q ?? LINE))}</textarea>
        <video class="ft-play" id="ft-video" playsinline loop hidden></video>
        <img class="ft-play" id="ft-gif" alt="The GIF you saved" hidden>
        <div class="ft-tools">
          <button type="button" class="ft-tool ft-shared" id="ft-share" aria-label="Save or share" title="Save or share">${ICON.share}</button>
          <button type="button" class="ft-tool ft-back" id="ft-back" aria-label="Back to typing" title="Back to typing">${ICON.back}</button>
          <button type="button" class="ft-tool" id="ft-sound"></button>
          <button type="button" class="ft-tool" id="ft-flip">${ICON.paper}</button>
        </div>
      </div>
      <div class="ft-actions">
        <div class="ft-bar">
          <button type="button" class="btn" data-act="mp4" aria-label="Download MP4">MP4</button>
          <button type="button" class="btn" data-act="gif" aria-label="Download GIF">GIF</button>
          <button type="button" class="btn" data-act="png" aria-label="Download PNG">PNG</button>
        </div>
        <p class="ft-note small" id="ft-note" aria-live="polite" hidden></p>
      </div>
    </div>
    <div class="ft-font">
      <header class="ft-head">
        <h2>Font</h2>
      </header>
      <div class="ft-paper ft-glyphs" data-paper="${paper}">
        <div class="ft-set" id="ft-set" role="group" aria-label="Characters">${CHARS.map((c) => `<button type="button" data-c="${esc(c)}" aria-label="${esc(c)}">${esc(c)}</button>`).join('')}</div>
        <div class="ft-printings">
          <p class="ft-ways-title" id="ft-ways-title"></p>
          <div class="ft-ways" id="ft-ways"></div>
        </div>
      </div>
      <div class="ft-bar ft-bar-font">
        <a class="btn primary" href="/receipt-font.zip" download>Download font</a>
        <span class="muted small">Free. OTF, TTF, WOFF and WOFF2.</span>
      </div>
    </div>
  </section>`;

  const t = app.querySelector<HTMLTextAreaElement>('#ft-type')!;
  const flip = app.querySelector<HTMLButtonElement>('#ft-flip')!;
  const ways = app.querySelector<HTMLElement>('#ft-ways')!;
  const waysTitle = app.querySelector<HTMLElement>('#ft-ways-title')!;
  const set = app.querySelector<HTMLElement>('#ft-set')!;
  const canvas = app.querySelector<HTMLCanvasElement>('.ft-canvas')!;
  const note = app.querySelector<HTMLElement>('#ft-note')!;
  const acts = [...app.querySelectorAll<HTMLButtonElement>('.ft-bar [data-act]')];
  const say = (msg: string) => ((note.textContent = msg), (note.hidden = !msg));
  // Nothing on the sheet, nothing to save.
  let busy: HTMLButtonElement | null = null;
  const fill = () => acts.forEach((b) => (b.disabled = (!!busy && b !== busy) || !clean(t.value).trim()));
  acts.forEach((b) => (b.dataset.label = b.textContent!));
  // Every export confirms the same way: the button says what happened, then goes back to its name.
  const confirm = (b: HTMLButtonElement, word: string) => {
    b.textContent = word;
    clearTimeout(Number(b.dataset.timer));
    b.dataset.timer = String(window.setTimeout(() => (b.textContent = b.dataset.label!), 1600));
  };
  // What you just saved plays on the sheet, in place, until you go back to typing.
  const sheet = app.querySelector<HTMLElement>('.ft-sheet')!;
  const video = app.querySelector<HTMLVideoElement>('#ft-video')!;
  const still = app.querySelector<HTMLImageElement>('#ft-gif')!;
  let shown = '';
  let pending: File | null = null;
  const stop = () => {
    if (!shown) return;
    video.pause();
    video.hidden = still.hidden = true;
    video.removeAttribute('src');
    still.removeAttribute('src');
    URL.revokeObjectURL(shown);
    shown = '';
    pending = null;
    delete sheet.dataset.playing;
    delete sheet.dataset.share;
  };
  const replay = (blob: Blob, kind: 'mp4' | 'gif', withSound: boolean) => {
    stop();
    shown = URL.createObjectURL(blob);
    sheet.dataset.playing = '';
    // With reduced motion nothing loops by itself: a video waits with its controls, a GIF isn't put back up.
    const calm = matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (kind === 'gif') return void (calm ? stop() : ((still.src = shown), (still.hidden = false)));
    video.src = shown;
    video.muted = !withSound;
    video.loop = video.autoplay = !calm;
    video.controls = calm;
    video.hidden = false;
    if (calm) return;
    // Sound needs the page to have been touched; if the browser still says no, it plays muted.
    video.play().catch(() => ((video.muted = true), video.play().catch(() => {})));
  };
  // On a phone a file belongs in the share sheet (Save Video, Photos, X), not in Files. The share sheet needs a fresh
  // tap and a video takes seconds to make, so the file also waits on the sheet behind a share button.
  const phone = matchMedia('(pointer: coarse)').matches;
  const share = (file: File) => navigator.share({ files: [file] }).then(() => true, () => false);
  /// Saves the file (a download, or on a phone the share sheet); true once it's saved.
  const deliver = async (blob: Blob, name: string) => {
    const file = new File([blob], name, { type: blob.type });
    if (!phone || !navigator.canShare?.({ files: [file] })) return save(blob, name), true;
    pending = file;
    sheet.dataset.share = '';
    return share(file);
  };
  app.querySelector<HTMLButtonElement>('#ft-share')!.onclick = () => pending && void share(pending);
  app.querySelector<HTMLButtonElement>('#ft-back')!.onclick = () => (stop(), t.focus({ preventScroll: true }));
  for (const el of [video, still]) el.addEventListener('click', () => (stop(), t.focus({ preventScroll: true })));

  // The sheet is the picture you download, drawn the same way at screen size: the box you type in is invisible over
  // it, and the sheet draws its caret.
  let geo: Geometry | null = null;
  let blink = true, blinkTimer = 0;
  const draw = () => {
    if (!canvas.clientWidth) return;
    const dpr = Math.min(2, devicePixelRatio || 1);
    const W = Math.round(canvas.clientWidth * dpr), H = Math.round(canvas.clientHeight * dpr);
    if (canvas.width !== W || canvas.height !== H) (canvas.width = W), (canvas.height = H);
    const text = clean(t.value);
    const focused = document.activeElement === t;
    const range = focused && t.selectionStart !== t.selectionEnd;
    // The caret blinks even before the sheet has focus (at the end of the line), so it says the sheet is for typing.
    const caret = blink && !range ? (focused ? t.selectionEnd : text.length) : null;
    geo = paint(canvas.getContext('2d')!, W, H, text, paper, text.length, caret, range ? [t.selectionStart, t.selectionEnd] : null);
  };
  const wake = () => {
    blink = true;
    clearInterval(blinkTimer);
    blinkTimer = window.setInterval(() => {
      if (!app.isConnected) return clearInterval(blinkTimer);
      blink = !blink;
      draw();
    }, 530);
    draw();
  };
  new ResizeObserver(draw).observe(canvas);
  t.addEventListener('focus', wake);
  t.addEventListener('blur', wake);
  t.addEventListener('keyup', wake);
  // ⌘C on the sheet with nothing selected copies the sheet as an image, to paste straight into a post; the PNG button
  // says so. A promise, not a blob: the clipboard takes it while the key press still counts.
  t.addEventListener('keydown', (e) => {
    if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'c' || t.selectionStart !== t.selectionEnd || !clean(t.value).trim()) return;
    e.preventDefault();
    const f = film(clean(t.value), paper, 'off'), pngBtn = app.querySelector<HTMLButtonElement>('[data-act=png]')!;
    const image = Promise.resolve().then(() => png(frame(f, PNG, f.at, false)));
    navigator.clipboard.write([new ClipboardItem({ 'image/png': image })]).then(
      () => confirm(pngBtn, 'Copied'),
      () => say('Couldn’t copy here. PNG saves it instead.'),
    );
  });
  document.addEventListener('selectionchange', () => document.activeElement === t && wake());
  // The sheet takes the pointer the way a text box would: press to place the caret at the letter under it, drag to
  // select, shift-click to extend, double-click for a word. Touch keeps the phone's own handling and only moves the caret on tap.
  const hit = (e: MouseEvent) => {
    if (!geo) return t.value.length;
    const r = canvas.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * canvas.width, y = ((e.clientY - r.top) / r.height) * canvas.height;
    const row = geo.rows.reduce((best, l) => (Math.abs(l.y0 + 4 * geo!.cell - y) < Math.abs(best.y0 + 4 * geo!.cell - y) ? l : best));
    const gap = (k: number) => Math.abs(row.left + row.xs[k] * geo!.cell - x);
    return row.a + row.xs.reduce((best, _, k) => (gap(k) < gap(best) ? k : best), 0);
  };
  let anchor = -1;
  t.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'mouse' || e.button !== 0) return;
    e.preventDefault();
    t.focus({ preventScroll: true });
    anchor = e.shiftKey ? t.selectionStart : hit(e);
    const i = hit(e);
    t.setSelectionRange(Math.min(anchor, i), Math.max(anchor, i), i < anchor ? 'backward' : 'forward');
    t.setPointerCapture(e.pointerId);
    wake();
  });
  t.addEventListener('pointermove', (e) => {
    if (anchor < 0 || !t.hasPointerCapture(e.pointerId)) return;
    const i = hit(e);
    t.setSelectionRange(Math.min(anchor, i), Math.max(anchor, i), i < anchor ? 'backward' : 'forward');
    wake();
  });
  t.addEventListener('pointerup', () => (anchor = -1));
  // A word: the run of letters around the double-click.
  t.addEventListener('dblclick', (e) => {
    const i = hit(e), v = t.value;
    let a = i, b = i;
    while (a > 0 && /\S/.test(v[a - 1])) a--;
    while (b < v.length && /\S/.test(v[b])) b++;
    t.setSelectionRange(a, b);
    wake();
  });
  t.addEventListener('click', (e) => {
    if ((e as PointerEvent).pointerType === 'mouse') return;
    const i = hit(e);
    t.setSelectionRange(i, i);
    wake();
  });

  // Sound, one icon that steps muted, soft, loud: soft is the Quiet score, loud is the Notes score. It plays as you
  // type, and the MP4 carries the same score; each step plays a taste of it.
  type Choice = 'off' | Style;
  const STEPS: Choice[] = ['off', 'quiet', 'notes'];
  const SAY: Record<Choice, string> = { off: 'Sound: muted', quiet: 'Sound: soft', notes: 'Sound: loud' };
  let sound: Choice = 'off';
  try {
    const kept = localStorage.getItem('cu-type-sound');
    sound = kept === 'notes' || kept === 'on' ? 'notes' : kept === 'quiet' ? 'quiet' : 'off';
  } catch {}
  let keys: Keys | null = null;
  const play = (cue: Cue) => {
    if (sound === 'off') return;
    (keys ??= new Keys(sound)).style = sound;
    keys.play(cue);
  };
  const soundBtn = app.querySelector<HTMLButtonElement>('#ft-sound')!;
  const paintSound = () => {
    soundBtn.innerHTML = sound === 'off' ? ICON.muted : sound === 'quiet' ? ICON.soft : ICON.loud;
    soundBtn.setAttribute('aria-label', SAY[sound]);
    soundBtn.title = SAY[sound];
    soundBtn.toggleAttribute('data-on', sound !== 'off');
  };
  soundBtn.onclick = () => {
    sound = STEPS[(STEPS.indexOf(sound) + 1) % STEPS.length];
    try {
      localStorage.setItem('cu-type-sound', sound);
    } catch {}
    paintSound();
    const text = clean(t.value), i = text.search(/\S/);
    if (i >= 0) play({ what: 'letter', i, note: noteOf(printWords(text, D)[i]) });
  };
  paintSound();

  const paintPaper = () => {
    app.querySelectorAll<HTMLElement>('.ft-paper').forEach((el) => (el.dataset.paper = paper));
    flip.setAttribute('aria-label', paper === 'black' ? 'White paper' : 'Black paper');
    flip.title = flip.getAttribute('aria-label')!;
    show(set.querySelector<HTMLElement>('[aria-pressed=true]')?.dataset.c ?? 'A');
    draw();
  };
  flip.onclick = () => {
    paper = paper === 'black' ? 'white' : 'black';
    try {
      localStorage.setItem('cu-type-paper', paper);
    } catch {}
    paintPaper();
  };

  // The line lives in the address, so a link opens on your words.
  let urlTimer = 0;
  t.addEventListener('input', (e) => {
    stop();
    wake();
    fill();
    // A letter ticks, a space or a new line prints the word, a delete ticks quietly.
    const how = (e as InputEvent).inputType ?? '';
    if (how.startsWith('delete')) play({ what: 'delete', i: 0, note: 0 });
    else if (how.startsWith('insert')) {
      const i = t.selectionStart - 1;
      const text = clean(t.value);
      play(i < 0 || /\s/.test(text[i]) ? { what: 'space', i, note: 0 } : { what: 'letter', i, note: noteOf(printWords(text, D)[i]) });
    }
    clearTimeout(urlTimer);
    urlTimer = window.setTimeout(() => {
      const v = clean(t.value);
      history.replaceState(null, '', v && v !== LINE ? `/font?t=${encodeURIComponent(v)}` : '/font');
    }, 300);
  });

  function show(ch: string) {
    const g = D.glyphs[ch];
    waysTitle.textContent = `“${ch}”, ${D.S} ways`;
    const K = kInk(paper);
    ways.innerHTML = g.variants
      .map((v) => `<svg viewBox="0 0 ${g.w} 8" shape-rendering="crispEdges" aria-hidden="true">${g.px.map(([x, y], i) => `<rect x="${x}" y="${y}" width="1" height="1" fill="${v[i] === 3 ? K : INK[v[i]]}"/>`).join('')}</svg>`)
      .join('');
    set.querySelectorAll<HTMLElement>('button').forEach((b) => {
      b.setAttribute('aria-pressed', String(b.dataset.c === ch));
      b.tabIndex = b.dataset.c === ch ? 0 : -1;
    });
  }
  set.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-c]');
    if (b) show(b.dataset.c!);
  });
  // One tab stop for the whole set; the arrow keys move through it, a row at a time up and down.
  set.addEventListener('keydown', (e) => {
    const keys = [...set.querySelectorAll<HTMLButtonElement>('button')];
    const i = keys.indexOf(document.activeElement as HTMLButtonElement);
    if (i < 0) return;
    const row = keys.filter((k) => k.offsetTop === keys[0].offsetTop).length;
    const to = { ArrowLeft: i - 1, ArrowRight: i + 1, ArrowUp: i - row, ArrowDown: i + row, Home: 0, End: keys.length - 1 }[e.key];
    if (to === undefined) return;
    e.preventDefault();
    const k = keys[Math.max(0, Math.min(keys.length - 1, to))];
    show(k.dataset.c!);
    k.focus();
  });
  paintPaper();
  fill();
  // The caret blinking on the sheet says it's for typing. Not on touch screens, where focus opens the keyboard.
  if (matchMedia('(hover: hover)').matches) t.focus({ preventScroll: true }), t.setSelectionRange(t.value.length, t.value.length);

  // The line as a file, made here frame by frame: the video and GIF type it out, the image is the finished line.
  app.querySelector('.ft-bar')!.addEventListener('click', async (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-act]');
    if (!b) return;
    const text = clean(t.value);
    if (!text.trim()) return;
    const f = film(text, paper, sound);
    say('');
    if (b.dataset.act === 'png') {
      const blob = await png(frame(f, PNG, f.at, false));
      if (phone) replay(blob, 'gif', false);
      if (await deliver(blob, `${f.name}.png`)) confirm(b, 'Saved');
      return;
    }
    const isVideo = b.dataset.act === 'mp4', what = isVideo ? 'video' : 'GIF';
    busy = b;
    b.classList.add('is-busy');
    fill();
    let done = false;
    try {
      const silent = isVideo && sound !== 'off' && !(await soundCodec());
      const blob = await (isVideo ? mp4 : gif)(f, (p) => {
        if (!app.isConnected) return;
        b.textContent = `${Math.round(p * 100)}%`;
        b.style.setProperty('--p', String(p));
      });
      if (!app.isConnected) return;
      replay(blob, isVideo ? 'mp4' : 'gif', isVideo && sound !== 'off');
      done = true;
      void deliver(blob, `${f.name}.${isVideo ? 'mp4' : 'gif'}`).then((saved) => saved && confirm(b, 'Saved'));
      // Typing goes straight back to the sheet.
      if (matchMedia('(hover: hover)').matches) t.focus({ preventScroll: true });
      if (silent) say('This browser can’t add sound to video, so the MP4 is silent. Chrome can.');
    } catch (err) {
      say(err instanceof Error ? err.message : `Couldn’t make the ${what}`);
    } finally {
      if (!done) b.textContent = b.dataset.label!;
      b.classList.remove('is-busy');
      b.style.removeProperty('--p');
      busy = null;
      fill();
    }
  });
}

/// Lines of the sheet: the text's own line breaks, then words wrapped into as few lines as about 16 columns allow,
/// as even as they'll go. Each entry is [start index, end index].
function layout(text: string): [number, number][] {
  const longest = Math.max(1, ...text.split(/\s+/).map((w) => w.length));
  const wrap = (cols: number) => {
    const lines: [number, number][] = [];
    let i = 0;
    for (const raw of text.split('\n')) {
      let a = i;
      const end = i + raw.length;
      while (end - a > cols) {
        let cut = text.lastIndexOf(' ', a + cols);
        if (cut <= a) cut = a + cols;
        lines.push([a, cut]);
        a = text[cut] === ' ' ? cut + 1 : cut;
      }
      lines.push([a, end]);
      i = end + 1;
    }
    return lines;
  };
  const most = wrap(Math.max(16, longest)).length;
  for (let cols = longest; ; cols++) if (wrap(cols).length <= most) return wrap(cols);
}

type Geometry = { cell: number; rows: { a: number; b: number; left: number; y0: number; xs: number[] }[] };

/// Where each character of text[a, b) starts, in cells from the start of its line, then where the line ends. A character
/// takes its width and a cell of space: 6 cells for most, 8 for the slashes.
function starts(text: string, a: number, b: number) {
  const xs = [0];
  for (let i = a; i < b; i++) xs.push(xs[xs.length - 1] + (D.glyphs[text[i]]?.w ?? 5) + 1);
  return xs;
}

/// One sheet: `text` laid out and centred, its first `shown` characters printed, a caret before character `caret`
/// (none for null) and a selection behind characters `sel` (none for null). Cells are whole pixels, so every pixel of
/// the type is crisp at any size.
function paint(g: CanvasRenderingContext2D, W: number, H: number, text: string, paper: Paper, shown: number, caret: number | null, sel: [number, number] | null = null): Geometry {
  const lines = layout(text);
  const part = text.slice(0, shown);
  const ink = printWords(part, D);
  g.fillStyle = paper === 'black' ? '#000' : '#fff';
  g.fillRect(0, 0, W, H);
  // At least 8 letters wide, so a short word doesn't fill the sheet edge to edge.
  const spans = lines.map(([a, b]) => starts(text, a, b));
  const widest = Math.max(8 * 6, ...spans.map((xs) => xs[xs.length - 1])) - 1;
  const cell = Math.max(1, Math.floor(Math.min((W * 0.8) / widest, (H * 0.7) / (lines.length * 11 - 3))));
  const top = Math.round((H - (lines.length * 11 - 3) * cell) / 2);
  const K = kInk(paper);
  const rows = lines.map(([a, b], row) => {
    const xs = spans[row];
    return { a, b, xs, left: Math.round((W - Math.max(0, xs[xs.length - 1] - 1) * cell) / 2), y0: top + row * 11 * cell };
  });
  // The selection band is a line's pitch tall, two rows above the caps (into the accents' marks) to one below the comma's,
  // so the bands of lines one above the other meet without overlapping.
  if (sel) {
    g.fillStyle = paper === 'black' ? 'rgba(0, 181, 226, 0.35)' : 'rgba(0, 181, 226, 0.25)';
    for (const { a, b, xs, left, y0 } of rows) {
      const from = Math.max(a, sel[0]), to = Math.min(b, sel[1]);
      if (to > from) g.fillRect(left + xs[from - a] * cell - Math.round(cell / 2), y0 - 2 * cell, (xs[to - a] - xs[from - a]) * cell, 11 * cell);
    }
  }
  for (const { a, b, xs, left, y0 } of rows)
    for (let i = a; i < Math.min(b, shown); i++) {
      const v = ink[i];
      if (!v) continue;
      const gl = D.glyphs[part[i]];
      const x0 = left + xs[i - a] * cell;
      gl.px.forEach(([x, y], p) => {
        g.fillStyle = v[p] === 3 ? K : INK[v[p]];
        g.fillRect(x0 + x * cell, y0 + y * cell, cell, cell);
      });
    }
  // The caret, magenta, in the gap before its letter.
  const at = caret === null ? undefined : rows.find((r) => caret >= r.a && caret <= r.b);
  if (at && caret !== null) {
    g.fillStyle = INK[1];
    const w = Math.max(1, Math.round(cell / 2));
    g.fillRect(at.left + at.xs[caret - at.a] * cell - Math.round((cell + w) / 2), at.y0 - cell, w, 9 * cell);
  }
  return { cell, rows };
}

/// The line typed out on the 4:5 sheet, letter by letter, each word reprinting as it grows. An eighth note after the
/// last letter the line commits: the caret goes as the score resolves, and the sheet holds while it rings out.
function film(text: string, paper: Paper, sound: 'off' | Style): Sounded {
  const n = text.length;
  const at = (i: number) => (LEAD_F + i * KEY_F) / FPS; // when letter i appears
  // An eighth note after the last letter.
  const end = (LEAD_F + (n + 1) * KEY_F) / FPS;
  const length = end + HOLD;
  const draw = (g: CanvasRenderingContext2D, W: number, H: number, t: number, moving: boolean) => {
    const f = Math.round(t * FPS);
    const typed = moving ? Math.max(0, Math.min(n, Math.floor((f - LEAD_F) / KEY_F) + 1)) : n;
    paint(g, W, H, text, paper, typed, moving && f < Math.round(end * FPS) ? typed : null);
  };
  const audio = async (sampleRate: number, early: number) => {
    const cues: (Cue & { at: number })[] = [];
    for (let i = 0; i < n; i++)
      cues.push(/\s/.test(text[i]) ? { at: at(i), what: 'space', i, note: 0 } : { at: at(i), what: 'letter', i, note: noteOf(printWords(text.slice(0, i + 1), D)[i]) });
    for (const c of cues) c.at -= early;
    cues.sort((a, b) => a.at - b.at);
    const [L, R] = score(sampleRate, length, cues, end - early, sound === 'off' ? 'notes' : sound);
    const buf = new AudioBuffer({ length: L.length, numberOfChannels: 2, sampleRate });
    buf.copyToChannel(L, 0);
    buf.copyToChannel(R, 1);
    return buf;
  };
  return { name: `receipt-${text.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32).toLowerCase() || 'line'}`, length, loop: true, at: length, draw, ...(sound !== 'off' ? { audio } : {}) };
}
