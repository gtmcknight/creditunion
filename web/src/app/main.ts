import type { Address } from 'viem';
import { parseAbi } from 'viem';
import { chain, config, connect, disconnect, loadConfig, onSession, restore, send, session, wallets } from './chain';
import { batch } from './views/batch';
import { create } from './views/create';
import { home, how } from './views/home';
import { esc, errText, short, toast } from './ui';

const app = document.getElementById('app')!;
let seq = 0;

async function route() {
  const run = ++seq;
  const hash = location.hash.replace(/^#\/?/, '');
  const [page, arg] = hash.split('/');
  document.querySelectorAll<HTMLAnchorElement>('[data-nav]').forEach((a) =>
    a.toggleAttribute('aria-current', a.dataset.nav === (page === 'b' || page === 'new' ? '' : page)),
  );
  app.classList.remove('in');
  try {
    if (page === 'how') how(app);
    else if (page === 'new') await create(app);
    else if (page === 'b' && /^0x[0-9a-fA-F]{40}$/.test(arg ?? '')) await batch(app, arg as Address, route);
    else await home(app);
  } catch (e) {
    if (run === seq) app.innerHTML = `<section class="prose"><h1>Something went wrong</h1><p class="error">${esc(errText(e))}</p></section>`;
  }
  if (run === seq) requestAnimationFrame(() => app.classList.add('in'));
}

/// Test networks only: the mock Credits contract lets anyone mint, so testers can fill batches themselves.
function drawTestnet() {
  const el = document.getElementById('testnet')!;
  if (config.chainId === 1) return;
  el.hidden = false;
  el.innerHTML = `<span><strong>${chain.name}</strong> test mode. Credits here are mocks.</span>${
    session.account ? '<button class="link small" id="faucet">Get 20 test Credits</button>' : ''
  }`;
  document.getElementById('faucet')?.addEventListener('click', async (e) => {
    const b = e.currentTarget as HTMLButtonElement;
    b.disabled = true;
    b.textContent = 'Minting…';
    try {
      await send({ address: config.credits, abi: parseAbi(['function mint(address,uint256) returns (uint256)']), functionName: 'mint', args: [session.account!, 20n] });
      toast('20 test Credits minted.', 'ok');
      route();
    } catch (x) {
      toast(errText(x), 'err');
    }
    b.disabled = false;
    b.textContent = 'Get 20 test Credits';
  });
}

function drawAccount() {
  const el = document.getElementById('account')!;
  el.innerHTML = session.account
    ? `<button class="btn sm" id="acct" title="Disconnect"><i class="dot live"></i><span class="mono">${short(session.account)}</span></button>`
    : `<button class="btn sm primary" data-connect>Connect</button>`;
  document.getElementById('acct')?.addEventListener('click', () => {
    if (confirm('Disconnect wallet?')) disconnect();
  });
}

async function openConnect() {
  window.dispatchEvent(new Event('eip6963:requestProvider'));
  if (wallets.length <= 1) {
    try {
      await connect(wallets[0]);
    } catch (e) {
      toast(errText(e), 'err');
    }
    return;
  }
  const d = document.getElementById('wallets') as HTMLDialogElement;
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
