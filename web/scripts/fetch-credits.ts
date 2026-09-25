// Rebuilds data/credits.json ({ id: [seedHex, paidAt] }) from the Credits contract's Distributed events, so the
// edition files and the onchain score table can be regenerated and checked by anyone:
//   MAINNET_RPC=… node scripts/fetch-credits.ts [out=data/credits.json]
// The edition is sealed (122,154 Credits), so the result is fixed; windows stay small for provider log limits.
import { writeFileSync } from 'node:fs';
import { createPublicClient, http, parseAbiItem } from 'viem';
import { mainnet } from 'viem/chains';

const CREDITS = '0x97630aA70AB14ed9883B41dAfccBc11349723043' as const;
const DEPLOY_BLOCK = 26_037_292n; // Sourcify: creation tx 0x8d8b6d11…48ae
const WINDOW = 150n;
const out = process.argv[2] ?? 'data/credits.json';
const rpc = process.env.MAINNET_RPC;
if (!rpc) throw new Error('MAINNET_RPC is required');

const client = createPublicClient({ chain: mainnet, transport: http(rpc, { timeout: 30_000 }) });
const event = parseAbiItem('event Distributed(uint256 indexed tokenId, address indexed to, bytes21 seed, uint64 paidAt)');
const supply = Number(await client.readContract({ address: CREDITS, abi: [parseAbiItem('function supply() view returns (uint256)')], functionName: 'supply' }));
const sealed = await client.readContract({ address: CREDITS, abi: [parseAbiItem('function isSealed() view returns (bool)')], functionName: 'isSealed' });
console.log('supply', supply, 'sealed', sealed);

const credits: Record<string, [string, number]> = {};
const head = await client.getBlockNumber();
for (let from = DEPLOY_BLOCK; from <= head && Object.keys(credits).length < supply; from += WINDOW) {
  const to = from + WINDOW - 1n > head ? head : from + WINDOW - 1n;
  for (let attempt = 0; ; attempt++) {
    try {
      const logs = await client.getLogs({ address: CREDITS, event, fromBlock: from, toBlock: to });
      for (const l of logs) credits[String(l.args.tokenId)] = [l.args.seed as string, Number(l.args.paidAt)];
      break;
    } catch (e) {
      if (attempt >= 5) throw e;
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
    }
  }
  if ((Number(from - DEPLOY_BLOCK) / Number(WINDOW)) % 20 === 0) console.log(`block ${from}: ${Object.keys(credits).length} Credits`);
}
const ids = Object.keys(credits).map(Number).sort((a, b) => a - b);
if (ids.length !== supply || ids[0] !== 1 || ids[ids.length - 1] !== supply) throw new Error(`incomplete: ${ids.length} of ${supply}`);
const sorted: Record<string, [string, number]> = {};
for (const id of ids) sorted[id] = credits[id];
writeFileSync(out, JSON.stringify(sorted));
console.log('wrote', out, ids.length, 'Credits');
