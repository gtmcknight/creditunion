/// The sweep's sound: a soft tick for each Credit picked, climbing a pentatonic scale with the count, a lower one for
/// each dropped, and a fuller chord at the most one buy takes. Made in the browser (no files), only ever after a drag
/// or tap.
const STEPS = [0, 2, 4, 7, 9]; // a major pentatonic: any run of it sounds like a tune
let ctx: AudioContext | null = null;
let last = 0;

function note(freq: number, at: number, peak: number, len: number, type: OscillatorType = 'sine') {
  const o = ctx!.createOscillator(), g = ctx!.createGain();
  o.type = type;
  o.frequency.value = freq;
  g.gain.setValueAtTime(0.0001, at);
  g.gain.exponentialRampToValueAtTime(peak, at + 0.006);
  g.gain.exponentialRampToValueAtTime(0.0001, at + len);
  o.connect(g).connect(ctx!.destination);
  o.start(at);
  o.stop(at + len + 0.02);
}

/// The count went from `was` to `n` (of at most `most`).
export function sweepSound(n: number, was: number, most: number) {
  if (n === was) return;
  const now = performance.now();
  if (now - last < 28 && n !== most) return; // a fast drag: a run, not a buzz
  last = now;
  try {
    ctx ??= new AudioContext();
    if (ctx.state === 'suspended') void ctx.resume();
  } catch {
    return;
  }
  const t = ctx.currentTime;
  const i = Math.min(Math.max(n, 1) - 1, 14);
  const freq = 392 * 2 ** ((12 * Math.floor(i / 5) + STEPS[i % 5]) / 12); // from G4, three octaves at most
  if (n < was) return note(freq * 0.75, t, 0.035, 0.07);
  if (n >= most) {
    for (const [k, r] of [1, 1.25, 1.5].entries()) note(392 * 2 * r, t + k * 0.04, 0.05, 0.45, 'triangle');
    return;
  }
  note(freq, t, 0.05, 0.09);
}
