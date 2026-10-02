# Test stand-ins, not real contracts

Everything in this folder exists so the tests, local chains and testnets can run the whole Credit Union flow,
burn included. None of it is deployed to mainnet or meant to be.

- `MockStatement.sol` is **not** Jack Butcher's Statement contract. It burns 80 test Credits and mints a worthless
  test Statement, through `make` (for `MockAssembler`) or `compose`, with the same call shape as Jack's real
  `compose` (so testnets can run the real `StatementAdapter`). The adapter's tests use his real contract.
- `MockAssembler.sol` is **not** the Credit Union adapter. It only works with `MockStatement`.
- `MockCredits.sol` and `TestCredits.sol` stand in for Credits.

The real adapter is `src/StatementAdapter.sol`, written against Jack's contract and not live until it passes the fork test against his deployed one. Until an adapter
is proposed and switched on, no Credit Union on mainnet can lock or burn. See [ADAPTER.md](../../ADAPTER.md).
