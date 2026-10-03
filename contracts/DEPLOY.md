# Mainnet deployment

The record of what was deployed, from which commit, with what settings. What the Safe can do afterwards:
[SAFE.md](SAFE.md).

## Addresses

| Contract | Address |
|---|---|
| BatchFactory | [`0xcb06f9076e5fbF3cB052086b1EE7C0F3836aa051`](https://etherscan.io/address/0xcb06f9076e5fbF3cB052086b1EE7C0F3836aa051) |
| Batch implementation (clone source) | [`0xd578eC605E60eDD008b415c23B15Eb3483CC6c50`](https://etherscan.io/address/0xd578eC605E60eDD008b415c23B15Eb3483CC6c50) |
| Sweeper | [`0x7b93309A12e05944Ab821470615983A4A2AC9799`](https://etherscan.io/address/0x7b93309A12e05944Ab821470615983A4A2AC9799) |
| Ratings | [`0x61Ca63cDE107CE7e32785c0d89904fE58f9d371d`](https://etherscan.io/address/0x61Ca63cDE107CE7e32785c0d89904fE58f9d371d) (v3.4.0, 122,154 scores in 11 data contracts) |
| UnionFormats (Oct 1) | [`0x16deCDa20c9164CcfDB4BE189557aDc4614aAedC`](https://etherscan.io/address/0x16deCDa20c9164CcfDB4BE189557aDc4614aAedC) |
| StatementAdapter, the factory's assembler (Oct 1) | [`0x6CAEb9953bA8625226345CF39F93541CE53AbFd2`](https://etherscan.io/address/0x6CAEb9953bA8625226345CF39F93541CE53AbFd2) |
| LiveRatings, `factory.ratings()` (Oct 2) | [`0xe27fC60dcE0a9c33743581bfCD72F619DB3612a6`](https://etherscan.io/address/0xe27fC60dcE0a9c33743581bfCD72F619DB3612a6) |

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
| Assembler | None at deploy. `StatementAdapter` since 8:10 PM ET Oct 1, permanent (below, and [ADAPTER.md](ADAPTER.md)). |
| Protocol fee | 200 bps (2%) of each Statement sale |
| Creator fee | 0 |
| Sweeper fee | 200 bps (2%) of each buy |
| Min Credits to open | 1 |
| Ratings | Deployed by the script from `data/scores.bin`. `LiveRatings` for unions opened since Oct 2 (below). |

## Run

| | |
|---|---|
| Commit | `880b3fc` (contracts as of `fc506e8`) |
| Deployer | `0xB508D6f4E5fD9CA85036778A9f6aBE77A9F925C9` (also a Safe signer; it holds no role in the contracts) |
| Blocks | 26072342 to 26072356, 2026-09-27 |
| Gas | 62.5M, 0.0215 ETH at 0.345 gwei (14 transactions) |

```
cd contracts
set -a; . ./.env; set +a    # MAINNET_RPC, ETHERSCAN_API_KEY, FEE_RECIPIENT, SETTER
forge script script/DeployMainnet.s.sol --rpc-url $MAINNET_RPC \
  --account deployer --sender 0xB508D6f4E5fD9CA85036778A9f6aBE77A9F925C9 \
  --broadcast --slow --verify
```

Forge wrote every transaction to `broadcast/DeployMainnet.s.sol/1/run-latest.json`. `broadcast/` is gitignored, so
that file is only on the machine that deployed; the transactions themselves are on Etherscan under the deployer.

## Checked before

- [x] Credits sealed on mainnet (`isSealed()` true); the script refuses to run otherwise
- [x] Safe is 2 of 3 on mainnet, v1.5.0, deployer is one signer
- [x] Sweeper changes since audit round 2 reviewed against the live FWA and CreditStrategy contracts
- [x] Full `forge test` with mainnet forks on the deploy commit: 264 passed
- [x] Halmos: settle, claim, split and Statement rules proved; the ratings switch rules proved (6); two bidding rules (5% raise, refund) time out, covered by fuzz and invariant tests
- [x] Dry run on the deploy commit, then a full deploy on a mainnet fork with every setting read back

## Checked after

- [x] All four verified on Etherscan (the 11 Ratings data contracts are raw data, no source)
- [x] `factory.feeRecipient()` and `factory.assemblerSetter()` are the Safe
- [x] `factory.protocolFeeBps()` 200, `creatorFeeBps()` 0, `sweeper.feeBps()` 200
- [x] `factory.ratings()` is the Ratings address above, `ratingsHistory()` has one entry (at deploy; LiveRatings since Oct 2)
- [x] `factory.assembler()` is zero (at deploy; the adapter came Oct 1)
- [x] `web/wrangler.jsonc` points at these addresses and `/config.json` shows chainId 1 (checked Oct 3, with
  `STATEMENTS` and `FORMATS` too)

## UnionFormats (Oct 1 2026)

`UnionFormats` 0x16deCDa20c9164CcfDB4BE189557aDc4614aAedC, block 26095891 (tx 0xb700c124…4e66), verified. Where a
union's creator picks its Statement format; the adapter reads it at burn time, so it went up first. Source as in
`c531062`, unchanged since. Deployed with `script/DeployUnionFormats.s.sol`; tests `test/UnionFormats.t.sol`.

## StatementAdapter (Oct 1 2026)

`StatementAdapter` 0x6CAEb9953bA8625226345CF39F93541CE53AbFd2, block 26100878 (tx 0x72bc7e50…7f4c), verified. Built
against Jack's Statements 0x75Edd94b7e49b3bD5C8047b91F165A5e265a069b and the UnionFormats above. The verified
source is in the repo as of `4a6180f`. Deployed with `script/DeployAdapter.s.sol` (`STATEMENTS`, `FORMATS`, optional
`EXPECT`); fork test `test/StatementAdapter.fork.t.sol`. Burn day and the replaced first proposal:
[RUNBOOK.md](RUNBOOK.md).

- [x] Safe proposed it, then `activateAssembler()`; permanent since 8:10 PM ET Oct 1
- [x] `factory.assembler()` reads 0x6CAE…bFd2 (checked Oct 3)
- [ ] No written review round in [AUDIT.md](AUDIT.md) and no Halmos coverage (also true of UnionFormats and
  LiveRatings)

## LiveRatings (Oct 2 2026)

`LiveRatings` 0xe27fC60dcE0a9c33743581bfCD72F619DB3612a6, block 26105860, verified. It reads each Credit's score
from the Statements contract's scorer (0x817A9cFfb4d6E7c206e745A4229001A472C1b7B7) when asked, ×10 rounded down;
`count()` 122,154 like the table it replaces. Deployed with `script/DeployLiveRatings.s.sol`; fork test
`test/LiveRatings.fork.t.sol` (needs `MAINNET_RPC`, no default, and an archive node: it's pinned to a block).

- [x] `scoreOf(9)` 7970 (797.0310), `scoreOf(53739)` 7451; `scorer()` and `credits()` as above
- [x] `proposeRatings(0xe27f…12a6)` simulates from the Safe (calldata `0xf9489bd7…e27fc60dce0a9c33743581bfcd72f619db3612a6`)
- [x] Safe proposed (Safe nonce 2); `activateRatings()` in tx 0x8480e4df…3db00; `factory.ratings()` reads it
- [x] Unions opened before keep 0x61Ca…371d for their rating rules; the site picks each union's table

## Tests now

Oct 3: 282 passing, 252 without forks and 30 on mainnet forks. Set `MAINNET_RPC` to an archive node:
`LiveRatings.fork.t.sol` has no default and `StatementAdapter.fork.t.sol` is pinned to an old block, so a public
node only serves the Sweeper fork tests.
