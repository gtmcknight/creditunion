import { sheet, art } from '../ui';
import { SHEET } from './docs';

/// /balance before it opens: the real page's shape (the next Statement filling on the left, your Credits in and
/// BALANCE out on the right) with nothing live in it. Says what it will do; nothing to press. The real page
/// replaces this under the same path.
export function balance(app: HTMLElement) {
  const ghosts = SHEET.map((id) => ({ id, src: art(id) }));
  const picks = SHEET.slice(0, 16).map((id) => `<button type="button" class="pick" disabled tabindex="-1" aria-hidden="true"><img src="${art(id)}" alt="" loading="lazy" decoding="async"></button>`).join('');
  app.innerHTML = `
  <section class="tokens balance-soon">
    <header class="create-head">
      <h1>Credits in. Balance out.</h1>
      <p class="create-lede">Pool 80 Credits with other holders, burn them into a Statement, and split the Balance by rating. Opens when Balance does.</p>
    </header>
    <section class="design" inert>
      <div class="design-preview">
        <div id="preview">${sheet([], { ghosts })}</div>
        <div class="legend muted small"><span>The next Statement</span><span class="num">0 of 80</span></div>
      </div>
      <form class="design-form" novalidate>
        <h2 class="form-title">Your Credits</h2>
        <section class="rule">
          <p class="term-desc">Pick the ones to convert.</p>
          <div class="picker static">${picks}</div>
        </section>
        <h2 class="form-title">You get</h2>
        <section class="rule">
          <div class="bal-get"><span class="muted">≈</span><span class="num bal-out">0</span><span>BALANCE</span></div>
          <p class="term-desc">Paid by the rating you put in, when the Statement burns.</p>
        </section>
        <div class="submit"><button type="button" class="btn primary block" disabled>Opens when Balance does</button></div>
      </form>
    </section>
  </section>`;
}
