/// Buy locks for Picture unions, one object per union. A picture's Colors fill their slots in the order Credits of
/// them go in, so two people buying the same Colors at once would land one of them a slot late. A buy locks its
/// Colors from the click until its transaction lands: long enough to confirm in the wallet, then while it's pending.
/// Anyone else sees those Colors as being bought and can buy the others. Kept in memory: a lock only matters for
/// seconds, and an object that restarts simply starts with none.
import { DurableObject } from 'cloudflare:workers';

type Lock = { id: string; until: number };

export class BuyLocks extends DurableObject {
  private locks = new Map<number, Lock>(); // Colors (CMYK mask) → who holds it, until when

  private sweep() {
    const now = Date.now();
    for (const [c, l] of this.locks) if (l.until <= now) this.locks.delete(c);
  }

  /// Lock these Colors for `id` for `ms`, unless someone else holds any of them.
  async acquire(id: string, colours: number[], ms: number): Promise<{ ok: true } | { ok: false; busy: number[]; until: number }> {
    this.sweep();
    const busy = colours.filter((c) => {
      const l = this.locks.get(c);
      return l && l.id !== id;
    });
    if (busy.length) return { ok: false, busy, until: Math.max(...busy.map((c) => this.locks.get(c)!.until)) };
    const until = Date.now() + ms;
    for (const c of colours) this.locks.set(c, { id, until });
    return { ok: true };
  }

  /// Keep `id`'s locks for another `ms` (its transaction is on its way).
  async hold(id: string, ms: number) {
    this.sweep();
    const until = Date.now() + ms;
    for (const l of this.locks.values()) if (l.id === id) l.until = until;
  }

  async release(id: string) {
    for (const [c, l] of this.locks) if (l.id === id) this.locks.delete(c);
  }

  /// The Colors being bought right now.
  async held(): Promise<number[]> {
    this.sweep();
    return [...this.locks.keys()];
  }
}
