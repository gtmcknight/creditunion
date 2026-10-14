#!/usr/bin/env node
// Converts every full token batch and pays its members, so /tokens never asks anyone to press anything.
// Each full batch locks the moment it fills (its adapter states no notice), and is rated (TokenAdapter.rate) and burned
// (Batch.assemble, the Statement surrendered in its own pocket) back to back: the burn goes out right behind the rating,
// on the next nonce, so both land in the same block when they can. Then everyone is paid (distribute, or distributeNext
// in parts when one call won't fit), but only once the token's transfers open (its transfersOpenBlock, when it has one):
// until then converted batches wait, and are paid in the first pass after. A batch whose burn hour ran out counts down
// again (restartCountdown). Converted batches still owing get paid out too.
// Every transaction is simulated first and only sent if it would succeed, except a burn sent right behind its rating
// (it can't be simulated until the rating lands; it gets the cap as its gas limit and is charged only what it uses). Each batch is on its own: one that fails is
// left alone for 5 minutes and the rest carry on; one whose only unpaid members can't receive is left for an hour
// (they claim on the page). Nothing is sent while the base fee is over --max-gwei.
// It only spends gas where we make money: a batch converts when our fee on it is worth at least --margin times the gas
// (rate + burn) at that moment, and a member is paid out by us only when our fee on their share is worth --margin times
// that payout; everyone else claims on the page. BALANCE is valued at the pool's price once it trades (--pool), else
// at --price (ETH per 1,000). A batch that isn't worth it yet waits for cheaper gas (or anyone can convert it).
// Anyone can do all of this; this is us doing it, from a hot wallet that only pays gas.
//   node scripts/convert-tokens.mjs                 one pass, then exit
//   node scripts/convert-tokens.mjs --watch         every 12 s (a block) until Ctrl-C (launch day)
//   node scripts/convert-tokens.mjs --dry           say what it would send
//   node scripts/convert-tokens.mjs --max-gwei 20   send nothing while the base fee is above this (default 30)
//   node scripts/convert-tokens.mjs --margin 2      our fee must be worth at least this many times the gas (default 2)
//   node scripts/convert-tokens.mjs --price 0.05    BALANCE in ETH per 1,000 until the pool trades (default 0.05, the 2026-10-14 market)
//   node scripts/convert-tokens.mjs --pool 3000,60,0x0000…   the pool (fee, tick spacing, hooks): its live price
// Env: RPC (default MAINNET_RPC in contracts/.env), KEY (the gas wallet's private key; or FROM=<addr> on a fork,
// which sends unsigned through anvil), TOKEN_FACTORY, TOKEN_ADAPTER (default: web/.dev.vars, then wrangler.jsonc).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createPublicClient, createWalletClient, encodeFunctionData, http, zeroAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { mainnet } from 'viem/chains';
import { batchAbi, factoryAbi, tokenAdapterAbi } from '../src/app/abi.ts';
import { V4_QUOTER, ethPool, quoterAbi } from '../src/shared/v4swap.ts';

const { values: opt } = parseArgs({
  options: {
    watch: { type: 'boolean', default: false },
    dry: { type: 'boolean', default: false },
    'max-gwei': { type: 'string', default: '30' },
    margin: { type: 'string', default: '2' },
    price: { type: 'string', default: '0.05' },
    pool: { type: 'string', default: '' },
  },
});
const MARGIN = Number(opt.margin);
const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => {
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return '';
  }
};
const vars = Object.fromEntries([...read(join(WEB, '.dev.vars')).matchAll(/^(\w+)=(.*)$/gm)].map((m) => [m[1], m[2].trim()]));
const strip = (s) => s.replace(/("(?:[^"\\]|\\.)*")|\/\/[^\n]*/g, (_, str) => str ?? '');
const wr = JSON.parse(strip(read(join(WEB, 'wrangler.jsonc')) || '{}')).vars ?? {};
const env = (k) => process.env[k] ?? vars[k] ?? wr[k];
const RPC = process.env.RPC ?? read(join(WEB, '..', 'contracts', '.env')).match(/^MAINNET_RPC=(.+)$/m)?.[1]?.trim();
const FACTORY = env('TOKEN_FACTORY');
const ADAPTER = env('TOKEN_ADAPTER');
if (!RPC || !FACTORY || !ADAPTER) throw new Error('needs RPC, TOKEN_FACTORY and TOKEN_ADAPTER');

const pub = createPublicClient({ chain: mainnet, transport: http(RPC, { timeout: 300_000 }) });
const account = process.env.KEY ? privateKeyToAccount(process.env.KEY) : null;
const from = account?.address ?? process.env.FROM;
if (!from && !opt.dry) throw new Error('needs KEY (or FROM on a fork)');
const wallet = account ? createWalletClient({ chain: mainnet, account, transport: http(RPC) }) : null;
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const PHASES = ['Open', 'Waiting', 'Countdown', 'Burnable', 'Expired', 'Assembled'];

// ---------------------------------------------------------------- what's worth our gas
/// Every Credit's score in ten-thousandths of a point (public/credit-score.bin, #1 first): a batch converts into
/// exactly the sum of its 80, one BALANCE per point.
const SCORES = (() => {
  const b = readFileSync(join(WEB, 'public', 'credit-score.bin'));
  return new Uint32Array(b.buffer, b.byteOffset, b.length / 4);
})();
const BURN_GAS = 15_000_000n; // a burn can't be estimated before its rating lands: the heaviest real sheet is ~14.5M
const PUSH_GAS = 360_000n; // paying one new holder of the real token (its artwork and colors), measured ~345k
/// What we'd pay per unit of gas right now: the base fee plus a normal tip.
async function gasPrice() {
  const [block, fees] = await Promise.all([pub.getBlock(), pub.estimateFeesPerGas()]);
  return (block.baseFeePerGas ?? 0n) + (fees.maxPriorityFeePerGas ?? 0n);
}
let tokenInfo;
async function token() {
  if (!tokenInfo) {
    const address = await pub.readContract({ address: ADAPTER, abi: tokenAdapterAbi, functionName: 'token' });
    const decimals = await pub.readContract({ address, abi: [{ type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] }], functionName: 'decimals' }).then(Number, () => 4);
    tokenInfo = { address, decimals };
  }
  return tokenInfo;
}
/// BALANCE in ETH per whole token: the pool's price for selling 1,000 once it quotes, else --price.
async function priceEth() {
  if (opt.pool) {
    const [fee, tickSpacing, hooks] = opt.pool.split(',');
    const t = await token();
    try {
      const { result } = await pub.simulateContract({
        address: V4_QUOTER, abi: quoterAbi, functionName: 'quoteExactInputSingle',
        args: [{ poolKey: ethPool(t.address, { fee: Number(fee), tickSpacing: Number(tickSpacing), hooks }), zeroForOne: false, exactAmount: 1000n * 10n ** BigInt(t.decimals), hookData: '0x' }],
      });
      return Number(result[0]) / 1e18 / 1000;
    } catch {}
  }
  return Number(opt.price) / 1000;
}
const eth = (x) => `${x.toFixed(4)} ETH`;
/// Whether converting batch `u` now earns at least MARGIN times its gas: our fee on what it converts into, against the
/// rating (unless already rated) and the burn at today's gas.
async function worthConverting(u) {
  const [ids, bps, rated, gp, price] = await Promise.all([
    pub.readContract({ address: u, abi: batchAbi, functionName: 'ids' }),
    pub.readContract({ address: u, abi: batchAbi, functionName: 'protocolFeeBps' }),
    pub.readContract({ address: ADAPTER, abi: tokenAdapterAbi, functionName: 'rated', args: [u] }),
    gasPrice(),
    priceEth(),
  ]);
  const points = ids.reduce((a, id) => a + SCORES[Number(id) - 1], 0) / 1e4;
  const fee = points * (Number(bps) / 1e4) * price;
  const rateGas = rated ? 0n : await pub.estimateGas({ account: from, to: ADAPTER, data: encodeFunctionData({ abi: tokenAdapterAbi, functionName: 'rate', args: [u] }) });
  const cost = Number((rateGas + BURN_GAS) * gp) / 1e18;
  return { ok: fee >= MARGIN * cost, line: `our fee ${eth(fee)} vs gas ${eth(cost)} (${(fee / cost).toFixed(1)}×, need ${MARGIN}×)` };
}

const CAP = 16_700_000n; // under the 16,777,216 per-transaction cap
/// Simulated, then sent with its estimate plus a margin (never past the cap). A transaction that would revert isn't sent.
async function tx(to, abi, functionName, args = []) {
  const data = encodeFunctionData({ abi, functionName, args });
  const est = await pub.estimateGas({ account: from, to, data });
  const gas = (est * 115n) / 100n > CAP ? CAP : (est * 115n) / 100n;
  log(`  ${functionName} ${to} (${est} gas)`);
  if (opt.dry) return;
  const hash = wallet
    ? await wallet.sendTransaction({ to, data, gas })
    : await pub.request({ method: 'eth_sendTransaction', params: [{ from, to, data, gas: `0x${gas.toString(16)}` }] });
  const r = await pub.waitForTransactionReceipt({ hash, timeout: 600_000 });
  if (r.status !== 'success') throw new Error(`${functionName} reverted (${hash})`);
  log(`    ok, ${r.gasUsed} gas`);
}

/// Sent without a simulation, at `nonce`: the burn that rides right behind its rating. Returns the hash.
async function sendAt(to, data, gas, nonce, label) {
  log(`  ${label} ${to} (nonce ${nonce}, up to ${gas} gas)`);
  if (opt.dry) return null;
  return wallet
    ? wallet.sendTransaction({ to, data, gas, nonce })
    : pub.request({ method: 'eth_sendTransaction', params: [{ from, to, data, gas: `0x${gas.toString(16)}`, nonce: `0x${nonce.toString(16)}` }] });
}

/// Rated and burned back to back: the rating simulated and sent, the burn right behind it on the next nonce (it can't be
/// simulated until the rating lands), so both can land in the same block. Already rated: just the burn, simulated.
async function convert(u) {
  if (await pub.readContract({ address: ADAPTER, abi: tokenAdapterAbi, functionName: 'rated', args: [u] })) return tx(u, batchAbi, 'assemble');
  const rateData = encodeFunctionData({ abi: tokenAdapterAbi, functionName: 'rate', args: [u] });
  const est = await pub.estimateGas({ account: from, to: ADAPTER, data: rateData });
  const nonce = await pub.getTransactionCount({ address: from, blockTag: 'pending' });
  const h1 = await sendAt(ADAPTER, rateData, (est * 115n) / 100n > CAP ? CAP : (est * 115n) / 100n, nonce, 'rate');
  const h2 = await sendAt(u, encodeFunctionData({ abi: batchAbi, functionName: 'assemble' }), CAP, nonce + 1, 'assemble');
  if (opt.dry) return;
  const [r1, r2] = await Promise.all([h1, h2].map((hash) => pub.waitForTransactionReceipt({ hash, timeout: 600_000 })));
  if (r1.status !== 'success' || r2.status !== 'success') throw new Error(`rate ${r1.status}, assemble ${r2.status} (${h2})`);
  log(`    ok: rate ${r1.gasUsed} gas, burn ${r2.gasUsed} gas, ${r1.blockNumber === r2.blockNumber ? 'same block' : `blocks ${r1.blockNumber} and ${r2.blockNumber}`}`);
}

/// The block the token's transfers open at (0 when it has no lock): until then nothing can be paid out.
let opensAt;
async function transfersOpen() {
  if (opensAt === undefined) {
    const token = await pub.readContract({ address: ADAPTER, abi: tokenAdapterAbi, functionName: 'token' });
    const lock = [{ type: 'function', name: 'transfersOpenBlock', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint64' }] }];
    opensAt = await pub.readContract({ address: token, abi: lock, functionName: 'transfersOpenBlock' }).then(BigInt, () => 0n);
    if (opensAt) log(`the token's transfers open at block ${opensAt}: payouts wait for it`);
  }
  return opensAt === 0n || (await pub.getBlockNumber()) >= opensAt;
}

/// A converted batch's members still owed, the ones whose payout is worth our gas (our fee on their share is at least
/// MARGIN times paying them), and whether our fees are still to collect.
async function owedOf(u) {
  const c = await pub.readContract({ address: ADAPTER, abi: tokenAdapterAbi, functionName: 'conversionOf', args: [u] });
  if (c[1] === 0n) return null;
  const members = await pub.readContract({ address: ADAPTER, abi: tokenAdapterAbi, functionName: 'membersOf', args: [u] });
  const [owed, put, [, total], gp, price, t] = await Promise.all([
    Promise.all(members.map((m) => pub.readContract({ address: ADAPTER, abi: tokenAdapterAbi, functionName: 'claimable', args: [u, m] }))),
    Promise.all(members.map((m) => pub.readContract({ address: ADAPTER, abi: tokenAdapterAbi, functionName: 'putIn', args: [u, m] }))),
    pub.readContract({ address: ADAPTER, abi: tokenAdapterAbi, functionName: 'ratingOf', args: [u, members[0]] }),
    gasPrice(),
    priceEth(),
    token(),
  ]);
  const push = Number(PUSH_GAS * gp) / 1e18;
  const ours = (i) => (Number(c[3]) * Number(put[i])) / Number(total) / 10 ** t.decimals * price; // our fee on their share
  const owing = members.filter((_, i) => owed[i] > 0n);
  const worth = members.filter((_, i) => owed[i] > 0n && ours(i) >= MARGIN * push);
  return { owing, worth, fees: !c[5] || !c[6] };
}

/// Pays out where it's worth our gas: our fees, and the members whose share pays for their own payout, 30 to a call
/// (paying a new holder of the real token costs ~350k gas, its artwork and colors). Everyone else claims on the page.
async function payOut(u) {
  const o = await owedOf(u);
  if (!o || (!o.worth.length && !o.fees)) return o ? `${o.owing.length} left to claim` : 'nothing owed';
  for (let i = 0; i < Math.max(o.worth.length, 1); i += 30) await tx(ADAPTER, tokenAdapterAbi, 'distributeTo', [u, o.worth.slice(i, i + 30)]);
  return `${o.worth.length} paid, ${o.owing.length - o.worth.length} left to claim (not worth our gas)`;
}

/// Batches left alone until a time (ms): after a failure, or when nobody left can be paid.
const resting = new Map();

async function pass() {
  const assembler = await pub.readContract({ address: FACTORY, abi: factoryAbi, functionName: 'assembler' });
  if (assembler === zeroAddress) return log('the adapter is not active yet: nothing converts');
  const base = (await pub.getBlock()).baseFeePerGas ?? 0n;
  if (base > BigInt(Math.round(Number(opt['max-gwei']) * 1e9))) return log(`base fee ${Number(base) / 1e9} gwei is over --max-gwei ${opt['max-gwei']}: waiting`);
  const n = await pub.readContract({ address: FACTORY, abi: factoryAbi, functionName: 'batchCount' });
  const all = n ? await pub.readContract({ address: FACTORY, abi: factoryAbi, functionName: 'batches', args: [0n, n] }) : [];
  const now = Number((await pub.getBlock()).timestamp);
  const open = await transfersOpen();
  // Oldest first: the batch that's waited longest goes first.
  for (const u of [...all].reverse()) {
    if ((resting.get(u) ?? 0) > Date.now()) continue;
    try {
      const [state, phase, lockAt] = await Promise.all(['state', 'phase', 'lockAt'].map((f) => pub.readContract({ address: u, abi: batchAbi, functionName: f })));
      const p = PHASES[phase];
      if (p === 'Assembled') {
        if (!open) continue; // its tokens wait in its pocket until the token's transfers open
        log(`${u}: ${await payOut(u)}`);
        resting.set(u, Date.now() + 1_800_000); // looked again in half an hour: cheaper gas may make more worth paying
        continue;
      }
      if (state !== 1) continue; // only full batches convert
      if (p === 'Countdown') log(`${u} locks in ${Number(lockAt) - now} s`);
      if (p === 'Expired') {
        log(`${u} missed its hour: counting down again`);
        await tx(u, batchAbi, 'restartCountdown');
      }
      if (p === 'Burnable') {
        const w = await worthConverting(u);
        if (!w.ok) {
          log(`${u} waiting: ${w.line}`);
          continue;
        }
        log(`${u} converting: ${w.line}`);
        await convert(u);
        if (open) log(`  ${await payOut(u)}`);
        else log(`  converted; pays out at block ${opensAt}`);
      }
    } catch (e) {
      log(`${u} failed, leaving it 5 minutes:`, e.shortMessage ?? e.message);
      resting.set(u, Date.now() + 300_000);
    }
  }
}

do {
  await pass().catch((e) => log('pass failed:', e.shortMessage ?? e.message));
  if (opt.watch) await new Promise((r) => setTimeout(r, 12_000));
} while (opt.watch);
