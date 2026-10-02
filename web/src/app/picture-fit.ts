/// Can join for a picture union: which of your Credits its plan would take now (null: not a picture), by the same test its own page runs
/// (planPicture in views/party.ts). The picture is matched against the listings of its Colors at the plan's price and
/// yours, each open spot gets its best Credit, and one of yours takes a spot only where it draws it about as well as
/// the best for sale (OWN_GOOD).
import type { Address } from 'viem';
import { config } from './chain';
import { keptSpots, layoutSlot, placeOnLayout, type Listed, type Rated } from './data';
import { Guide, OWN_GOOD, planOf, sliceBase, unpackPicture, type Stored } from './picture';
import { placedKeys } from './slots';
import { paletteBit } from './traits';

/// `owned`: all your Credits, as the page plans with them: its plan may give a spot to one of yours the rules then
/// refuse, so the caller keeps only the picked ones its rules take, as the page does. `traits`: their Colors.
export async function pictureFit(b: Listed, account: Address, owned: bigint[], traits: Map<string, Rated>): Promise<bigint[] | null> {
  const r = await fetch(`/pictures/${b.s.address}`);
  if (!r.ok && r.status !== 404) throw new Error(`picture ${r.status}`);
  const d = r.ok ? ((await r.json()) as Stored | null) : null;
  if (!d) return null; // no saved picture: a plain painted union, where Colors are the whole test
  const slots = Array.from({ length: 80 }, (_, i) => layoutSlot(b.s.filter, i));
  let placed: (bigint | null)[] | undefined;
  if (b.ids.length) {
    const keyed = await placedKeys(b.s.address, b.ids);
    placed = placeOnLayout(slots, b.ids, (id) => keyed.get(id.toString()) ?? 0);
    placed = (await keptSpots(b.s.address)) ?? placed; // where the burn contract keeps them, once it's on
  }
  const colours = (id: bigint) => {
    const t = traits.get(id.toString());
    return t ? paletteBit(t.traits.palette) : 0;
  };
  // Only yours of a Colors the sheet paints can draw a spot: the rest would only slow the match down.
  const painted = new Set(slots);
  const ids = owned.filter((id) => painted.has(colours(id)));
  if (!ids.length) return [];
  const guide = await Guide.of(unpackPicture(d.px), { wallets: [account], held: ids, colours, detail: d.detail, own: config.sweeper ? OWN_GOOD : 1, look: d.look, base: sliceBase(slots, ids) });
  const rec = guide.fillYoursFirst(slots, placed ? placed.map((x) => (x === null ? null : Number(x))) : slots.map(() => null));
  const plan = planOf(rec, slots, placed, guide.twins(slots));
  return ids.filter((id) => plan.mine.has(id.toString()));
}
