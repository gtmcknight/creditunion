/// Which of a wallet's Credits fit which batch, evaluated in the browser from the same trait data the
/// design page uses, so the listing can say "you can join" without a chain call per Credit per batch.
/// Allowlisted batches are the exception: their lists live only onchain, so those are checked there.
import type { Address } from 'viem';
import { batchAbi } from './abi';
import { pub, session } from './chain';
import { myCredits, ratings, type Listed, type Rated, type Summary } from './data';
import { paletteBit, TRAITS } from './traits';

let cache: { account: string; owned: bigint[]; traits: Map<string, Rated> } | null = null;

/// The connected wallet's Credits with their traits. Cached per account for the session.
export async function myTraits(): Promise<{ owned: bigint[]; traits: Map<string, Rated> }> {
  const account = session.account;
  if (!account) return { owned: [], traits: new Map() };
  if (cache && cache.account === account) return cache;
  const owned = [...(await myCredits(account))];
  const traits = new Map<string, Rated>();
  for (let i = 0; i < owned.length; i += 200) {
    try {
      const r = await ratings(owned.slice(i, i + 200));
      for (const [id, v] of Object.entries(r.ratings)) traits.set(id, v);
    } catch {}
  }
  cache = { account, owned, traits };
  return cache;
}

export function invalidateFit() {
  cache = null;
}

const weightOf = (r: Rated) => {
  const marks = r.traits.activeBits, cap = r.traits.palette.length * 64;
  if (marks * 256 >= 120 * cap && marks * 256 <= 136 * cap) return 'even';
  if (marks * 256 >= 112 * cap && marks * 256 <= 144 * cap) return 'lean';
  if (marks * 256 >= 96 * cap && marks * 256 <= 160 * cap) return 'sparse';
  return 'extreme';
};

/// Everything except the allowlist, which needs the chain.
export function fitsRules(s: Summary, id: bigint, r: Rated | undefined): boolean {
  const f = s.filter;
  if (f.idFrom && id < f.idFrom) return false;
  if (f.idTo && id > f.idTo) return false;
  const wantsTraits = f.palettes || f.prints || f.weights || f.eights || f.paidFrom || f.paidTo;
  if (!wantsTraits) return true;
  if (!r) return false;
  if (f.paidFrom && r.paidAt < f.paidFrom) return false;
  if (f.paidTo && r.paidAt > f.paidTo) return false;
  if (f.palettes && !(f.palettes & (1 << paletteBit(r.traits.palette)))) return false;
  if (f.prints && !(f.prints & (1 << TRAITS.print.indexOf(r.traits.registration as (typeof TRAITS.print)[number])))) return false;
  if (f.weights && !(f.weights & (1 << TRAITS.weight.indexOf(weightOf(r) as (typeof TRAITS.weight)[number])))) return false;
  if (f.eights && !(f.eights & (1 << r.traits.eights))) return false;
  return true;
}

/// For each open batch, the ids of the wallet's Credits that could be deposited.
export async function fitByBatch(list: Listed[]): Promise<Map<Address, bigint[]>> {
  const out = new Map<Address, bigint[]>();
  const { owned, traits } = await myTraits();
  if (!owned.length) return out;
  for (const { s } of list) {
    if (s.state !== 'Open') continue;
    let fit = owned.filter((id) => fitsRules(s, id, traits.get(id.toString())));
    if (fit.length && s.allowlistSize) {
      const ok = await Promise.all(
        fit.map((id) => pub.readContract({ address: s.address, abi: batchAbi, functionName: 'allowed', args: [id] }).catch(() => false)),
      );
      fit = fit.filter((_, i) => ok[i]);
    }
    if (fit.length) out.set(s.address, fit);
  }
  return out;
}
