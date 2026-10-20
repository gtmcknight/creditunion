#!/usr/bin/env node
// Launch day, stage 2 step 4: the Safe proposes our adapter on the token factory (proposeAssembler), signed by the
// deployer in a terminal, never in a browser (a browser wallet makes the last signer Execute, which spends its nonce).
//   node scripts/safe-propose.mjs                 checks the adapter, prints the Safe transaction's hash and the command
//                                                 that signs it (any owner's key works; nothing is sent)
//   SIG=0x… node scripts/safe-propose.mjs         checks the signature is an owner's and queues the transaction in the
//                                                 Safe app with it; another owner (FE35) then confirms and executes there
//   SIG=0x… node scripts/safe-propose.mjs --dry   checks the signature only (a fork: the Safe app only knows mainnet)
// Env: RPC (default MAINNET_RPC in contracts/.env), ADAPTER (default: the TokenAdapter in the latest DeployTokenUnions
// broadcast), TOKEN (when set, the adapter must convert into it), SAFE_API (default Safe's mainnet transaction service).
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, encodeFunctionData, getAddress, http, parseAbi, recoverAddress, zeroAddress } from 'viem';
import { mainnet } from 'viem/chains';
import { factoryAbi } from '../src/app/abi.ts';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
const CONTRACTS = join(WEB, '..', 'contracts');
const RPC = process.env.RPC ?? readFileSync(join(CONTRACTS, '.env'), 'utf8').match(/^MAINNET_RPC=(.+)$/m)?.[1]?.trim();
const strip = (s) => s.replace(/("(?:[^"\\]|\\.)*")|\/\/[^\n]*/g, (_, str) => str ?? '');
const FACTORY = getAddress(JSON.parse(strip(readFileSync(join(WEB, 'wrangler.jsonc'), 'utf8'))).vars.TOKEN_FACTORY);
const SAFE_API = process.env.SAFE_API ?? 'https://api.safe.global/tx-service/eth';
const DRY = process.argv.includes('--dry');
const SIG = process.env.SIG;
const pub = createPublicClient({ chain: mainnet, transport: http(RPC, { timeout: 120_000 }) });
const fail = (why) => {
  console.error(`FAIL ${why}`);
  process.exit(1);
};

const safeAbi = parseAbi([
  'function getOwners() view returns (address[])',
  'function getThreshold() view returns (uint256)',
  'function nonce() view returns (uint256)',
  'function getTransactionHash(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, uint256 nonce) view returns (bytes32)',
]);
const adapterAbi = parseAbi(['function factory() view returns (address)', 'function token() view returns (address)']);
const read = (address, abi, functionName, args = []) => pub.readContract({ address, abi, functionName, args });

// The adapter: named, or the one the latest deploy made. Either way it must be live here and built on this factory.
const latest = () => {
  const f = join(CONTRACTS, 'broadcast', 'DeployTokenUnions.s.sol', '1', 'run-latest.json');
  if (!existsSync(f)) return null;
  const t = JSON.parse(readFileSync(f, 'utf8')).transactions?.findLast((x) => x.contractName === 'TokenAdapter' && x.transactionType === 'CREATE');
  return t?.contractAddress ?? null;
};
const named = process.env.ADAPTER ?? latest();
if (!named) fail('no adapter: set ADAPTER=<address> (the deploy prints it)');
const ADAPTER = getAddress(named);
if (((await pub.getCode({ address: ADAPTER })) ?? '0x') === '0x') fail(`no contract at ${ADAPTER} on this chain${process.env.ADAPTER ? '' : ' (taken from the latest broadcast, which a fork run also writes: set ADAPTER)'}`);
const [factory, token] = await Promise.all([read(ADAPTER, adapterAbi, 'factory'), read(ADAPTER, adapterAbi, 'token')]).catch(() => fail(`${ADAPTER} isn't a TokenAdapter`));
if (getAddress(factory) !== FACTORY) fail(`${ADAPTER} is built on ${factory}, not the token factory ${FACTORY}`);
if (process.env.TOKEN && getAddress(token) !== getAddress(process.env.TOKEN)) fail(`${ADAPTER} converts into ${token}, not TOKEN ${process.env.TOKEN}`);

// The factory: no adapter fixed yet, and nothing (or something else) pending.
const [setter, active, pending, until] = await Promise.all([
  read(FACTORY, parseAbi(['function assemblerSetter() view returns (address)']), 'assemblerSetter'),
  read(FACTORY, factoryAbi, 'assembler'),
  read(FACTORY, factoryAbi, 'pendingAssembler'),
  read(FACTORY, parseAbi(['function pendingUntil() view returns (uint64)']), 'pendingUntil'),
]);
if (active !== zeroAddress) fail(`the token factory's adapter is already fixed: ${active}`);
if (getAddress(pending) === ADAPTER) {
  console.log(`Already proposed: ${ADAPTER} can go live from ${new Date(Number(until) * 1000).toLocaleString('en-US', { timeZone: 'America/New_York', timeZoneName: 'short' })}; the keeper activates it once BALANCE is ready.`);
  process.exit(0);
}
if (pending !== zeroAddress) console.log(`note: this replaces the pending proposal ${pending}`);

// The Safe transaction: proposeAssembler(ADAPTER) on the factory, at the Safe's next nonce (after any already queued).
const SAFE = getAddress(setter);
const [owners, threshold, onchainNonce] = await Promise.all([read(SAFE, safeAbi, 'getOwners'), read(SAFE, safeAbi, 'getThreshold'), read(SAFE, safeAbi, 'nonce')]);
const data = encodeFunctionData({ abi: factoryAbi, functionName: 'proposeAssembler', args: [ADAPTER] });
const queued = DRY ? [] : ((await fetch(`${SAFE_API}/api/v1/safes/${SAFE}/multisig-transactions/?executed=false&nonce__gte=${onchainNonce}`).then((r) => r.json()).catch(() => null))?.results ?? []);
const same = queued.find((t) => getAddress(t.to) === FACTORY && t.data?.toLowerCase() === data.toLowerCase());
const nonce = same ? BigInt(same.nonce) : queued.reduce((n, t) => (BigInt(t.nonce) >= n ? BigInt(t.nonce) + 1n : n), onchainNonce);
const hash = await read(SAFE, safeAbi, 'getTransactionHash', [FACTORY, 0n, data, 0, 0n, 0n, 0n, zeroAddress, zeroAddress, nonce]);
const who = (a) => ({ '0xFE35e15bE885750D9b2363cbB6aBDd57AC9C4c40': 'FE35', '0xf32484112E0b6c994f5dB084D5C15F2a1d6a4228': 'buildinginpublic.eth', '0xB508D6f4E5fD9CA85036778A9f6aBE77A9F925C9': 'deployer' })[getAddress(a)] ?? a;
const queue = `https://app.safe.global/transactions/queue?safe=eth:${SAFE}`;
console.log(`Safe ${SAFE} (${threshold} of ${owners.length}: ${owners.map(who).join(', ')})
proposes adapter ${ADAPTER} (converts into ${token}) on the token factory ${FACTORY}, Safe nonce ${nonce}
safeTxHash ${hash}`);
if (same) console.log(`It's queued already, with ${same.confirmations?.length ?? 0} of ${same.confirmationsRequired} signatures: ${queue}`);

if (!SIG) {
  console.log(`
Sign it in this terminal (it asks for the keystore password and sends nothing):
  cast wallet sign --no-hash --account deployer ${hash}
Then: SIG=<the signature> ADAPTER=${ADAPTER} node scripts/safe-propose.mjs`);
  process.exit(0);
}

// The signature: an owner's, over this exact hash (cast's --no-hash signs the hash itself, which the Safe checks as is).
const signer = await recoverAddress({ hash, signature: SIG }).catch(() => fail('that signature is malformed'));
if (!owners.some((o) => getAddress(o) === signer)) fail(`that signature is from ${signer}, not an owner of the Safe (or it signed another hash)`);
console.log(`ok   signed by ${who(signer)}`);
if (DRY) process.exit(0);
if (same?.confirmations?.some((c) => getAddress(c.owner) === signer)) {
  console.log(`${who(signer)} has signed it already. Another owner confirms and executes: ${queue}`);
  process.exit(0);
}
const res = same
  ? await fetch(`${SAFE_API}/api/v1/multisig-transactions/${hash}/confirmations/`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ signature: SIG }) })
  : await fetch(`${SAFE_API}/api/v1/safes/${SAFE}/multisig-transactions/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ to: FACTORY, value: '0', data, operation: 0, safeTxGas: '0', baseGas: '0', gasPrice: '0', gasToken: zeroAddress, refundReceiver: zeroAddress, nonce: Number(nonce), contractTransactionHash: hash, sender: signer, signature: SIG, origin: 'Credit Union: BALANCE adapter' }),
    });
if (!res.ok) fail(`the Safe service said ${res.status}: ${(await res.text()).slice(0, 400)}`);
const back = await fetch(`${SAFE_API}/api/v1/multisig-transactions/${hash}/`).then((r) => r.json()).catch(() => null);
console.log(`ok   queued in the Safe app with ${back?.confirmations?.length ?? 1} of ${threshold} signatures
Next: FE35 opens ${queue}, then Confirm and Execute (it pays the gas, ~60k).
30 minutes after it executes the keeper activates the adapter, once BALANCE takes Statements.`);
