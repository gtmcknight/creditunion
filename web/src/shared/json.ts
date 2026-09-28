/// JSON that keeps bigints: written as { "$n": "123" } and read back as 123n. The Worker's union index
/// (/unions.json) carries Batch.summary this way, so the app gets the same values a readContract would.
export const toJson = (v: unknown) => JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? { $n: x.toString() } : x));
export const fromJson = (s: string): unknown =>
  JSON.parse(s, (_, x) => (x && typeof x === 'object' && typeof x.$n === 'string' && Object.keys(x).length === 1 ? BigInt(x.$n) : x));
