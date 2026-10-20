#!/usr/bin/env node
// Launch day, step one: is the BALANCE contract at TOKEN the one we rehearsed against, and how far along is its
// launch? Then the commands for our side, with the addresses filled in.
//   TOKEN=0x… node scripts/check-balance.mjs        (RPC: env, else MAINNET_RPC in contracts/.env)
// Checks: its code is the release build we tested (contracts/test/fixtures/balance-release.json, kept out of git; its
// constructor's values aside), 18 decimals, it reads the real Statements, a Statement's quote is its rating, its
// renderer is registered and its launch supply retired (until both, every conversion reverts), and when its transfers
// open. Prints FAIL for what's wrong, WAIT for what the launch hasn't done yet.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, getContractAddress, http, parseAbi } from 'viem';
import { mainnet } from 'viem/chains';
import { factoryAbi } from '../src/app/abi.ts';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
const CONTRACTS = join(WEB, '..', 'contracts');
const RPC = process.env.RPC ?? readFileSync(join(CONTRACTS, '.env'), 'utf8').match(/^MAINNET_RPC=(.+)$/m)?.[1]?.trim();
const TOKEN = process.env.TOKEN ?? process.argv[2];
if (!RPC || !TOKEN) throw new Error('needs TOKEN=<BALANCE address> (and RPC or MAINNET_RPC)');
const strip = (s) => s.replace(/("(?:[^"\\]|\\.)*")|\/\/[^\n]*/g, (_, str) => str ?? '');
const vars = JSON.parse(strip(readFileSync(join(WEB, 'wrangler.jsonc'), 'utf8'))).vars;
const STATEMENTS = '0x75Edd94b7e49b3bD5C8047b91F165A5e265a069b';
const DEPLOYER = process.env.DEPLOYER ?? '0xB508D6f4E5fD9CA85036778A9f6aBE77A9F925C9'; // our deployer keystore (stage 1)
const FIXTURE = join(CONTRACTS, 'test', 'fixtures', 'balance-release.json');
const pub = createPublicClient({ chain: mainnet, transport: http(RPC, { timeout: 120_000 }) });

const tokenAbi = parseAbi([
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function SCORE_TO_TOKEN() view returns (uint256)',
  'function statements() view returns (address)',
  'function renderer() view returns (address)',
  'function artwork() view returns (address)',
  'function withdrawnFormat() view returns (uint8)',
  'function ready() view returns (bool)',
  'function launchRetirement() view returns (uint256)',
  'function totalRetired() view returns (uint256)',
  'function transfersOpenBlock() view returns (uint64)',
  'function auctionFunder() view returns (address)',
  'function auctionCustodian() view returns (address)',
  'function liquidityCustodian() view returns (address)',
  'function withdrawnCount() view returns (uint256)',
  'function quote(uint256) view returns (uint256)',
]);
const statementsAbi = parseAbi(['function ownerOf(uint256) view returns (address)', 'function creditScoreOf(uint256) view returns (uint256)', 'function formatCount() view returns (uint256)', 'function formatName(uint8) view returns (string)', 'function rendererOf(uint8) view returns (address)']);
const read = (functionName, args = [], address = TOKEN, abi = tokenAbi) => pub.readContract({ address, abi, functionName, args });
let failed = false;
const line = (tag, what) => console.log(`${tag.padEnd(4)} ${what}`);
const check = (ok, what, why = '') => {
  line(ok ? 'ok' : 'FAIL', ok ? what : `${what}${why ? `: ${why}` : ''}`);
  if (!ok) failed = true;
};
const bal = (v, d = 4) => (Number(v) / 1e18).toLocaleString('en-US', { maximumFractionDigits: d });

const block = await pub.getBlock();
console.log(`BALANCE at ${TOKEN}, block ${block.number.toLocaleString('en-US')}\n`);

// 1. The code: the release build we tested, the slots its constructor fills (addresses, the format, the opening block) aside.
const code = (await pub.getCode({ address: TOKEN })) ?? '0x';
if (code === '0x') {
  check(false, 'contract deployed', 'no code at this address');
  process.exit(1);
}
if (existsSync(FIXTURE)) {
  const f = JSON.parse(readFileSync(FIXTURE, 'utf8'));
  const mask = (hex) => {
    const b = Buffer.from(hex.slice(2), 'hex');
    for (const { start, length } of f.immutables ?? []) b.fill(0, start, start + length);
    return b.toString('hex');
  };
  check(f.runtime && mask(code) === mask(f.runtime), `its code is the build we tested (${f.source?.split(' ')[1] ?? 'fixture'})`, 'it differs: rebuild the fixture from his deployed revision and rerun the fork test before going on');
} else line('--', 'code not compared (no contracts/test/fixtures/balance-release.json on this machine)');

// 2. What our adapter relies on.
const [name, symbol, decimals, unit, statements] = await Promise.all(['name', 'symbol', 'decimals', 'SCORE_TO_TOKEN', 'statements'].map((f) => read(f).catch(() => null)));
check(decimals === 18 && unit === 10n ** 14n, `${name} (${symbol}): 18 decimals, one rating point = one token`, `decimals ${decimals}, SCORE_TO_TOKEN ${unit}`);
check(statements?.toLowerCase() === STATEMENTS.toLowerCase(), 'it converts the real Statements', `statements() is ${statements}`);
for (let id = 1n; id < 300n; id++) {
  const owner = await read('ownerOf', [id], STATEMENTS, statementsAbi).catch(() => null);
  if (!owner || owner.toLowerCase() === TOKEN.toLowerCase()) continue;
  const [score, q] = await Promise.all([read('creditScoreOf', [id], STATEMENTS, statementsAbi), read('quote', [id]).catch(() => null)]);
  check(q === score * 10n ** 14n, `a Statement's quote is its rating (#${id}: ${(Number(score) / 1e4).toLocaleString('en-US', { maximumFractionDigits: 4 })} → ${q === null ? '?' : bal(q)})`, `quote ${q}`);
  break;
}

// 3. The launch so far: until the renderer is registered and the launch supply retired, every conversion reverts.
const [ready, format, renderer, formatCount, retire, retired, opensAt, funder, auction, liquidity, count] = await Promise.all(
  ['ready', 'withdrawnFormat', 'renderer', 'formatCount', 'launchRetirement', 'totalRetired', 'transfersOpenBlock', 'auctionFunder', 'auctionCustodian', 'liquidityCustodian', 'withdrawnCount'].map((f) =>
    (f === 'formatCount' ? read(f, [], STATEMENTS, statementsAbi) : read(f)).catch(() => null),
  ),
);
if (ready) check(true, `its renderer is registered (format ${format}, "${await read('formatName', [format], STATEMENTS, statementsAbi).catch(() => '?')}")`);
else line('WAIT', `renderer not registered yet (it expects format ${format}; Statements has ${formatCount}): conversions revert until it is`);
if (retire !== null && retired !== null && retired >= retire) check(true, `launch supply retired (${bal(retired)}): anyone can convert`);
else line('WAIT', `launch supply not retired yet (${bal(retired ?? 0n)} of ${bal(retire ?? 0n)}): only the funder can convert until then`);
line('info', `${count ?? '?'} Statements converted so far`);
if (opensAt !== null) {
  const left = Number(BigInt(opensAt) - block.number);
  const at = new Date(Date.now() + Math.max(0, left) * 12_000);
  line('info', left > 0 ? `transfers open at block ${BigInt(opensAt).toLocaleString('en-US')}, about ${at.toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York', timeZoneName: 'short' })} (${Math.floor(left / 300)}h ${Math.round((left % 300) / 5)}m): payouts wait for it` : `transfers open (block ${opensAt}): payouts can go out`);
}
line('info', `funder ${funder}, auction ${auction}, liquidity ${liquidity}, renderer ${renderer}`);

// 4. Our side, with the addresses filled in.
const nonce = await pub.getTransactionCount({ address: DEPLOYER });
const adapter = getContractAddress({ from: DEPLOYER, nonce: BigInt(nonce) });
const safe = await read('assemblerSetter', [], vars.TOKEN_FACTORY, parseAbi(['function assemblerSetter() view returns (address)'])).catch(() => 'the setter');
const pending = await read('pendingAssembler', [], vars.TOKEN_FACTORY, factoryAbi).catch(() => null);
const active = await read('assembler', [], vars.TOKEN_FACTORY, factoryAbi).catch(() => null);
console.log(`
Next, if nothing above says FAIL:
1. Rehearse against it (about 2 min, a mainnet copy):
   cd contracts && VAULT=${TOKEN} forge test --match-path test/TokenAdapterRelease.fork.t.sol -vv
2. Deploy our adapter (deployer ${DEPLOYER} is at nonce ${nonce}, so it lands at ${adapter} if this is its next send):
   cd contracts && FACTORY=${vars.TOKEN_FACTORY} FORMATS=${vars.TOKEN_FORMATS} VAULT=${TOKEN} \\
     forge script script/DeployTokenUnions.s.sol --rpc-url $MAINNET_RPC --account deployer --sender ${DEPLOYER} --broadcast --verify
3. The Safe (${safe}) proposes it. The deployer signs in this terminal, never in a browser; FE35 then confirms and
   executes in the Safe app:
   cd web && ADAPTER=<the deployed adapter> TOKEN=${TOKEN} node scripts/safe-propose.mjs
4. The site: in web/wrangler.jsonc vars add "TOKEN_ADAPTER": "${adapter}" and "BALANCE_TOKEN": "${TOKEN}", then deploy.
5. The keeper, from a wallet holding only gas money (~0.2 ETH; a batch is ~17M gas to convert and pay). It activates the adapter 30 minutes after the Safe's
   proposal, once BALANCE is ready, converts full batches and pays out when transfers open:
   cd web && KEY=<gas wallet key> node scripts/convert-tokens.mjs --watch --max-gwei 20 --margin 2 --price 0.05
Now: ${active && !/^0x0{40}$/i.test(active) ? `adapter ${active} is active` : pending && !/^0x0{40}$/i.test(pending) ? `adapter ${pending} is proposed` : 'no adapter proposed yet'}.`);
process.exitCode = failed ? 1 : 0;
