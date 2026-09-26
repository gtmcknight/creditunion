import { go as navigate } from '../main';
import type { Address } from 'viem';
import { batchAbi } from '../abi';
import { config, disconnect, explorer, pub, send, session } from '../chain';
import { listBatches, myCredits, type Listed } from '../data';
import { hydrate, who } from '../ens';
import { fillGhosts } from '../ghosts';
import { art, errText, esc, eth, same, toast } from '../ui';
import { card, mineIn } from './home';

type Due = { b: Listed; claim: bigint; owed: bigint };

/// Your Credits, the batches you're in or opened, and anything you can collect.
export async function profile(app: HTMLElement, rerender: () => void) {
  const account = session.account;
  if (!account) {
    app.innerHTML = `<section class="narrow"><h1>Your Eighty</h1><p class="lede">Connect to see your Credits and parties.</p><button class="btn primary" data-connect>Connect wallet</button></section>`;
    return;
  }

  const [owned, list] = await Promise.all([myCredits(account), listBatches()]);
  const mine = list.filter((b) => mineIn(b).size > 0 || same(b.s.creator, account));
  const deposited = mine.reduce((n, b) => n + mineIn(b).size, 0);

  // What's collectable: sale shares on settled batches, and refunds whose automatic send failed.
  const dues: Due[] = (
    await Promise.all(
      mine.map(async (b): Promise<Due> => {
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
  const total = dues.reduce((a, d) => a + d.claim + d.owed, 0n);
  const ex = explorer('address', account);

  app.innerHTML = `
  <section class="profile">
    <header class="profile-head">
      ${who(account, 'lg')}
      <div class="actions">${ex ? `<a class="btn sm" href="${ex}" target="_blank" rel="noopener">Explorer ↗</a>` : ''}<button class="btn sm" id="disconnect">Disconnect</button></div>
    </header>
    <dl class="stats">
      <div><dt>In your wallet</dt><dd class="num">${owned.length}</dd></div>
      <div><dt>In parties</dt><dd class="num">${deposited}</dd></div>
      <div><dt>To collect</dt><dd class="num">${total ? eth(total) : '0'}</dd></div>
    </dl>
  </section>

  ${
    dues.length
      ? `<section class="box">
    <h3>Ready to collect</h3>
    <div class="dues">${dues
      .map(
        (d) => `<div class="due">
        <a href="/party/${d.b.s.address}">${esc(d.b.s.name || 'Untitled')}</a>
        <span class="num muted">${d.claim ? `${eth(d.claim)} share` : ''}${d.claim && d.owed ? ' · ' : ''}${d.owed ? `${eth(d.owed)} refund` : ''}</span>
        <button class="btn sm primary" data-collect="${d.b.s.address}" data-claim="${d.claim > 0n}" data-owed="${d.owed > 0n}">Collect</button>
      </div>`,
      )
      .join('')}</div>
  </section>`
      : ''
  }

  <section>
    <div class="section-head"><h2>Your parties</h2><span class="muted">${mine.length || ''}</span></div>
    <div class="grid">${
      mine.length
        ? mine.map((b) => card(b)).join('')
        : `<div class="empty-state"><p>You're not in any party yet.</p><div class="actions"><a class="btn primary" href="/parties">Browse parties</a><a class="btn" href="/create">Open one</a></div></div>`
    }</div>
  </section>

  <section>
    <div class="section-head"><h2>In your wallet</h2><span class="muted">${owned.length || ''}</span></div>
    ${
      owned.length
        ? `<div class="picker lg static wallet-grid">${[...owned]
            .reverse()
            .map((id) => `<span class="pick" title="Credit #${id}"><img src="${art(id)}" alt="Credit #${id}" loading="lazy"></span>`)
            .join('')}</div>`
        : `<p class="muted">No Credits here.${config.chainId !== 1 ? ' <a href="/mint">Mint test Credits →</a>' : ''}</p>`
    }
  </section>`;

  hydrate(app);
  fillGhosts(app);
  document.getElementById('disconnect')?.addEventListener('click', () => {
    disconnect();
    navigate('/');
  });
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
