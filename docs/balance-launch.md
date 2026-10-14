# BALANCE launch

Token unions behind `/balance`: five lines of batches (Any, C, M, Y, K), 80 Credits each, converted into BALANCE and paid
out by rating. Two stages, like the first factory.

Merging the code changes nothing on the live site until the `TOKEN_*` vars are set: `/balance` keeps showing the
pre-launch board (what 1 BALANCE costs by each way in) until `TOKEN_FACTORY` is set, then the token page takes the path.
So: merge, deploy the contracts, then set the vars.

## Before stage 2

The adapter is written against the expected BALANCE interface (`IStatementVault`: `quote(id)`, `withdraw(id, expected)`,
the token being the converter itself). Once BALANCE is deployed and verified, check it against that interface, rerun
the adapter's fork tests against the real address, and only then deploy the adapter. Until then every Credit in a
batch can be withdrawn.

## Stage 1: pooling (no adapter yet)

Deploys the token factory, its UnionFormats and its Sweeper. Members can deposit and withdraw; nothing locks.
The conversion fee defaults to 6% (`PROTOCOL_FEE_BPS=600`; the cap is 15%, and the Safe can change it for new batches).
About 11.2M gas (0.004 ETH at 0.16 gwei).

```sh
cd contracts
SETTER=0xFE4761e66C2A37492871d30d0e83bcBC454A7C10 FEE_RECIPIENT=0xFE4761e66C2A37492871d30d0e83bcBC454A7C10 \
  forge script script/DeployTokenUnions.s.sol --rpc-url $MAINNET_RPC --account deployer --sender <deployer> --broadcast --verify
```

Put the printed `TOKEN_FACTORY`, `TOKEN_FORMATS` and `TOKEN_SWEEPER` in `web/wrangler.jsonc` vars and deploy the site.
Check: `/balance` loads, all five colors show a price, a small deposit and withdraw from a test wallet work.

## Stage 2: converting (when the BALANCE contract is live)

1. Check the deployed contract against `IStatementVault` (`quote(id)`, `withdraw(id, expected)`, `decimals()`). If it
   differs, update `TokenPocket.convert` and `IStatementVault`, and rerun the fork tests against the real address.
2. Deploy the adapter:
   `FACTORY=<TOKEN_FACTORY> FORMATS=<TOKEN_FORMATS> VAULT=<BALANCE contract> forge script script/DeployTokenUnions.s.sol --rpc-url $MAINNET_RPC --account deployer --sender <deployer> --broadcast --verify`
3. From the setter: `cast send <TOKEN_FACTORY> "proposeAssembler(address)" <TOKEN_ADAPTER>`. 30 minutes later, anyone:
   `cast send <TOKEN_FACTORY> "activateAssembler()"`. From then a batch locks the moment its 80th Credit lands (the
   adapter's `lockDelay()` is 0; auction unions keep their 5 minutes).
4. Put `TOKEN_ADAPTER` in the wrangler vars and deploy the site.
5. Run the converter from a wallet that only holds gas money (about 20M gas per batch: rate + burn):
   `KEY=<gas wallet key> node web/scripts/convert-tokens.mjs --watch --max-gwei 20 --margin 2 --price 0.05`
   (add `--pool <fee>,<tick spacing>,<hooks>` once BALANCE trades, so it values the fee at the pool's price). It only
   spends gas where we make money: a batch converts when our fee on it is worth 2× the gas, and a member is paid by us
   only when our fee on their share is worth 2× that payout; everyone else claims on the page. Rehearsal:
   `node web/scripts/keeper-fork.mjs`.
   It rates and burns each full batch back to back (same block when it can), and pays members once the token's
   transfers open (its `transfersOpenBlock`); before that their BALANCE waits in the batch's pocket, claimable.

Until activation every Credit can be withdrawn, so a delay or a change in the BALANCE contract costs nobody anything.

## Stage 3: Buy and Sell (when BALANCE trades)

`/balance` is one box: Buy · Sell once the Worker names the token, Buy alone before. Buy takes ETH and goes whichever
way gets more: a batch (the cheapest Credits per point, swept into the Mixed batch's open spots, Uniswap buying what
they leave) or Uniswap for all of it. A batch has to beat Uniswap by more than 1%, since it lands when the batch fills;
"Or N now on Uniswap" switches. A pure color only goes through a batch (the pool sells its own mix). Before the token's
transfer lock opens (its `transfersOpenBlock`, read on-chain) Buy goes through a batch and Sell is greyed with the
block. Under You get: the way, and our fees on it (2% on Credits, 6% on conversion, `SWAP_FEE_BPS` on a swap). Your
own Credits: "Convert your N Credits →" under the button. Swaps go through Uniswap's Universal Router into BALANCE's
v4 pool; our slice of each swap's output goes to `SWAP_FEE_TO`.

1. When the auction's pool exists, read its key from the launch (the strategy's migration): fee, tick spacing, hooks.
2. Set the vars in `web/wrangler.jsonc` and deploy the site:
   `BALANCE_TOKEN` (the converter, which is the token), `BALANCE_POOL_FEE`, `BALANCE_POOL_TICK_SPACING`,
   `BALANCE_POOL_HOOKS` (zero if none), `SWAP_FEE_BPS` (capped at 500), `SWAP_FEE_TO`.
3. Check: `/balance` shows Buy · Sell; before the opening block Sell is greyed with the block; after it, a small buy and
   sell from a test wallet land.

Rehearse on a local copy: `node scripts/swap-fork.mjs` (the router encoding: exact fee slices, a too-high minimum
reverts) and `node scripts/e2e-swap.mjs` (the page in Chrome: buy, sell, a pure color, screenshots to
~/Desktop/tokens-swap; `LOCKED=1` for the locked state). Both use `../statement-arb` for the stand-in token's pool.
To click through it yourself: `node scripts/dev-tokens.mjs` (a Mixed batch 60 of 80, the market book, the keeper
converting each batch as it fills), then http://127.0.0.1:5196/balance.

## Rehearsal

`node web/scripts/fork-chain.mjs --tokens --vault` runs both stages on a local copy of mainnet with a test vault.
Point `web/.dev.vars` at it (`RPC_URL=http://127.0.0.1:8549` plus the printed addresses).
