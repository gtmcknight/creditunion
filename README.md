# Eighty

Trustless pools for Jack Butcher's [Credits](https://jack.art/credits). Eighty Credits burn into one Statement, and most holders have one. A batch contract holds the Credits, burns them together, auctions the Statement onchain, and splits the sale 80 ways. No Credits? Buy in from OpenSea and deposit in one transaction.

Independent. Not affiliated with Jack Butcher.

## How it works

| | |
|---|---|
| **Open** | Anyone with a Credit opens a batch. Optional eligibility, all combinable and enforced onchain on every deposit: trait filter (Colors / Print / Weight / Eights via Jack's own `CreditArt.describe`), a payment window (e.g. one minute of the mint), a Credit-number range, or an explicit list of up to 200 Credits. Optional reserve. Deadline 3–90 days. |
| **Order** | Chosen by the opener and shown before anyone deposits: *Deposit order*, *Mint time*, *Credit number*, *Creator's order*, or a *Layout* (the 8×10 sheet painted with palettes on the design page; each painted slot only takes a Credit of that palette, enforced on every deposit, and the burn follows the painting). With the last, the creator arranges the full sheet by hand (or by rating, mint time, number) and burns with that order; if they haven't within a day of filling, anyone can burn in deposit order. The adapter receives the arrangement too, so whatever Jack's contract wants can be handled there. |
| **Deposit** | Approve the factory once and deposit any number, or `safeTransferFrom` one Credit straight to the batch (no approval; `data` may name a beneficiary). Deposit order is the Statement order. Plain `transferFrom` fires no hook: such strays go to the fee recipient via `rescue()` as lost-and-found. |
| **Buy in** | The `Sweeper` buys the cheapest fitting OpenSea listings through Seaport 1.6 and deposits them in the buyer's name, in one transaction. The buyer pays the listings plus the sweep fee (2%). Unused ETH is refunded, and listings that sold first are skipped. |
| **Withdraw** | Any depositor, any time, until the batch holds 80. |
| **Lock** | The 80th Credit locks it. The deadline extends to at least 7 days out. |
| **Burn** | Anyone calls `assemble()`. The batch checks that all 80 Credits are gone and that it holds the Statement, or the whole call reverts. |
| **Expire** | Not burned by the deadline (never filled, or Statements sold out): everyone withdraws. |
| **Auction** | A 24h clock starts at the first bid. Each bid +5% (min 0.01 ETH). Bids in the last 15 min extend it. Outbid ETH is refunded in the same tx. A reserve lapses after 7 days with no bids (the minimum is then 0.01 ETH). |
| **Split** | Anyone settles. The Statement goes to the winner. The protocol fee (2%) comes off the top; the rest goes to the 80 positions: 1/80 each (*Equal*), or 1.5 → 0.5 shares by deposit order (*Early bird*, chosen when the batch opens — the curator deposits first, so that is their reward instead of a fee), and each deposited Credit claims 1/80 of the rest. |

## Ratings

Batch pages show each Credit's **official rating**: Jack Butcher's published formula (methodology v3.4.0, [jack.art/credits/rating](https://jack.art/credits/rating)), reproduced in `web/src/shared/credits.ts` from his MIT-licensed art contracts and verified to match his API exactly (score and rank) on sampled Credits. The frozen edition (122,154 Credits: seeds and payment times from the `Distributed` events) is compiled into `web/public/edition.bin` by `node scripts/edition.ts credits.json`; the Worker's `/ratings` endpoint rates any ids against it, including testnet Credits.

## Fees

| | Launch | Set by | Ceiling (in code) |
|---|---|---|---|
| Protocol, on each Statement sale | 2% | deploy (`PROTOCOL_FEE_BPS`), later `setFees` | 5% |
| Creator, on each Statement sale | 0% | deploy (`CREATOR_FEE_BPS`), later `setFees` | 10% |
| Sweep, on OpenSea buy-ins | 2% | deploy (`SWEEP_FEE_BPS`), later `setFee` | 5% |

The fee recipient can change any of these within the ceilings. A batch copies the protocol and creator fees the moment it opens and keeps them forever (`Batch.protocolFeeBps` / `creatorFeeBps`, shown on its page), so a change only reaches batches opened afterwards. The sweep fee is read at each purchase and included in the quote before signing. Batch cards and pages lead with the creator (ENS name and avatar, resolved on mainnet); a creator fee, when there is one, is shown beside them.

## Launching before the Statement contract exists

The factory can deploy with **no assembler**. Batches open, fill and lock as normal, but cannot burn: pooling only. When Jack's Statement contract ships and the adapter is written and reviewed, one address (the *setter*, ideally a multisig) **proposes** it. That opens a **3-day exit window** in which anyone can withdraw from any batch, full ones included. After 3 days anyone can **activate** it, permanently; the setter then has no powers at all. Full batches get a fresh 7 days from activation to burn, so none expires while waiting. The setter can replace a pending proposal (which restarts the window) but can do nothing else, ever.

## Trust model

- No owner, admin, pause, or upgrade. Every parameter is fixed at deploy, except the assembler when launched in pooling mode: one setter key, one proposal at a time, always behind a 3-day exit window, gone once active.
- The factory only moves Credits **from its caller** into **its own** batches.
- The Statement mint goes through an immutable `IAssembler`, **called** (never delegatecalled) with an operator approval that exists only for the duration of the call. The batch verifies the result: the adapter's `statement()` matches, none of the 80 still exist, and it owns the Statement. Adapter storage cannot reach the batch.
- The auction follows the Nouns/Zora pattern. Refunds are gas-capped and never copy return data. A failed refund becomes `owed` (pull), so a hostile bidder can't block the auction.
- Payouts are pull-based (`claim`, callable by anyone for anyone).

**Internally reviewed, not externally audited.** See [contracts/AUDIT.md](contracts/AUDIT.md): static analysis, three adversarial reviews, invariant fuzzing and mainnet fork tests, with every finding and what changed. Get an independent audit before mainnet, including the Jack assembler.

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

**Mainnet, stage 1 (pooling, can happen now):** `FEE_RECIPIENT=… SETTER=… forge script script/DeployMainnet.s.sol --broadcast` deploys the factory with no assembler and the Sweeper. Set `CHAIN_ID=1`, `CREDITS`, `FACTORY`, `SWEEPER` in `wrangler.jsonc` and deploy the site. Batches fill and lock; burning waits.

**Mainnet, stage 2 (after Jack publishes the Statement contract, ~Oct 1 2026):**
1. Read the Statement contract. Write `JackAssembler` implementing `IAssembler` (called by the batch with a scoped operator approval; must finish with the batch owning the Statement). Test it on a mainnet fork against the real Credits.
2. Get it and the core contracts reviewed. Then from the setter: `proposeAssembler(adapter)`; 3 days later anyone calls `activateAssembler()`.
3. `ASSEMBLER=… FEE_RECIPIENT=… [PROTOCOL_FEE_BPS=100 SWEEP_FEE_BPS=100] forge script script/DeployMainnet.s.sol --broadcast` deploys the factory and the Sweeper.
4. Set `CHAIN_ID=1`, `CREDITS=0x97630aA70AB14ed9883B41dAfccBc11349723043`, `FACTORY=…` and `SWEEPER=…` in `wrangler.jsonc`, then deploy.

Open questions about Jack's contract that the assembler must answer: does it accept contract callers? Does it take ids in a meaningful order? Does it `safeMint` (batches accept that during assembly)? Is there a per-wallet limit?
