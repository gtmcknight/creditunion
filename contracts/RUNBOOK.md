# Runbook

How Credit Union runs now that the adapter is live, and the record of burn day. Why the adapter works the way it
does is in [ADAPTER.md](ADAPTER.md); what was deployed is in [DEPLOY.md](DEPLOY.md).

| | |
|---|---|
| Factory | `0xcb06f9076e5fbF3cB052086b1EE7C0F3836aa051` |
| Adapter (`StatementAdapter`, permanent) | `0x6CAEb9953bA8625226345CF39F93541CE53AbFd2` |
| Statements (Jack Butcher) | `0x75Edd94b7e49b3bD5C8047b91F165A5e265a069b` |
| UnionFormats | `0x16deCDa20c9164CcfDB4BE189557aDc4614aAedC` |
| Credits | `0x97630aA70AB14ed9883B41dAfccBc11349723043` |
| Safe (fee recipient, assembler setter, 2 of 3) | `0xFE4761e66C2A37492871d30d0e83bcBC454A7C10` |

## Burn day, Oct 1 2026 (done)

- Jack's Statements contract went up Oct 1 (block 26100733) and opened at 8:00 PM ET.
- The adapter was deployed at block 26100878 and became the factory's adapter, for good, at 8:10 PM ET.
- The first burn was ours: Union Jack, Statement #1, block 26100993 (8:15:59 PM ET).
- 17 of the 20 full unions burned in the first hour. Three (Che, Black & White, All Credits) let their hour run out
  at 9:15 PM and unlocked. Black & White and All Credits were restarted and have since burned and settled.
- Auctions ran from there, and many unions have settled since.

**Incident: the first proposed address.** The adapter's address was fixed ahead of time by the deployer's next
nonce, so the Safe could sign `proposeAssembler(<that address>)` before the deploy. The deployer key then sent the
Safe's execution from a browser wallet, which used that nonce. The proposed address could no longer be deployed,
so the Safe had to propose a replacement, which restarted the 30-minute notice.

**Lesson:** a key whose nonce fixes a contract address signs nothing else before the deploy, and never from a
browser wallet. `script/DeployAdapter.s.sol` takes `EXPECT=<proposed address>` and refuses to send if the address
would differ.

The deploy command. The script needs `STATEMENTS` and `FORMATS`; `EXPECT` is optional:

```
cd contracts
STATEMENTS=0x75Edd94b7e49b3bD5C8047b91F165A5e265a069b FORMATS=0x16deCDa20c9164CcfDB4BE189557aDc4614aAedC \
EXPECT=<the address the Safe proposed> \
forge script script/DeployAdapter.s.sol --rpc-url $MAINNET_RPC --broadcast --verify
```

## The keeper

A Cron Trigger on the Worker (`web/src/worker/keeper.ts`) that runs every 5 minutes and presses the buttons
nobody is paid to press. Each run sends up to five transactions, each simulated first:

- switches burning on (`activateAssembler()`) once a proposal's notice has run (done; nothing to switch now),
- settles auctions that have ended,
- retries failed payouts (`claim(member)`), checked hourly, for three days after an auction ends,
- records a full picture's spots on the adapter (`record(union)`), so a leave can't slide them before the burn.

It never burns. Every Statement is made by someone pressing Convert Union to Statement.

- `KEEPER_KEY` (`wrangler secret put KEEPER_KEY`): a gas-only key with no role in any contract. Without it the
  keeper does nothing. Its address, never the key, is at `/burns`; keep ETH on it.
- `KEEPER_MAX_GWEI` (default 20): above this gas price it waits.
- It sends nothing while its last transactions are pending.

## Burns open

The KV key `burns-open` in `PLANS` gates the button on union pages, not the contract: `1` means open, a unix time
means open from then (pages count down to it), empty means held. Anyone can still call `assemble()` directly.

```
pnpm wrangler kv key get --binding PLANS burns-open --remote
pnpm wrangler kv key put --binding PLANS burns-open 1 --remote
```

Burns have been open since burn night. `?burn` on a union URL (`/union/<address>?burn`) shows the button while
burns are held.

## A lapsed countdown

A full union locks 5 minutes after it fills, then has 1 hour in which anyone can burn it. If nobody does, it
unlocks: members can leave, and anyone can press **Restart countdown** on its page (`restartCountdown()`), which
starts a fresh 5 minutes and another hour. Nothing is lost but the hour.

## If the site is down or slow

Nothing on-chain depends on creditunion.fun. Pages already loaded fall back to the visitor's wallet when `/rpc`
fails. Point people to:

- **The mirror:** [creditunionfun.eth.limo](https://creditunionfun.eth.limo), one static page that bids, settles,
  claims, refunds and burns through the visitor's own wallet. The same file is on GitHub Pages at
  [gtmcknight.github.io/creditunion](https://gtmcknight.github.io/creditunion). Its CID, hash and how to update it
  are in [mirror/README.md](../mirror/README.md).
- **Etherscan:** the union's address, Contract, Write as Proxy, then `bid` (the bid as the value), `settle` or
  `claim`.

## If something goes wrong

- **A burn fails:** the union's own checks undo the whole transaction, so no Credits move. It stays locked until
  its hour ends, then unlocks, and anyone can restart the countdown once the problem is fixed.
- **The adapter turns out wrong:** it is permanent. Nobody, the Safe included, can swap it. The only fix is a new
  factory, with members withdrawing from unions that aren't locked and depositing again. Unions that haven't
  locked can always be left; locked ones unlock after their hour if they can't burn.
