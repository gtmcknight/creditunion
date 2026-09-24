import type { Address } from 'viem';
import { chain, config, connect, loadConfig, onSession, restore, session, wallets } from './chain';
import { batch } from './views/batch';
import { create } from './views/create';
import { home, how } from './views/home';
import { hydrate, who } from './ens';
import { mint } from './views/mint';
import { profile } from './views/profile';
import { esc, errText, toast } from './ui';

const app = document.getElementById('app')!;
let seq = 0;

async function route() {
  const run = ++seq;
  const hash = location.hash.replace(/^#\/?/, '');
  const [page, arg] = hash.split('/');
  document.querySelectorAll<HTMLAnchorElement>('[data-nav]').forEach((a) =>
    a.toggleAttribute('aria-current', a.dataset.nav === (page === 'b' || page === 'new' ? '' : page ?? '')),
  );
  document.querySelectorAll<HTMLAnchorElement>('#account [data-nav]').forEach((a) =>
    a.classList.toggle('current', page === 'me'),
  );
  app.classList.remove('in');
  try {
    if (page === 'how') how(app);
    else if (page === 'mint') await mint(app, route);
    else if (page === 'me') await profile(app, route);
    else if (page === 'new') await create(app);
    else if (page === 'b' && /^0x[0-9a-fA-F]{40}$/.test(arg ?? '')) await batch(app, arg as Address, route);
    else await home(app);
  } catch (e) {
    if (run === seq) app.innerHTML = `<section class="prose"><h1>Something went wrong</h1><p class="error">${esc(errText(e))}</p></section>`;
  }
  if (run === seq) requestAnimationFrame(() => app.classList.add('in'));
}

/// Test networks only: a banner above the header so shared links are unmistakably the preview.
function drawTestnet() {
  if (config.chainId === 1) return;
  const el = document.getElementById('testnet')!;
  el.hidden = false;
  el.innerHTML = `<span><strong>Testnet preview</strong> · ${esc(chain.name)}, test Credits only. Mainnet launches with Jack’s Statement contract.</span><a href="#/mint">Mint test Credits →</a>`;
  document.querySelector<HTMLElement>('nav a[data-nav="mint"]')?.removeAttribute('hidden');
}

/// Phone browsers have no wallet inside them: open this page in a wallet's own browser instead.
function mobileWalletLinks() {
  const here = location.href;
  const host = location.host + location.pathname + location.hash;
  const links: [string, string][] = [
    ['MetaMask', `https://metamask.app.link/dapp/${host}`],
    ['Coinbase Wallet', `https://go.cb-w.com/dapp?cb_url=${encodeURIComponent(here)}`],
    ['Trust Wallet', `https://link.trustwallet.com/open_url?coin_id=60&url=${encodeURIComponent(here)}`],
  ];
  return `<h3>Open in your wallet</h3>
    <p class="muted small">This browser has no wallet built in. Open Eighty inside your wallet app’s browser, or paste the link there.</p>
    <div class="wallet-list">${links.map(([n, u]) => `<a class="wallet" href="${esc(u)}" rel="noopener"><span>${n}</span><span class="muted">↗</span></a>`).join('')}</div>
    <button class="btn block" id="copy-link" value="">Copy link</button>`;
}

function drawAccount() {
  const el = document.getElementById('account')!;
  el.innerHTML = session.account
    ? `<a class="btn sm acct" href="#/me" data-nav="me">${who(session.account)}</a>`
    : `<button class="btn sm primary" data-connect>Connect</button>`;
  hydrate(el);
}

async function openConnect() {
  window.dispatchEvent(new Event('eip6963:requestProvider'));
  const d = document.getElementById('wallets') as HTMLDialogElement;
  const injected = (window as unknown as { ethereum?: unknown }).ethereum;
  if (wallets.length === 0 && !injected) {
    d.innerHTML = `<form method="dialog">${mobileWalletLinks()}</form>`;
    d.querySelector('#copy-link')?.addEventListener('click', () => {
      navigator.clipboard?.writeText(location.href).then(() => toast('Link copied.', 'ok'));
    });
    d.showModal();
    return;
  }
  if (wallets.length <= 1) {
    try {
      await connect(wallets[0]);
    } catch (e) {
      toast(errText(e), 'err');
    }
    return;
  }
  d.innerHTML = `<form method="dialog"><h3>Connect a wallet</h3><div class="wallet-list">${wallets
    .map((w, i) => `<button class="wallet" value="${i}"><img src="${esc(w.info.icon)}" alt=""><span>${esc(w.info.name)}</span></button>`)
    .join('')}</div><button class="btn block" value="">Cancel</button></form>`;
  d.showModal();
  d.addEventListener(
    'close',
    async () => {
      if (d.returnValue === '') return;
      try {
        await connect(wallets[Number(d.returnValue)]);
      } catch (e) {
        toast(errText(e), 'err');
      }
    },
    { once: true },
  );
}

document.addEventListener('click', (e) => {
  if ((e.target as HTMLElement).closest('[data-connect]')) openConnect();
});

onSession(() => {
  drawAccount();
  drawTestnet();
  route();
});
window.addEventListener('hashchange', () => {
  window.scrollTo({ top: 0 });
  route();
});

(async () => {
  drawAccount();
  try {
    await loadConfig();
  } catch {
    app.innerHTML = `<section class="prose"><h1>Offline</h1><p class="muted">Couldn’t load config.</p></section>`;
    return;
  }
  drawTestnet();
  await restore().catch(() => {});
  route();
})();
