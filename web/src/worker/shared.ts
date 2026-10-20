/// A read one request starts and the others in this isolate share while it runs (the union index, the Activity feed,
/// a contract's address, a data file), its value then handed out for `keep(value)` ms (by default, not at all). Its
/// I/O belongs to the request that started it, and Workers cancel that when the request ends, as when its visitor
/// leaves: the read then never settles, and every request after would wait on it until the isolate is recycled. So
/// the starter keeps its read going with waitUntil (up to 30 s after it ends), and nobody waits on another request's
/// read past SHARE_MS from its start: they read for themselves, and the requests after them share that. A caller
/// without `ctx` gets only the limit.
const SHARE_MS = 4_000;
const LATE = Symbol('late');
export function shared<T>(keep: (v: T) => number = () => 0) {
  let now: { at: number; p: Promise<T>; until?: number } | null = null;
  return async (ctx: ExecutionContext | undefined, read: () => Promise<T>): Promise<T> => {
    const s = now;
    if (s?.until !== undefined) {
      if (Date.now() < s.until) return s.p;
    } else if (s) {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const late = new Promise<typeof LATE>((ok) => (timer = setTimeout(() => ok(LATE), s.at + SHARE_MS - Date.now())));
      const v = await Promise.race([s.p, late]).finally(() => clearTimeout(timer));
      if (v !== LATE) return v;
      if (now === s) now = null;
    }
    const mine: { at: number; p: Promise<T>; until?: number } = { at: Date.now(), p: read() };
    now = mine;
    // A failed read is asked again by the next caller.
    const settled = mine.p.then((v) => void (mine.until = Date.now() + keep(v)), () => void (mine.until = 0));
    ctx?.waitUntil(settled);
    return mine.p;
  };
}
