import type { Address } from 'viem';
import { chain, config, connect, loadConfig, onSession, restore, session, wallets } from './chain';
import { batch } from './views/batch';
import { create } from './views/create';
import { home } from './views/home';
import { docs } from './views/docs';
import { invalidateFit } from './fit';
import { hydrate, who } from './ens';
import { mint } from './views/mint';
import { og } from './views/og';
import { profile } from './views/profile';
import { esc, errText, toast } from './ui';

const app = document.getElementById('app')!;
let seq = 0;

/// Real paths: / (how it works; /about too), /parties, /auctions, /create, /party/0x…, /mint, /me.
/// Old #/ links (and the old names /new, /b, /docs, /how) still land in the right place.
const LEGACY: Record<string, string> = { new: 'create', b: 'party', docs: 'about', how: 'about' };
function pagePath(): string[] {
  const parts = location.pathname.replace(/^\/+|\/+$/g, '').split('/');
  parts[0] = LEGACY[parts[0]] ?? parts[0];
  return parts;
}
if (location.hash.startsWith('#/')) {
  const [p, ...rest] = location.hash.slice(2).split('/');
  history.replaceState(null, '', '/' + [LEGACY[p] ?? p, ...rest].filter(Boolean).join('/'));
}
/// Navigate without a reload.
export function go(path: string) {
  if (path === location.pathname) return;
  history.pushState(null, '', path);
  window.scrollTo({ top: 0 });
  route();
}

async function route() {
  const run = ++seq;
  const [page, arg] = pagePath();
  const current = page === 'party' ? 'parties' : page;
  document.querySelectorAll<HTMLAnchorElement>('[data-nav]').forEach((a) => a.toggleAttribute('aria-current', a.dataset.nav === current));
  document.querySelectorAll<HTMLAnchorElement>('#account [data-nav]').forEach((a) =>
    a.classList.toggle('current', page === 'me'),
  );
  app.classList.remove('in');
  try {
    if (page === '' || page === 'about') docs(app);
    else if (page === 'mint') await mint(app, route);
    else if (page === 'og') await og(app);
    else if (page === 'me') await profile(app, route);
    else if (page === 'create') await create(app);
    else if (page === 'party' && /^0x[0-9a-fA-F]{40}$/.test(arg ?? '')) await batch(app, arg as Address, route);
    else if (page === 'parties' || page === 'auctions') await home(app, page);
    else docs(app);
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
  el.innerHTML = `<span><strong>Testnet</strong> · ${esc(chain.name)}</span><a href="/mint">Mint test Credits →</a>`;
}

/// Phone browsers have no wallet inside them: open this page in a wallet's own browser instead.
function mobileWalletLinks() {
  const here = location.href;
  const host = location.host + location.pathname;
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
    ? `<a class="btn sm acct" href="/me" data-nav="me">${who(session.account)}</a>`
    : `<button class="btn sm" data-connect>Connect</button>`;
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

// Theme: the button flips whatever is currently in effect; the choice is remembered per browser.
function currentTheme(): 'light' | 'dark' {
  const set = document.documentElement.getAttribute('data-theme');
  if (set === 'light' || set === 'dark') return set;
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}
function drawTheme() {
  const t = currentTheme();
  document.documentElement.dataset.mode = t;
  document.getElementById('theme')?.setAttribute('aria-label', `Switch to ${t === 'dark' ? 'light' : 'dark'} theme`);
  document.querySelector<HTMLMetaElement>('meta[name=theme-color]:not([media])')?.setAttribute('content', t === 'dark' ? '#0a0a0a' : '#ffffff');
}
document.getElementById('theme')?.addEventListener('pointerup', (e) => setTimeout(() => (e.currentTarget as HTMLElement | null)?.blur(), 0));
document.getElementById('theme')?.addEventListener('click', () => {
  const next = currentTheme() === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  try {
    localStorage.setItem('eighty-theme', next);
  } catch {}
  drawTheme();
});
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', drawTheme);
drawTheme();

onSession(() => {
  invalidateFit();
  drawAccount();
  drawTestnet();
  route();
});
window.addEventListener('popstate', () => route());
// Same-site links navigate in place; new tabs, modified clicks and the Worker's own paths load normally.
document.addEventListener('click', (e) => {
  const a = (e.target as HTMLElement).closest?.('a');
  if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || a.target) return;
  const url = new URL(a.href, location.href);
  if (url.origin !== location.origin || /^\/(rpc|ratings|edition|art|opensea|ens|config\.json)/.test(url.pathname)) return;
  e.preventDefault();
  go(url.pathname);
});

// A mouse click on a nav link shouldn't leave a focus ring on it after the page changes.
document.addEventListener('click', (e) => {
  const a = (e.target as HTMLElement).closest?.('header a');
  if (a && e.detail > 0) (a as HTMLElement).blur();
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
  // Header counts. The Parties and Auctions pages fill them from their own read.
})();
