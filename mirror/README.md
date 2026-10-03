# The mirror

`index.html` is Credit Union's auctions as one static page that needs nothing from creditunion.fun: it lists the
full Credit Unions and auctions and bids, settles, claims, refunds and burns through the visitor's own wallet
(public nodes until one connects). It's the exact file pinned to IPFS and served at
[creditunionfun.eth.limo](https://creditunionfun.eth.limo), and GitHub Pages serves the same file at
[gtmcknight.github.io/creditunion](https://gtmcknight.github.io/creditunion).

| | |
|---|---|
| IPFS CID (this folder) | `bafybeierwzxzhvgtymabvyl7k7acmu6dedjdtxrqqchyeyddoinohhmfai` |
| ENS | `creditunionfun.eth`, content hash `ipfs://` that CID |
| `index.html` sha-256 | `47c236e7ac1eec2ddd59b7570ddbeb2234a4edf78476caa735a6bb73bff52c46` |

Both copies served that hash on Oct 3.

**Behind the source.** This file was built in `2274c6d` (Sep 30). `web/src/mirror` changed in `c531062` (Oct 1), so
a build from today's source no longer matches: on Oct 3 it printed `61a5a2fc…7505`. It needs a rebuild and a re-pin.

To check or update it:

1. `cd web && pnpm install && pnpm mirror && shasum -a 256 dist-mirror/index.html`
2. Copy `web/dist-mirror/index.html` here and pin this folder to IPFS.
3. Set the `creditunionfun.eth` content hash to the new CID, and update the table above.
4. Push to main: `.github/workflows/mirror.yml` publishes this folder to GitHub Pages.
