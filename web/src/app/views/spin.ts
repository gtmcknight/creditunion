import { createPublicClient, createWalletClient, custom, parseAbi, type Address, type Hash } from 'viem';
import { mainnet } from 'viem/chains';
import { config, session } from '../chain';
import { errText, esc, eth, toast } from '../ui';

/// The pool's calls and the errors it can revert with, so a failed simulation reads plainly.
const poolAbi = parseAbi([
  'function acquire(address purchaser, uint256 maxAcquisitionFee, uint256 minWeightedValue, uint256 maxNegativeSlippageBps, uint256 expectedInventoryVersion, uint256 deadline) payable returns (uint256 requestId)',
  'function acquireBatch(address purchaser, uint256 count, uint256 maxAcquisitionFee, uint256 minWeightedValue, uint256 maxNegativeSlippageBps, uint256 expectedInventoryVersion, uint256 deadline) payable returns (uint256[] requestIds)',
  'function processAcquisitions(uint256 maxCount) returns (uint256 processed)',
  'function withdrawAcquisitionRefund() returns (uint256 amount)',
  'error InventoryVersionMismatch(uint256 expected, uint256 actual)',
  'error InventoryChangeCooldownActive(uint256 purchasesResumeAt)',
  'error TransactionExpired(uint256 deadline)',
  'error AcquisitionFeeTooHigh()',
  'error InsufficientPayment()',
  'error AcquisitionsNotEnabled()',
  'error FactoryPurchasesDisabled()',
  'error FactoryWithdrawOnly()',
  'error VrfRequestsPaused()',
  'error ConsumerNotReady()',
  'error NoActiveListings()',
  'error PoolAlreadyRetired()',
  'error PurchaseNotAllowed()',
  'error NoAcquisitionRefund()',
]);

type Pool = {
  pool: Address;
  total: number;
  credits: number;
  odds: number;
  collections: number;
  sample: { id: string; price: string }[];
  fee: string;
  vrfGas: string;
  vrfFlat: string;
  gasPrice: string;
  price: string;
  inventoryVersion: string;
  open: boolean;
  closed: string | null;
  resumesAt: number;
  error?: string;
};
type Spin = {
  state: 'pending' | 'reverted' | 'mined';
  head?: number;
  spins: { requestId: string; status: string; wordDeadline: number; nft: { collection: Address; id: string; name: string | null; credit: boolean } | null }[];
  refund?: string;
  error?: string;
};

const SAVED = 'cu-spin'; // the spin being watched, so a reload keeps showing it
const DEADLINE = 10 * 60; // a spin transaction must land within 10 minutes of its price
const CREDITS: Address = '0x97630aA70AB14ed9883B41dAfccBc11349723043';
const pct = (x: number) => (x >= 0.1 ? `${Math.round(x * 100)}%` : `${(x * 100).toFixed(1)}%`);
const openseaItem = (c: string, id: string) => `https://opensea.io/assets/ethereum/${c}/${id}`;

let poller: ReturnType<typeof setTimeout> | null = null;
let refresher: ReturnType<typeof setInterval> | null = null;

/// /spin: one spin buys a random NFT from an FWA pool on Ethereum mainnet. Some of the pool is Credits.
export async function spin(app: HTMLElement) {
  if (poller) clearTimeout(poller);
  if (refresher) clearInterval(refresher);
  if (!config.fwaPool) {
    app.innerHTML = `<section class="narrow"><h1>Spin</h1><p class="lede">Not available right now.</p></section>`;
    return;
  }
  app.innerHTML = `<section class="narrow spin">
    <h1>Spin</h1>
    <p class="lede" id="spin-lede">One spin sends you a random NFT from an <a href="https://fwa.fun" target="_blank" rel="noopener">FWA</a> pool.</p>
    <dl class="facts" id="spin-facts">
      <div><dt>In the pool</dt><dd class="num">…</dd></div>
      <div><dt>Chance of a Credit</dt><dd class="num">…</dd></div>
      <div><dt>Price per spin</dt><dd class="num">…</dd></div>
    </dl>
    <div class="box" id="spin-box">
      <div class="seg" role="radiogroup" aria-label="How many spins"><label><input type="radio" name="spin-n" value="1" checked><span>1 spin</span></label><label><input type="radio" name="spin-n" value="5"><span>5 spins</span></label></div>
      ${session.account ? '<button class="btn primary block" id="spin-go" disabled>Spin</button>' : '<button class="btn primary block" data-connect>Connect to spin</button>'}
      <div id="spin-out" class="spin-out" hidden></div>
      <p class="muted small">On Ethereum mainnet, through FWA’s pool contract. Chainlink picks the NFT, usually within a minute. The randomness fee moves with gas; anything sent over the price comes back.</p>
    </div>
    <div class="box" id="spin-credits" hidden>
      <div class="box-head"><h3>Credits in the pool</h3><span class="muted small num" id="spin-credit-count"></span></div>
      <div class="picker lg static" id="spin-sample"></div>
    </div>
  </section>`;

  let pool: Pool | null = null;
  let loadedAt = 0;
  const go = document.getElementById('spin-go') as HTMLButtonElement | null;
  const out = document.getElementById('spin-out')!;
  const count = () => Number((app.querySelector('input[name=spin-n]:checked') as HTMLInputElement | null)?.value ?? 1);
  let busy = false;

  const drawButton = () => {
    if (!go || busy) return;
    if (!pool) {
      go.disabled = true;
      go.textContent = 'Spin';
      return;
    }
    const n = count();
    const wait = pool.resumesAt > Date.now() / 1000;
    go.disabled = !pool.open || wait;
    go.textContent = !pool.open ? 'Closed' : wait ? 'Opens again soon' : `Spin${n > 1 ? ` ${n}` : ''} · ${eth(BigInt(pool.price) * BigInt(n))}`;
  };

  const load = async () => {
    try {
      const r = await fetch('/fwa/pool');
      const p = (await r.json()) as Pool;
      if (!r.ok || p.error) throw new Error(p.error ?? 'unavailable');
      pool = p;
      loadedAt = Date.now();
    } catch (e) {
      console.warn('[spin] pool', e);
      if (!pool) {
        document.getElementById('spin-facts')!.innerHTML = '<div><dt>Pool</dt><dd>Couldn’t load it right now.</dd></div>';
        return;
      }
    }
    if (!app.isConnected || !document.getElementById('spin-facts')) return;
    const p = pool!;
    document.getElementById('spin-lede')!.innerHTML = `One spin sends you a random NFT from this <a href="https://etherscan.io/address/${esc(p.pool)}" target="_blank" rel="noopener">FWA pool</a>. About ${pct(p.odds)} of spins land a Credit.`;
    document.getElementById('spin-facts')!.innerHTML = `
      <div><dt>In the pool</dt><dd class="num">${p.total} NFTs · ${p.credits} Credits</dd></div>
      <div><dt>Chance of a Credit</dt><dd class="num" title="Cheaper NFTs in the pool come up more often, so this is weighted by price, not a plain count">${pct(p.odds)}</dd></div>
      <div><dt>Price per spin</dt><dd class="num">${eth(BigInt(p.price))}</dd></div>
      ${p.closed ? `<div><dt>Status</dt><dd>${esc(p.closed)}</dd></div>` : p.resumesAt ? `<div><dt>Status</dt><dd>The pool just changed. Spins open again at ${new Date(p.resumesAt * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.</dd></div>` : ''}`;
    const box = document.getElementById('spin-credits')!;
    box.hidden = !p.sample.length;
    document.getElementById('spin-credit-count')!.textContent = p.credits > p.sample.length ? `${p.sample.length} of ${p.credits}` : String(p.credits);
    document.getElementById('spin-sample')!.innerHTML = p.sample
      .map((c) => `<a class="pick" href="${openseaItem(CREDITS, c.id)}" target="_blank" rel="noopener" title="Credit #${c.id}"><img src="/art/mainnet/${c.id}.svg" alt="Credit #${c.id}" loading="lazy"></a>`)
      .join('');
    drawButton();
  };

  app.querySelectorAll('input[name=spin-n]').forEach((r) => r.addEventListener('change', drawButton));
  await load();
  // The price moves with gas: refresh it while the page is open.
  refresher = setInterval(() => (app.isConnected && document.getElementById('spin-box') ? void load() : refresher && clearInterval(refresher)), 30_000);

  // A spin sent earlier (this tab or before a reload) keeps being watched.
  try {
    const saved = JSON.parse(localStorage.getItem(SAVED) ?? 'null') as { tx: Hash; at: number; n: number } | null;
    if (saved && Date.now() - saved.at < 86_400_000) watch(saved.tx, saved.n);
  } catch {}

  go?.addEventListener('click', async () => {
    if (!pool || busy) return;
    const provider = session.provider;
    const account = session.account;
    if (!provider || !account) return;
    busy = true;
    const n = count();
    const label = go.textContent;
    go.disabled = true;
    try {
      // The site runs on another network; spins are on mainnet, so the wallet switches for this.
      go.textContent = 'Switch to Ethereum…';
      try {
        await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x1' }] });
      } catch (e) {
        if ((e as { code?: number }).code === 4001) throw new Error('Cancelled in wallet.');
        throw new Error('Switch your wallet to Ethereum mainnet to spin.');
      }
      if (Number(await provider.request({ method: 'eth_chainId' })) !== 1) throw new Error('Switch your wallet to Ethereum mainnet to spin.');
      // A price older than a minute is refreshed before signing.
      if (Date.now() - loadedAt > 60_000) await load();
      const p = pool;
      if (!p.open) throw new Error(p.closed ?? 'Spins are closed right now.');
      const pub = createPublicClient({ chain: mainnet, transport: custom(provider) });
      const wallet = createWalletClient({ account, chain: mainnet, transport: custom(provider) });
      // The randomness fee is charged at the transaction's own gas price, so send enough for the highest gas price
      // this transaction may pay (maxFeePerGas). The pool keeps exactly the price and returns the rest.
      const fees = await pub.estimateFeesPerGas();
      const fee = BigInt(p.fee);
      const value = BigInt(n) * (fee + BigInt(p.vrfGas) * fees.maxFeePerGas + BigInt(p.vrfFlat));
      const deadline = BigInt(Math.floor(Date.now() / 1000) + DEADLINE);
      // maxAcquisitionFee = the quoted price: if it went up, the spin reverts instead of charging more. Price drift
      // at the draw itself (other spins settling first) never turns this spin into a refund (10000 bps).
      const common = [fee, 0n, 10_000n, BigInt(p.inventoryVersion), deadline] as const;
      go.textContent = 'Confirm in wallet…';
      const { request } = await pub.simulateContract(
        n === 1
          ? { address: p.pool, abi: poolAbi, functionName: 'acquire', args: [account, ...common], value, account, maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas }
          : { address: p.pool, abi: poolAbi, functionName: 'acquireBatch', args: [account, BigInt(n), ...common], value, account, maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas },
      );
      const tx = await wallet.writeContract(request as never);
      try {
        localStorage.setItem(SAVED, JSON.stringify({ tx, at: Date.now(), n }));
      } catch {}
      watch(tx, n);
    } catch (e) {
      const msg = errText(e);
      toast(msg, 'err', 8000);
      // The pool moved under the quote: show the new price.
      if (/price|changed|expired/i.test(msg)) void load();
      go.textContent = label;
    } finally {
      busy = false;
      drawButton();
    }
  });

  /// Follow one spin transaction until every draw in it lands.
  function watch(tx: Hash, n: number) {
    if (poller) clearTimeout(poller);
    out.hidden = false;
    const link = `<a href="https://etherscan.io/tx/${tx}" target="_blank" rel="noopener">transaction ↗</a>`;
    const say = (html: string) => {
      out.innerHTML = html;
    };
    say(`<p>Sent. Waiting for it to land. <span class="muted small">${link}</span></p>`);
    let tries = 0;
    const tick = async () => {
      if (!out.isConnected) return;
      tries++;
      let s: Spin;
      try {
        const r = await fetch(`/fwa/spin?tx=${tx}`);
        s = (await r.json()) as Spin;
        if (!r.ok || s.error) throw new Error(s.error ?? 'unavailable');
      } catch {
        poller = setTimeout(tick, 8000);
        return;
      }
      if (s.state === 'pending') {
        say(`<p>Sent. Waiting for it to land. <span class="muted small">${link}</span></p>`);
        poller = setTimeout(tick, tries > 60 ? 15000 : 4000);
        return;
      }
      if (s.state === 'reverted') {
        forget(tx);
        say(`<p>The spin didn’t go through, so nothing was charged but gas. <span class="muted small">${link}</span></p>`);
        return;
      }
      const done = s.spins.filter((x) => x.status === 'won' || x.status === 'delivering' || x.status === 'expired' || x.status === 'refunded');
      const won = s.spins.filter((x) => x.nft);
      const credits = won.filter((x) => x.nft!.credit).length;
      const rows = won
        .map((x) => {
          const nft = x.nft!;
          const art = nft.credit ? `<img src="/art/mainnet/${esc(nft.id)}.svg" alt="">` : '';
          const what = nft.credit ? `Credit #${esc(nft.id)}` : `${esc(nft.name ?? 'An NFT')} #${esc(nft.id)}`;
          const note = x.status === 'delivering' ? ' <span class="muted small">(delivery pending)</span>' : '';
          return `<li class="won${nft.credit ? ' credit' : ''}">${art}<span>${what}${note}</span><a class="muted small" href="${openseaItem(nft.collection, nft.id)}" target="_blank" rel="noopener">OpenSea ↗</a></li>`;
        })
        .join('');
      const missed = s.spins.length - done.length;
      const refunded = s.spins.filter((x) => x.status === 'expired' || x.status === 'refunded').length;
      // Randomness is in (drawn) but nobody has settled it yet, well past its window: anyone can finish it.
      const stuck = s.spins.some((x) => x.status === 'drawn') && (s.head ?? 0) > Math.max(...s.spins.map((x) => x.wordDeadline)) + 10;
      let html = '';
      if (won.length) {
        html += `<p><strong>${credits === 1 ? 'You won a Credit.' : credits ? `You won ${credits} Credits.` : 'You won'}</strong></p><ul class="won-list">${rows}</ul>`;
        // Credit unions take real Credits only where the site runs on mainnet.
        if (credits && config.chainId === 1) html += `<div class="actions"><a class="btn primary" href="/unions">Put it in a credit union</a></div>`;
      }
      if (missed > 0) {
        html += stuck
          ? `<p>The random number is in but the draw hasn’t been settled. Anyone can finish it.</p><button class="btn" id="spin-finish">Finish the draw</button>`
          : `<p>Drawing${n > 1 ? ` ${missed} of ${s.spins.length}` : ''}. Chainlink sends the random number, usually within a minute.</p>`;
      }
      if (refunded) {
        html += `<p>${refunded === 1 ? 'One spin' : `${refunded} spins`} timed out without a draw, so the pool price is refunded (the randomness fee is not).</p>`;
        if (BigInt(s.refund ?? '0') > 0n) html += `<button class="btn" id="spin-refund">Withdraw ${eth(BigInt(s.refund!))}</button>`;
      }
      say(html + `<p class="muted small">${link}</p>`);
      document.getElementById('spin-finish')?.addEventListener('click', (e) => mainnetCall(e.currentTarget as HTMLButtonElement, 'processAcquisitions', [5n]));
      document.getElementById('spin-refund')?.addEventListener('click', (e) => mainnetCall(e.currentTarget as HTMLButtonElement, 'withdrawAcquisitionRefund', []));
      if (missed > 0) poller = setTimeout(tick, 5000);
      else {
        forget(tx);
        void load();
      }
    };
    void tick();
  }

  /// A plain pool call from the page (finish a stuck draw, withdraw a refund), on mainnet.
  async function mainnetCall(btn: HTMLButtonElement, functionName: 'processAcquisitions' | 'withdrawAcquisitionRefund', args: readonly bigint[]) {
    const provider = session.provider;
    const account = session.account;
    if (!provider || !account || !pool) return toast('Connect a wallet first.', 'err');
    btn.disabled = true;
    try {
      await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x1' }] });
      const pub = createPublicClient({ chain: mainnet, transport: custom(provider) });
      const wallet = createWalletClient({ account, chain: mainnet, transport: custom(provider) });
      const { request } = await pub.simulateContract({ address: pool.pool, abi: poolAbi, functionName, args, account } as never);
      const hash = await wallet.writeContract(request as never);
      toast('Sent.', 'ok');
      await pub.waitForTransactionReceipt({ hash });
    } catch (e) {
      toast(errText(e), 'err', 8000);
    }
    btn.disabled = false;
  }
}

function forget(tx: Hash) {
  try {
    const saved = JSON.parse(localStorage.getItem(SAVED) ?? 'null') as { tx: Hash } | null;
    if (saved?.tx === tx) localStorage.removeItem(SAVED);
  } catch {}
}
