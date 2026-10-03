# Security

## Reporting a vulnerability

Report it privately through GitHub: [Security → Report a vulnerability](https://github.com/gtmcknight/creditunion/security/advisories/new). Please don't open a public issue or post about it until it's fixed.

Include what you found, the contract or page it affects, and how to reproduce it. A fork test or a transaction on a copy of mainnet (`pnpm chain:fork`, see the README) is the fastest way to show it.

There is no bug bounty.

## Scope

The contracts on Ethereum mainnet, listed in the README under [Deployed addresses](README.md#deployed-addresses): `BatchFactory`, every Credit Union (clones of the `Batch` implementation), `StatementAdapter`, `UnionFormats`, `Sweeper`, `Ratings` and `LiveRatings`. Also the site at creditunion.fun and its Worker, and the mirror at creditunionfun.eth.limo.

Out of scope: Jack Butcher's Credits and Statements contracts (report those to him), OpenSea and Seaport, and the Safe itself.

## What's been checked

The contracts have no owner, pause or upgrade. What has and hasn't been reviewed, proved and tested is in the README's [Security](README.md#security) section. There has been no third-party audit.
