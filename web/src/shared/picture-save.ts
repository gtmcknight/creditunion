/// A Picture union's picture as the Worker keeps it (/pictures/<union>), and the words its creator signs to save it.
/// The page and the Worker both build them here, so the hash the creator signs is the hash of exactly what is kept.
import { getAddress, keccak256, toBytes } from 'viem';

const SUPPLY = 122_154;

/// The picture as kept, as text: 64 × 80 RGBA in base64 and the Detail it was matched with; the Credit picked for each
/// slot when all 80 are given (null where none was for sale); the format it was matched in when not Consolidated.
/// Always in this order, so one picture is always the same text. Null when the picture itself is malformed.
export function pictureRecord(b: { px?: unknown; detail?: unknown; ids?: unknown; look?: unknown }): string | null {
  const px = String(b.px ?? ''), detail = Number(b.detail);
  if (!/^[A-Za-z0-9+/]{27307}=$/.test(px) || !(detail >= 0 && detail <= 4)) return null; // 20,480 bytes
  const ids = Array.isArray(b.ids) && b.ids.length === 80 && b.ids.every((x) => x === null || (Number.isInteger(x) && x >= 1 && x <= SUPPLY)) ? (b.ids as (number | null)[]) : null;
  const look = b.look === 'Assessed' || b.look === 'Reconciled' ? b.look : null;
  return JSON.stringify({ px, detail, ...(ids ? { ids } : {}), ...(look ? { look } : {}) });
}

/// What the union's creator signs to save its picture (a message, not a transaction): the union, the chain, and the
/// hash of the picture as kept.
export const pictureMessage = (union: string, chainId: number, record: string) =>
  `Credit Union: save the picture for my union.\n\nUnion: ${getAddress(union)}\nChain: ${chainId}\nPicture: ${keccak256(toBytes(record))}`;
