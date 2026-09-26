# The adapter: what happens when Jack's Statement contract ships

Credit Union pools Credits now. It can't burn them into Statements until Jack Butcher publishes the Statement
contract, expected around October 1 ([his announcement](https://x.com/jackbutcher/status/2102910106451021935)).
The piece that connects the two is the **adapter** (called the assembler in the code). This doc is the plan
for writing it, testing it and switching it on, written down before we know the details so anyone can check
it against what we actually do.

Parts marked **Guess** depend on a contract we haven't seen. They get replaced with facts once it ships.

## What exists today

- `BatchFactory` is deployed with no adapter. Credit unions fill, but a credit union with no adapter never locks: anyone
  can withdraw at any time, even at 80/80.
- Each credit union already decides its own burn order (`Batch.burnOrder()`: deposit order, Credit number up or
  down, or the painted sheet). The adapter receives that exact list and must not reorder it.
- The adapter interface is fixed: `contracts/src/interfaces/IAssembler.sol`.
  - `statement()`: the Statement contract it mints from.
  - `assemble(uint256[] ids, uint8 arrangement)`: burn these 80 Credits and give the calling credit union the Statement.
- After the adapter returns, the credit union checks its work itself: none of the 80 Credits may still exist, and
  the credit union must own the Statement the adapter reports. If either check fails, the whole burn reverts.
- The adapter is an operator for the credit union's Credits only for the length of that one call.

## Who can switch it on

One address, the factory's **setter**, can propose an adapter. It has no other power:
- It can't touch Credits, ETH, fees, credit unions or auctions.
- It can replace a pending proposal (restarting the notice), but only until an adapter is live.
- Once an adapter is active it's permanent. Nobody, including the setter, can change it.

**Setter on mainnet:** a multisig (a Safe) held by the Credit Union team, 2 of 3 signers. The address goes here
and in the README before mainnet deploy. On Sepolia the setter is the deployer.

## The switch-on, step by step

1. **Jack publishes the Statement contract.** We read it, and its source must be verified on Etherscan
   before we build against it.
2. **We write the adapter** against that contract. **Guess:** it will take 80 Credit ids (possibly in a
   required order, which is why each credit union fixes its order in advance), burn them through Jack's contract,
   and mint one Statement to the caller. If Jack's contract works differently (for example it needs
   approvals, payment, a signature, or a different count), the adapter handles that. The credit-union-side checks
   above don't change.
3. **We publish it before proposing it:**
   - Adapter source in this repo, under `contracts/src/`, with tests.
   - Deployed and verified on Etherscan.
   - A post with the address and a link here, so anyone can read it.
4. **Test it** (next section). Nothing is proposed until every step passes.
5. **The setter proposes it:** `factory.proposeAssembler(adapter)`. This starts a **30-minute notice**,
   shown on the site. Nothing locks during it, and anyone who doesn't trust the adapter can withdraw.
6. **Anyone activates it** after the 30 minutes: `factory.activateAssembler()`. From here it's permanent.
7. **Credit unions start burning:**
   - Every credit union already at 80 starts a **5-minute countdown**. Withdrawals still work, so it's a last
     chance to leave.
   - After the countdown the credit union is **locked for 1 hour**. Nobody can withdraw, and anyone can press
     **Make Statement** (`assemble()`), paying the gas.
   - If nobody burns within the hour, the credit union unlocks. People can leave, and anyone can restart the
     countdown.
8. **Statement auctions** run as they do today: 24 hours from the first bid, and the sale is split among the
   credit union.

We plan to run a small bot that presses Make Statement for every credit union whose countdown ends, so credit unions don't
wait on a stranger. **Guess:** only 1,526 Statements can ever exist, so there may be a race once burning opens.

## How we'll test it before proposing

1. **Mainnet fork:**
   - Deploy the adapter on a fork of mainnet with Jack's real Statement contract.
   - Fill a credit union with real Credit ids (impersonated holders) in every burn order.
   - Run the full path: countdown, lock, `assemble()`, auction, settle, claim.
   - Check that the Credits are burned, the Statement is owned by the credit union, and the order Jack's contract
     received equals `burnOrder()`.
2. **Adversarial cases:**
   - An adapter that doesn't burn, keeps the Statement, returns a wrong id or reenters: every one must revert.
   - These already exist for the mock adapter in `contracts/test/` and get rerun against the real one.
3. **Sepolia:** if Jack deploys a test version of his contract, we repeat the full flow on the site's
   testnet. If he doesn't, we run a Sepolia stand-in with the same interface.
4. **Review:** the adapter goes through the same internal audit process as the rest (`AUDIT.md`), with the
   findings and fixes written up before proposing.
5. **Mainnet canary:** after activation, the first burn is a credit union we fill ourselves. We confirm the Statement
   and the auction before telling people to burn theirs.

## If something goes wrong

- **Before activation:** the setter replaces or withdraws the proposal, and nothing is locked.
- **During the 30-minute notice:** anyone can leave any credit union.
- **A burn fails:** the credit union's checks revert the whole transaction, so no Credits are lost. The credit union stays
  locked until the hour ends, then unlocks.
- **After activation, the adapter turns out wrong:** it can't be swapped. Credit unions that haven't locked can
  still be left at any time before their countdown ends, and locked ones unlock after the hour if they can't
  burn. The fix would be a new factory, and people moving to it by withdrawing and re-depositing.

## Open questions (filled in when Jack's contract ships)

- The exact function the adapter calls, and whether the order of the 80 matters to it.
- Whether minting needs payment, a signature, a whitelist or an approval.
- Whether a credit union contract can call it directly (some mints are limited to regular wallets).
- Gas for a full burn of 80.
- Any per-address or per-time limits on minting Statements.
