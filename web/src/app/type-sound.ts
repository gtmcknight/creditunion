/// Balance's sound, synthesized sample by sample and seeded, so the page and the video play the same sounds; the
/// video is mastered to -16 LUFS like the Credit Union films. Two scores, both made from the line itself:
///   notes: each letter rings a glass note its inks pick, so a word plays its own tune, the same every time; the
///          line resolves on its own chord, the notes it rang most over a low C, rolled up to its last note.
///   quiet: a faint tick per letter, then a soft press as the line prints and one far bell on its last note.
const TAU = Math.PI * 2;
const dB = (d: number) => 10 ** (d / 20);
const clamp = (x: number, a = 0, b = 1) => Math.max(a, Math.min(b, x));
// C pentatonic over two octaves for the letters, and the same five notes an octave down for the chord.
const SCALE = [523.25, 587.33, 659.25, 783.99, 880, 1046.5, 1174.66, 1318.51];
const MIDDLE = [261.63, 293.66, 329.63, 392.0, 440.0];
const C2 = 65.41, C3 = 130.81;

export type Style = 'notes' | 'quiet';

/// Something that happens: a letter typed (letter `i` of the line, its note from its inks), a space or line break,
/// a delete on the page.
export type Cue = { what: 'letter' | 'space' | 'delete'; i: number; note: number };

/// A letter's note: where its inks put it in the scale.
export const noteOf = (inks: number[] | null) => (inks ? inks.reduce((s, c, p) => s + (c + 1) * (p + 1), 0) % SCALE.length : 0);

/// The engine from the films' score scripts, at one sample rate.
function engine(SR: number) {
  let seed = 0xa0c710;
  const rnd = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const white = () => rnd() * 2 - 1;
  const buf = (sec: number) => new Float32Array(Math.max(1, Math.round(sec * SR)));
  function biquad(type: 'lp' | 'hp' | 'bp', f0: number, Q = Math.SQRT1_2) {
    const w = (TAU * Math.min(f0, SR * 0.45)) / SR, c = Math.cos(w), s = Math.sin(w), al = s / (2 * Q);
    let b0: number, b1: number, b2: number;
    const a0 = 1 + al;
    if (type === 'lp') (b0 = (1 - c) / 2), (b1 = 1 - c), (b2 = b0);
    else if (type === 'hp') (b0 = (1 + c) / 2), (b1 = -(1 + c)), (b2 = b0);
    else (b0 = al), (b1 = 0), (b2 = -al);
    const B0 = b0 / a0, B1 = b1 / a0, B2 = b2 / a0, A1 = (-2 * c) / a0, A2 = (1 - al) / a0;
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    return (x: number) => {
      const y = B0 * x + B1 * x1 + B2 * x2 - A1 * y1 - A2 * y2;
      (x2 = x1), (x1 = x), (y2 = y1), (y1 = y);
      return y;
    };
  }
  function partial(b: Float32Array, { f, f1 = f, glide = 0.01, amp = 1, attack = 0.001, decay = 0.1, delay = 0 }: { f: number; f1?: number; glide?: number; amp?: number; attack?: number; decay?: number; delay?: number }) {
    const d = Math.round(delay * SR);
    let ph = 0;
    for (let i = d; i < b.length; i++) {
      const t = (i - d) / SR;
      ph += (TAU * (f1 + (f - f1) * Math.exp(-t / glide))) / SR;
      const e = (t < attack ? t / attack : 1) * Math.exp(-Math.max(0, t - attack) / decay);
      if (e < 1e-6 && t > attack) break;
      b[i] += Math.sin(ph) * e * amp;
    }
    return b;
  }
  function burst(b: Float32Array, { amp = 1, attack = 0.0002, decay = 0.002, delay = 0, filters = [] as ['lp' | 'hp' | 'bp', number, number][] }) {
    const d = Math.round(delay * SR);
    const fs = filters.map(([type, f, q]) => biquad(type, f, q));
    for (let i = d; i < b.length; i++) {
      const t = (i - d) / SR;
      const e = (t < attack ? t / attack : 1) * Math.exp(-Math.max(0, t - attack) / decay);
      let x = white() * e;
      for (const fl of fs) x = fl(x);
      b[i] += x * amp;
    }
    return b;
  }
  const saturate = <T extends Float32Array>(b: T, drive: number): T => {
    const n = Math.tanh(drive);
    for (let i = 0; i < b.length; i++) b[i] = Math.tanh(b[i] * drive) / n;
    return b;
  };
  return { SR, rnd, buf, biquad, partial, burst, saturate };
}

type F32 = Float32Array<ArrayBuffer>;
type Voices = ReturnType<typeof build>;
const cache = new Map<number, Voices>();

/// Every sound, made once per sample rate (the line's chord and bell are made per line).
function build(SR: number) {
  const E = engine(SR);
  // A struck glass: the note, its bright overtone, the mallet's contact; `decay` sets how long it rings.
  const glass = (f: number, decay = 0.45) => {
    const b = E.buf(decay * 3.6);
    E.partial(b, { f, amp: 1, attack: 0.002, decay });
    E.partial(b, { f: f * 2.76, amp: 0.25, attack: 0.001, decay: decay * 0.27 });
    E.partial(b, { f: f * 5.4, amp: 0.08, attack: 0.0005, decay: decay * 0.09 });
    E.burst(b, { amp: 0.05, decay: 0.001, filters: [['bp', Math.min(f * 4, SR * 0.4), 2]] });
    return b;
  };
  // The counting machine's tick, from the Credit Union films, dry.
  const tick = () => {
    const b = E.buf(0.05);
    E.burst(b, { amp: 1, decay: 0.0009, filters: [['bp', 3300, 1.2]] });
    E.partial(b, { f: 1320, amp: 0.16, attack: 0.0004, decay: 0.011 });
    return b;
  };
  // The sheet printing: the black plate's registration click, a press and its pin seating.
  const press = () => {
    const b = E.buf(0.4);
    E.burst(b, { amp: 1.5, decay: 0.0016, filters: [['bp', 2550, 1.1]] });
    E.burst(b, { amp: 0.45, decay: 0.0008, delay: 0.011, filters: [['hp', 2600, 0.7]] });
    E.partial(b, { f: 160, f1: 68, glide: 0.02, amp: 0.6, attack: 0.001, decay: 0.08 });
    E.burst(b, { amp: 0.7, decay: 0.007, filters: [['lp', 900, 0.7]] });
    return E.saturate(b, 1.4);
  };
  // A small bell, from the films, on any note.
  const bell = (f: number, decay: number) => {
    const b = E.buf(decay * 4.5);
    let pc = 0, pm = 0;
    for (let i = 0; i < b.length; i++) {
      const t = i / SR;
      pc += (TAU * f) / SR;
      pm += (TAU * f * 3.5) / SR;
      const e = (1 - Math.exp(-t / 0.0025)) * Math.exp(-t / decay);
      b[i] = Math.sin(pc + 1.5 * Math.exp(-t / 0.22) * Math.sin(pm)) * e;
    }
    E.partial(b, { f: f * 2, amp: 0.1, attack: 0.002, decay: decay * 0.35 });
    E.partial(b, { f: f / 2, amp: 0.1, attack: 0.004, decay: decay * 0.7 });
    return b;
  };
  // The line's chord: its notes on the same glass, rolled up from the bass a few hundredths apart and spread across
  // the stereo field, a pad breathing in under them so the chord blooms rather than strikes, and a low C felt more
  // than heard. Gone to near silence in about three seconds.
  const chord = (freqs: number[]): [F32, F32] => {
    const len = 3.2, n = Math.round(len * SR), l = new Float32Array(n), r = new Float32Array(n);
    freqs.forEach((f, k) => {
      const b = glass(f, 0.95), at = Math.round(k * 0.055 * SR);
      const a = (((k / Math.max(1, freqs.length - 1)) * 0.6 - 0.3 + 1) * Math.PI) / 4, gl = Math.cos(a), gr = Math.sin(a);
      for (let i = 0; i < b.length && at + i < n; i++) (l[at + i] += b[i] * gl * 0.55), (r[at + i] += b[i] * gr * 0.55);
    });
    const fa = E.biquad('lp', 1600, 0.6), fb = E.biquad('lp', 1600, 0.6);
    const pad = freqs.slice(0, -1), ph = pad.map(() => [E.rnd() * TAU, E.rnd() * TAU]);
    let sub = 0;
    for (let i = 0; i < n; i++) {
      const t = i / SR, e = (1 - Math.exp(-t / 0.18)) * Math.exp(-t / 0.85);
      let a = 0, b = 0;
      pad.forEach((f, k) => {
        ph[k][0] += (TAU * f * (1 - 0.0012)) / SR;
        ph[k][1] += (TAU * f * (1 + 0.0012)) / SR;
        for (let h = 1; h <= 3; h++) (a += Math.sin(h * ph[k][0]) / h ** 2), (b += Math.sin(h * ph[k][1]) / h ** 2);
      });
      sub += (TAU * C2) / SR;
      const s = Math.sin(sub) * (1 - Math.exp(-t / 0.03)) * Math.exp(-t / 0.9) * 0.5;
      (l[i] += fa(a) * e * 0.16 + s), (r[i] += fb(b) * e * 0.16 + s);
    }
    return [l, r];
  };
  // The films' room: eight combs and four allpasses, a little pre-delay.
  const reverb = (input: Float32Array, spread: number): F32 => {
    const combs = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617].map((d) => Math.round(((d + spread) * SR) / 44100));
    const aps = [556, 441, 341, 225].map((d) => Math.round(((d + spread) * SR) / 44100));
    const pre = Math.round(0.012 * SR), out = new Float32Array(input.length);
    const cb = combs.map((d) => ({ buf: new Float32Array(d), i: 0, store: 0 }));
    const ab = aps.map((d) => ({ buf: new Float32Array(d), i: 0 }));
    for (let n = 0; n < input.length; n++) {
      const x = (n >= pre ? input[n - pre] : 0) * 0.015;
      let y = 0;
      for (const c of cb) {
        const o = c.buf[c.i];
        c.store = o * 0.65 + c.store * 0.35;
        c.buf[c.i] = x + c.store * 0.82;
        c.i = (c.i + 1) % c.buf.length;
        y += o;
      }
      for (const a of ab) {
        const o = a.buf[a.i];
        a.buf[a.i] = y + o * 0.5;
        a.i = (a.i + 1) % a.buf.length;
        y = o - y;
      }
      out[n] = y;
    }
    return out;
  };
  const impulse = new Float32Array(Math.round(1.6 * SR));
  impulse[0] = 1;
  return { glass: SCALE.map((f) => glass(f)), tick: tick(), press: press(), bell, chord, reverb, ir: [reverb(impulse, 0), reverb(impulse, 23)] as [F32, F32] };
}
function voices(SR: number) {
  let v = cache.get(SR);
  if (!v) cache.set(SR, (v = build(SR)));
  return v;
}

/// The line's own chord: a low C, the two notes its letters rang most (by count, then by first use; C itself
/// counts as the root), and on top the note its last letter rang.
function lineChord(cues: Cue[]) {
  const letters = cues.filter((c) => c.what === 'letter');
  const count = [0, 0, 0, 0, 0], first = [Infinity, Infinity, Infinity, Infinity, Infinity];
  letters.forEach((c, k) => {
    const d = c.note % 5;
    count[d]++;
    first[d] = Math.min(first[d], k);
  });
  const picked = [1, 2, 3, 4].sort((a, b) => count[b] - count[a] || first[a] - first[b]).slice(0, 2).sort((a, b) => a - b);
  const top = letters.length ? SCALE[letters[letters.length - 1].note] : SCALE[0];
  return [C3, MIDDLE[0], ...picked.map((d) => MIDDLE[d]), top];
}

/// One sound to play: mono with a pan, or a stereo pair; `send` is how much goes to the room; `delay` after the cue.
type Hit = { v: F32 | [F32, F32]; gain: number; send?: number; pan?: number; delay?: number };

/// The two scores: what each cue plays, and what plays when the line is done (made from the line's cues).
const SCORES: Record<Style, { cue: (c: Cue, V: Voices) => Hit[]; end: (V: Voices, cues: Cue[]) => Hit[] }> = {
  notes: {
    cue: (c, V) => (c.what === 'letter' ? [{ v: V.glass[c.note], gain: dB(-19), send: 0.3, pan: (c.note / (SCALE.length - 1)) * 0.6 - 0.3 }] : c.what === 'delete' ? [{ v: V.tick, gain: dB(-30) }] : []),
    end: (V, cues) => [{ v: V.chord(lineChord(cues)), gain: dB(-12), send: 0.45 }],
  },
  // The end sits only a little over the ticks, so it settles rather than startles.
  quiet: {
    cue: (c, V) => (c.what === 'letter' || c.what === 'delete' ? [{ v: V.tick, gain: dB(-22), send: 0.08 }] : []),
    end: (V, cues) => {
      const last = cues.filter((c) => c.what === 'letter').pop();
      return [{ v: V.press, gain: dB(-42), send: 0.35 }, { v: V.bell(SCALE[last ? last.note : 0], 1.1), gain: dB(-43), send: 0.55, delay: 0.03 }];
    },
  },
};

/// The video's soundtrack, `length` seconds: each cue at its time, the line's end at `end`. Mastered to -16 LUFS (Quiet
/// to -24, about 10 dB under Notes), limited at -2.2 dB so the AAC encode stays under -1.5 dB true peak, with a
/// fade over the last 0.4 s.
export function score(SR: number, length: number, cues: (Cue & { at: number })[], end: number, style: Style) {
  const V = voices(SR), E = engine(SR), N = Math.ceil(length * SR);
  const L = new Float32Array(N), R = new Float32Array(N), VL = new Float32Array(N), VR = new Float32Array(N);
  const place = ({ v, gain, send = 0, pan = 0, delay = 0 }: Hit, at: number) => {
    const s = Math.round((at + delay) * SR), a = ((clamp(pan, -1, 1) + 1) * Math.PI) / 4;
    const [l, r] = Array.isArray(v) ? v : [v, v];
    const gl = Array.isArray(v) ? gain : Math.cos(a) * gain, gr = Array.isArray(v) ? gain : Math.sin(a) * gain;
    for (let i = 0; i < l.length; i++) {
      const j = s + i;
      if (j < 0 || j >= N) continue;
      const x = l[i] * gl, y = r[i] * gr;
      (L[j] += x), (R[j] += y);
      if (send) (VL[j] += x * send), (VR[j] += y * send);
    }
  };
  for (const c of cues) for (const h of SCORES[style].cue(c, V)) place(h, c.at);
  for (const h of SCORES[style].end(V, cues)) place(h, end);
  const target = style === 'quiet' ? -24 : -16;
  const WL = V.reverb(VL, 0), WR = V.reverb(VR, 23);
  const hl = [E.biquad('hp', 28), E.biquad('hp', 28)], hr = [E.biquad('hp', 28), E.biquad('hp', 28)];
  for (let i = 0; i < N; i++) (L[i] = hl[1](hl[0](L[i] + WL[i]))), (R[i] = hr[1](hr[0](R[i] + WR[i])));
  let gain = 1;
  for (let pass = 0; pass < 6; pass++) {
    const l = L.map((x) => x * gain), r = R.map((x) => x * gain);
    limit(l, r, SR, dB(-2.2));
    const got = lufs(l, r, SR);
    if (!isFinite(got) || Math.abs(got - target) < 0.05) break;
    gain *= dB(target - got);
  }
  for (let i = 0; i < N; i++) (L[i] *= gain), (R[i] *= gain);
  limit(L, R, SR, dB(-2.2));
  const fade = Math.min(N, Math.round(0.4 * SR));
  for (let i = N - fade; i < N; i++) {
    const w = 0.5 + 0.5 * Math.cos((Math.PI * (i - (N - fade))) / fade);
    (L[i] *= w), (R[i] *= w);
  }
  return [L, R] as const;
}

/// Integrated loudness, ITU BS.1770 (K-weighted, gated).
function lufs(l: Float32Array, r: Float32Array, SR: number) {
  const kw = () => {
    const mk = (b: number[], a: number[]) => {
      let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
      return (x: number) => {
        const y = b[0] * x + b[1] * x1 + b[2] * x2 - a[0] * y1 - a[1] * y2;
        (x2 = x1), (x1 = x), (y2 = y1), (y1 = y);
        return y;
      };
    };
    const f1 = mk([1.53512485958697, -2.69169618940638, 1.19839281085285], [-1.69065929318241, 0.73248077421585]);
    const f2 = mk([1.0, -2.0, 1.0], [-1.99004745483398, 0.99007225036621]);
    return (x: number) => f2(f1(x));
  };
  const kl = kw(), kr = kw(), cum = new Float64Array(l.length + 1);
  for (let i = 0; i < l.length; i++) {
    const a = kl(l[i]), b = kr(r[i]);
    cum[i + 1] = cum[i] + a * a + b * b;
  }
  const blk = Math.round(0.4 * SR), step = Math.round(0.1 * SR), blocks: number[] = [];
  for (let s = 0; s + blk <= l.length; s += step) blocks.push((cum[s + blk] - cum[s]) / blk);
  const loud = (z: number) => -0.691 + 10 * Math.log10(z);
  const abs = blocks.filter((z) => loud(z) > -70);
  if (!abs.length) return -Infinity;
  const rel = loud(abs.reduce((a, b) => a + b, 0) / abs.length) - 10;
  const gated = abs.filter((z) => loud(z) > rel);
  return loud(gated.reduce((a, b) => a + b, 0) / gated.length);
}

/// A look-ahead peak limiter.
function limit(l: Float32Array, r: Float32Array, SR: number, ceiling: number) {
  const g = new Float32Array(l.length);
  for (let i = 0; i < l.length; i++) g[i] = Math.min(1, ceiling / Math.max(1e-9, Math.abs(l[i]), Math.abs(r[i])));
  const att = Math.exp(-1 / (0.0015 * SR)), rel = Math.exp(-1 / (0.08 * SR));
  for (let i = l.length - 2; i >= 0; i--) g[i] = Math.min(g[i], g[i + 1] + (1 - g[i + 1]) * (1 - att));
  for (let i = 1; i < l.length; i++) g[i] = Math.min(g[i], g[i - 1] + (1 - g[i - 1]) * (1 - rel));
  for (let i = 0; i < l.length; i++) (l[i] *= g[i]), (r[i] *= g[i]);
}

/// The page's keys, live: the picked score's sounds through the same room, at about the video's level.
export class Keys {
  private ctx = new AudioContext();
  private dry: GainNode;
  private wet: GainNode;
  private V: Voices;
  private bufs = new Map<F32, AudioBuffer>();
  constructor(public style: Style) {
    this.V = voices(this.ctx.sampleRate);
    const out = this.ctx.createGain();
    out.gain.value = dB(12);
    const limiter = this.ctx.createDynamicsCompressor();
    limiter.threshold.value = -3;
    limiter.ratio.value = 20;
    out.connect(limiter).connect(this.ctx.destination);
    this.dry = this.ctx.createGain();
    this.dry.connect(out);
    const room = this.ctx.createConvolver();
    room.normalize = false;
    const ir = this.ctx.createBuffer(2, this.V.ir[0].length, this.ctx.sampleRate);
    ir.copyToChannel(this.V.ir[0], 0);
    ir.copyToChannel(this.V.ir[1], 1);
    room.buffer = ir;
    this.wet = this.ctx.createGain();
    this.wet.connect(room).connect(out);
  }
  play(cue: Cue) {
    void this.ctx.resume();
    for (const { v, gain, send = 0, pan = 0, delay = 0 } of SCORES[this.style].cue(cue, this.V)) {
      if (Array.isArray(v)) continue;
      let b = this.bufs.get(v);
      if (!b) {
        b = this.ctx.createBuffer(1, v.length, this.ctx.sampleRate);
        b.copyToChannel(v, 0);
        this.bufs.set(v, b);
      }
      const src = this.ctx.createBufferSource();
      src.buffer = b;
      const g = this.ctx.createGain();
      g.gain.value = gain;
      const p = this.ctx.createStereoPanner();
      p.pan.value = pan;
      src.connect(g).connect(p).connect(this.dry);
      if (send) {
        const s = this.ctx.createGain();
        s.gain.value = send;
        p.connect(s).connect(this.wet);
      }
      src.start(this.ctx.currentTime + delay);
    }
  }
}
