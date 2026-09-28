# Credit Union: formal verification (Halmos)

| | |
|---|---|
| Commit | `bcf9a04`: the contracts deployed on mainnet. `DEPLOY.md` records the deploy from contracts as of `fc506e8`, and `src/` and `test/formal/` are identical at `bcf9a04`. Every rule below was rerun there. |
| Build | `forge build` in a fresh clone of `bcf9a04`: exit 0 (forge 1.7.1, solc 0.8.28, via-IR), warnings only. |
| forge test | Not rerun for this report. `DEPLOY.md` records 264 passed, mainnet forks included, on the deploy commit (`880b3fc`, contracts as of `fc506e8`). |
| Halmos | 0.3.3 (`uv tool install halmos`). Default solver Yices 2.6.4; Bitwuzla 0.8.1 for the payout math. |
| In scope | `Batch.sol`, `BatchFactory.sol`, `Sweeper.sol`, `Ratings.sol` |

**Result: 51 rules proved, 0 broken, 5 timed out.** What the timeouts leave unproven: that each outbid clears the last bid by 5% (`check_outbidRaisesEnough`; the refund proved, and `test/Batch.t.sol:309` checks the 5% step with one concrete bid, 3 ETH then 3.15 ETH minimum), and that settle's fees are at least the protocol fee (part of `check_settleConservesEth`, whose other parts proved). Everything else the timed-out rules check was split into smaller rules that proved.

## What "proved" means here

Every argument to a `check_` function is symbolic: Halmos proves the rule for every caller, amount and timestamp, not a sample. Limits you should know:

- **Mocks stand in for the outside world.** Credits, the Statement, the assembler and FWA's market are the repo's mocks; Seaport and CreditStrategy get small stand-ins here (`FormalSeaport`, `FormalStrategy`), and the score tables are real `Ratings` contracts with scores for 3 Credits. The proofs cover Credit Union's contracts against those, not against mainnet Credits, Seaport, FWA, CreditStrategy or the deployed score table.
- **Fixed starting states.** Most rules start from one concrete setup (an open union, a full one, one in auction) and prove what any single call can do from there. The `invariant_` rules explore sequences of calls by two members, 2 calls deep.
- **Bounds on inputs:** bids and prices ≤ 1e30 wei, time jumps < 30 days (< 365 days in the two notice-delay rules). Arbitrary calls (`createCalldata`) use Halmos's default dynamic lengths (arrays 0-2, bytes 0/65/1024).
- **Loop unrolling.** No single-call rule hit Halmos's loop bound. The invariants were rerun at `--loop 5` to clear that warning (see below).

## Rules


### BatchFactory

| Rule | Why it matters | Result |
|---|---|---|
| `FactoryFormal.check_setFees_onlyFeeRecipient` | A stranger changing fees would change every new union's split. | Proved |
| `FactoryFormal.check_fees_neverAboveCaps` | Fees stay at or under 5% protocol and 10% creator, whoever calls. | Proved |
| `FactoryFormal.check_propose_onlySetter` | Only the named setter can put an assembler up for activation. | Proved |
| `FactoryFormal.check_activate_notBeforeDelay` | Members always get 30 minutes' notice before an assembler that can burn goes live. | Proved |
| `FactoryFormal.check_assembler_fixedOnceActive` | Once live, nobody (the setter included) can swap the contract that burns Credits. | Timed out (wall clock, 10 min): arbitrary calls into create() are too large |
| `FactoryFormal.check_assembler_fixedOnceActive_exceptCreate` | Same rule, every factory function except create(). | Proved |
| `FactoryFormal.check_assembler_fixedOnceActive_create` | Same rule, create() by anyone with any id. | Proved |
| `FactoryFormal.check_factory_neverTakesOthersCredits` | Holders approve the factory for all their Credits, so it must only ever move the caller's own. | Timed out (wall clock, 10 min): same create() blowup |
| `FactoryFormal.check_factory_neverTakesOthersCredits_exceptCreate` | Same rule, every factory function except create(). | Proved |
| `FactoryFormal.check_factory_neverTakesOthersCredits_create` | Same rule, create() by anyone naming any id. | Proved |
| `FactoryFormal.check_depositFor_rejectsSinks` | A share booked to the batch, the factory or address 0 could never be withdrawn or paid. | Proved |

### Batch

| Rule | Why it matters | Result |
|---|---|---|
| `FactoryFormal.check_initialize_once` | Re-initializing a batch or the implementation would let anyone rewrite its terms. | Proved |
| `BatchAccessFormal.check_depositFrom_onlyFactory` | Only the factory, which just moved the Credits in, may book a deposit. | Proved |
| `BatchAccessFormal.check_withdraw_onlyDepositor` | Nobody but the depositor can pull a Credit out. | Proved |
| `BatchAccessFormal.check_outsiderCannotTouchDeposit` | Any call to the batch by anyone else leaves a member's Credit, record and share untouched. | Proved |
| `BatchAccessFormal.check_hook_onlyCredits` | Calling the deposit hook directly can't fake a deposit. | Proved |
| `BatchAccessFormal.check_rescue_neverTakesPooled` | The lost-and-found sweep can't reach a pooled Credit. | Proved |
| `BatchAccessFormal.check_booksMatchHoldings` | After any action by a member, shares equal Credits held, and every booked Credit is really in the batch. | Proved |
| `BatchLockFormal.check_noWithdrawWhileBurnable` | Nobody can yank a Credit out from under a burn in progress. | Proved |
| `BatchLockFormal.check_canLeaveOutsideBurnWindow` | Outside the one-hour burn window a member can always leave: no surprise lock, no lock forever. | Proved |
| `BatchLockFormal.check_burnOnlyInWindow` | The 80 burn only inside [fill + 5 min, fill + 65 min), so there is always notice. | Proved |
| `BatchLockFormal.check_restartAlwaysGivesNotice` | Restarting a lapsed window never locks at once: a fresh 5 minutes every time. | Proved |
| `BatchLockFormal.check_neverMoreThan80` | A full union never takes an 81st Credit by either deposit path. | Proved |
| `BatchAuctionFormal.check_outbidRaisesAndRefunds` | Outbids must raise enough, and the outbid bidder is made whole. | Timed out (Yices 10 min, 30 min no solver limit; Bitwuzla 20 min) |
| `BatchAuctionFormal.check_outbidRefundsExactly` | The outbid bidder gets exactly their bid back; the batch holds only the new high bid. | Proved (Bitwuzla) |
| `BatchAuctionFormal.check_outbidRaisesEnough` | Each outbid is at least 5% and 0.01 ETH higher, so the clock can't be dragged by dust bids. | Timed out (Bitwuzla 20 min) |
| `BatchAuctionFormal.check_bidNeverShortensAuction` | A bid never cuts the auction short, and a late bid leaves at least 15 minutes. | Proved |
| `BatchAuctionFormal.check_noSettleBeforeEnd` | Nobody can close the auction early and take the Statement cheap. | Proved |
| `BatchAuctionFormal.check_settleConservesEth` | Every wei of the sale goes to fees or members; nothing stuck, nothing extra. | Timed out (Yices 10 min, 30 min no solver limit; Bitwuzla 20 min) |
| `BatchAuctionFormal.check_settlePaysOutExactly` | Settle alone pays everyone: fees plus both members' payouts equal the winning bid exactly, the batch ends empty, and nothing is left to claim. | Proved (Bitwuzla) |
| `BatchAuctionFormal.check_equalSplitIsEqual` | Equal split pays equal shares, and the Statement lands with the winner. | Proved (Bitwuzla) |
| `BatchAuctionFormal.check_claimOnce` | A member can't be paid twice. | Proved |
| `BatchAuctionFormal.check_settleOnce` | Settle can't run twice and pay fees twice. | Proved |
| `BatchAuctionFormal.check_claimStatement_onlyWinner` | Only the winner can pull an undelivered Statement. | Proved |
| `BatchAuctionFormal.check_statementStaysDuringAuction` | No call by anyone moves the Statement out before settle. | Proved |
| `BatchEarlyFormal.check_earlySplitConserves` | Early split weights sum to exactly 80 shares, pay out everything, and favor the earlier member. | Proved (Bitwuzla); timed out on Yices |

### Sweeper

| Rule | Why it matters | Result |
|---|---|---|
| `SweeperFormal.check_sweepAllExactAndHoldsNothing` | One sweep across Seaport, FWA and CreditStrategy: a listing is bought only at its quoted price, the buyer pays exactly what they got plus the fee, every Credit is booked to them, and the Sweeper keeps nothing. | Proved |
| `SweeperFormal.check_buyExactAndHoldsNothing` | buy() (straight to the wallet): the buyer owns every Credit bought, pays exactly those listings plus the fee at quoted prices, nothing is deposited, and the Sweeper keeps no ETH and no Credit. | Proved |
| `SweeperFormal.check_buyFeeRaiseNeverSlipsIn` | buy() is held to the quoted fee like sweep(). | Proved |
| `SweeperFormal.check_constructorRejectsOtherStrategy` | The Sweeper can't be wired to a strategy that sells some other collection. | Proved |
| `SweeperFormal.check_setFee_onlyRecipientAndCapped` | Only the fee recipient sets the sweep fee, never above 5%. | Proved |
| `SweeperFormal.check_sweepExactAndHoldsNothing` | A buyer pays exactly the listing price plus the fee, gets the rest back, is booked as depositor, and the Sweeper keeps nothing. | Proved |
| `SweeperFormal.check_feeRaiseNeverSlipsIn` | A fee raised after the quote can't apply to the sweep. | Proved |
| `SweeperFormal.check_sweepOnlyIntoBatches` | Bought Credits only ever go into a real union. | Proved |

### Ratings

| Rule | Why it matters | Result |
|---|---|---|
| `RatingsFormal.check_unknownIdScoresZero` | Unknown ids score 0, which rating filters never admit. | Proved |
| `RatingsFormal.check_knownIdsReadExactly` | Every rated id reads back exactly its stored score. | Proved (id split into its 3 values: Halmos can't take a symbolic EXTCODECOPY offset) |
| `RatingsFormal.check_constructorRejectsWrongCount` | The table only deploys with exactly the data it claims to cover. | Proved |

### Ratings switch

| Rule | Why it matters | Result |
|---|---|---|
| `RatingsSwitchFormal.check_proposeRatings_onlyFeeRecipient` | Only the fee recipient can put a new score table up for activation. | Proved |
| `RatingsSwitchFormal.check_activateRatings_notBeforeDelay` | No new table goes live before its 30 minutes' notice is up, whoever activates it. | Proved |
| `RatingsSwitchFormal.check_ratings_onlyActivateMovesIt_exceptCreate` | With a new table ready, only activateRatings() switches to it: every other factory function except create() leaves the table alone, whoever calls. | Proved |
| `RatingsSwitchFormal.check_ratings_unchangedByCreate` | Same rule, create() by anyone with any id. | Proved |
| `RatingsSwitchFormal.check_create_onlyOnExpectedTable` | A union opens only on the table its creator was shown and records exactly that table, so a switch can't be slipped in front of an opening. | Proved |
| `RatingsSwitchFormal.check_openBatch_keepsItsTable` | After the factory switches, no call by anyone changes an open union's table: its rating rules stay the ones members joined under. | Proved |

### Batch

| Rule | Why it matters | Result |
|---|---|---|
| `BatchInvariantFormal.invariant_sharesMatchCount` | Across call sequences by members: shares always add up to Credits held, never over 80. | Proved (2-call sequences, --loop 5) |
| `BatchInvariantFormal.invariant_booksMatchHoldings` | Across call sequences: a Credit is booked if and only if the batch holds it. | Proved (2-call sequences, --loop 5) |
| `BatchInvariantFormal.invariant_onlyRealDepositors` | Across call sequences: nobody who never deposited shows up on the books. | Proved (2-call sequences, --loop 5) |

## Commands and output

Each rule was run on its own under a wall-clock cap (`test/formal/run.sh <Contract> <seconds>`): 600 s, 900 s for the invariants, and for the retries under Timeouts 1800 s (Yices, no solver limit) or 1200 s (Bitwuzla). Output below is Halmos's own; forge's compile banner and lint warnings are stripped, as are Halmos's notes that it skipped the build files of two local scripts that aren't in the repo.


### At bcf9a04 (every proved rule)


**BatchAccessFormal.check_booksMatchHoldings.log**
```
$ halmos --match-contract '^BatchAccessFormal$' --match-test '^check_booksMatchHoldings\('
No files changed, compilation skipped
Running 1 tests for test/formal/BatchAccessFormal.t.sol:BatchAccessFormal
[PASS] check_booksMatchHoldings(bool,bool) (paths: 170, time: 4.50s, bounds: [])
Symbolic test result: 1 passed; 0 failed; time: 4.61s
```

**BatchAccessFormal.check_depositFrom_onlyFactory.log**
```
$ halmos --match-contract '^BatchAccessFormal$' --match-test '^check_depositFrom_onlyFactory\('
No files changed, compilation skipped
Running 1 tests for test/formal/BatchAccessFormal.t.sol:BatchAccessFormal
[PASS] check_depositFrom_onlyFactory(address,address,uint256) (paths: 6, time: 0.05s, bounds: [])
Symbolic test result: 1 passed; 0 failed; time: 0.14s
```

**BatchAccessFormal.check_hook_onlyCredits.log**
```
$ halmos --match-contract '^BatchAccessFormal$' --match-test '^check_hook_onlyCredits\('
No files changed, compilation skipped
Running 1 tests for test/formal/BatchAccessFormal.t.sol:BatchAccessFormal
[PASS] check_hook_onlyCredits(address,address,address,uint256,bytes) (paths: 6, time: 0.05s, bounds: [data=[0, 65, 1024]])
Symbolic test result: 1 passed; 0 failed; time: 0.17s
```

**BatchAccessFormal.check_outsiderCannotTouchDeposit.log**
```
$ halmos --match-contract '^BatchAccessFormal$' --match-test '^check_outsiderCannotTouchDeposit\('
No files changed, compilation skipped
Running 1 tests for test/formal/BatchAccessFormal.t.sol:BatchAccessFormal
[PASS] check_outsiderCannotTouchDeposit(address) (paths: 91, time: 1.95s, bounds: [])
Symbolic test result: 1 passed; 0 failed; time: 2.05s
```

**BatchAccessFormal.check_rescue_neverTakesPooled.log**
```
$ halmos --match-contract '^BatchAccessFormal$' --match-test '^check_rescue_neverTakesPooled\('
No files changed, compilation skipped
Running 1 tests for test/formal/BatchAccessFormal.t.sol:BatchAccessFormal
[PASS] check_rescue_neverTakesPooled(address) (paths: 2, time: 0.01s, bounds: [])
Symbolic test result: 1 passed; 0 failed; time: 0.13s
```

**BatchAccessFormal.check_withdraw_onlyDepositor.log**
```
$ halmos --match-contract '^BatchAccessFormal$' --match-test '^check_withdraw_onlyDepositor\('
No files changed, compilation skipped
Running 1 tests for test/formal/BatchAccessFormal.t.sol:BatchAccessFormal
[PASS] check_withdraw_onlyDepositor(address) (paths: 2, time: 0.02s, bounds: [])
Symbolic test result: 1 passed; 0 failed; time: 0.11s
```

**BatchAuctionFormal.check_bidNeverShortensAuction.log**
```
$ halmos --match-contract '^BatchAuctionFormal$' --match-test '^check_bidNeverShortensAuction\('
No files changed, compilation skipped
Running 1 tests for test/formal/BatchAuctionFormal.t.sol:BatchAuctionFormal
[PASS] check_bidNeverShortensAuction(uint256,uint256,uint256) (paths: 34, time: 3.01s, bounds: [])
Symbolic test result: 1 passed; 0 failed; time: 24.61s
```

**BatchAuctionFormal.check_claimOnce.log**
```
$ halmos --match-contract '^BatchAuctionFormal$' --match-test '^check_claimOnce\('
No files changed, compilation skipped
Running 1 tests for test/formal/BatchAuctionFormal.t.sol:BatchAuctionFormal
[PASS] check_claimOnce(uint256,address) (paths: 74, time: 11.05s, bounds: [])
Symbolic test result: 1 passed; 0 failed; time: 32.89s
```

**BatchAuctionFormal.check_claimStatement_onlyWinner.log**
```
$ halmos --match-contract '^BatchAuctionFormal$' --match-test '^check_claimStatement_onlyWinner\('
No files changed, compilation skipped
Running 1 tests for test/formal/BatchAuctionFormal.t.sol:BatchAuctionFormal
[PASS] check_claimStatement_onlyWinner(uint256,address) (paths: 52, time: 9.44s, bounds: [])
Symbolic test result: 1 passed; 0 failed; time: 31.14s
```

**BatchAuctionFormal.check_equalSplitIsEqual.log**
```
$ halmos --match-contract '^BatchAuctionFormal$' --match-test '^check_equalSplitIsEqual\(' --solver bitwuzla --solver-timeout-assertion 0
No files changed, compilation skipped
Running 1 tests for test/formal/BatchAuctionFormal.t.sol:BatchAuctionFormal
[PASS] check_equalSplitIsEqual(uint256) (paths: 61, time: 11.29s, bounds: [])
Symbolic test result: 1 passed; 0 failed; time: 32.97s
```

**BatchAuctionFormal.check_noSettleBeforeEnd.log**
```
$ halmos --match-contract '^BatchAuctionFormal$' --match-test '^check_noSettleBeforeEnd\('
No files changed, compilation skipped
Running 1 tests for test/formal/BatchAuctionFormal.t.sol:BatchAuctionFormal
[PASS] check_noSettleBeforeEnd(uint256,uint256,address) (paths: 54, time: 9.99s, bounds: [])
Symbolic test result: 1 passed; 0 failed; time: 31.83s
```

**BatchAuctionFormal.check_outbidRefundsExactly.log**
```
$ halmos --match-contract '^BatchAuctionFormal$' --match-test '^check_outbidRefundsExactly\(' --solver bitwuzla --solver-timeout-assertion 0
No files changed, compilation skipped
Running 1 tests for test/formal/BatchAuctionFormal.t.sol:BatchAuctionFormal
[PASS] check_outbidRefundsExactly(uint256,uint256) (paths: 9, time: 1.52s, bounds: [])
Symbolic test result: 1 passed; 0 failed; time: 23.20s
```

**BatchAuctionFormal.check_settleOnce.log**
```
$ halmos --match-contract '^BatchAuctionFormal$' --match-test '^check_settleOnce\('
No files changed, compilation skipped
Running 1 tests for test/formal/BatchAuctionFormal.t.sol:BatchAuctionFormal
[PASS] check_settleOnce(uint256,address) (paths: 53, time: 8.99s, bounds: [])
Symbolic test result: 1 passed; 0 failed; time: 30.72s
```

**BatchAuctionFormal.check_settlePaysOutExactly.log**
```
$ halmos --match-contract '^BatchAuctionFormal$' --match-test '^check_settlePaysOutExactly\(' --solver bitwuzla --solver-timeout-assertion 0
No files changed, compilation skipped
Running 1 tests for test/formal/BatchAuctionFormal.t.sol:BatchAuctionFormal
[PASS] check_settlePaysOutExactly(uint256) (paths: 63, time: 12.56s, bounds: [])
Symbolic test result: 1 passed; 0 failed; time: 34.36s
```

**BatchAuctionFormal.check_statementStaysDuringAuction.log**
```
$ halmos --match-contract '^BatchAuctionFormal$' --match-test '^check_statementStaysDuringAuction\('
No files changed, compilation skipped
Running 1 tests for test/formal/BatchAuctionFormal.t.sol:BatchAuctionFormal
[PASS] check_statementStaysDuringAuction(address) (paths: 98, time: 8.33s, bounds: [])
Symbolic test result: 1 passed; 0 failed; time: 29.78s
```

**BatchEarlyFormal.check_earlySplitConserves.log**
```
$ halmos --match-contract '^BatchEarlyFormal$' --match-test '^check_earlySplitConserves\(' --solver bitwuzla --solver-timeout-assertion 0
No files changed, compilation skipped
Running 1 tests for test/formal/BatchAuctionFormal.t.sol:BatchEarlyFormal
[PASS] check_earlySplitConserves(uint256) (paths: 121, time: 57.42s, bounds: [])
Symbolic test result: 1 passed; 0 failed; time: 79.06s
```

**BatchInvariantFormal.log**
```
$ halmos --match-contract '^BatchInvariantFormal$' --loop 5
No files changed, compilation skipped
Running 3 tests for test/formal/BatchInvariantFormal.t.sol:BatchInvariantFormal
╭───────────────────── Initial Invariant Target Functions ─────────────────────╮
│ MockCredits.sol:MockCredits @ 0xaaaa0002                                     │
│ └── safeTransferFrom(address,address,uint256)                                │
│                                                                              │
│ Batch.sol:Batch @ 0xaaaa0008                                                 │
│ ├── assemble()                                                               │
│ ├── bid()                                                                    │
│ ├── claim(address)                                                           │
│ ├── claimStatement(address)                                                  │
│ ├── depositFrom(address,uint256[])                                           │
│ ├── initialize(address,string,(uint16,uint8,uint8,uint32,uint64,uint64,uint2 │
│ │   56,uint256,uint16,uint16,uint256,uint64,uint16,uint16,uint8),uint256[],u │
│ │   int256,uint256,uint256,uint8,uint8,uint64,address)                       │
│ ├── onERC721Received(address,address,uint256,bytes)                          │
│ ├── rescue(address,uint256)                                                  │
│ ├── restartCountdown()                                                       │
│ ├── settle()                                                                 │
│ ├── withdraw(uint256[])                                                      │
│ └── withdrawOwed()                                                           │
╰──────────────────────────────────────────────────────────────────────────────╯
[PASS] invariant_booksMatchHoldings() (paths: 534, time: 23.78s, bounds: [])
[PASS] invariant_onlyRealDepositors() (paths: 2995, time: 64.69s, bounds: [])
[PASS] invariant_sharesMatchCount() (paths: 178, time: 4.66s, bounds: [])
Symbolic test result: 3 passed; 0 failed; time: 93.34s
```

**BatchLockFormal.check_burnOnlyInWindow.log**
```
$ halmos --match-contract '^BatchLockFormal$' --match-test '^check_burnOnlyInWindow\('
No files changed, compilation skipped
Running 1 tests for test/formal/BatchLockFormal.t.sol:BatchLockFormal
[PASS] check_burnOnlyInWindow(address,uint256) (paths: 4, time: 14.29s, bounds: [])
Symbolic test result: 1 passed; 0 failed; time: 23.37s
```

**BatchLockFormal.check_canLeaveOutsideBurnWindow.log**
```
$ halmos --match-contract '^BatchLockFormal$' --match-test '^check_canLeaveOutsideBurnWindow\('
No files changed, compilation skipped
Running 1 tests for test/formal/BatchLockFormal.t.sol:BatchLockFormal
[PASS] check_canLeaveOutsideBurnWindow(uint256) (paths: 3, time: 5.48s, bounds: [])
Symbolic test result: 1 passed; 0 failed; time: 14.71s
```

**BatchLockFormal.check_neverMoreThan80.log**
```
$ halmos --match-contract '^BatchLockFormal$' --match-test '^check_neverMoreThan80\('
No files changed, compilation skipped
Running 1 tests for test/formal/BatchLockFormal.t.sol:BatchLockFormal
[PASS] check_neverMoreThan80(bool) (paths: 3, time: 0.47s, bounds: [])
Symbolic test result: 1 passed; 0 failed; time: 9.56s
```

**BatchLockFormal.check_noWithdrawWhileBurnable.log**
```
$ halmos --match-contract '^BatchLockFormal$' --match-test '^check_noWithdrawWhileBurnable\('
No files changed, compilation skipped
Running 1 tests for test/formal/BatchLockFormal.t.sol:BatchLockFormal
[PASS] check_noWithdrawWhileBurnable(uint256) (paths: 4, time: 5.64s, bounds: [])
Symbolic test result: 1 passed; 0 failed; time: 14.82s
```

**BatchLockFormal.check_restartAlwaysGivesNotice.log**
```
$ halmos --match-contract '^BatchLockFormal$' --match-test '^check_restartAlwaysGivesNotice\('
No files changed, compilation skipped
Running 1 tests for test/formal/BatchLockFormal.t.sol:BatchLockFormal
[PASS] check_restartAlwaysGivesNotice(address,uint256) (paths: 10, time: 1.14s, bounds: [])
Symbolic test result: 1 passed; 0 failed; time: 10.26s
```

**FactoryFormal.check_activate_notBeforeDelay.log**
```
$ halmos --match-contract '^FactoryFormal$' --match-test '^check_activate_notBeforeDelay\('
No files changed, compilation skipped
Running 1 tests for test/formal/FactoryFormal.t.sol:FactoryFormal
[PASS] check_activate_notBeforeDelay(address,uint256) (paths: 3, time: 0.03s, bounds: [])
Symbolic test result: 1 passed; 0 failed; time: 0.14s
```

**FactoryFormal.check_assembler_fixedOnceActive_create.log**
```
$ halmos --match-contract '^FactoryFormal$' --match-test '^check_assembler_fixedOnceActive_create\('
No files changed, compilation skipped
Running 1 tests for test/formal/FactoryFormal.t.sol:FactoryFormal
[PASS] check_assembler_fixedOnceActive_create(address,uint256) (paths: 5, time: 0.16s, bounds: [])
Symbolic test result: 1 passed; 0 failed; time: 0.27s
```

**FactoryFormal.check_assembler_fixedOnceActive_exceptCreate.log**
```
$ halmos --match-contract '^FactoryFormal$' --match-test '^check_assembler_fixedOnceActive_exceptCreate\('
No files changed, compilation skipped
Running 1 tests for test/formal/FactoryFormal.t.sol:FactoryFormal
[PASS] check_assembler_fixedOnceActive_exceptCreate(address) (paths: 141, time: 2.83s, bounds: [])
Symbolic test result: 1 passed; 0 failed; time: 2.94s
```

**FactoryFormal.check_depositFor_rejectsSinks.log**
```
$ halmos --match-contract '^FactoryFormal$' --match-test '^check_depositFor_rejectsSinks\('
No files changed, compilation skipped
Running 1 tests for test/formal/FactoryFormal.t.sol:FactoryFormal
[PASS] check_depositFor_rejectsSinks(uint256) (paths: 3, time: 0.03s, bounds: [])
Symbolic test result: 1 passed; 0 failed; time: 0.14s
```

**FactoryFormal.check_factory_neverTakesOthersCredits_create.log**
```
$ halmos --match-contract '^FactoryFormal$' --match-test '^check_factory_neverTakesOthersCredits_create\('
No files changed, compilation skipped
Running 1 tests for test/formal/FactoryFormal.t.sol:FactoryFormal
[PASS] check_factory_neverTakesOthersCredits_create(address,uint256) (paths: 5, time: 0.19s, bounds: [])
Symbolic test result: 1 passed; 0 failed; time: 0.29s
```

**FactoryFormal.check_factory_neverTakesOthersCredits_exceptCreate.log**
```
$ halmos --match-contract '^FactoryFormal$' --match-test '^check_factory_neverTakesOthersCredits_exceptCreate\('
No files changed, compilation skipped
Running 1 tests for test/formal/FactoryFormal.t.sol:FactoryFormal
[PASS] check_factory_neverTakesOthersCredits_exceptCreate(address) (paths: 92, time: 1.59s, bounds: [])
Symbolic test result: 1 passed; 0 failed; time: 1.70s
```

**FactoryFormal.check_fees_neverAboveCaps.log**
```
$ halmos --match-contract '^FactoryFormal$' --match-test '^check_fees_neverAboveCaps\('
No files changed, compilation skipped
Running 1 tests for test/formal/FactoryFormal.t.sol:FactoryFormal
[PASS] check_fees_neverAboveCaps(address,uint256,uint256) (paths: 5, time: 0.04s, bounds: [])
Symbolic test result: 1 passed; 0 failed; time: 0.15s
```

**FactoryFormal.check_initialize_once.log**
```
$ halmos --match-contract '^FactoryFormal$' --match-test '^check_initialize_once\('
No files changed, compilation skipped
Running 1 tests for test/formal/FactoryFormal.t.sol:FactoryFormal
[PASS] check_initialize_once(address,bool) (paths: 4, time: 0.03s, bounds: [])
Symbolic test result: 1 passed; 0 failed; time: 0.14s
```

**FactoryFormal.check_propose_onlySetter.log**
```
$ halmos --match-contract '^FactoryFormal$' --match-test '^check_propose_onlySetter\('
No files changed, compilation skipped
Running 1 tests for test/formal/FactoryFormal.t.sol:FactoryFormal
[PASS] check_propose_onlySetter(address,address) (paths: 5, time: 0.03s, bounds: [])
Symbolic test result: 1 passed; 0 failed; time: 0.14s
```

**FactoryFormal.check_setFees_onlyFeeRecipient.log**
```
$ halmos --match-contract '^FactoryFormal$' --match-test '^check_setFees_onlyFeeRecipient\('
No files changed, compilation skipped
Running 1 tests for test/formal/FactoryFormal.t.sol:FactoryFormal
[PASS] check_setFees_onlyFeeRecipient(address,uint256,uint256) (paths: 5, time: 0.03s, bounds: [])
Symbolic test result: 1 passed; 0 failed; time: 0.14s
```

**RatingsFormal.check_constructorRejectsWrongCount.log**
```
$ halmos --match-contract '^RatingsFormal$' --match-test '^check_constructorRejectsWrongCount\('
No files changed, compilation skipped
Running 1 tests for test/formal/RatingsFormal.t.sol:RatingsFormal
WARNING  unknown deployed bytecode: 0x0020033412401f
[PASS] check_constructorRejectsWrongCount(uint256) (paths: 8, time: 0.04s, bounds: [])
Symbolic test result: 1 passed; 0 failed; time: 0.05s
```

**RatingsFormal.check_knownIdsReadExactly.log**
```
$ halmos --match-contract '^RatingsFormal$' --match-test '^check_knownIdsReadExactly\('
No files changed, compilation skipped
Running 1 tests for test/formal/RatingsFormal.t.sol:RatingsFormal
WARNING  unknown deployed bytecode: 0x0020033412401f
[PASS] check_knownIdsReadExactly(uint256) (paths: 3, time: 0.02s, bounds: [])
Symbolic test result: 1 passed; 0 failed; time: 0.03s
```

**RatingsFormal.check_unknownIdScoresZero.log**
```
$ halmos --match-contract '^RatingsFormal$' --match-test '^check_unknownIdScoresZero\('
No files changed, compilation skipped
Running 1 tests for test/formal/RatingsFormal.t.sol:RatingsFormal
WARNING  unknown deployed bytecode: 0x0020033412401f
[PASS] check_unknownIdScoresZero(uint256) (paths: 2, time: 0.01s, bounds: [])
Symbolic test result: 1 passed; 0 failed; time: 0.02s
```

**RatingsSwitchFormal.check_activateRatings_notBeforeDelay.log**
```
$ halmos --match-contract '^RatingsSwitchFormal$' --match-test '^check_activateRatings_notBeforeDelay\('
No files changed, compilation skipped
Running 1 tests for test/formal/RatingsSwitchFormal.t.sol:RatingsSwitchFormal
WARNING  unknown deployed bytecode: 0x0020033412401f
WARNING  unknown deployed bytecode: 0x00401f34122003
[PASS] check_activateRatings_notBeforeDelay(address,uint256) (paths: 3, time: 0.03s, bounds: [])
Symbolic test result: 1 passed; 0 failed; time: 0.14s
```

**RatingsSwitchFormal.check_create_onlyOnExpectedTable.log**
```
$ halmos --match-contract '^RatingsSwitchFormal$' --match-test '^check_create_onlyOnExpectedTable\('
No files changed, compilation skipped
Running 1 tests for test/formal/RatingsSwitchFormal.t.sol:RatingsSwitchFormal
WARNING  unknown deployed bytecode: 0x0020033412401f
WARNING  unknown deployed bytecode: 0x00401f34122003
[PASS] check_create_onlyOnExpectedTable(address) (paths: 4, time: 0.10s, bounds: [])
Symbolic test result: 1 passed; 0 failed; time: 0.20s
```

**RatingsSwitchFormal.check_openBatch_keepsItsTable.log**
```
$ halmos --match-contract '^RatingsSwitchFormal$' --match-test '^check_openBatch_keepsItsTable\('
No files changed, compilation skipped
Running 1 tests for test/formal/RatingsSwitchFormal.t.sol:RatingsSwitchFormal
WARNING  unknown deployed bytecode: 0x0020033412401f
WARNING  unknown deployed bytecode: 0x00401f34122003
[PASS] check_openBatch_keepsItsTable(address) (paths: 112, time: 1.39s, bounds: [])
Symbolic test result: 1 passed; 0 failed; time: 1.49s
```

**RatingsSwitchFormal.check_proposeRatings_onlyFeeRecipient.log**
```
$ halmos --match-contract '^RatingsSwitchFormal$' --match-test '^check_proposeRatings_onlyFeeRecipient\('
No files changed, compilation skipped
Running 1 tests for test/formal/RatingsSwitchFormal.t.sol:RatingsSwitchFormal
WARNING  unknown deployed bytecode: 0x0020033412401f
WARNING  unknown deployed bytecode: 0x00401f34122003
[PASS] check_proposeRatings_onlyFeeRecipient(address) (paths: 3, time: 0.02s, bounds: [])
Symbolic test result: 1 passed; 0 failed; time: 0.16s
```

**RatingsSwitchFormal.check_ratings_onlyActivateMovesIt_exceptCreate.log**
```
$ halmos --match-contract '^RatingsSwitchFormal$' --match-test '^check_ratings_onlyActivateMovesIt_exceptCreate\('
No files changed, compilation skipped
Running 1 tests for test/formal/RatingsSwitchFormal.t.sol:RatingsSwitchFormal
WARNING  unknown deployed bytecode: 0x0020033412401f
WARNING  unknown deployed bytecode: 0x00401f34122003
[PASS] check_ratings_onlyActivateMovesIt_exceptCreate(address) (paths: 56, time: 0.53s, bounds: [])
Symbolic test result: 1 passed; 0 failed; time: 0.63s
```

**RatingsSwitchFormal.check_ratings_unchangedByCreate.log**
```
$ halmos --match-contract '^RatingsSwitchFormal$' --match-test '^check_ratings_unchangedByCreate\('
No files changed, compilation skipped
Running 1 tests for test/formal/RatingsSwitchFormal.t.sol:RatingsSwitchFormal
WARNING  unknown deployed bytecode: 0x0020033412401f
WARNING  unknown deployed bytecode: 0x00401f34122003
[PASS] check_ratings_unchangedByCreate(address,uint256) (paths: 3, time: 0.07s, bounds: [])
Symbolic test result: 1 passed; 0 failed; time: 0.17s
```

**SweeperFormal.check_buyExactAndHoldsNothing.log**
```
$ halmos --match-contract '^SweeperFormal$' --match-test '^check_buyExactAndHoldsNothing\('
No files changed, compilation skipped
Running 1 tests for test/formal/SweeperFormal.t.sol:SweeperFormal
[PASS] check_buyExactAndHoldsNothing(uint96,uint256,uint256,uint256,uint256,uint256) (paths: 167, time: 11.65s, bounds: [])
Symbolic test result: 1 passed; 0 failed; time: 11.82s
```

**SweeperFormal.check_buyFeeRaiseNeverSlipsIn.log**
```
$ halmos --match-contract '^SweeperFormal$' --match-test '^check_buyFeeRaiseNeverSlipsIn\('
No files changed, compilation skipped
Running 1 tests for test/formal/SweeperFormal.t.sol:SweeperFormal
[PASS] check_buyFeeRaiseNeverSlipsIn(uint256,uint256) (paths: 2, time: 0.05s, bounds: [])
Symbolic test result: 1 passed; 0 failed; time: 0.23s
```

**SweeperFormal.check_constructorRejectsOtherStrategy.log**
```
$ halmos --match-contract '^SweeperFormal$' --match-test '^check_constructorRejectsOtherStrategy\('
No files changed, compilation skipped
Running 1 tests for test/formal/SweeperFormal.t.sol:SweeperFormal
[PASS] check_constructorRejectsOtherStrategy(address) (paths: 4, time: 0.06s, bounds: [])
Symbolic test result: 1 passed; 0 failed; time: 0.24s
```

**SweeperFormal.check_feeRaiseNeverSlipsIn.log**
```
$ halmos --match-contract '^SweeperFormal$' --match-test '^check_feeRaiseNeverSlipsIn\('
No files changed, compilation skipped
Running 1 tests for test/formal/SweeperFormal.t.sol:SweeperFormal
[PASS] check_feeRaiseNeverSlipsIn(uint256,uint256) (paths: 3, time: 0.05s, bounds: [])
Symbolic test result: 1 passed; 0 failed; time: 0.23s
```

**SweeperFormal.check_setFee_onlyRecipientAndCapped.log**
```
$ halmos --match-contract '^SweeperFormal$' --match-test '^check_setFee_onlyRecipientAndCapped\('
No files changed, compilation skipped
Running 1 tests for test/formal/SweeperFormal.t.sol:SweeperFormal
[PASS] check_setFee_onlyRecipientAndCapped(address,uint256) (paths: 4, time: 0.05s, bounds: [])
Symbolic test result: 1 passed; 0 failed; time: 0.23s
```

**SweeperFormal.check_sweepAllExactAndHoldsNothing.log**
```
$ halmos --match-contract '^SweeperFormal$' --match-test '^check_sweepAllExactAndHoldsNothing\('
No files changed, compilation skipped
Running 1 tests for test/formal/SweeperFormal.t.sol:SweeperFormal
[PASS] check_sweepAllExactAndHoldsNothing(uint96,uint256,uint256,uint256,uint256,uint256) (paths: 173, time: 12.03s, bounds: [])
Symbolic test result: 1 passed; 0 failed; time: 12.17s
```

**SweeperFormal.check_sweepExactAndHoldsNothing.log**
```
$ halmos --match-contract '^SweeperFormal$' --match-test '^check_sweepExactAndHoldsNothing\('
No files changed, compilation skipped
Running 1 tests for test/formal/SweeperFormal.t.sol:SweeperFormal
[PASS] check_sweepExactAndHoldsNothing(uint256,uint256) (paths: 11, time: 0.35s, bounds: [])
Symbolic test result: 1 passed; 0 failed; time: 0.53s
```

**SweeperFormal.check_sweepOnlyIntoBatches.log**
```
$ halmos --match-contract '^SweeperFormal$' --match-test '^check_sweepOnlyIntoBatches\('
No files changed, compilation skipped
Running 1 tests for test/formal/SweeperFormal.t.sol:SweeperFormal
[PASS] check_sweepOnlyIntoBatches(address,uint256) (paths: 3, time: 0.06s, bounds: [])
Symbolic test result: 1 passed; 0 failed; time: 0.24s
```

### Timeouts (at bcf9a04)


**FactoryFormal.check_assembler_fixedOnceActive.log**
```
$ halmos --match-contract '^FactoryFormal$' --match-test '^check_assembler_fixedOnceActive\('
No files changed, compilation skipped
TIMED OUT after 600s (wall clock)
```

**FactoryFormal.check_factory_neverTakesOthersCredits.log**
```
$ halmos --match-contract '^FactoryFormal$' --match-test '^check_factory_neverTakesOthersCredits\('
No files changed, compilation skipped
TIMED OUT after 600s (wall clock)
```

**BatchAuctionFormal.check_outbidRaisesAndRefunds.log**
```
$ halmos --match-contract '^BatchAuctionFormal$' --match-test '^check_outbidRaisesAndRefunds\('
No files changed, compilation skipped
Running 1 tests for test/formal/BatchAuctionFormal.t.sol:BatchAuctionFormal
[TIMEOUT] check_outbidRaisesAndRefunds(uint256,uint256) (paths: 26, time: 61.88s, bounds: [])
Timeout queries saved in: /var/folders/6q/tt5xvkvd76ldv0wkmkwc8p240000gn/T/check_outbidRaisesAndRefunds-11iyeyos-timeout
Symbolic test result: 0 passed; 1 failed; time: 83.50s
```

**BatchAuctionFormal.check_settleConservesEth.log**
```
$ halmos --match-contract '^BatchAuctionFormal$' --match-test '^check_settleConservesEth\('
No files changed, compilation skipped
Running 1 tests for test/formal/BatchAuctionFormal.t.sol:BatchAuctionFormal
[TIMEOUT] check_settleConservesEth(uint256) (paths: 103, time: 72.83s, bounds: [])
Timeout queries saved in: /var/folders/6q/tt5xvkvd76ldv0wkmkwc8p240000gn/T/check_settleConservesEth-582jy82r-timeout
Symbolic test result: 0 passed; 1 failed; time: 94.37s
```

**yices/BatchEarlyFormal.check_earlySplitConserves.log**
```
$ halmos --match-contract '^BatchEarlyFormal$' --match-test '^check_earlySplitConserves\('
No files changed, compilation skipped
Running 1 tests for test/formal/BatchAuctionFormal.t.sol:BatchEarlyFormal
[TIMEOUT] check_earlySplitConserves(uint256) (paths: 119, time: 104.76s, bounds: [])
Timeout queries saved in: /var/folders/6q/tt5xvkvd76ldv0wkmkwc8p240000gn/T/check_earlySplitConserves-f47e75ei-timeout
Symbolic test result: 0 passed; 1 failed; time: 127.17s
```

**retry/BatchAuctionFormal.check_outbidRaisesAndRefunds.log**
```
$ halmos --match-contract '^BatchAuctionFormal$' --match-test '^check_outbidRaisesAndRefunds\(' --solver-timeout-assertion 0
No files changed, compilation skipped
TIMED OUT after 1800s (wall clock)
```

**retry/BatchAuctionFormal.check_settleConservesEth.log**
```
$ halmos --match-contract '^BatchAuctionFormal$' --match-test '^check_settleConservesEth\(' --solver-timeout-assertion 0
No files changed, compilation skipped
TIMED OUT after 1800s (wall clock)
```

**retry/BatchEarlyFormal.check_earlySplitConserves.log**
```
$ halmos --match-contract '^BatchEarlyFormal$' --match-test '^check_earlySplitConserves\(' --solver-timeout-assertion 0
No files changed, compilation skipped
TIMED OUT after 1800s (wall clock)
```

**bitwuzla/BatchAuctionFormal.check_outbidRaisesAndRefunds.log**
```
$ halmos --match-contract '^BatchAuctionFormal$' --match-test '^check_outbidRaisesAndRefunds\(' --solver bitwuzla --solver-timeout-assertion 0
No files changed, compilation skipped
TIMED OUT after 1200s (wall clock)
```

**bitwuzla/BatchAuctionFormal.check_settleConservesEth.log**
```
$ halmos --match-contract '^BatchAuctionFormal$' --match-test '^check_settleConservesEth\(' --solver bitwuzla --solver-timeout-assertion 0
No files changed, compilation skipped
TIMED OUT after 1200s (wall clock)
```

**bitwuzla/BatchAuctionFormal.check_outbidRaisesEnough.log**
```
$ halmos --match-contract '^BatchAuctionFormal$' --match-test '^check_outbidRaisesEnough\(' --solver bitwuzla --solver-timeout-assertion 0
No files changed, compilation skipped
TIMED OUT after 1200s (wall clock)
```

The Bitwuzla run of `check_settleConservesEth` straddled a four-hour hibernation when the laptop's battery ran out. The cap only counts time awake, so it still ran about 20 minutes.

Bitwuzla runs need `HALMOS_ALLOW_DOWNLOAD=1` the first time (Halmos fetches the solver).


## Code

Rerun everything: `cd contracts && forge build --ast && for c in FactoryFormal BatchAccessFormal BatchLockFormal BatchAuctionFormal BatchEarlyFormal SweeperFormal RatingsFormal RatingsSwitchFormal; do test/formal/run.sh $c 600; done`, then `halmos --match-contract BatchInvariantFormal --loop 5`, and for the Bitwuzla rules add `--solver bitwuzla --solver-timeout-assertion 0`.


### test/formal/FormalBase.sol
```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {ratingsOf} from "../../script/RatingsOf.sol";
import {Batch, IRatings} from "../../src/Batch.sol";
import {BatchFactory} from "../../src/BatchFactory.sol";
import {IAssembler} from "../../src/interfaces/IAssembler.sol";
import {ICredits} from "../../src/interfaces/ICredits.sol";
import {MockCredits} from "../../src/mocks/MockCredits.sol";
import {MockStatement} from "../../src/mocks/MockStatement.sol";
import {MockAssembler} from "../../src/mocks/MockAssembler.sol";

/// @dev Halmos cheatcodes (a16z/halmos-cheatcodes), declared here so the suite needs no extra dependency.
interface SVM {
    function createUint256(string memory name) external pure returns (uint256);
    function createUint(uint256 bits, string memory name) external pure returns (uint256);
    function createAddress(string memory name) external pure returns (address);
    function createBool(string memory name) external pure returns (bool);
    function createCalldata(string memory contractName) external pure returns (bytes memory);
}

SVM constant svm = SVM(0xF3993A62377BCd56AE39D773740A5390411E8BC9);

/// @dev Shared world for the formal suite: Credits, a Statement and its adapter, a factory, and named actors.
///      Rules are written as Halmos `check_` functions: every input is symbolic, so a rule that passes holds
///      for every value, not a sample.
abstract contract FormalBase is Test {
    address internal constant FEE = address(0xFEE);
    address internal constant SETTER = address(0x5E77);
    address internal constant ALICE = address(0xA11CE);
    address internal constant BOB = address(0xB0B);
    uint256 internal constant PROTOCOL_BPS = 250;
    uint256 internal constant CREATOR_BPS = 500;

    MockCredits internal credits;
    MockStatement internal statement;
    MockAssembler internal asm_;
    BatchFactory internal factory;

    /// @param live deploy with the assembler already active (true) or with none, for the setter to propose.
    function _world(bool live) internal {
        vm.warp(1_000_000);
        credits = new MockCredits();
        statement = new MockStatement(ICredits(address(credits)));
        asm_ = new MockAssembler(statement);
        factory = new BatchFactory(
            ICredits(address(credits)),
            IRatings(address(0)),
            live ? IAssembler(address(asm_)) : IAssembler(address(0)),
            SETTER,
            FEE,
            PROTOCOL_BPS,
            CREATOR_BPS,
            1
        );
    }

    function _ids(uint256 first, uint256 n) internal pure returns (uint256[] memory a) {
        a = new uint256[](n);
        for (uint256 i; i < n; ++i) a[i] = first + i;
    }

    function _open(address who, uint256[] memory ids, Batch.Split split) internal returns (Batch b) {
        Batch.Filter memory f;
        vm.startPrank(who);
        credits.setApprovalForAll(address(factory), true);
        b = Batch(
            factory.create("u", f, new uint256[](0), 0, Batch.Arrangement.Deposit, split, 3 days, ids, PROTOCOL_BPS, CREATOR_BPS, ratingsOf(address(factory)))
        );
        vm.stopPrank();
    }

    /// @dev Actors the protocol treats as special; a symbolic caller is kept distinct from them where the
    ///      rule is about outsiders.
    function _outsider(address a) internal view {
        vm.assume(a != address(factory) && a != address(credits) && a != address(statement) && a != address(asm_));
        vm.assume(a != address(this) && a != address(0));
    }
}
```

### test/formal/FactoryFormal.t.sol
```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {FormalBase, svm} from "./FormalBase.sol";
import {ratingsOf} from "../../script/RatingsOf.sol";
import {Batch, IRatings} from "../../src/Batch.sol";
import {IAssembler} from "../../src/interfaces/IAssembler.sol";

/// @dev BatchFactory: who may touch fees and the assembler, and that it only ever moves the caller's Credits.
contract FactoryFormal is FormalBase {
    Batch internal batch;

    function setUp() public {
        _world(false); // no assembler yet: the setter's window is open
        credits.mint(ALICE, 2); // 1 opens the batch, 2 stays in Alice's wallet with the factory approved
        batch = _open(ALICE, _ids(1, 1), Batch.Split.Equal);
    }

    /// Only the fee recipient changes fees.
    function check_setFees_onlyFeeRecipient(address caller, uint256 p, uint256 c) public {
        vm.prank(caller);
        try factory.setFees(p, c) {
            assert(caller == FEE);
        } catch {}
    }

    /// Fees never exceed their caps, whoever calls and with whatever values.
    function check_fees_neverAboveCaps(address caller, uint256 p, uint256 c) public {
        vm.prank(caller);
        try factory.setFees(p, c) {} catch {}
        assert(factory.protocolFeeBps() <= 500);
        assert(factory.creatorFeeBps() <= 1000);
    }

    /// Only the setter proposes an assembler.
    function check_propose_onlySetter(address caller, address a) public {
        vm.prank(caller);
        try factory.proposeAssembler(IAssembler(a)) {
            assert(caller == SETTER);
        } catch {}
    }

    /// A proposed assembler cannot go live before its 30-minute notice.
    function check_activate_notBeforeDelay(address caller, uint256 wait) public {
        vm.prank(SETTER);
        factory.proposeAssembler(IAssembler(address(asm_)));
        uint256 proposedAt = block.timestamp;
        vm.assume(wait < 365 days);
        vm.warp(proposedAt + wait);
        vm.prank(caller);
        try factory.activateAssembler() {
            assert(wait >= 30 minutes);
        } catch {}
    }

    /// Once active, the assembler never changes: no call by anyone, including the setter, moves it.
    function check_assembler_fixedOnceActive(address caller) public {
        vm.prank(SETTER);
        factory.proposeAssembler(IAssembler(address(asm_)));
        vm.warp(block.timestamp + 30 minutes);
        factory.activateAssembler();
        address a = address(factory.assembler());
        uint64 at = factory.assemblerActiveAt();

        bytes memory data = svm.createCalldata("BatchFactory");
        vm.prank(caller);
        (bool ok,) = address(factory).call(data);
        ok;
        assert(address(factory.assembler()) == a);
        assert(factory.assemblerActiveAt() == at);
    }

    /// The factory never moves a Credit its owner didn't send: any call by anyone else leaves Alice's
    /// Credit #2 in her wallet, even though she approved the factory for all her Credits.
    function check_factory_neverTakesOthersCredits(address caller) public {
        _outsider(caller);
        vm.assume(caller != ALICE);
        bytes memory data = svm.createCalldata("BatchFactory");
        vm.prank(caller);
        (bool ok,) = address(factory).call(data);
        ok;
        assert(credits.ownerOf(2) == ALICE);
    }

    /// depositFor never records a depositor that could not withdraw or be paid.
    function check_depositFor_rejectsSinks(uint256 pick) public {
        address to = pick % 3 == 0 ? address(0) : pick % 3 == 1 ? address(batch) : address(factory);
        vm.prank(ALICE);
        try factory.depositFor(address(batch), _ids(2, 1), to) {
            assert(false);
        } catch {}
    }

    /// A created batch can never be re-initialized, and neither can the implementation behind every clone.
    function check_initialize_once(address caller, bool impl) public {
        Batch target = impl ? Batch(factory.implementation()) : batch;
        Batch.Filter memory f;
        vm.prank(caller);
        try target.initialize(caller, "x", f, new uint256[](0), 0, 500, 1000, Batch.Arrangement.Deposit, Batch.Split.Equal, 0, IRatings(address(0))) {
            assert(false);
        } catch {}
    }

    // The two "any call" rules above time out: create() alone (strings, arrays, a full batch initialize) is
    // too large to explore. Each is split into every other function, plus create() with the parts that
    // matter (caller, the ids moved) symbolic.

    function _activate() internal {
        vm.prank(SETTER);
        factory.proposeAssembler(IAssembler(address(asm_)));
        vm.warp(block.timestamp + 30 minutes);
        factory.activateAssembler();
    }

    /// Assembler fixed once active: any call except create().
    function check_assembler_fixedOnceActive_exceptCreate(address caller) public {
        _activate();
        address a = address(factory.assembler());
        uint64 at = factory.assemblerActiveAt();
        bytes memory data = svm.createCalldata("BatchFactory");
        vm.assume(bytes4(data) != factory.create.selector);
        vm.prank(caller);
        (bool ok,) = address(factory).call(data);
        ok;
        assert(address(factory.assembler()) == a);
        assert(factory.assemblerActiveAt() == at);
    }

    /// Assembler fixed once active: create(), by anyone, with any id.
    function check_assembler_fixedOnceActive_create(address caller, uint256 id) public {
        _activate();
        address a = address(factory.assembler());
        uint64 at = factory.assemblerActiveAt();
        Batch.Filter memory f;
        uint256[] memory ids = new uint256[](1);
        ids[0] = id;
        vm.prank(caller);
        try factory.create("x", f, new uint256[](0), 0, Batch.Arrangement.Deposit, Batch.Split.Equal, 3 days, ids, 250, 500, ratingsOf(address(factory))) {}
            catch {}
        assert(address(factory.assembler()) == a);
        assert(factory.assemblerActiveAt() == at);
    }

    /// The factory never takes someone else's Credit: any call except create().
    function check_factory_neverTakesOthersCredits_exceptCreate(address caller) public {
        _outsider(caller);
        vm.assume(caller != ALICE);
        bytes memory data = svm.createCalldata("BatchFactory");
        vm.assume(bytes4(data) != factory.create.selector);
        vm.prank(caller);
        (bool ok,) = address(factory).call(data);
        ok;
        assert(credits.ownerOf(2) == ALICE);
    }

    /// The factory never takes someone else's Credit: create() by anyone else, naming any id.
    function check_factory_neverTakesOthersCredits_create(address caller, uint256 id) public {
        _outsider(caller);
        vm.assume(caller != ALICE);
        Batch.Filter memory f;
        uint256[] memory ids = new uint256[](1);
        ids[0] = id;
        vm.prank(caller);
        try factory.create("x", f, new uint256[](0), 0, Batch.Arrangement.Deposit, Batch.Split.Equal, 3 days, ids, 250, 500, ratingsOf(address(factory))) {}
            catch {}
        assert(credits.ownerOf(2) == ALICE);
    }
}
```

### test/formal/BatchAccessFormal.t.sol
```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {FormalBase, svm} from "./FormalBase.sol";
import {Batch} from "../../src/Batch.sol";

/// @dev An open batch: Alice deposited Credit #1 (she created it), Bob holds #2.
contract BatchAccessFormal is FormalBase {
    Batch internal batch;

    function setUp() public {
        _world(true);
        credits.mint(ALICE, 1);
        credits.mint(BOB, 1);
        batch = _open(ALICE, _ids(1, 1), Batch.Split.Equal);
    }

    /// Only the factory records deposits made through it.
    function check_depositFrom_onlyFactory(address caller, address from, uint256 id) public {
        uint256[] memory ids = new uint256[](1);
        ids[0] = id;
        vm.prank(caller);
        try batch.depositFrom(from, ids) {
            assert(caller == address(factory));
        } catch {}
    }

    /// Only a Credit's depositor can withdraw it.
    function check_withdraw_onlyDepositor(address caller) public {
        vm.assume(caller != ALICE);
        vm.prank(caller);
        try batch.withdraw(_ids(1, 1)) {
            assert(false);
        } catch {}
    }

    /// No call to the batch by anyone but Alice moves her Credit, her depositor record, or her share.
    function check_outsiderCannotTouchDeposit(address caller) public {
        _outsider(caller);
        vm.assume(caller != ALICE);
        bytes memory data = svm.createCalldata("Batch");
        vm.prank(caller);
        (bool ok,) = address(batch).call(data);
        ok;
        assert(credits.ownerOf(1) == address(batch));
        assert(batch.depositorOf(1) == ALICE);
        assert(batch.sharesOf(ALICE) == 1);
        assert(batch.count() == 1);
    }

    /// The deposit hook only answers the Credits contract: no one can fake a deposit by calling it directly.
    function check_hook_onlyCredits(address caller, address op, address from, uint256 id, bytes calldata data) public {
        vm.assume(caller != address(credits));
        vm.prank(caller);
        try batch.onERC721Received(op, from, id, data) {
            assert(false);
        } catch {}
    }

    /// rescue can never take a pooled Credit.
    function check_rescue_neverTakesPooled(address caller) public {
        vm.prank(caller);
        try batch.rescue(address(credits), 1) {
            assert(false);
        } catch {}
    }

    /// Shares always equal Credits held, and every recorded Credit is actually in the batch, after Alice
    /// or Bob does anything at all to the batch or sends a Credit into it.
    function check_booksMatchHoldings(bool aliceActs, bool viaTransfer) public {
        address who = aliceActs ? ALICE : BOB;
        if (viaTransfer) {
            // Bob's #2 through the hook; Alice owns nothing loose, so hers reverts.
            vm.prank(who);
            try credits.safeTransferFrom(who, address(batch), 2) {} catch {}
        } else {
            bytes memory data = svm.createCalldata("Batch");
            vm.prank(who);
            (bool ok,) = address(batch).call(data);
            ok;
        }
        uint256 n = batch.count();
        assert(n <= 80);
        assert(batch.sharesOf(ALICE) + batch.sharesOf(BOB) == n);
        uint256[] memory ids = batch.ids();
        for (uint256 i; i < ids.length; ++i) {
            assert(credits.ownerOf(ids[i]) == address(batch));
            assert(batch.depositorOf(ids[i]) != address(0));
        }
    }
}
```

### test/formal/BatchLockFormal.t.sol
```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {FormalBase, svm} from "./FormalBase.sol";
import {Batch} from "../../src/Batch.sol";

/// @dev A full batch: Alice put in all 80 at t0 with the assembler already live, so the countdown is running.
contract BatchLockFormal is FormalBase {
    Batch internal batch;
    uint256 internal t0;

    function setUp() public {
        _world(true);
        credits.mint(ALICE, 80);
        credits.mint(BOB, 1);
        t0 = block.timestamp;
        batch = _open(ALICE, _ids(1, 80), Batch.Split.Equal);
    }

    /// In the burn window no depositor can pull a Credit out from under the burn.
    function check_noWithdrawWhileBurnable(uint256 dt) public {
        vm.assume(dt < 30 days);
        vm.warp(t0 + dt);
        bool burnable = batch.phase() == Batch.Phase.Burnable;
        vm.prank(ALICE);
        try batch.withdraw(_ids(1, 1)) {
            assert(!burnable);
        } catch {}
    }

    /// Outside the burn window the depositor can always leave (no lock without notice, no lock forever).
    function check_canLeaveOutsideBurnWindow(uint256 dt) public {
        vm.assume(dt < 30 days);
        vm.warp(t0 + dt);
        vm.assume(batch.phase() != Batch.Phase.Burnable);
        vm.prank(ALICE);
        batch.withdraw(_ids(1, 1)); // a revert here is a counterexample
        assert(credits.ownerOf(1) == ALICE);
    }

    /// A burn only happens inside [fill + 5 min, fill + 5 min + 1 h), whoever calls it.
    function check_burnOnlyInWindow(address caller, uint256 dt) public {
        vm.assume(dt < 30 days);
        vm.warp(t0 + dt);
        vm.prank(caller);
        try batch.assemble() {
            assert(dt >= 5 minutes && dt < 5 minutes + 1 hours);
        } catch {}
    }

    /// Restarting a lapsed window never locks at once: it always gives a fresh 5-minute notice.
    function check_restartAlwaysGivesNotice(address caller, uint256 dt) public {
        vm.assume(dt < 30 days);
        vm.warp(t0 + dt);
        vm.prank(caller);
        try batch.restartCountdown() {
            assert(batch.lockAt() == block.timestamp + 5 minutes);
            assert(batch.phase() == Batch.Phase.Countdown);
        } catch {}
    }

    /// A full batch takes no 81st Credit, by either deposit path.
    function check_neverMoreThan80(bool viaFactory) public {
        vm.startPrank(BOB);
        credits.setApprovalForAll(address(factory), true);
        if (viaFactory) {
            try factory.deposit(address(batch), _ids(81, 1)) {} catch {}
        } else {
            try credits.safeTransferFrom(BOB, address(batch), 81) {} catch {}
        }
        vm.stopPrank();
        assert(batch.count() == 80);
        assert(credits.ownerOf(81) == BOB);
    }
}
```

### test/formal/BatchAuctionFormal.t.sol
```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {FormalBase, svm} from "./FormalBase.sol";
import {Batch} from "../../src/Batch.sol";

/// @dev Plain wallets for bidders and payees: accept ETH, nothing else.
contract Wallet {
    receive() external payable {}
}

/// @dev An assembled batch in auction: Alice (the creator) put in 40, Bob 40. `EARLY` switches the split.
abstract contract AuctionBase is FormalBase {
    Batch internal batch;
    address internal b1;
    address internal b2;

    function _auction(Batch.Split split) internal {
        _world(true);
        credits.mint(ALICE, 40);
        credits.mint(BOB, 40);
        batch = _open(ALICE, _ids(1, 40), split);
        vm.startPrank(BOB);
        credits.setApprovalForAll(address(factory), true);
        factory.deposit(address(batch), _ids(41, 40));
        vm.stopPrank();
        vm.warp(batch.lockAt());
        batch.assemble();
        b1 = address(new Wallet());
        b2 = address(new Wallet());
    }

    function _bid(address who, uint256 v) internal returns (bool ok) {
        vm.deal(who, v);
        vm.prank(who);
        try batch.bid{value: v}() {
            ok = true;
        } catch {}
    }

    /// One accepted bid of `v`, then time runs past the end and anyone settles.
    function _sold(uint256 v) internal {
        vm.assume(v >= 0.01 ether && v <= 1e30);
        assert(_bid(b1, v));
        vm.warp(batch.auctionEnd());
        batch.settle();
    }
}

contract BatchAuctionFormal is AuctionBase {
    function setUp() public {
        _auction(Batch.Split.Equal);
    }

    /// Every accepted outbid raises by at least 5% and 0.01 ETH, and the outbid bidder gets exactly their bid back.
    function check_outbidRaisesAndRefunds(uint256 v1, uint256 v2) public {
        vm.assume(v1 <= 1e30 && v2 <= 1e30);
        vm.assume(_bid(b1, v1));
        if (_bid(b2, v2)) {
            assert(v2 >= v1 + 0.01 ether);
            assert(v2 >= v1 + v1 * 5 / 100);
            assert(b1.balance == v1);
            assert(address(batch).balance == v2);
            assert(batch.highBidder() == b2);
        }
    }

    // check_outbidRaisesAndRefunds and check_settleConservesEth time out as single rules (several nonlinear
    // assertions at once). Each is split below into parts the solver can close.

    /// The outbid bidder gets exactly their bid back, and the batch holds only the new high bid.
    function check_outbidRefundsExactly(uint256 v1, uint256 v2) public {
        vm.assume(v1 <= 1e30 && v2 <= 1e30);
        vm.assume(_bid(b1, v1));
        if (_bid(b2, v2)) {
            assert(b1.balance == v1);
            assert(address(batch).balance == v2);
            assert(batch.highBidder() == b2);
        }
    }

    /// Every accepted outbid is at least 5% and 0.01 ETH above the bid it replaces.
    function check_outbidRaisesEnough(uint256 v1, uint256 v2) public {
        vm.assume(v1 <= 1e30 && v2 <= 1e30);
        vm.assume(_bid(b1, v1));
        if (_bid(b2, v2)) {
            assert(v2 >= v1 + 0.01 ether);
            assert(v2 >= v1 + v1 * 5 / 100);
        }
    }

    /// Settle alone pays out the sale: fees plus both members' shares are exactly the winning bid, the batch
    /// ends empty, and neither member has anything left to claim.
    function check_settlePaysOutExactly(uint256 v) public {
        _sold(v);
        assert(batch.claimable(ALICE) == 0 && batch.claimable(BOB) == 0);
        assert(batch.claimed(ALICE) && batch.claimed(BOB));
        assert(address(batch).balance == 0);
        assert(FEE.balance + ALICE.balance + BOB.balance == v);
    }

    /// Equal split: two members with 40 Credits each are owed the same.
    function check_equalSplitIsEqual(uint256 v) public {
        _sold(v);
        assert(batch.unitsOf(ALICE) * batch.payoutPerUnit() == batch.unitsOf(BOB) * batch.payoutPerUnit());
        assert(ALICE.balance - v * CREATOR_BPS / 10_000 == BOB.balance);
        assert(statement.ownerOf(batch.statementId()) == b1);
    }

    /// A bid can never shorten the auction, and a late bid always leaves at least 15 minutes.
    function check_bidNeverShortensAuction(uint256 v1, uint256 v2, uint256 dt) public {
        vm.assume(v1 <= 1e30 && v2 <= 1e30 && dt < 30 days);
        vm.assume(_bid(b1, v1));
        uint256 end = batch.auctionEnd();
        vm.warp(block.timestamp + dt);
        if (_bid(b2, v2)) {
            assert(batch.auctionEnd() >= end);
            assert(batch.auctionEnd() >= block.timestamp + 15 minutes);
        }
    }

    /// No settlement before the clock runs out.
    function check_noSettleBeforeEnd(uint256 v, uint256 dt, address caller) public {
        vm.assume(v <= 1e30 && dt < 30 days);
        vm.assume(_bid(b1, v));
        vm.warp(block.timestamp + dt);
        vm.prank(caller);
        try batch.settle() {
            assert(block.timestamp >= batch.auctionEnd());
        } catch {}
    }

    /// Settlement conserves the sale: fees plus every member's share is exactly the winning bid, nothing is
    /// left stuck and nothing is paid twice. The Statement goes to the winner.
    function check_settleConservesEth(uint256 v) public {
        _sold(v);
        assert(statement.ownerOf(batch.statementId()) == b1);
        assert(FEE.balance >= v * PROTOCOL_BPS / 10_000);
        assert(address(batch).balance == 0);
        assert(FEE.balance + ALICE.balance + BOB.balance == v);
        // equal split: 40 shares each
        assert(ALICE.balance - v * CREATOR_BPS / 10_000 == BOB.balance);
    }

    /// A member is paid once: after settle paid them, no claim by anyone pays them again.
    function check_claimOnce(uint256 v, address caller) public {
        _sold(v);
        uint256 paid = BOB.balance;
        vm.prank(caller);
        try batch.claim(BOB) {
            assert(false);
        } catch {}
        assert(BOB.balance == paid);
    }

    /// Settle runs once: no second payout of fees.
    function check_settleOnce(uint256 v, address caller) public {
        _sold(v);
        vm.prank(caller);
        try batch.settle() {
            assert(false);
        } catch {}
    }

    /// Only the winner can pull an undelivered Statement.
    function check_claimStatement_onlyWinner(uint256 v, address caller) public {
        _sold(v);
        vm.prank(caller);
        try batch.claimStatement(caller) {
            assert(caller == b1);
        } catch {}
    }

    /// Nobody, by any call, can take the Statement out of the batch while the auction runs.
    function check_statementStaysDuringAuction(address caller) public {
        _outsider(caller);
        bytes memory data = svm.createCalldata("Batch");
        vm.prank(caller);
        (bool ok,) = address(batch).call(data);
        ok;
        if (!batch.settled()) assert(statement.ownerOf(batch.statementId()) == address(batch));
    }
}

contract BatchEarlyFormal is AuctionBase {
    function setUp() public {
        _auction(Batch.Split.Early);
    }

    /// Early split: the 80 positions' weights add to exactly the sale net of fees, first money earns more,
    /// and the batch pays out everything it holds.
    function check_earlySplitConserves(uint256 v) public {
        _sold(v);
        assert(batch.unitsOf(ALICE) + batch.unitsOf(BOB) == 12_640);
        uint256 creatorFee = v * CREATOR_BPS / 10_000;
        assert(address(batch).balance == 0);
        assert(FEE.balance + ALICE.balance + BOB.balance == v);
        assert(ALICE.balance - creatorFee >= BOB.balance);
    }
}
```

### test/formal/BatchInvariantFormal.t.sol
```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {FormalBase} from "./FormalBase.sol";
import {Batch} from "../../src/Batch.sol";

/// @dev Sequences of calls (Halmos invariant mode): Alice and Bob each hold 2 Credits and have 1 in an open
///      batch. Any sender calls any Batch function, or sends a Credit into the batch through the hook, in any
///      order up to --invariant-depth. After every step the books must match what the batch holds.
contract BatchInvariantFormal is FormalBase {
    Batch internal batch;

    function setUp() public {
        _world(true);
        credits.mint(ALICE, 2); // #1 in the batch, #2 loose
        credits.mint(BOB, 2); // #3 in the batch, #4 loose
        batch = _open(ALICE, _ids(1, 1), Batch.Split.Equal);
        vm.startPrank(BOB);
        credits.setApprovalForAll(address(factory), true);
        factory.deposit(address(batch), _ids(3, 1));
        vm.stopPrank();

        targetContract(address(batch));
        targetContract(address(credits));
        bytes4[] memory sel = new bytes4[](1);
        sel[0] = bytes4(keccak256("safeTransferFrom(address,address,uint256)"));
        targetSelector(FuzzSelector(address(credits), sel));
        targetSender(ALICE);
        targetSender(BOB);
    }

    /// Shares always add up to the Credits held, and never exceed 80.
    function invariant_sharesMatchCount() public view {
        uint256 n = batch.count();
        assert(n <= 80);
        assert(batch.sharesOf(ALICE) + batch.sharesOf(BOB) == n);
    }

    /// Every Credit on the books is in the batch; every Credit in the batch is on the books.
    function invariant_booksMatchHoldings() public view {
        for (uint256 id = 1; id <= 4; ++id) {
            bool held = credits.ownerOf(id) == address(batch);
            bool booked = batch.depositorOf(id) != address(0);
            assert(held == booked);
        }
    }

    /// Only the two people who put Credits in are ever on the books (no depositor appears from nowhere).
    /// Alice and Bob may pass loose Credits to each other; that's theirs to do, so it isn't ruled out.
    function invariant_onlyRealDepositors() public view {
        for (uint256 id = 1; id <= 4; ++id) {
            address d = batch.depositorOf(id);
            assert(d == address(0) || d == ALICE || d == BOB);
        }
    }
}
```

### test/formal/SweeperFormal.t.sol
```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {FormalBase} from "./FormalBase.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {Wallet} from "./BatchAuctionFormal.t.sol";
import {FormalSeaport} from "./FormalSeaport.sol";
import {MockFWAMarket} from "../SweeperFWA.t.sol";
import {Batch} from "../../src/Batch.sol";
import {Sweeper} from "../../src/Sweeper.sol";
import {ICreditStrategy} from "../../src/interfaces/ICreditStrategy.sol";
import {IFWAMarket} from "../../src/interfaces/IFWAMarket.sol";
import {
    AdvancedOrder, ConsiderationItem, ISeaport, ItemType, OfferItem, OrderParameters, OrderType
} from "../../src/interfaces/ISeaport.sol";

/// @dev CreditStrategy's sale rule as the Sweeper relies on it: exact price, delivery to the caller, price
///      cleared once sold.
contract FormalStrategy {
    address public immutable collection;
    mapping(uint256 => uint256) public nftForSale;

    constructor(address c) {
        collection = c;
    }

    function offer(uint256 id, uint256 price) external {
        nftForSale[id] = price;
    }

    function sellTargetNFT(uint256 id) external payable {
        require(nftForSale[id] != 0 && msg.value == nftForSale[id], "price");
        delete nftForSale[id];
        IERC721(collection).transferFrom(address(this), msg.sender, id);
    }
}

/// @dev Three sellers, one Credit each: #2 on Seaport, #3 on FWA's marketplace, #4 held by CreditStrategy.
///      An open batch holds Alice's #1. A buyer sweeps into the batch.
contract SweeperFormal is FormalBase {
    Sweeper internal sweeper;
    FormalSeaport internal seaport;
    MockFWAMarket internal fwa;
    FormalStrategy internal strategy;
    Batch internal batch;
    address internal buyer;
    address internal seller;
    address internal fwaSeller;
    uint256 internal constant FEE_BPS = 200;

    function setUp() public {
        _world(true);
        seaport = new FormalSeaport();
        fwa = new MockFWAMarket();
        strategy = new FormalStrategy(address(credits));
        sweeper = new Sweeper(ISeaport(address(seaport)), factory, FEE_BPS, IFWAMarket(address(fwa)), ICreditStrategy(address(strategy)));
        buyer = address(new Wallet());
        seller = address(new Wallet());
        fwaSeller = address(new Wallet());
        credits.mint(ALICE, 1); // #1
        credits.mint(seller, 1); // #2
        credits.mint(fwaSeller, 1); // #3
        credits.mint(address(strategy), 1); // #4
        vm.prank(seller);
        credits.setApprovalForAll(address(seaport), true);
        batch = _open(ALICE, _ids(1, 1), Batch.Split.Equal);
    }

    function _order(uint256 price) internal view returns (AdvancedOrder[] memory o) {
        o = new AdvancedOrder[](1);
        OrderParameters memory p;
        p.offerer = seller;
        p.offer = new OfferItem[](1);
        p.offer[0] = OfferItem(ItemType.ERC721, address(credits), 2, 1, 1);
        p.consideration = new ConsiderationItem[](1);
        p.consideration[0] = ConsiderationItem(ItemType.NATIVE, address(0), 0, price, price, payable(seller));
        p.orderType = OrderType.FULL_OPEN;
        o[0].parameters = p;
        o[0].numerator = 1;
        o[0].denominator = 1;
    }

    /// Only the fee recipient changes the sweep fee, and never above 5%.
    function check_setFee_onlyRecipientAndCapped(address caller, uint256 bps) public {
        vm.prank(caller);
        try sweeper.setFee(bps) {
            assert(caller == FEE);
        } catch {}
        assert(sweeper.feeBps() <= 500);
    }

    /// A Seaport sweep holds nothing afterwards, charges exactly listing + fee, refunds the rest, and records the
    /// buyer (not the Sweeper) as depositor.
    function check_sweepExactAndHoldsNothing(uint256 price, uint256 value) public {
        vm.assume(price <= 1e30 && value <= 1e30);
        vm.deal(buyer, value);
        vm.prank(buyer);
        try sweeper.sweep{value: value}(address(batch), _order(price), 1, FEE_BPS) {
            uint256 fee = price * FEE_BPS / 10_000;
            assert(address(sweeper).balance == 0);
            assert(buyer.balance == value - price - fee);
            assert(seller.balance == price);
            assert(FEE.balance == fee);
            assert(batch.depositorOf(2) == buyer);
            assert(credits.ownerOf(2) == address(batch));
        } catch {
            assert(buyer.balance == value);
        }
    }

    /// Across all three markets in one sweep: the buyer pays exactly what the listings they got cost plus the
    /// fee, never more than they were quoted; a listing whose live price differs from the quote is skipped,
    /// never paid; every Credit bought is booked to the buyer; the Sweeper keeps nothing.
    function check_sweepAllExactAndHoldsNothing(
        uint96 fwaLive,
        uint256 fwaQuote,
        uint256 stratLive,
        uint256 stratQuote,
        uint256 seaPrice,
        uint256 value
    ) public {
        vm.assume(fwaQuote <= 1e30 && stratLive <= 1e30 && stratQuote <= 1e30 && seaPrice <= 1e30 && value <= 4e30);
        vm.startPrank(fwaSeller);
        credits.setApprovalForAll(address(fwa), true);
        uint256 listingId = fwa.list(address(credits), 3, fwaLive);
        vm.stopPrank();
        strategy.offer(4, stratLive);
        vm.roll(block.number + 1);

        Sweeper.FWAListing[] memory fl = new Sweeper.FWAListing[](1);
        fl[0] = Sweeper.FWAListing(listingId, fwaQuote);
        Sweeper.StrategyListing[] memory sl = new Sweeper.StrategyListing[](1);
        sl[0] = Sweeper.StrategyListing(4, stratQuote);

        vm.deal(buyer, value);
        vm.prank(buyer);
        try sweeper.sweepAll{value: value}(address(batch), _order(seaPrice), fl, sl, 1, FEE_BPS) {
            bool gotF = credits.ownerOf(3) == address(batch);
            bool gotS = credits.ownerOf(4) == address(batch);
            // bought only at the quoted price
            if (gotF) assert(fwaQuote == fwaLive);
            if (gotS) assert(stratQuote == stratLive && stratLive != 0);
            uint256 spent = seaPrice + (gotF ? fwaQuote : 0) + (gotS ? stratQuote : 0);
            uint256 fee = spent * FEE_BPS / 10_000;
            assert(address(sweeper).balance == 0);
            assert(buyer.balance == value - spent - fee);
            assert(FEE.balance == fee);
            assert(batch.depositorOf(2) == buyer);
            if (gotF) assert(batch.depositorOf(3) == buyer);
            if (gotS) assert(batch.depositorOf(4) == buyer);
            assert(credits.ownerOf(3) == address(batch) || credits.ownerOf(3) == address(fwa));
            assert(credits.ownerOf(4) == address(batch) || credits.ownerOf(4) == address(strategy));
        } catch {
            assert(buyer.balance == value);
        }
    }

    /// buy(): the same three markets, straight to the wallet. The buyer ends up owning every Credit bought, pays
    /// exactly what those listings cost plus the fee (only at quoted prices), and the Sweeper keeps no ETH and no
    /// Credit. Nothing is deposited anywhere.
    function check_buyExactAndHoldsNothing(
        uint96 fwaLive,
        uint256 fwaQuote,
        uint256 stratLive,
        uint256 stratQuote,
        uint256 seaPrice,
        uint256 value
    ) public {
        vm.assume(fwaQuote <= 1e30 && stratLive <= 1e30 && stratQuote <= 1e30 && seaPrice <= 1e30 && value <= 4e30);
        vm.startPrank(fwaSeller);
        credits.setApprovalForAll(address(fwa), true);
        uint256 listingId = fwa.list(address(credits), 3, fwaLive);
        vm.stopPrank();
        strategy.offer(4, stratLive);
        vm.roll(block.number + 1);

        Sweeper.FWAListing[] memory fl = new Sweeper.FWAListing[](1);
        fl[0] = Sweeper.FWAListing(listingId, fwaQuote);
        Sweeper.StrategyListing[] memory sl = new Sweeper.StrategyListing[](1);
        sl[0] = Sweeper.StrategyListing(4, stratQuote);

        vm.deal(buyer, value);
        vm.prank(buyer);
        try sweeper.buy{value: value}(_order(seaPrice), fl, sl, 1, FEE_BPS) {
            bool gotF = credits.ownerOf(3) == buyer;
            bool gotS = credits.ownerOf(4) == buyer;
            if (gotF) assert(fwaQuote == fwaLive);
            if (gotS) assert(stratQuote == stratLive && stratLive != 0);
            uint256 spent = seaPrice + (gotF ? fwaQuote : 0) + (gotS ? stratQuote : 0);
            uint256 fee = spent * FEE_BPS / 10_000;
            assert(address(sweeper).balance == 0);
            assert(buyer.balance == value - spent - fee);
            assert(FEE.balance == fee);
            assert(credits.ownerOf(2) == buyer);
            assert(credits.balanceOf(address(sweeper)) == 0);
            assert(credits.ownerOf(3) == buyer || credits.ownerOf(3) == address(fwa));
            assert(credits.ownerOf(4) == buyer || credits.ownerOf(4) == address(strategy));
            assert(batch.count() == 1); // untouched
        } catch {
            assert(buyer.balance == value);
            assert(credits.ownerOf(2) == seller);
        }
    }

    /// buy() is held to the quoted fee too.
    function check_buyFeeRaiseNeverSlipsIn(uint256 quoted, uint256 price) public {
        vm.assume(price <= 1e30 && quoted < FEE_BPS);
        uint256 value = price * 2 + 1 ether;
        vm.deal(buyer, value);
        vm.prank(buyer);
        try sweeper.buy{value: value}(_order(price), new Sweeper.FWAListing[](0), new Sweeper.StrategyListing[](0), 1, quoted) {
            assert(false);
        } catch {}
    }

    /// A raised fee never applies to a sweep quoted at the old rate.
    function check_feeRaiseNeverSlipsIn(uint256 quoted, uint256 price) public {
        vm.assume(price <= 1e30 && quoted < FEE_BPS);
        uint256 value = price * 2 + 1 ether;
        vm.deal(buyer, value);
        vm.prank(buyer);
        try sweeper.sweep{value: value}(address(batch), _order(price), 1, quoted) {
            assert(false);
        } catch {}
    }

    /// Sweeps only ever deposit into batches the factory made.
    function check_sweepOnlyIntoBatches(address target, uint256 price) public {
        vm.assume(!factory.isBatch(target) && price <= 1e30);
        vm.deal(buyer, price * 2);
        vm.prank(buyer);
        try sweeper.sweep{value: price * 2}(target, _order(price), 1, FEE_BPS) {
            assert(false);
        } catch {}
    }

    /// The Sweeper can't be pointed at a strategy that trades some other collection.
    function check_constructorRejectsOtherStrategy(address collection) public {
        FormalStrategy other = new FormalStrategy(collection);
        try new Sweeper(ISeaport(address(seaport)), factory, FEE_BPS, IFWAMarket(address(fwa)), ICreditStrategy(address(other))) {
            assert(collection == address(credits));
        } catch {}
    }
}
```

### test/formal/FormalSeaport.sol
```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {
    AdvancedOrder, CriteriaResolver, Execution, FulfillmentComponent, ItemType, ReceivedItem
} from "../../src/interfaces/ISeaport.sol";

/// @dev Minimal Seaport for the formal suite: each order sells its one ERC721 for its consideration items in
///      ETH (startAmount), paid to their recipients; an order whose offerer no longer holds the Credit is
///      skipped as unavailable; unspent ETH goes back to the caller. Same return shape as Seaport 1.6.
contract FormalSeaport {
    function fulfillAvailableAdvancedOrders(
        AdvancedOrder[] calldata orders,
        CriteriaResolver[] calldata,
        FulfillmentComponent[][] calldata,
        FulfillmentComponent[][] calldata,
        bytes32,
        address recipient,
        uint256
    ) external payable returns (bool[] memory available, Execution[] memory executions) {
        available = new bool[](orders.length);
        uint256 nc;
        for (uint256 i; i < orders.length; ++i) nc += orders[i].parameters.consideration.length;
        executions = new Execution[](nc + orders.length);
        uint256 k;
        uint256 spent;
        for (uint256 i; i < orders.length; ++i) {
            address seller = orders[i].parameters.offerer;
            IERC721 token = IERC721(orders[i].parameters.offer[0].token);
            uint256 id = orders[i].parameters.offer[0].identifierOrCriteria;
            if (token.ownerOf(id) != seller) continue;
            available[i] = true;
            token.transferFrom(seller, recipient, id);
            executions[k++].item = ReceivedItem(ItemType.ERC721, address(token), id, 1, payable(recipient));
            for (uint256 j; j < orders[i].parameters.consideration.length; ++j) {
                uint256 amt = orders[i].parameters.consideration[j].startAmount;
                address payable to = orders[i].parameters.consideration[j].recipient;
                spent += amt; // reverts (underflow below) if the caller sent too little
                (bool ok,) = to.call{value: amt}("");
                require(ok);
                executions[k++].item = ReceivedItem(ItemType.NATIVE, address(0), 0, amt, to);
            }
        }
        assembly {
            mstore(executions, k)
        }
        (bool back,) = msg.sender.call{value: msg.value - spent}("");
        require(back);
    }
}
```

### test/formal/RatingsFormal.t.sol
```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Ratings, DataStore} from "../../src/Ratings.sol";

/// @dev A three-Credit table: #1 = 80.0, #2 = 0x1234, #3 = 800.0, stored little-endian as the deployer writes it.
contract RatingsFormal is Test {
    Ratings internal ratings;
    address internal chunk;

    function setUp() public {
        chunk = DataStore.write(hex"2003" hex"3412" hex"401f");
        address[] memory c = new address[](1);
        c[0] = chunk;
        ratings = new Ratings(c, 3, "test");
    }

    /// Unknown ids score 0, which Batch treats as "never admitted by a rating rule".
    function check_unknownIdScoresZero(uint256 id) public view {
        vm.assume(id == 0 || id > 3);
        assert(ratings.scoreOf(id) == 0);
    }

    /// Every known id reads back exactly the score stored for it. Halmos can't take a symbolic EXTCODECOPY
    /// offset, so the symbolic id is split into its three possible values before the read.
    function check_knownIdsReadExactly(uint256 id) public view {
        vm.assume(id >= 1 && id <= 3);
        uint256 k = id == 1 ? 1 : id == 2 ? 2 : 3;
        uint16 s = ratings.scoreOf(k);
        assert(k == 1 ? s == 800 : k == 2 ? s == 0x1234 : s == 8000);
    }

    /// The table can only be deployed with exactly the data it claims to cover (so no id maps past a chunk).
    function check_constructorRejectsWrongCount(uint256 n) public {
        address[] memory c = new address[](1);
        c[0] = chunk;
        try new Ratings(c, n, "test") {
            assert(n == 3);
        } catch {}
    }
}
```

### test/formal/RatingsSwitchFormal.t.sol
```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {FormalBase, svm} from "./FormalBase.sol";
import {ratingsOf} from "../../script/RatingsOf.sol";
import {Batch, IRatings} from "../../src/Batch.sol";
import {BatchFactory} from "../../src/BatchFactory.sol";
import {IAssembler} from "../../src/interfaces/IAssembler.sol";
import {ICredits} from "../../src/interfaces/ICredits.sol";
import {MockCredits} from "../../src/mocks/MockCredits.sol";
import {MockStatement} from "../../src/mocks/MockStatement.sol";
import {MockAssembler} from "../../src/mocks/MockAssembler.sol";
import {Ratings, DataStore} from "../../src/Ratings.sol";

/// @dev Moving to a later score table: who may propose, the notice, that nothing else moves the factory's table,
///      that create() only opens on the table the caller expected, and that an open batch keeps its own.
contract RatingsSwitchFormal is FormalBase {
    Ratings internal v3;
    Ratings internal v4;
    Batch internal batch;

    function setUp() public {
        vm.warp(1_000_000);
        v3 = _table(hex"2003" hex"3412" hex"401f", "3.4.0");
        v4 = _table(hex"401f" hex"3412" hex"2003", "4.0.0");
        credits = new MockCredits();
        statement = new MockStatement(ICredits(address(credits)));
        asm_ = new MockAssembler(statement);
        factory = new BatchFactory(
            ICredits(address(credits)), IRatings(address(v3)), IAssembler(address(asm_)), SETTER, FEE, PROTOCOL_BPS, CREATOR_BPS, 1
        );
        credits.mint(ALICE, 1);
        batch = _open(ALICE, _ids(1, 1), Batch.Split.Equal);
    }

    function _table(bytes memory data, string memory version) internal returns (Ratings r) {
        address[] memory c = new address[](1);
        c[0] = DataStore.write(data);
        r = new Ratings(c, 3, version);
    }

    function _propose() internal {
        vm.prank(FEE);
        factory.proposeRatings(IRatings(address(v4)));
    }

    /// Only the fee recipient proposes a table.
    function check_proposeRatings_onlyFeeRecipient(address caller) public {
        vm.prank(caller);
        try factory.proposeRatings(IRatings(address(v4))) {
            assert(caller == FEE);
        } catch {}
    }

    /// A proposed table cannot go live before its 30-minute notice, whoever activates it.
    function check_activateRatings_notBeforeDelay(address caller, uint256 wait) public {
        _propose();
        uint256 proposedAt = block.timestamp;
        vm.assume(wait < 365 days);
        vm.warp(proposedAt + wait);
        vm.prank(caller);
        try factory.activateRatings() {
            assert(wait >= 30 minutes);
        } catch {}
    }

    /// With a proposal pending, no call except activateRatings() (and create(), below) moves the factory's table,
    /// whoever makes it.
    function check_ratings_onlyActivateMovesIt_exceptCreate(address caller) public {
        _propose();
        vm.warp(block.timestamp + 30 minutes);
        bytes memory data = svm.createCalldata("BatchFactory");
        vm.assume(bytes4(data) != factory.create.selector && bytes4(data) != factory.activateRatings.selector);
        vm.prank(caller);
        (bool ok,) = address(factory).call(data);
        ok;
        assert(address(factory.ratings()) == address(v3));
    }

    /// create() never moves the factory's table.
    function check_ratings_unchangedByCreate(address caller, uint256 id) public {
        _propose();
        vm.warp(block.timestamp + 30 minutes);
        Batch.Filter memory f;
        uint256[] memory ids = new uint256[](1);
        ids[0] = id;
        vm.prank(caller);
        try factory.create("x", f, new uint256[](0), 0, Batch.Arrangement.Deposit, Batch.Split.Equal, 3 days, ids, PROTOCOL_BPS, CREATOR_BPS, IRatings(address(v3))) {}
            catch {}
        assert(address(factory.ratings()) == address(v3));
    }

    /// A batch only opens on the table its creator expected, and it keeps exactly that table.
    function check_create_onlyOnExpectedTable(address expect) public {
        credits.mint(BOB, 1);
        Batch.Filter memory f;
        vm.startPrank(BOB);
        credits.setApprovalForAll(address(factory), true);
        try factory.create("x", f, new uint256[](0), 0, Batch.Arrangement.Deposit, Batch.Split.Equal, 3 days, _ids(2, 1), PROTOCOL_BPS, CREATOR_BPS, IRatings(expect)) returns (address b) {
            assert(expect == address(v3));
            assert(address(Batch(b).ratings()) == address(v3));
        } catch {}
        vm.stopPrank();
    }

    /// After the factory moves to a new table, no call to an open batch by anyone changes the table it opened with.
    function check_openBatch_keepsItsTable(address caller) public {
        _propose();
        vm.warp(block.timestamp + 30 minutes);
        factory.activateRatings();
        assert(address(factory.ratings()) == address(v4));
        bytes memory data = svm.createCalldata("Batch");
        vm.prank(caller);
        (bool ok,) = address(batch).call(data);
        ok;
        assert(address(batch.ratings()) == address(v3));
    }
}
```

### test/formal/run.sh
```bash
#!/usr/bin/env bash
# Runs each Halmos rule on its own with a wall-clock cap, so one slow rule can't hide the others.
# Usage: test/formal/run.sh <Contract> [seconds per rule, default 900] [extra halmos flags...]
# Full output per rule lands in test/formal/logs/<Contract>.<rule>.log.
set -u
c=$1; cap=${2:-900}; shift; shift 2>/dev/null || true
cd "$(dirname "$0")/../.."
mkdir -p test/formal/logs
file=$(grep -l "^contract $c " test/formal/*.t.sol) || { echo "no contract $c"; exit 1; }
# the check_ functions declared inside contract $c (up to the next top-level contract)
for f in $(awk -v c="$c" '/^(abstract )?contract /{on = ($2 == c)} on && /function check_/{sub(/.*function /, ""); sub(/\(.*/, ""); print}' "$file"); do
  log=test/formal/logs/$c.$f.log
  echo "\$ halmos --match-contract '^$c\$' --match-test '^$f\(' $*" > "$log"
  perl -e 'alarm shift; exec @ARGV' "$cap" halmos --match-contract "^$c\$" --match-test "^$f\(" --no-status "$@" >> "$log" 2>&1
  rc=$?
  [ $rc -eq 142 ] && echo "TIMED OUT after ${cap}s (wall clock)" >> "$log"
  echo "$c.$f rc=$rc $(grep -Eo '\[(PASS|FAIL|TIMEOUT|ERROR)\][^(]*' "$log" | head -1)"
done
```
