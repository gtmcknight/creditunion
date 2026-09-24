import { parseAbi } from 'viem';
import { chain, config, send, session } from '../chain';
import { myCredits } from '../data';
import { art, errText, toast } from '../ui';

const mintAbi = parseAbi(['function mint(address to, uint256 n) returns (uint256 first)']);
const COUNTS = [1, 5, 10, 20, 40];

/// Test networks only: mint Credits from the testnet contract, which uses Jack's real art renderer.
export async function mint(app: HTMLElement, rerender: () => void) {
  if (config.chainId === 1) {
    location.hash = '#/';
    return;
  }
  const owned = session.account ? await myCredits(session.account) : [];

  app.innerHTML = `<a class="back" href="#/">← Batches</a>
  <section class="narrow">
    <h1>Mint test Credits</h1>
    <p class="lede">Free on ${chain.name}. Same art and traits as real Credits, so you can try every flow: open a batch, fill it, burn it, bid.</p>
    <div class="box">
      <div class="box-head"><h3>How many</h3><span class="muted small">Up to 40 per transaction</span></div>
      <div class="seg" role="radiogroup" aria-label="How many">${COUNTS.map((n) => `<label><input type="radio" name="mint-n" value="${n}" ${n === 20 ? 'checked' : ''}><span>${n}</span></label>`).join('')}</div>
      ${session.account ? `<button class="btn primary block" id="mint-go">Mint 20</button>` : `<button class="btn primary block" data-connect>Connect wallet</button>`}
    </div>
    ${
      session.account
        ? `<div class="box">
      <div class="box-head"><h3>Yours</h3><span class="muted small num">${owned.length}</span></div>
      ${
        owned.length
          ? `<div class="picker lg static">${[...owned]
              .reverse()
              .map((id) => `<span class="pick" title="Credit #${id}"><img src="${art(id)}" alt="Credit #${id}" loading="lazy"></span>`)
              .join('')}</div>
             <div class="actions"><a class="btn primary" href="#/">Join a batch</a><a class="btn" href="#/new">Open a batch</a></div>`
          : '<p class="muted">None yet.</p>'
      }
    </div>`
        : ''
    }
  </section>`;

  const go = document.getElementById('mint-go') as HTMLButtonElement | null;
  const n = () => Number((app.querySelector('input[name=mint-n]:checked') as HTMLInputElement).value);
  app.querySelectorAll('input[name=mint-n]').forEach((r) =>
    r.addEventListener('change', () => go && (go.textContent = `Mint ${n()}`)),
  );
  go?.addEventListener('click', async () => {
    const count = n();
    go.disabled = true;
    go.textContent = 'Minting…';
    try {
      await send({ address: config.credits, abi: mintAbi, functionName: 'mint', args: [session.account!, BigInt(count)] });
      toast(`${count} test Credit${count === 1 ? '' : 's'} minted.`, 'ok');
      rerender();
    } catch (e) {
      toast(errText(e), 'err', 8000);
      go.disabled = false;
      go.textContent = `Mint ${count}`;
    }
  });
}
