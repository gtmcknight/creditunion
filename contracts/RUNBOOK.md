# Burn day: switching the adapter on

Jack's Statement contract opens **Thursday Oct 1, 8:00pm ET (Oct 2 00:00 UTC)**. His contract is due Tuesday night or
early Wednesday. This is the checklist from his publish to the first Statement. Why it's built this way is in
[ADAPTER.md](ADAPTER.md).

| | |
|---|---|
| Factory | `0xcb06f9076e5fbF3cB052086b1EE7C0F3836aa051` |
| Setter (Safe, 2 of 3) | `0xFE4761e66C2A37492871d30d0e83bcBC454A7C10` |
| Credits | `0x97630aA70AB14ed9883B41dAfccBc11349723043` |
| Adapter | `src/StatementAdapter.sol`, a draft until the steps below |

## When Jack publishes (Tue/Wed)

1. **Read his contract** on Etherscan (the source must be verified). Answer ADAPTER.md's open questions: the function
   that burns 80 and mints a Statement, how it takes the direction, whether it needs an approval, a payment or a
   signature, whether a contract may call it, per-address or per-time limits, the opening time and the cap.
2. **Finish `_compose`** in `StatementAdapter.sol` (and `IStatements.sol`) to match. Nothing else in the adapter
   should change. Then set `ADAPTER_READY = true`.
3. **Test it:**
   - `forge test`: everything passes.
   - `STATEMENTS=<his address> forge test --match-path test/StatementAdapter.fork.t.sol -vv`: the whole burn day
     on a copy of mainnet against his real contract, from the Safe's proposal to every member paid.
   - Note the gas it logs for one burn. With the stand-in it's 6.4M. If his pushes it past about 9M, raise
     `ASSEMBLE_GAS` in `web/src/worker/keeper.ts` (the page sends the same) to keep 30% headroom.
4. **Review it** the way the rest was reviewed ([AUDIT.md](AUDIT.md)) and write the findings up.
5. **Deploy it:** `STATEMENTS=<his address> forge script script/DeployAdapter.s.sol --rpc-url $MAINNET_RPC --broadcast --verify`.
   It refuses mainnet while `ADAPTER_READY` is false. Put the address in README.md and ADAPTER.md and post it.
6. **Site:** point it at the adapter so creators can pick their union's direction (fixed once the countdown
   starts), and put up the Oct 1 banner.
7. **Safe:** prepare `proposeAssembler(<adapter>)` and collect 2 of 3 signatures ahead of time. Don't execute yet.

## Thursday, Oct 1

| ET | UTC | |
|---|---|---|
| by 6:00pm | 22:00 | The keeper is on: `KEEPER_KEY` is set (`wrangler secret put KEEPER_KEY`) and the key holds enough ETH for every full union's burn. `KEEPER_MAX_GWEI` isn't below the day's gas price. **Burns are held:** `pnpm wrangler kv key get --binding PLANS burns-open --remote` is empty (not `1`). While held, the keeper still turns burning on and settles, but burns nothing, and union pages hide Make Statement. |
| **7:30pm** | 23:30 | **Execute the Safe's `proposeAssembler`.** Not earlier: the keeper switches it on as soon as the 30-minute notice ends, and a union that locks before Jack's contract opens only fails its burn and loses its hour. The site shows the notice bar; anyone can still leave any union. |
| 8:00pm | 00:00 | Burning switches on: anyone calls `activateAssembler()`, the keeper within 5 minutes, or press it ourselves at 8:00. Every full union starts its 5-minute countdown. |
| ~8:05pm | 00:05 | The first union can burn. Open it with `?burn` on the URL (`/union/<address>?burn`), press **Make Statement** ourselves and check: the Statement is on the union page, the 80 are gone, the direction is right, the auction is open. |
| once it checks out | | **Open burns:** `pnpm wrangler kv key put --binding PLANS burns-open 1 --remote`. Within 5 minutes the keeper burns every other full union, and Make Statement shows on every union page. Then post. Watch `wrangler tail` for `[keeper] can't burn`. |
| if it doesn't | | Leave burns held. Every other union's hour runs out and it unlocks; members can leave. Nothing is lost but the hour. Fix, then anyone restarts the countdowns. |

## If something goes wrong

- **Before the proposal:** nothing is locked. Fix and redeploy.
- **After the proposal, before 8:00pm:** the Safe can't withdraw a proposal. It can only replace it with another
  adapter, which restarts the 30-minute notice. Anyone can still leave any union.
- **A burn fails:** the union's own checks undo the whole transaction, so no Credits move. It stays locked until
  its hour ends, then unlocks. Anyone can press restart once the problem is fixed.
- **Jack's cap runs out** (1,526 Statements): burns fail the same way and unions keep their Credits.
- **After 8:00pm the adapter is permanent.** If it turns out wrong, the fix is a new factory, with members
  withdrawing and depositing again. Unions that haven't locked can always be left.
