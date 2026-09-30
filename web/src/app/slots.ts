import { primeInks } from './directions';
/// What a painted sheet can still take. Mirrors Batch.sol: `_keyOf` (a Credit's value of the painted trait, read
/// from Jack's art contract exactly as the batch reads it) and `_add` (a Credit lands if a painted slot of its
/// value is free, else only while an open slot is: `overflow < anySlots`, which it then uses up). `passes()` is
/// slot-blind, so without this the page offers Credits the sheet has no room for and the deposit reverts NoSlot.
import type { Address } from 'viem';
import { batchAbi, creditArtAbi, creditsAbi } from './abi';
import { config, pub } from './chain';
import { layoutSlot, type Summary } from './data';
import { slotName } from '../shared/layout';

const PRINTS = ['Registered', 'Nudge', 'Slip', 'Skew', 'Drift', 'Loose'];
const WEIGHTS = ['even', 'lean', 'sparse', 'extreme'];

type Read = { colors: string; eights: bigint; weight: string; register: string };

let artAt: { credits: string; at: Promise<Address> } | null = null;
/// Credits' art contract (the batch reads the same one: `art = credits.art()` at initialize).
function artAddress() {
  if (!artAt || artAt.credits !== config.credits) {
    const at = pub.readContract({ address: config.credits, abi: creditsAbi, functionName: 'art' }) as Promise<Address>;
    artAt = { credits: config.credits, at };
    at.catch(() => (artAt = null));
  }
  return artAt.at;
}

/// describe() per Credit, cached: a Credit's traits never change.
const reads = new Map<string, Promise<Read>>();
function readOf(id: bigint): Promise<Read> {
  const k = `${config.credits}:${id}`;
  let p = reads.get(k);
  if (!p) {
    p = (async () => {
      const [art, seed, ts] = await Promise.all([
        artAddress(),
        pub.readContract({ address: config.credits, abi: creditsAbi, functionName: 'seedOf', args: [id] }),
        pub.readContract({ address: config.credits, abi: creditsAbi, functionName: 'timestampOf', args: [id] }),
      ]);
      return (await pub.readContract({ address: art, abi: creditArtAbi, functionName: 'describe', args: [seed, ts] })) as unknown as Read;
    })();
    reads.set(k, p);
    p.catch(() => reads.delete(k));
  }
  return p;
}

const paletteMask = (colors: string) => [...'CMYK'].reduce((m, ch, b) => (colors.includes(ch) ? m | (1 << b) : m), 0);

/// Batch._keyOf: the slot value a Credit has for the painted trait.
export function keyFromRead(trait: number, r: Read): number {
  if (trait === 0) return paletteMask(r.colors);
  if (trait === 1) return r.eights < 14n ? Number(r.eights) + 1 : 15;
  if (trait === 2) return PRINTS.indexOf(r.register) + 1;
  if (trait === 3) return WEIGHTS.indexOf(r.weight) + 1;
  return r.colors.length; // Plates: 1–4 inks
}

/// Slot values of `ids` for a trait, keyed by id.
export async function keysOf(trait: number, ids: readonly bigint[]): Promise<Map<string, number>> {
  const r = await Promise.all(ids.map(readOf));
  return new Map(ids.map((id, i) => [id.toString(), keyFromRead(trait, r[i])]));
}

/// The same from the Worker's /placed answer: one request (kept at the edge) for every Credit's value, which also
/// brings their ink. Falls back to reading the chain when the answer is behind the ids asked for.
export async function placedKeys(batch: Address, ids: readonly bigint[]): Promise<Map<string, number>> {
  const r = (await fetch(`/placed/${batch}`)
    .then((x) => (x.ok ? x.json() : null))
    .catch(() => null)) as { ids?: string[]; keys?: number[]; inks?: Record<string, [string, number, number]> } | null;
  if (r?.ids && r.keys) {
    primeInks(r.inks);
    const m = new Map(r.ids.map((id, i) => [id, r.keys![i]] as const));
    if (ids.every((id) => m.has(id.toString()))) return m;
  }
  return depositedKeys(batch, ids);
}

/// Values the batch recorded for its deposits (Batch.keyOf), keyed by id.
export async function depositedKeys(batch: Address, ids: readonly bigint[]): Promise<Map<string, number>> {
  const k = (await Promise.all(ids.map((id) => pub.readContract({ address: batch, abi: batchAbi, functionName: 'keyOf', args: [id] })))) as number[];
  return new Map(ids.map((id, i) => [id.toString(), Number(k[i])]));
}

/// The batch's slot books: painted slots per value, Credits in per value, open slots, and how many of the Credits
/// in already spill into open slots.
export type Books = { trait: number; slots: number[]; have: number[]; any: number; overflow: number };

export function books(f: Summary['filter'], deposited: Iterable<number>): Books {
  return booksOf(f.layoutTrait ?? 0, Array.from({ length: 80 }, (_, i) => layoutSlot(f, i)), deposited);
}

/// The same from 80 slot values (0 = open), e.g. a sheet still being painted.
export function booksOf(trait: number, layout: readonly number[], deposited: Iterable<number> = []): Books {
  const slots = new Array(16).fill(0), have = new Array(16).fill(0);
  let any = 0;
  for (const p of layout) {
    if (p) slots[p]++;
    else any++;
  }
  for (const p of deposited) have[p]++;
  const overflow = have.reduce((n, h, p) => n + Math.max(0, h - slots[p]), 0);
  return { trait, slots, have, any, overflow };
}

/// Room for a set of picks, as the contract would book them in one deposit. `room` is 80 minus Credits in.
export class Room {
  private have: number[];
  private spill: number;
  n = 0;
  constructor(private b: Books | null, private room: number) {
    this.have = b ? [...b.have] : [];
    this.spill = b ? b.overflow : 0;
  }
  /// Whether one more Credit with slot value `key` would land (key is ignored without a layout).
  fits(key = 0): boolean {
    if (this.n >= this.room) return false;
    if (!this.b) return true;
    return this.have[key] < this.b.slots[key] || this.spill < this.b.any;
  }
  take(key = 0): boolean {
    if (!this.fits(key)) return false;
    if (this.b) {
      if (this.have[key] >= this.b.slots[key]) this.spill++;
      this.have[key]++;
    }
    this.n++;
    return true;
  }
}

/// Why a Credit with slot value `key` has no room: "CMY slots are full", "No 2-ink slots, open slots are full".
export function noRoomReason(b: Books, key: number, picked = false): string {
  const name = b.trait === 1 && key === 1 ? 'Zero-eight' : slotName(b.trait, key);
  const why = b.slots[key]
    ? `${name} slots${b.any ? ' and open slots' : ''} are ${picked ? 'taken by your picks' : 'full'}`
    : `No ${name} slots${b.any ? `, open slots are ${picked ? 'taken by your picks' : 'full'}` : ' on this sheet'}`;
  return why;
}

