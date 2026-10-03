# Test stand-ins, not real contracts

Everything in this folder exists so the tests, local chains and testnets can run the whole Credit Union flow,
burn included. None of it is deployed to mainnet or meant to be.

- `MockStatement.sol` is **not** Jack Butcher's Statement contract. It burns 80 test Credits and mints a worthless
  test Statement, through `make` (for `MockAssembler`) or `compose`, with the same call shape as Jack's real
  `compose` (so testnets can run the real `StatementAdapter`). The adapter's fork tests use his real contract.
- `MockAssembler.sol` is **not** the Credit Union adapter. It only works with `MockStatement`.
- `MockCredits.sol` and `TestCredits.sol` stand in for Credits.

The real adapter is `src/StatementAdapter.sol`, live on mainnet at `0x6CAEb9953bA8625226345CF39F93541CE53AbFd2`
since Oct 1 2026 and permanent. It burns into Jack's Statements contract at
`0x75Edd94b7e49b3bD5C8047b91F165A5e265a069b`. See [ADAPTER.md](../../ADAPTER.md).
