#!/usr/bin/env node
// End-to-end matrix: the real site (Vite + the Worker) against a fresh local anvil, driven by Playwright with a mock
// wallet. Covers every filter type, combinations, every arrangement and painted layouts for every layout trait
// (contracts/script/Matrix.s.sol makes the parties), plus the create page.
//
// For each party it checks, against the contract itself (Batch.canTake / a test-run of factory.deposit):
//   · the picker's "N of your M Credits fit" equals what the batch would actually take (canTake, capped by room)
//   · every Credit offered deposits on its own; every Credit in the "don't fit" fold reverts (NoSlot / Excluded)
//   · Select all picks exactly that many, the rest grey out, and Deposit lands them all (no NoSlot, no skips)
//   · the page refreshes to the new state, and withdrawing a picked subset through the page returns just those
// Then it withdraws the rest directly so the next party starts from the same wallet.
//
// Run (from web/):
//   node scripts/e2e-matrix.mjs
// Env: ANVIL_PORT (8546) WEB_PORT (5191) CHROME (path to Chrome) HEADED=1 ONLY=<regex on party names>
//      REUSE=1 (keep the anvil already on ANVIL_PORT and the parties in .wrangler/e2e/manifest.json)
//      KEEP=1 (leave anvil and the site running afterwards) SKIP_CREATE=1 SKIP_PARTIES=1
// Needs foundry (anvil, forge) on PATH or in ~/.foundry/bin. Results: .wrangler/e2e/results.json and a table.
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, createWalletClient, http, parseAbi } from 'viem';
import { foundry } from 'viem/chains';
import { chromium } from 'playwright-core';
import { batchAbi, creditsAbi, factoryAbi } from '../src/app/abi.ts';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
const CONTRACTS = join(WEB, '..', 'contracts');
const OUT = join(WEB, '.wrangler', 'e2e');
mkdirSync(OUT, { recursive: true });
const ANVIL_PORT = Number(process.env.ANVIL_PORT ?? 8546);
const WEB_PORT = Number(process.env.WEB_PORT ?? 5191);
const RPC = `http://127.0.0.1:${ANVIL_PORT}`;
const BASE = `http://127.0.0.1:${WEB_PORT}`;
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const ONLY = process.env.ONLY ? new RegExp(process.env.ONLY) : null;
const ME = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'; // anvil account 0, unlocked: the tester
const PATH = `${join(homedir(), '.foundry', 'bin')}:${process.env.PATH}`;
const procs = [];
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const pub = createPublicClient({ chain: foundry, transport: http(RPC, { timeout: 60_000 }) });
const wallet = createWalletClient({ chain: foundry, account: ME, transport: http(RPC) });
// Factory deposits revert with the batch's own errors: decode them too.
const depositAbi = [...factoryAbi, ...batchAbi.filter((x) => x.type === 'error'), ...parseAbi(['error ERC721InsufficientApproval(address operator, uint256 tokenId)', 'error ERC721IncorrectOwner(address sender, uint256 tokenId, address owner)'])];

// ---------------------------------------------------------------- stack

async function rpcUp(url) {
  try {
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' });
    return r.ok;
  } catch {
    return false;
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(f, ms, what) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await f().catch(() => null);
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await sleep(250);
  }
}

function forge(args) {
  const r = spawnSync('forge', ['script', 'script/Matrix.s.sol', '--rpc-url', RPC, '--broadcast', '--slow', ...args], { cwd: CONTRACTS, env: { ...process.env, PATH }, encoding: 'utf8', maxBuffer: 1 << 30 });
  if (r.status !== 0) throw new Error(`forge failed:\n${(r.stdout + r.stderr).split('\n').filter((l) => /Error|rror:/.test(l)).slice(0, 20).join('\n')}`);
  return r.stdout;
}

async function deploy() {
  if (process.env.REUSE) {
    if (!(await rpcUp(RPC))) throw new Error(`REUSE=1 but nothing answers on ${RPC}`);
    return JSON.parse(readFileSync(join(OUT, 'manifest.json'), 'utf8'));
  }
  if (await rpcUp(RPC)) throw new Error(`Something already answers on ${RPC}. Stop it, pick another ANVIL_PORT, or use REUSE=1.`);
  log('anvil on', ANVIL_PORT);
  const anvil = spawn('anvil', ['--gas-limit', '60000000', '--port', String(ANVIL_PORT), '--silent'], { env: { ...process.env, PATH }, stdio: 'ignore' });
  procs.push(anvil);
  await until(() => rpcUp(RPC), 20_000, 'anvil');
  log('stage 1: deploy + mint');
  const one = forge([]);
  const get = (k) => one.match(new RegExp(`${k} (0x[0-9a-fA-F]{40})`))?.[1];
  const m = { credits: get('CREDITS'), factory: get('FACTORY'), ratings: get('RATINGS'), parties: [] };
  log('stage 2: parties');
  const two = forge(['--sig', 'parties(address,address)', m.credits, m.factory]);
  for (const line of two.split('\n')) {
    const x = line.match(/^\s+PARTY (0x[0-9a-fA-F]{40}) (.+)$/);
    if (x) m.parties.push({ address: x[1], name: x[2].trim() });
  }
  writeFileSync(join(OUT, 'manifest.json'), JSON.stringify(m, null, 2));
  log(`${m.parties.length} parties`);
  return m;
}

async function site(m) {
  const cfg = {
    name: 'creditunion-e2e',
    main: join(WEB, 'src', 'worker', 'index.ts'),
    compatibility_date: '2026-09-01',
    assets: { binding: 'ASSETS', not_found_handling: 'single-page-application', run_worker_first: JSON.parse(readFileSync(join(WEB, 'wrangler.jsonc'), 'utf8').replace(/("(?:[^"\\]|\\.)*")|\/\/[^\n]*/g, (_, str) => str ?? '')).assets.run_worker_first },
    kv_namespaces: [{ binding: 'PLANS', id: 'plans-e2e' }], // Picture unions keep their picture here
    durable_objects: { bindings: [{ name: 'LOCKS', class_name: 'BuyLocks' }] },
    migrations: [{ tag: 'v1', new_sqlite_classes: ['BuyLocks'] }],
    vars: { CHAIN_ID: '31337', CREDITS: m.credits, FACTORY: m.factory, RATINGS: m.ratings, SWEEPER: '0x0000000000000000000000000000000000000000', OPENSEA_SLUG: 'credits', RPC_URL: RPC, FALLBACK_RPC: RPC },
  };
  const path = join(OUT, 'wrangler.json');
  writeFileSync(path, JSON.stringify(cfg, null, 2));
  log('site on', WEB_PORT);
  const vite = spawn(join(WEB, 'node_modules', '.bin', 'vite'), ['--config', 'scripts/e2e.vite.config.mjs'], { cwd: WEB, env: { ...process.env, E2E_WRANGLER: path, E2E_PORT: String(WEB_PORT) }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  vite.stdout.on('data', (d) => (out += d));
  vite.stderr.on('data', (d) => (out += d));
  procs.push(vite);
  await until(async () => (await (await fetch(`${BASE}/config.json`)).json()).chainId === 31337, 60_000, `site (${out.slice(-500)})`);
}

// ---------------------------------------------------------------- browser

/// A wallet the page finds as window.ethereum: the tester's account; every request goes to anvil unchanged
/// (its accounts are unlocked, so eth_sendTransaction signs there). Toasts are collected for the checks.
async function browser() {
  const b = await chromium.launch({ executablePath: CHROME, headless: !process.env.HEADED });
  const ctx = await b.newContext({ viewport: { width: 1280, height: 1000 } });
  await ctx.exposeBinding('__anvil', async (_src, body) => {
    const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    return r.text();
  });
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
  return { b, ctx };
}

const toasts = (page) => page.evaluate(() => window.__toasts.splice(0));
/// A landed deposit opens the "You're in" card (it replaced the Deposited toast); it's closed before going on.
async function waitJoined(page, ms = 90_000) {
  const seen = [];
  const end = Date.now() + ms;
  while (Date.now() < end) {
    for (const t of await toasts(page)) {
      seen.push(t);
      if (t.kind === 'err') throw new Error(`toast error: ${t.text}`);
    }
    if (await page.$('dialog.created[open]')) {
      await page.keyboard.press('Escape');
      await page.waitForSelector('dialog.created', { state: 'detached', timeout: 5_000 }).catch(() => {});
      return seen;
    }
    await sleep(200);
  }
  throw new Error(`no You're in card (saw ${seen.map((t) => t.text).join(' | ')})`);
}

async function waitToast(page, re, ms = 90_000) {
  const seen = [];
  const end = Date.now() + ms;
  while (Date.now() < end) {
    for (const t of await toasts(page)) {
      seen.push(t);
      if (t.kind === 'err') throw new Error(`toast error: ${t.text}`);
      if (re.test(t.text)) return seen;
    }
    await sleep(200);
  }
  throw new Error(`no toast ${re} (saw ${seen.map((t) => t.text).join(' | ')})`);
}

// ---------------------------------------------------------------- chain helpers

const owned = async () => [...(await pub.readContract({ address: MANIFEST.credits, abi: creditsAbi, functionName: 'tokensOf', args: [ME] }))];
const countOf = async (b) => Number(await pub.readContract({ address: b, abi: batchAbi, functionName: 'count' }));
/// Batch.canTake over the wallet's Credits in one bundle: the contract's own answer to "how many would land".
async function canTake(b, ids) {
  if (!ids.length) return [];
  return pub.readContract({ address: b, abi: batchAbi, functionName: 'canTake', args: [ids], gas: 2_000_000_000n });
}
/// Test-run depositing these ids alone: null when it would land, else the revert's error name.
async function tryDeposit(b, ids) {
  try {
    await pub.simulateContract({ address: MANIFEST.factory, abi: depositAbi, functionName: 'deposit', args: [b, ids], account: ME, gas: 50_000_000n });
    return null;
  } catch (e) {
    for (let c = e; c; c = c.cause) if (c.data?.errorName) return c.data.errorName;
    return (e.shortMessage ?? e.message).split('\n')[0];
  }
}
async function withdrawAll(b) {
  const [ids, deps] = await pub.readContract({ address: b, abi: batchAbi, functionName: 'slots' });
  const mine = ids.filter((_, i) => deps[i].toLowerCase() === ME.toLowerCase());
  for (let i = 0; i < mine.length; i += 40) {
    const hash = await wallet.writeContract({ address: b, abi: batchAbi, functionName: 'withdraw', args: [mine.slice(i, i + 40)] });
    const r = await pub.waitForTransactionReceipt({ hash });
    if (r.status !== 'success') throw new Error('cleanup withdraw reverted');
  }
}

// ---------------------------------------------------------------- page helpers

/// The Add Credits box once the picker has settled: fit line, offered ids, and the fold's groups.
async function readPicker(page) {
  await page.waitForFunction(() => document.querySelector('#fit-line strong') || document.querySelector('#fit-none'), null, { timeout: 90_000 });
  await page.click('[data-add="mine"]').catch(() => {});
  return page.evaluate(() => {
    const fit = Number(document.querySelector('#fit-line strong')?.textContent ?? 0);
    const line = (document.querySelector('#fit-line') ?? document.querySelector('#fit-none'))?.textContent?.trim() ?? '';
    const offered = [...document.querySelectorAll('#picker .pick')].map((p) => p.dataset.id);
    const groups = [];
    for (const why of document.querySelectorAll('#picker-off-wrap [data-why]')) {
      const grid = why.nextElementSibling;
      groups.push({ why: why.firstChild.textContent.trim(), ids: [...grid.querySelectorAll('.pick')].map((p) => p.dataset.id) });
    }
    return { fit, line, offered, groups };
  });
}

// ---------------------------------------------------------------- one party

async function testParty(page, p) {
  const r = { party: p.name, before: 0, owned: 0, expected: 0, fit: 0, offered: 0, picked: 0, deposit: '-', refresh: '-', nonfit: '-', withdraw: '-', errors: [] };
  const err = (m) => r.errors.push(m);
  const b = p.address;
  try {
    const mine = await owned();
    r.owned = mine.length;
    r.before = await countOf(b);
    const room = 80 - r.before;
    const ok = await canTake(b, mine);
    r.expected = Math.min(ok.filter(Boolean).length, room);

    await page.goto(`${BASE}/party/${b}`);
    await toasts(page);
    let ui = await readPicker(page);
    r.fit = ui.fit;
    r.offered = ui.offered.length;
    if (ui.fit !== r.expected) err(`fit line says ${ui.fit}, contract takes ${r.expected} ("${ui.line}")`);
    const foldIds = ui.groups.flatMap((g) => g.ids);
    if (ui.offered.length + foldIds.length !== mine.length) err(`picker + fold show ${ui.offered.length + foldIds.length} of ${mine.length} Credits`);

    // The first party approves the factory through the page; the per-Credit test-runs need that approval.
    const approved = await pub.readContract({ address: MANIFEST.credits, abi: creditsAbi, functionName: 'isApprovedForAll', args: [ME, MANIFEST.factory] });
    if (!approved && ui.offered.length) {
      await page.click('#pick-all');
      await page.waitForSelector('#approve', { timeout: 10_000 });
      await page.click('#approve');
      await waitToast(page, /Approved/);
      ui = await readPicker(page);
    }
    // Offered: each lands alone. Fold: each reverts alone, for the reason given.
    const offeredBad = [];
    for (const id of ui.offered) if (await tryDeposit(b, [BigInt(id)])) offeredBad.push(id);
    if (offeredBad.length) err(`offered but revert alone: ${offeredBad.slice(0, 8).join(',')}${offeredBad.length > 8 ? '…' : ''}`);
    let nonfitOk = 0;
    const nonfitBad = [];
    for (const g of ui.groups) {
      const want = /rules/.test(g.why) ? 'Excluded' : 'NoSlot';
      for (const id of g.ids) {
        const e = await tryDeposit(b, [BigInt(id)]);
        if (e === want) nonfitOk++;
        else nonfitBad.push(`${id}:${e ?? 'lands'}`);
      }
    }
    r.nonfit = nonfitBad.length ? `FAIL ${nonfitBad.slice(0, 6).join(',')}` : `${nonfitOk} revert`;
    if (nonfitBad.length) err(`fold Credits that don't revert as expected: ${nonfitBad.slice(0, 6).join(',')}`);

    if (!ui.offered.length) {
      if (r.expected) err('nothing offered but the contract takes some');
      r.deposit = 'none to deposit';
    } else {
      // Select all (picks carried over from approving are cleared first).
      if (await page.$('#pick-none')) await page.click('#pick-none');
      await page.click('#pick-all');
      const picked = await page.$$eval('#picker .pick[aria-pressed="true"]', (xs) => xs.map((x) => x.dataset.id));
      r.picked = picked.length;
      if (picked.length !== r.expected) err(`Select all picked ${picked.length}, contract takes ${r.expected}`);
      const bright = await page.$$eval('#picker .pick[aria-pressed="false"]:not(.off)', (xs) => xs.length);
      if (bright) err(`${bright} unpicked Credits still pickable after Select all`);
      // The picks, as one bundle, must land (what the Deposit button sends, chunked).
      const bundle = await canTake(b, picked.map(BigInt));
      if (bundle.some((x) => !x)) err('the picked bundle does not all land (canTake)');
      await page.click('#deposit');
      const seen = await waitJoined(page, 180_000).catch((e) => (err(e.message), []));
      if (seen.some((t) => /Skipping|no slot/i.test(t.text))) err(`deposit fell back to skipping: ${seen.map((t) => t.text).join(' | ')}`);
      const after = await countOf(b);
      r.deposit = after === r.before + picked.length ? `ok +${picked.length}` : `FAIL ${r.before}→${after}`;
      if (after !== r.before + picked.length) err(`count ${r.before} → ${after}, expected +${picked.length}`);

      // The page redraws with the new state: if still open, the fit line matches the contract again.
      const state = Number(await pub.readContract({ address: b, abi: batchAbi, functionName: 'state' }));
      await page.waitForFunction((n) => document.querySelector('.progress .row span')?.textContent?.startsWith(`${n} of 80`), after, { timeout: 60_000 }).catch(() => err('page did not refresh the count'));
      if (state === 0) {
        const mine2 = await owned();
        const exp2 = Math.min((await canTake(b, mine2)).filter(Boolean).length, 80 - after);
        ui = await readPicker(page);
        r.refresh = ui.fit === exp2 ? `ok ${ui.fit} fit` : `FAIL ${ui.fit}≠${exp2}`;
        if (ui.fit !== exp2) err(`after deposit the fit line says ${ui.fit}, contract takes ${exp2}`);
      } else r.refresh = 'ok full';

      // Withdraw a subset through the page: pick 2 of yours, Withdraw 2. An open union keeps it in its own tab.
      if (await page.$('[data-add="withdraw"]')) await page.click('[data-add="withdraw"]');
      await page.waitForSelector('#w-picker .pick', { timeout: 60_000 });
      const w = await page.$$eval('#w-picker .pick', (xs) => xs.slice(0, 2).map((x) => x.dataset.id));
      for (const id of w) await page.click(`#w-picker .pick[data-id="${id}"]`);
      const label = await page.textContent('#withdraw');
      if (!/Withdraw 2 Credits|Withdraw 1 Credit/.test(label ?? '')) err(`withdraw button reads "${label}"`);
      await page.click('#withdraw');
      await waitToast(page, /returned/, 120_000).catch((e) => err(e.message));
      const back = await Promise.all(w.map((id) => pub.readContract({ address: MANIFEST.credits, abi: creditsAbi, functionName: 'ownerOf', args: [BigInt(id)] })));
      const left = await countOf(b);
      const good = back.every((o) => o.toLowerCase() === ME.toLowerCase()) && left === after - w.length;
      r.withdraw = good ? `ok -${w.length}` : `FAIL count ${left}`;
      if (!good) err(`withdraw of ${w.join(',')} left count ${left}`);
    }
    for (const t of await toasts(page)) if (t.kind === 'err') err(`toast: ${t.text}`);
  } catch (e) {
    err(`crash: ${e.message.split('\n')[0]}`);
  } finally {
    await withdrawAll(b).catch((e) => err(`cleanup: ${e.message}`));
  }
  return r;
}

// ---------------------------------------------------------------- create page

async function createFlow(page, c) {
  const r = { party: `create: ${c.name}`, before: 0, owned: 0, expected: 0, fit: 0, offered: 0, picked: 0, deposit: '-', refresh: '-', nonfit: '-', withdraw: '-', errors: [] };
  const err = (m) => r.errors.push(m);
  let made = null;
  try {
    r.owned = (await owned()).length;
    await page.goto(`${BASE}/create`);
    await toasts(page);
    await page.waitForSelector('#picker .pick', { timeout: 60_000 });
    await sleep(1500); // traits load, then the picker sorts itself
    await c.setup(page);
    await page.waitForTimeout(800);
    const picked = await page.$$eval('#picker .pick[aria-pressed="true"]', (xs) => xs.map((x) => x.dataset.id));
    r.picked = picked.length;
    r.fit = picked.length;
    await page.fill('#name', `E2E ${c.name}`);
    const before = Number(await pub.readContract({ address: MANIFEST.factory, abi: factoryAbi, functionName: 'batchCount' }));
    if (await page.$eval('#go', (x) => x.disabled)) throw new Error(`Start is disabled: ${await page.textContent('#warn')}`);
    await page.click('#go');
    await page.waitForURL(/\/(union|party)\/0x/, { timeout: 180_000 }).catch(async () => {
      const t = await toasts(page);
      throw new Error(`no party page (${t.map((x) => x.text).join(' | ') || 'no toast'})`);
    });
    made = page.url().match(/0x[0-9a-fA-F]{40}/)[0];
    const n = Number(await pub.readContract({ address: MANIFEST.factory, abi: factoryAbi, functionName: 'batchCount' }));
    if (n !== before + 1) err('batchCount did not go up by one');
    const count = await countOf(made);
    r.deposit = count === picked.length ? `ok ${count} in` : `FAIL ${count}/${picked.length}`;
    if (count !== picked.length) err(`party holds ${count}, picked ${picked.length}`);
    if (c.check) await c.check(made, picked, err, page);
    // The new party's page shows the created dialog and its own picker; it must agree with the contract too.
    await page.keyboard.press('Escape').catch(() => {});
    if (count === 80) {
      r.refresh = 'ok full';
      return r;
    }
    if (c.picture) {
      r.refresh = 'picture (checked above)'; // a picture union offers only its next Credits, not all that fit
      return r;
    }
    const ui = await readPicker(page);
    const exp = Math.min((await canTake(made, await owned())).filter(Boolean).length, 80 - count);
    r.expected = exp;
    r.refresh = ui.fit === exp ? `ok ${ui.fit} fit` : `FAIL ${ui.fit}≠${exp}`;
    if (ui.fit !== exp) err(`new party's fit line says ${ui.fit}, contract takes ${exp}`);
    for (const t of await toasts(page)) if (t.kind === 'err') err(`toast: ${t.text}`);
  } catch (e) {
    err(`crash: ${e.message.split('\n')[0]}`);
    await page.screenshot({ path: join(OUT, `fail-${c.name.replace(/\W+/g, '-')}.png`), fullPage: true }).catch(() => {});
  } finally {
    if (made) await withdrawAll(made).catch((e) => err(`cleanup: ${e.message}`));
  }
  return r;
}

/// Open a rule row and press some of its tiles.
/// Rules not set wait as "+ Colors" chips (the same data-tab-btn as their rows): nothing to open first.
async function openRules() {}
async function rule(page, row, key, bits) {
  await openRules(page);
  await page.click(`[data-tab-btn="${row}"]:visible`);
  for (const bit of bits) await page.click(`[data-rule="${key}"] [data-bit="${bit}"]`);
}
async function pickFirst(page, n) {
  const ids = await page.$$eval('#picker .pick:not(.off):not(.full)', (xs, n) => xs.slice(0, n).map((x) => x.dataset.id), n);
  for (const id of ids) await page.click(`#picker .pick[data-id="${id}"]`);
}
/// Painted: picking it paints a random design; Shuffle deals more. `trait`: paint with Eights/Print/Weight instead
/// (switching clears the sheet, and Shuffle paints it again in that trait).
async function painted(page, shuffles, trait) {
  await page.click('label.arr-tile:has(input[value="4"])');
  if (trait) {
    await page.click(`label:has(input[name="paint-with"][value="${trait}"])`);
    await page.click('[data-shuffle]');
  }
  for (let i = 0; i < shuffles; i++) await page.click('[data-shuffle]');
}

/// Picture: pick the layout, wait until the sheet is designed from the picture that opens on it (its Credits in the
/// preview, every slot painted).
async function picture(page) {
  await page.click('label.arr-tile:has(input[value="6"])');
  await page.setInputFiles('#pic-file', join(WEB, 'public', 'examples', 'jack.jpg')); // no examples: upload one
  await page.waitForFunction(
    () => !document.getElementById('pic-status')?.textContent && [...document.querySelectorAll('#preview .sheet .cell')].filter((c) => c.dataset.id || c.dataset.ghost).length === 80,
    null,
    { timeout: 120_000 },
  );
  await page.waitForTimeout(800);
}
/// The preview's Credit in each slot (yours going in, or the one the picture wants there).
const planned = (page) => page.$$eval('#preview .sheet .cell', (cs) => cs.map((c) => c.dataset.id ?? c.dataset.ghost ?? null));
/// Each slot's Colors, from the Rules view (then back to the Credits). Its button only shows on a hand-painted
/// layout, so a picture's is pressed from script.
async function colours(page) {
  await page.$eval('.dirs [data-dir="Rules"]', (b) => b.click());
  const v = await page.$$eval('#preview .rule-cell', (cs) => cs.map((c) => Number(c.dataset.v)));
  await page.click('.dirs [data-dir="Consolidated"]');
  await page.waitForTimeout(300);
  return v;
}
/// The painted layout as the contract holds it: 80 slot values (CMYK masks for a Colors sheet).
async function layoutOf(b) {
  const s = await pub.readContract({ address: b, abi: batchAbi, functionName: 'summary' });
  const f = s.filter;
  return { arrangement: Number(s.arrangement), trait: Number(f.layoutTrait), palettes: Number(f.palettes), slots: Array.from({ length: 80 }, (_, i) => Number(((i < 64 ? f.layout0 : f.layout1) >> BigInt(4 * (i < 64 ? i : i - 64))) & 15n)) };
}
/// Where the contract puts each Credit in: each painted slot takes the earliest-deposited Credit of its Colors.
async function slotsOnChain(b) {
  const { slots } = await layoutOf(b);
  const ids = (await pub.readContract({ address: b, abi: batchAbi, functionName: 'ids' })).map(String);
  const keys = await Promise.all(ids.map((id) => pub.readContract({ address: b, abi: batchAbi, functionName: 'keyOf', args: [BigInt(id)] })));
  const used = new Set();
  return slots.map((m) => {
    const j = ids.findIndex((_, k) => !used.has(k) && Number(keys[k]) === m);
    if (j < 0) return null;
    used.add(j);
    return ids[j];
  });
}
const pictureSeen = {};
/// Every Credit in sits in the slot the page planned for it, and the sheet is Painted by Colors.
async function checkPlaced(b, want, err) {
  const l = await layoutOf(b);
  if (l.arrangement !== 4) err(`arrangement ${l.arrangement}, want Painted (4)`);
  if (l.trait !== 0) err(`layout trait ${l.trait}, want Colors (0)`);
  if (l.slots.some((m) => !m)) err(`${l.slots.filter((m) => !m).length} slots left open`);
  const on = await slotsOnChain(b);
  const wrong = on.flatMap((id, i) => (id && id !== want[i] ? [`slot ${i}: #${id}, planned #${want[i]}`] : []));
  if (wrong.length) err(`misplaced: ${wrong.slice(0, 4).join('; ')}${wrong.length > 4 ? '…' : ''}`);
  return on;
}

const CREATES = [
  { name: 'no rules, 3 picked', setup: (page) => pickFirst(page, 3) },
  {
    name: 'colors rule, all that fit',
    setup: async (page) => {
      await rule(page, 'palette', 'palettes', [8, 9, 12, 13]); // K, CK, YK, CYK
      await page.click('#all');
    },
    check: async (b, picked, err) => {
      for (const id of picked) if (!(await pub.readContract({ address: b, abi: batchAbi, functionName: 'passes', args: [BigInt(id)] }))) err(`#${id} in but doesn't pass`);
    },
  },
  { name: 'painted design, all that fit', setup: async (page) => { await painted(page, 0); await page.click('#all'); } },
  { name: 'painted design 3, all that fit', setup: async (page) => { await painted(page, 3); await page.click('#all'); } },
  {
    name: 'picture, all yours: each lands in its slot',
    picture: true,
    setup: async (page) => {
      await picture(page);
      pictureSeen.plan = await planned(page);
    },
    check: async (b, picked, err) => {
      const on = await checkPlaced(b, pictureSeen.plan, err);
      if (on.filter(Boolean).length !== picked.length) err(`${on.filter(Boolean).length} placed, ${picked.length} picked`);
    },
  },
  {
    name: 'picture, a skipped slot is refused, the first goes in',
    picture: true,
    setup: async (page) => {
      await picture(page);
      const plan = await planned(page), col = await colours(page);
      const picked = await page.$$eval('#picker .pick[aria-pressed="true"]', (xs) => xs.map((x) => x.dataset.id));
      // A picked Credit that's second in its Colors, and the one ahead of it.
      const firstOf = new Map();
      let second = null;
      plan.forEach((id, i) => {
        if (!firstOf.has(col[i])) firstOf.set(col[i], id);
        else if (!second && picked.includes(id) && picked.includes(firstOf.get(col[i]))) second = { id, ahead: firstOf.get(col[i]) };
      });
      if (!second) throw new Error('no Colors with two of yours in a row');
      for (const id of picked) await page.click(`#picker .pick[data-id="${id}"]`);
      await page.click(`#picker .pick[data-id="${second.id}"]`);
      await page.waitForTimeout(400);
      const warn = await page.textContent('#warn');
      if (!warn.includes(`#${second.ahead}`)) throw new Error(`skipping #${second.ahead} wasn't refused ("${warn}")`);
      await page.click(`#picker .pick[data-id="${second.id}"]`);
      await page.click(`#picker .pick[data-id="${second.ahead}"]`);
      pictureSeen.plan = plan;
    },
    check: async (b, picked, err, page) => {
      await checkPlaced(b, pictureSeen.plan, err);
      // The union page: its Deposit offers only the Credits next in their Colors, and they land where it planned.
      // The "Your Credit Union is live" card opens once the page is in: close it.
      await page.waitForSelector('dialog[open]', { timeout: 15_000 }).then(() => page.keyboard.press('Escape')).catch(() => {});
      await page.waitForFunction(() => document.querySelectorAll('.batch-art .cell.planned').length > 0 && !document.querySelector('dialog[open]'), null, { timeout: 120_000 });
      const plan = await page.$$eval('.batch-art .sheet .cell', (cs) => cs.map((c) => c.dataset.id ?? c.dataset.ghost ?? null));
      const ui = await readPicker(page);
      if (!ui.offered.length) return err('union page offers none of the next Credits');
      const stray = ui.offered.filter((id) => !plan.includes(id));
      if (stray.length) err(`offered Credits the picture didn't plan: ${stray.slice(0, 5).join(',')}`);
      if (!ui.groups.some((g) => /Not next in the picture/.test(g.why))) err('no "Not next in the picture" fold');
      await page.click('#pick-all');
      await page.click('#deposit');
      await waitJoined(page);
      await checkPlaced(b, plan, err);
    },
  },
  {
    name: 'picture, a Colors tile off repaints without it',
    picture: true,
    setup: async (page) => {
      await picture(page);
      const col = await colours(page);
      const n = {};
      for (const m of col) n[m] = (n[m] ?? 0) + 1;
      const top = Number(Object.entries(n).sort((x, y) => y[1] - x[1])[0][0]);
      await openRules(page);
      await page.click('[data-tab-btn="palette"]:visible');
      await page.click(`[data-rule="palettes"] [data-bit="${top}"]`);
      await page.waitForFunction(() => !document.getElementById('pic-status')?.textContent, null, { timeout: 120_000 });
      await page.waitForTimeout(1200);
      if ((await colours(page)).includes(top)) throw new Error('its Colors still painted after the tile went off');
      pictureSeen.gone = top;
      pictureSeen.plan = await planned(page);
    },
    check: async (b, picked, err) => {
      if ((await layoutOf(b)).slots.includes(pictureSeen.gone)) err('the Colors taken off are still on the sheet');
      await checkPlaced(b, pictureSeen.plan, err);
    },
  },
  {
    name: 'picture, then back to Deposit',
    setup: async (page) => {
      await picture(page);
      await page.click('label.arr-tile:has(input[value="0"])');
      await page.waitForTimeout(500);
      await pickFirst(page, 2);
    },
    check: async (b, picked, err) => {
      const l = await layoutOf(b);
      if (l.arrangement !== 0) err(`arrangement ${l.arrangement}, want Deposit (0)`);
      if (l.slots.some(Boolean)) err('paint left on the sheet');
      if (l.palettes) err(`Colors set ${l.palettes} left on Who can join`);
    },
  },
  {
    name: 'number, high to low',
    setup: async (page) => {
      await page.click('label.arr-tile:has(input[value="2"])');
      await page.click('.num-dir label:nth-child(2)');
      await pickFirst(page, 2);
    },
    check: async (b, picked, err) => {
      const a = Number((await pub.readContract({ address: b, abi: batchAbi, functionName: 'summary' })).arrangement);
      if (a !== 5) err(`arrangement ${a}, want Number ↓ (5)`);
    },
  },
  {
    name: 'painted weight, all that fit',
    setup: async (page) => {
      await rule(page, 'weight', 'weights', [0, 1]);
      await painted(page, 1, 3);
      await page.click('#all');
    },
  },
];

// ---------------------------------------------------------------- main

let MANIFEST;
function table(rows) {
  const cols = ['party', 'owned', 'before', 'expected', 'fit', 'offered', 'picked', 'deposit', 'refresh', 'nonfit', 'withdraw', 'errors'];
  const cell = (r, c) => (c === 'errors' ? (r.errors.length ? r.errors.join('; ') : 'none') : String(r[c]));
  return [`| ${cols.join(' | ')} |`, `|${cols.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${cols.map((c) => cell(r, c).replace(/\|/g, '/')).join(' | ')} |`)].join('\n');
}

async function main() {
  MANIFEST = await deploy();
  await site(MANIFEST);
  const { b, ctx } = await browser();
  const page = await ctx.newPage();
  page.on('pageerror', (e) => log('pageerror', e.message));
  const rows = [];
  try {
    if (!process.env.SKIP_PARTIES)
      for (const p of MANIFEST.parties) {
        if (ONLY && !ONLY.test(p.name)) continue;
        const r = await testParty(page, p);
        log(`${r.errors.length ? 'FAIL' : 'ok  '} ${p.name} · fit ${r.fit}/${r.expected} · ${r.deposit} · ${r.withdraw}${r.errors.length ? ` · ${r.errors.join('; ')}` : ''}`);
        rows.push(r);
      }
    if (!process.env.SKIP_CREATE)
      for (const c of CREATES) {
        if (ONLY && !ONLY.test(`create: ${c.name}`)) continue;
        const r = await createFlow(page, c);
        log(`${r.errors.length ? 'FAIL' : 'ok  '} create: ${c.name} · ${r.deposit}${r.errors.length ? ` · ${r.errors.join('; ')}` : ''}`);
        rows.push(r);
      }
  } finally {
    await b.close();
  }
  writeFileSync(join(OUT, 'results.json'), JSON.stringify(rows, null, 2));
  console.log(`\n${table(rows)}\n`);
  const failed = rows.filter((r) => r.errors.length);
  console.log(failed.length ? `${failed.length} of ${rows.length} FAILED` : `all ${rows.length} passed`);
  return failed.length ? 1 : 0;
}

let code = 1;
try {
  code = await main();
} catch (e) {
  console.error(e);
} finally {
  if (!process.env.KEEP) for (const p of procs) p.kill();
  else log(`kept running: anvil ${RPC}, site ${BASE}`);
}
process.exit(code);
