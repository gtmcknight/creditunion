# The Safe: what the fee recipient and setter can do

On mainnet one Safe multisig is both the factory's **fee recipient** and its **assembler setter**. Everything it
can do is listed here, with the contract line that allows it. Anything not listed, it can't do.

- Safe: [`0xFE4761e66C2A37492871d30d0e83bcBC454A7C10`](https://app.safe.global/home?safe=eth:0xFE4761e66C2A37492871d30d0e83bcBC454A7C10), 2 of 3
- Signers: `0xFE35e15bE885750D9b2363cbB6aBDd57AC9C4c40`, `0xf32484112E0b6c994f5dB084D5C15F2a1d6a4228`,
  `0xB508D6f4E5fD9CA85036778A9f6aBE77A9F925C9`
- Check them onchain: `cast call <safe> "getOwners()(address[])"` and `"getThreshold()(uint256)"`

Both roles are immutable: set in the factory's constructor, no function changes them.

## What it receives

| From | What | When |
|---|---|---|
| Each Credit Union | Protocol fee, a share of the Statement sale | At settlement (`Batch.sol`, `_push(factory.feeRecipient(), fee)`) |
| Sweeper | Buy-in fee, a share of what was spent on listings | Every sweep and buy (`Sweeper._settle`) |
| Each Credit Union | Tokens sent to it by mistake, never deposited | When anyone calls `rescue(token, id)`. Pooled Credits and the Statement can't be rescued. |

## What it can change

| Call | Contract | Limit | Reaches |
|---|---|---|---|
| `setFees(protocolBps, creatorBps)` | BatchFactory | Protocol at most 500 (5%), creator at most 1000 (10%) | Only Credit Unions opened afterwards. Open ones keep the fees they opened with. |
| `setFee(bps)` | Sweeper | At most 500 (5%) | The next buy. Every buy passes a `maxFeeBps` and reverts if the fee is above it, so a change can't catch a signature in flight. |
| `proposeRatings(table)` | BatchFactory | Must cover the same number of Credits as the current table. Anyone activates it 30 minutes later with `activateRatings()`. | Only Credit Unions opened afterwards. Each keeps the table it opened with. `ratingsHistory()` lists every table used. |
| `proposeAssembler(adapter)` | BatchFactory, as setter | Only while no adapter is active. Anyone activates it 30 minutes later with `activateAssembler()`. After that it's permanent. | Every Credit Union, since burning needs it. See [ADAPTER.md](ADAPTER.md). |

Proposing again before activation replaces the pending proposal and restarts the 30 minutes.

## What it can't do

It has no call that moves pooled Credits, bids, sale proceeds owed to members, or the Statement. It can't pause,
upgrade, change an open Credit Union's rules, fees or score table, swap an active adapter, or change who the fee
recipient is. The contracts have no owner or admin beyond the calls above.

## How to send one

In the Safe app: **New transaction → Transaction Builder**, enter the contract address, paste the ABI from
Etherscan (the contracts are verified), pick the function, fill it in, and collect two signatures.

Or build the calldata locally and paste it as a raw transaction:

```
cast calldata "setFees(uint256,uint256)" 200 0
cast calldata "setFee(uint256)" 200
cast calldata "proposeRatings(address)" 0x...
cast calldata "proposeAssembler(address)" 0x...
```

After the 30 minutes, anyone (any wallet, not only the Safe) sends the activation:

```
cast send $FACTORY "activateRatings()"   --rpc-url $MAINNET_RPC --account deployer
cast send $FACTORY "activateAssembler()" --rpc-url $MAINNET_RPC --account deployer
```

Contract addresses are in [DEPLOY.md](DEPLOY.md).
