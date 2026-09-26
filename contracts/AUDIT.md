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

`DeployMainnet` run against a fork of mainnet: 60.1 M gas over 14 txs; every § 3 sanity check passes; the constructor-args encodings match the deployed bytecode byte for byte. A real OpenSea quote surfaced a listing that passed the on-chain liveness check (owner, approval) yet was dead on OpenSea's side (`Order not valid`, a gasless cancel). The Worker now skips such listings and backfills with the next cheapest instead of failing the quote. A 5-Credit sweep through the real Seaport then went through with no page errors.

### Ratings (score table)

`Ratings.sol` freezes Jack's official rating (methodology v3.4.0, ×10 as uint16) for all 122,154 Credits in 11 SSTORE2-style data contracts read with `EXTCODECOPY`. It is pure data: no owner, no setters, no external calls. The constructor rejects a chunk whose code length does not match the expected `1 + 2 × ids`, so a truncated or padded table cannot be deployed. `scoreOf` returns 0 for id 0 or ids past `count`, which a rating rule treats as "does not qualify". `Batch` reads it only inside `passes()` after the cheaper checks, through the factory's immutable `ratings()`; a factory deployed without a table rejects rating rules at `create` (`BadFilter`) rather than silently admitting everything. The generated `data/scores.bin` is checked against jack.art (score and rank) in `Ratings.t.sol` and `web/scripts/edition.ts`.

## Round 2 (Sept 24, after fees became adjustable and the score table went onchain)

| Track | What | Result |
|---|---|---|
| Static analysis | Slither 0.11.6 and Aderyn 0.6.8 on the core sources | Slither: 0 High, 3 Medium (the same intentional ones as round 1). Aderyn: 4 "High" flags, all false positives on inspection (packed init code, not a hash; refunds/claims exist; guarded book-then-move; storage array passed by copy). |
| Adversarial review | Three fresh reviewers: fees + Ratings, Worker + site, full Batch lifecycle | 0 High, 2 Medium (Worker), 5 Low, 6 Info; all fixed below. 42 new tests in `test/audit/Adversarial2.t.sol` and `test/audit/Adversarial3.t.sol`. |
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

Per-batch `Split { Equal, Early }` fixed at `initialize`. Early: position i (0-based, deposit order) earns `237 − 2i` units of `net / 12,640` (= 80 × 158), i.e. 1.5 shares at the first slot down to 0.5 at the last; Equal is unchanged (`net / 80` per share, same dust rule). `unitsOf()` walks `_ids` at claim time (≤ 80 SLOAD pairs, ~460k gas worst case for a back-of-line depositor, early exit once all of a depositor's Credits are found). Early dust is < 12,640 wei (vs < 80 on Equal), all of it to the protocol fee. `payoutPerShare()` on Early is the average share (a position pays 0.5–1.5× it); `claimable()` is exact. A fourth reviewer pass (`test/audit/Adversarial4.t.sol`, 15 tests: 80-depositor conservation, churn fuzz, exit-window churn, hook beneficiaries, `assembleOrdered` not moving payout positions, reentrant claim) found nothing exploitable; `settle()` does no extra work. Positions shift on withdraw exactly as `_ids` does, so leaving forfeits the slot and re-depositing joins at the back; `depositFor` (the Sweeper) takes the next slots for the buyer. `test/Split.t.sol`: weights, shifting, Sweeper positions, Equal unchanged, and a fuzz over any bid and any three-way division proving payouts + fee == bid exactly.

### Added after round 2: palette layouts

`Filter.layout0/layout1` hold 80 × 4-bit palette masks (0 = any). A layout batch (`Arrangement.Layout`) keeps `_slots[p]` (slots wanting p), `_have[p]` (Credits of p in), `anySlots` and `overflow` = Σ max(0, have − slots). `_add` refuses a Credit whose palette has no painted slot left once `overflow == anySlots` (`NoSlot`); `withdraw` undoes the count. Invariant `overflow ≤ anySlots` plus Σ have = 80 at Full gives deficit 0, so `layoutOrder()` (painted slots take the earliest deposit of their palette, any slots the rest) always completes; `assemble()` burns in that order after the creator's day, and `assembleOrdered` lets the creator swap only within a palette (`LayoutMismatch`). `test/Layout.t.sol`: enforcement, withdraw, any-slot overflow, order, creator reorder, and a fuzz over random layouts and deposit/withdraw sequences proving every Full layout batch burns.

## Before mainnet

1. Write `JackAssembler` against the published Statement contract; add fork tests against it.
2. Independent audit of `Batch.sol`, `BatchFactory.sol`, `Sweeper.sol` and the adapter.
3. Deploy with `PROTOCOL_FEE_BPS`/`SWEEP_FEE_BPS` decided; verify sources on Etherscan/Sourcify.


## Round 3: unlock after fill, Bits, Creator order retired (branch `unlock-after-fill`, Sept 25)

**What changed.** The deadline/Expired model is replaced. Open batches never expire (`duration` is still validated
and stored so the factory interface is unchanged, but nothing reads it). A full batch is locked until `unlocksAt()`,
then any depositor may withdraw (dropping it back to Open); while all 80 remain it can still be assembled.
`State.Expired` is never returned (kept so enum values don't shift). `effectiveDeadline()` and `summary().deadline`
carry `unlocksAt()`. The filter gains a Bits range (`bitsFrom`/`bitsTo` against Jack's `marks`; 0 = unbounded; a
reversed range is `BadFilter`). The Creator arrangement is retired: `initialize` reverts `ArrangementRetired`,
`assembleOrdered` and the creator's grace are gone, and Layout batches are burnable by anyone the moment they fill.

**Method.** A line-by-line read of the diff, the full suite, and a separate adversarial pass with proof-of-concept
tests (`test/audit/AuditBranch.t.sol`).

**Fixed (medium).**
- *The lock could be spent before burning was possible.* With the lock counted only from the first fill, a batch
  that filled during the staged launch and waited more than 7 days for the assembler was already unlocked when it
  first became burnable, so any one depositor could veto the burn by withdrawing ahead of `assemble()`. Now
  `unlocksAt() = max(filledAt, assemblerActiveAt) + UNLOCK_AFTER`: every batch gets one full lock in which it can
  actually be burned. Activation happens once, so this can't re-lock twice. (`test_LockRunsFromActivation`)
- *Fill-and-leave during the exit window spent the lock.* The exit window lets a Full batch be withdrawn from, so an
  outsider could deposit the 80th Credit and withdraw it in one block, setting `filledAt`; the real fill weeks later
  would already be unlocked. Leaving a batch whose lock has not lifted (only possible in the exit window) now clears
  `filledAt`, so the next real fill locks. Harmless as a re-lock: while the window is open anyone may leave
  regardless. (`test_ExitWindowFillAndLeaveKeepsLock`; `Adversarial3.test_ExitWindowWithdrawThenRefillLocksAgain`)

**Changed by decision: the exit window is 30 minutes (was 3 days).** `ASSEMBLER_DELAY` is now 30 minutes so burning
can start the day Jack's contract ships. The window is still the only defence against a bad or stolen-key adapter
(a malicious adapter could burn real Credits and hand the batch a fake Statement), so it now leans on the setter
being a multisig and on people watching for the proposal. The re-lock at activation still gives every full batch
7 days to burn.

**Accepted.**
- Once the lock has lifted, a single depositor can keep front-running `assemble()` with a withdrawal and rejoin,
  and a refill never re-locks (by design, so nobody can re-lock others). Milder than the old Expired state, which
  ended the batch; a private relay defeats it. Refill after unlock keeps the original `unlocksAt()`
  (`test_RefillAfterUnlockDoesNotRelock`).
- Bits: 0/0 means no filter, so `marks == 0` exactly can't be targeted; `bitsTo` alone admits 0. `bitsTo > 256` is
  accepted and harmless.
- `Filled` re-emits the original unlock time on a refill after unlock.

**Checked and clean.** Withdraw during assembly (`nonReentrant`, `_assembling`); assemble when not full; unlock and
assemble in the same block (first transaction wins cleanly); layout counts on withdraw after unlock; Early-bird
weights recomputed from the final order; storage (`bitsFrom`/`bitsTo` pack into `layout1`'s slot, clones are fixed
to one implementation); a Sweeper buy into a batch that just filled reverts whole, Seaport purchase included.

Tests: full suite green except the pre-existing `Adversarial2.test_ConstructorRejectsBadLengths` (Ratings reports
`BadCount` before `BadChunk` for one case; unrelated to this branch).

## Round 4: paint with any one trait (Sept 25)

**What changed.** A layout can paint any one of Jack's traits, not only Colors: `Filter.layoutTrait` picks it
(0 Colors, 1 Eights, 2 Print, 3 Weight, 4 Plates) and each 4-bit slot holds 1 + that trait's value, 0 = any.
`paletteOf` is now `keyOf` (a deposited Credit's value of the painted trait). One trait per sheet, on purpose:
every Credit has exactly one value of each of these traits, so the existing slot books (have / slots / overflow
against the any slots) still guarantee a batch stays fillable and `layoutOrder()` always completes. Mixing traits
per slot would make Credits fit several slots and need a matching step at deposit.

**Validation.** `initialize` rejects an unknown trait, a slot value above the trait's range (a slot no Credit could
fill: Colors 15, Eights 9, Print 6, Weight 4, Plates 4), and a `layoutTrait` without a layout.

**Tests.** Plates and Eights layouts fill, refuse a Credit with no slot left, and burn in painted order;
validation cases revert `BadFilter`. The mock art now varies Eights so these are testable. Full suite: 170 of 171,
the one failure the pre-existing Ratings test above.

## Round 5: full re-read after layoutTrait (Sept 26)

**Scope.** Every file in `src/` (Batch, BatchFactory, Sweeper, Ratings, MockAssembler, interfaces, mocks, vendored
art) read in full; rounds 1–4 re-verified against the current code; proofs in `test/audit/Audit5.t.sol`.

**Re-verified, still holding.** B1 (assembler called, approval scoped, burn + Statement ownership checked), B2/B6
(rescue refuses pooled Credits and the Statement, before and after sale; book-then-move), B3/R2-5 (hook beneficiary,
sink rule, mint hook refused), B4 (settle try/catch + `claimStatement`), S1/S3/S4/R2-3/R2-4 (Sweeper `spent` from
executions, sink rule, no receiver hook, `maxFeeBps`, `expect*FeeBps`), round 3 (`unlocksAt` from
`max(filledAt, assemblerActiveAt)`, exit-window leave clears `filledAt`), round 4 (trait range validation; `_keyOf`
stays ≤ 15 for every trait against the real `CreditArt`, so `_have`/`_slots` can't go out of bounds). Clones can't be
re-initialised; the implementation is locked. ETH conservation on a Plates layout lifecycle is exact.

| # | Sev | Finding | Proof | Fix |
|---|---|---|---|---|
| R5-1 | Low | `minBid()` (`Batch.sol:611`) returns `reserve` whenever it is non-zero, so a reserve below `MIN_RAISE` *lowers* the floor: with reserve 1 wei a 1 wei bid starts the 24 h clock and, unanswered, buys the Statement. With reserve 0 the floor is 0.01 ETH. A creator typing a "small floor" makes the batch cheaper to snipe than no floor. | `test_R5_1_ReserveBelowFloorRejected` (positive: `test_R5_1_ValidReservesStillWork`) | **Fixed.** `initialize` reverts `ReserveTooLow` when `0 < reserve < MIN_RAISE`; 0 and 0.01 ETH and up still work. |
| R5-2 | Low | Eights layouts accept slot values up to 9 (`_topKey`, `Batch.sol:478`), but the real edition tops out at 5 eights (1 Credit; 26 have 4; from `web/public/edition-traits.bin`). Values 7–9 can never fill, 6 at most once. The batch is accepted, takes deposits, and can never reach 80. No funds at risk (Open batches are always withdrawable) but depositors' Credits sit in a dead party. Round 4's "rejects a slot no Credit could fill" is true per trait range, not per edition. | `test_R5_2_EightsLayoutAboveEditionRejected` (positive: `test_R5_2_EightsLayoutValueSixAccepted`) | **Fixed.** `_topKey` returns 6 for Eights (0 to 5 eights); `web/src/shared/layout.ts` `TOP[1]` is 6 to match (the painter already offered only 0 to 5). The per-value supply cap in the painter is not done. |
| R5-2b | Info | The layout isn't checked against the filter (`Batch.sol:264–276`): a painted value the filter excludes (K slot on a CMY-only batch; an Eights slot outside `eights`; Print/Weight likewise) makes the batch unfillable from creation. | `test_R5_2b_LayoutContradictingFilterRejected` (positive: `test_R5_2b_ConsistentLayoutAndFilterAccepted`) | **Fixed.** `initialize` builds the set of values the filter admits (`_filterKeys`: Colors on `palettes`, Eights/Print/Weight on bit `p - 1` of `eights`/`prints`/`weights`, Plates on the ink counts of the allowed palettes) and reverts `BadFilter` on any painted value outside it. |
| R5-3 | Info | `withdraw([])` (`Batch.sol:388–395`) by anyone, depositor or not, during the exit window zeroes `filledAt` on every locked Full batch. Nothing moves and activation still re-locks from `assemblerActiveAt`, but `filledAt` reads 0 on a Full batch and, after unlock, the next leave-and-refill re-locks for 7 more days (normally a refill never re-locks). | `test_R5_3_StrangerEmptyWithdrawRejected` (control: `test_R5_3_ControlRefillWithoutResetStaysUnlocked`) | **Fixed.** `withdraw` reverts `NothingToClaim` on empty `ids`. `Adversarial3.test_WithdrawDuplicatesAndForeignIdsRevert` now expects that revert. |

**Measured.** `create` with 40 Credits into a Layout batch with a trait filter on the real art (describe runs twice per
Credit: `passes()` and `_keyOf()`): 11.3 M gas. The "~40 per call" guidance holds.

**Still accepted (unchanged).** The setter/adapter is the trust boundary: a malicious adapter can burn a batch's 80,
keep the real Statement and hand the batch a fake one (`statement()` is the adapter's own answer); the 30-minute exit
window is the only defence. A Statement with no bid is held until someone bids 0.01 ETH. Unlocked batches can be
vetoed by a withdraw front-run. A share gifted (hook `data`, `depositFor`) to a contract that can't take ETH, the
Sweeper included, strands that share's ETH.

**Checked and clean.** Refund/claim/owed accounting under reverting and gas-burning receivers; bid/settle boundary
(`ts < auctionEnd` vs `ts >= auctionEnd`); anti-snipe arithmetic can't underflow; Early and Equal dust all to the
protocol fee; rescue re-entry via a hostile token (only reaches the hook, which is an ordinary deposit); try/catch gas
griefing in `settle` and the burn check (the 1/64 left over can't finish the call); `layoutOrder()` completeness with
trait keys 10–15 (Eights ≥ 9) and Colors mask 0 always going to any slots; uint8 books (max 80); factory only moves the
caller's Credits; Sweeper `spent ≤ msg.value` and self-paid consideration filtered by Seaport.

## Round 6: independent adversarial re-read (Sept 26)

**Scope.** Every file in `src/` read line by line (Batch, BatchFactory, Sweeper, Ratings, MockAssembler, interfaces,
mocks, vendored CreditArt/CreditDrawing), with rounds 1 to 5 treated as unverified. Proofs in `test/audit/Audit6.t.sol`.

**Round 5 fixes, re-verified.**
- `ReserveTooLow` (`Batch.sol:266`): a fuzz over any reserve shows `create` succeeds exactly when the reserve is 0 or
  at least 0.01 ETH and stores it unchanged; for 0, 0.01 ETH and 3 ETH the opening floor after assembly is never
  below 0.01 ETH and is exactly 0.01 ETH once the reserve window lapses. No legit path passes a small reserve: the
  site sends 0 (`create.ts`), `SeedDemo` uses 0, 0.5 and 1 ETH, the factory has no default.
  (`testFuzz_R6_ReserveRuleExact`, `test_R6_OpeningFloorNeverBelowMinRaise`)
- `_topKey` Eights = 6 (`Batch.sol:483`): matches `web/src/shared/layout.ts` `TOP[1]`; values 7 and up are refused.
- `_filterKeys` (`Batch.sol:490`): checked against an independent model for every trait, random trait rules, any
  painted value (1 to 15) and any of the 80 slots, including `layout1`. Colors uses bit `p`, Eights/Print/Weight bit
  `p - 1`, exactly as `passes()` tests them; no off-by-one. Plates maps each palette to its ink count, checked
  exhaustively for all 15 single-palette filters; the real art's `colors` string is one letter per enabled plate,
  so `bytes(colors).length` equals the popcount used here. In the other direction, on the real `CreditArt` with
  random rules, every Credit that passes the filter has a value the check admits and deposits into its painted
  slot, so the fix never refuses a fillable layout. The check is 15 iterations at most; no gas concern. It cannot be
  bypassed: `initialize` is the only writer of `_filter` and runs once.
  (`testFuzz_R6_FilterKeysMatchesModel`, `test_R6_PlatesMappingExhaustive`,
  `testFuzz_R6_FilterKeysAdmitsEveryPassingCredit` and its non-vacuity check)
- Empty `withdraw` (`Batch.sol:394`): reverts in Open as well as Full (harmless). A stranger passing a non-empty
  list hits `NotDepositor` and the `filledAt` reset rolls back with it; only a real leave in the exit window resets
  it. (`test_R6_FilledAtResetOnlyByARealLeave`)

| # | Sev | Finding | Proof | Fix sketch |
|---|---|---|---|---|
| R6-1 | Info | The R5-2b check (`_filterKeys`, `Batch.sol:490`) looks only at the painted trait's own rule. The Bits range can still exclude a painted value outright: a Credit with n inks has at most 64n marks, so `bitsFrom = 65` rules out every 1-ink Credit (a C/M/Y/K Colors slot, a Plates 1 slot), and `bitsFrom = 137` rules out every "even" Credit (even needs marks at most 136/256 of capacity). Such layouts are accepted and can never fill. Same class and impact as R5-2b: nothing is lost, Credits sit in a dead party. Joint rules (e.g. a K slot plus a Print rule no K Credit has) are not decidable onchain and stay with the painter. | `test_R6_1_BitsRangeMakesPaintedValueImpossible` (real art, 200 Credits: accepted; no 1-ink or even Credit passes) | In `initialize`, for Colors/Plates layouts clear any painted value whose ink count n has `64n < bitsFrom`; for Weight, clear "even" when `bitsFrom > 136`, "lean" when `bitsFrom > 144`, "sparse" when `bitsFrom > 160`. Or leave it to the site and document. |
| R6-2 | Info | `initialize` accepts filters that can never admit 80 Credits: an allowlist of 1 to 79 ids, an id range narrower than 80 (`idTo - idFrom < 79`), `bitsFrom > 256` (256 is the most marks a Credit has), or `palettes == 1` (only mask 0; every Credit has at least one ink). The batch opens, takes the creator's `minOpen` Credits and joiners, and can never burn. Open batches are always withdrawable, so nothing is lost. | `test_R6_2_FiltersThatCanNeverFill` (79-id allowlist fills to 79, the 80th is `Excluded`; the others accepted and, on the real art, nothing passes) | `BadFilter` when `allowlistSize != 0 && allowlistSize < SIZE`, `idTo != 0 && idTo - idFrom + 1 < SIZE`, `bitsFrom > 256`, or `palettes == 1`. One comparison each. |

**Fixed.**
- R6-1 Fixed: `_filterKeys` now also drops painted values the Bits range rules out (`_bitsKeys`): Colors/Plates with n inks when `64n < bitsFrom`, Weight per ink count against the exact CreditArt bands (even 30..136, lean 28..144, sparse 24..160, extreme 0..256, with the gaps between ink counts), so both `bitsFrom` and `bitsTo` count; exact against a brute-force model, and on the real art every passing Credit is still admitted. (`test_R6_1_BitsRangeMakesPaintedValueImpossible`, `test_R6_1_WeightBoundsExact`, `testFuzz_R6_1_BitsKeysMatchModel`, `testFuzz_R6_1_BitsNeverRefusesAPassingCredit`)
- R6-2 Fixed: `initialize` reverts `BadFilter` for a deduped allowlist of 1 to 79, `idTo != 0 && idTo - idFrom + 1 < 80`, `bitsFrom > 256` and `palettes == 1`; exactly 80 listed ids or numbers still fills. The create page blocks both narrow cases before submit. (`test_R6_2_FiltersThatCanNeverFill`, `test_R6_2_BoundaryFiltersStillWork`)

No Critical, High, Medium or Low findings.

**Checked and sound.**
- ETH conservation: `settle` books `per * units + creatorFee + fee == highBid` exactly (dust into `fee`); Early
  weights `237 - 2i` sum to 12,640; `_ids`, `depositorOf` and `sharesOf` are frozen once a Statement exists (every
  writer requires Open or Full), so the sum of `unitsOf` is the split's total at claim time. Owed refunds stay in
  the balance until pulled; nothing reads `address(this).balance`.
- Reentrancy: every mutating entry point is `nonReentrant` except `onERC721Received`, which only accepts Credits
  (or anything while `_assembling`) and requires Open. Callbacks from refunds (50k gas), `claim`/`withdrawOwed`
  (all gas), `rescue` of a hostile token, and the assembler all find either the guard or a closed state. Withdraw
  and the factory's `_move` use plain `transferFrom` (no hook). Transient guard slots are per clone.
- Griefing under limited gas: `bid` refunds can't be starved (the caller needs about 1.6 M gas left for the owed
  write, which gives the callee the full 50k); `settle`'s try/catch and the burn check can't be pushed into their
  catch branches with enough gas left to finish; `claim` reverts whole on a failed send.
- State machine: at most 80 ids (every push is behind `_require(Open)`); a two-id deposit at 79 reverts whole;
  `filledAt` is never 0 on a Full batch now; exit window exists only before any assembler is active, so it can't
  race `assemble`; `exitWindowOpen` stays true after `pendingUntil` until someone activates (withdrawals stay open,
  burning stays impossible); the setter can restart the window but each proposal gets the full 30 minutes.
- Layout books: `overflow <= anySlots` plus 80 ids gives zero deficit, so `layoutOrder()` completes and hands the
  adapter 80 distinct held ids; on an Open batch the view can't index out of bounds (unused ids always cover the
  any slots seen so far). Keys stay at most 15, mask 0 and Eights 6+ go to any slots.
- Factory and clones: `create` initialises in the same transaction; the implementation is locked (`factory = 1`)
  and has no `selfdestruct`/`delegatecall`; fees are snapshotted and guarded by `expect*FeeBps`; `feeRecipient`,
  `ratings`, `credits` are immutable; `depositFor` only moves the caller's Credits.
- Sweeper: `spent` from Seaport's executions; duplicate listings for one Credit revert the whole fill; seller
  callbacks that fill the batch make `depositFor` revert the purchase with it; ETH sent to the Sweeper outside a
  sweep never enters `left`.
- Ratings: little-endian decode and chunk bounds; out-of-range ids read 0.

**Still accepted (unchanged).** The adapter/setter trust boundary and the 30-minute window; the post-unlock
withdraw veto; zero-bid Statements held until a 0.01 ETH bid; shares gifted to contracts that can't take ETH (the
Sweeper included) strand that ETH; plain-`transferFrom` strays go to the fee recipient via `rescue`; per-value
edition supply in the painter.

Tests: `test/audit/Audit6.t.sol` 13 of 13 pass. Full suite: 194 of 195, the one failure the pre-existing
`Adversarial2.test_ConstructorRejectsBadLengths`.
