# Credit Union contracts

See the [root README](../README.md).

```sh
forge test --no-match-path 'test/*.fork.t.sol'      # no network
MAINNET_RPC=<archive node> forge test               # everything, mainnet forks included
```

`test/LiveRatings.fork.t.sol` has no default RPC and `test/StatementAdapter.fork.t.sol` is pinned to an old block,
so the full run needs an archive node.

| | |
|---|---|
| [DEPLOY.md](DEPLOY.md) | What's on mainnet, from which commit |
| [ADAPTER.md](ADAPTER.md) | The live adapter: how a union becomes a Statement |
| [ORDER.md](ORDER.md) | Burn order and painted sheets |
| [RUNBOOK.md](RUNBOOK.md) | Burn day record and running it now |
| [AUDIT.md](AUDIT.md) | Internal review log |
| [SAFE.md](SAFE.md) | What the Safe can do |
