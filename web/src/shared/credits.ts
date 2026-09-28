/// Credits traits and Jack Butcher's official rating, in TypeScript.
///
/// Traits are a port of the pure functions in CreditArt.sol / CreditDrawing.sol (MIT, vendored under
/// contracts/src/vendor/credits). The rating follows the published methodology at
/// https://jack.art/credits/rating (engine v3.4.0): for each of five traits, p = share of the edition whose
/// value occurs no more often than this one; R = weighted mean of −ln p with weights 1,1,1,2,1 (eights double);
/// rank = 1 + number of Credits with strictly higher R (1e-12 tolerance); score = 80 + 720·(N − rank)/(N − 1).
import { sha256 } from '@noble/hashes/sha2.js';

export type Traits = {
  palette: string; // "CMY" etc.
  activeBits: number; // set bits across enabled plates
  occupied: number; // cells marked on at least one enabled plate
  eights: number; // count of '8' in the 21-char seed
  registration: string; // Registered / Nudge / Slip / Skew / Drift / Loose
};

const LETTERS = 'CMYK';
/// Seeds are 21 bytes; real ones are alphanumeric ASCII. Encode byte-for-byte (latin1) so any seed hashes
/// exactly as the contract hashes it, not through UTF-8.
const enc = { encode: (s: string) => Uint8Array.from(s, (ch) => ch.charCodeAt(0) & 0xff) };

/// Plate offsets for misregistered prints: a port of CreditDrawing.slips.
function slips(mis: Uint8Array): { dx: number[]; dy: number[] } {
  const dx = [0, 0, 0, 0];
  const dy = [0, 0, 0, 0];
  if (mis[0] >= 32) return { dx, dy };
  const dice = mis[1];
  let maxStep = 1;
  let movers = 1;
  let kMoves = false;
  if (dice < 80) movers = 1;
  else if (dice < 160) movers = 2;
  else if (dice < 210) movers = 3;
  else if (dice < 240) {
    maxStep = 2;
    movers = 2 + (mis[2] % 2);
  } else {
    maxStep = 2;
    movers = 3 + (mis[2] % 2);
    kMoves = true;
  }
  const pool = kMoves ? [0, 1, 2, 3] : [0, 1, 2];
  let cursor = 3;
  const selected: number[] = [];
  while (selected.length < movers && pool.length > 0) {
    const idx = mis[cursor++ % 32] % pool.length;
    selected.push(pool.splice(idx, 1)[0]);
  }
  const ux = [-1, 1, 0, 0, -1, -1, 1, 1];
  const uy = [0, 0, -1, 1, -1, 1, -1, 1];
  for (const layer of selected) {
    const b = mis[(layer + cursor) % 32];
    const c = mis[(layer + cursor + 4) % 32];
    if (maxStep === 1) {
      dx[layer] = ux[b % 8];
      dy[layer] = uy[b % 8];
    } else {
      dx[layer] = (b % 5) - 2;
      dy[layer] = (c % 5) - 2;
      if (dx[layer] === 0 && dy[layer] === 0) dx[layer] = b & 1 ? 2 : -2;
    }
  }
  return { dx, dy };
}

/// Each step from payment to picture, for the Credit page's "How it was made": the hash, the four 8×8 plates
/// (bit order as the art reads them), which plates the payment time turns on, and each plate's slip.
export type Process = { hash: Uint8Array; plates: boolean[][]; mask: number; dx: number[]; dy: number[]; misprint: boolean };
export function processOf(seed: string, paidAt: number): Process {
  const hash = sha256(enc.encode(seed));
  const mis = sha256(enc.encode(seed + '/misprint'));
  const plates = [0, 1, 2, 3].map((layer) =>
    Array.from({ length: 64 }, (_, i) => {
      const index = layer * 64 + i;
      return ((hash[index >> 3] >> (7 - (index & 7))) & 1) === 1;
    }),
  );
  const { dx, dy } = slips(mis);
  return { hash, plates, mask: (paidAt % 15) + 1, dx, dy, misprint: mis[0] < 32 };
}

export function traitsOf(seed: string, paidAt: number): Traits {
  const hash = sha256(enc.encode(seed));
  const mis = sha256(enc.encode(seed + '/misprint'));
  const mask = (paidAt % 15) + 1;
  const { dx, dy } = slips(mis);
  let palette = '';
  let activeBits = 0;
  const pixels = new Uint8Array(144); // 12×12: the 8×8 grid plus 2 cells of slip on each side
  for (let layer = 0; layer < 4; layer++) {
    if (!(mask & (1 << layer))) continue;
    palette += LETTERS[layer];
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        const index = layer * 64 + y * 8 + x;
        if ((hash[index >> 3] >> (7 - (index & 7))) & 1) {
          activeBits++;
          pixels[(y + 2 + dy[layer]) * 12 + (x + 2 + dx[layer])] |= 1 << layer;
        }
      }
    }
  }
  let occupied = 0;
  for (const p of pixels) if (p) occupied++;
  let eights = 0;
  for (const ch of seed) if (ch === '8') eights++;
  let registration = 'Registered';
  if (mis[0] < 32) {
    const dice = mis[1];
    registration = dice < 80 ? 'Nudge' : dice < 160 ? 'Slip' : dice < 210 ? 'Skew' : dice < 240 ? 'Drift' : 'Loose';
  }
  return { palette, activeBits, occupied, eights, registration };
}

export const TRAIT_KEYS = ['palette', 'activeBits', 'occupied', 'eights', 'registration'] as const;
export const TRAIT_LABELS = ['Palette', 'Active bits', 'Occupied cells', 'Eights', 'Registration'] as const;
export const TRAIT_WEIGHTS = [1, 1, 1, 2, 1] as const;

/// Per trait, per value: the share of the edition whose value is as rare or rarer. Plus, for ranking, the
/// distinct R values ascending and, for each, how many Credits have a strictly lower R.
export type Edition = {
  n: number;
  tails: Record<(typeof TRAIT_KEYS)[number], Record<string, number>>;
  counts: Record<(typeof TRAIT_KEYS)[number], Record<string, number>>;
  rs: Float64Array;
  below: Uint32Array;
};

export function buildEdition(rows: Traits[]): Edition {
  const n = rows.length;
  const counts = {} as Edition['counts'];
  const tails = {} as Edition['tails'];
  for (const k of TRAIT_KEYS) {
    const c: Record<string, number> = {};
    for (const r of rows) c[String(r[k])] = (c[String(r[k])] ?? 0) + 1;
    counts[k] = c;
    const t: Record<string, number> = {};
    for (const [v, cnt] of Object.entries(c)) t[v] = Object.values(c).reduce((s, x) => s + (x <= cnt ? x : 0), 0) / n;
    tails[k] = t;
  }
  const sorted = Float64Array.from(rows, (r) => rarityOf(r, tails)).sort();
  const rs: number[] = [];
  const below: number[] = [];
  for (let i = 0; i < sorted.length; i++) {
    if (i === 0 || sorted[i] - sorted[i - 1] > 1e-12) {
      rs.push(sorted[i]);
      below.push(i);
    }
  }
  return { n, tails, counts, rs: Float64Array.from(rs), below: Uint32Array.from(below) };
}

export function rarityOf(t: Traits, tails: Edition['tails']): number {
  let sum = 0;
  TRAIT_KEYS.forEach((k, i) => {
    sum -= TRAIT_WEIGHTS[i] * Math.log(tails[k][String(t[k])]);
  });
  return sum / 6;
}

/// Jack's engine: score from the count of Credits with strictly lower R; competition rank from the count
/// with strictly higher R (ties share a rank). Both with a 1e-12 tolerance.
export function place(r: number, ed: Pick<Edition, 'n' | 'rs' | 'below'>): { lower: number; higher: number } {
  const first = (x: number) => {
    let lo = 0;
    let hi = ed.rs.length;
    while (lo < hi) {
      const m = (lo + hi) >>> 1;
      if (ed.rs[m] < x) lo = m + 1;
      else hi = m;
    }
    return lo; // index of the first distinct value >= x
  };
  const iLow = first(r - 1e-12);
  const lower = iLow < ed.rs.length ? ed.below[iLow] : ed.n;
  const iHigh = first(r + 1e-12);
  const higher = ed.n - (iHigh < ed.rs.length ? ed.below[iHigh] : ed.n);
  return { lower, higher };
}

export function scoreOf(lower: number, n: number): number {
  return n === 1 ? 800 : 80 + (720 * lower) / (n - 1);
}

export type Rating = { score: number; rank: number; traits: Traits; tails: number[] };

export function rate(seed: string, paidAt: number, ed: Edition): Rating {
  const traits = traitsOf(seed, paidAt);
  // A value unseen in the edition (testnet Credits can produce one) counts as rarest: tail = 1/N.
  const tails = TRAIT_KEYS.map((k) => ed.tails[k][String(traits[k])] ?? 1 / ed.n);
  let sum = 0;
  tails.forEach((p, i) => (sum -= TRAIT_WEIGHTS[i] * Math.log(p)));
  const r = sum / 6;
  const { lower, higher } = place(r, ed);
  return { score: scoreOf(lower, ed.n), rank: higher + 1, traits, tails };
}

/// Truncated to two decimals, as the official page displays it.
export const fmtScore = (s: number) => (Math.floor(s * 100) / 100).toFixed(2);
