import type { Address } from 'viem';
import { chain, config, connect, disconnect, explorer, loadConfig, onSession, restore, session, wallets } from './chain';
import { party } from './views/party';
import { create } from './views/create';
import { lists } from './views/lists';
import { home } from './views/home';
import { invalidateFit } from './fit';
import { hydrate, who } from './ens';
import { mint } from './views/mint';
import { previews } from './views/previews';
import { live } from './views/live';
import { profile } from './views/profile';
import { credit } from './views/credit';
import { traitPage } from './views/trait';
import { timePage } from './views/time';
import { creditsPage } from './views/credits';
import { bitsPage, ratingPage } from './views/scale';
import { esc, errText, openModal, toast } from './ui';

const app = document.getElementById('app')!;
let seq = 0;

/// Real paths: / (how it works; /about too), /unions, /auctions, /credits, /create, /union/0x…, /credit/123, /mint, /me,
/// trait pages /palette/CMYK, /eights/3, /print/slip, /weight/sparse, and /time?from=&to=, /rating, /bits. Pages keep their old
/// internal names (party, parties). Old #/ links and old paths (/party, /parties, /new, /b, /docs, /how) still land.
const LEGACY: Record<string, string> = { union: 'party', unions: 'parties', new: 'create', b: 'party', docs: 'about', how: 'about' };
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
  if (path === location.pathname + location.search) return;
  history.pushState(null, '', path);
  window.scrollTo({ top: 0 });
  route();
}

/// The Credits explorer: its landing, the trait indexes and pages, the range pages.
const EXPLORER = new Set(['credits', 'palette', 'eights', 'print', 'weight', 'time', 'rating', 'bits']);

let lastPage = '';
async function route() {
  const run = ++seq;
  const [page, arg] = pagePath();
  const current = page === 'party' ? 'parties' : EXPLORER.has(page) ? 'credits' : page === '' || page === 'about' ? 'home' : page;
  document.querySelectorAll<HTMLAnchorElement>('[data-nav]').forEach((a) => a.toggleAttribute('aria-current', a.dataset.nav === current));
  document.querySelectorAll<HTMLAnchorElement>('#account [data-nav]').forEach((a) =>
    a.classList.toggle('current', page === 'me'),
  );
  // Moving within the Credits explorer (trait to trait) swaps the page in place; elsewhere it fades in.
  const within = EXPLORER.has(page) && EXPLORER.has(lastPage);
  lastPage = page;
  if (!within) app.classList.remove('in');
  try {
    if (page === '' || page === 'about') home(app);
    else if (page === 'mint') await mint(app, route);
    else if (page === 'og') await previews(app);
    else if (page === 'live') await live(app);
    else if (page === 'me') await profile(app, route);
    else if (page === 'member' && /^0x[0-9a-fA-F]{40}$/.test(arg ?? '')) await profile(app, route, arg as Address);
    else if (page === 'create') await create(app);
    else if (page === 'credit') await credit(app, arg ?? '');
    else if (page === 'time') await timePage(app);
    else if (page === 'rating') await ratingPage(app);
    else if (page === 'bits') await bitsPage(app);
    else if (page === 'credits') await creditsPage(app); // the explorer's overview: a tile per trait
    else if (page === 'palette' || page === 'eights' || page === 'print' || page === 'weight') await traitPage(app, page, arg ?? '');
    else if (page === 'party' && /^0x[0-9a-fA-F]{40}$/.test(arg ?? '')) await party(app, arg as Address, route);
    else if (page === 'parties' || page === 'auctions') await lists(app, page);
    else home(app);
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
    <p class="muted small">This browser has no wallet built in. Open Credit Union inside your wallet app’s browser, or paste the link there.</p>
    <div class="wallet-list">${links.map(([n, u]) => `<a class="wallet" href="${esc(u)}" rel="noopener"><span>${n}</span><span class="muted">↗</span></a>`).join('')}</div>
    <button class="btn block" id="copy-link" value="">Copy link</button>`;
}

function drawAccount() {
  const el = document.getElementById('account')!;
  el.innerHTML = session.account
    ? `<div class="acct-wrap"><button type="button" class="btn sm acct" data-nav="me" aria-haspopup="menu" aria-expanded="false">${who(session.account)}</button>
      <div class="acct-menu" role="menu" hidden><a role="menuitem" href="/me">Profile</a><button type="button" role="menuitem" data-disconnect>Disconnect</button></div></div>`
    : `<button class="btn sm" data-connect>Connect</button>`;
  hydrate(el);
}

// The account button opens a small menu: Profile, Disconnect. Any click elsewhere, a pick, or Escape closes it.
document.addEventListener('click', (e) => {
  const t = e.target as HTMLElement;
  const btn = t.closest<HTMLButtonElement>('.btn.acct');
  const menu = document.querySelector<HTMLElement>('.acct-menu');
  if (!menu) return;
  if (btn) {
    menu.hidden = !menu.hidden;
    btn.setAttribute('aria-expanded', String(!menu.hidden));
    return;
  }
  if (t.closest('[data-disconnect]')) {
    disconnect();
    go('/');
  }
  menu.hidden = true;
  document.querySelector('.btn.acct')?.setAttribute('aria-expanded', 'false');
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  const menu = document.querySelector<HTMLElement>('.acct-menu');
  if (menu) menu.hidden = true;
});

async function openConnect() {
  window.dispatchEvent(new Event('eip6963:requestProvider'));
  const d = document.getElementById('wallets') as HTMLDialogElement;
  const injected = (window as unknown as { ethereum?: unknown }).ethereum;
  if (wallets.length === 0 && !injected) {
    d.innerHTML = `<form method="dialog">${mobileWalletLinks()}</form>`;
    d.querySelector('#copy-link')?.addEventListener('click', () => {
      navigator.clipboard?.writeText(location.href).then(() => toast('Link copied.', 'ok'));
    });
    openModal(d);
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
    .join('')}</div></form>`;
  openModal(d);
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
    localStorage.setItem('cu-theme', next);
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
  // A link inside a link (a card's creator): its own place, not the card's.
  const inner = (e.target as HTMLElement).closest?.<HTMLElement>('[data-href]');
  if (inner && e.button === 0) {
    e.preventDefault();
    if (e.metaKey || e.ctrlKey) window.open(inner.dataset.href, '_blank');
    else go(inner.dataset.href!);
    return;
  }
  const a = (e.target as HTMLElement).closest?.('a');
  if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || a.target) return;
  const url = new URL(a.href, location.href);
  if (url.origin !== location.origin || /^\/(rpc|ratings|edition|art|opensea|ens|config\.json)/.test(url.pathname)) return;
  e.preventDefault();
  document.querySelectorAll<HTMLDialogElement>('dialog[open]').forEach((d) => d.close());
  go(url.pathname + url.search);
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
  document.getElementById('magic-eye')?.addEventListener('click', () => import('./magic').then((m) => m.openMagic()));
  const factoryUrl = explorer('address', config.factory);
  if (factoryUrl) document.getElementById('foot-contract')?.setAttribute('href', factoryUrl);
  // Draw with the wallet if it answers quickly; never wait on it. A slow extension (Rainbow can take seconds to
  // answer eth_accounts) reconnects whenever it answers, and the page redraws then (onSession).
  await Promise.race([restore().catch(() => {}), new Promise((r) => setTimeout(r, 300))]);
  route();
  // Header counts. The Parties and Auctions pages fill them from their own read.
})();
