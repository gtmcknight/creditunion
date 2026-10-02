/// Outbid alerts, on every page, for the wallet that's connected (or the last one that was, kept as an address only):
/// auctions it bid on whose lead has passed to someone else, each told once in this browser. A toast on the site
/// (waiting for your return if the tab is in the background), "(Outbid)" in the tab's title meanwhile, and a system
/// notification there if you turned them on after a bid.
import type { Address } from 'viem';
import { session } from './chain';
import { listBatches, type Listed } from './data';
import { esc, eth, same, toast } from './ui';

const SEEN = 'cu-outbid-seen'; // union → the high bid you were told about
const LAST = 'cu-last-account';
const POLL = 30_000;

const read = <T>(k: string, d: T): T => {
  try {
    const v = localStorage.getItem(k);
    return v ? (JSON.parse(v) as T) : d;
  } catch {
    return d;
  }
};
const write = (k: string, v: unknown) => {
  try {
    localStorage.setItem(k, JSON.stringify(v));
  } catch {}
};

/// The wallet to watch: the one connected, else the last one that was.
function watched(): Address | null {
  if (session.account) {
    write(LAST, session.account);
    return session.account;
  }
  return read<Address | null>(LAST, null);
}

/// A union page that just said so itself: don't say it again.
export function markOutbidSeen(union: string, highBid: bigint) {
  const seen = read<Record<string, string>>(SEEN, {});
  seen[union.toLowerCase()] = String(highBid);
  write(SEEN, seen);
}

/// Unions this wallet has bid on and when it last did, from the activity feed (a few seconds behind the chain).
async function bidOn(me: Address): Promise<Map<string, number>> {
  type Row = { kind: string; union?: string; time?: number };
  const r = await fetch(`/activity.json?member=${me}&limit=1000`)
    .then((x) => x.json() as Promise<{ items?: Row[] }>)
    .catch(() => ({ items: [] as Row[] }));
  const last = new Map<string, number>();
  for (const x of r.items ?? []) if (x.kind === 'bid' && x.union) last.set(x.union.toLowerCase(), Math.max(last.get(x.union.toLowerCase()) ?? 0, x.time ?? 0));
  return last;
}
/// After your own bid the feed can show it a few seconds before the union list does: no "outbid" until both caught up.
const GRACE = 90;

export async function checkOutbid() {
  const me = watched();
  if (!me) return;
  const [mine, all] = await Promise.all([bidOn(me), listBatches().catch(() => [] as Listed[])]);
  if (!mine.size) return;
  const now = Date.now() / 1000;
  const seen = read<Record<string, string>>(SEEN, {});
  const fresh: Listed[] = [];
  for (const b of all) {
    const k = b.s.address.toLowerCase();
    if (!mine.has(k)) continue;
    if (now - (mine.get(k) ?? 0) < GRACE) continue; // your own bid, still being indexed
    const live = b.s.state === 'Auction' && !(b.s.highBid > 0n && now >= b.s.auctionEnd);
    if (!live || same(b.s.highBidder, me)) {
      delete seen[k]; // leading again, or over: a later outbid is news
      continue;
    }
    if (seen[k] === String(b.s.highBid)) continue;
    seen[k] = String(b.s.highBid);
    fresh.push(b);
  }
  write(SEEN, seen);
  if (fresh.length) tell(fresh);
}

const title = (b: Listed) => `${b.s.name || 'Untitled'} #${b.s.statementId}`;
let waiting: Listed[] = [];
let plainTitle = '';

function tell(list: Listed[]) {
  if (!document.hidden) return say(list);
  // In the background: the title says so now, the toast waits for your return, and the system says so if allowed.
  waiting = [...waiting.filter((w) => !list.some((b) => b.s.address === w.s.address)), ...list];
  plainTitle ||= document.title;
  document.title = waiting.length === 1 ? `(Outbid) ${title(waiting[0])} · Credit Union` : `(Outbid on ${waiting.length}) · Credit Union`;
  if ('Notification' in window && Notification.permission === 'granted') {
    const one = list.length === 1 ? list[0] : null;
    const n = new Notification(one ? `Outbid on ${title(one)}` : `Outbid on ${list.length} auctions`, {
      body: one ? `${eth(one.s.highBid)} now. Bid again on Credit Union.` : 'Bid again on Credit Union.',
      tag: 'cu-outbid',
    });
    n.onclick = () => {
      window.focus();
      location.href = one ? `/union/${one.s.address}` : '/auctions/multibid';
      n.close();
    };
  }
}

function say(list: Listed[]) {
  const one = list.length === 1 ? list[0] : null;
  toast(
    one
      ? `Outbid on <a href="/union/${one.s.address}">${esc(title(one))}</a>: ${eth(one.s.highBid)} now.`
      : `Outbid on ${list.length} auctions. <a href="/auctions/multibid">Bid again</a>`,
    'info', // news, not an error: red is for what failed
    12_000,
    true,
  );
}

/// A page that saw the bid land itself (the Auctions page reads every 10 seconds): the one alert, told once.
export function outbidNow(b: Listed) {
  markOutbidSeen(b.s.address, b.s.highBid);
  tell([b]);
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  if (plainTitle) (document.title = plainTitle), (plainTitle = '');
  if (waiting.length) say(waiting), (waiting = []);
});

/// After a bid: offer the system notification once, while the browser can still ask.
export function offerAlerts() {
  if (!('Notification' in window) || Notification.permission !== 'default') return;
  toast('Get a notification here if you’re outbid? <button type="button" class="link" id="cu-alerts-on">Turn on</button>', 'info', 12_000, true);
  document.getElementById('cu-alerts-on')?.addEventListener('click', () => void Notification.requestPermission());
}

let polling = false;
/// Checks soon after the page opens (a visit's "since last time"), then every 30 seconds, background tabs included.
export function watchOutbid() {
  if (polling) return void checkOutbid();
  polling = true;
  setTimeout(() => void checkOutbid(), 2_000);
  setInterval(() => void checkOutbid(), POLL);
}
