/// The Statements for sale (Market → Statements): OpenSea's listings of the Statements contract, each with its Credit
/// Rating and format as the contract states them, and the call that buys one straight from the buyer's wallet
/// (Seaport's fulfillAdvancedOrder, no Sweeper: a Statement is bought one at a time).
import { encodeFunctionData, type Address, type PublicClient } from 'viem';
import { sweeperAbi } from '../app/abi';
import { bestPage, fillFor, type Listing } from './opensea';

const SEAPORT: Address = '0x0000000000000068F116a894984e2DB1123eB395';
const SLUG = 'statements';
const READ = [
  { type: 'function', name: 'creditScoreOf', stateMutability: 'view', inputs: [{ type: 'uint256' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'formatOf', stateMutability: 'view', inputs: [{ type: 'uint256' }], outputs: [{ type: 'uint8' }] },
  { type: 'function', name: 'historyLength', stateMutability: 'view', inputs: [{ type: 'uint256' }], outputs: [{ type: 'uint256' }] },
] as const;

/// Seaport 1.6's fulfillAdvancedOrder, its AdvancedOrder taken from the Sweeper's ABI (the same struct).
const sweepIn = (sweeperAbi as readonly { type: string; name?: string; inputs?: readonly { name: string; components?: unknown }[] }[]).find((x) => x.type === 'function' && x.name === 'sweep')!.inputs!.find((i) => i.name === 'orders')!;
const FULFILL = [
  {
    type: 'function',
    name: 'fulfillAdvancedOrder',
    stateMutability: 'payable',
    inputs: [
      { name: 'advancedOrder', type: 'tuple', components: sweepIn.components },
      {
        name: 'criteriaResolvers',
        type: 'tuple[]',
        components: [
          { name: 'orderIndex', type: 'uint256' },
          { name: 'side', type: 'uint8' },
          { name: 'index', type: 'uint256' },
          { name: 'identifier', type: 'uint256' },
          { name: 'criteriaProof', type: 'bytes32[]' },
        ],
      },
      { name: 'fulfillerConduitKey', type: 'bytes32' },
      { name: 'recipient', type: 'address' },
    ],
    outputs: [{ name: 'fulfilled', type: 'bool' }],
  },
] as const;

export type ForSale = Listing & { rating: number | null; format: number | null; pages: number | null };

/// Every Statement listed on OpenSea (cheapest per Statement), up to three pages, with its rating, format and how many
/// pages it holds (more than one when others were overprinted onto it).
export async function statementsForSale(key: string, statements: Address, c: PublicClient): Promise<ForSale[]> {
  const out: Listing[] = [];
  let next = '';
  for (let i = 0; i < 3; i++) {
    const pg = await bestPage(key, SLUG, statements, next);
    for (const l of pg.items) if (!out.some((x) => x.id === l.id)) out.push(l);
    if (!pg.next) break;
    next = pg.next;
  }
  const reads = await c.multicall({
    contracts: out.flatMap((l) => [
      { address: statements, abi: READ, functionName: 'creditScoreOf', args: [BigInt(l.id)] } as const,
      { address: statements, abi: READ, functionName: 'formatOf', args: [BigInt(l.id)] } as const,
      { address: statements, abi: READ, functionName: 'historyLength', args: [BigInt(l.id)] } as const,
    ]),
    allowFailure: true,
    multicallAddress: '0xcA11bde05977b3631167028862bE2a173976CA11',
  });
  return out.map((l, i) => {
    const sc = reads[3 * i], f = reads[3 * i + 1], h = reads[3 * i + 2];
    return {
      ...l,
      rating: sc.status === 'success' ? Number((sc.result as bigint) / 10_000n) : null,
      format: f.status === 'success' ? Number(f.result) : null,
      pages: h.status === 'success' ? Number(h.result) : null,
    };
  });
}

/// The transaction that buys one listed Statement for `buyer`: to Seaport, with the listing's price as value.
/// Seaport 1.6's fulfillAvailableAdvancedOrders: several listings in one call, each filled if still there; one that
/// sold since is skipped and its ETH comes back to the caller in the same call.
const FULFILL_MANY = [
  {
    type: 'function',
    name: 'fulfillAvailableAdvancedOrders',
    stateMutability: 'payable',
    inputs: [
      { name: 'advancedOrders', type: 'tuple[]', components: sweepIn.components },
      { name: 'criteriaResolvers', type: 'tuple[]', components: FULFILL[0].inputs[1].components },
      { name: 'offerFulfillments', type: 'tuple[][]', components: [{ name: 'orderIndex', type: 'uint256' }, { name: 'itemIndex', type: 'uint256' }] },
      { name: 'considerationFulfillments', type: 'tuple[][]', components: [{ name: 'orderIndex', type: 'uint256' }, { name: 'itemIndex', type: 'uint256' }] },
      { name: 'fulfillerConduitKey', type: 'bytes32' },
      { name: 'recipient', type: 'address' },
      { name: 'maximumFulfilled', type: 'uint256' },
    ],
    outputs: [],
  },
] as const;

/// The most Statements one buy fills (about 150k gas each).
export const MAX_STATEMENTS = 10;

/// Several Statements in one transaction from the buyer's wallet, each to the buyer: every listing's signed order for
/// them, one offer item and its consideration items fulfilled on their own (no aggregation across sellers), and the
/// ETH all of them ask. Listings OpenSea no longer has drop out here; any that sell before the block, there.
export async function buyStatements(key: string, picks: { hash: string; protocol: string }[], buyer: Address) {
  const fills = (await Promise.all(picks.map((x) => fillFor(key, x.hash, x.protocol, buyer).catch(() => null)))).filter((f): f is NonNullable<typeof f> => !!f);
  if (!fills.length) throw new Error('Those Statements just sold. Pick again.');
  const orders = fills.map((f) => f.order);
  const offer = orders.map((_, i) => [{ orderIndex: BigInt(i), itemIndex: 0n }]);
  const consideration = orders.flatMap((o, i) => (o.parameters.consideration as unknown[]).map((_, j) => [{ orderIndex: BigInt(i), itemIndex: BigInt(j) }]));
  const value = fills.reduce((a, f) => a + f.value, 0n);
  const data = encodeFunctionData({ abi: FULFILL_MANY, functionName: 'fulfillAvailableAdvancedOrders', args: [orders as never, [], offer, consideration, `0x${'0'.repeat(64)}`, buyer, BigInt(orders.length)] });
  return { to: SEAPORT, data, value: value.toString(), n: orders.length };
}

export async function buyStatement(key: string, hash: string, protocol: string, buyer: Address) {
  const { order, value } = await fillFor(key, hash, protocol, buyer);
  const data = encodeFunctionData({ abi: FULFILL, functionName: 'fulfillAdvancedOrder', args: [order as never, [], `0x${'0'.repeat(64)}`, buyer] });
  return { to: SEAPORT, data, value: value.toString() };
}
