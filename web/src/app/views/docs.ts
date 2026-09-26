import { mountWall } from '../wall';
import { chain, config, explorer } from '../chain';
import { esc, short } from '../ui';

const REPO = 'https://github.com/lucibotnyc/eighty';
const CREDITS_MAINNET = '0x97630aA70AB14ed9883B41dAfccBc11349723043';
const SEAPORT = '0x0000000000000068F116a894984e2DB1123eB395';


const link = (href: string, text: string) => `<a href="${esc(href)}" target="_blank" rel="noopener">${esc(text)} ↗</a>`;
const addr = (a: string, label: string) => {
  const u = explorer('address', a);
  return `<span class="addr"><span>${esc(label)}</span>${u ? `<a class="mono" href="${u}" target="_blank" rel="noopener">${short(a)} ↗</a>` : `<span class="mono">${short(a)}</span>`}</span>`;
};
const src = (path: string) => link(`${REPO}/blob/main/${path}`, path.split('/').pop()!);

/* ---------------------------------------------------------------- figures
   Drawn in the Credits' own inks on paper. Plate mixes indexed by the 4-bit CMYK mask, as in wall.ts. */
const MIXES = ['#fff', '#00b5e2', '#e4007c', '#00006e', '#ffd100', '#009400', '#e40000', '#000', '#111', '#000c0f', '#0f0008', '#000007', '#110e00', '#000a00', '#0f0000', '#000'];
const INKS = [1, 2, 4, 3, 5, 6, 8];
const PAPER_GREY = '#e6e6e3';
const K = '#111', C = '#00b5e2', M = '#e4007c', Y = '#ffd100';
let seed = 80;
const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const r = (x: number, y: number, w: number, h: number, fill: string, extra = '') =>
  `<rect x="${+x.toFixed(1)}" y="${+y.toFixed(1)}" width="${+w.toFixed(1)}" height="${+h.toFixed(1)}" fill="${fill}"${extra}/>`;
const t = (x: number, y: number, s: string, o: { size?: number; anchor?: string; fill?: string; weight?: number } = {}) =>
  `<text x="${x}" y="${y}" font-size="${o.size ?? 13}" font-weight="${o.weight ?? 400}" text-anchor="${o.anchor ?? 'middle'}" fill="${o.fill ?? K}">${s}</text>`;
const svg = (w: number, h: number, inner: string) => `<svg viewBox="0 0 ${w} ${h}" role="img">${inner}</svg>`;
/// An 8-wide, 10-tall Statement sheet at (x, y).
const sheet = (x: number, y: number, fill: (i: number, c: number, row: number) => string, cell = 10, gap = 2) => {
  let out = '';
  for (let i = 0; i < 80; i++) out += r(x + (i % 8) * (cell + gap), y + ((i / 8) | 0) * (cell + gap), cell, cell, fill(i, i % 8, (i / 8) | 0));
  return out;
};
const fig = (inner: string, caption = '') => `<figure class="fig"><div class="viz">${inner}</div>${caption ? `<figcaption>${caption}</figcaption>` : ''}</figure>`;


const FIG = {
  lifecycle: () => {
    const steps: [string, string, string][] = [
      ['Open', 'join or leave any time', C],
      ['Full', '80 in, locked', M],
      ['Burn', 'anyone can trigger it', K],
      ['Auction', '24 hours', Y],
      ['Split', 'shared by the 80', '#009400'],
    ];
    return fig(
      svg(300, 300, `<line x1="61" y1="48" x2="61" y2="252" stroke="${K}" stroke-width="1.5"/>` +
        steps.map(([a, b, f], i) => r(50, 37 + i * 51, 22, 22, f) + t(92, 46 + i * 51, a, { weight: 600, size: 15, anchor: 'start' }) + t(92, 63 + i * 51, b, { size: 12, fill: '#666', anchor: 'start' })).join('')),
    );
  },

  exit: () =>
    fig(
      svg(300, 300,
        r(50, 30, 30, 120, C) + r(50, 150, 30, 60, K) + r(50, 210, 30, 60, Y) +
        t(100, 86, 'Filling', { weight: 600, size: 15, anchor: 'start' }) + t(100, 104, 'leave any time', { size: 12, fill: '#666', anchor: 'start' }) +
        t(100, 176, 'Full', { weight: 600, size: 15, anchor: 'start' }) + t(100, 194, 'locked for 7 days', { size: 12, fill: '#666', anchor: 'start' }) +
        t(100, 236, 'Not burned', { weight: 600, size: 15, anchor: 'start' }) + t(100, 254, 'anyone can leave', { size: 12, fill: '#666', anchor: 'start' })),
    ),

  // The paired figures are square, drawn on a 300-unit grid.
  eligibility: () => {
    const on = new Set([1, 5, 6]);
    return fig(
      svg(300, 300,
        Array.from({ length: 15 }, (_, i) => {
          const m = i + 1, x = 16 + (i % 5) * 56, y = 42 + ((i / 5) | 0) * 76;
          return r(x, y, 44, 44, MIXES[m], on.has(m) ? '' : ' opacity=".15"') + t(x + 22, y + 62, [...'CMYK'].filter((_, b) => m & (1 << b)).join(''), { size: 12, fill: on.has(m) ? K : '#aaa' });
        }).join(''))
    );
  },

  order: () => {
    const x0 = [20, 115, 210];
    const deposit = sheet(x0[0], 96, () => MIXES[INKS[(rnd() * INKS.length) | 0]], 7, 2);
    const sorted = sheet(x0[1], 96, (i) => MIXES[INKS[Math.min(INKS.length - 1, ((i / 80) * INKS.length) | 0)]], 7, 2);
    const layout = sheet(x0[2], 96, (_, c, row) => (c === 0 || row === 0 || c === 7 || row === 9 ? K : (c + row) % 2 ? C : Y), 7, 2);
    return fig(
      svg(300, 300, deposit + sorted + layout + ['Deposit', 'Mint time', 'Layout'].map((l, i) => t(x0[i] + 35, 214, l, { size: 12, fill: '#666' })).join(''))
    );
  },

  auction: () => {
    const x = (h: number) => 30 + (h / 24) * 220;
    const bids: [number, number][] = [[0, 36], [4, 56], [9, 78], [15, 102], [21, 126], [23.4, 150]];
    return fig(
      svg(300, 300,
        `<line x1="30" y1="220" x2="${x(24)}" y2="220" stroke="${K}" stroke-width="1.5"/>` +
        r(x(24), 217, 30, 6, M) +
        bids.map(([h, v], i) => r(x(h) - 5, 220 - v, 10, v, i === bids.length - 1 ? M : K)).join('') +
        t(30, 245, 'first bid', { size: 12, fill: '#666', anchor: 'start' }) +
        t(x(24), 245, '24h', { size: 12, fill: '#666' }) +
        t(280, 265, '+15 min', { size: 12, fill: M, anchor: 'end' }))
    );
  },

  early: () => {
    const base = 230, top = 150, h = (i: number) => top * ((1.5 - i / 79) / 1.5);
    const pay = (i: number) => ((4 * 0.98) / 80) * (1.5 - i / 79);
    const eqY = base - top / 1.5;
    return fig(
      svg(300, 300,
        Array.from({ length: 80 }, (_, i) => r(30 + i * 3, base - h(i), 2, h(i), i < 12 ? M : K)).join('') +
        `<line x1="28" y1="${eqY}" x2="272" y2="${eqY}" stroke="${C}" stroke-width="1.5" stroke-dasharray="4 4"/>` +
        t(272, eqY - 8, 'Equal 0.049', { size: 12, fill: C, anchor: 'end' }) +
        t(30, 256, `1st in ${pay(0).toFixed(4)}`, { size: 12, anchor: 'start', weight: 600 }) +
        t(270, 256, `80th ${pay(79).toFixed(4)}`, { size: 12, anchor: 'end', weight: 600 })),
      'ETH per Credit on a 4 ETH sale.',
    );
  },

  buying: () =>
    fig(
      svg(300, 300,
        [0, 1, 2, 3, 4].map((i) => r(44, 90 + i * 24, 18, 18, C)).join('') +
        t(53, 232, 'OpenSea', { size: 12, fill: '#666' }) +
        `<path d="M80 150 H132 M124 143 L132 150 L124 157" stroke="${K}" stroke-width="1.5" fill="none"/>` +
        sheet(150, 76, (i) => (i < 58 ? '#9a9a9a' : i < 63 ? C : PAPER_GREY), 12, 3)),
    ),

  launch: () =>
    fig(
      svg(300, 300,
        r(50, 40, 24, 24, K) + r(56, 76, 12, 136, Y) + r(50, 224, 24, 24, '#009400') +
        t(96, 50, 'Proposed', { weight: 600, size: 15, anchor: 'start' }) + t(96, 67, 'the burn adapter', { size: 12, fill: '#666', anchor: 'start' }) +
        t(96, 140, '30 minutes', { weight: 600, size: 15, anchor: 'start' }) + t(96, 157, 'anyone can leave any party', { size: 12, fill: '#666', anchor: 'start' }) +
        t(96, 234, 'Switched on', { weight: 600, size: 15, anchor: 'start' }) + t(96, 251, 'for good', { size: 12, fill: '#666', anchor: 'start' })),
    ),

};

type Chapter = { id: string; nav: string; title: string; figure?: string; body: string };

export function docs(app: HTMLElement) {
  const testnet = config.chainId !== 1;
  const chapters: Chapter[] = [
    {
      id: 'lifecycle',
      nav: 'How it runs',
      title: 'Five steps, all onchain',
      figure: FIG.lifecycle(),
      body: `<p>Start a party with your Credit. At 80, anyone can burn them into a Statement. It sells at auction and the money is split between the 80, after a 2% fee.</p>`,
    },
    {
      id: 'exit',
      nav: 'Leaving',
      title: 'You can always leave',
      figure: FIG.exit(),
      body: `<p>Take your Credits back any time before the party fills. A full party locks for 7 days so it can be burned. Not burned by then? Anyone can leave.</p>`,
    },
    {
      id: 'eligibility',
      nav: 'Who joins',
      title: 'Parties pick who joins',
      figure: FIG.eligibility(),
      body: `<p>By Jack’s traits: Colors, Plates, Print, Weight, Eights, Bits, Payment Time or ${link('https://jack.art/credits/rating', 'Rating')}. Or by name, up to 200 Credits. Every deposit is checked onchain.</p>`,
    },
    {
      id: 'order',
      nav: 'Order',
      title: 'And how the 80 are laid out',
      figure: FIG.order(),
      body: `<p>Deposit order, mint time, Credit number, or a painted layout that only fills with the right Colors.</p>`,
    },
    {
      id: 'auction',
      nav: 'Auction',
      title: '24 hours from the first bid',
      figure: FIG.auction(),
      body: `<p>Each bid beats the last by 5%. A bid in the final 15 minutes puts 15 back on the clock. Outbid? Your ETH comes straight back.</p>`,
    },
    {
      id: 'early',
      nav: 'Early bird',
      title: 'Early bird pays more',
      figure: FIG.early(),
      body: `<p>Early bird parties pay the first Credit in three times the last. Equal parties pay every Credit the same.</p>`,
    },
    {
      id: 'buying',
      nav: 'Buying in',
      title: 'No Credit? Buy in',
      figure: FIG.buying(),
      body: `<p>Eighty finds the cheapest OpenSea listings that fit, then buys and deposits them in one transaction, for a 2% fee.</p>`,
    },
    {
      id: 'launch',
      nav: 'Before launch',
      title: 'Filling now, burning soon',
      figure: FIG.launch(),
      body: `<p>Jack’s Statement contract isn’t out yet. When it ships, we plug in the piece that burns through it. You get 30 minutes’ notice to leave first.</p>`,
    },
    {
      id: 'contracts',
      nav: 'Contracts',
      title: 'Contracts',
      body: `<div class="addrs">
        ${addr(config.factory, 'BatchFactory')}
        ${addr(config.credits, testnet ? 'Test Credits' : 'Credits')}
        ${config.sweeper ? addr(config.sweeper, 'Sweeper') : ''}
        ${config.ratings ? addr(config.ratings, 'Ratings') : ''}
      </div>
      ${testnet ? `<p class="small muted">This is a preview on ${esc(chain.name)}. The Credits are test mints with the real art.</p>` : ''}
      <p class="small muted">${link(REPO, 'Source')} · ${src('contracts/AUDIT.md')} · ${link(`https://etherscan.io/address/${CREDITS_MAINNET}`, 'Jack’s Credits')} · ${link('https://opensea.io/collection/credits', 'OpenSea')} · ${link(`https://etherscan.io/address/${SEAPORT}`, 'Seaport 1.6')}</p>`,
    },
  ];

  // Two sections to a row, and between rows a band of the living wall in another view.
  const panels = chapters.filter((c) => c.id !== 'contracts');
  const panel = (c: Chapter) => `<section class="chapter" id="${c.id}">
      <h2>${esc(c.title)}</h2>
      ${c.body}
      ${c.figure ?? ''}
    </section>`;

  app.innerHTML = `
  <div id="wall"></div>
  <article class="about doc">
    <div class="chapter-grid">${panels.map(panel).join('')}</div>
    ${chapters
      .filter((c) => c.id === 'contracts')
      .map((c) => `<section class="contracts-foot" id="${c.id}"><h2>${esc(c.title)}</h2>${c.body}</section>`)
      .join('')}
    <p class="muted small">Eighty is independent and not affiliated with Jack Butcher.</p>
  </article>`;

  // In-page links scroll; the router never sees them.
  app.querySelectorAll<HTMLAnchorElement>('a[href^="#"]').forEach((a) =>
    a.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const id = a.getAttribute('href')!.slice(1);
      document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      history.replaceState(null, '', `/about/${id}`);
    }),
  );

  mountWall(document.getElementById('wall')!, {
    label: `<h1>Eighty Credits make a Statement.</h1>
    <p>${link('https://jack.art/credits', 'Credits')} by Jack Butcher burn 80 at a time into one Statement. Most people hold one. A party pools them: one wallet nobody owns, rules nobody can change.</p>`,
  });

  // Deep link: /about/<chapter>.
  const target = location.pathname.split('/')[2];
  const el = target && document.getElementById(target);
  if (el) requestAnimationFrame(() => el.scrollIntoView({ block: 'start' }));
}
