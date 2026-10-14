#!/usr/bin/env node
// /tokens Buy and Sell, clicked through in a real browser against a local copy of mainnet:
//   1. anvil forks mainnet; token unions stage 1 deploys (so /tokens draws); a stand-in token gets an ETH pool on the
//      real v4 PoolManager (statement-arb's script/E2ESetup.s.sol) and the test wallet gets some of it
//   2. the site runs on that copy with BALANCE_* set (generated wrangler config, nothing persisted)
//   3. Chrome, with a wallet that sends from anvil's account 2, buys 0.5 ETH of it (no Credits for sale here, so Buy goes
//      to Uniswap) and sells 5,000 back through the page's own buttons; balances are checked on-chain and each step is
//      screenshotted to SHOTS; then a pure color, which only a batch can make
//   node scripts/e2e-swap.mjs      Env: MAINNET_RPC (or contracts/.env), CHROME, HEADED=1, SHOTS (~/Desktop/tokens-swap)
//   LOCKED=1 node scripts/e2e-swap.mjs   instead: a token still in its transfer lock (opens 300 blocks on): Sell greyed
//                                       with the opening block, Buy through a batch only
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, encodeFunctionData, erc20Abi, formatEther, formatUnits, http, parseEther, parseUnits } from 'viem';
import { mainnet } from 'viem/chains';
import { chromium } from 'playwright-core';
import { factoryAbi } from '../src/app/abi.ts';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
const CONTRACTS = join(WEB, '..', 'contracts');
const ARB = join(WEB, '..', '..', 'statement-arb');
const ANVIL_PORT = 8561;
const WEB_PORT = 5195;
const RPC = `http://127.0.0.1:${ANVIL_PORT}`;
const BASE = `http://127.0.0.1:${WEB_PORT}`;
const OUT = join(WEB, '.wrangler', 'e2e-swap');
const SHOTS = process.env.SHOTS ?? join(homedir(), 'Desktop', 'tokens-swap');
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PATH = `${join(homedir(), '.foundry', 'bin')}:${process.env.PATH}`;
const MAINNET_RPC = process.env.MAINNET_RPC ?? readFileSync(join(homedir(), 'Documents', 'GitHub', 'creditunion', 'contracts', '.env'), 'utf8').match(/^MAINNET_RPC=(.+)$/m)?.[1]?.trim();
// The OpenSea key from the main checkout's .dev.vars when there is one (local file only), so the page has the Sweeper
// and Buy can go through a batch, as in production.
const OPENSEA = (() => { try { return readFileSync(join(homedir(), 'Documents', 'GitHub', 'creditunion', 'web', '.dev.vars'), 'utf8').match(/^OPENSEA_API_KEY\s*=\s*"?([^"\n]+)"?/m)?.[1]; } catch { return undefined; } })();
// anvil's accounts 0-2; 1 deploys the token and pool, 2 is the wallet in the page.
const ACCOUNTS = ['0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266', '0x70997970C51812dc3A010C7d01b50e0d17dc79C8', '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC'];
const KEY1 = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const ME = ACCOUNTS[2];
const FEE_TO = '0x000000000000000000000000000000000000FeE5'; // a bad checksum on purpose: the Worker lowercases it

const log = (...a) => console.log('[e2e-swap]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rpc = async (method, params = []) => (await (await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json()).result;
const procs = [];
let failed = false;
let page = null;
const check = (ok, what) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failed = true;
};

try {
  mkdirSync(OUT, { recursive: true });
  mkdirSync(SHOTS, { recursive: true });
  // 1. The copy, token unions stage 1, the pool.
  const anvil = spawn('anvil', ['--fork-url', MAINNET_RPC, '--hardfork', 'osaka', '--enable-tx-gas-limit', '--auto-impersonate', '--port', String(ANVIL_PORT), '--silent'], { env: { ...process.env, PATH }, stdio: 'ignore' });
  procs.push(anvil);
  for (let i = 0; !(await rpc('eth_blockNumber').catch(() => null)); i++) {
    if (i > 120) throw new Error('anvil did not start');
    await sleep(500);
  }
  for (const a of ACCOUNTS) {
    await rpc('anvil_setCode', [a, '0x']); // mainnet has sweeper code on anvil's well-known accounts
    await rpc('anvil_setBalance', [a, '0x3635C9ADC5DEA00000']);
  }
  const deploy = execFileSync('forge', ['script', 'script/DeployTokenUnions.s.sol', '--rpc-url', RPC, '--unlocked', '--sender', ACCOUNTS[0], '--broadcast', '--slow'], {
    cwd: CONTRACTS,
    env: { ...process.env, PATH, SETTER: ACCOUNTS[0], FEE_RECIPIENT: ACCOUNTS[0] },
    encoding: 'utf8',
  });
  const tokenVars = Object.fromEntries([...deploy.matchAll(/^\s*(TOKEN_\w+)\s+(0x[0-9a-fA-F]{40})/gm)].map((m) => [m[1], m[2]]));
  const tick = Math.round(Math.log(1000 / 0.03) / Math.log(1.0001) / 60) * 60;
  execFileSync('forge', ['script', 'script/E2ESetup.s.sol', '--rpc-url', RPC, '--broadcast'], { cwd: ARB, env: { ...process.env, PATH, TICK: String(tick), E2E_KEY: KEY1 }, stdio: 'ignore' });
  const token = JSON.parse(readFileSync(join(ARB, 'bot', 'e2e.json'), 'utf8')).vault;
  const pub = createPublicClient({ chain: mainnet, transport: http(RPC) });
  const give = await rpc('eth_sendTransaction', [{ from: ACCOUNTS[1], to: token, data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [ME, parseUnits('20000', 18)] }) }]);
  await pub.waitForTransactionReceipt({ hash: give });
  const tok = () => pub.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [ME] });
  // LOCKED: a stand-in whose every read answers one number, the block its transfers open at (300 blocks on).
  const LOCK_STUB = '0x00000000000000000000000000000000000010cc';
  if (process.env.LOCKED) {
    const opens = (await pub.getBlockNumber()) + 300n;
    await rpc('anvil_setCode', [LOCK_STUB, `0x7f${opens.toString(16).padStart(64, '0')}600052602060006000f3`.replace('602060006000f3', '60206000f3')]);
  }
  log('copy ready · token unions', tokenVars.TOKEN_FACTORY, '· pool ETH/', token, 'at 0.03 per 1,000');

  // 2. The site on the copy.
  const strip = (s) => s.replace(/("(?:[^"\\]|\\.)*")|\/\/[^\n]*/g, (_, str) => str ?? '');
  const prod = JSON.parse(strip(readFileSync(join(WEB, 'wrangler.jsonc'), 'utf8')));
  const cfg = {
    name: 'creditunion-e2e-swap',
    main: join(WEB, 'src', 'worker', 'index.ts'),
    compatibility_date: prod.compatibility_date,
    assets: { binding: 'ASSETS', not_found_handling: 'single-page-application', run_worker_first: prod.assets.run_worker_first },
    kv_namespaces: [{ binding: 'PLANS', id: 'plans-e2e-swap' }],
    durable_objects: { bindings: [{ name: 'LOCKS', class_name: 'BuyLocks' }, { name: 'CHAIN', class_name: 'ChainBook' }] },
    migrations: [{ tag: 'v1', new_sqlite_classes: ['BuyLocks'] }, { tag: 'v3', new_sqlite_classes: ['ChainBook'] }],
    vars: {
      ...prod.vars,
      RPC_URL: RPC,
      FALLBACK_RPC: RPC,
      ...(OPENSEA ? { OPENSEA_API_KEY: OPENSEA } : {}),
      ...tokenVars,
      BALANCE_TOKEN: process.env.LOCKED ? LOCK_STUB : token,
      BALANCE_POOL_FEE: '3000',
      BALANCE_POOL_TICK_SPACING: '60',
      BALANCE_POOL_HOOKS: '0x0000000000000000000000000000000000000000',
      SWAP_FEE_BPS: '50',
      SWAP_FEE_TO: FEE_TO,
    },
  };
  writeFileSync(join(OUT, 'wrangler.json'), JSON.stringify(cfg, null, 2));
  const vite = spawn(join(WEB, 'node_modules', '.bin', 'vite'), ['--config', 'scripts/e2e.vite.config.mjs'], { cwd: WEB, env: { ...process.env, E2E_WRANGLER: join(OUT, 'wrangler.json'), E2E_PORT: String(WEB_PORT) }, stdio: ['ignore', 'pipe', 'pipe'] });
  procs.push(vite);
  for (let i = 0; ; i++) {
    const ok = await fetch(`${BASE}/config.json`).then((r) => r.ok && r.json()).then((c) => c?.balance?.token).catch(() => null);
    if (ok) break;
    if (i > 120) throw new Error('site did not start');
    await sleep(500);
  }
  log('site on', BASE);

  // 3. The browser: a wallet whose every request goes to anvil (account 2 is unlocked there).
  const b = await chromium.launch({ executablePath: CHROME, headless: !process.env.HEADED });
  procs.push({ kill: () => b.close() });
  const ctx = await b.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: 'light' });
  await ctx.exposeBinding('__anvil', async (_src, body) => (await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body })).text());
  await ctx.addInitScript((me) => {
    localStorage.setItem('cu-wallet', 'injected');
    window.__toasts = [];
    let id = 0;
    window.ethereum = {
      async request({ method, params }) {
        if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [me];
        if (method === 'wallet_switchEthereumChain') return null;
        const res = JSON.parse(await window.__anvil(JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params: params ?? [] })));
        if (res.error) throw Object.assign(new Error(res.error.message), { code: res.error.code, data: res.error.data });
        return res.result;
      },
      on() {},
      removeListener() {},
    };
    new MutationObserver((ms) => {
      for (const m of ms) for (const n of m.addedNodes) if (n.classList?.contains('toast')) window.__toasts.push({ kind: n.className.replace('toast', '').trim(), text: n.textContent });
    }).observe(document, { childList: true, subtree: true });
  }, ME);
  page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const toastFor = async (want, ms = 120_000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      for (const t of await page.evaluate(() => window.__toasts.splice(0))) {
        if (t.kind.includes('err')) throw new Error(`toast error: ${t.text}`);
        if (t.text.includes(want)) return t.text;
      }
      await sleep(250);
    }
    throw new Error(`no "${want}" toast`);
  };
  const shot = (name) => page.locator('.tk-design').screenshot({ path: join(SHOTS, `${name}.png`) });

  await page.goto(`${BASE}/tokens`);
  if (process.env.LOCKED) {
    await page.waitForSelector('.tk-modes [data-view="buy"][aria-selected="true"]', { timeout: 120_000 });
    check(await page.locator('.tk-modes [data-view="sell"]').isDisabled(), 'Sell is greyed while the lock holds');
    const opens = await page.locator('.tk-modes [data-view="sell"]').getAttribute('title');
    log('note:', opens);
    check(/^Opens at block/.test(opens ?? ''), 'it says when it opens');
    await page.fill('#amt', '0.5');
    await page.waitForFunction(() => /via a batch/.test(document.getElementById('route')?.textContent ?? ''), null, { timeout: 30_000 });
    check(true, 'Buy goes through a batch until then');
    await shot('0-locked');
    throw Object.assign(new Error('locked run done'), { done: true });
  }
  await page.waitForSelector('.tk-modes [data-view="buy"][aria-selected="true"]', { timeout: 120_000 });
  await page.waitForSelector('#amt');
  await shot('1-buy-empty');

  // Buy 0.5 ETH: with no Credits for sale here, the page routes it to Uniswap.
  const tokBefore = await tok();
  await page.fill('#amt', '0.5');
  await page.waitForFunction(() => /^Get [\d,]+ /.test(document.getElementById('go')?.textContent ?? '') && !document.getElementById('go')?.disabled, null, { timeout: 30_000 });
  check(/via Uniswap/.test((await page.locator('#route').textContent()) ?? ''), 'it says the buy goes via Uniswap');
  check(/0\.5% on the swap/.test((await page.locator('#fees').textContent()) ?? ''), 'it says our 0.5%');
  const youGet = await page.locator('#get').getAttribute('data-n');
  await shot('2-buy-quoted');
  await page.click('#go');
  log('toast:', await toastFor('Bought'));
  const bought = (await tok()) - tokBefore;
  log(`bought ${formatUnits(bought, 18)} (page said ≈ ${youGet})`);
  check(bought > 0n, 'the buy landed: the wallet holds more of the token');
  check(Math.abs(Number(formatUnits(bought, 18)) - Number(String(youGet).replace(/,/g, ''))) <= Number(formatUnits(bought, 18)) * 0.01 + 1, 'what landed matches what the page quoted (within 1%)');
  check((await pub.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [FEE_TO.toLowerCase()] })) > 0n, 'our 0.5% went to the fee address');

  // Sell 5,000 back (two one-time approvals, then the swap).
  await page.waitForSelector('.tk-modes [data-view="sell"]:not([disabled])', { timeout: 60_000 });
  await page.click('.tk-modes [data-view="sell"]');
  await page.waitForSelector('#amt');
  const ethBefore = await pub.getBalance({ address: ME });
  await page.fill('#amt', '5000');
  await page.waitForFunction(() => /^Sell 5,000/.test(document.getElementById('go')?.textContent ?? '') && !document.getElementById('go')?.disabled, null, { timeout: 30_000 });
  await shot('3-sell-quoted');
  await page.click('#go');
  log('toast:', await toastFor('Sold'));
  check((await pub.getBalance({ address: ME })) > ethBefore, 'the sell landed: the wallet got ETH back (net of gas)');
  check((await pub.getBalance({ address: FEE_TO.toLowerCase() })) > 0n, 'our 0.5% of the ETH went to the fee address');

  // A pure color: only a batch makes one. None of it is for sale here (no market book on this copy); with no OpenSea key
  // at all nothing buys Credits with ETH, so the box is your own Credits.
  await page.waitForSelector('.tk-modes [data-view="buy"]:not([disabled])', { timeout: 60_000 });
  await page.click('.tk-modes [data-view="buy"]');
  await page.fill('#amt', '0.2');
  await page.click('#tk-color');
  await page.click('.tk-menu [data-lane="c"]');
  await page.waitForFunction(() => /via a batch/.test(document.getElementById('route')?.textContent ?? ''), null, { timeout: 30_000 });
  check(true, 'a pure color goes through a batch');
  if (OPENSEA) {
    await page.waitForFunction(() => /No cyan Credits/.test(document.getElementById('amt-line')?.textContent ?? ''), null, { timeout: 30_000 });
    check(true, 'it says none are for sale');
  } else check(!(await page.locator('.tk-modes').count()) && /Your Credits/.test((await page.locator('.tk-form').textContent()) ?? ''), 'with nothing to buy it with, the box is your Credits');
  await shot('4-cyan');
  // And a phone.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.click('#tk-color');
  await page.click('.tk-menu [data-lane="any"]');
  await page.fill('#amt', '0.25');
  await page.waitForFunction(() => /^Get [\d,]+ /.test(document.getElementById('go')?.textContent ?? ''), null, { timeout: 30_000 });
  await page.locator('.tk-form').screenshot({ path: join(SHOTS, '5-buy-phone.png') });
  check(!errors.length, `no page errors${errors.length ? `: ${errors.join(' | ')}` : ''}`);
  log('screens in', SHOTS);
} catch (e) {
  if (!e.done) {
    failed = true;
    console.log('FAIL', e.shortMessage ?? e.message);
    await page?.screenshot({ path: join(SHOTS, 'fail.png'), fullPage: true }).catch(() => {});
  }
} finally {
  for (const p of procs.reverse()) {
    try {
      await p.kill();
    } catch {}
  }
  rmSync(OUT, { recursive: true, force: true });
  console.log(failed ? 'E2E SWAP FAILED' : 'E2E SWAP PASSED');
  process.exitCode = failed ? 1 : 0;
}
