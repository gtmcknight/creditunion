#!/usr/bin/env node
// Buy and Sell on a local copy of mainnet, through Uniswap's real Universal Router, Permit2 and V4Quoter, with the
// same encoding the page uses (src/shared/v4swap.ts). A stand-in token gets an ETH pool on the real v4 PoolManager
// (statement-arb's script/E2ESetup.s.sol), then a fresh wallet buys with ETH and sells half back, our fee going to a
// fresh address each way. Checks what each side received against the quote, and that a too-high minimum reverts.
//   node scripts/swap-fork.mjs        (from web/; needs anvil, forge, MAINNET_RPC (env or contracts/.env), ../statement-arb)
import { execFileSync, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, createWalletClient, erc20Abi, formatEther, http, maxUint160, maxUint256, parseEther } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { mainnet } from 'viem/chains';
import { PERMIT2, UNIVERSAL_ROUTER, V4_QUOTER, afterFee, ethPool, permit2Abi, quoterAbi, routerAbi, swapArgs } from '../src/shared/v4swap.ts';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
const ARB = join(WEB, '..', '..', 'statement-arb'); // Taylor's local repo with v4-core and the pool setup script
const PORT = 8557;
const RPC = `http://127.0.0.1:${PORT}`;
const PATH = `${join(homedir(), '.foundry', 'bin')}:${process.env.PATH}`;
const MAINNET_RPC = process.env.MAINNET_RPC ?? (() => { try { return readFileSync(join(WEB, '..', 'contracts', '.env'), 'utf8').match(/^MAINNET_RPC=(.+)$/m)?.[1]?.trim(); } catch { return undefined; } })();
if (!MAINNET_RPC) throw new Error('set MAINNET_RPC (or contracts/.env)');
const FEE_BPS = 50;
const SLIP = 100n; // 1%
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rpc = (method, params = []) => fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }).then((r) => r.json());

const anvil = spawn('anvil', ['--fork-url', MAINNET_RPC, '--port', String(PORT), '--silent'], { env: { ...process.env, PATH }, stdio: 'ignore' });
let failed = false;
const check = (ok, what) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failed = true;
};
try {
  for (let i = 0; !(await rpc('eth_chainId').catch(() => null))?.result; i++) {
    if (i > 120) throw new Error('anvil did not start');
    await sleep(500);
  }
  const deployer = generatePrivateKey();
  const me = privateKeyToAccount(generatePrivateKey());
  const feeTo = privateKeyToAccount(generatePrivateKey()).address;
  for (const a of [privateKeyToAccount(deployer).address, me.address]) await rpc('anvil_setBalance', [a, '0x' + parseEther('1000').toString(16)]);

  // A token and its ETH pool at ~0.03 ETH per 1,000 tokens, ±6,000 ticks of liquidity, ~50 ETH a side.
  const tick = Math.round(Math.log(1000 / 0.03) / Math.log(1.0001) / 60) * 60;
  execFileSync('forge', ['script', 'script/E2ESetup.s.sol', '--rpc-url', RPC, '--broadcast'], { cwd: ARB, env: { ...process.env, PATH, TICK: String(tick), E2E_KEY: deployer }, stdio: 'ignore' });
  const { vault: token } = JSON.parse(readFileSync(join(ARB, 'bot', 'e2e.json'), 'utf8'));
  const key = ethPool(token, { fee: 3000, tickSpacing: 60, hooks: '0x0000000000000000000000000000000000000000' });
  const pub = createPublicClient({ chain: mainnet, transport: http(RPC) });
  const wallet = createWalletClient({ account: me, chain: mainnet, transport: http(RPC) });
  const tok = (who) => pub.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [who] });
  const quote = async (buy, amount) => (await pub.simulateContract({ address: V4_QUOTER, abi: quoterAbi, functionName: 'quoteExactInputSingle', args: [{ poolKey: key, zeroForOne: buy, exactAmount: amount, hookData: '0x' }] })).result[0];
  const deadline = () => BigInt(Math.floor(Date.now() / 1000) + 1200);
  const run = async (args, value = 0n) => {
    const { request } = await pub.simulateContract({ account: me, address: UNIVERSAL_ROUTER, abi: routerAbi, functionName: 'execute', args, value });
    const r = await pub.waitForTransactionReceipt({ hash: await wallet.writeContract(request) });
    return r;
  };
  console.log(`fork at ${RPC} · pool ETH/${token} at ${(1000 / 1.0001 ** tick).toFixed(4)} ETH per 1,000 · fee ${FEE_BPS / 100}%`);

  // Buy: 0.5 ETH in.
  const ethIn = parseEther('0.5');
  const out = await quote(true, ethIn);
  const net = afterFee(out, FEE_BPS);
  const buy = await run(swapArgs({ key, buy: true, amountIn: ethIn, minOut: (net * (10_000n - SLIP)) / 10_000n, feeBps: FEE_BPS, feeTo, deadline: deadline() }), ethIn);
  const got = await tok(me.address), fee = await tok(feeTo);
  console.log(`buy  0.5 ETH: quoted ${formatEther(out)}, you ${formatEther(got)}, fee ${formatEther(fee)} · gas ${buy.gasUsed}`);
  check(got === net, 'buyer gets the quote less exactly our slice');
  check(fee === out - net, 'fee wallet gets exactly its slice, in the token');

  // Sell: half of it back, through Permit2 (approve the token to Permit2, Permit2 to the router).
  const half = got / 2n;
  await pub.waitForTransactionReceipt({ hash: await wallet.writeContract({ address: token, abi: erc20Abi, functionName: 'approve', args: [PERMIT2, maxUint256] }) });
  await pub.waitForTransactionReceipt({ hash: await wallet.writeContract({ address: PERMIT2, abi: permit2Abi, functionName: 'approve', args: [token, UNIVERSAL_ROUTER, maxUint160, Math.floor(Date.now() / 1000) + 86_400 * 30] }) });
  const back = await quote(false, half);
  const netBack = afterFee(back, FEE_BPS);
  const ethBefore = await pub.getBalance({ address: me.address });
  const feeEthBefore = await pub.getBalance({ address: feeTo });
  const sell = await run(swapArgs({ key, buy: false, amountIn: half, minOut: (netBack * (10_000n - SLIP)) / 10_000n, feeBps: FEE_BPS, feeTo, deadline: deadline() }));
  const ethAfter = await pub.getBalance({ address: me.address });
  const gasPaid = sell.gasUsed * sell.effectiveGasPrice;
  console.log(`sell ${formatEther(half)}: quoted ${formatEther(back)} ETH, you +${formatEther(ethAfter - ethBefore + gasPaid)} before gas · gas ${sell.gasUsed}`);
  check(ethAfter - ethBefore + gasPaid === netBack, 'seller gets the quote less exactly our slice, in ETH');
  check((await pub.getBalance({ address: feeTo })) - feeEthBefore === back - netBack, 'fee wallet gets exactly its slice, in ETH');
  check((await tok(me.address)) === got - half, 'exactly the amount sold left the wallet');

  // A minimum above what the pool gives reverts, and nothing moves.
  const tooMuch = (afterFee(await quote(true, ethIn), FEE_BPS) * 105n) / 100n;
  const before = await tok(me.address);
  const reverted = await run(swapArgs({ key, buy: true, amountIn: ethIn, minOut: tooMuch, feeBps: FEE_BPS, feeTo, deadline: deadline() }), ethIn).then(() => false, () => true);
  check(reverted && (await tok(me.address)) === before, 'a minimum above the pool reverts, nothing moves');

  // No fee configured: the whole output to the sender.
  const out0 = await quote(true, parseEther('0.1'));
  const b0 = await tok(me.address);
  await run(swapArgs({ key, buy: true, amountIn: parseEther('0.1'), minOut: (out0 * 99n) / 100n, feeBps: 0, feeTo: null, deadline: deadline() }), parseEther('0.1'));
  check((await tok(me.address)) - b0 === out0, 'with no fee the sender gets the whole quote');
} catch (e) {
  failed = true;
  console.log('FAIL', e.shortMessage ?? e.message);
} finally {
  anvil.kill();
  console.log(failed ? 'SWAP REHEARSAL FAILED' : 'SWAP REHEARSAL PASSED');
  process.exitCode = failed ? 1 : 0;
}
