import { decodeEventLog, parseEther } from 'viem';
import { creditsAbi, factoryAbi } from '../abi';
import { config, send, session } from '../chain';
import { isApproved, minOpen, myCredits, protocolFeeBps } from '../data';
import { hashTrait, LABEL, TRAITS, type TraitKey } from '../traits';
import { $$, art, errText, esc, toast } from '../ui';

const CHUNK = 40;
const fmt = (n: number) => n.toFixed(4).replace(/\.?0+$/, '');
const DURATIONS = [7, 14, 30, 60, 90];

export async function create(app: HTMLElement) {
  if (!session.account) {
    app.innerHTML = `<a class="back" href="#/">← Batches</a>
    <section class="narrow"><h1>Open a batch</h1><p class="lede">Start with 10 or more. Anyone can leave until 80.</p>
    <button class="btn primary" data-connect>Connect wallet</button></section>`;
    return;
  }

  const [owned, approved, min, protocolBps] = await Promise.all([
    myCredits(session.account),
    isApproved(session.account),
    minOpen(),
    protocolFeeBps(),
  ]);
  const picks = new Set<string>();
  const filter: Record<TraitKey, string> = { colors: '', print: '', weight: '', eights: '' };

  app.innerHTML = `<a class="back" href="#/">← Batches</a>
  <section class="narrow">
    <h1>Open a batch</h1>
    <p class="lede">Start with ${min} or more. Anyone can leave until 80.</p>
    <form id="create" class="form" novalidate>
      <label class="field-row"><span class="label">Name</span><input id="name" maxlength="64" placeholder="e.g. All Cyan" autocomplete="off"></label>

      <div class="field-row" role="group" aria-label="Only accept"><span class="label">Only accept</span><div>
        <div class="selects">${(Object.keys(TRAITS) as TraitKey[])
          .map((k) => `<label class="select"><span>${LABEL[k]}</span><select data-trait="${k}"><option value="">Any</option>${TRAITS[k].map((v) => `<option>${esc(v)}</option>`).join('')}</select></label>`)
          .join('')}</div>
        <p class="hint">Optional. Enforced onchain.</p>
      </div></div>

      <label class="field-row"><span class="label">Your fee</span><div><div class="field"><input id="cfee" inputmode="decimal" placeholder="0" autocomplete="off"><span>%</span></div><p class="hint" id="cfee-hint">Your cut of the sale, 0–10%. Fixed forever and shown to everyone before they join.</p></div></label>

      <label class="field-row"><span class="label">Reserve</span><div><div class="field"><input id="reserve" inputmode="decimal" placeholder="0" autocomplete="off"><span>ETH</span></div><p class="hint">Minimum first bid. Lapses 7 days after the burn.</p></div></label>

      <div class="field-row" role="radiogroup" aria-label="Deadline"><span class="label">Deadline</span>
        <div><div class="seg">${DURATIONS.map((d) => `<label><input type="radio" name="dur" value="${d}" ${d === 30 ? 'checked' : ''}><span>${d}d</span></label>`).join('')}</div>
        <p class="hint">Unburned by then, everyone withdraws.</p></div>
      </div>

      <div class="field-row" role="group" aria-label="Your Credits"><span class="label">Your Credits</span>
        <div>
          <div class="box-head"><span class="muted small num" id="n"></span><button type="button" class="link small" id="all">Select all that fit</button></div>
          <div class="picker lg" id="picker">${
            owned.length
              ? owned.map((id) => `<button type="button" class="pick" data-id="${id}" aria-pressed="false" title="Credit #${id}"><img src="${art(id)}" alt="Credit #${id}" loading="lazy"></button>`).join('')
              : `<p class="muted">You don’t hold any Credits.</p>`
          }</div>
        </div>
      </div>

      <div class="submit">
        ${approved ? '' : `<button type="button" class="btn primary" id="approve">Approve Eighty · once</button>`}
        <button class="btn primary" id="go" disabled ${approved ? '' : 'hidden'}>Open batch</button>
        <p class="hint" id="why"></p>
      </div>
    </form>
  </section>`;

  const go = document.getElementById('go') as HTMLButtonElement;
  const why = document.getElementById('why')!;
  let isOk = approved;

  const draw = () => {
    $$<HTMLButtonElement>('.pick', app).forEach((p) => p.setAttribute('aria-pressed', String(picks.has(p.dataset.id!))));
    document.getElementById('n')!.textContent = picks.size ? `${picks.size} selected` : `Min ${min}`;
    const n = picks.size;
    const reason = !isOk ? 'Approve first.' : n < min ? `Select at least ${min}.` : n > 80 ? 'At most 80.' : '';
    why.textContent = reason || (n > CHUNK ? `${Math.ceil(n / CHUNK)} transactions: open with ${CHUNK}, then deposit the rest.` : '');
    go.disabled = !!reason;
  };
  draw();

  document.getElementById('picker')!.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('.pick');
    if (!b) return;
    picks.has(b.dataset.id!) ? picks.delete(b.dataset.id!) : picks.add(b.dataset.id!);
    draw();
  });
  document.getElementById('all')!.addEventListener('click', () => {
    owned.slice(0, 80).forEach((id) => picks.add(id.toString()));
    draw();
  });
  const cfee = document.getElementById('cfee') as HTMLInputElement;
  const feeBps = () => {
    const v = cfee.value.trim();
    if (!v) return 0;
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 && n <= 10 ? Math.round(n * 100) : NaN;
  };
  cfee.addEventListener('input', () => {
    const bps = feeBps();
    const hint = document.getElementById('cfee-hint')!;
    if (Number.isNaN(bps)) hint.textContent = 'Between 0 and 10.';
    else if (!bps) hint.textContent = 'Your cut of the sale, 0–10%. Fixed forever and shown to everyone before they join.';
    else {
      const you = (3 * bps) / 10_000;
      const per = (3 * (1 - (protocolBps + bps) / 10_000)) / 80;
      hint.textContent = `On a 3 ETH sale: ${fmt(you)} ETH to you, ${fmt(per)} ETH per Credit.`;
    }
  });

  $$<HTMLSelectElement>('select[data-trait]', app).forEach((s) =>
    s.addEventListener('change', () => (filter[s.dataset.trait as TraitKey] = s.value)),
  );

  document.getElementById('approve')?.addEventListener('click', async (e) => {
    const b = e.currentTarget as HTMLButtonElement;
    b.disabled = true;
    b.textContent = 'Approving…';
    try {
      await send({ address: config.credits, abi: creditsAbi, functionName: 'setApprovalForAll', args: [config.factory, true] });
      isOk = true;
      b.remove();
      go.hidden = false;
      draw();
    } catch (x) {
      toast(errText(x), 'err');
      b.disabled = false;
      b.textContent = 'Approve Eighty · once';
    }
  });

  document.getElementById('create')!.addEventListener('submit', async (e) => {
    e.preventDefault();
    let reserve = 0n;
    try {
      reserve = parseEther((document.getElementById('reserve') as HTMLInputElement).value.trim() || '0');
    } catch {
      return toast('Reserve must be an ETH amount.', 'err');
    }
    const bps = feeBps();
    if (Number.isNaN(bps)) return toast('Your fee must be between 0 and 10%.', 'err');
    const name = (document.getElementById('name') as HTMLInputElement).value.trim();
    const days = Number((app.querySelector('input[name=dur]:checked') as HTMLInputElement).value);
    const ids = [...picks].map(BigInt);
    const f = {
      colors: hashTrait(filter.colors),
      print: hashTrait(filter.print),
      weight: hashTrait(filter.weight),
      eights: hashTrait(filter.eights),
    };
    go.disabled = true;
    go.textContent = 'Opening…';
    try {
      const receipt = await send({
        address: config.factory,
        abi: factoryAbi,
        functionName: 'create',
        args: [name, f, reserve, BigInt(bps), BigInt(days * 86400), ids.slice(0, CHUNK)],
      });
      const ev = receipt.logs
        .map((l) => {
          try {
            return decodeEventLog({ abi: factoryAbi, ...l });
          } catch {
            return null;
          }
        })
        .find((x) => x?.eventName === 'BatchCreated');
      const batch = (ev?.args as { batch: `0x${string}` }).batch;
      for (let i = CHUNK; i < ids.length; i += CHUNK) {
        go.textContent = `Depositing ${i}–${Math.min(i + CHUNK, ids.length)}…`;
        await send({ address: config.factory, abi: factoryAbi, functionName: 'deposit', args: [batch, ids.slice(i, i + CHUNK)] });
      }
      toast('Batch opened.', 'ok');
      location.hash = `#/b/${batch}`;
    } catch (x) {
      toast(errText(x), 'err', 8000);
      go.textContent = 'Open batch';
      draw();
    }
  });
}
