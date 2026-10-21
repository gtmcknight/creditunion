/// Make a Statement yourself (/make): burn 80 of your Credits into one Statement you keep, through Jack's Statements
/// contract's own compose. No Credit Union, no auction. Cells run in the order you picked them; it's made in the
/// Consolidated format, as a union's Joined layout is. Two confirmations the first time (let Statements take your
/// Credits, then make it), one after.
import { parseAbi } from 'viem';
import { go as navigate } from '../main';
import { creditsAbi } from '../abi';
import { config, pub, send, session } from '../chain';
import { myCredits, type Summary } from '../data';
import { editionArt, examples } from '../ghosts';
import { art, errText, sheet, toast } from '../ui';

const STATEMENTS_ABI = parseAbi(['function compose(uint256[80] creditIds, uint8 format) returns (uint256)', 'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)']);
const CONSOLIDATED = 1;
const N = 80;

/// Faint example Credits for the cells not picked yet, read once.
let sample: Promise<number[]> | null = null;
const ghostsFor = (n: number, ids: number[]) => ids.slice(0, N - n).map((id) => ({ id: BigInt(id), src: editionArt(id) }));

export async function make(app: HTMLElement) {
  sample ??= examples({ palettes: 0, prints: 0, weights: 0, eights: 0, idFrom: 0n, idTo: 0n, minScore: 0, maxScore: 0 } as Summary['filter']).catch(() => []);
  const fillGhosts = (picked: readonly bigint[]) =>
    void sample!.then((ids) => {
      const el = app.querySelector('#preview');
      if (el) el.innerHTML = sheet(picked, { ghosts: ghostsFor(picked.length, ids) });
    });
  const head = `<header class="create-head"><h1>Make a Statement</h1><p class="create-lede">Burn 80 of your Credits into one Statement you keep. No auction, nobody else in it. <a href="/docs#how">How it works →</a></p></header>`;
  const account = session.account;
  const statements = config.statements;
  if (!statements) {
    app.innerHTML = `${head}<p class="muted">Statements aren’t on this network.</p>`;
    return;
  }
  // The page as it will be: the preview, your Credits to pick from, and one button for what comes next.
  const page = (picker: string, button: string, why = '') => `${head}
  <section class="design">
    <div class="design-preview"><div id="preview">${sheet([])}</div></div>
    <div class="design-form">
      ${picker}
      <p class="heads-up"><strong>This burns the 80 for good.</strong> You get one Statement, in your wallet, laid out in the order you picked.</p>
      ${button}
      <p class="hint" id="make-why">${why}</p>
    </div>
  </section>`;
  if (!account) {
    app.innerHTML = page('<div class="make-head"><h3>Your Credits</h3></div><p class="muted make-empty">Connect to see yours.</p>', '<button type="button" class="btn primary block" data-connect>Connect to make a Statement</button>');
    fillGhosts([]);
    return;
  }
  app.innerHTML = `${head}<p class="muted">Reading your Credits…</p>`;
  const [held, approved, code] = await Promise.all([
    myCredits(account) as Promise<readonly bigint[]>,
    pub.readContract({ address: config.credits, abi: creditsAbi, functionName: 'isApprovedForAll', args: [account, statements] }) as Promise<boolean>,
    // Asked of the wallet: the site's RPC doesn't serve eth_getCode.
    (session.provider?.request({ method: 'eth_getCode', params: [account, 'latest'] }) as Promise<string> | undefined)?.catch(() => '0x') ?? '0x',
  ]);
  if (session.account !== account) return; // switched wallets meanwhile: the page draws again
  // A contract wallet (a Safe) can't make one; a regular wallet upgraded under EIP-7702 (its code is just the
  // 0xef0100 pointer to its delegate) can.
  if (code && code !== '0x' && !code.toLowerCase().startsWith('0xef0100')) {
    app.innerHTML = `${head}<p class="muted">Making a Statement needs a regular wallet. This one is a contract wallet.</p>`;
    return;
  }
  // Short of 80: the same page with yours in it, and the button goes to buy the rest.
  const short = Math.max(0, N - held.length);
  let allowed = approved;
  const picks: bigint[] = []; // in the order picked: cell 1 first
  app.innerHTML = page(
    `<div class="make-head"><h3>Your Credits <span class="muted num" id="make-n">0 of 80</span></h3>${held.length ? `<button type="button" class="link" id="make-fill">${short ? `Pick all ${held.length}` : 'Pick the first 80'}</button>` : ''}</div>
      ${held.length ? `<div class="picker make-picker" id="make-picker">${held.map((id) => `<button type="button" class="pick" data-id="${id}" aria-pressed="false" aria-label="Credit #${id}" title="Credit #${id}"><img src="${art(id)}" alt="" loading="lazy"></button>`).join('')}</div>` : '<p class="muted make-empty">You don’t hold any Credits yet.</p>'}`,
    short ? `<a class="btn primary block" href="/credits">Buy ${short} more ${short === 1 ? 'Credit' : 'Credits'}</a>` : '<button type="button" class="btn primary block" id="make-go" disabled>Pick 80 Credits</button>',
    short ? `A Statement takes 80. You hold ${held.length}.` : allowed ? 'One confirmation.' : 'Two confirmations: let Statements take your Credits, then make it.',
  );
  if (short && !held.length) return fillGhosts([]);
  const grid = app.querySelector<HTMLElement>('#make-picker')!;
  const go = app.querySelector<HTMLButtonElement>('#make-go'); // none while short of 80: the button buys
  const fill = app.querySelector<HTMLButtonElement>('#make-fill')!;
  const draw = () => {
    const on = new Set(picks.map(String));
    grid.querySelectorAll<HTMLElement>('.pick').forEach((b) => b.setAttribute('aria-pressed', String(on.has(b.dataset.id!))));
    app.querySelector('#make-n')!.textContent = `${picks.length} of 80`;
    fillGhosts(picks);
    fill.textContent = picks.length ? 'Clear' : short ? `Pick all ${held.length}` : 'Pick the first 80';
    if (!go) return;
    go.disabled = picks.length !== N;
    go.textContent = picks.length === N ? 'Make Statement' : `Pick ${N - picks.length} more`;
  };
  grid.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('.pick');
    if (!b) return;
    const id = BigInt(b.dataset.id!);
    const i = picks.indexOf(id);
    if (i >= 0) picks.splice(i, 1);
    else if (picks.length < N) picks.push(id);
    else return toast('80 is a full Statement. Drop one to swap it.', 'info');
    draw();
  });
  fill.addEventListener('click', () => {
    if (picks.length) picks.length = 0;
    else picks.push(...held.slice(0, N));
    draw();
  });
  go?.addEventListener('click', async () => {
    if (!go) return;
    if (picks.length !== N) return;
    go.disabled = true;
    try {
      if (!allowed) {
        go.textContent = 'Allow in your wallet (1 of 2)…';
        await send({ address: config.credits, abi: creditsAbi, functionName: 'setApprovalForAll', args: [statements, true] });
        allowed = true;
      }
      go.textContent = allowed && !approved ? 'Make it in your wallet (2 of 2)…' : 'Confirm in your wallet…';
      const receipt = await send({ address: statements, abi: STATEMENTS_ABI, functionName: 'compose', args: [picks as unknown as readonly bigint[] & { length: 80 }, CONSOLIDATED] }, () => (go.textContent = 'Making your Statement…'));
      // The new Statement: the mint (from zero) to you in this transaction.
      const minted = receipt.logs.find((l) => l.address.toLowerCase() === statements.toLowerCase() && l.topics.length === 4 && BigInt(l.topics[1]!) === 0n);
      toast('Your Statement is made.', 'ok');
      navigate(minted ? `/statement/${BigInt(minted.topics[3]!)}` : `/member/${account}`);
    } catch (e) {
      toast(errText(e), 'err');
      go.disabled = false;
      draw();
    }
  });
  draw();
}

