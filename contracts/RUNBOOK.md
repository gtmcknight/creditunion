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
   - Note the gas it logs for one burn. It must fit well under 16,777,216, the most any mainnet transaction may
     carry (EIP-7825): the page's Make Statement sends 16M (`web/src/app/views/party.ts`).
4. **Review it** the way the rest was reviewed ([AUDIT.md](AUDIT.md)) and write the findings up.
5. **Deploy it:** `STATEMENTS=<his address> forge script script/DeployAdapter.s.sol --rpc-url $MAINNET_RPC --broadcast --verify`.
   It refuses mainnet while `ADAPTER_READY` is false. Put the address in README.md and ADAPTER.md and post it.
6. **Site:** point it at the adapter so creators can pick their union's direction (fixed once the countdown
   starts), and put up the Oct 1 banner.
7. **Safe:** prepare `proposeAssembler(<adapter>)` and collect 2 of 3 signatures ahead of time. Don't execute yet.

## Thursday, Oct 1

| ET | UTC | |
|---|---|---|
| by 6:00pm | 22:00 | The keeper is on: `KEEPER_KEY` is set (`wrangler secret put KEEPER_KEY`) and the key holds enough ETH for every full union's burn (its address is at `/burns`). `KEEPER_MAX_GWEI` isn't below the day's gas price. **Burns are held:** `pnpm wrangler kv key get --binding PLANS burns-open --remote` is empty (not `1` or a time). While held, union pages keep Convert Union to Statement disabled. The keeper never burns; it turns burning on and settles. |
| **7:30pm** | 23:30 | **Execute the Safe's `proposeAssembler`.** Not earlier: the keeper switches it on as soon as the 30-minute notice ends, and a union that locks before Jack's contract opens only fails its burn and loses its hour. The site shows the notice bar; anyone can still leave any union. |
| 8:00pm | 00:00 | Burning switches on: anyone calls `activateAssembler()`, the keeper within 5 minutes, or press it ourselves at 8:00. Every full union starts its 5-minute countdown. |
| ~8:05pm | 00:05 | The first union can burn. Open it with `?burn` on the URL (`/union/<address>?burn`), press **Make Statement** ourselves and check: the Statement is on the union page, the 80 are gone, the direction is right, the auction is open. |
| once it checks out | | **Open burns:** `pnpm wrangler kv key put --binding PLANS burns-open 1 --remote` opens them now. Or put a unix time (`burns-open 1790902800`) a few minutes ahead: every union page counts down to it ("Opens in 4:32 · At 8:15 PM") and opens by itself. Convert Union to Statement then works on every union page, and each union burns when someone presses it. Then post. A union nobody burns within its hour unlocks; anyone can restart its countdown. |
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

- **creditunion.fun is down or slow during an auction:** nothing depends on it. Pages that load already read and
  send through the visitor's wallet when `/rpc` fails. Point people to creditunionfun.eth.limo (the mirror, below)
  or to Etherscan: the union's address, Contract, Write as Proxy, then `bid` (the bid as the value), `settle` or
  `claim`.

## The mirror

creditunionfun.eth.limo: one static page that bids, settles, claims, refunds and burns through the visitor's own
wallet, with nothing from creditunion.fun. `mirror/README.md` has its CID, how to check the file and how to change
it; `.github/workflows/mirror.yml` publishes the same file to GitHub Pages once Pages is on (Settings → Pages →
GitHub Actions).
