import { keccak256, type Address } from 'viem';
import { explorer } from './chain';
import { esc, short } from './ui';

type Ens = { name: string | null; avatar: string | null };
const memo = new Map<string, Promise<Ens>>();

export function ens(a: Address): Promise<Ens> {
  const k = a.toLowerCase();
  if (!memo.has(k)) {
    memo.set(
      k,
      fetch(`/ens/${k}`)
        .then((r) => (r.ok ? r.json() : { name: null, avatar: null }))
        .catch(() => ({ name: null, avatar: null })),
    );
  }
  return memo.get(k)!;
}

/// 8×8 mirrored mark from the address, in ink on paper: a tiny Credit for people without an avatar.
export function identicon(a: string) {
  const h = keccak256(a.toLowerCase() as `0x${string}`).slice(2);
  let rects = '';
  for (let y = 0; y < 8; y++)
    for (let x = 0; x < 4; x++) {
      if (parseInt(h[y * 4 + x], 16) % 2) continue;
      rects += `<rect x="${x}" y="${y}" width="1" height="1"/><rect x="${7 - x}" y="${y}" width="1" height="1"/>`;
    }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-1 -1 10 10" shape-rendering="crispEdges"><rect x="-1" y="-1" width="10" height="10" fill="#fff"/><g fill="#0a0a0a">${rects}</g></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

/// Creator chip; names and avatars fill in by `hydrate`. `link` makes it open the address on the explorer
/// (not inside cards, which are already links).
export const who = (a: Address, size: 'sm' | 'lg' = 'sm', link = false) => {
  const inner = `<img src="${identicon(a)}" alt=""><span class="who-name mono">${short(a)}</span>`;
  const url = link ? explorer('address', a) : null;
  return url
    ? `<a class="who ${size}" data-ens="${esc(a)}" href="${url}" target="_blank" rel="noopener" title="View on the explorer">${inner}</a>`
    : `<span class="who ${size}" data-ens="${esc(a)}">${inner}</span>`;
};

export function hydrate(root: ParentNode = document) {
  root.querySelectorAll<HTMLElement>('[data-ens]').forEach(async (el) => {
    const r = await ens(el.dataset.ens as Address);
    if (!el.isConnected) return;
    if (r.name) {
      const n = el.querySelector('.who-name')!;
      n.textContent = r.name;
      n.classList.remove('mono');
    }
    if (r.avatar && /^https:\/\//.test(r.avatar)) {
      const img = new Image();
      img.alt = '';
      img.onload = () => el.querySelector('img')?.replaceWith(img);
      img.src = r.avatar;
    }
  });
}

export const pct = (bps: number) => `${(bps / 100).toFixed(2).replace(/\.?0+$/, '')}%`;
