/// What the Statements contract's history says, for the overprint views: when each page of a Statement was made and
/// burned (its Timeline: the blocks of each page's Transfer from nowhere and to nowhere), and which overprinted
/// Statements still stand (Market → Statements, when none are for sale).
import { parseAbiItem, type Address, type PublicClient } from 'viem';

const TRANSFER = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)');
/// The block the Statements contract was deployed in: nothing of it is older.
const FROM = 26_100_733n;
/// Public RPCs cap a getLogs range; this fits the ones the site falls back to.
const WINDOW = 45_000n;
const NOWHERE = '0x0000000000000000000000000000000000000000';

export type Life = { made: number | null; burned: number | null };

export async function livesOf(c: PublicClient, rpcs: string[], statements: Address, ids: bigint[]): Promise<Life[]> {
  const head = await c.getBlockNumber();
  const read = (fromBlock: bigint, toBlock: bigint) => c.getLogs({ address: statements, event: TRANSFER, args: { tokenId: ids }, fromBlock, toBlock });
  // The whole history in one ask (a handful of transfers per page); a node that caps the range gets it in windows,
  // a few at a time.
  let logs: Awaited<ReturnType<typeof read>>;
  try {
    logs = await read(FROM, head);
  } catch {
    const spans: [bigint, bigint][] = [];
    for (let f = FROM; f <= head; f += WINDOW) spans.push([f, f + WINDOW - 1n > head ? head : f + WINDOW - 1n]);
    logs = [];
    for (let i = 0; i < spans.length; i += 6) logs.push(...(await Promise.all(spans.slice(i, i + 6).map(([f, t]) => read(f, t)))).flat());
  }
  const moves = logs.map((l) => ({ block: l.blockNumber, id: l.args.tokenId!, from: l.args.from!.toLowerCase(), to: l.args.to!.toLowerCase() }));
  const times = await blockTimes(rpcs, [...new Set(moves.map((m) => m.block))]);
  const when = (m?: { block: bigint }) => (m ? (times.get(m.block) ?? null) : null);
  return ids.map((id) => ({ made: when(moves.find((m) => m.id === id && m.from === NOWHERE)), burned: when(moves.find((m) => m.id === id && m.to === NOWHERE)) }));
}

/// Each block's time (ms), asked in one JSON-RPC batch, so a long history is still one request. Sent by hand rather
/// than through viem's batching, whose scheduler is shared across requests in an isolate (see index.ts).
async function blockTimes(rpcs: string[], blocks: bigint[]): Promise<Map<bigint, number>> {
  const out = new Map<bigint, number>();
  if (!blocks.length) return out;
  const body = JSON.stringify(blocks.map((n, id) => ({ jsonrpc: '2.0', id, method: 'eth_getBlockByNumber', params: [`0x${n.toString(16)}`, false] })));
  let failed: unknown = new Error('No RPC');
  for (const url of rpcs) {
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(8_000) });
      const got = (await r.json()) as { id: number; result?: { timestamp: string } | null }[];
      if (!Array.isArray(got) || got.length !== blocks.length || got.some((x) => !x.result)) throw new Error('Incomplete block batch');
      for (const x of got) out.set(blocks[x.id], Number(BigInt(x.result!.timestamp)) * 1000);
      return out;
    } catch (e) {
      failed = e;
    }
  }
  throw failed;
}

const READ = [
  { type: 'function', name: 'supply', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'historyLength', stateMutability: 'view', inputs: [{ type: 'uint256' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'ownerOf', stateMutability: 'view', inputs: [{ type: 'uint256' }], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'creditScoreOf', stateMutability: 'view', inputs: [{ type: 'uint256' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'formatOf', stateMutability: 'view', inputs: [{ type: 'uint256' }], outputs: [{ type: 'uint8' }] },
] as const;
const MULTICALL: Address = '0xcA11bde05977b3631167028862bE2a173976CA11';

export type Overprint = { id: string; pages: number; rating: number | null; format: number | null };

/// The overprinted Statements still standing (an owner, more than one page), most pages first, then newest, up to
/// `count`, and how many there are: every Statement's history length and owner in one multicall (ids run 1..supply),
/// then the rating and format of those shown.
export async function overprintsOf(c: PublicClient, statements: Address, count = 60): Promise<{ items: Overprint[]; total: number }> {
  const supply = Number(await c.readContract({ address: statements, abi: READ, functionName: 'supply' }));
  const ids = Array.from({ length: supply }, (_, i) => BigInt(i + 1));
  const reads = await c.multicall({
    contracts: ids.flatMap((id) => [{ address: statements, abi: READ, functionName: 'historyLength', args: [id] } as const, { address: statements, abi: READ, functionName: 'ownerOf', args: [id] } as const]),
    allowFailure: true,
    batchSize: 0,
    multicallAddress: MULTICALL,
  });
  const all = ids
    .map((id, i) => ({ id, pages: reads[2 * i].status === 'success' ? Number(reads[2 * i].result) : 0, owned: reads[2 * i + 1].status === 'success' }))
    .filter((x) => x.owned && x.pages > 1)
    .sort((a, b) => b.pages - a.pages || Number(b.id - a.id));
  const standing = all.slice(0, count);
  const more = await c.multicall({
    contracts: standing.flatMap((x) => [{ address: statements, abi: READ, functionName: 'creditScoreOf', args: [x.id] } as const, { address: statements, abi: READ, functionName: 'formatOf', args: [x.id] } as const]),
    allowFailure: true,
    batchSize: 0,
    multicallAddress: MULTICALL,
  });
  const items = standing.map((x, i) => {
    const sc = more[2 * i], f = more[2 * i + 1];
    return { id: x.id.toString(), pages: x.pages, rating: sc.status === 'success' ? Number((sc.result as bigint) / 10_000n) : null, format: f.status === 'success' ? Number(f.result) : null };
  });
  return { items, total: all.length };
}
