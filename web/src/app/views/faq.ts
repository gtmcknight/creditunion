import { pageHead } from '../ui';

/// /faq: the questions, on their own page (they used to sit at the bottom of the homepage).
const QA: [string, string][] = [
  ['When can Credit Unions burn into Statements?', 'Jack’s Statement contract goes live October 1 (<a href="https://x.com/jackbutcher/status/2102910106451021935" target="_blank" rel="noopener">Jack’s announcement</a>). Then we build our burn contract, test it, and launch it with a 35 minute warning. Full unions (80/80) lock and burn when the warning ends. A union that hits 80/80 after that gets 5 minutes to leave, then burns. Until a union locks, anyone can leave it.'],
  ['Is Credit Union official?', 'No. It’s an independent project built on Jack Butcher’s Credits.'],
  ['What does it cost?', 'Free to start or join. Credit Union takes 2% of the sale, only if it sells, and 2% on Credits you buy from OpenSea through Credit Union.'],
  ['What if a Credit Union never fills?', 'Nothing. Take your Credits back whenever you want.'],
  ['How does the auction work?', 'No reserve, and anyone can bid, members too. The 24 hour clock starts with the first bid. Every bid beats the last by at least 5%, and a bid in the last 15 minutes adds 15 minutes. If you’re outbid, your ETH comes back in the same transaction.'],
  ['What if nobody bids?', 'The Statement stays in the Credit Union until someone bids at least 0.01 ETH. The 24 hours start with that bid.'],
  ['How is the money split?', 'A 2% fee comes off the sale, and the rest goes to the 80 Credits that made the Statement. Equal pays every Credit the same. Early bird pays the first Credit in 1.5× and the last 0.5×.'],
  ['How do I get paid?', 'Automatically. When the auction settles, every member’s share is sent in the same transaction. If your wallet can’t receive it, claim it on the Credit Union’s page.'],
  ['What if nobody burns it?', 'We burn every full union within minutes of it locking. If one still isn’t burned within the hour, it unlocks: leave, or restart the countdown.'],
];

export function faq(app: HTMLElement) {
  app.innerHTML = `<section class="home faq-page">
    ${pageHead({ title: 'Questions' })}
    <div class="faq">${QA.map(([q, a]) => `<details><summary>${q}</summary><p>${a}</p></details>`).join('')}</div>
  </section>`;
}
