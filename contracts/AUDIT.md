# Security review — 2026-09-24

Internal review of `Batch.sol`, `BatchFactory.sol`, `Sweeper.sol` and the Worker, before any external audit.
Commit: see git history for "Security review" on this date. **This is not a substitute for an independent
audit before mainnet.** The mainnet assembler adapter does not exist yet and must be reviewed with it.

## Method

| Track | What | Result |
|---|---|---|
| Static analysis | Slither 0.11.6 (core sources; tests, mocks, vendored art excluded), Forge lint | No High. Mediums reviewed below. |
| Adversarial review | Three independent reviewers, one per surface: Batch state machine + auction, Factory + Sweeper + Seaport, Worker + site | 2 Medium, 6 Low, several Info; all fixed or accepted below |
| Invariant fuzzing | `test/Invariant.t.sol`: 256 runs × 100 calls over the full batch lifecycle with reverting and gas-burning receivers | 4 invariants hold over 128,000 calls |
| Fork tests | Real Seaport 1.6, real Credits, OpenSea's signed zone (`0x000056F7…`) with injected signer | Restricted and open listings both fill; stale/skipped semantics documented |
| Unit tests | 55 (Batch 31, TestCredits 6, Sweeper fork 4, audit 14) | All pass |

## Findings and what changed

### Fixed

| # | Sev | Finding | Fix |
|---|---|---|---|
| B1 | Medium | `assemble()` ran the assembler by `delegatecall`. An honest adapter with one ordinary storage variable would overwrite Batch slot 0 (`factory`); bids would still be accepted, `settle()` would revert forever, ETH and Statement stuck. Demonstrated by test. | Assembler is now **called**, with a temporary `setApprovalForAll` scoped to the call and revoked after; Batch checks the adapter's `statement()` matches, that none of the 80 Credits exist, and that it owns the Statement. Adapter storage can no longer reach Batch. `IAssembler` interface changed accordingly. |
| B2 | Low | Credits sent with plain `transferFrom` (Seaport delivery, most wallet "send" flows) fire no hook and were stuck forever. | `rescue(token, id)`: permissionless, forwards any token the batch holds but never recorded to the fee recipient as lost-and-found. Refuses pooled Credits and the Statement. |
| B3 | Low | `safeTransferFrom` by an operator/escrow credited the previous owner, not the intended beneficiary. | `data` may carry an abi-encoded beneficiary address. |
| B4 | Info | `settle()` assumed the Statement transfer to the winner cannot revert. | `try/catch`; on failure `claimStatement(to)` lets the winner pull. |
| B5 | Info | Factory accepted `feeRecipient = 0` (fees burned). | Rejected in constructor. |
| B6 | Info | `withdraw` transferred inside its bookkeeping loop (Slither reentrancy note). | Book all, then transfer. |
| S1 | Low | Sweeper derived `spent` from a balance delta; a bait listing's recipient pushing ETH mid-call could revert the sweep (arithmetic panic) or shrink the fee. | `spent` is summed from Seaport's returned `executions` (NATIVE items). |
| S2 | Low | Stale listings (seller moved the Credit or revoked approval) revert the whole `fulfillAvailableAdvancedOrders`, unlike filled ones which are skipped. | Quote endpoint checks `ownerOf` and `isApprovedForAll(seller, conduit)` per listing on-chain and drops listings whose consideration goes to a contract other than OpenSea's fee wallet. On-chain semantics are documented by test. |
| S3 | Low | `depositFor(to = batch/factory)` created a share that could never withdraw or be paid. | Rejected. (Any other contract without `receive()` remains the caller's own mistake; the factory only moves the caller's Credits.) |
| S4 | Info | Sweeper accepted `safeTransferFrom` of stray NFTs it could never move. | Receiver hook removed; such transfers now fail instead of stranding. |
| W1 | High | `/rpc` was an open relay for the paid RPC key: any `eth_call`/`eth_getLogs` target, usable cross-site. | Six methods only; `eth_call` only to Credits, Factory, Sweeper or a factory batch (`isBatch` cached); same-site only; JSON re-serialised; size and batch caps; per-IP rate limit. |
| W2 | High | `/opensea/quote` fanned out to ~500 uncached `eth_call`s and 40 OpenSea calls per anonymous request, against any address. | Batch must be a factory batch; scan cached 30 s per batch; RPC calls batched; rate limited (6/min/IP). |
| W3 | Medium | Frontend displayed `ids`/`total` from the quote but sent `orders`; a bad quote could show 10 and buy 1. | `checkQuote` verifies every order's offer id/token and ETH-only consideration against the shown ids, prices and total before anything is sent. The Sweeper contract independently bounds spend by `msg.value`. |
| W4 | Medium | No security headers. | CSP (`frame-ancestors 'none'`, `script-src 'self'`, images only self/data/ENS metadata), HSTS, nosniff, referrer and permissions policies on every response. |
| W5 | Medium | `/ens` fetched name-owner-chosen avatar URLs from the Worker and never cached negatives. | Avatar is now ENS's own metadata service URL; negatives cached 1 h, errors 60 s; 5 s RPC timeout; rate limited. |
| W6 | Low | `/art` SVG served without a CSP; 404s uncached. | `sandbox` CSP on SVG responses; 404 cached 5 min. |

### Added after the review: staged launch

To take deposits before the Statement contract exists, the factory can deploy without an assembler. A single setter key may propose one; a proposal opens a 3-day exit window during which every batch (full ones included) is withdrawable; after the delay anyone activates it permanently and the setter loses all power. Full batches get `FILL_GRACE` from activation. This is the one privileged action in the system and it is covered by `test/Staged.t.sol` (10 tests). **The external audit should cover this path**, and the setter should be a multisig.

### Added after the review: arrangements

Batches carry an `Arrangement` (Deposit / MintTime / Number / Creator). `assembleOrdered(order)` lets the creator of a Creator-arranged batch burn with a hand-made permutation; the contract checks it is exactly the 80 pooled ids with no duplicates (O(80²), bounded). Within `CREATOR_ORDER_GRACE` (1 day of filling) only the creator can burn; afterwards anyone can, in deposit order, so a creator cannot stall. The adapter receives the arrangement value; MintTime/Number sorting happens in the adapter (insertion sort over 80). Covered by `test/Arrangement.t.sol` (8 tests). **Should be included in the external audit.**

### Added after the review: eligibility

`Filter` gained a payment window (`paidFrom`/`paidTo`, via `timestampOf`) and a number range; `initialize` takes an allowlist of up to 200 ids stored in a mapping (bounded loop, duplicates tolerated, backwards ranges rejected). `passes()` checks allowlist → range → window → traits, so the expensive `describe` call happens last. Covered by `test/Eligibility.t.sol` (8 tests).

### Accepted / documented

- **The assembler is the trust boundary.** It is immutable and set at factory deploy. It is now isolated from Batch storage and its result is verified, but it holds operator rights over the batch's Credits for the duration of `assemble()`. The mainnet adapter must be reviewed before deploy.
- A depositor that is a contract without `receive()` cannot be paid; `claim()` reverts for them and there is no alternate recipient by design (ERC721 gives no other attribution). Self-inflicted.
- `settle()` after `RESERVE_WINDOW` lets a 1 wei bid start the 24 h clock. Design: the reserve is a 7-day option, not a floor forever.
- Slither Mediums not acted on: rounding in `settle()` is intentional (dust to the protocol fee; fuzz proves the split is exact); `ownerOf` return is intentionally unused inside `try/catch`.
- Protocol fees, the creator fee cap (10 %), and the sweep fee are immutable once deployed.

### Hypotheses checked and rejected (summary)

ETH accounting under mixed reverting/gas-burning receivers; reentrancy via refund callbacks, `claim`, the assembler call and ERC721 hooks; Expired as a terminal state; 80th-slot races; clone initialisation races; uint64 casts; factory moving anyone else's Credits or into a non-batch; the Sweeper's factory approval being usable by others; Seaport overspending `msg.value`; malicious order shapes (ERC20/ERC721 consideration, criteria, partial fills, contract orders, offerer == Sweeper, zero amounts, duplicate orders, invalid signatures); XSS via chain/ENS/OpenSea data; secret leakage in errors; open redirects; malicious injected providers.

## Before mainnet

1. Write `JackAssembler` against the published Statement contract; add fork tests against it.
2. Independent audit of `Batch.sol`, `BatchFactory.sol`, `Sweeper.sol` and the adapter.
3. Deploy with `PROTOCOL_FEE_BPS`/`SWEEP_FEE_BPS` decided; verify sources on Etherscan/Sourcify.
