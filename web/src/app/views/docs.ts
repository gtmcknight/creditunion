import { config, explorer } from '../chain';
import { art, esc, pageHead, short } from '../ui';
import { arrIcon } from './create';

/// /docs: what Credits, Statements and Credit Unions are, then every rule of a union, in plain sections.
/// /faq redirects here. Numbers come from the contracts (Batch.sol constants); keep them in step.

/// The 80 Credits of the "All Credits" union, in deposit order: real art for the basics cards.
const SHEET = [56,67487,74082,67712,38883,107942,113579,87848,106728,90141,113276,108710,113083,63192,63220,63610,63993,63725,12257,119452,118865,6030,46828,93771,88997,3831,13208,85954,54261,46655,47227,46875,115397,119378,41233,27065,50460,4519,18140,18345,30174,19354,88704,30523,29886,9418,77721,34855,8155,22552,22468,50158,44608,105981,108927,114108,972,42232,101574,844,4995,117587,29261,42946,42971,50004,54301,74019,22663,87735,9016,775,784,104633,697,45979,63467,29024,114798,1929].map(BigInt);

/// 8×10 grid of framed Credit art; slots past `n` stay empty.
const grid = (n = 80) => `<div class="basic-grid">${SHEET.map((id, i) => (i < n ? `<i><img src="${art(id)}" alt=""></i>` : '<i></i>')).join('')}</div>`;

type Card = { tag: string; official: boolean; q: string; a: string; art: string; facts: [string, string][] };
/// Built on render: art URLs need the loaded config.
const cards = (): Card[] => [
  {
    tag: 'Jack Butcher', official: true, q: 'What are Credits?',
    a: 'Art by Jack Butcher. Every $8 sent to him on X Money bought one, and each was airdropped as an NFT on Ethereum, drawn from that payment’s transaction ID.',
    art: `<div class="basic-four">${SHEET.slice(0, 4).map((id) => `<img src="${art(id)}" alt="">`).join('')}</div>`,
    facts: [['122,154', 'Credits'], ['Sep 20–21', 'Paid on X, $8 each'], ['Sep 22–23', 'Airdropped on Ethereum']],
  },
  {
    tag: 'Jack Butcher', official: true, q: 'What are Statements?',
    a: 'Also by Jack Butcher. Burn 80 Credits from one wallet and they become one Statement, a single work made of all 80.',
    art: grid(),
    facts: [['80', 'Credits each'], ['1,526', 'Max, ever'], ['Oct 1', 'Burning opens']],
  },
  {
    tag: 'Credit Union', official: false, q: 'What is Credit Union?',
    a: 'This site, not Jack’s. Most people don’t have 80, so strangers pool them here. At 80 they burn, the Statement is auctioned, and everyone gets paid.',
    art: grid(52),
    facts: [['Pick', 'A union'], ['Join', 'Buy + deposit in one click'], ['Split', 'Paid when it sells']],
  },
];

const basics = () => `<div class="basics">${cards().map((c) => `<article class="basic${c.official ? '' : ' ours'}">
  <span class="basic-tag">${c.official ? 'Official' : 'Unofficial'} · ${c.tag}</span>
  <h2>${c.q}</h2>
  <p>${c.a}</p>
  <div class="basic-art">${c.art}</div>
  <dl>${c.facts.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('')}</dl>
</article>`).join('')}</div>`;


/// Early bird weight of the Credit at deposit position i (0-based), in shares: 1.5 for the first, 0.5 for the last.
/// Matches Batch._payMembers: units 237 − 2i out of 12,640.
const weight = (i: number, early: boolean) => (early ? (237 - 2 * i) / 158 : 1);
const FEE = 0.02;
const eth4 = (x: number) => `${x >= 1 ? x.toFixed(3) : x.toPrecision(3)} ETH`.replace(/\.?0+ ETH$/, ' ETH');

/// The union's life as five boxes, with what can happen in each.
const flow = `<ol class="doc-flow" aria-label="A Credit Union’s life">
  <li><b>Filling</b><span>Until 80 of 80. Leave anytime.</span></li>
  <li><b>Countdown</b><span>5 minutes. Anyone leaving stops it.</span></li>
  <li><b>Locked</b><span>1 hour. Anyone can burn.</span></li>
  <li><b>Auction</b><span>24 hours from the first bid.</span></li>
  <li><b>Paid</b><span>Everyone, in one transaction.</span></li>
</ol>`;

/// The split calculator: a sale price, the split, and your spots in the deposit order, drawn on the 8×10 sheet.
const calculator = `<div class="calc" id="calc">
  <div class="calc-inputs">
    <label><span>Sale price</span><span class="calc-field"><input type="number" id="calc-price" min="0" step="0.1" inputmode="decimal"><em>ETH</em></span></label>
    <label><span>Your Credits</span><span class="calc-field"><input type="number" id="calc-count" min="1" max="80" step="1" inputmode="numeric"></span></label>
    <label><span>First one in at</span><span class="calc-field"><em>#</em><input type="number" id="calc-from" min="1" max="80" step="1" inputmode="numeric"></span></label>
  </div>
  <div class="calc-sheets">
    <figure><div class="calc-sheet" data-split="equal"></div><figcaption><span>Equal</span><strong id="calc-equal"></strong></figcaption></figure>
    <figure><div class="calc-sheet" data-split="early"></div><figcaption><span>Early bird</span><strong id="calc-early"></strong></figcaption></figure>
  </div>
  <p class="calc-key">One square per Credit, in the order they went in. Stronger color earns more. Yours are outlined.</p>
</div>`;

function mountCalculator(root: HTMLElement) {
  const price = root.querySelector<HTMLInputElement>('#calc-price')!;
  const count = root.querySelector<HTMLInputElement>('#calc-count')!;
  const from = root.querySelector<HTMLInputElement>('#calc-from')!;
  const sheets = [...root.querySelectorAll<HTMLElement>('.calc-sheet')];
  sheets.forEach((el) => {
    const early = el.dataset.split === 'early';
    el.innerHTML = Array.from({ length: 80 }, (_, i) => `<i style="--w:${(weight(i, early) / 1.5).toFixed(3)}"></i>`).join('');
  });
  const draw = () => {
    const p = Math.max(0, Number(price.value) || 0);
    // Nothing is filled in until you type: no Credits outlined, no amounts.
    const n0 = Math.round(Number(count.value) || 0);
    const first = Math.min(80, Math.max(1, Math.round(Number(from.value) || 1))) - 1;
    const n = Math.min(80 - first, Math.max(0, n0));
    const perShare = (p * (1 - FEE)) / 80;
    for (const el of sheets) {
      const early = el.dataset.split === 'early';
      let shares = 0;
      el.querySelectorAll('i').forEach((c, i) => {
        const mine = i >= first && i < first + n;
        c.classList.toggle('mine', mine);
        if (mine) shares += weight(i, early);
      });
      const out = root.querySelector<HTMLElement>(`#calc-${early ? 'early' : 'equal'}`)!;
      const ready = p > 0 && n > 0;
      out.textContent = ready ? eth4(perShare * shares) : '0 ETH';
      out.classList.toggle('empty', !ready);
    }
  };
  [price, count, from].forEach((i) => i.addEventListener('input', draw));
  draw();
}

type Section = { id: string; title: string; body: string };
const sections = (): Section[] => [
  {
    id: 'how',
    title: 'How it works',
    body: `<p>A Credit Union is a contract that holds Credits for a group. When it has 80, it burns them into one Statement, auctions it, and pays everyone who put Credits in.</p>
    ${flow}
    <ol class="doc-steps">
      <li><b>Start.</b> Someone opens a union and sets its rules: which Credits it takes, how they’re arranged, and how the sale is split.</li>
      <li><b>Fill.</b> Members put in Credits they own or buy them through the site. The contract checks every Credit against the rules.</li>
      <li><b>Lock.</b> At 80 of 80, a 5 minute countdown starts. If anyone leaves, the clock stops. When it runs out, the union locks for an hour.</li>
      <li><b>Burn.</b> During that hour, anyone can burn the union. If nobody does, it unlocks and members can leave again.</li>
      <li><b>Auction and split.</b> The Statement is auctioned. When the auction ends, the winner gets the Statement and every member is paid.</li>
    </ol>
    <h3>When burning opens</h3>
    <p>Jack’s Statement contract goes live on October 1. Our burn contract follows with a 30 minute public notice onchain, and then every full union starts its countdown. Until then, unions fill but never lock, so you can always leave. Unions don’t expire.</p>`,
  },
  {
    id: 'types',
    title: 'Types of unions',
    body: `<p>Every union takes 80 Credits. The type decides how they’re arranged on the Statement, and that decides how you join.</p>
    <div class="doc-types">${(
      [
        [0, 'Joined', 'In the order they come in.', 'Your Credits or buy'],
        [2, 'Number', 'By Credit number, up or down.', 'Your Credits or buy'],
        [4, 'Painted', 'The creator paints the sheet by a trait, like Colors or Eights. Each spot takes only a Credit that matches.', 'Your Credits or buy'],
        [6, 'Picture', 'The creator uploads an image. The site picks the listed Credits that draw it best.', 'Buy here only'],
      ] as [number, string, string, string][]
    )
      .map(([v, name, how, join]) => `<div class="doc-type">${arrIcon(v)}<div><b>${name}</b><p>${how}</p><span class="doc-join${v === 6 ? ' only' : ''}">${join}</span></div></div>`)
      .join('')}</div>
    <h3>Why Picture unions are buy only</h3>
    <p>Underneath, a Picture union is a Painted union by Colors, and the contract only checks colors. A spot that asks for cyan and black takes any cyan and black Credit, and spots of the same color fill in the order Credits arrive. A picture needs the exact Credit in every spot.</p>
    <p>So the site plans the picture from Credits listed for sale and sells them to you in order, so each lands where it belongs. If a planned Credit sells elsewhere first, the site swaps in the next best listing for that spot. Once a Picture union is full, the site doesn’t offer Withdraw, because taking a Credit out would shift the picture.</p>
    <h3>Limiting who can join</h3>
    <p>Joined, Number and Painted unions can take any Credit, or only ones that match rules the creator sets: Colors, Eights, Print, Weight, Plates, Bits, rating, payment time, a number range, or a list of up to 200 Credits.</p>`,
  },
  {
    id: 'joining',
    title: 'Joining and leaving',
    body: `<h3>With your Credits</h3>
    <p>Connect your wallet, approve Credit Union once, and pick which Credits to put in. The union’s page only offers Credits it will take.</p>
    <h3>By buying</h3>
    <p>Tap the Credits you want on the union’s page. One transaction buys them from OpenSea, CreditStrategy or FWA and puts them in the union in your name. If one sells before your transaction lands, it’s skipped and you get that ETH back. In a Picture union it’s all or nothing: the purchase goes through only if every Credit is still for sale.</p>
    <h3>Starting a union</h3>
    <p>Put in at least one of your own Credits. A Picture union starts with a purchase of its first Credit.</p>
    <h3>Leaving</h3>
    <p>Withdraw your Credits anytime before the union locks.</p>`,
  },
  {
    id: 'auctions',
    title: 'Auctions',
    body: `<p>After a union burns, its Statement goes up for auction onchain. There’s no reserve, and the clock doesn’t start until the first bid.</p>
    <h3>Bidding</h3>
    <p>The first bid is at least 0.01 ETH. Each bid after that must beat the current one by 5% or 0.01 ETH, whichever is more. Anyone can bid, members included. When you’re outbid, your ETH comes back in the same transaction.</p>
    <h3>When it ends</h3>
    <p>The auction ends 24 hours after the first bid. A bid in the last 15 minutes pushes the end to 15 minutes after that bid.</p>
    <p class="doc-note"><b>Example.</b> The first bid is 0.5 ETH at 2:00 pm Monday. The auction will end at 2:00 pm Tuesday, and the next bid must be at least 0.525 ETH. A bid at 1:50 pm Tuesday moves the end to 2:05 pm.</p>
    <h3>Settling</h3>
    <p>When time runs out, anyone can settle it. The Statement goes to the highest bidder, and the sale is paid out to members in the same transaction.</p>`,
  },
  {
    id: 'payouts',
    title: 'Payouts',
    body: `<p>2% of the sale goes to Credit Union. The rest is paid per Credit, not per wallet: 10 Credits in means 10 shares.</p>
    <p>The creator picks the split when opening the union. <b>Equal</b> pays every Credit the same. <b>Early bird</b> pays by the order Credits went in, from 1.5× for the first down to 0.5× for the last.</p>
    ${calculator}
    <h3>Your place in line</h3>
    <p>Early bird counts the order Credits went in, not where they sit on the sheet. If someone ahead of you leaves, everyone behind them moves up one place.</p>
    <h3>Seeing your share</h3>
    <p>A union’s page shows your share once you’re in, and what it’s worth at the current bid during the auction.</p>
    <h3>Getting paid</h3>
    <p>Settling sends every member their share automatically. If your wallet can’t receive it, the share waits in the union and you can claim it from the union’s page.</p>`,
  },
  {
    id: 'fees',
    title: 'Fees',
    body: `<p>Starting and joining a union is free apart from gas. Credit Union takes 2% of a Statement’s sale, only if it sells, and 2% on Credits you buy through the site.</p>`,
  },
  {
    id: 'safety',
    title: 'Safety',
    body: `<p>The contracts hold every Credit and every bid. They have no owner, pause or upgrade, and nobody, us included, can move pooled Credits, bids or payouts.</p>
    <p>The code is open source on <a href="https://github.com/gtmcknight/creditunion" target="_blank" rel="noopener">GitHub</a>, with 264 tests, 51 formally proved rules and seven rounds of internal review. There has been no third-party audit.</p>
    <p>If this site goes down, everything still works from Etherscan: leaving, burning, bidding, settling and claiming.</p>
    <p>Credit Union is independent and not affiliated with Jack Butcher. It’s experimental software; use it at your own risk.</p>`,
  },
  {
    id: 'contracts',
    title: 'Contracts',
    body: `<ul class="doc-addrs">${(
      [
        ['Credit Union factory', config.factory],
        ['Sweeper, for buying', config.sweeper],
        ['Ratings', config.ratings],
        ['Credits, by Jack Butcher', config.credits],
      ] as [string, string | null][]
    )
      .filter(([, a]) => a)
      .map(([k, a]) => {
        const u = explorer('address', a!);
        return `<li>${k}: ${u ? `<a class="mono" href="${esc(u)}" target="_blank" rel="noopener">${short(a!)}</a>` : `<span class="mono">${short(a!)}</span>`}</li>`;
      })
      .join('')}</ul>`,
  },
];

export function docs(app: HTMLElement) {
  const list = sections();
  app.innerHTML = `<section class="home docs-page">
    ${pageHead({ title: 'Docs', lede: 'What Credits and Statements are, and how a Credit Union turns 80 Credits into a Statement and a payout.' })}
    ${basics()}
    <p class="basics-cta"><a class="btn primary" href="/unions">Browse Credit Unions →</a><a class="btn" href="/create">Start your own</a></p>
    <div class="docs">
      <nav class="docs-nav">${list.map((x) => `<a href="#${x.id}">${x.title}</a>`).join('')}</nav>
      <div class="docs-body">${list.map((x) => `<section id="${x.id}" class="doc"><h2>${x.title}</h2>${x.body}</section>`).join('')}</div>
    </div>
  </section>`;
  mountCalculator(app.querySelector<HTMLElement>('#calc')!);
}
