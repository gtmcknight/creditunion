<a href="https://creditunion.fun"><img src="docs/banner.jpg" alt="Credit Union"></a>

<p align="center"><b><a href="https://creditunion.fun">creditunion.fun</a></b> · <a href="#how-balance-batches-work">How it works</a> · <a href="#fees">Fees</a> · <a href="#who-controls-what">Who controls what</a> · <a href="#security">Security</a> · <a href="#addresses">Addresses</a> · <a href="https://creditunion.fun/docs">Docs</a></p>

A Statement takes 80 of Jack Butcher's [Credits](https://jack.art/credits). Credit Union pools them from many holders, burns them into a Statement, and splits what it becomes among everyone in: $BALANCE, or the ETH from its auction. Live on Ethereum since September 27, 2026.

<table>
<tr>
<td width="33%" valign="top"><img src="docs/balance.svg" alt="Get $BALANCE"><br><b><a href="https://creditunion.fun/balance">Get $BALANCE</a></b><br>Put in Credits or ETH. A full batch becomes $BALANCE, split by the rating each of you put in.</td>
<td width="33%" valign="top"><img src="docs/colors.svg" alt="Pick a color"><br><b><a href="https://creditunion.fun/balance">Pick a color</a></b><br>Mixed takes any Credit. C, M, Y and K take one ink, and pay $BALANCE in it.</td>
<td width="33%" valign="top"><img src="docs/union.svg" alt="Make a Statement together"><br><b><a href="https://creditunion.fun/unions">Make a Statement together</a></b><br>Pool 80 in a Credit Union, auction the Statement, split the sale.</td>
</tr>
<tr>
<td width="33%" valign="top"><img src="docs/shop.svg" alt="Shop Credits"><br><b><a href="https://creditunion.fun/credits">Shop Credits</a></b><br>Every Credit for sale on OpenSea, FWA and CreditStrategy, in one list.</td>
<td width="33%" valign="top"><img src="docs/bid.svg" alt="Bid on Statements"><br><b><a href="https://creditunion.fun/statements">Bid on Statements</a></b><br>Bid on live auctions, several at once, or buy a listed Statement.</td>
<td width="33%" valign="top"><img src="docs/design.svg" alt="Design a Statement"><br><b>Design a Statement</b><br><a href="https://creditunion.fun/create">Paint it by trait</a>, <a href="https://creditunion.fun/printer">draw a picture with friends</a>, or <a href="https://creditunion.fun/make">burn 80 of your own</a>.</td>
</tr>
</table>

## How $BALANCE batches work

$BALANCE is the token Statements convert into, launched by Jack Butcher on October 20, 2026. Batches use the Credit Union contracts through a second factory, whose burn adapter converts the Statement into $BALANCE instead of auctioning it.

1. **Fill.** A batch takes 80 Credits. Mixed batches take any Credit; C, M, Y and K batches take only Credits printed in that one ink, since $BALANCE carries the ink of the Statement it comes from. Pay ETH instead and the site goes whichever way gets you more: Uniswap at once, or the cheapest Credits per rating point swept into a batch, when that beats Uniswap by 3%. Take your Credits back anytime before the batch fills.
2. **Convert.** A full batch locks for an hour, and anyone can convert it: its 80 burn into a Statement in a wallet of the batch's own (`TokenPocket`), and the Statement converts into $BALANCE there. No auction. Our keeper converts full batches, and anyone else can too.
3. **Pay.** Members split the $BALANCE by the rating each put in, after a 6% fee. Our keeper sends each share when its gas is worth it, and any member can claim theirs on the Balance page anytime.

## How a Credit Union works

1. **Open.** Anyone with a Credit opens a Credit Union and sets its rules (below).
2. **Join.** Holders deposit Credits, each checked onchain against the rules. No Credits? The Sweeper buys the cheapest listings that fit and deposits them in one transaction.
3. **Lock.** At 80 a 5-minute countdown starts, and anyone leaving stops it. Then it locks for an hour: nobody can leave, and anyone can burn. If nobody does, it unlocks and anyone can restart the countdown.
4. **Burn.** `assemble()` sends the 80 to Jack's Statements contract in the union's order and format. The union must end up holding the Statement, or the call reverts.
5. **Auction.** 24 hours from the first bid. Each bid beats the last by 5% (at least 0.01 ETH), and a bid in the last 15 minutes moves the end to 15 minutes after it. Outbid ETH comes back in the same transaction.
6. **Split.** Anyone settles. The winner gets the Statement, and the sale, less a 2% fee, goes to every member at once by the union's split. A wallet that can't take the payment keeps its share, and `claim` sends it later.

The creator sets these when opening it:

| Rule | Choices |
|:---|:---|
| Who&nbsp;can&nbsp;join | Any mix of Jack's traits (Colors, Eights, Print, Weight, Plates, Bits), payment time, [rating](https://jack.art/credits/rating), a Credit-number range, or a list of up to 200 Credits |
| Burn&nbsp;order | The order Credits joined, Credit number up or down, a sheet painted by trait (each spot takes only a matching Credit), or a picture drawn by the Credits that match it best |
| Format | Which of Jack's Statement formats it's made in |
| Split | Equal (1/80 each) or Early bird (1.5 shares for the first deposit, falling evenly to 0.5 for the last) |
| Reserve | An optional minimum first bid (the site opens unions with none). With no bid within 7 days of the burn, it drops to 0.01 ETH |

## Fees

| Fee | Now | Most it can be |
|:---|:---|:---|
| Credit Union sale, only if the Statement sells | 2% | 5% |
| $BALANCE batch conversion | 6% | 15% |
| Buying Credits through the Sweeper | 2% | 5% |
| Buying or selling $BALANCE on Uniswap through the site | 1% | 5% |
| Creator's share of a sale or conversion | 0% | 10% |

Every fee but the creator's goes to the Safe. A union or batch keeps the fees it opened with. The Uniswap fee is set by the site, not a contract.

## Who controls what

- **Nobody** can move pooled Credits, bids, ETH or $BALANCE. The contracts have no owner, pause or upgrade.
- **The Safe** (2 of 3) receives the fees. It can change them within their caps and propose a new rating table; a union or batch keeps the fees and table it opened with. Both burn adapters are set for good. Every call it has: [SAFE.md](contracts/SAFE.md).
- **Keepers** do chores anyone can do. The site's keeper settles ended auctions and retries failed payouts; the token keeper converts full batches and pays members. Their keys hold no role in any contract.
- **Your wallet** signs everything. The site reads, caches and builds transactions. If it goes down, the [mirror](https://creditunionfun.eth.limo) and Etherscan still bid, settle and claim.

## Security

| Check | Covers | Result |
|:---|:---|:---|
| [Internal&nbsp;review](contracts/AUDIT.md) | `Batch`, `BatchFactory`, `Sweeper`, `Ratings` | 7 rounds; every finding fixed or documented |
| [Halmos&nbsp;proofs](contracts/test/formal/REPORT.md) | The same four, rerun on the token factory's code on Oct 14 | 51 rules proved, none broken, 5 timed out |
| Foundry&nbsp;tests | Every contract | 270 unit, fuzz, invariant and adversarial tests pass (Oct 21), run by CI on every contract change; 32 more on a mainnet fork |
| Tests&nbsp;only | `StatementAdapter`, `LiveRatings`, `UnionFormats`, `TokenAdapter`, `TokenPocket` | Unit and mainnet-fork tests; no written review yet |
| End-to-end | The site in Chrome, against a local chain | Every Credit Union filter, burn order and painted layout |

No third-party audit. To report a vulnerability, see [SECURITY.md](SECURITY.md); please don't open a public issue.

## Addresses

Ethereum mainnet. The deployment record is [contracts/DEPLOY.md](contracts/DEPLOY.md); how $BALANCE batches launched is [docs/balance-launch.md](docs/balance-launch.md).

### Credit Union contracts

| Contract | For | Address |
|:---|:---|:---|
| BatchFactory | Credit Unions | [`0xcb06f9076e5fbF3cB052086b1EE7C0F3836aa051`](https://etherscan.io/address/0xcb06f9076e5fbF3cB052086b1EE7C0F3836aa051) |
| Batch implementation | Credit Unions | [`0xd578eC605E60eDD008b415c23B15Eb3483CC6c50`](https://etherscan.io/address/0xd578eC605E60eDD008b415c23B15Eb3483CC6c50) |
| StatementAdapter | Credit Unions | [`0x6CAEb9953bA8625226345CF39F93541CE53AbFd2`](https://etherscan.io/address/0x6CAEb9953bA8625226345CF39F93541CE53AbFd2) |
| UnionFormats | Credit Unions | [`0x16deCDa20c9164CcfDB4BE189557aDc4614aAedC`](https://etherscan.io/address/0x16deCDa20c9164CcfDB4BE189557aDc4614aAedC) |
| Sweeper | Credit Unions | [`0x7b93309A12e05944Ab821470615983A4A2AC9799`](https://etherscan.io/address/0x7b93309A12e05944Ab821470615983A4A2AC9799) |
| Ratings v3.4.0 | Unions opened before Oct 2 | [`0x61Ca63cDE107CE7e32785c0d89904fE58f9d371d`](https://etherscan.io/address/0x61Ca63cDE107CE7e32785c0d89904fE58f9d371d) |
| LiveRatings | Both, since Oct 2 | [`0xe27fC60dcE0a9c33743581bfCD72F619DB3612a6`](https://etherscan.io/address/0xe27fC60dcE0a9c33743581bfCD72F619DB3612a6) |
| BatchFactory | $BALANCE batches | [`0x1Ea4b73dE4e946bc58A9A477a7291abe7D7417C1`](https://etherscan.io/address/0x1Ea4b73dE4e946bc58A9A477a7291abe7D7417C1) |
| Batch implementation | $BALANCE batches | [`0x93656C01C23a55fb8d39f0c7D3ce2A8CA1332D99`](https://etherscan.io/address/0x93656C01C23a55fb8d39f0c7D3ce2A8CA1332D99) |
| TokenAdapter | $BALANCE batches | [`0xe6492DCCB96D1468302843AEc42Bb39f0FD7BD1D`](https://etherscan.io/address/0xe6492DCCB96D1468302843AEc42Bb39f0FD7BD1D) |
| UnionFormats | $BALANCE batches | [`0xF3bf99F0a28c4Fc0cf77eB4480F5d0f87d782a25`](https://etherscan.io/address/0xF3bf99F0a28c4Fc0cf77eB4480F5d0f87d782a25) |
| Sweeper | $BALANCE batches | [`0xA4a4dBFddD6C8cc771F4a013Ccd30494Fc82bC5e`](https://etherscan.io/address/0xA4a4dBFddD6C8cc771F4a013Ccd30494Fc82bC5e) |
| Safe (2 of 3) | Both | [`0xFE4761e66C2A37492871d30d0e83bcBC454A7C10`](https://etherscan.io/address/0xFE4761e66C2A37492871d30d0e83bcBC454A7C10) |
| Keeper | Credit Unions | [`0x1493E85aA9f5B3ACb051F16998C57Ece50b2D17e`](https://etherscan.io/address/0x1493E85aA9f5B3ACb051F16998C57Ece50b2D17e) |
| Token keeper | $BALANCE batches | [`0x42d553DE53063610073b24C68566Db013740DC54`](https://etherscan.io/address/0x42d553DE53063610073b24C68566Db013740DC54) |

### Jack Butcher's official contracts

| Contract | Address |
|:---|:---|
| Credits | [`0x97630aA70AB14ed9883B41dAfccBc11349723043`](https://etherscan.io/address/0x97630aA70AB14ed9883B41dAfccBc11349723043) |
| Statements | [`0x75Edd94b7e49b3bD5C8047b91F165A5e265a069b`](https://etherscan.io/address/0x75Edd94b7e49b3bD5C8047b91F165A5e265a069b) |
| $BALANCE | [`0x3620540c994433D7B4a628C46d2ED5F92572eA07`](https://etherscan.io/address/0x3620540c994433D7B4a628C46d2ED5F92572eA07) |

## Developers

```sh
git clone --recurse-submodules https://github.com/gtmcknight/creditunion
cd creditunion/contracts && forge test --no-match-path '*fork*'
cd ../web && pnpm install && pnpm dev
```

<details>
<summary><b>Repo layout</b></summary>

```
contracts/          Foundry
  src/              Batch, BatchFactory, Sweeper, Ratings, LiveRatings, StatementAdapter,
                    TokenAdapter, TokenPocket, UnionFormats, lens/, interfaces, mocks, vendor/
  script/           deploy and check scripts
  test/             unit, fuzz, invariant, adversarial and mainnet-fork tests; formal/ proofs
  data/scores.bin   the v3.4.0 rating table deployed onchain
  ADAPTER.md        how a union becomes a Statement; how burning was tested and switched on
  AUDIT.md          the internal review log
  DEPLOY.md         the mainnet deployment record: addresses, settings, commit
  ORDER.md          how a union decides where every Credit goes on the sheet
  RUNBOOK.md        operations: the keeper, burns, countdowns, what to do if the site is down
  SAFE.md           everything the Safe can and can't do
web/                Cloudflare Worker + static site (Vite, TypeScript, viem, no framework)
  src/app/          the site: reads the chain, wallets sign in the browser (EIP-6963)
  src/worker/       the Worker: config, RPC proxy, caches, art, listings, keeper, link cards
  src/shared/       code both use: rating formula, eligibility rules, layout
  src/mirror/       the mirror's source: one static page that needs no server
  scripts/          data builders, token keeper, e2e matrix, mainnet copy, mirror build
  public/           static assets and precomputed edition data
  data/             credits.json.gz, the full edition every derived file is built from
mirror/             the mirror as pinned to IPFS (see mirror/README.md)
docs/               README images and the $BALANCE launch plan
```

</details>

<details>
<summary><b>Contracts</b></summary>

| Contract | What it does |
|:---|:---|
| `BatchFactory` | Deploys Credit Unions (or batches) as minimal clones, moves Credits from its caller into them, and holds the fees and the one-time burn adapter setting. |
| `Batch` | One Credit Union or batch: eligibility checks, deposits and withdrawals, lock, burn, auction, split, claims. |
| `Sweeper` | Buys OpenSea listings through Seaport 1.6, into the buyer's wallet or straight into a union in their name. Unused ETH is refunded; listings that sold first are skipped. |
| `Ratings` | Jack's rating for all 122,154 Credits under methodology v3.4.0, stored as data contracts. Credit Unions opened before Oct 2, 2026 check rating rules against it. |
| `LiveRatings` | The rating table since Oct 2, 2026: each Credit's score as Jack's Statements contract computes it, asked when a rule checks it, ×10 rounded down. Nothing stored. |
| `StatementAdapter` | Credit Unions' burn adapter, permanent since Oct 1, 2026: has the Statements contract burn a full union's 80 in its order and format, and hands the Statement back. |
| `TokenAdapter` | $BALANCE batches' burn adapter: burns a full batch's 80 into a Statement, converts it into $BALANCE, and pays members by the rating each put in, after fees. |
| `TokenPocket` | One wallet per converted batch, cloned at the burn, so each batch's $BALANCE keeps its own colors until it's paid out. |
| `UnionFormats` | Where a union's creator picks its Statement format. The adapter reads it at burn time. |
| `IAssembler` | The interface a union calls (never delegatecalls) to burn its 80. `MockAssembler` stands in for tests and local chains. |

More in [ADAPTER.md](contracts/ADAPTER.md) (how burning works and was switched on), [ORDER.md](contracts/ORDER.md) (how the 80 are ordered and painted) and [RUNBOOK.md](contracts/RUNBOOK.md) (operations).

#### Build and test

```sh
cd contracts
forge build
forge test                            # the fork tests need MAINNET_RPC set to an archive node
forge test --no-match-path '*fork*'   # everything but the fork tests
```

#### Deploy

Copy `contracts/.env.example` to `contracts/.env`, fill it in, and load it with `set -a; . ./.env; set +a`.

| Script | Deploys or checks | Env |
|:---|:---|:---|
| `DeployMainnet.s.sol` | Credit Unions on mainnet: rating table, factory, Sweeper | `FEE_RECIPIENT` (required), `SETTER`, `ASSEMBLER`, `RATINGS`, `PROTOCOL_FEE_BPS`, `CREATOR_FEE_BPS`, `SWEEP_FEE_BPS` |
| `DeployUnionFormats.s.sol` | The format picker, before the adapter | none |
| `DeployAdapter.s.sol` | The burn adapter; the Safe proposes it after | `STATEMENTS`, `FORMATS`, `EXPECT` (the proposed address) |
| `DeployRatings.s.sol` | The v3.4.0 rating table on its own | none |
| `DeployLiveRatings.s.sol` | The live rating table; the Safe proposes it after | none |
| `CheckRatings.s.sol` | Read-only: the deployed table matches `data/scores.bin` byte for byte | args `$RATINGS $CREDITS` |
| `DeployTokenUnions.s.sol` | $BALANCE batches in two stages: the factory, its UnionFormats and Sweeper; then `TokenAdapter`, which the Safe proposes | `SETTER`, `FEE_RECIPIENT`; stage 2 adds `FACTORY`, `FORMATS`, `VAULT` |
| `DeployTestnet.s.sol`, `DeployFactory.s.sol` | Sepolia: test Credits, a mock Statement, factory, Sweeper | see each header |
| `SeedDemo.s.sol`, `Matrix.s.sol` | Local anvil: unions in every state; the end-to-end matrix | none |

```sh
forge script script/DeployMainnet.s.sol --rpc-url "$MAINNET_RPC" \
  --private-key "$PRIVATE_KEY" --broadcast --slow
forge script script/CheckRatings.s.sol --sig "run(address,address)" $RATINGS $CREDITS \
  --rpc-url "$MAINNET_RPC"
```

</details>

<details>
<summary><b>Site and Worker</b></summary>

```sh
cd web
pnpm install
cp .dev.vars.example .dev.vars   # optional: without it, RPC uses a public node
pnpm dev
```

Contract addresses, the chain and the $BALANCE pool settings live in `wrangler.jsonc` `vars`; override them in `.dev.vars` to point the site at a local chain. After changing contracts, run `forge build`, then `pnpm abi` to regenerate `src/app/abi.ts`. `pnpm build` fails if the ABI is stale.

The contracts are the only source of truth. The Worker caches their reads in a Durable Object, so every visitor shares one read, keeps the listings book, and stores Printer plans in KV. Nothing it stores can move Credits or ETH.

#### Endpoints

The main ones; the full set is the router in `src/worker/index.ts`.

| Path | Returns |
|:---|:---|
| `/config.json` | chain and contract addresses (also written into every page the Worker serves) |
| `/rpc` | a read-only JSON-RPC proxy with a method allowlist, so the RPC key stays server-side; falls back to `FALLBACK_RPC` when the key is over its limit or down |
| `/unions.json` | every Credit Union with its summary and slots, one cached read for all visitors |
| `/token-batches.json` | every $BALANCE batch with its payout, one cached read for all visitors |
| `/activity.json` | what wallets have done on the site, newest first, from the contracts' events |
| `/passes` | which of a wallet's Credits a union would take, in one multicall |
| `/art/:id.svg`, `/statement/:id.svg`, `/balance-art/*` | a Credit's, Statement's or Balance's art, as its contract draws it, cached |
| `/ratings`, `/edition/match`, `/edition/rows`, `/*.bin` | ratings for ids, how many Credits fit a rule set, and edition data for the filters and walls |
| `/opensea/listed`, `/opensea/credit/:id`, `/opensea/buyquote` | every Credit for sale, cheapest first (OpenSea, FWA, CreditStrategy); one Credit's cheapest listing; a price for the ones picked |
| `/opensea/listings`, `/opensea/quote` | listings that fit a union, and signed Seaport orders for the Sweeper |
| `/market.json`, `/market-top.json` | the listings book, kept live each minute, and its cheapest cut for the Balance page |
| `/plans/*`, `/pictures/*`, `/placed/*`, `/locks/*` | Printer plans, picture unions' cards and spots, buy locks while a picture fills |
| `/bids/:party`, `/owner/:id`, `/ens/:address`, `/burns` | a union's bids, a Credit's holder, an ENS name and avatar, burning's state and the keeper's address |
| `/og/...` | link-preview cards |

#### Keepers

- **The Worker's keeper** (`src/worker/keeper.ts`, a Cron Trigger): every 5 minutes it settles ended auctions and saves a picture union's spots once it fills; on the hour it retries payouts that failed at settle. It never burns or restarts a countdown, simulates every transaction first, and sends at most five a run. It does nothing until `KEEPER_KEY` is set.
- **The token keeper** (`scripts/convert-tokens.mjs`, run on its own): rates and converts each full $BALANCE batch, then pays its members once $BALANCE transfers are open. It spends gas only where the fee covers it, and sends nothing while the base fee is over `--max-gwei`.

The same cron keeps the listings book live and records the $BALANCE price each minute. Rate limits are per IP (`unsafe.bindings` in `wrangler.jsonc`). The build writes `_headers`, so files served without the Worker get the same security headers, and hashed build files a year's cache.

#### Deploy

```sh
cd web
pnpm wrangler secret put RPC_URL
pnpm wrangler secret put OPENSEA_API_KEY   # without it buy-in is hidden
pnpm wrangler secret put OPENSEA_API_KEY_2 # optional; a spare when the first is rate limited
pnpm wrangler secret put ENS_RPC           # optional; mainnet RPC for ENS when not on mainnet
pnpm wrangler secret put KEEPER_KEY        # optional; the keeper's key (fund it with gas only)
pnpm run deploy                            # abi check, typecheck, vite build, wrangler deploy
```

Use `pnpm run deploy`, not `pnpm deploy` (a built-in pnpm command). To run your own copy, change the Worker `name` in `wrangler.jsonc` (it's still `eighty`, the project's first name, because its secrets live there), the `routes`, and the KV namespace id (`wrangler kv namespace create PLANS`).

</details>

<details>
<summary><b>Local chains and end-to-end tests</b></summary>

A local chain with unions in every state (run `anvil` in its own terminal):

```sh
cd contracts
anvil --gas-limit 60000000
bash script/seed-local.sh   # unions in every state; moves anvil's clock through the lock phases
```

A copy of mainnet instead, with the real Credits, unions, Statements and burn contract as they are now (needs `MAINNET_RPC` in `contracts/.env`):

```sh
cd web
pnpm chain:fork                 # funds test accounts, prints how to point the site at it
pnpm chain:fork --credits 80    # also hands the test wallet 80 real Credits
pnpm chain:fork --warp 24       # moves the clock 24 hours on
```

The end-to-end matrix deploys a fresh anvil (port 8546) with `contracts/script/Matrix.s.sol`, runs a second copy of the site on port 5191, and drives it in Chrome with a mock wallet. Every union's picker is checked against `Batch.canTake`: every offered Credit must deposit and every folded one revert. Then Select all, Deposit and a partial Withdraw go through the page, and the create page runs a few configs. Needs Foundry and Chrome.

```sh
cd web
node scripts/e2e-matrix.mjs                    # every union and the create page
ONLY='^L nearly' node scripts/e2e-matrix.mjs   # a subset; more flags in its header
```

</details>

<details>
<summary><b>Edition data</b></summary>

Trait bits, the mint timeline, rating statistics and the onchain score table all derive from `web/data/credits.json.gz` (`{ id: [seed, paidAt] }` for all 122,154 Credits), rebuilt from the Credits contract's `Distributed` events:

```sh
cd web
MAINNET_RPC=... node scripts/fetch-credits.ts data/credits.json
gzip -k data/credits.json
node scripts/edition.ts data/credits.json.gz   # *.bin, minutes.json, scores.bin
node scripts/wall.ts                           # wall.bin, bits.bin, times.bin
RPC=... node scripts/credit-score.ts           # credit-score.bin, scores-live.bin
```

They write to `web/public/` and `contracts/data/scores.bin`. `credit-score.ts` takes each score as the Statements contract computes it.

Ratings follow Jack's published formula (methodology v3.4.0), reproduced in `web/src/shared/credits.ts` and checked against his API.

</details>

## Made by

[@taylor_](https://x.com/taylor_) and [@bigvibessss](https://x.com/bigvibessss). MIT licensed, see [LICENSE](LICENSE).

Credit Union is independent and unofficial, not affiliated with or endorsed by Jack Butcher. `contracts/src/vendor/credits/` holds Jack's MIT-licensed Credits art contracts, copied unmodified (see its NOTICE.md).
