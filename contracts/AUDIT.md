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
| W2 | High | `/opensea/quote` fanned out to ~500 uncached `eth_call`s and 40 OpenSea calls per anonymous request, against any address. | Batch must be a factory batch; scan cached 30 s per batch and coalesced while in flight; rules checked before any liveness call; rate limited (6/min/IP). (Round 2: the earlier note "RPC calls batched" was wrong — see R2-2.) |
| W3 | Medium | Frontend displayed `ids`/`total` from the quote but sent `orders`; a bad quote could show 10 and buy 1. | `checkQuote` verifies every order's offer id/token and ETH-only consideration against the shown ids, prices and total before anything is sent. The Sweeper contract independently bounds spend by `msg.value`. |
| W4 | Medium | No security headers. | CSP (`frame-ancestors 'none'`, `script-src 'self'`, images only self/data/ENS metadata), HSTS, nosniff, referrer and permissions policies on every response. |
| W5 | Medium | `/ens` fetched name-owner-chosen avatar URLs from the Worker and never cached negatives. | Avatar is now ENS's own metadata service URL; negatives cached 1 h, errors 60 s; 5 s RPC timeout; rate limited. |
| W6 | Low | `/art` SVG served without a CSP; 404s uncached. | `sandbox` CSP on SVG responses; 404 cached 5 min. |

### Added after the review: staged launch

To take deposits before the Statement contract exists, the factory can deploy without an assembler. A single setter key may propose one; a proposal opens a 3-day exit window during which every batch (full ones included) is withdrawable; after the delay anyone activates it permanently and the setter loses all power. Full batches get `FILL_GRACE` from activation. This is the one privileged action in the system and it is covered by `test/Staged.t.sol` (10 tests). **The external audit should cover this path**, and the setter should be a multisig.

### Added after the review: arrangements

Batches carry an `Arrangement` (Deposit / MintTime / Number / Creator). `assembleOrdered(order)` lets the creator of a Creator-arranged batch burn with a hand-made permutation; the contract checks it is exactly the 80 pooled ids with no duplicates (O(80²), bounded). Within `CREATOR_ORDER_GRACE` (1 day of filling) only the creator can burn; afterwards anyone can, in deposit order, so a creator cannot stall. The adapter receives the arrangement value; MintTime/Number sorting happens in the adapter (insertion sort over 80). Covered by `test/Arrangement.t.sol` (8 tests). **Should be included in the external audit.**

### Added after the review: eligibility (updated: sets)

Trait rules are now sets: `Filter.palettes` (uint16, bit = C|M|Y|K mask of the combination), `prints` (uint8, bit per registration kind), `weights` (uint8), `eights` (uint32, bit n = n eights); 0 means any. `passes()` derives each value from `CreditArt.describe` and tests the bit, so "cyan or black" and "with any number of eights" are single onchain rules. Label lookups use a bounded `_index` over a constant list. Covered by `test/TestCredits.t.sol::test_FilterAcceptsSets` and the eligibility suite.


`Filter` gained a payment window (`paidFrom`/`paidTo`, via `timestampOf`) and a number range; `initialize` takes an allowlist of up to 200 ids stored in a mapping (bounded loop, duplicates tolerated, backwards ranges rejected). `passes()` checks allowlist → range → window → traits, so the expensive `describe` call happens last. Covered by `test/Eligibility.t.sol` (8 tests).

### Accepted / documented

- **The assembler is the trust boundary.** It is immutable and set at factory deploy. It is now isolated from Batch storage and its result is verified, but it holds operator rights over the batch's Credits for the duration of `assemble()`. The mainnet adapter must be reviewed before deploy.
- A depositor that is a contract without `receive()` cannot be paid; `claim()` reverts for them and there is no alternate recipient by design (ERC721 gives no other attribution). Self-inflicted.
- `settle()` after `RESERVE_WINDOW` lets a 1 wei bid start the 24 h clock. Design: the reserve is a 7-day option, not a floor forever.
- Slither Mediums not acted on: rounding in `settle()` is intentional (dust to the protocol fee; fuzz proves the split is exact); `ownerOf` return is intentionally unused inside `try/catch`.
- Fees are adjustable by the fee recipient within hard caps (protocol 5 %, creator 10 %, sweep 5 %). A batch snapshots both sale fees in `initialize` and settles on those, so a change cannot reach a batch anyone has already joined; the sweep fee is part of every quote and covered by the caller's `msg.value` check, so a raise between quote and purchase makes the sweep revert (`FeeNotCovered`) rather than overcharge. The fee recipient itself is immutable.

### Hypotheses checked and rejected (summary)

ETH accounting under mixed reverting/gas-burning receivers; reentrancy via refund callbacks, `claim`, the assembler call and ERC721 hooks; Expired as a terminal state; 80th-slot races; clone initialisation races; uint64 casts; factory moving anyone else's Credits or into a non-batch; the Sweeper's factory approval being usable by others; Seaport overspending `msg.value`; malicious order shapes (ERC20/ERC721 consideration, criteria, partial fills, contract orders, offerer == Sweeper, zero amounts, duplicate orders, invalid signatures); XSS via chain/ENS/OpenSea data; secret leakage in errors; open redirects; malicious injected providers.

### Buy-in rehearsal on a mainnet fork (Sept 24)

`DeployMainnet` run against a fork of mainnet: 60.1 M gas over 14 txs; every § 3 sanity check passes; the constructor-args encodings in LAUNCH.md match the deployed bytecode byte for byte. A real OpenSea quote surfaced a listing that passed the on-chain liveness check (owner, approval) yet was dead on OpenSea's side (`Order not valid`, a gasless cancel). The Worker now skips such listings and backfills with the next cheapest instead of failing the quote. A 5-Credit sweep through the real Seaport then went through with no page errors.

### Ratings (score table)

`Ratings.sol` freezes Jack's official rating (methodology v3.4.0, ×10 as uint16) for all 122,154 Credits in 11 SSTORE2-style data contracts read with `EXTCODECOPY`. It is pure data: no owner, no setters, no external calls. The constructor rejects a chunk whose code length does not match the expected `1 + 2 × ids`, so a truncated or padded table cannot be deployed. `scoreOf` returns 0 for id 0 or ids past `count`, which a rating rule treats as "does not qualify". `Batch` reads it only inside `passes()` after the cheaper checks, through the factory's immutable `ratings()`; a factory deployed without a table rejects rating rules at `create` (`BadFilter`) rather than silently admitting everything. The generated `data/scores.bin` is checked against jack.art (score and rank) in `Ratings.t.sol` and `web/scripts/edition.ts`.

## Round 2 (Sept 24, after fees became adjustable and the score table went onchain)

| Track | What | Result |
|---|---|---|
| Static analysis | Slither 0.11.6 and Aderyn 0.6.8 on the core sources | Slither: 0 High, 3 Medium (the same intentional ones as round 1). Aderyn: 4 "High" flags, all false positives on inspection (packed init code, not a hash; refunds/claims exist; guarded book-then-move; storage array passed by copy). |
| Adversarial review | Three fresh reviewers: fees + Ratings, Worker + site, full Batch lifecycle | 0 High, 2 Medium (Worker), 5 Low, 6 Info; all fixed below. 42 new tests in `test/Adversarial2.t.sol` and `test/Adversarial3.t.sol`. |
| Fork rehearsal | `DeployMainnet` on a mainnet fork, then a real OpenSea quote and sweep through the site | 60.1 M gas / 14 txs; found the dead-listing quote failure (fixed) |
| Verification | Sourcify on all four Sepolia contracts | Works without an Etherscan key |
| Live Credits | Source fetched from Sourcify: OZ v5, `burn` → `_burn`, `ownerOf` reverts on a burned id | The post-assembly `CreditsNotBurned` check is correct for mainnet |

### Fixed

| # | Sev | Finding | Change |
|---|---|---|---|
| R2-1 | Med | Rate-limit keys were the raw IP: one IPv6 /64 gives an attacker 2^64 fresh limits. | Keys are the IPv4 address or the IPv6 /64. |
| R2-2 | Med | An uncached listing scan cost up to ~2,000 individual RPC calls, and concurrent quotes for one batch each ran their own scan. | Rules (`passes`) are checked before any liveness call; one scan per batch at a time, shared by requests that arrive during it (kept alive with `waitUntil`); fill data cached 20 s per listing. |
| R2-3 | Low | `Sweeper.setFee` raised between quote and purchase charged the new rate on partial fills (the unspent ETH of sold-out listings covered it). | `sweep(…, maxFeeBps)`: reverts `FeeChanged` if the rate rose above what the buyer was quoted. |
| R2-4 | Low | The fee recipient could front-run a `create()` with `setFees` at the caps and that batch would keep them. | `create(…, expectProtocolFeeBps, expectCreatorFeeBps)` reverts `FeesChanged` on any mismatch; the site passes what it showed. |
| R2-5 | Low | The ERC721 hook accepted a `data` beneficiary of the batch itself, the factory or another batch (which `depositFor` already refused), stranding that share's ETH forever. | The hook applies the same sink rule (`NoDepositor`), and refuses a mint hook (`from == 0`). |
| R2-6 | Low | The creator's 1-day ordering window ran from `filledAt`, so every batch that filled during the staged launch had lost it by activation. | The window runs from `max(filledAt, assemblerActiveAt)`. |
| R2-7 | Low | `usable()` did not pin the Seaport version or the ERC721 amount; a 1.5 listing or amount ≠ 1 would revert the whole sweep at execution. | Only `protocol_address == Seaport 1.6` and `startAmount == endAmount == 1`. |
| R2-8 | Low | `/rpc` forwarded params verbatim (state overrides, gas/value, archive block tags, full-transaction blocks on the paid key). | Params are rebuilt per method: `eth_call → [{to, data}, 'latest']`, `eth_getBlockByNumber → [tag, false]`, hashes validated, nothing else. |
| R2-9 | Low | `/ratings` never cached misses; a list of bogus ids was a free RPC amplifier. | Misses cached 60 s; ids bounded to 1e7. |
| R2-10 | Low | No body cap on `/edition/match` and `/ratings`; `/rpc` buffered before checking. | All three read through a 16 KB / 64 KB capped stream. |
| R2-11 | Low | A rate limit or malformed fill mid-quote discarded the good orders already collected. | Malformed fills are skipped like dead listings; an upstream error returns the partial quote if any. |
| R2-12 | Info | `Ratings` accepted a chunk count that did not cover `count` (in-range `scoreOf` could panic). | Constructor requires exactly `ceil(count / 12000)` chunks. |
| R2-13 | Info | A max-only rating rule admitted ids missing from the table (score 0). | Score 0 never satisfies a rating rule. |
| R2-14 | Info | Chunk contents are trusted at deploy time. | `script/CheckRatings.s.sol` hashes the onchain chunks against `data/scores.bin`, checks `count` against Credits and `isSealed`; in the runbook. |

### Accepted / documented (round 2)

- The fee recipient is now an admin key: `setFees` and `Sweeper.setFee` within the caps, plus receiving fees, dust and rescued strays. It cannot touch any batch, pooled Credit or the assembler. Use a multisig.
- Scan cache (30 s) residual: a seller can revoke or transfer after the scan; the sweep skips or reverts at simulation. Same class as S2.
- `/ens`, `/art`, `/config.json` are usable cross-site (cached, rate limited); the quote endpoint's same-site check is defence in depth, the key never leaves the Worker and no CORS headers are set.
- `style-src 'unsafe-inline'` remains for the inline widths on sheets and bars.

### Added after round 2: Early-bird split

Per-batch `Split { Equal, Early }` fixed at `initialize`. Early: position i (0-based, deposit order) earns `237 − 2i` units of `net / 12,640` (= 80 × 158), i.e. 1.5 shares at the first slot down to 0.5 at the last; Equal is unchanged (`net / 80` per share, same dust rule). `unitsOf()` walks `_ids` at claim time (≤ 80 SLOAD pairs, ~460k gas worst case for a back-of-line depositor, early exit once all of a depositor's Credits are found). Early dust is < 12,640 wei (vs < 80 on Equal), all of it to the protocol fee. `payoutPerShare()` on Early is the average share (a position pays 0.5–1.5× it); `claimable()` is exact. A fourth reviewer pass (`test/Adversarial4.t.sol`, 15 tests: 80-depositor conservation, churn fuzz, exit-window churn, hook beneficiaries, `assembleOrdered` not moving payout positions, reentrant claim) found nothing exploitable; `settle()` does no extra work. Positions shift on withdraw exactly as `_ids` does, so leaving forfeits the slot and re-depositing joins at the back; `depositFor` (the Sweeper) takes the next slots for the buyer. `test/Split.t.sol`: weights, shifting, Sweeper positions, Equal unchanged, and a fuzz over any bid and any three-way division proving payouts + fee == bid exactly.

### Added after round 2: palette layouts

`Filter.layout0/layout1` hold 80 × 4-bit palette masks (0 = any). A layout batch (`Arrangement.Layout`) keeps `_slots[p]` (slots wanting p), `_have[p]` (Credits of p in), `anySlots` and `overflow` = Σ max(0, have − slots). `_add` refuses a Credit whose palette has no painted slot left once `overflow == anySlots` (`NoSlot`); `withdraw` undoes the count. Invariant `overflow ≤ anySlots` plus Σ have = 80 at Full gives deficit 0, so `layoutOrder()` (painted slots take the earliest deposit of their palette, any slots the rest) always completes; `assemble()` burns in that order after the creator's day, and `assembleOrdered` lets the creator swap only within a palette (`LayoutMismatch`). `test/Layout.t.sol`: enforcement, withdraw, any-slot overflow, order, creator reorder, and a fuzz over random layouts and deposit/withdraw sequences proving every Full layout batch burns.

## Before mainnet

1. Write `JackAssembler` against the published Statement contract; add fork tests against it.
2. Independent audit of `Batch.sol`, `BatchFactory.sol`, `Sweeper.sol` and the adapter.
3. Deploy with `PROTOCOL_FEE_BPS`/`SWEEP_FEE_BPS` decided; verify sources on Etherscan/Sourcify.


## Change: unlock after fill (branch `unlock-after-fill`, not yet reviewed)

Replaces the deadline/Expired model. Open batches no longer expire (`duration` is still validated and stored but
not enforced, so the factory interface is unchanged). The 80th deposit sets `filledAt`; `unlocksAt() = filledAt +
UNLOCK_AFTER` (7 days). `withdraw` is allowed while Open, from Full once `block.timestamp >= unlocksAt()`, and in
the exit window as before. An unlocked Full batch can still be assembled while all 80 remain; a withdrawal drops it
to Open. The lock runs once, from the first fill: a refill never re-locks (otherwise a depositor could leave and
rejoin in one transaction to keep everyone else locked indefinitely). `State.Expired` is never returned (kept so enum values don't shift).
`effectiveDeadline()` now returns `unlocksAt()`, and `summary().deadline` carries it. `FILL_GRACE` and the
activation extension are gone: a batch that filled before activation simply waits (unlocked) and is burnable the
moment the assembler is active. Tests updated: Batch, Adversarial3/4/5, Staged, Audit; five new unit tests
(open never expires, fill starts lock, unlock lets depositors leave, unlocked batch still assembles, refill
does not relock). To review: the creator's-order grace (1 day from max(fill, activation)) can now overlap an unlocked
batch, where a depositor may leave before the creator burns. The creator's grace
also keys off the first fill.
