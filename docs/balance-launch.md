# BALANCE launch

Token unions behind `/balance`: five lines of batches (Any, C, M, Y, K), 80 Credits each, converted into BALANCE and paid
out by rating. Two stages, like the first factory.

Merging the code changes nothing on the live site until the `TOKEN_*` vars are set: `/balance` keeps showing the
pre-launch board (what 1 BALANCE costs by each way in) until `TOKEN_FACTORY` is set, then the token page takes the path.
So: merge, deploy the contracts, then set the vars.

## Before stage 2

The adapter is written against BALANCE's interface (`IStatementVault`: `quote(id)`, `withdraw(id, expected)`, the
token being the converter itself). BALANCE takes Statements only once its renderer is registered with Statements
(`ready()`) and its creator has retired the launch supply (`totalRetired()` reaches `launchRetirement()`); before that
every conversion reverts, though `quote` answers. Its transfers stay locked until `transfersOpenBlock()`, the end of
the launch auction, so payouts wait for that block. Until the adapter is active every Credit in a batch can be
withdrawn.

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

1. Check it: `TOKEN=<BALANCE> node web/scripts/check-balance.mjs`. It compares the code with the build we tested
   (`contracts/test/fixtures/balance-release.json`, kept out of git), checks decimals, the
   Statements it reads and a quote, says how far the launch is (renderer, retirement, the opening block) and prints
   steps 2 to 5 with the addresses filled in. Anything marked FAIL stops here.
2. Rehearse against it on a copy of mainnet: `VAULT=<BALANCE> forge test --match-path test/TokenAdapterRelease.fork.t.sol -vv`
   (80 fresh members, the heaviest sheet: the burn, a merge into the first converted Statement, payouts after the
   opening block). `VAULT=<BALANCE> node web/scripts/launch-fork.mjs` runs the keeper through the same order.
3. Deploy the adapter:
   `FACTORY=<TOKEN_FACTORY> FORMATS=<TOKEN_FORMATS> VAULT=<BALANCE> forge script script/DeployTokenUnions.s.sol --rpc-url $MAINNET_RPC --account deployer --sender <deployer> --broadcast --verify`
4. The Safe proposes it: `proposeAssembler(<TOKEN_ADAPTER>)` on the token factory. `ADAPTER=<TOKEN_ADAPTER>
   TOKEN=<BALANCE> node web/scripts/safe-propose.mjs` checks the adapter and prints the Safe transaction's hash and
   `cast wallet sign --no-hash --account deployer <hash>`, which signs it in the terminal (the deployer never goes in a
   browser wallet). Run it again with `SIG=<signature>` to queue it in the Safe app; FE35 confirms and executes there.
   30 minutes later anyone can activate it; the keeper does, once BALANCE takes Statements. From then a batch locks the
   moment its 80th Credit lands (the adapter's `lockDelay()` is 0; auction unions keep their 5 minutes).
5. Put `TOKEN_ADAPTER` and `BALANCE_TOKEN` in the wrangler vars and deploy the site. The pool and swap-fee vars are
   already set and do nothing until `BALANCE_TOKEN` is.
6. Run the converter from a wallet that only holds gas money (about 15M gas per batch: rate + burn):
   `KEY=<gas wallet key> node web/scripts/convert-tokens.mjs --watch --max-gwei 20 --margin 2 --price 0.05`
   (add `--pool 3000,30,0x0000000000000000000000000000000000000000` once BALANCE trades, so it values the fee at the
   pool's price). It sends nothing while
   the adapter's 30 minutes run or while BALANCE doesn't take Statements, activates the adapter when both are done,
   then only spends gas where we make money: a batch converts when our fee on it is worth 2× the gas, and a member is
   paid by us only when our fee on their share is worth 2× that payout; everyone else claims on the page. It rates and
   burns each full batch back to back (same block when it can) and pays members once the token's transfers open;
   before that their BALANCE waits in the batch's pocket. Rehearsal: `node web/scripts/keeper-fork.mjs`.

Until activation every Credit can be withdrawn, so a delay or a change in the BALANCE contract costs nobody anything.
A converted batch's Statement stays in the BALANCE contract for good and reads WITHDRAWN. Anyone may merge it into the
first converted Statement; it's burned then and Statements can't draw it.

## Stage 3: Buy and Sell (when BALANCE trades)

`/balance` is one box: Buy · Sell once the Worker names the token, Buy alone before. Buy takes ETH and goes whichever
way gets more: a batch (the cheapest Credits per point, swept into the Mixed batch's open spots, Uniswap buying what
they leave) or Uniswap for all of it. A batch has to beat Uniswap by more than 1%, since it lands when the batch fills;
"Or N now on Uniswap" switches. A pure color only goes through a batch (the pool sells its own mix). Before the token's
transfer lock opens (its `transfersOpenBlock`, read on-chain) Buy goes through a batch and Sell is greyed with the
block. Under You get: the way, and our fees on it (2% on Credits, 6% on conversion, `SWAP_FEE_BPS` on a swap). Your
own Credits: "Convert your N Credits →" under the button. Swaps go through Uniswap's Universal Router into BALANCE's
v4 pool; our slice of each swap's output goes to `SWAP_FEE_TO`.

1. The vars are set already (stage 2 sets `BALANCE_TOKEN`): `BALANCE_POOL_FEE` 3000, `BALANCE_POOL_TICK_SPACING` 30 and
   no hook (`BALANCE_POOL_HOOKS` the zero address), the pool BALANCE's launch liquidity is locked into (the lock
   0xC9951Be537d6F9Df431579cC493aC4e250E3b93E; its `poolId()` is this key's); `SWAP_FEE_BPS` 100 (capped at 500) to
   `SWAP_FEE_TO`, the Safe.
2. When the auction ends and its pool exists, check the key against the migration's `Initialize` event on the
   PoolManager (fee, tick spacing, hooks). If it differs, fix the three vars and deploy the site. The pool exists only
   once someone sends the migration (eligible a block after the opening), so Buy · Sell can show no quote for a while.
   If someone initialized the no-hook pool first, the migration uses the strategy as its hook: `BALANCE_POOL_HOOKS`
   0x2EEF0e2a9a652d755AccAD95a24541A98B5CA000, same fee and spacing (and the keeper's `--pool` with it).
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
