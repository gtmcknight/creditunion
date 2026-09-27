# Mainnet deployment

The record of what was deployed, from which commit, with what settings. Blanks get filled in as each step lands.
What the Safe can do afterwards: [SAFE.md](SAFE.md).

## Addresses

| Contract | Address |
|---|---|
| BatchFactory | _pending_ |
| Batch implementation (clone source) | _pending_ |
| Sweeper | _pending_ |
| Ratings | _pending_ |

Contracts it points at, fixed in `script/DeployMainnet.s.sol`:

| Contract | Address |
|---|---|
| Credits (Jack Butcher, sealed) | [`0x97630aA70AB14ed9883B41dAfccBc11349723043`](https://etherscan.io/address/0x97630aA70AB14ed9883B41dAfccBc11349723043) |
| Seaport 1.6 | [`0x0000000000000068F116a894984e2DB1123eB395`](https://etherscan.io/address/0x0000000000000068F116a894984e2DB1123eB395) |
| FWA marketplace | [`0x2b019Cfb591988D28C64C4f4be6a24b1592BBF25`](https://etherscan.io/address/0x2b019Cfb591988D28C64C4f4be6a24b1592BBF25) |
| CreditStrategy | [`0x8e607209899b5d12Bd3167a6CD0E8E11FEB053d6`](https://etherscan.io/address/0x8e607209899b5d12Bd3167a6CD0E8E11FEB053d6) |

## Settings

| Setting | Value |
|---|---|
| Fee recipient | Safe `0xFE4761e66C2A37492871d30d0e83bcBC454A7C10` (2 of 3) |
| Assembler setter | The same Safe |
| Assembler | None at deploy. Proposed by the Safe once Jack's Statement contract ships ([ADAPTER.md](ADAPTER.md)). |
| Protocol fee | 200 bps (2%) of each Statement sale |
| Creator fee | 0 |
| Sweeper fee | 200 bps (2%) of each buy |
| Min Credits to open | 1 |
| Ratings | Deployed by the script from `data/scores.bin` |

## Run

| | |
|---|---|
| Commit | _pending_ |
| Deployer | `0xB508D6f4E5fD9CA85036778A9f6aBE77A9F925C9` (also a Safe signer; it holds no role in the contracts) |
| Block | _pending_ |
| Gas | _pending_ (dry run: about 81M) |

```
cd contracts
set -a; . ./.env; set +a    # MAINNET_RPC, ETHERSCAN_API_KEY, FEE_RECIPIENT, SETTER
forge script script/DeployMainnet.s.sol --rpc-url $MAINNET_RPC \
  --account deployer --sender 0xB508D6f4E5fD9CA85036778A9f6aBE77A9F925C9 \
  --broadcast --slow --verify
```

Every transaction is in `broadcast/DeployMainnet.s.sol/1/run-latest.json`.

## Checked before

- [x] Credits sealed on mainnet (`isSealed()` true); the script refuses to run otherwise
- [x] Safe is 2 of 3 on mainnet, v1.5.0, deployer is one signer
- [x] Sweeper changes since audit round 2 reviewed against the live FWA and CreditStrategy contracts
- [ ] Full `forge test` with mainnet forks on the deploy commit
- [ ] Halmos rules for Factory, Ratings and the ratings switch on the deploy commit
- [ ] Dry run on the deploy commit

## Checked after

- [ ] All four verified on Etherscan
- [ ] `factory.feeRecipient()` and `factory.assemblerSetter()` are the Safe
- [ ] `factory.protocolFeeBps()` 200, `creatorFeeBps()` 0, `sweeper.feeBps()` 200
- [ ] `factory.ratings()` is the Ratings address above, `ratingsHistory()` has one entry
- [ ] `factory.assembler()` is zero
- [ ] `web/wrangler.jsonc` points at these addresses and `/config.json` shows chainId 1
