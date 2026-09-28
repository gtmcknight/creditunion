/// CreditStrategy (nftstrategy.fun) on Ethereum mainnet, read-only: it buys floor Credits and holds them for sale
/// at a markup from its own contract, not Seaport, so OpenSea never shows them. A third Buy Credits source.
/// Nothing here signs or sends. Self-contained (viem only) so it can be exercised from a plain node script.
import { encodeAbiParameters, parseAbi, type Address, type Hex, type PublicClient } from 'viem';

export const strategyAbi = parseAbi(['function nftForSale(uint256 tokenId) view returns (uint256)']);

/// contracts/src/lens/StrategyScan.sol creation code, run in an eth_call and never deployed: returns every id in a
/// range the strategy has for sale, packed (id << 128) | price. `forge build` and copy .bytecode.object on change.
const SCAN =
  '0x346054576100f5388190036080601f8201601f19168101906001600160401b038211908210176058576060928291604052608039126054576080516001600160a01b038116810360545760a05160c05191606c565b5f80fd5b634e487b7160e01b5f52604160045260245ffd5b91604051925f9263485d3d1960e11b5f525b828110609e57505050806040602084019360208552015260051b60400190f35b806004526020604060245f855afa60bc575b6001908560405201607e565b60405180151560203d10151660d1575b5060b0565b9390600180920194828060801b03168160801b1760408660051b880101529060cc56fe';
/// Ids per call: about 3,800 gas each, under the 50M eth_call gas cap most RPCs (publicnode included) set.
const SPAN = 10_000;
const GAS = 50_000_000n;
/// A span that won't run in one call (more of it for sale costs more gas) is read in halves, down to this.
const MIN_SPAN = 500;

export type StrategyListing = { id: string; price: string };

/// Every Credit the strategy has for sale, cheapest first (then by id). The strategy can't list what it holds, so
/// this reads nftForSale for every Credit id, 1..supply, a range per call, all calls at once.
export async function strategyListings(c: PublicClient, o: { strategy: Address; supply: number }): Promise<StrategyListing[]> {
  const spans: [number, number][] = [];
  for (let from = 1; from <= o.supply; from += SPAN) spans.push([from, Math.min(from + SPAN, o.supply + 1)]);
  const read = async (from: number, to: number): Promise<bigint[]> => {
    const args = encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }, { type: 'uint256' }], [o.strategy, BigInt(from), BigInt(to)]);
    try {
      const r = await c.call({ data: (SCAN + args.slice(2)) as Hex, gas: GAS });
      return decode(r.data ?? '0x');
    } catch (e) {
      if (to - from <= MIN_SPAN) throw e;
      const mid = from + Math.floor((to - from) / 2);
      const [a, b] = await Promise.all([read(from, mid), read(mid, to)]);
      return [...a, ...b];
    }
  };
  const parts = await Promise.all(spans.map(([from, to]) => read(from, to)));
  const mask = (1n << 128n) - 1n;
  const all = parts.flat().map((x) => ({ id: x >> 128n, price: x & mask }));
  all.sort((a, b) => (a.price < b.price ? -1 : a.price > b.price ? 1 : a.id < b.id ? -1 : 1));
  return all.map((x) => ({ id: String(x.id), price: String(x.price) }));
}

/// An abi-encoded uint256[] (offset, length, words).
function decode(data: Hex): bigint[] {
  const hex = data.slice(2);
  if (hex.length < 128) throw new Error('Strategy scan returned nothing.');
  const n = Number(BigInt('0x' + hex.slice(64, 128)));
  if (hex.length < 128 + n * 64) throw new Error('Strategy scan came back short.');
  return Array.from({ length: n }, (_, i) => BigInt('0x' + hex.slice(128 + i * 64, 192 + i * 64)));
}

/// One Credit, read now: still for sale, at this price.
export async function confirmStrategy(c: PublicClient, strategy: Address, l: StrategyListing): Promise<boolean> {
  const price = await c.readContract({ address: strategy, abi: strategyAbi, functionName: 'nftForSale', args: [BigInt(l.id)] });
  return price > 0n && String(price) === l.price;
}
