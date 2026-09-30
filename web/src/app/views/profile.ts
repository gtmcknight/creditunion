import type { Address } from 'viem';
import { batchAbi } from '../abi';
import { config, pub, send, session } from '../chain';
import { listBatches, myCredits, type Listed } from '../data';
import { hydrate, who } from '../ens';
import { fillGhosts } from '../ghosts';
import { errText, esc, eth, pageHead, same, toast } from '../ui';
import { card, drawPictures, mineIn, pictureCards, placeCards } from './lists';
import { creditCell } from './trait';
import { activityItems, activityOf } from './live';

type Due = { b: Listed; claim: bigint; owed: bigint };
/// The site's own sections, as they touch this wallet.
const TABS = ['Unions', 'Auctions', 'Credits', 'Activity'] as const;
type Tab = (typeof TABS)[number];
/// One plain line under each tab saying what it lists, for your own page or someone else's.
const NOTES: Record<Tab, (own: boolean) => string> = {
  Unions: (own) => `Credit Unions ${own ? 'you are' : 'they are'} in.`,
  Auctions: (own) => `Statements from Credit Unions ${own ? 'you were' : 'they were'} in, and auctions ${own ? 'you lead' : 'they lead'}.`,
  Credits: (own) => `Every Credit ${own ? 'you hold' : 'they hold'}: in ${own ? 'your' : 'their'} wallet, and deposited in Credit Unions.`,
  Activity: (own) => `What ${own ? 'you have' : 'they have'} done on Credit Union, newest first.`,
};

/// Your Credits, the batches you're in or opened, and anything you can collect. With `member`, anyone's page:
/// their Credit Unions and Credits, read-only (your own address shows your own page).
export async function profile(app: HTMLElement, rerender: () => void, member?: Address) {
  const own = !member || same(member, session.account);
  const account = own ? session.account : member;
  if (!account) {
    app.innerHTML = `<section class="profile">${pageHead({ title: 'Your Credits', lede: 'Connect to see your Credits and Credit Unions.' })}<button class="btn primary" data-connect>Connect wallet</button></section>`;
    return;
  }

  const [owned, list] = await Promise.all([myCredits(account), listBatches()]);
  const mine = list.filter((b) => mineIn(b, account).size > 0 || same(b.s.creator, account));
  const deposited = mine.reduce((n, b) => n + mineIn(b, account).size, 0);

  // What's collectable: sale shares on settled batches, and refunds whose automatic send failed.
  const dues: Due[] = (
    await Promise.all(
      (own ? mine : []).map(async (b): Promise<Due> => {
        const [claim, owed] = await Promise.all([
          b.s.state === 'Settled'
            ? pub.readContract({ address: b.s.address, abi: batchAbi, functionName: 'claimable', args: [account] })
            : 0n,
          pub.readContract({ address: b.s.address, abi: batchAbi, functionName: 'owed', args: [account] }),
        ]);
        return { b, claim: claim as bigint, owed: owed as bigint };
      }),
    )
  ).filter((d) => d.claim > 0n || d.owed > 0n);

  const dueBox = dues.length
    ? `<section class="box dues-box">
    <h3>Ready to collect</h3>
    <div class="dues">${dues
      .map(
        (d) => `<div class="due">
        <a href="/union/${d.b.s.address}">${esc(d.b.s.name || 'Untitled')}</a>
        <span class="num muted">${d.claim ? `${eth(d.claim)} share` : ''}${d.claim && d.owed ? ' · ' : ''}${d.owed ? `${eth(d.owed)} refund` : ''}</span>
        <button class="btn sm primary" data-collect="${d.b.s.address}" data-claim="${d.claim > 0n}" data-owed="${d.owed > 0n}">Collect</button>
      </div>`,
      )
      .join('')}</div>
  </section>`
    : '';

  app.innerHTML = `
  <section class="profile">
    ${pageHead({
      title: who(account, 'lg'),
      lede: `<span class="mono profile-addr">${account}</span>`,
      label: 'Member',
      tabs: TABS.map((t) => ({ label: `${t} <span class="num muted" id="n-${t.replace(' ', '-')}"></span>`, attrs: `data-tab="${t}"` })),
    })}
    ${dueBox}
    <div id="tab-body"></div>
  </section>`;

  // Tabs: Credit Unions they're in (starting one means depositing into it; one they started and since left stays
  // listed) while they fill; the Statements those became, at auction or sold, and auctions they lead; their
  // Credits, in the wallet and deposited; what they've done.
  const joined = list.filter((b) => mineIn(b, account).size > 0 || same(b.s.creator, account));
  const selling = (b: Listed) => b.s.state === 'Auction' || b.s.state === 'Settled';
  const filling = joined.filter((b) => !selling(b));
  const auctions = list.filter((b) => selling(b) && (joined.includes(b) || same(b.s.highBidder, account)));
  const inUnions = joined.flatMap((b) => [...mineIn(b, account)].map((id) => ({ id: BigInt(id), b })));
  // What they've done, from the site-wide feed; the tab's count fills in when it's read (undefined while it is,
  // null if it couldn't be).
  let activity: Awaited<ReturnType<typeof activityOf>> | undefined;
  const count: Record<Tab, () => number | null> = {
    Unions: () => filling.length,
    Auctions: () => auctions.length,
    Credits: () => owned.length + inUnions.length,
    Activity: () => activity?.length ?? null,
  };
  const grid = (bs: Listed[], empty: string) => (bs.length ? `<div class="grid">${bs.map((b) => card(b)).join('')}</div>` : `<p class="muted">${empty}</p>`);
  // The explorer's tile, as every grid of Credits: art, number; where it sits in a union, on hover.
  const tiles = (xs: { id: bigint; b?: Listed }[]) =>
    `<div class="trait-grid">${xs.map(({ id, b }) => creditCell(Number(id), '', { title: `Credit #${id}${b ? ` · in ${b.s.name || 'Untitled'}` : ''}` })).join('')}</div>`;
  const body: Record<Tab, () => string> = {
    Unions: () => grid(filling, own ? 'You’re not in any Credit Union yet. <a href="/unions">Browse Credit Unions</a>' : 'Not in any Credit Union yet.'),
    Auctions: () => grid(auctions, own ? 'None of your Credit Unions has made a Statement yet.' : 'None of their Credit Unions has made a Statement yet.'),
    Credits: () =>
      `<div class="section-head"><h3>In wallet</h3><span class="muted num">${owned.length || ''}</span></div>${
        owned.length ? tiles([...owned].reverse().map((id) => ({ id }))) : `<p class="muted">None.${own && config.chainId !== 1 ? ' <a href="/mint">Mint test Credits →</a>' : ''}</p>`
      }<div class="section-head"><h3>Deposited</h3><span class="muted num">${inUnions.length || ''}</span></div>${inUnions.length ? tiles(inUnions) : '<p class="muted">None.</p>'}`,
    Activity: () => (activity === undefined ? '<p class="muted">Loading…</p>' : `<ol class="live-list fold-list">${activityItems(activity, { member: true })}</ol>`),
  };
  const at = document.getElementById('tab-body')!;
  let tab: Tab = filling.length || !auctions.length ? 'Unions' : 'Auctions';
  const draw = () => {
    for (const t of TABS) {
      const n = count[t]();
      const el = document.getElementById(`n-${t.replace(' ', '-')}`);
      if (el) el.textContent = n === null ? '' : String(n);
      app.querySelector(`[data-tab="${t}"]`)?.setAttribute('aria-selected', String(t === tab));
    }
    at.innerHTML = `<p class="muted tab-note">${NOTES[tab](own)}</p>${body[tab]()}`;
    hydrate(at);
    drawPictures(at);
    fillGhosts(at);
  };
  app.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach((b) =>
    b.addEventListener('click', () => {
      tab = b.dataset.tab as Tab;
      draw();
    }),
  );
  draw();
  // Layout and picture unions draw as /unions draws them once their placements and saved pictures are read.
  // Always redraw: a second render of this page finds them already read (nothing new), yet drew before they were.
  void Promise.all([placeCards([...filling, ...auctions]), pictureCards([...filling, ...auctions])]).then(() => {
    if (document.getElementById('tab-body') === at) draw();
  });
  void activityOf({ member: account }).then((rows) => {
    activity = rows;
    if (at.isConnected) draw();
  });

  hydrate(app);

  app.querySelectorAll<HTMLButtonElement>('[data-collect]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      const batch = btn.dataset.collect as Address;
      btn.disabled = true;
      btn.textContent = 'Collecting…';
      try {
        if (btn.dataset.claim === 'true')
          await send({ address: batch, abi: batchAbi, functionName: 'claim', args: [account] });
        if (btn.dataset.owed === 'true') await send({ address: batch, abi: batchAbi, functionName: 'withdrawOwed' });
        toast('Collected.', 'ok');
        rerender();
      } catch (e) {
        toast(errText(e), 'err', 8000);
        btn.disabled = false;
        btn.textContent = 'Collect';
      }
    }),
  );
}
