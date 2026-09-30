/// The edition's data files (public/*.bin), each asked for with its content hash (scripts/bins.mjs), so the Worker
/// can let the browser keep it until the file changes. Read once per visit, whichever page asks first.
declare const __BINS__: Record<string, string>;
const HASH: Record<string, string> = typeof __BINS__ === 'undefined' ? {} : __BINS__; // a build without the plugin: unversioned
/// All the edition files' hashes as one: what's worked out from them and kept in the browser is kept under it.
export const binsVersion = Object.values(HASH).join('.');

/// A file as-is, not kept here. `as` names the file whose hash versions it (wall/<k>.bin: wall.bin's).
export const fetchBin = (path: string, as = path) =>
  fetch(HASH[as] ? `/${path}?v=${HASH[as]}` : `/${path}`).then((r) => {
    if (!r.ok) throw new Error(`${path} missing`);
    return r.arrayBuffer();
  });

const kept = new Map<string, Promise<ArrayBuffer>>();
export function bin(name: string): Promise<ArrayBuffer> {
  let p = kept.get(name);
  if (!p) {
    p = fetchBin(name);
    kept.set(name, p);
    p.catch(() => kept.delete(name)); // a failed read is retried next time, not remembered
  }
  return p;
}
