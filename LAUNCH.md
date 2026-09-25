# Launch runbook — mainnet stage 1 (pooling)

Batches open, fill and lock on mainnet. Burning waits for Jack's Statement contract (stage 2).
Everything deployed here is immutable except the one-time adapter activation (setter → 3-day exit window → anyone activates).

## Inputs (decide before deploying)

| | Value | Notes |
|---|---|---|
| `FEE_RECIPIENT` | | Receives protocol fees and rescued strays. Cannot change. |
| `SETTER` | | Proposes the adapter in stage 2. Use a multisig. Nothing else. |
| `PROTOCOL_FEE_BPS` | 100 | 1 %. Ceiling 500. |
| `SWEEP_FEE_BPS` | 100 | 1 % on OpenSea buy-ins. Ceiling 500. |
| Deployer | `0x75BD31465854c7e9E0066496b4ADaD6a46E4eD5C` | Needs ~0.01 ETH. Key in `web/.env`. |
| Etherscan API key | | For source verification. |

## 1. Deploy (≈7.5M gas + ≈55M for the score table)

The score table (Jack's official ratings for all 122,154 Credits, `contracts/data/scores.bin`) is deployed as 11 data
contracts plus a reader. `DeployMainnet` deploys it unless `RATINGS` names an existing one.

```sh
cd contracts
set -a; . ../web/.env; set +a          # MAINNET_RPC, DEPLOYER_PRIVATE_KEY
FEE_RECIPIENT=0x… SETTER=0x… PROTOCOL_FEE_BPS=100 SWEEP_FEE_BPS=100 \
forge script script/DeployMainnet.s.sol --rpc-url "$MAINNET_RPC" --private-key "$DEPLOYER_PRIVATE_KEY" --broadcast --slow
```
Record `RATINGS`, `FACTORY` and `SWEEPER`. The Batch implementation address is `factory.implementation()`.

## 2. Verify source

```sh
forge verify-contract --chain 1 --etherscan-api-key $ETHERSCAN_KEY --watch \
  --constructor-args $(cast abi-encode "constructor(address,address,address,address,address,uint256,uint256)" 0x97630aA70AB14ed9883B41dAfccBc11349723043 $RATINGS 0x0000000000000000000000000000000000000000 $SETTER $FEE_RECIPIENT 100 1) \
  $FACTORY src/BatchFactory.sol:BatchFactory
forge verify-contract --chain 1 --etherscan-api-key $ETHERSCAN_KEY --watch $(cast call $FACTORY "implementation()(address)" --rpc-url "$MAINNET_RPC") src/Batch.sol:Batch
forge verify-contract --chain 1 --etherscan-api-key $ETHERSCAN_KEY --watch \
  --constructor-args $(cast abi-encode "constructor(address,address,uint256)" 0x0000000000000068F116a894984e2DB1123eB395 $FACTORY 100) \
  $SWEEPER src/Sweeper.sol:Sweeper
```

## 3. Sanity checks on chain

```sh
cast call $FACTORY "minOpen()(uint256)"          # 1
cast call $FACTORY "ratings()(address)"          # RATINGS
cast call $RATINGS "scoreOf(uint256)(uint16)" 11469   # 8000 (rank 1, 800.00)
cast call $FACTORY "protocolFeeBps()(uint256)"   # 100
cast call $FACTORY "assembler()(address)"        # 0x0 (stage 1)
cast call $FACTORY "assemblerSetter()(address)"  # SETTER
cast call $FACTORY "feeRecipient()(address)"     # FEE_RECIPIENT
cast call $SWEEPER "feeBps()(uint256)"           # 100
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

## Operational notes

- No admin, no pause: if something is wrong with a batch, the fix is people withdrawing (always possible before 80, after expiry, and during any exit window). The site can be taken down; the contracts continue.
- Rate limits are per IP in the Worker; Cloudflare's dashboard has logs and metrics (observability is on).
- Rotate the Cloudflare token and API keys used during development after launch.
