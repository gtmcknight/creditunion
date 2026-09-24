# Eighty

Trustless pools for Jack Butcher's [Credits](https://jack.art/credits). Eighty Credits burn into one Statement, and most holders have one. A batch contract holds the Credits, burns them together, auctions the Statement onchain, and splits the sale 80 ways. No Credits? Buy in from OpenSea and deposit in one transaction.

Independent. Not affiliated with Jack Butcher.

## How it works

| | |
|---|---|
| **Open** | Anyone with ≥10 Credits opens a batch and sets a creator fee (0–10%, fixed forever). Optional trait filter (Colors / Print / Weight / Eights), checked onchain against Jack's own `CreditArt.describe`. Optional reserve. Deadline 3–90 days. |
| **Deposit** | Approve the factory once and deposit any number, or `safeTransferFrom` one Credit straight to the batch (no approval). Deposit order is the Statement order. |
| **Buy in** | The `Sweeper` buys the cheapest fitting OpenSea listings through Seaport 1.6 and deposits them in the buyer's name, in one transaction. The buyer pays the listings plus the sweep fee (1%). Unused ETH is refunded, and listings that sold first are skipped. |
| **Withdraw** | Any depositor, any time, until the batch holds 80. |
| **Lock** | The 80th Credit locks it. The deadline extends to at least 7 days out. |
| **Burn** | Anyone calls `assemble()`. The batch checks that all 80 Credits are gone and that it holds the Statement, or the whole call reverts. |
| **Expire** | Not burned by the deadline (never filled, or Statements sold out): everyone withdraws. |
| **Auction** | A 24h clock starts at the first bid. Each bid +5% (min 0.01 ETH). Bids in the last 15 min extend it. Outbid ETH is refunded in the same tx. A reserve lapses after 7 days with no bids. |
| **Split** | Anyone settles. The Statement goes to the winner. The protocol fee (1%) and the creator's fee come off the top, and each deposited Credit claims 1/80 of the rest. |

## Fees

| | Default | Set by | Ceiling (in code) |
|---|---|---|---|
| Protocol, on each Statement sale | 1% | deploy (`PROTOCOL_FEE_BPS`) | 5% |
| Creator, on each Statement sale | 0% | batch opener, at creation | 10% |
| Sweep, on OpenSea buy-ins | 1% | deploy (`SWEEP_FEE_BPS`) | 5% |

All of these are fixed once set. Batch cards and pages lead with the creator (ENS name and avatar, resolved on mainnet) and their fee, and the list can sort by lowest fee.

## Trust model

- No owner, admin, pause, or upgrade. Every parameter is fixed at deploy.
- The factory only moves Credits **from its caller** into **its own** batches.
- The Statement mint goes through an immutable `IAssembler`, run by `delegatecall` so the batch is the Credits owner Jack's contract sees. The batch verifies the result: none of the 80 still exist, and it owns the Statement.
- The auction follows the Nouns/Zora pattern. Refunds are gas-capped and never copy return data. A failed refund becomes `owed` (pull), so a hostile bidder can't block the auction.
- Payouts are pull-based (`claim`, callable by anyone for anyone).

**Not yet audited.** Get a review before mainnet, focused on the Jack assembler.

## Layout

```
contracts/   Foundry. Batch.sol, BatchFactory.sol, Sweeper.sol, IAssembler, mocks, tests
             (31 unit incl. fuzz, plus 4 against real mainnet Seaport and Credits: MAINNET_RPC=… forge test)
web/         Cloudflare Worker + static app (Vite, TypeScript, viem, no framework)
  src/worker   /config.json, /rpc (read-only proxy, key stays secret), /art/:id.svg (cached forever),
               /ens/:address (mainnet ENS, cached), /opensea/quote (listings → signed Seaport orders)
  src/app      the site; reads the chain directly, wallets sign in the browser (EIP-6963)
```

The site has no database or indexer. Batches, slots, and bids are read straight from the contracts, and `Credits.tokensOf(owner)` lists a wallet's Credits onchain.

## Develop

```sh
# contracts
cd contracts && forge test

# local chain with demo batches in every state
anvil --gas-limit 60000000
forge script script/SeedDemo.s.sol --rpc-url http://127.0.0.1:8545 --broadcast --slow
#   → then: cast rpc evm_increaseTime 86401; cast rpc evm_mine; cast send <SETTLE_ME> "settle()" …
#   → then: forge script script/SeedDemo.s.sol --sig "later(address)" <FACTORY> …

# site (web/.dev.vars holds CHAIN_ID / CREDITS / FACTORY / FALLBACK_RPC for local)
cd web && pnpm i && pnpm dev
```

After changing contracts, run `pnpm abi` in `web/` to regenerate `src/app/abi.ts`.

## Deploy

Secrets: `wrangler secret put RPC_URL` and `wrangler secret put OPENSEA_API_KEY` (buy-in is hidden without it). Optional `ENS_RPC` when not on mainnet.

**Sepolia (now):** `forge script script/DeployTestnet.s.sol --rpc-url $SEPOLIA --broadcast --private-key $PK` deploys mock Credits, a mock Statement, and the factory. Put the addresses in `web/wrangler.jsonc` `vars`, then run `wrangler secret put RPC_URL` and `pnpm deploy`.

**Mainnet (after Jack publishes the Statement contract, ~Oct 1 2026):**
1. Read the Statement contract. Write `JackAssembler` implementing `IAssembler`: stateless, approve → mint → revoke, return `(statement, id)`. Test it on a mainnet fork against the real Credits.
2. Get it and `Batch.sol` reviewed.
3. `ASSEMBLER=… FEE_RECIPIENT=… [PROTOCOL_FEE_BPS=100 SWEEP_FEE_BPS=100] forge script script/DeployMainnet.s.sol --broadcast` deploys the factory and the Sweeper.
4. Set `CHAIN_ID=1`, `CREDITS=0x97630aA70AB14ed9883B41dAfccBc11349723043`, `FACTORY=…` and `SWEEPER=…` in `wrangler.jsonc`, then deploy.

Open questions about Jack's contract that the assembler must answer: does it accept contract callers? Does it take ids in a meaningful order? Does it `safeMint` (batches accept that during assembly)? Is there a per-wallet limit?
