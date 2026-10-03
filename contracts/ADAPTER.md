# The adapter: how a Credit Union becomes a Statement

> **Status, Oct 1 2026: live.** `StatementAdapter` at
> [0x6CAEb9953bA8625226345CF39F93541CE53AbFd2](https://etherscan.io/address/0x6CAEb9953bA8625226345CF39F93541CE53AbFd2)
> (source verified) has been the factory's adapter since 8:10 PM ET on Oct 1, for good. It burns into Jack
> Butcher's Statements contract at
> [0x75Edd94b7e49b3bD5C8047b91F165A5e265a069b](https://etherscan.io/address/0x75Edd94b7e49b3bD5C8047b91F165A5e265a069b).
> A union burn takes 10–12M gas, under mainnet's 16,777,216 per-transaction cap (EIP-7825). The burn-day
> record and the runbook are [RUNBOOK.md](RUNBOOK.md).

Credit Union pools Credits, and Jack Butcher's Statement contract
([his announcement](https://x.com/jackbutcher/status/2102910106451021935)) burns 80 Credits into a Statement. The
piece that connects the two is the **adapter** (called the assembler in the code). This doc is how it works, how
it was switched on, and what can go wrong.

## How it fits

- `BatchFactory`'s adapter is `StatementAdapter`, for good. Before it, a Credit Union never locked: anyone could
  withdraw at any time, even at 80/80.
- Each Credit Union already decides its own burn order (`Batch.burnOrder()`: deposit order, Credit number up or
  down, or the painted sheet). The adapter receives that list and burns it as is, except for a picture with
  recorded spots (below).
- The adapter interface is fixed: `contracts/src/interfaces/IAssembler.sol`.
  - `statement()`: the Statement contract it mints from.
  - `assemble(uint256[] ids, uint8 arrangement)`: burn these 80 Credits and give the calling Credit Union the Statement.
- After the adapter returns, the Credit Union checks its work itself: none of the 80 Credits may still exist, and
  the Credit Union must own the Statement the adapter reports. If either check fails, the whole burn reverts.
- The adapter is an operator for the Credit Union's Credits only for the length of that one call.

## `StatementAdapter`

- **It takes the 80 in first.** Jack's `compose` burns only its caller's own Credits, and a union can approve only
  the adapter, so the adapter moves the 80 to itself (in the union's order) and calls `compose` with the union as
  the recipient: the Statement is minted straight to the union. Moving them in costs 3.1M gas; there is no way
  around it with his contract.
- **Formats.** His contract calls the drawing a format: an index into a list he can append to until he seals it.
  At launch: 0 Issued, 1 Consolidated, 2 Assessed, 3 Reconciled, 4 Accrued, 5 Amortized, 6 Liquidated,
  7 Recorded. A union always tells the adapter "Deposit" (its code can't change), so the adapter keeps each
  union's format outside the union (`formatOf`): the creator's pick in UnionFormats, a separate contract deployed
  ahead so creators can pick before burning opens. With no pick it's Consolidated for a picture,
  a layout painted in colors with every slot painted (`isPicture`), and Issued for everything else. Only
  Consolidated shows a picture edge to edge, the way the site previews it; in Issued it's faint tiles, and
  Reconciled and Liquidated don't keep cell positions at all. The creator can change it while every member can
  still leave (while the union fills, while it waits for burning to open, after a burn hour lapses) and not from
  the countdown on. Any format on his list is choosable, Issued for a picture included, and ones he adds later.
  The format is only where the Statement starts: whoever owns it (the auction's winner, once it settles) can switch
  it any time with his `setFormat`.
- **Order.** Cell i of the Statement is the union's i-th Credit (`burnOrder()`), 8 across and 10 down, row by row.
- **A picture's Credits keep their spots.** A picture's own layout order gives each Colors' spots to that Colors'
  Credits in the order they went in, so one early leave slides every later Credit of that Colors back a spot and
  scrambles the picture. `record(union)` writes down where each Credit sits. Anyone can call it, and it only ever
  writes `orderOf(union)`. From then on a leave opens only the leaver's spot, and the next Credit of that Colors
  fills it. On the site, a leave saves the spots first when they aren't saved (one batch where the wallet allows,
  else save, check, then leave), and the keeper records each picture once when it reaches 80/80. A leave sent
  straight to the contract skips that, so Credits that joined since the last save can slide. The burn puts recorded
  Credits in their spots and the rest of each Colors in layout order, working only from the 80 the union hands
  over: always those 80, each in a spot of its own Colors. With nothing recorded, the burn is the layout order. The
  most this adds to a burn is about 230k gas.
- **Only the factory's unions** can use it, and it holds nothing between calls.
- **`ADAPTER_READY`** kept the deploy script (`script/DeployAdapter.s.sol`) off mainnet until the fork test passed
  against the deployed Statements contract. It's true in the deployed adapter.
- **Tests:** `test/StatementAdapter.fork.t.sol` runs burn day on a copy of mainnet, on the block before the adapter
  switched on, against the live Statements contract: the real All Credits union, the Safe's proposal, the burn, the
  auction, every member paid, and the gas against the cap.

## Who can switch it on

One address, the factory's **setter**, can propose an adapter. It has no other power:
- It can't touch Credits, ETH, fees, Credit Unions or auctions.
- It can replace a pending proposal (restarting the notice), but only until an adapter is live.
- Once an adapter is active it's permanent. Nobody, including the setter, can change it.

**Setter on mainnet:** the Credit Union team's Safe,
[0xFE4761e66C2A37492871d30d0e83bcBC454A7C10](https://etherscan.io/address/0xFE4761e66C2A37492871d30d0e83bcBC454A7C10),
2 of 3 signers. On Sepolia the setter is the deployer.

## The switch-on, step by step

1. **Jack deployed the Statement contract** (Oct 1, block 26100733).
2. **We checked the adapter** against it: the fork test with `STATEMENTS=<his address>`, every test passing. The
   Credit Union side checks above don't change.
3. **It's public:** deployed and verified on Etherscan, and its source here, under `contracts/src/`.
4. **It was tested** (next section).
5. **The setter proposed it:** `factory.proposeAssembler(adapter)`. That starts a **30-minute notice**, shown on
   the site. Nothing locks during it, and anyone who doesn't trust the adapter can withdraw. The first proposal
   had to be replaced, which restarted the notice ([RUNBOOK.md](RUNBOOK.md)).
6. **It was activated** after the notice, `factory.activateAssembler()`, at 8:10 PM ET on Oct 1. It's permanent.
7. **How Credit Unions burn:**
   - Every Credit Union already at 80 starts a **5-minute countdown**. Withdrawals still work, so it's a last
     chance to leave.
   - After the countdown the Credit Union is **locked for 1 hour**. Nobody can withdraw, and anyone can press
     **Convert Union to Statement** (`assemble()`), paying the gas.
   - If nobody burns within the hour, the Credit Union unlocks. People can leave, and anyone can restart the
     countdown.
8. **Statement auctions** run as they do today: 24 hours from the first bid, and the sale is split among the
   Credit Union.

The site's keeper (`web/src/worker/keeper.ts`, every 5 minutes) activates the adapter once the notice has run,
settles ended auctions and records full pictures' spots. It never burns: every Statement is made by someone pressing Convert Union to Statement. The site shows
the notice as a bar above every page, with when burning starts, in the viewer's own time. There is no race: a union's 80 are its own, and
his contract has no cap beyond the Credits themselves.

## How it was tested

1. **The union's own checks:** an adapter that doesn't burn, keeps the Statement, returns a wrong id or reenters
   reverts the whole burn. These are tested with mock adapters (`test/audit/`, `test/BurnOrder.t.sol`). The draft
   adapter also had unit tests against a stand-in Statements contract; they were dropped once the fork tests ran
   against the real one (`4a6180f`). `UnionFormats` has its own (`test/UnionFormats.t.sol`).
2. **Fork tests against the real Statements contract:** `test/StatementAdapter.fork.t.sol` deploys the adapter on
   a copy of mainnet, fills unions with real Credit ids from impersonated holders, and runs the whole path:
   proposal, countdown, lock, `assemble()`, auction, settle, every member paid. It checks the Credits are burned,
   the union owns the Statement, the cells Jack's contract recorded are `burnOrder()`, every full union on the
   block burns, and the gas fits under the cap, a picture with the costliest recorded spots included. The
   picture's spot order (`orderOf()`) itself isn't checked on the fork. It's pinned to a block, so it needs an archive node:
   `MAINNET_RPC=<url> forge test --match-path test/StatementAdapter.fork.t.sol -vv`.
3. **Burn-day rehearsals on mainnet forks** in place of a Sepolia run. The Sepolia step was skipped.
4. **Mainnet canary:** we sent the first burn ourselves, Union Jack, Statement #1.

Not done: no written review round for the adapter, `UnionFormats` or `LiveRatings` in [AUDIT.md](AUDIT.md), and
none of the three is covered by the Halmos proofs. Nothing in Credit Union has had an independent audit.

## If something goes wrong

- **A burn fails:** the Credit Union's checks revert the whole transaction, so no Credits are lost. The Credit Union stays
  locked until the hour ends, then unlocks.
- **The adapter turns out wrong:** it can't be swapped. Credit Unions that haven't locked can still be left at any
  time before their countdown ends, and locked ones unlock after the hour if they can't burn. The fix is a new
  factory, with people moving to it by withdrawing and depositing again.

## The Statements contract, as deployed

| Question | Answer |
|---|---|
| The call | `compose(uint256[80] creditIds, uint8 format) returns (uint256)`. Burns the caller's own 80, mints to the caller with `_mint` (no receiver hook). Also `compose(creditIds, format, address to)`, minting to `to`; the adapter uses it to mint to the union. |
| Order | Cell i = `creditIds[i]`, 8 across, 10 down, row by row. |
| Format | An index into his list (above). Not fixed: the owner can switch it any time with `setFormat(id, format)` (the owner itself, not an approved operator). |
| Payment, signature, allowlist | None. The holder approves Statements on Credits (`setApprovalForAll`); the adapter does that once in its constructor. |
| Can a contract call it | Yes. |
| Opening time | `composeOpensAt`: 8:00 PM ET on Oct 1, 2026 (1790899200). Every compose before it reverts. |
| Cap, per-address limits | None. 1,526 is just 122,154 / 80; a union's Credits are its own, so there is no race. |
| Gas | Union burns on Oct 1 took 10–12M (Union Jack's: 10.2M), under the 16,777,216 transaction cap. The fork test checks the heaviest sheet a union can hold fits too. |
| Overprinting | Any Statement can be burned onto another its owner controls; the ink, Credits and rating add up. The union never approves anyone, so nobody can overprint a union's Statement while it's up for auction. The winner can. |
| Rating | His contract prints its own Credit Rating (a new curve over the same rarities, not jack.art's v3.4.0). Ranks are identical; single Credits differ by up to ±2.75, a random sheet by about +23. |
