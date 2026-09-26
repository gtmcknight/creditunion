import { listBatches } from '../data';
import { esc } from '../ui';

/// /og: every page's link card as X shows it, read from the head tags the worker serves for that page
/// (src/worker/og.ts), with the tags underneath. The images are drawn by scripts/og.ts.

type Card = { route: string; title: string; ogTitle: string; description: string; image: string; card: string };

async function read(route: string): Promise<Card> {
  const doc = new DOMParser().parseFromString(await (await fetch(route, { cache: 'no-store' })).text(), 'text/html');
  const meta = (sel: string) => doc.querySelector<HTMLMetaElement>(sel)?.content ?? '';
  return {
    route,
    title: doc.title,
    ogTitle: meta('meta[property="og:title"]'),
    description: meta('meta[name="twitter:description"]') || meta('meta[property="og:description"]'),
    image: meta('meta[name="twitter:image"]') || meta('meta[property="og:image"]'),
    card: meta('meta[name="twitter:card"]'),
  };
}

const host = location.hostname.replace(/^www\./, '');

export async function og(app: HTMLElement) {
  app.innerHTML = `<section class="og-page"><h1>Link previews</h1><p class="muted">Each page’s card as X shows it, read from the tags the site serves for that page.</p><div class="og-grid" id="og-grid"><p class="muted">Reading the pages…</p></div></section>`;
  // Every real party gets its own card, drawn from the party itself.
  const parties = await listBatches()
    .then((all) => all.map((b) => `/party/${b.s.address}`))
    .catch(() => [] as string[]);
  const routes = ['/', '/parties', '/auctions', '/create', '/about', ...(parties.length ? parties : ['/party/0x0000000000000000000000000000000000000000']), '/mint', '/me'];
  const cards = await Promise.all(routes.map(read));
  const grid = document.getElementById('og-grid');
  if (!grid) return;
  grid.innerHTML = cards
    .map(
      (c) => `<article class="og-post">
      <div class="og-route"><a href="${esc(c.route)}">${esc(c.route.length > 24 ? `${c.route.slice(0, 16)}…${c.route.slice(-4)}` : c.route)}</a><span>${esc(c.card || 'no twitter:card')}</span></div>
      <div class="og-tweet">
        <span class="og-avatar" aria-hidden="true"></span>
        <div class="og-body">
          <div class="og-who"><b>Eighty</b><span>@eighty · 1h</span></div>
          <p>${esc(`${host}${c.route === '/' ? '' : c.route}`)}</p>
          <a class="og-card" href="${esc(c.route)}">
            <span class="og-media">${c.image ? `<img src="${esc(new URL(c.image).pathname)}" alt="" loading="lazy">` : '<span class="og-none">No image</span>'}<span class="og-overlay">${esc(c.ogTitle)}</span></span>
          </a>
          <div class="og-from">From ${esc(host)}</div>
        </div>
      </div>
      <dl class="og-tags">
        <dt>title</dt><dd>${esc(c.title || '—')}</dd>
        <dt>og:title</dt><dd>${esc(c.ogTitle || '—')}</dd>
        <dt>description</dt><dd>${esc(c.description || '—')}</dd>
        <dt>image</dt><dd>${c.image ? `<a href="${esc(new URL(c.image).pathname)}" target="_blank" rel="noopener">${esc(new URL(c.image).pathname)}</a>` : '—'}</dd>
      </dl>
    </article>`,
    )
    .join('');
  // Every state a party's card can be in, drawn from made-up parties.
  const SAMPLES: [string, string][] = [['open', 'Filling'], ['full', 'Full'], ['nobids', 'At auction, no bids'], ['auction', 'At auction'], ['sold', 'Sold']];
  // The page can be drawn twice at load (the wallet reconnecting re-routes); keep one copy.
  document.getElementById('og-samples')?.remove();
  grid.insertAdjacentHTML(
    'afterend',
    `<div id="og-samples"><h2 class="og-h">Party cards, every state</h2><div class="og-grid">${SAMPLES.map(
      ([k, l]) => `<figure class="og-sample"><img src="/og/sample/${k}.png" alt="" loading="lazy"><figcaption>${l}</figcaption></figure>`,
    ).join('')}</div></div>`,
  );
}
