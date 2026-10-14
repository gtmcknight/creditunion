#!/usr/bin/env node
// The converter keeper's money rules on a local copy of mainnet: one full batch (two members with 40 and 39 Credits,
// one with a single low-rated Credit), a test vault paying a realistic 35,000 tokens per Statement, BALANCE valued at
// 0.02 ETH per 1,000, our fee 10%. At 5 gwei the keeper must wait (the fee isn't worth 2× the gas); at 0.3 gwei it
// converts, pays the two big members and leaves the single-Credit member to claim (paying them isn't worth our gas).
//   node scripts/keeper-fork.mjs      (from web/; needs anvil, forge, MAINNET_RPC in env or creditunion/contracts/.env)
import { execFileSync, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, encodeFunctionData, erc20Abi, http, parseEther } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { mainnet } from 'viem/chains';
import { creditsAbi, factoryAbi, tokenAdapterAbi } from '../src/app/abi.ts';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
const CONTRACTS = join(WEB, '..', 'contracts');
const PORT = 8573;
const RPC = `http://127.0.0.1:${PORT}`;
const PATH = `${join(homedir(), '.foundry', 'bin')}:${process.env.PATH}`;
const MAINNET_RPC = process.env.MAINNET_RPC ?? readFileSync(join(homedir(), 'Documents', 'GitHub', 'creditunion', 'contracts', '.env'), 'utf8').match(/^MAINNET_RPC=(.+)$/m)?.[1]?.trim();
const CREDITS = '0x97630aA70AB14ed9883B41dAfccBc11349723043';
const ADMIN = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const ANY = { palettes: 0, prints: 0, weights: 0, eights: 0, paidFrom: 0n, paidTo: 0n, idFrom: 0n, idTo: 0n, minScore: 0, maxScore: 0, layout0: 0n, layout1: 0n, bitsFrom: 0, bitsTo: 0, layoutTrait: 0 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rpc = async (method, params = []) => {
  const r = await (await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json();
  if (r.error) throw new Error(`${method}: ${r.error.message}`);
  return r.result;
};
let failed = false;
const check = (ok, what) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failed = true;
};

const anvil = spawn('anvil', ['--fork-url', MAINNET_RPC, '--hardfork', 'osaka', '--enable-tx-gas-limit', '--auto-impersonate', '--port', String(PORT), '--silent'], { env: { ...process.env, PATH }, stdio: 'ignore' });
try {
  for (let i = 0; !(await rpc('eth_blockNumber').catch(() => null)); i++) {
    if (i > 120) throw new Error('anvil did not start');
    await sleep(500);
  }
  await rpc('anvil_setCode', [ADMIN, '0x']);
  await rpc('anvil_setBalance', [ADMIN, '0x3635C9ADC5DEA00000']);
  const pub = createPublicClient({ chain: mainnet, transport: http(RPC, { timeout: 300_000 }) });
  const send = async (from, to, data) => {
    const r = await pub.waitForTransactionReceipt({ hash: await rpc('eth_sendTransaction', [{ from, to, data }]) });
    if (r.status !== 'success') throw new Error(`tx to ${to} reverted`);
  };
  const forge = (env) => {
    const out = execFileSync('forge', ['script', 'script/DeployTokenUnions.s.sol', '--rpc-url', RPC, '--unlocked', '--sender', ADMIN, '--broadcast', '--slow'], { cwd: CONTRACTS, env: { ...process.env, PATH, ...env }, encoding: 'utf8' });
    return Object.fromEntries([...out.matchAll(/^\s*(TOKEN_\w+|VAULT)\s+(0x[0-9a-fA-F]{40})/gm)].map((m) => [m[1], m[2]]));
  };
  const v = forge({ SETTER: ADMIN, FEE_RECIPIENT: ADMIN });
  Object.assign(v, forge({ FACTORY: v.TOKEN_FACTORY, FORMATS: v.TOKEN_FORMATS, MOCK_VAULT: 'true', FORK: 'true', PER_STATEMENT: parseEther('35000').toString() }));
  await rpc('evm_increaseTime', [1800]);
  await rpc('evm_mine');
  await send(ADMIN, v.TOKEN_FACTORY, encodeFunctionData({ abi: factoryAbi, functionName: 'activateAssembler' }));
  console.log('token unions on the copy, fee', Number(await pub.readContract({ address: v.TOKEN_FACTORY, abi: factoryAbi, functionName: 'protocolFeeBps' })) / 100, '%');

  // 80 real Credits from ordinary holders: 40 to A, 39 to B, the lowest-rated one to C.
  const scores = (() => { const b = readFileSync(join(WEB, 'public', 'credit-score.bin')); return new Uint32Array(b.buffer, b.byteOffset, b.length / 4); })();
  const got = [];
  for (let id = 1n; got.length < 80 && id < 4000n; id++) {
    const owner = await pub.readContract({ address: CREDITS, abi: creditsAbi, functionName: 'ownerOf', args: [id] }).catch(() => null);
    if (!owner || ((await pub.getCode({ address: owner })) ?? '0x') !== '0x') continue;
    got.push({ id, owner });
  }
  got.sort((a, b) => scores[Number(b.id) - 1] - scores[Number(a.id) - 1]); // C gets the last, lowest-rated
  const [A, B, C] = [0, 1, 2].map(() => privateKeyToAccount(generatePrivateKey()).address);
  const plan = [...got.slice(0, 40).map((x) => ({ ...x, to: A })), ...got.slice(40, 79).map((x) => ({ ...x, to: B })), { ...got[79], to: C }];
  for (const x of plan) {
    await rpc('anvil_setBalance', [x.owner, '0xDE0B6B3A7640000']);
    await send(x.owner, CREDITS, encodeFunctionData({ abi: creditsAbi, functionName: 'transferFrom', args: [x.owner, x.to, x.id] }));
  }
  for (const m of [A, B, C]) {
    await rpc('anvil_setBalance', [m, '0xDE0B6B3A7640000']);
    await send(m, CREDITS, encodeFunctionData({ abi: creditsAbi, functionName: 'setApprovalForAll', args: [v.TOKEN_FACTORY, true] }));
  }
  const ids = (who) => plan.filter((x) => x.to === who).map((x) => x.id);
  const [p, c, t] = await Promise.all(['protocolFeeBps', 'creatorFeeBps', 'ratings'].map((f) => pub.readContract({ address: v.TOKEN_FACTORY, abi: factoryAbi, functionName: f })));
  await send(A, v.TOKEN_FACTORY, encodeFunctionData({ abi: factoryAbi, functionName: 'create', args: ['Mixed 1', ANY, [], 0n, 0, 0, 90n * 86400n, ids(A), p, c, t] }));
  const [u] = await pub.readContract({ address: v.TOKEN_FACTORY, abi: factoryAbi, functionName: 'batches', args: [0n, 1n] });
  await send(B, v.TOKEN_FACTORY, encodeFunctionData({ abi: factoryAbi, functionName: 'deposit', args: [u, ids(B)] }));
  await send(C, v.TOKEN_FACTORY, encodeFunctionData({ abi: factoryAbi, functionName: 'deposit', args: [u, ids(C)] }));
  console.log(`batch ${u} full: A 40, B 39, C 1 (rated ${scores[Number(got[79].id) - 1] / 1e4})`);

  const keeper = async (gwei) => {
    await rpc('anvil_setNextBlockBaseFeePerGas', [`0x${Math.round(gwei * 1e9).toString(16)}`]);
    return rpc('evm_mine').then(() =>
      execFileSync('node', ['scripts/convert-tokens.mjs', '--margin', '2', '--price', '0.02'], { cwd: WEB, env: { ...process.env, RPC, FROM: ADMIN, TOKEN_FACTORY: v.TOKEN_FACTORY, TOKEN_ADAPTER: v.TOKEN_ADAPTER }, encoding: 'utf8' }),
    );
  };
  const converted = async () => (await pub.readContract({ address: v.TOKEN_ADAPTER, abi: tokenAdapterAbi, functionName: 'conversionOf', args: [u] }))[1] > 0n;

  const hot = await keeper(5); // under --max-gwei, so the margin rule decides
  console.log(hot.trim().split('\n').map((l) => `  [5 gwei] ${l}`).join('\n'));
  check(!(await converted()) && /waiting/.test(hot), 'at 5 gwei it waits: the fee is not worth 2× the gas');

  const calm = await keeper(0.3);
  console.log(calm.trim().split('\n').map((l) => `  [0.3 gwei] ${l}`).join('\n'));
  check(await converted(), 'at 0.3 gwei it converts');
  const bal = (who) => pub.readContract({ address: v.VAULT, abi: erc20Abi, functionName: 'balanceOf', args: [who] });
  check((await bal(A)) > 0n && (await bal(B)) > 0n, 'the two big members were paid');
  check((await bal(C)) === 0n && (await pub.readContract({ address: v.TOKEN_ADAPTER, abi: tokenAdapterAbi, functionName: 'claimable', args: [u, C] })) > 0n, 'the single-Credit member was left to claim (not worth our gas)');
  check((await bal(ADMIN)) > 0n, 'our fee arrived');
} catch (e) {
  failed = true;
  console.log('FAIL', e.shortMessage ?? e.message);
} finally {
  anvil.kill();
  console.log(failed ? 'KEEPER REHEARSAL FAILED' : 'KEEPER REHEARSAL PASSED');
  process.exitCode = failed ? 1 : 0;
}
