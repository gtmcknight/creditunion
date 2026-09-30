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
import { activityTicker, live, tickerHtml } from './views/live';
import { docs } from './views/docs';
import { profile } from './views/profile';
import { printer } from './views/printer';
import { credit } from './views/credit';
import { traitPage } from './views/trait';
import { timePage } from './views/time';
import { bitsPage, ratingPage } from './views/scale';
import { esc, errText, openModal, startsAt, toast } from './ui';
import { indexedBatch, me, readNotice } from './data';

const app = document.getElementById('app')!;
let seq = 0;

/// Real paths: / (how it works and live activity), /docs, /unions, /auctions, /credits, /create, /union/0x…, /credit/123, /mint, /me,
/// trait pages /palette/CMYK, /eights/3, /print/slip, /weight/sparse, and /time?from=&to=, /rating, /bits. Pages keep their old
/// internal names (party, parties). Old #/ links and old paths (/party, /parties, /new, /b, /docs, /how) still land.
const LEGACY: Record<string, string> = { union: 'party', unions: 'parties', new: 'create', b: 'party', faq: 'docs', how: '', about: '' };
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
  // Where you came from, so a page can send you back (a Credit bought from a union's page returns there).
  try {
    sessionStorage.setItem('cu-prev', JSON.stringify({ from: location.pathname, to: path.split('?')[0] }));
  } catch {}
  history.pushState(null, '', path);
  window.scrollTo({ top: 0 });
  route();
}

/// The Credits explorer: its landing, the trait indexes and pages, the range pages.
const EXPLORER = new Set(['credits', 'palette', 'eights', 'print', 'weight', 'time', 'rating', 'bits']);

let lastPath = '';
let lastPage = '';
async function route() {
  const run = ++seq;
  const [page, arg] = pagePath();
  siteTicker(page);
  const current = page === 'party' ? 'parties' : EXPLORER.has(page) ? 'credits' : page === '' ? 'home' : page;
  document.querySelectorAll<HTMLAnchorElement>('[data-nav]').forEach((a) => a.toggleAttribute('aria-current', a.dataset.nav === current));
  document.querySelectorAll<HTMLAnchorElement>('#account [data-nav]').forEach((a) =>
    a.classList.toggle('current', page === 'me'),
  );
  // Moving within the Credits explorer (trait to trait) swaps the page in place; elsewhere it fades in.
  const within = EXPLORER.has(page) && EXPLORER.has(lastPage);
  // The same page drawn again (a wallet waking up and reconnecting, say) stays on screen: only a new page fades.
  const again = location.pathname === lastPath;
  lastPage = page;
  lastPath = location.pathname;
  if (!within && !again) {
    app.classList.remove('in');
    // The page being left goes at once: what fades in next can only be the new page (the backstop below once brought
    // the old one back while the new one was still loading).
    app.replaceChildren();
    // It fades in as soon as the view has put something up, not after everything it loads: a view that waits on a
    // slow read (or a wallet) must never sit invisible. A moment later it shows regardless.
    // Not on an animation frame alone: a frame can be withheld (a busy tab, a wallet popup) until the next click or
    // scroll, and the page would sit invisible. A short timer shows it regardless (after the style has flushed, so
    // it still fades).
    const show = () => {
      if (run !== seq) return;
      requestAnimationFrame(() => app.classList.add('in'));
      setTimeout(() => app.classList.add('in'), 60);
    };
    const seen = new MutationObserver(() => (seen.disconnect(), show()));
    seen.observe(app, { childList: true });
    setTimeout(() => (seen.disconnect(), show()), 400);
  }
  try {
    if (page === '') home(app);
    else if (page === 'docs') docs(app);
    else if (page === 'mint') await mint(app, route);
    else if (page === 'og') await previews(app);
    else if (page === 'activity' || page === 'live') await live(app);
    else if (page === 'me') await profile(app, route);
    else if (page === 'member' && /^0x[0-9a-fA-F]{40}$/.test(arg ?? '')) await profile(app, route, arg as Address);
    else if (page === 'create') await create(app);
    else if (page === 'printer' && (!arg || arg === 'mine' || /^[A-Za-z0-9]{10}$/.test(arg))) await printer(app, arg, route);
    else if (page === 'credit') await credit(app, arg ?? '');
    else if (page === 'time') await timePage(app);
    else if (page === 'rating') await ratingPage(app);
    else if (page === 'bits') await bitsPage(app);
    else if (page === 'credits' || page === 'palette' || page === 'eights' || page === 'print' || page === 'weight') await traitPage(app, page, arg ?? '');
    else if (page === 'party' && /^0x[0-9a-fA-F]{40}$/.test(arg ?? '')) await party(app, arg as Address, route);
    else if (page === 'parties' || page === 'auctions') await lists(app, page);
    else home(app);
  } catch (e) {
    if (run === seq) app.innerHTML = `<section class="prose"><h1>Something went wrong</h1><p class="error">${esc(errText(e))}</p></section>`;
  }
  if (run !== seq) return;
  requestAnimationFrame(() => app.classList.add('in'));
  setTimeout(() => run === seq && app.classList.add('in'), 60);
  // The tab says where you are: the page's heading (or, in the Credits explorer, its crumb: "Palette Y"), then the
  // site. Home is the site alone. It follows the heading when that changes (an address becoming its ENS name).
  const text = (e: Element | null) => (e?.textContent ?? '').replace(/\s+/g, ' ').trim();
  const title = () => {
    const crumb = [...app.querySelectorAll('.jb-crumb a, .jb-crumb b')].map(text);
    const name = page === '' ? '' : text(app.querySelector('h1')) || (crumb.length > 1 ? crumb.slice(1).join(' ') : crumb[0] ?? '');
    document.title = name && name !== 'Credit Union' ? `${name} · Credit Union` : 'Credit Union';
  };
  title();
  // A tab row that swipes (the Credits pages on a phone) opens with the current tab in the middle of it.
  const cur = app.querySelector<HTMLElement>('.subtabs.swipe [aria-current]');
  const row = cur?.parentElement;
  if (cur && row && row.scrollWidth > row.clientWidth) row.scrollLeft += cur.getBoundingClientRect().left - row.getBoundingClientRect().left - (row.clientWidth - cur.offsetWidth) / 2;
  headWatch?.disconnect();
  const h1 = app.querySelector('h1');
  if (h1) (headWatch = new MutationObserver(title)).observe(h1, { subtree: true, childList: true, characterData: true });
}
let headWatch: MutationObserver | null = null;

/// Test networks only: a banner above the header so shared links are unmistakably the preview.
function drawTestnet() {
  if (config.chainId === 1) return;
  const el = document.getElementById('testnet')!;
  el.hidden = false;
  el.innerHTML = `<span><strong>Testnet</strong> · ${esc(chain.name)}</span><a href="/mint">Mint test Credits →</a>`;
}

/// Burn day: from the moment the burn adapter is proposed until it's on, a bar above the header with when burning
/// turns on (the 30-minute notice in contracts/ADAPTER.md), in the viewer's own time, so members who don't trust it
/// know to leave in time.
async function drawNotice() {
  const n = await readNotice();
  if (!n) return;
  const link = explorer('address', n.adapter);
  const el = document.getElementById('notice')!;
  el.innerHTML = `<span><strong>Burning starts ${startsAt(n.at)}.</strong> Full Credit Unions lock 5 minutes later. Withdraw before then.</span>${link ? `<a href="${esc(link)}" target="_blank" rel="noopener">The burn contract ↗</a>` : ''}`;
  el.hidden = false;
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

// A slider dragged with the pointer keeps no focus ring; one moved with the keyboard shows it.
// Reading ahead: a pointer resting on a link to a Credit Union starts reading your side of it, so it opens with it
// there. Resting, not passing: a pointer crossing a grid of cards reads none of them.
let ahead: ReturnType<typeof setTimeout> | null = null;
document.addEventListener('pointerover', (e) => {
  const to = (e.target as HTMLElement).closest?.<HTMLAnchorElement>('a[href^="/union/0x"]')?.pathname.slice(7);
  if (ahead) clearTimeout(ahead);
  ahead = null;
  if (!to || !/^0x[0-9a-fA-F]{40}$/.test(to)) return;
  ahead = setTimeout(() => {
    if (session.account) void me(to as Address, session.account).catch(() => {});
    // An open union's Buy tab: the Worker starts its scan of the market now, so the listings are waiting on arrival.
    if (indexedBatch(to as Address)?.b.s.state === 'Open') void fetch(`/opensea/listings?batch=${to}`).catch(() => {});
  }, 150);
});
document.addEventListener('pointerdown', (e) => (e.target as HTMLElement).closest?.('.sweep-range input')?.setAttribute('data-pointer', ''), true);
document.addEventListener('keydown', (e) => (e.target as HTMLElement).closest?.('.sweep-range input')?.removeAttribute('data-pointer'), true);

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
  void drawNotice();
  document.getElementById('magic-eye')?.addEventListener('click', () => import('./magic').then((m) => m.openMagic()));
  // Draw with the wallet if it answers quickly; never wait on it. A slow extension (Rainbow can take seconds to
  // answer eth_accounts) reconnects whenever it answers, and the page redraws then (onSession).
  await Promise.race([restore().catch(() => {}), new Promise((r) => setTimeout(r, 300))]);
  route();
  // Header counts. The Parties and Auctions pages fill them from their own read.
})();

/// The Latest band under the nav, on every page but /activity (the full list), /create, profiles and union pages. Drawn once and kept
/// across page changes.
let tickerEl: HTMLElement | null = null;
function siteTicker(page: string) {
  if (!tickerEl) {
    document.querySelector('header.top')?.insertAdjacentHTML('afterend', `<div class="site-tick">${tickerHtml('site-ticker', 'tick-bar')}</div>`);
    tickerEl = document.querySelector<HTMLElement>('.site-tick');
    const t = document.getElementById('site-ticker');
    if (t) void activityTicker(t);
  }
  if (!tickerEl) return;
  const was = tickerEl.hidden;
  tickerEl.hidden = ['activity', 'live', 'create', 'me', 'member', 'party'].includes(page);
  if (was && !tickerEl.hidden) document.getElementById('site-ticker')?.dispatchEvent(new Event('refresh'));
}

// The mark builds once on load and again on hover; a hover mid-build lets it finish.
{
  const mark = document.querySelector<SVGElement>('.logo .mark');
  let building = false;
  const build = () => {
    if (!mark || building) return;
    building = true;
    mark.classList.remove('build');
    void mark.getBoundingClientRect();
    mark.classList.add('build');
    setTimeout(() => (building = false), 800);
  };
  build();
  mark?.closest('a')?.addEventListener('pointerenter', build);
}
