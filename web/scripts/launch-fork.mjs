#!/usr/bin/env node
// Launch day on a local copy of mainnet, in the order it happens, against the BALANCE contract itself: the live
// token factory, our adapter deployed against the token, the Safe's proposal, and the converter keeper
// (convert-tokens.mjs) run between steps. It must hold off while the adapter's 30 minutes run, while the token's
// renderer isn't registered and while its creator hasn't retired the launch supply; then activate the adapter,
// convert a full batch the moment it's worth it, hold the payouts until the token's transfers open, and pay out after.
//   node scripts/launch-fork.mjs                    the token built from contracts/test/fixtures/balance-release.json
//   VAULT=0x… node scripts/launch-fork.mjs          the deployed token (launch day): steps the launch already did are skipped
//   KEEPER_KEY=0x… node scripts/launch-fork.mjs     the keeper signs with a key, as on launch day (funded on the copy only)
//   KEEPER_HOST=user@host:dir node scripts/launch-fork.mjs   the keeper runs on that machine, from its copy of web/ at
//                                                   dir, reaching this copy through an ssh tunnel
// From web/; needs anvil, forge, MAINNET_RPC in env or creditunion/contracts/.env.
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, encodeAbiParameters, encodeFunctionData, erc20Abi, http, parseAbi } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { mainnet } from 'viem/chains';
import { creditsAbi, factoryAbi, tokenAdapterAbi } from '../src/app/abi.ts';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
const CONTRACTS = join(WEB, '..', 'contracts');
const PORT = 8574;
const RPC = `http://127.0.0.1:${PORT}`;
const PATH = `${join(homedir(), '.foundry', 'bin')}:${process.env.PATH}`;
const MAINNET_RPC = process.env.MAINNET_RPC ?? readFileSync(join(homedir(), 'Documents', 'GitHub', 'creditunion', 'contracts', '.env'), 'utf8').match(/^MAINNET_RPC=(.+)$/m)?.[1]?.trim();
const strip = (s) => s.replace(/("(?:[^"\\]|\\.)*")|\/\/[^\n]*/g, (_, str) => str ?? '');
const vars = JSON.parse(strip(readFileSync(join(WEB, 'wrangler.jsonc'), 'utf8'))).vars;
const FACTORY = vars.TOKEN_FACTORY, FORMATS = vars.TOKEN_FORMATS;
const CREDITS = '0x97630aA70AB14ed9883B41dAfccBc11349723043';
const STATEMENTS = '0x75Edd94b7e49b3bD5C8047b91F165A5e265a069b';
const FUNDER = '0xc8f8e2F59Dd95fF67c3d39109ecA2e2A017D4c8a'; // visualizevalue.eth, the launch's funder
const ADMIN = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'; // deploys our adapter and runs the keeper, on the copy only
const FIXTURE = join(CONTRACTS, 'test', 'fixtures', 'balance-release.json');
const ANY = { palettes: 0, prints: 0, weights: 0, eights: 0, paidFrom: 0n, paidTo: 0n, idFrom: 0n, idTo: 0n, minScore: 0, maxScore: 0, layout0: 0n, layout1: 0n, bitsFrom: 0, bitsTo: 0, layoutTrait: 0 };
const statementsAbi = parseAbi([
  'function owner() view returns (address)',
  'function ownerOf(uint256) view returns (address)',
  'function formatCount() view returns (uint256)',
  'function addFormat(address renderer, string name) returns (uint8)',
  'function approve(address to, uint256 id)',
  'function transferFrom(address from, address to, uint256 id)',
]);
const tokenAbi = parseAbi([
  'function ready() view returns (bool)',
  'function renderer() view returns (address)',
  'function artwork() view returns (address)',
  'function withdrawnFormat() view returns (uint8)',
  'function auctionFunder() view returns (address)',
  'function launchRetirement() view returns (uint256)',
  'function totalRetired() view returns (uint256)',
  'function transfersOpenBlock() view returns (uint64)',
  'function quote(uint256) view returns (uint256)',
  'function withdraw(uint256, uint256) returns (uint256)',
  'function retireLaunchSupply()',
]);
const artworkAbi = parseAbi(['function tokenIdOf(address) view returns (uint256)']);
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
if (!process.env.VAULT && !existsSync(FIXTURE)) throw new Error(`needs VAULT=<deployed token> or ${FIXTURE}`);

const anvil = spawn('anvil', ['--fork-url', MAINNET_RPC, '--hardfork', 'osaka', '--enable-tx-gas-limit', '--auto-impersonate', '--port', String(PORT), '--silent'], { env: { ...process.env, PATH }, stdio: 'ignore' });
const [HOST, DIR] = process.env.KEEPER_HOST?.split(':') ?? [];
const tunnel = HOST && spawn('ssh', ['-N', '-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes', '-R', `${PORT}:127.0.0.1:${PORT}`, HOST], { stdio: 'ignore' });
try {
  for (let i = 0; !(await rpc('eth_blockNumber').catch(() => null)); i++) {
    if (i > 120) throw new Error('anvil did not start');
    await sleep(500);
  }
  await rpc('anvil_setCode', [ADMIN, '0x']);
  await rpc('anvil_setBalance', [ADMIN, '0x3635C9ADC5DEA00000']);
  const KEEPER = process.env.KEEPER_KEY ? privateKeyToAccount(process.env.KEEPER_KEY).address : null;
  if (KEEPER) await rpc('anvil_setBalance', [KEEPER, '0x8AC7230489E80000']);
  const pub = createPublicClient({ chain: mainnet, transport: http(RPC, { timeout: 300_000 }) });
  const send = async (from, to, data, value = 0n) => {
    await rpc('anvil_setBalance', [from, '0xDE0B6B3A7640000']).catch(() => {});
    const hash = await rpc('eth_sendTransaction', [{ from, to, data, value: `0x${value.toString(16)}` }]);
    const r = await pub.waitForTransactionReceipt({ hash });
    if (r.status !== 'success') throw new Error(`tx to ${to} reverted`);
    return r;
  };
  const read = (address, abi, functionName, args = []) => pub.readContract({ address, abi, functionName, args });
  const keeperEnv = (adapter) => ({ ...process.env, RPC, ...(KEEPER ? { KEY: process.env.KEEPER_KEY } : { FROM: ADMIN }), TOKEN_FACTORY: FACTORY, TOKEN_ADAPTER: adapter });
  const keeper = async (adapter, label, gwei = 0.3) => {
    await rpc('anvil_setNextBlockBaseFeePerGas', [`0x${Math.round(gwei * 1e9).toString(16)}`]);
    await rpc('evm_mine');
    const args = ['scripts/convert-tokens.mjs', '--margin', '2', '--price', '0.05'];
    const env = keeperEnv(adapter);
    if (tunnel && tunnel.exitCode !== null) throw new Error(`the ssh tunnel to ${HOST} closed`);
    const out = HOST
      ? execFileSync('ssh', ['-o', 'BatchMode=yes', HOST, `cd ${DIR} && ${['RPC', 'KEY', 'FROM', 'TOKEN_FACTORY', 'TOKEN_ADAPTER'].filter((k) => env[k]).map((k) => `${k}=${env[k]}`).join(' ')} PATH=/usr/local/bin:/opt/homebrew/bin:$PATH node ${args.join(' ')}`], { encoding: 'utf8' })
      : execFileSync('node', args, { cwd: WEB, env, encoding: 'utf8' });
    console.log(out.trim().split('\n').map((l) => `  [${label}] ${l}`).join('\n'));
    return out;
  };

  // 1. The token: deployed by its creator (its renderer and wallet artwork come with it).
  let token = process.env.VAULT;
  if (!token) {
    const { bytecode } = JSON.parse(readFileSync(FIXTURE, 'utf8'));
    const opens = (await pub.getBlockNumber()) + 1_200n; // the plan has about a day (7,200); the copy needn't wait that long
    const format = Number(await read(STATEMENTS, statementsAbi, 'formatCount'));
    const args = encodeAbiParameters(
      [{ type: 'address' }, { type: 'uint8' }, { type: 'uint64' }, { type: 'address' }, { type: 'address' }, { type: 'address' }],
      [STATEMENTS, format, opens, FUNDER, '0x000000000000000000000000000000000000a11c', '0x000000000000000000000000000000000000b0b1'],
    );
    const r = await pub.waitForTransactionReceipt({ hash: await rpc('eth_sendTransaction', [{ from: FUNDER, data: bytecode + args.slice(2), gas: '0xF42400' }]) });
    token = r.contractAddress;
    console.log(`token built from the fixture at ${token} (${r.gasUsed} gas), transfers open at block ${opens}`);
  } else console.log(`the deployed token ${token}`);

  // 2. Our adapter against it, proposed by the Safe.
  const out = execFileSync('forge', ['script', 'script/DeployTokenUnions.s.sol', '--rpc-url', RPC, '--unlocked', '--sender', ADMIN, '--broadcast', '--slow'], { cwd: CONTRACTS, env: { ...process.env, PATH, FACTORY, FORMATS, VAULT: token }, encoding: 'utf8' });
  const adapter = out.match(/TOKEN_ADAPTER\s+(0x[0-9a-fA-F]{40})/)?.[1];
  check(!!adapter, `adapter deployed against the token: ${adapter}`);
  const safe = await read(FACTORY, parseAbi(['function assemblerSetter() view returns (address)']), 'assemblerSetter');
  await send(safe, FACTORY, encodeFunctionData({ abi: factoryAbi, functionName: 'proposeAssembler', args: [adapter] }));
  check(/goes live in 30 min/.test(await keeper(adapter, 'proposed')), 'the keeper waits out the 30 minutes');
  await rpc('evm_increaseTime', [1800]);

  // 3. The creator registers the renderer and retires the launch supply; until both, the keeper holds off.
  if (!(await read(token, tokenAbi, 'ready'))) {
    check(/renderer isn't registered/.test(await keeper(adapter, 'unregistered')), 'it doesn\'t activate the adapter before the renderer is registered');
    const owner = await read(STATEMENTS, statementsAbi, 'owner');
    check(Number(await read(STATEMENTS, statementsAbi, 'formatCount')) === Number(await read(token, tokenAbi, 'withdrawnFormat')), 'the Balance format lands in the slot the token expects');
    await send(owner, STATEMENTS, encodeFunctionData({ abi: statementsAbi, functionName: 'addFormat', args: [await read(token, tokenAbi, 'renderer'), 'Balance'] }));
  }
  if ((await read(token, tokenAbi, 'totalRetired')) < (await read(token, tokenAbi, 'launchRetirement'))) {
    check(/hasn't retired/.test(await keeper(adapter, 'unretired')), 'it doesn\'t activate the adapter before the launch supply is retired');
    const funder = await read(token, tokenAbi, 'auctionFunder');
    let sid = 1n;
    for (let owner; sid < 400n; sid++) {
      owner = await read(STATEMENTS, statementsAbi, 'ownerOf', [sid]).catch(() => null);
      if (owner && ((await pub.getCode({ address: owner })) ?? '0x') === '0x') {
        if (owner.toLowerCase() !== funder.toLowerCase()) await send(owner, STATEMENTS, encodeFunctionData({ abi: statementsAbi, functionName: 'transferFrom', args: [owner, funder, sid] }));
        break;
      }
    }
    await send(funder, STATEMENTS, encodeFunctionData({ abi: statementsAbi, functionName: 'approve', args: [token, sid] }));
    await send(funder, token, encodeFunctionData({ abi: tokenAbi, functionName: 'withdraw', args: [sid, await read(token, tokenAbi, 'quote', [sid])] }));
    await send(funder, token, encodeFunctionData({ abi: tokenAbi, functionName: 'retireLaunchSupply' }));
  }
  await keeper(adapter, 'ready');
  check((await read(FACTORY, factoryAbi, 'assembler')).toLowerCase() === adapter.toLowerCase(), 'the keeper activated the adapter once the token was ready');

  // 4. A batch fills: 80 real Credits, 40 from A, 39 from B, the lowest-rated one from C.
  const scores = (() => { const b = readFileSync(join(WEB, 'public', 'credit-score.bin')); return new Uint32Array(b.buffer, b.byteOffset, b.length / 4); })();
  const got = [];
  for (let id = 1n; got.length < 80 && id < 4000n; id++) {
    const owner = await read(CREDITS, creditsAbi, 'ownerOf', [id]).catch(() => null);
    if (!owner || ((await pub.getCode({ address: owner })) ?? '0x') !== '0x') continue;
    got.push({ id, owner });
  }
  got.sort((a, b) => scores[Number(b.id) - 1] - scores[Number(a.id) - 1]);
  const [A, B, C] = [0, 1, 2].map(() => privateKeyToAccount(generatePrivateKey()).address);
  const plan = [...got.slice(0, 40).map((x) => ({ ...x, to: A })), ...got.slice(40, 79).map((x) => ({ ...x, to: B })), { ...got[79], to: C }];
  for (const x of plan) await send(x.owner, CREDITS, encodeFunctionData({ abi: creditsAbi, functionName: 'transferFrom', args: [x.owner, x.to, x.id] }));
  for (const m of [A, B, C]) await send(m, CREDITS, encodeFunctionData({ abi: creditsAbi, functionName: 'setApprovalForAll', args: [FACTORY, true] }));
  const ids = (who) => plan.filter((x) => x.to === who).map((x) => x.id);
  const [p, c, t] = await Promise.all(['protocolFeeBps', 'creatorFeeBps', 'ratings'].map((f) => read(FACTORY, factoryAbi, f)));
  await send(A, FACTORY, encodeFunctionData({ abi: factoryAbi, functionName: 'create', args: ['Launch rehearsal', ANY, [], 0n, 0, 0, 90n * 86400n, ids(A), p, c, t] }));
  const n = await read(FACTORY, factoryAbi, 'batchCount');
  const [u] = await read(FACTORY, factoryAbi, 'batches', [0n, 1n]);
  await send(B, FACTORY, encodeFunctionData({ abi: factoryAbi, functionName: 'deposit', args: [u, ids(B)] }));
  await send(C, FACTORY, encodeFunctionData({ abi: factoryAbi, functionName: 'deposit', args: [u, ids(C)] }));
  console.log(`batch ${u} full (${n} batches on the factory): A 40, B 39, C 1`);

  // 5. It converts at once; the payouts wait for the token's transfers to open.
  const converted = async () => (await read(adapter, tokenAdapterAbi, 'conversionOf', [u]))[1] > 0n;
  const early = await keeper(adapter, 'full');
  check(await converted(), 'the full batch converted');
  const opens = await read(token, tokenAbi, 'transfersOpenBlock');
  check(/pays out at block/.test(early) && (await pub.getBlockNumber()) < opens, `before the opening block (${opens}) nobody is paid`);
  const bal = (who) => read(token, erc20Abi, 'balanceOf', [who]);
  check((await bal(A)) === 0n, 'A has nothing yet');

  // 6. Open: the keeper pays those worth our gas; the single low-rated Credit is left to claim.
  for (let now = await pub.getBlockNumber(); now < opens; now = await pub.getBlockNumber()) {
    const step = opens - now > 500n ? 500n : opens - now; // a few hundred at a time: one long mine times the call out
    await rpc('anvil_mine', [`0x${step.toString(16)}`]);
  }
  await keeper(adapter, 'open');
  check((await bal(A)) > 0n && (await bal(B)) > 0n, 'after the opening block A and B are paid');
  check((await bal(C)) === 0n && (await read(adapter, tokenAdapterAbi, 'claimable', [u, C])) > 0n, 'C is left to claim (not worth our gas)');
  const artwork = await read(token, tokenAbi, 'artwork');
  const [ia, ib] = await Promise.all([A, B].map((m) => read(artwork, artworkAbi, 'tokenIdOf', [m])));
  check(ia > 0n && ib > 0n && ia < 1_000_000n && ia !== ib, `each got a wallet artwork, numbered in order (Balance #${ia}, #${ib})`);
  check((await bal(await read(FACTORY, parseAbi(['function feeRecipient() view returns (address)']), 'feeRecipient'))) > 0n, 'our fee reached the Safe');
} catch (e) {
  failed = true;
  console.log('FAIL', e.shortMessage ?? e.message);
} finally {
  anvil.kill();
  if (tunnel) tunnel.kill();
  console.log(failed ? 'LAUNCH REHEARSAL FAILED' : 'LAUNCH REHEARSAL PASSED');
  process.exitCode = failed ? 1 : 0;
}
