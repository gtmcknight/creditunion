/// The Bars for sale: OpenSea's listings of the Bars edition, each with the $BALANCE inside it: what its vault holds now
/// (the edition's Minted logs name each Bar's vault, and a melted Bar is gone, so it is never listed as holding anything).
import { erc20Abi, parseAbi, parseAbiItem, type Address, type PublicClient } from 'viem';
import { bestPage, type Listing } from './opensea';

const MINTED = parseAbiItem('event Minted(uint256 indexed id, address indexed to, address vault, uint256 amount)');
const MELTED = parseAbiItem('event Melted(uint256 indexed id, address indexed owner, uint256 amount)');

export type BarForSale = Listing & { holds: string };

/// Every live Bar and the $BALANCE it holds (wei), from `fromBlock` on. A melt hands over everything in the Bar's vault,
/// the deposit plus anything others sent to it, so that is what a Bar holds: its vault's balance now, or the deposit if
/// that read fails.
export async function barHoldings(c: PublicClient, edition: Address, fromBlock: bigint): Promise<Map<string, bigint>> {
  const [minted, melted, token] = await Promise.all([
    c.getLogs({ address: edition, event: MINTED, fromBlock, toBlock: 'latest' }),
    c.getLogs({ address: edition, event: MELTED, fromBlock, toBlock: 'latest' }),
    c.readContract({ address: edition, abi: parseAbi(['function balance() view returns (address)']), functionName: 'balance' }).catch(() => null),
  ]);
  const gone = new Set(melted.map((l) => String(l.args.id)));
  const live = minted.filter((l) => l.args.id != null && l.args.amount != null && !gone.has(String(l.args.id)));
  const held = token
    ? await c.multicall({ contracts: live.map((l) => ({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [l.args.vault!] }) as const), allowFailure: true }).catch(() => [])
    : [];
  const out = new Map<string, bigint>();
  live.forEach((l, i) => {
    const r = held[i];
    out.set(String(l.args.id), r?.status === 'success' ? (r.result as bigint) : l.args.amount!);
  });
  return out;
}

/// Listed Bars, cheapest first, up to two pages, each with what it holds (`holds`, from barHoldings). One the logs
/// don't know is left out.
export async function barsForSale(key: string, slug: string, edition: Address, holds: Map<string, bigint>): Promise<BarForSale[]> {
  const out: Listing[] = [];
  let next = '';
  for (let i = 0; i < 2; i++) {
    const pg = await bestPage(key, slug, edition, next);
    for (const l of pg.items) if (!out.some((x) => x.id === l.id)) out.push(l);
    if (!pg.next) break;
    next = pg.next;
  }
  return out.filter((l) => holds.has(l.id)).map((l) => ({ ...l, holds: holds.get(l.id)!.toString() }));
}

const TRANSFER = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)');

/// The Bars `who` holds now and what each holds, from the edition's Transfer logs in and out of that wallet.
export async function barsOwned(c: PublicClient, edition: Address, fromBlock: bigint, who: Address): Promise<{ id: string; holds: string }[]> {
  const [ins, outs, holds] = await Promise.all([
    c.getLogs({ address: edition, event: TRANSFER, args: { to: who }, fromBlock, toBlock: 'latest' }),
    c.getLogs({ address: edition, event: TRANSFER, args: { from: who }, fromBlock, toBlock: 'latest' }),
    barHoldings(c, edition, fromBlock),
  ]);
  const last = new Map<string, { at: bigint; mine: boolean }>();
  for (const [logs, mine] of [[ins, true], [outs, false]] as const)
    for (const l of logs) {
      const id = String(l.args.tokenId), at = (l.blockNumber ?? 0n) * 100_000n + BigInt(l.logIndex ?? 0);
      if (!last.has(id) || last.get(id)!.at < at) last.set(id, { at, mine });
    }
  return [...last].filter(([id, x]) => x.mine && holds.has(id)).map(([id]) => ({ id, holds: holds.get(id)!.toString() })).sort((a, b) => Number(BigInt(b.holds) - BigInt(a.holds)));
}
