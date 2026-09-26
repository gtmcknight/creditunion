/// <reference types="vite/client" />
import { FIG } from './docs';
import { esc } from '../ui';
import { FAMILY, OPENSEA } from './figures';
import '../lab.css';

type Row = [string, string][];
const now = (id: string): Row => {
  const f = (FIG as Record<string, (() => string) | undefined>)[id];
  return f ? [['Now', f()]] : [];
};
const ROWS: Record<string, () => Row> = {
  // Positions keep their letters (KILLED hides the cut ones).
  lifecycle: () => [['', FAMILY.steps], ['', FAMILY.story], ['', ''], ['', '']],
  eligibility: () => [['', FAMILY.colors], ['', ''], ['', FAMILY.invited], ['', '']],
  order: () => [['', ''], ['', ''], ['', FAMILY.painted], ['', '']],
  buying: () => [['', FAMILY.buy], ['', OPENSEA.sheet], ['', OPENSEA.source], ['', '']],
  exit: () => [['', ''], ['', ''], ['', ''], ['', ''], ['', FAMILY.door], ['', ''], ['', FAMILY.doors]],
  auction: () => [['', FAMILY.paddles], ['', FAMILY.ladder], ['', ''], ['', '']],
};

const CHAPTERS: [string, string, string][] = [
  ['lifecycle', 'Five steps, all onchain', 'Start a party with your Credit. At 80, anyone can burn them into a Statement. It sells at auction and the money is split between the 80, after a 2% fee.'],
  ['eligibility', 'Parties pick who joins', 'By Jack’s traits: Colors, Eights, Print, Weight, payment time or Rating. Or by name, up to 200 Credits. Every deposit is checked onchain.'],
  ['order', 'And the order they burn in', 'Deposit order, mint time, Credit number, or a sheet you paint by Colors, Eights, Print or Weight. It’s the order the 80 go to Jack’s contract.'],
  ['buying', 'No Credit? Buy in', 'Eighty finds the cheapest OpenSea listings that fit, then buys and deposits them in one transaction, for a 2% fee.'],
  ['exit', 'You can always leave', 'Take your Credits back any time before the party fills. A full party locks for 7 days so it can be burned. Not burned by then? Anyone can leave.'],
  ['auction', 'The Statement goes to auction', '24 hours from the first bid. Each bid beats the last by 5%, or 0.01 ETH, whichever is more. A bid in the final 15 minutes adds 15 more. Outbid? Your ETH comes straight back.'],
];

export function lab(app: HTMLElement) {
  // Cut options keep their letters out of the page; the rest keep theirs, so picks stay stable.
  const KILLED = new Set('1c 1d 2b 2d 3a 3b 3d 4b 4c 4d 5b 5c 5d 5f 6c 6d 7a 7b 5a 5g 2a 6b'.split(' '));
  const panels = (row: Row, ch: number) =>
    row
      .map(([, figure], k) => [`${ch}${'abcdefgh'[k]}`, figure] as const)
      .filter(([key]) => !KILLED.has(key))
      .map(([key, figure]) => `<div class="lab-panel"><span class="lab-tag">${key.slice(-1).toUpperCase()}</span>${figure}</div>`)
      .join('');
  app.innerHTML = `<article class="lab">
    <header class="lab-head"><h1>Figure lab</h1><p>Pick one per chapter, like 2A 3C.</p></header>
    ${CHAPTERS.map(([id, title, body], i) => `<section class="lab-chapter" id="${id}">
      <h2><span>${i + 1}</span>${esc(title)}</h2>
      <p>${esc(body)}</p>
      <div class="lab-row">${panels(ROWS[id](), i + 1)}</div>
    </section>`).join('')}
  </article>`;
}
