# Vendored: Credits art

`CreditArt.sol` and `CreditDrawing.sol` are copied **unmodified** from the verified source of
Jack Butcher's Credits contract on Ethereum mainnet
(`0x97630aA70AB14ed9883B41dAfccBc11349723043`, verified on Sourcify, solc 0.8.28).
Both files are published under the MIT license (`SPDX-License-Identifier: MIT`).

Credit Union uses them only in `TestCredits`, the testnet stand-in, so test Credits render and carry
traits exactly as real ones do. Nothing on mainnet deploys them; mainnet reads the real Credits.
