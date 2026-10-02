# The adapter: how a Credit Union becomes a Statement

> **Status, Oct 1 2026: live.** `StatementAdapter` at
> [0x6CAEb9953bA8625226345CF39F93541CE53AbFd2](https://etherscan.io/address/0x6CAEb9953bA8625226345CF39F93541CE53AbFd2)
> (source verified) has been the factory's adapter since 8:10 PM ET on Oct 1, for good. It burns into Jack
> Butcher's Statements contract at
> [0x75Edd94b7e49b3bD5C8047b91F165A5e265a069b](https://etherscan.io/address/0x75Edd94b7e49b3bD5C8047b91F165A5e265a069b).
> A union burn takes 10–12M gas, under mainnet's 16,777,216 per-transaction cap (EIP-7825). The burn-day
> checklist is [RUNBOOK.md](RUNBOOK.md).

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
  scrambles the picture. `record(union)` writes down where each Credit sits. Anyone can call it, and it only
  ever writes `orderOf(union)`. From then on a leave opens only the leaver's spot, and the next Credit of that
  Colors fills it. The site's keeper records after deposits and leaves. The burn puts recorded Credits in their
  spots and the rest of each Colors in layout order, working only from the 80 the union hands over: always those
  80, each in a spot of its own Colors. With nothing recorded, the burn is the layout order. The most this adds
  to a burn is about 230k gas.
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
4. **Test it** (next section). Nothing is proposed until every step passes.
5. **The setter proposes it:** `factory.proposeAssembler(adapter)`. This starts a **30-minute notice**,
   shown on the site. Nothing locks during it, and anyone who doesn't trust the adapter can withdraw.
6. **Anyone activates it** after the 30 minutes: `factory.activateAssembler()`. From here it's permanent.
7. **Credit Unions start burning:**
   - Every Credit Union already at 80 starts a **5-minute countdown**. Withdrawals still work, so it's a last
     chance to leave.
   - After the countdown the Credit Union is **locked for 1 hour**. Nobody can withdraw, and anyone can press
     **Make Statement** (`assemble()`), paying the gas.
   - If nobody burns within the hour, the Credit Union unlocks. People can leave, and anyone can restart the
     countdown.
8. **Statement auctions** run as they do today: 24 hours from the first bid, and the sale is split among the
   Credit Union.

The site's keeper (`web/src/worker/keeper.ts`, every 5 minutes) activates the adapter once the notice has run and
settles ended auctions. It never burns: every Statement is made by someone pressing Make Statement. The site shows
the notice as a bar above every page, with when burning starts, in the viewer's own time. There is no race: a union's 80 are its own, and
his contract has no cap beyond the Credits themselves.

## How we'll test it before proposing

1. **Mainnet fork:**
   - Deploy the adapter on a fork of mainnet with Jack's real Statement contract.
   - Fill a Credit Union with real Credit ids (impersonated holders) in every burn order.
   - Run the full path: countdown, lock, `assemble()`, auction, settle (which pays every member).
   - Check that the Credits are burned, the Statement is owned by the Credit Union, and the order Jack's contract
     received equals `burnOrder()` (`orderOf()` for a picture with recorded spots).
2. **Adversarial cases:**
   - An adapter that doesn't burn, keeps the Statement, returns a wrong id or reenters: every one must revert.
   - These already exist for the mock adapter in `contracts/test/` and get rerun against the real one.
   - `test/StatementAdapter.fork.t.sol` runs this whole list against his contract with `STATEMENTS=<his address>`.
3. **Sepolia:** if Jack deploys a test version of his contract, we repeat the full flow on the site's
   testnet. If he doesn't, we run a Sepolia stand-in with the same interface.
4. **Review:** the adapter goes through the same internal audit process as the rest (`AUDIT.md`), with the
   findings and fixes written up before proposing.
5. **Mainnet canary:** after activation, the first burn is a Credit Union we fill ourselves. We confirm the Statement
   and the auction before telling people to burn theirs.

## If something goes wrong

- **Before activation:** nothing is locked. The setter can't withdraw a proposal, only replace it with another
  adapter, which restarts the 30-minute notice.
- **During the 30-minute notice:** anyone can leave any Credit Union.
- **A burn fails:** the Credit Union's checks revert the whole transaction, so no Credits are lost. The Credit Union stays
  locked until the hour ends, then unlocks.
- **After activation, the adapter turns out wrong:** it can't be swapped. Credit Unions that haven't locked can
  still be left at any time before their countdown ends, and locked ones unlock after the hour if they can't
  burn. The fix would be a new factory, and people moving to it by withdrawing and re-depositing.

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
