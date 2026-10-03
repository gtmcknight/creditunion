#!/usr/bin/env node
// A copy of mainnet on your machine: the live Credits, factory, unions, Statements and burn contract, as they are
// right now, with anvil's test accounts funded. Point the site or the mirror at it and click through anything
// (join, burn, bid, settle) without spending real ETH. It leaves the chain running until Ctrl-C.
//   node scripts/fork-chain.mjs                     (from web/; needs anvil and MAINNET_RPC in contracts/.env)
//   node scripts/fork-chain.mjs --credits 80        also hand the test wallet 80 real Credits from their holders
//   node scripts/fork-chain.mjs --warp 24           move the clock 24 hours on (auctions end, burn hours run out)
// Env: ANVIL_PORT (8549) MIRROR (the mirror's URL, default http://localhost:5310/).
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createPublicClient, encodeFunctionData, formatEther, http } from 'viem';
import { batchAbi, creditsAbi, factoryAbi } from '../src/app/abi.ts';

const { values: opt } = parseArgs({ options: { credits: { type: 'string', default: '0' }, warp: { type: 'string', default: '0' } } });
const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
const CONTRACTS = join(WEB, '..', 'contracts');
const PORT = Number(process.env.ANVIL_PORT ?? 8549);
const RPC = `http://127.0.0.1:${PORT}`;
const MIRROR = process.env.MIRROR ?? 'http://localhost:5310/';
const PATH = `${join(homedir(), '.foundry', 'bin')}:${process.env.PATH}`;
const strip = (s) => s.replace(/("(?:[^"\\]|\\.)*")|\/\/[^\n]*/g, (_, str) => str ?? '');
const { CREDITS, FACTORY } = JSON.parse(strip(readFileSync(join(WEB, 'wrangler.jsonc'), 'utf8'))).vars;
const MAINNET_RPC = readFileSync(join(CONTRACTS, '.env'), 'utf8').match(/^MAINNET_RPC=(.+)$/m)?.[1]?.trim();
// anvil's well-known accounts 0-2. The test wallet is account 2: import its key into a wallet to use the site.
const ACCOUNTS = [
  '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
  '0x70997970C51812dc3A010C7D01b50e0d17dc79C8',
  '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC',
];
const WALLET = ACCOUNTS[2];
const WALLET_KEY = '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a';
const PHASES = ['open', 'waiting', 'countdown', 'burnable', 'expired', 'burned'];
const STATES = ['open', 'full', 'expired', 'auction', 'settled'];

const log = (...a) => console.log('[fork]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rpc = async (method, params = []) => {
  const r = await (await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json();
  if (r.error) throw new Error(`${method}: ${r.error.message}`);
  return r.result;
};
const pub = createPublicClient({ transport: http(RPC, { timeout: 120_000 }) });
const read = (address, abi, functionName, args = []) => pub.readContract({ address, abi, functionName, args });
async function send(from, to, abi, functionName, args = []) {
  const hash = await pub.request({ method: 'eth_sendTransaction', params: [{ from, to, data: encodeFunctionData({ abi, functionName, args }) }] });
  const r = await pub.waitForTransactionReceipt({ hash, timeout: 300_000 });
  if (r.status !== 'success') throw new Error(`${functionName} on ${to} reverted`);
}

async function listUnions() {
  const n = await read(FACTORY, factoryAbi, 'batchCount');
  const addrs = await read(FACTORY, factoryAbi, 'batches', [0n, n]);
  const now = Number((await pub.getBlock()).timestamp);
  const rows = await Promise.all(
    addrs.map(async (u) => {
      const [name, count, phase, state, end, high] = await Promise.all(
        ['name', 'count', 'phase', 'state', 'auctionEnd', 'highBid'].map((f) => read(u, batchAbi, f).catch(() => undefined)),
      );
      return { u, name: String(name).slice(0, 28), count: Number(count), phase: PHASES[phase] ?? '?', state: STATES[state] ?? '?', end: Number(end ?? 0), high };
    }),
  );
  // Open unions are most of the list: a count and the fullest few. Everything past open gets a line.
  const open = rows.filter((r) => r.state === 'open').sort((a, b) => b.count - a.count);
  console.log(`  ${open.length} open unions; fullest: ${open.slice(0, 4).map((r) => `${r.name} ${r.count}/80`).join(' · ')}`);
  for (const r of rows.filter((r) => r.state !== 'open')) {
    const left = r.state === 'auction' && r.end > now ? ` · ${Math.round((r.end - now) / 360) / 10}h left` : '';
    const bidTxt = r.high ? ` · high bid ${formatEther(r.high)} ETH` : '';
    console.log(`  ${r.u}  ${r.name.padEnd(28)} ${r.phase}/${r.state}${bidTxt}${left}`);
  }
}

// Hand the wallet real Credits: walk token ids, take each one an ordinary wallet holds (not a union or contract).
async function giveCredits(want) {
  let got = 0;
  for (let id = 1n; got < want && id <= 2000n; id++) {
    const owner = await read(CREDITS, creditsAbi, 'ownerOf', [id]).catch(() => null);
    if (!owner || owner.toLowerCase() === WALLET.toLowerCase()) continue;
    if (((await pub.getCode({ address: owner })) ?? '0x') !== '0x') continue;
    await rpc('anvil_setBalance', [owner, '0xDE0B6B3A7640000']);
    await send(owner, CREDITS, creditsAbi, 'transferFrom', [owner, WALLET, id]).then(() => got++, () => {});
  }
  log(`the test wallet holds ${got} more Credits`);
}

if (!MAINNET_RPC) throw new Error('contracts/.env needs MAINNET_RPC');
log('copying mainnet onto port', PORT);
const anvil = spawn('anvil', ['--fork-url', MAINNET_RPC, '--hardfork', 'osaka', '--enable-tx-gas-limit', '--auto-impersonate', '--port', String(PORT), '--silent'], { env: { ...process.env, PATH }, stdio: 'ignore' });
process.on('SIGINT', () => (anvil.kill(), process.exit(0)));
for (let i = 0; i < 120 && !(await rpc('eth_blockNumber').catch(() => null)); i++) await sleep(500);
for (const a of ACCOUNTS) {
  await rpc('anvil_setCode', [a, '0x']); // mainnet has sweeper code on anvil's well-known accounts
  await rpc('anvil_setBalance', [a, '0x3635C9ADC5DEA00000']); // 1,000 ETH
}
if (Number(opt.credits) > 0) await giveCredits(Number(opt.credits));
if (Number(opt.warp) > 0) {
  await rpc('evm_increaseTime', [Math.round(Number(opt.warp) * 3600)]);
  await rpc('evm_mine');
  log(`clock moved ${opt.warp}h on`);
}
log('unions on this copy:');
await listUnions();
console.log(`
  RPC        ${RPC}   (chain id 1, any address can send: anvil impersonates)
  Site       put RPC_URL=${RPC} in web/.dev.vars, then pnpm dev
  Wallet     add a network: RPC ${RPC}, chain id 1; import the test key ${WALLET_KEY} (${WALLET})
  Mirror     ${MIRROR}?rpc=${encodeURIComponent(RPC)}&preview=1   (look only, no wallet)
  Clock      cast rpc evm_increaseTime 3600 --rpc-url ${RPC} && cast rpc evm_mine --rpc-url ${RPC}
`);
log('the chain keeps running; Ctrl-C stops it');
await new Promise(() => {});
