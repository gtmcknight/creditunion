/// Buy locks for Picture unions, one object per union. A picture's Colors fill their slots in the order Credits of
/// them go in, so two people buying the same Colors at once would land one of them a slot late. A buy locks its
/// Colors from the click until its transaction lands: 30 s to confirm in the wallet, then, once the Worker has
/// seen the transaction the wallet sent (index.ts), two minutes at a time while it's pending, never past CAP from the
/// click. Anyone else sees those Colors as being bought and can buy the others. A lock with no transaction behind it
/// is charged to the address that asked (BUDGET), so nobody can keep Colors locked just by asking again and again.
/// Kept in memory: a lock only matters for minutes, and an object that restarts simply starts with none.
import { DurableObject } from 'cloudflare:workers';

/// The longest a lock lives, from the click: 30 s in the wallet, then a transaction pending for several blocks.
/// One still pending after that is stuck, and keeping everyone else from buying its Colors costs more than the slot
/// order it protects.
export const CAP = 10 * 60_000;
/// Lock time without a transaction behind it that one address (an IPv4 address, an IPv6 /64) may take per WINDOW: a
/// few tries that were cancelled in the wallet, not a lock kept up for good.
const BUDGET = 3 * 60_000;
const WINDOW = 10 * 60_000;

type Lock = { account: string; ip: string; colours: number[]; at: number; until: number; tx: string | null };

export class BuyLocks extends DurableObject {
  private locks = new Map<string, Lock>(); // lock id → its lock
  private by = new Map<number, string>(); // Colors (CMYK mask) → the lock id holding it
  private txs = new Map<string, { id: string; at: number }>(); // transaction → the one lock it holds
  private spent = new Map<string, { id: string; at: number; ms: number }[]>(); // address → lock time with no transaction

  private sweep() {
    const now = Date.now();
    for (const [id, l] of this.locks) if (l.until <= now) this.drop(id);
    for (const [tx, t] of this.txs) if (now - t.at > CAP + WINDOW) this.txs.delete(tx);
    for (const [ip, xs] of this.spent) {
      const kept = xs.filter((x) => now - x.at < WINDOW);
      if (kept.length) this.spent.set(ip, kept);
      else this.spent.delete(ip);
    }
  }
  private drop(id: string) {
    const l = this.locks.get(id);
    if (!l) return;
    for (const c of l.colours) if (this.by.get(c) === id) this.by.delete(c);
    this.locks.delete(id);
  }

  /// Lock these Colors for `id` (taken by `account`, asked from `ip`) for `ms`, unless someone else holds any of them.
  /// `spent`: `ip` has used up its lock time without transactions.
  async acquire(id: string, account: string, ip: string, colours: number[], ms: number): Promise<{ ok: true } | { ok: false; busy: number[]; until: number } | { ok: false; spent: true }> {
    this.sweep();
    if (this.locks.has(id)) return { ok: false, busy: [], until: 0 }; // a lock is taken once
    const busy = colours.filter((c) => this.by.has(c));
    if (busy.length) return { ok: false, busy, until: Math.max(...busy.map((c) => this.locks.get(this.by.get(c)!)!.until)) };
    const now = Date.now();
    const had = this.spent.get(ip) ?? [];
    if (had.reduce((a, x) => a + x.ms, 0) + ms > BUDGET) return { ok: false, spent: true };
    this.spent.set(ip, [...had, { id, at: now, ms }]);
    this.locks.set(id, { account, ip, colours, at: now, until: now + ms, tx: null });
    for (const c of colours) this.by.set(c, id);
    return { ok: true };
  }

  /// Who took `id`'s lock, and the transaction already holding it; null once it's gone.
  async lockOf(id: string): Promise<{ account: string; tx: string | null } | null> {
    this.sweep();
    const l = this.locks.get(id);
    return l ? { account: l.account, tx: l.tx } : null;
  }

  /// Keep `id`'s Colors another `ms`, never past CAP from the click: its transaction `tx` is on its way (the Worker
  /// has checked it). 'gone': the lock isn't there any more; 'taken': `tx` already holds another lock.
  async hold(id: string, tx: string, ms: number): Promise<'held' | 'gone' | 'taken'> {
    this.sweep();
    const l = this.locks.get(id);
    const t = this.txs.get(tx);
    if (!l) return 'gone';
    if (t && t.id !== id) return 'taken';
    if (!t) this.txs.set(tx, { id, at: Date.now() });
    l.tx = tx;
    l.until = Math.max(l.until, Math.min(Date.now() + ms, l.at + CAP));
    // A real transaction: the lock's time no longer counts against its address.
    const xs = this.spent.get(l.ip);
    if (xs) this.spent.set(l.ip, xs.filter((x) => x.id !== id));
    return 'held';
  }

  async release(id: string) {
    const l = this.locks.get(id);
    // Released early (cancelled in the wallet): only the time it was held counts against its address.
    const x = l && this.spent.get(l.ip)?.find((s) => s.id === id);
    if (x) x.ms = Math.min(x.ms, Date.now() - x.at);
    this.drop(id);
  }

  /// The Colors being bought right now.
  async held(): Promise<number[]> {
    this.sweep();
    return [...this.by.keys()];
  }
}
