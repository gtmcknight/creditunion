/// A short name for a union's Credits in slot order (FNV-1a over the ids, and how many). A URL that carries it asks
/// for exactly one answer, so that answer can be kept for good by the browser and at the edge.
export function idsKey(ids: readonly (bigint | number | string)[]): string {
  const s = ids.join('.');
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  return `${h.toString(36)}-${ids.length}`;
}
