// Builds public/credit-score.bin (and public/scores-live.bin): every Credit's score as the Statements contract computes it (its CreditScore's
// pure scoreOf(seed, paidAt)), in ten-thousandths (80.0000 → 800,000), uint32 little-endian, index id − 1.
// The edition is sealed, so this never changes; the file saves the site a chain call per Credit.
//   RPC=<mainnet rpc> node scripts/credit-score.ts [path/to/credits.json.gz]
import { readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { createPublicClient, http, toHex, type Address } from 'viem';
import { mainnet } from 'viem/chains';

const STATEMENTS = '0x75Edd94b7e49b3bD5C8047b91F165A5e265a069b';
const N = 122_154;
const c = createPublicClient({ chain: mainnet, transport: http(process.env.RPC, { timeout: 120_000 }) });
const score = (await c.readContract({ address: STATEMENTS, abi: [{ type: 'function', name: 'score', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] }], functionName: 'score' })) as Address;
const abi = [{ type: 'function', name: 'scoreOf', stateMutability: 'pure', inputs: [{ type: 'bytes21' }, { type: 'uint64' }], outputs: [{ type: 'uint256' }] }] as const;
const raw = readFileSync(process.argv[2] ?? new URL('../data/credits.json.gz', import.meta.url));
const src = JSON.parse(gunzipSync(raw).toString('utf8')) as Record<string, [string, number]>;
const seed = (v: string) => (v.startsWith('0x') ? (v as `0x${string}`) : toHex(Buffer.from(v, 'latin1')));
const out = new Uint32Array(N);
for (let i = 0; i < N; i += 400) {
  const ids = Array.from({ length: Math.min(400, N - i) }, (_, k) => i + k + 1);
  const res = await c.multicall({ contracts: ids.map((id) => ({ address: score, abi, functionName: 'scoreOf', args: [seed(src[id][0]), BigInt(src[id][1])] }) as const), allowFailure: false, batchSize: 0 });
  ids.forEach((id, k) => (out[id - 1] = Number(res[k])));
}
if (out.some((v) => v < 800_000 || v > 8_000_000)) throw new Error('a score out of range');
writeFileSync(new URL('../public/credit-score.bin', import.meta.url), Buffer.from(out.buffer));
// The same cut to tenths, as LiveRatings hands it to unions' rating rules (public/scores.bin is the older table).
writeFileSync(new URL('../public/scores-live.bin', import.meta.url), Buffer.from(Uint16Array.from(out, (v) => Math.floor(v / 1000)).buffer));
console.log('CreditScore', score, '· #1', out[0], '· #9', out[8]);
