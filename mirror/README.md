# The mirror

`index.html` is Credit Union's auctions as one static page that needs nothing from creditunion.fun: it lists the
full Credit Unions and auctions and bids, settles, claims, refunds and burns through the visitor's own wallet
(public nodes until one connects). It's the exact file pinned to IPFS and served at
[creditunionfun.eth.limo](https://creditunionfun.eth.limo).

| | |
|---|---|
| IPFS CID (this folder) | `bafybeierwzxzhvgtymabvyl7k7acmu6dedjdtxrqqchyeyddoinohhmfai` |
| ENS | `creditunionfun.eth`, content hash `ipfs://` that CID |
| `index.html` sha-256 | `47c236e7ac1eec2ddd59b7570ddbeb2234a4edf78476caa735a6bb73bff52c46` |

Rebuild it from the source (`web/src/mirror`) and compare: `cd web && pnpm install && pnpm mirror && shasum -a 256
dist-mirror/index.html` prints the hash above.

To change it: edit `web/src/mirror`, `pnpm mirror`, copy `web/dist-mirror/index.html` here, pin this folder, set the
ENS content hash to the new CID, and update this table. `.github/workflows/mirror.yml` publishes this folder to
GitHub Pages.
