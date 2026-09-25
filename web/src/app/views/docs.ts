import { chain, config, explorer } from '../chain';
import { esc, short } from '../ui';

const REPO = 'https://github.com/lucibotnyc/eighty';
const CREDITS_MAINNET = '0x97630aA70AB14ed9883B41dAfccBc11349723043';
const SEAPORT = '0x0000000000000068F116a894984e2DB1123eB395';

type Section = { id: string; title: string; body: string };

const link = (href: string, text: string) => `<a href="${esc(href)}" target="_blank" rel="noopener">${esc(text)} ↗</a>`;
const addr = (a: string, label: string) => {
  const u = explorer('address', a);
  return `<span class="addr"><span>${esc(label)}</span>${u ? `<a class="mono" href="${u}" target="_blank" rel="noopener">${short(a)} ↗</a>` : `<span class="mono">${short(a)}</span>`}</span>`;
};
const src = (path: string) => link(`${REPO}/blob/main/${path}`, path.split('/').pop()!);
const rules = (rows: [string, string][]) =>
  `<dl class="rules">${rows.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('')}</dl>`;

export function docs(app: HTMLElement) {
  const testnet = config.chainId !== 1;
  const sections: Section[] = [
    {
      id: 'idea',
      title: 'The idea',
      body: `<p>Jack Butcher’s ${link('https://jack.art/credits', 'Credits')} burn 80 at a time into a Statement, at most 1,526 of them, and the burn needs all 80 in one wallet. Most holders have one Credit. Eighty is that wallet: a small contract per batch that nobody controls. It holds the Credits, burns them together, auctions the Statement onchain, and splits the sale 80 ways.</p>
      <p>There is no account, no database and no admin key. Everything you see on this site is read straight from the chain, and every action is a transaction you sign yourself.</p>`,
    },
    {
      id: 'lifecycle',
      title: 'Life of a batch',
      body: rules([
        ['Open', 'Anyone holding at least 10 Credits opens a batch with them and names it. At open they fix, forever: who may join (§ Eligibility), the order on the Statement (§ Order), their own fee (0–10 %), an optional reserve, and a deadline of 3–90 days.'],
        ['Deposit', 'Approve the Eighty factory once, then add any number of Credits (up to 40 per transaction). Or send a single Credit straight to the batch with <code>safeTransferFrom</code>; no approval needed. Deposits record who put in what.'],
        ['Withdraw', 'Until the batch holds 80, every depositor can take their Credits back at any time. No fee, no penalty, no permission.'],
        ['Lock', 'The 80th deposit locks the batch. Nobody can add or withdraw. The deadline moves to at least 7 days out so there is time to burn.'],
        ['Burn', 'Anyone can burn a full batch (the caller pays the gas, roughly 4–7 M). The batch approves the adapter for exactly that call, then checks that all 80 Credits are gone and that it now owns the Statement, or the whole transaction reverts.'],
        ['Auction', 'The Statement is sold by a 24-hour auction that starts at the first bid (§ Auction).'],
        ['Split', 'Anyone settles when the clock runs out. The Statement goes to the winner; the protocol fee and the creator’s fee come off the top; each Credit that went in claims 1/80 of the rest.'],
        ['Expire', 'If a batch is not burned by its deadline (never filled, or Statements sold out), everyone withdraws their Credits. Nothing is ever stuck.'],
      ]),
    },
    {
      id: 'eligibility',
      title: 'Eligibility',
      body: `<p>Who may join is set when the batch opens and enforced by the contract on every deposit. Rules combine.</p>` +
        rules([
          ['Traits', 'One required value for any of Colors, Print, Weight or Eights, read from Jack’s own art contract onchain, so a filter can never be fooled.'],
          ['Payment window', 'Only Credits paid for between two moments, e.g. a single minute of the mint.'],
          ['Credit numbers', 'Only Credits in a numeric range.'],
          ['A list', 'Only specific Credits, up to 200 numbers, stored in the batch.'],
          ['Rating', 'Every batch shows its Credits’ official ratings (§ Ratings), and the arranger can sort by them, but a batch cannot filter by rating: the rating is a rank over the whole edition, which a contract cannot recompute.'],
        ]),
    },
    {
      id: 'order',
      title: 'Order on the Statement',
      body: `<p>The Statement is an 8 × 10 sheet, and its order may matter to Jack’s contract. The creator chooses at open:</p>` +
        rules([
          ['Deposit order', 'As deposited. The default.'],
          ['Mint time', 'Sorted by when each Credit was paid for, earliest first.'],
          ['Credit number', 'Sorted by number, lowest first.'],
          ['Creator’s order', 'Once the batch is full, the creator arranges the sheet: by rating, mint time or number, or by tapping two Credits to swap them, then burns with that exact order. The contract checks the order is precisely the 80 pooled Credits. If the creator has not burned within one day of filling, anyone can burn in deposit order, so a creator cannot stall.'],
        ]) +
        `<p class="muted">Mint-time and number sorting happen in the adapter, which also receives the chosen arrangement, so whatever Jack’s contract expects can be handled there without touching batches.</p>`,
    },
    {
      id: 'auction',
      title: 'Auction',
      body: rules([
        ['Clock', '24 hours, starting at the first bid. There is no clock before that.'],
        ['Reserve', 'If the creator set one, it is the minimum first bid for 7 days after the burn. After that any amount starts the auction.'],
        ['Raises', 'Each bid must beat the last by 5 %, and by at least 0.01 ETH.'],
        ['Anti-snipe', 'A bid in the last 15 minutes moves the end to 15 minutes after it.'],
        ['Refunds', 'When you are outbid, your ETH comes back in the same transaction. If your wallet cannot receive it (a contract that reverts), it is held for you to collect.'],
        ['Settle', 'Anyone can settle after the clock ends. If the Statement contract refuses the transfer to the winner, the winner collects it themselves.'],
        ['Why no proxy bids', 'On a public chain your maximum would be visible, so a rival could bid just under it. Every bid is the full amount, escrowed, and returned the moment you are outbid.'],
      ]),
    },
    {
      id: 'fees',
      title: 'Fees',
      body: rules([
        ['Creator', '0–10 % of the sale, chosen when the batch opens, shown on every card and page, fixed forever.'],
        ['Protocol', '1 % of the sale, fixed when the contracts were deployed. The contracts refuse any deploy above 5 %.'],
        ['Buy-in', '1 % on Credits bought through OpenSea (§ Buying in), also fixed at deploy, same 5 % ceiling.'],
        ['Example', 'A 3 ETH sale with a 2 % creator fee: 0.03 ETH protocol, 0.06 ETH creator, 0.036375 ETH per Credit. Rounding dust goes to the protocol fee, so the split is always exact.'],
      ]),
    },
    {
      id: 'ratings',
      title: 'Ratings',
      body: `<p>Ratings on this site are ${link('https://jack.art/credits/rating', 'Jack Butcher’s official Credit rating')}, methodology v3.4.0, reproduced from his published formula and his MIT-licensed art contracts over the frozen edition of 122,154 Credits, and verified to match his page exactly, score and rank.</p>
      <p>For each of five traits (palette, active bits, occupied cells, eights, registration) take the share of the edition whose value is as rare or rarer; average the negative logs with eights counted double; rank every Credit; score 80–800 from the rank. Batch pages show the average and the top rating of the sheet, and each Credit’s score and rank in its tooltip.</p>`,
    },
    {
      id: 'buying',
      title: 'Buying in from OpenSea',
      body: `<p>No Credits? On an open batch, pick how many and get a price. The site finds the cheapest OpenSea listings that fit the batch’s rules, checks onchain that each seller still owns and has approved the Credit, and prepares one transaction that buys them through Seaport and deposits them in your name. They are yours in the batch exactly as if you had deposited them: you can withdraw them until it locks.</p>
      <p>You pay the listings plus the buy-in fee; anything unspent comes straight back. A listing that sold moments before is skipped and refunded. Listings already include Jack’s 1 % royalty, as on OpenSea.</p>`,
    },
    {
      id: 'launch',
      title: 'Before Jack’s Statement contract exists',
      body: `<p>Jack’s Statement contract is not published yet, so the adapter that burns through it cannot be written. Batches can still open, fill and lock: pooling only.</p>` +
        rules([
          ['Propose', 'One address, the setter, proposes the adapter once it exists and has been reviewed.'],
          ['Exit window', 'A proposal opens a 3-day window in which anyone can withdraw from any batch, full ones included. If you do not like the adapter, leave.'],
          ['Activate', 'After 3 days anyone activates it, permanently. The setter has no other power and none at all afterwards. Full batches get a fresh 7 days to burn.'],
        ]) +
        (testnet
          ? `<p class="muted">This deployment (${esc(chain.name)}) is a test preview: the Credits here are test mints with the real art, and the adapter proposed here targets a mock Statement.</p>`
          : ''),
    },
    {
      id: 'trust',
      title: 'What you are trusting',
      body: rules([
        ['Nobody', 'No owner, no admin, no pause, no upgrade. Every rule is in the contracts and every parameter is fixed at deploy, except the one-time adapter activation described above.'],
        ['The factory', 'The only contract you approve. It can move Credits only from the person calling it, only into a batch it created.'],
        ['The adapter', 'Holds operator rights over a batch’s Credits for the duration of one burn call, and its result is verified. It is called, never delegatecalled, so nothing it does can reach a batch’s state.'],
        ['Reviews', `Static analysis, three independent adversarial reviews, invariant fuzzing (128,000 random calls per run) and tests against the real Seaport and Credits contracts on a mainnet fork. Every finding and fix is recorded in ${src('contracts/AUDIT.md')}. An independent audit is planned before mainnet.`],
      ]),
    },
    {
      id: 'contracts',
      title: 'Contracts',
      body: `<div class="addrs">
        ${addr(config.factory, 'BatchFactory')}
        ${addr(config.credits, testnet ? 'Test Credits' : 'Credits')}
        ${config.sweeper ? addr(config.sweeper, 'Sweeper') : ''}
        <span class="addr"><span>Network</span><span>${esc(chain.name)}</span></span>
      </div>
      <p class="muted small">Batches are minimal clones of one implementation; each batch page links to its own address.</p>
      ${rules([
        ['Source', `${src('contracts/src/Batch.sol')} · ${src('contracts/src/BatchFactory.sol')} · ${src('contracts/src/Sweeper.sol')} · ${src('contracts/src/interfaces/IAssembler.sol')} · ${link(REPO, 'repository')}`],
        ['Jack’s', `${link(`https://etherscan.io/address/${CREDITS_MAINNET}`, 'Credits on Ethereum')} · ${link('https://jack.art/credits', 'jack.art/credits')} · ${link('https://opensea.io/collection/credits', 'OpenSea')}`],
        ['Seaport 1.6', link(`https://etherscan.io/address/${SEAPORT}`, short(SEAPORT))],
        ['Site', `Cloudflare Worker with no state: a read-only RPC proxy to these contracts, cached Credit art, ENS names, OpenSea quotes and ratings. ${src('web/src/worker/index.ts')}`],
      ])}`,
    },
  ];

  app.innerHTML = `
  <section class="docs">
    <aside class="toc"><nav aria-label="On this page">${sections.map((s) => `<a href="#/docs/${s.id}" data-toc="${s.id}">${esc(s.title)}</a>`).join('')}</nav></aside>
    <div class="prose docs-body">
      <h1>Docs</h1>
      <p class="lede">How Eighty works, rule by rule, and what you are trusting when you use it.</p>
      ${sections.map((s) => `<section id="doc-${s.id}"><h2>${esc(s.title)}</h2>${s.body}</section>`).join('')}
      <p class="muted small">Eighty is independent and not affiliated with Jack Butcher.</p>
    </div>
  </section>`;

  // Deep link: #/docs/<section>
  const target = location.hash.split('/')[2];
  if (target) requestAnimationFrame(() => document.getElementById(`doc-${target}`)?.scrollIntoView({ block: 'start' }));
  const links = [...app.querySelectorAll<HTMLAnchorElement>('[data-toc]')];
  const heads = sections.map((s) => document.getElementById(`doc-${s.id}`)!);
  const io = new IntersectionObserver(
    (entries) => {
      const visible = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
      if (!visible) return;
      links.forEach((l) => l.classList.toggle('current', `doc-${l.dataset.toc}` === visible.target.id));
    },
    { rootMargin: '-80px 0px -70% 0px' },
  );
  heads.forEach((h) => io.observe(h));
}
