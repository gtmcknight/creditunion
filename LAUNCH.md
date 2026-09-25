# Launch runbook — mainnet stage 1 (pooling)

Batches open, fill and lock on mainnet. Burning waits for Jack's Statement contract (stage 2).
Everything deployed here is immutable except the one-time adapter activation (setter → 3-day exit window → anyone activates).

## To-do

**Before deploying (you)**
- [ ] `FEE_RECIPIENT`: a multisig or a wallet you will keep. It receives fees and rescued strays, and it is the only key that can change fees (within the caps). Immutable.
- [ ] `SETTER`: multisig. Its only power is proposing the Statement adapter once. Immutable.
- [ ] Confirm fees: protocol 2 %, creator 0 %, buy-in 2 % (all changeable later by `FEE_RECIPIENT`, new batches only).
- [ ] Fund the deployer `0x75BD…eD5C`. Rehearsed on a mainnet fork: **60.1 M gas over 14 txs** (score table 11 chunks + reader, factory, sweeper). At 0.2 gwei that is 0.012 ETH; at 2 gwei 0.12 ETH. Fund `60M × gas price × 1.5`; check `cast gas-price` right before.
- [ ] Etherscan API key for source verification.
- [ ] Decide the launch domain (eighty.rhps.fun stays, or a custom one → add the route in `wrangler.jsonc`).

**Deploy (me, with you watching)**
- [ ] Run `DeployMainnet` (§ 1); record `RATINGS`, `FACTORY`, `SWEEPER`, implementation.
- [ ] Verify all four contracts on Etherscan (§ 2).
- [ ] Sanity-check every constant on chain (§ 3), including `scoreOf(11469) == 8000`.
- [ ] Site: mainnet vars + secrets, build, deploy (§ 4). Confirm `/config.json` shows chain 1 and non-null `sweeper` and `ratings`.
- [ ] Smoke test with a real wallet and one real Credit (§ 5): open, withdraw, quote a buy-in, small real sweep.
- [ ] Commit the addresses (README + docs) and tag `v1-mainnet-stage1`.

**Announce**
- [ ] Say clearly: pooling only until Jack's contract ships; withdraw any time before 80; the 3-day exit window before any adapter goes live.
- [ ] Link Docs → Contracts so people can verify addresses themselves.

**After launch**
- [ ] Rotate the Cloudflare token, Alchemy key and OpenSea key used during development; move them out of `web/.env` if the machine is shared.
- [ ] Watch Cloudflare logs for rate-limit hits and Worker errors the first day.
- [ ] Sepolia: activate the test adapter after its window (Sept 27) so the full burn → auction → split flow can be demoed.
- [ ] When Jack's Statement contract is published: read it, write `JackAssembler`, fork-test, propose from `SETTER`, activate after 3 days (§ 6). Before that, an independent audit of `Batch`, `BatchFactory`, `Sweeper` and the adapter.

## Inputs (decide before deploying)

| | Value | Notes |
|---|---|---|
| `FEE_RECIPIENT` | | Receives protocol fees and rescued strays. Cannot change. |
| `SETTER` | | Proposes the adapter in stage 2. Use a multisig. Nothing else. |
| `PROTOCOL_FEE_BPS` | 200 | 2 %. Ceiling 500. Changeable later by `FEE_RECIPIENT` via `setFees` (new batches only). |
| `CREATOR_FEE_BPS` | 0 | Creator's share, same for every batch. Ceiling 1000. Same setter. |
| `SWEEP_FEE_BPS` | 200 | 2 % on OpenSea buy-ins. Ceiling 500. `Sweeper.setFee` later. |
| Deployer | `0x75BD31465854c7e9E0066496b4ADaD6a46E4eD5C` | Needs ~0.01 ETH. Key in `web/.env`. |
| Etherscan API key | | For source verification. |

## 1. Deploy (60.1M gas, 14 txs, rehearsed on a fork)

The score table (Jack's official ratings for all 122,154 Credits, `contracts/data/scores.bin`) is deployed as 11 data
contracts plus a reader. `DeployMainnet` deploys it unless `RATINGS` names an existing one.

```sh
cd contracts
set -a; . ../web/.env; set +a          # MAINNET_RPC, DEPLOYER_PRIVATE_KEY
FEE_RECIPIENT=0x… SETTER=0x… PROTOCOL_FEE_BPS=200 CREATOR_FEE_BPS=0 SWEEP_FEE_BPS=200 \
forge script script/DeployMainnet.s.sol --rpc-url "$MAINNET_RPC" --private-key "$DEPLOYER_PRIVATE_KEY" --broadcast --slow
```
Record `RATINGS`, `FACTORY` and `SWEEPER`. The Batch implementation address is `factory.implementation()`.

## 2. Verify source

```sh
forge verify-contract --chain 1 --etherscan-api-key $ETHERSCAN_KEY --watch \
  --constructor-args $(cast abi-encode "constructor(address,address,address,address,address,uint256,uint256,uint256)" 0x97630aA70AB14ed9883B41dAfccBc11349723043 $RATINGS 0x0000000000000000000000000000000000000000 $SETTER $FEE_RECIPIENT 200 0 1) \
  $FACTORY src/BatchFactory.sol:BatchFactory
forge verify-contract --chain 1 --etherscan-api-key $ETHERSCAN_KEY --watch $(cast call $FACTORY "implementation()(address)" --rpc-url "$MAINNET_RPC") src/Batch.sol:Batch
forge verify-contract --chain 1 --etherscan-api-key $ETHERSCAN_KEY --watch \
  --constructor-args $(cast abi-encode "constructor(address,address,uint256)" 0x0000000000000068F116a894984e2DB1123eB395 $FACTORY 200) \
  $SWEEPER src/Sweeper.sol:Sweeper
```

## 3. Sanity checks on chain

```sh
cast call $FACTORY "minOpen()(uint256)"          # 1
cast call $FACTORY "ratings()(address)"          # RATINGS
cast call $RATINGS "scoreOf(uint256)(uint16)" 11469   # 8000 (rank 1, 800.00)
cast call $FACTORY "protocolFeeBps()(uint256)"   # 200
cast call $FACTORY "creatorFeeBps()(uint256)"    # 0
cast call $FACTORY "assembler()(address)"        # 0x0 (stage 1)
cast call $FACTORY "assemblerSetter()(address)"  # SETTER
cast call $FACTORY "feeRecipient()(address)"     # FEE_RECIPIENT
cast call $SWEEPER "feeBps()(uint256)"           # 200
```

## 4. Site

In `web/wrangler.jsonc` set `CHAIN_ID` `"1"`, `CREDITS` `0x97630aA70AB14ed9883B41dAfccBc11349723043`, `FACTORY`, `SWEEPER`, and `FALLBACK_RPC` to a public mainnet RPC. Secrets:
```sh
cd web
wrangler secret put RPC_URL          # the Alchemy mainnet URL (paid reads, key stays private)
wrangler secret put OPENSEA_API_KEY  # already set; re-put if rotated
wrangler secret put ENS_RPC          # same as RPC_URL on mainnet
pnpm build && wrangler deploy
```
The testnet banner and Mint page disappear automatically on chain 1.

## 5. Smoke test on the live site

- `/config.json` shows chain 1 and the new addresses; `sweeper` is non-null.
- Home loads batches (none yet); connect a real wallet; the join bar reports your Credits.
- Design page: counts and previews load; open a batch with one Credit; withdraw it.
- Buy-in: get a price on an open batch (live OpenSea listings); a small real sweep.
- Docs page shows the mainnet addresses with Etherscan links.

## 6. Stage 2, when Jack's Statement contract ships

1. Read it; write `JackAssembler` (`IAssembler`: `statement()`, `assemble(ids, arrangement)`), fork-test against real Credits.
2. From the setter: `cast send $FACTORY "proposeAssembler(address)" $ADAPTER` → 3-day exit window (site shows it on every batch).
3. After 3 days, anyone: `cast send $FACTORY "activateAssembler()"`. Full batches get 7 days to burn.

## Changing fees later

From `FEE_RECIPIENT` only, within the ceilings; affects batches opened after the call (and, for the Sweeper, purchases after it):
```sh
cast send $FACTORY "setFees(uint256,uint256)" 200 0     # protocol bps, creator bps
cast send $SWEEPER "setFee(uint256)" 200
```

## Operational notes

- No admin, no pause: if something is wrong with a batch, the fix is people withdrawing (always possible before 80, after expiry, and during any exit window). The site can be taken down; the contracts continue.
- Rate limits are per IP in the Worker; Cloudflare's dashboard has logs and metrics (observability is on).
- Rotate the Cloudflare token and API keys used during development after launch.
