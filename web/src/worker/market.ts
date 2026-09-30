/// The market book: every Credit for sale (OpenSea, FWA, CreditStrategy), the cheapest listing each, in one Durable
/// Object so every page reads the same book at once. The cron keeps it live: each minute it applies what OpenSea's
/// event feed says changed (new listings in, sold or moved Credits out), every 5 minutes it re-reads FWA and the
/// strategy, and once an hour it rebuilds the whole book from OpenSea as a check. Buying never trusts it: a buy
/// always takes a fresh signed order, so a listing gone since just drops out.
import { DurableObject } from 'cloudflare:workers';
import { createPublicClient, http, parseAbiItem, type Address } from 'viem';
import { events, setSpareKey, type Listing } from './opensea';

type Env = { MARKET_LOOP?: string; OPENSEA_API_KEY?: string; OPENSEA_API_KEY_2?: string; OPENSEA_SLUG: string; CREDITS: string; SWEEPER?: string; RPC_URL?: string; FALLBACK_RPC: string };
/// How often the book reads OpenSea's feed and the chain: about a block.
const TICK = 10_000;
const TRANSFER = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)');

/// One row: [id, price in wei, source, a, b, seller, until]. OpenSea: a = order hash, b = protocol. FWA: a = its
/// listing id. seller: who listed it (lowercase), '' when unknown. until: expiry, unix seconds (0 = none).
export type Row = [string, string, string, string, string, string, number];

export class MarketBook extends DurableObject<Env> {
  private sql = this.ctx.storage.sql;
  private memo: { v: number; at: number; body: string } | null = null;
  private v = 0;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS listings (id TEXT PRIMARY KEY, price TEXT, source TEXT, a TEXT, b TEXT, seller TEXT, until INTEGER)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)`);
  }

  private meta(k: string): string | null {
    const r = this.sql.exec(`SELECT v FROM meta WHERE k = ?`, k).toArray()[0];
    return r ? String(r.v) : null;
  }
  private setMeta(k: string, v: string | number) {
    this.sql.exec(`INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`, k, String(v));
  }
  private put(r: Row) {
    this.sql.exec(`INSERT INTO listings (id, price, source, a, b, seller, until) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET price = excluded.price, source = excluded.source, a = excluded.a, b = excluded.b, seller = excluded.seller, until = excluded.until`, ...r);
  }
  private changed() {
    this.v++;
    this.setMeta('updated', Date.now());
  }

  /// When it was last rebuilt whole, last changed, and where the event feed was read up to (unix seconds).
  async state(): Promise<{ built: number; updated: number; cursor: number; rows: number }> {
    const rows = Number(this.sql.exec(`SELECT COUNT(*) AS n FROM listings`).toArray()[0].n);
    return { built: Number(this.meta('built') ?? 0), updated: Number(this.meta('updated') ?? 0), cursor: Number(this.meta('cursor') ?? 0), rows };
  }

  /// Claim the next job of this kind for `ms` (a rebuild takes a minute or more; the cron comes every minute): false
  /// while an earlier claim still holds.
  async claim(kind: string, ms: number): Promise<boolean> {
    const until = Number(this.meta('claim:' + kind) ?? 0);
    if (until > Date.now()) return false;
    this.setMeta('claim:' + kind, Date.now() + ms);
    return true;
  }
  async release(kind: string) {
    this.setMeta('claim:' + kind, 0);
  }

  /// The hourly rebuild: the whole book at once.
  async replaceAll(rows: Row[], cursor: number) {
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(`DELETE FROM listings`);
      for (const r of rows) this.put(r);
      this.setMeta('built', Date.now());
      if (!this.meta('cursor')) this.setMeta('cursor', cursor);
    });
    this.changed();
  }

  /// FWA's and the strategy's listings, read whole every few minutes: theirs replace the old, and a cheaper OpenSea
  /// listing of the same Credit stays.
  async setExtras(rows: Row[]) {
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(`DELETE FROM listings WHERE source IN ('fwa', 'strategy')`);
      for (const r of rows) {
        const had = this.sql.exec(`SELECT price FROM listings WHERE id = ?`, r[0]).toArray()[0];
        if (!had || BigInt(String(had.price)) > BigInt(r[1])) this.put(r);
      }
    });
    this.changed();
  }

  /// What the event feed said since the cursor, oldest first. A listing replaces the Credit's row when it's cheaper,
  /// when the row is the same seller's (a relist, maybe dearer) or when the row has expired. A Credit that left
  /// `from` (sold or moved) takes that seller's listing with it.
  async apply(ops: ({ listed: Row } | { gone: { id: string; from: string } })[], cursor: number) {
    const now = Math.floor(Date.now() / 1000);
    this.ctx.storage.transactionSync(() => {
      for (const op of ops) {
        if ('gone' in op) {
          this.sql.exec(`DELETE FROM listings WHERE id = ? AND source = 'opensea' AND (seller = ? OR seller = '')`, op.gone.id, op.gone.from);
          continue;
        }
        const r = op.listed;
        const had = this.sql.exec(`SELECT price, source, seller, until FROM listings WHERE id = ?`, r[0]).toArray()[0];
        const expired = had && Number(had.until) > 0 && Number(had.until) <= now;
        if (!had || expired || BigInt(r[1]) < BigInt(String(had.price)) || (had.source === 'opensea' && had.seller === r[5])) this.put(r);
      }
      this.setMeta('cursor', cursor);
    });
    if (ops.length) this.changed();
    else this.setMeta('updated', Date.now());
  }

  /// Credits that moved (a sale anywhere, a transfer, a buy on our site): each seller's OpenSea listing of it is dead,
  /// and so is FWA's or the strategy's (the next read of theirs puts back one still listed).
  async moved(moves: { id: string; from: string }[]) {
    if (!moves.length) return;
    this.ctx.storage.transactionSync(() => {
      for (const m of moves) {
        this.sql.exec(`DELETE FROM listings WHERE id = ? AND source = 'opensea' AND (seller = ? OR seller = '')`, m.id, m.from);
        this.sql.exec(`DELETE FROM listings WHERE id = ? AND source IN ('fwa', 'strategy')`, m.id);
      }
    });
    this.changed();
  }

  /// Keep the 10-second loop running (the cron calls this each minute; the first call starts it).
  async kick() {
    if (this.env.MARKET_LOOP === 'off') return;
    if (!(await this.ctx.storage.getAlarm())) await this.ctx.storage.setAlarm(Date.now() + 1000);
  }

  /// Every ~10 s: new listings and sales from OpenSea's feed, and every Credit that moved on chain since the last
  /// block read (whatever marketplace it went through). Waits for the first full build (the cron's) to set a cursor.
  async alarm() {
    if (this.env.MARKET_LOOP === 'off') return; // local dev: don't spend the shared OpenSea key every 10 s
    try {
      if (this.env.OPENSEA_API_KEY && this.meta('cursor')) await this.tick();
    } catch (e) {
      console.warn('[market] tick failed', (e as Error).message?.slice(0, 200));
    } finally {
      await this.ctx.storage.setAlarm(Date.now() + TICK);
    }
  }

  private async tick() {
    const env = this.env;
    setSpareKey(env.OPENSEA_API_KEY_2);
    const credits = env.CREDITS as Address;
    const chain = createPublicClient({ transport: http(env.RPC_URL || env.FALLBACK_RPC, { timeout: 8_000 }) });
    const cursor = Number(this.meta('cursor'));
    const [ev, head] = await Promise.all([events(env.OPENSEA_API_KEY!, env.OPENSEA_SLUG, credits, cursor - 30, 4), chain.getBlockNumber()]);
    const row = (l: Listing): Row => [l.id, l.price, 'opensea', l.hash ?? '', l.protocol ?? '', l.seller ?? '', l.until ?? 0];
    await this.apply(ev.ops.map((o) => ('listed' in o ? { listed: row(o.listed) } : { gone: o.gone })), Math.max(cursor, ev.newest));
    // The chain: every Credit transfer since the last block read (a few blocks at most, so one call).
    const last = Number(this.meta('block') ?? 0);
    const from = last ? BigInt(last + 1) : head;
    if (from <= head) {
      const logs = await chain.getLogs({ address: credits, event: TRANSFER, fromBlock: from > head - 50n ? from : head - 50n, toBlock: head });
      await this.moved(logs.map((l) => ({ id: String(l.args.tokenId), from: String(l.args.from).toLowerCase() })));
    }
    this.setMeta('block', Number(head));
  }

  /// One Credit's row (expired ones count as gone), and how fresh the book is.
  async get(id: string): Promise<{ row: Row | null; updated: number }> {
    const r = this.sql.exec(`SELECT * FROM listings WHERE id = ?`, id).toArray()[0];
    const now = Math.floor(Date.now() / 1000);
    const row = r && !(Number(r.until) > 0 && Number(r.until) <= now) ? ([r.id, r.price, r.source, r.a, r.b, r.seller, Number(r.until)].map((x, i) => (i === 6 ? x : String(x))) as Row) : null;
    return { row, updated: Number(this.meta('updated') ?? 0) };
  }

  /// Many Credits' rows at once (expired ones count as gone), and how fresh the book is.
  async getMany(ids: string[]): Promise<{ rows: Row[]; updated: number }> {
    const now = Math.floor(Date.now() / 1000);
    const rows: Row[] = [];
    for (let i = 0; i < ids.length; i += 50) {
      const chunk = ids.slice(i, i + 50); // a query binds at most 100 values
      for (const r of this.sql.exec(`SELECT * FROM listings WHERE id IN (${chunk.map(() => '?').join(',')})`, ...chunk).toArray())
        if (!(Number(r.until) > 0 && Number(r.until) <= now)) rows.push([r.id, r.price, r.source, r.a, r.b, r.seller, Number(r.until)].map((x, k) => (k === 6 ? x : String(x))) as Row);
    }
    return { rows, updated: Number(this.meta('updated') ?? 0) };
  }

  /// The whole book as /market.json serves it: { at, items: [id, price, source, a, b][] }, unexpired, built once per
  /// change.
  async snapshot(): Promise<string> {
    if (this.memo && this.memo.v === this.v && Date.now() - this.memo.at < 60_000) return this.memo.body; // a minute at most, so expiries drop out
    const now = Math.floor(Date.now() / 1000);
    const items = this.sql
      .exec(`SELECT id, price, source, a, b FROM listings WHERE until = 0 OR until > ?`, now)
      .toArray()
      .map((r) => [r.id, r.price, r.source, r.a, r.b].map(String));
    const body = JSON.stringify({ at: Number(this.meta('updated') ?? Date.now()), items });
    this.memo = { v: this.v, at: Date.now(), body };
    return body;
  }
}
