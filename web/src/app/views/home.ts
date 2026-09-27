import { mountWall } from '../wall';
import { FAMILY } from './figures';
import { esc, short } from '../ui';



const link = (href: string, text: string) => `<a href="${esc(href)}" target="_blank" rel="noopener">${esc(text)} ↗</a>`;

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


export const FIG = {
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
        t(100, 176, 'Full', { weight: 600, size: 15, anchor: 'start' }) + t(100, 194, 'locked an hour to burn', { size: 12, fill: '#666', anchor: 'start' }) +
        t(100, 236, 'Not burned', { weight: 600, size: 15, anchor: 'start' }) + t(100, 254, 'unlocks, anyone can leave', { size: 12, fill: '#666', anchor: 'start' })),
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
      svg(300, 300, deposit + sorted + layout + ['Deposit', 'Number', 'Painted'].map((l, i) => t(x0[i] + 35, 214, l, { size: 12, fill: '#666' })).join(''))
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

};

type Chapter = { id: string; nav: string; title: string; figure?: string; body: string };

export function home(app: HTMLElement) {
  const chapters: Chapter[] = [
    {
      id: 'lifecycle',
      nav: 'How it runs',
      title: 'Start a Credit Union',
      figure: FAMILY.story,
      body: `<p>Pool your Credits with other holders. At 80 they burn into a Statement, and everyone in shares the sale.</p>`,
    },
    {
      id: 'eligibility',
      nav: 'Who joins',
      title: 'Deposit',
      figure: FAMILY.invited,
      body: `<p>Pick exactly which Credits get in: any Credit, or only ones with the <a href="/credits">traits</a> you choose.</p>`,
    },
    {
      id: 'order',
      nav: 'Layout',
      title: 'Layout',
      figure: FAMILY.painted,
      body: `<p>Arrange the 80 however you like: in deposit order, by Credit number, or painted into a design.</p>`,
    },
    {
      id: 'buying',
      nav: 'Buying in',
      title: 'Buy in',
      figure: FAMILY.buy,
      body: `<p>Buy Credits right here, through OpenSea, to help fill any Credit Union.</p>`,
    },
    {
      id: 'exit',
      nav: 'Leaving',
      title: 'Withdrawals',
      figure: FAMILY.door,
      body: `<p>Withdraw anytime until a full Credit Union locks. If nobody burns it within the hour, it unlocks again.</p>`,
    },
    {
      id: 'auction',
      nav: 'Auction',
      title: 'Dividends',
      figure: FAMILY.paddles,
      body: `<p>The Statement goes to auction, and the proceeds are split across its members.</p>`,
    },
  ];

  // Two sections to a row, and between rows a band of the living wall in another view.
  const panels = chapters;
  const panel = (c: Chapter) => `<section class="chapter" id="${c.id}">
      <h2>${esc(c.title)}</h2>
      ${c.body}
      ${c.figure ?? ''}
    </section>`;

  const headline = `<h1><span>Join a Credit Union</span> <span>to make a Statement together.</span></h1>`;
  const cta = `<p class="wall-cta"><a class="btn primary" href="/unions">Browse Credit Unions →</a><a class="btn" href="/create">Start your own</a></p>`;
  app.innerHTML = `
  <section class="hero"><div id="wall"></div><div class="hero-text">${headline}${cta}</div></section>
  <article class="about doc">
    <div class="chapter-grid">${panels.map(panel).join('')}</div>
    <section class="faq" id="faq"><h2>Questions</h2><div class="faq-cols"><div><details><summary>When can Credit Unions burn into Statements?</summary><p>Jack’s Statement contract is expected around October 1 (<a href="https://x.com/jackbutcher/status/2102910106451021935" target="_blank" rel="noopener">Jack’s announcement</a>). Until then full Credit Unions wait, and anyone can still leave. Once it’s live, a full Credit Union counts down 5 minutes, then locks for an hour so anyone can burn it.</p></details><details><summary>Is Credit Union official?</summary><p>No. It’s an independent project built on Jack Butcher’s Credits.</p></details><details><summary>What does it cost?</summary><p>Free to start or join. Credit Union takes 2% of the sale, only if it sells, and 2% on Credits you buy from OpenSea through Credit Union.</p></details><details><summary>What if a Credit Union never fills?</summary><p>Nothing. Take your Credits back whenever you want.</p></details></div><div><details><summary>What if nobody burns it?</summary><p>After the hour it unlocks. Leave, or restart the countdown for another try.</p></details><details><summary>What if nobody bids?</summary><p>The Statement stays in the Credit Union until someone bids at least 0.01 ETH. The 24 hours start with that bid.</p></details><details><summary>How is the money split?</summary><p>Equal pays every Credit the same. Early bird pays the first Credit in three times the last.</p></details><details><summary>How do I get paid?</summary><p>Claim your share on the Credit Union’s page once the auction settles.</p></details></div></div></section>
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

  mountWall(document.getElementById('wall')!);

  // Deep link: /about/<chapter>.
  const target = location.pathname.split('/')[2];
  const el = target && document.getElementById(target);
  if (el) requestAnimationFrame(() => el.scrollIntoView({ block: 'start' }));
}
