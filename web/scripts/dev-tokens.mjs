#!/usr/bin/env node
// /tokens on your machine, for working on the page: a copy of mainnet with token unions (both stages, the adapter active),
// a test vault standing in for BALANCE (it is the token, as the real converter is) with an ETH pool on the real v4
// PoolManager, a Mixed batch 60 of 80 full, the keeper converting and paying out each batch the moment it fills, and the
// test wallet holding Credits and some of the token. The site runs with Vite (edits to src/app reload in the browser).
// Runs until Ctrl-C.
//   node scripts/dev-tokens.mjs        (from web/)   Env: MAINNET_RPC (or creditunion/contracts/.env), CREDITS (20)
// Then open http://127.0.0.1:5196/tokens. To send from the page, add a network to a wallet (RPC http://127.0.0.1:8549,
// chain id 1) and import anvil's test key 0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a.
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, encodeAbiParameters, encodeFunctionData, erc20Abi, http, keccak256, parseEther, parseUnits, toHex } from 'viem';
import { mainnet } from 'viem/chains';
import { batchAbi, creditsAbi, factoryAbi } from '../src/app/abi.ts';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
const CONTRACTS = join(WEB, '..', 'contracts');
const ARB = join(WEB, '..', '..', 'statement-arb');
const ANVIL_PORT = 8549;
const WEB_PORT = 5196;
const RPC = `http://127.0.0.1:${ANVIL_PORT}`;
const OUT = join(WEB, '.wrangler', 'dev-tokens');
const PATH = `${join(homedir(), '.foundry', 'bin')}:${process.env.PATH}`;
const MAIN = join(homedir(), 'Documents', 'GitHub', 'creditunion');
const MAINNET_RPC = process.env.MAINNET_RPC ?? readFileSync(join(MAIN, 'contracts', '.env'), 'utf8').match(/^MAINNET_RPC=(.+)$/m)?.[1]?.trim();
// The OpenSea key from the main checkout's .dev.vars, so Convert can buy Credits on the copy too (local file only).
const OPENSEA = (() => { try { return readFileSync(join(MAIN, 'web', '.dev.vars'), 'utf8').match(/^OPENSEA_API_KEY\s*=\s*"?([^"\n]+)"?/m)?.[1]; } catch { return undefined; } })();
const ACCOUNTS = ['0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266', '0x70997970C51812dc3A010C7d01b50e0d17dc79C8', '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC'];
const KEY1 = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const WALLET = ACCOUNTS[2];
const log = (...a) => console.log('[dev-tokens]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rpc = async (method, params = []) => {
  const r = await (await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json();
  if (r.error) throw new Error(`${method}: ${r.error.message}`);
  return r.result;
};
const procs = [];
const stop = () => {
  for (const p of procs) p.kill();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

mkdirSync(OUT, { recursive: true });
log('copying mainnet onto port', ANVIL_PORT);
procs.push(spawn('anvil', ['--fork-url', MAINNET_RPC, '--hardfork', 'osaka', '--enable-tx-gas-limit', '--auto-impersonate', '--port', String(ANVIL_PORT), '--silent'], { env: { ...process.env, PATH }, stdio: 'ignore' }));
for (let i = 0; !(await rpc('eth_blockNumber').catch(() => null)); i++) {
  if (i > 120) throw new Error('anvil did not start');
  await sleep(500);
}
for (const a of ACCOUNTS) {
  await rpc('anvil_setCode', [a, '0x']); // mainnet has sweeper code on anvil's well-known accounts
  await rpc('anvil_setBalance', [a, '0x3635C9ADC5DEA00000']);
}
const pub = createPublicClient({ chain: mainnet, transport: http(RPC, { timeout: 120_000 }) });
const send = async (from, to, data) => pub.waitForTransactionReceipt({ hash: await rpc('eth_sendTransaction', [{ from, to, data }]) });

// Token unions, both stages (fork-chain --tokens --vault): the adapter is active, so a full batch converts here. The test
// vault pays 35,000 per Statement, about a real one's rating.
const forge = (env) => {
  const out = execFileSync('forge', ['script', 'script/DeployTokenUnions.s.sol', '--rpc-url', RPC, '--unlocked', '--sender', ACCOUNTS[0], '--broadcast', '--slow'], { cwd: CONTRACTS, env: { ...process.env, PATH, ...env }, encoding: 'utf8' });
  return Object.fromEntries([...out.matchAll(/^\s*(TOKEN_\w+|VAULT)\s+(0x[0-9a-fA-F]{40})/gm)].map((m) => [m[1], m[2]]));
};
const tokenVars = forge({ SETTER: ACCOUNTS[0], FEE_RECIPIENT: ACCOUNTS[0] });
Object.assign(tokenVars, forge({ FACTORY: tokenVars.TOKEN_FACTORY, FORMATS: tokenVars.TOKEN_FORMATS, MOCK_VAULT: 'true', FORK: 'true', PER_STATEMENT: parseEther('35000').toString() }));
await rpc('evm_increaseTime', [1800]);
await rpc('evm_mine');
await send(ACCOUNTS[0], tokenVars.TOKEN_FACTORY, encodeFunctionData({ abi: factoryAbi, functionName: 'activateAssembler' }));
log('token unions', tokenVars.TOKEN_FACTORY, 'adapter', tokenVars.TOKEN_ADAPTER, 'active');

// The token's pool at ~0.03 ETH per 1,000. Its maker gets 5M of the token written straight into its balance (slot 0 of
// OpenZeppelin's ERC20; slot 2 is the supply).
const token = tokenVars.VAULT;
await rpc('anvil_setStorageAt', [token, keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [ACCOUNTS[1], 0n])), toHex(parseEther('5000000'), { size: 32 })]);
await rpc('anvil_setStorageAt', [token, toHex(2, { size: 32 }), toHex(parseEther('5000000'), { size: 32 })]);
const tick = Math.round(Math.log(1000 / 0.03) / Math.log(1.0001) / 60) * 60;
execFileSync('forge', ['script', 'script/E2ESetup.s.sol', '--rpc-url', RPC, '--broadcast'], { cwd: ARB, env: { ...process.env, PATH, TICK: String(tick), E2E_KEY: KEY1, TOKEN: token }, stdio: 'ignore' });
await send(ACCOUNTS[1], token, encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [WALLET, parseUnits('20000', 18)] }));
log('pool ETH /', token);

// Real Credits from ordinary holders (not unions or contracts): 60 into a Mixed batch from two members, then the test
// wallet's.
const CREDITS = '0x97630aA70AB14ed9883B41dAfccBc11349723043';
let next = 1n;
const take = async (n, to) => {
  const ids = [];
  for (; ids.length < n && next <= 4000n; next++) {
    const owner = await pub.readContract({ address: CREDITS, abi: creditsAbi, functionName: 'ownerOf', args: [next] }).catch(() => null);
    if (!owner || ACCOUNTS.some((a) => a.toLowerCase() === owner.toLowerCase()) || ((await pub.getCode({ address: owner })) ?? '0x') !== '0x') continue;
    await rpc('anvil_setBalance', [owner, '0xDE0B6B3A7640000']);
    const r = await send(owner, CREDITS, encodeFunctionData({ abi: creditsAbi, functionName: 'transferFrom', args: [owner, to, next] })).catch(() => null);
    if (r?.status === 'success') ids.push(next);
  }
  return ids;
};
const ANY = { palettes: 0, prints: 0, weights: 0, eights: 0, paidFrom: 0n, paidTo: 0n, idFrom: 0n, idTo: 0n, minScore: 0, maxScore: 0, layout0: 0n, layout1: 0n, bitsFrom: 0, bitsTo: 0, layoutTrait: 0 };
const [a, b] = [await take(40, ACCOUNTS[0]), await take(20, ACCOUNTS[1])];
for (const m of ACCOUNTS.slice(0, 2)) await send(m, CREDITS, encodeFunctionData({ abi: creditsAbi, functionName: 'setApprovalForAll', args: [tokenVars.TOKEN_FACTORY, true] }));
const [p, c, t] = await Promise.all(['protocolFeeBps', 'creatorFeeBps', 'ratings'].map((f) => pub.readContract({ address: tokenVars.TOKEN_FACTORY, abi: factoryAbi, functionName: f })));
await send(ACCOUNTS[0], tokenVars.TOKEN_FACTORY, encodeFunctionData({ abi: factoryAbi, functionName: 'create', args: ['Mixed 1', ANY, [], 0n, 0, 0, 90n * 86400n, a, p, c, t] }));
const [u] = await pub.readContract({ address: tokenVars.TOKEN_FACTORY, abi: factoryAbi, functionName: 'batches', args: [0n, 1n] });
await send(ACCOUNTS[1], tokenVars.TOKEN_FACTORY, encodeFunctionData({ abi: factoryAbi, functionName: 'deposit', args: [u, b] }));
log(`Mixed batch ${u}: ${await pub.readContract({ address: u, abi: batchAbi, functionName: 'count' })} of 80`);
const got = (await take(Number(process.env.CREDITS ?? 20), WALLET)).length;
log(`test wallet holds ${got} Credits and 20,000 of the token`);

// The keeper, as on launch day but spending no matter the gas (--margin 0): a batch converts the moment it fills.
const keeper = spawn('node', ['scripts/convert-tokens.mjs', '--watch', '--margin', '0'], { cwd: WEB, env: { ...process.env, RPC, FROM: ACCOUNTS[0], TOKEN_FACTORY: tokenVars.TOKEN_FACTORY, TOKEN_ADAPTER: tokenVars.TOKEN_ADAPTER }, stdio: ['ignore', 'pipe', 'pipe'] });
procs.push(keeper);
for (const s of [keeper.stdout, keeper.stderr]) s.on('data', (d) => String(d).trim().split('\n').forEach((l) => l && console.log('[keeper]', l)));

// The site on the copy, Vite with hot reload.
const strip = (s) => s.replace(/("(?:[^"\\]|\\.)*")|\/\/[^\n]*/g, (_, str) => str ?? '');
const prod = JSON.parse(strip(readFileSync(join(WEB, 'wrangler.jsonc'), 'utf8')));
const cfg = {
  name: 'creditunion-dev-tokens',
  main: join(WEB, 'src', 'worker', 'index.ts'),
  compatibility_date: prod.compatibility_date,
  assets: { binding: 'ASSETS', not_found_handling: 'single-page-application', run_worker_first: prod.assets.run_worker_first },
  kv_namespaces: [{ binding: 'PLANS', id: 'plans-dev-tokens' }],
  // The market book too (MarketBook, as in production), so buying through a batch prices Credits from /market.json.
  durable_objects: { bindings: [{ name: 'LOCKS', class_name: 'BuyLocks' }, { name: 'MARKET', class_name: 'MarketBook' }, { name: 'CHAIN', class_name: 'ChainBook' }] },
  migrations: [{ tag: 'v1', new_sqlite_classes: ['BuyLocks'] }, { tag: 'v2', new_sqlite_classes: ['MarketBook'] }, { tag: 'v3', new_sqlite_classes: ['ChainBook'] }],
  vars: {
    ...prod.vars,
    RPC_URL: RPC,
    FALLBACK_RPC: RPC,
    ...(OPENSEA ? { OPENSEA_API_KEY: OPENSEA } : {}),
    TOKEN_FACTORY: tokenVars.TOKEN_FACTORY,
    TOKEN_FORMATS: tokenVars.TOKEN_FORMATS,
    TOKEN_SWEEPER: tokenVars.TOKEN_SWEEPER,
    TOKEN_ADAPTER: tokenVars.TOKEN_ADAPTER,
    BALANCE_TOKEN: token,
    BALANCE_POOL_FEE: '3000',
    BALANCE_POOL_TICK_SPACING: '60',
    BALANCE_POOL_HOOKS: '0x0000000000000000000000000000000000000000',
    SWAP_FEE_BPS: '50',
    SWAP_FEE_TO: ACCOUNTS[0],
  },
};
writeFileSync(join(OUT, 'wrangler.json'), JSON.stringify(cfg, null, 2));
procs.push(spawn(join(WEB, 'node_modules', '.bin', 'vite'), ['--config', 'scripts/e2e.vite.config.mjs'], { cwd: WEB, env: { ...process.env, E2E_WRANGLER: join(OUT, 'wrangler.json'), E2E_PORT: String(WEB_PORT) }, stdio: 'inherit' }));
for (let i = 0; !(await fetch(`http://127.0.0.1:${WEB_PORT}/config.json`).then((r) => r.ok).catch(() => false)); i++) {
  if (i > 240) throw new Error('site did not start');
  await sleep(500);
}
// The market book fills from the cron, as in production (a page's read alone can't finish it): run it once and wait,
// so the page has Credits to price.
log('filling the market book…');
await fetch(`http://127.0.0.1:${WEB_PORT}/cdn-cgi/local/explorer/api/local/scheduled?worker=${cfg.name}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cron: '* * * * *' }) }).catch(() => null);
const same = { referer: `http://127.0.0.1:${WEB_PORT}/tokens`, 'sec-fetch-site': 'same-origin' };
for (let i = 0; i < 60; i++) {
  const items = await fetch(`http://127.0.0.1:${WEB_PORT}/market.json`, { headers: same }).then((r) => r.json()).then((j) => j.items?.length ?? 0).catch(() => 0);
  if (items) {
    log(`market book: ${items.toLocaleString('en-US')} listings`);
    break;
  }
  await sleep(5000);
}
console.log(`
  Page       http://127.0.0.1:${WEB_PORT}/tokens   (edits to src/app reload in the browser)
  Wallet     add a network: RPC ${RPC}, chain id 1; import anvil's test key
             0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a  (${WALLET}: 1,000 ETH, ${got} Credits, 20,000 STMT)
  Stand-in   BALANCE is the test vault ${token} (18 decimals; the real one has 4), 35,000 per Statement, pool at ~0.03
             ETH per 1,000, our slice 0.5%; a Mixed batch is 60 of 80 and the keeper converts it when it fills
  Stop       Ctrl-C
`);
await new Promise(() => {});
