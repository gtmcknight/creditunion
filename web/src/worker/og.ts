/// Link previews: every page is the same index.html, so the worker rewrites its head per route with the title,
/// description and card image a crawler (X, Telegram, iMessage) reads. Images: public/og/*.png (scripts/og.ts).

export type Card = { title: string; description: string; image: string };

const SITE = 'Credit Union';
const CARDS_V = 6;
const CARDS: Record<string, Card> = {
  home: { title: 'Credit Union', description: 'Join a Credit Union to make a Statement together.', image: '/og/home.png' },
  parties: { title: 'Credit Unions', description: 'Credit Unions pooling Credits toward a Statement. Join one, leave any time before it fills.', image: '/og/party.png' },
  auctions: { title: 'Auctions · Credit Union', description: 'Statements at auction: 24 hours from the first bid, split between the 80 Credits that made them.', image: '/og/auctions.png' },
  create: { title: 'Start a Credit Union', description: 'Pick who joins and how the 80 are laid out. Anyone can burn the moment it fills.', image: '/og/create.png' },
  about: { title: 'How Credit Union works', description: 'One wallet nobody owns, rules nobody can change. 80 Credits make a Statement.', image: '/og/about.png' },
  party: { title: 'Join this Credit Union', description: '80 Credits. One Statement. Split 80 ways. Leave any time before it fills.', image: '/og/party.png' },
  mint: { title: 'Mint test Credits · Credit Union', description: 'Real Credits art on testnet, to try a Credit Union end to end.', image: '/og/mint.png' },
  me: { title: 'Your Credit Unions', description: 'Your Credits in Credit Unions, and what they’re worth.', image: '/og/home.png' },
  member: { title: 'Member · Credit Union', description: 'Their Credit Unions and Credits.', image: '/og/home.png' },
  credits: { title: 'Credits · Credit Union', description: 'Every Credit, the ones for sale first, cheapest first.', image: '/og/home.png' },
  credit: { title: 'Credit · Credit Union', description: 'A Credit: its rating, its owner, and the Credit Unions it fits.', image: '/og/home.png' },
  time: { title: 'Time · Credit Union', description: 'Pick a stretch of the mint and see every Credit paid in it.', image: '/og/home.png' },
  rating: { title: 'Rating · Credit Union', description: 'Pick a range of ratings and see every Credit in it.', image: '/og/home.png' },
  bits: { title: 'Bits · Credit Union', description: 'Pick a range of Bits and see every Credit in it.', image: '/og/home.png' },
  activity: { title: 'Activity · Credit Union', description: 'Every deposit, buy, bid and new Credit Union, as it happens.', image: '/og/home.png' },
  printer: { title: 'Printer · Credit Union', description: 'Turn a picture into a Statement, drawn by Credits you and your friends own and Credits for sale.', image: '/og/create.png' },
  og: { title: 'Link previews · Credit Union', description: 'Every page’s link card.', image: '/og/home.png' },
};

/// The card for a path, or null for paths that aren't pages.
export function cardFor(path: string): Card | null {
  const first = path.split('/')[1] ?? '';
  if (first === '') return CARDS.home;
  if (first === 'b' || first === 'party' || first === 'union') return CARDS.party;
  if (first === 'unions') return CARDS.parties;
  if (first === 'member') return CARDS.member;
  if (first === 'faq') return CARDS.about;
  if (first === 'new') return CARDS.create;
  return CARDS[first] ?? null;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

/// index.html with this route's head tags, and `head` (the app's boot data) after them.
export function withCard(html: Response, card: Card, url: URL, head = ''): Response {
  // `v` changes when the cards are redrawn, so sites that cached the old image by URL fetch the new one.
  const image = `${url.origin}${card.image}${card.image.includes('?') ? '&' : '?'}v=${CARDS_V}`;
  const page = `${url.origin}${url.pathname}`;
  const tags = [
    ['property', 'og:site_name', SITE],
    ['property', 'og:type', 'website'],
    ['property', 'og:title', card.title],
    ['property', 'og:description', card.description],
    ['property', 'og:url', page],
    ['property', 'og:image', image],
    ['property', 'og:image:width', '1200'],
    ['property', 'og:image:height', '630'],
    ['name', 'twitter:card', 'summary_large_image'],
    ['name', 'twitter:title', card.title],
    ['name', 'twitter:description', card.description],
    ['name', 'twitter:image', image],
  ]
    .map(([k, n, v]) => `<meta ${k}="${n}" content="${esc(v)}">`)
    .join('\n  ');
  const res = new HTMLRewriter()
    .on('title', { element: (e) => void e.setInnerContent(card.title) })
    .on('meta[name="description"]', { element: (e) => void e.setAttribute('content', card.description) })
    .on('head', { element: (e) => void e.append(`  ${tags}\n${head ? `  ${head}\n` : ''}`, { html: true }) })
    .transform(html);
  const out = new Response(res.body, res);
  out.headers.set('cache-control', 'no-cache'); // always revalidate: a stale shell would point at old asset hashes after a deploy
  return out;
}

/// A Credit Union's card. Only what never changes (name, rule): platforms keep a link's preview for days, so a
/// count or a state would go stale.
export function partyCard(address: string, name: string, rule: string): Card {
  const n = name || 'A Credit Union';
  const takes = rule ? `${rule}. ` : '';
  return {
    title: `${n} · Credit Union`,
    description: `${takes}80 Credits burn into one Statement, auctioned and split among the members.`,
    image: `/og/party/${address.toLowerCase()}.png`,
  };
}

/// A Batch.Filter as one line: "Palette Y · Print Registered · Three or four eights". "" when anything can join.
export type Filter = {
  palettes: number; prints: number; weights: number; eights: number;
  paidFrom: bigint; paidTo: bigint; idFrom: bigint; idTo: bigint;
  minScore: number; maxScore: number; bitsFrom: number; bitsTo: number;
};
const PRINT_NAMES = ['Registered', 'Nudge', 'Slip', 'Skew', 'Drift', 'Loose'];
const WEIGHT_NAMES = ['Even', 'Lean', 'Sparse', 'Extreme'];
const WORDS = ['No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten'];
const setOf = (bits: number, n: number) => Array.from({ length: n }, (_, i) => i).filter((i) => bits & (1 << i));
const either = (xs: string[]) => (xs.length > 1 ? `${xs.slice(0, -1).join(', ')} or ${xs[xs.length - 1]}` : xs[0] ?? '');
const utcDay = (t: number) => new Date(t * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const utcTime = (t: number) => new Date(t * 1000).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' });
export function ruleLine(f: Filter, allowlistSize = 0): string {
  const parts: string[] = [];
  if (f.palettes) parts.push(`Palette ${either(setOf(f.palettes, 16).map((m) => [...'CMYK'].filter((_, b) => m & (1 << b)).join('')))}`);
  if (f.prints) parts.push(`Print ${either(setOf(f.prints, 6).map((i) => PRINT_NAMES[i]))}`);
  if (f.weights) parts.push(`Weight ${either(setOf(f.weights, 4).map((i) => WEIGHT_NAMES[i].toLowerCase()))}`);
  if (f.eights) {
    const ns = setOf(f.eights, 11);
    const w = either(ns.map((n) => WORDS[n].toLowerCase()));
    parts.push(`${w.charAt(0).toUpperCase()}${w.slice(1)} ${ns.length === 1 && ns[0] === 1 ? 'eight' : 'eights'}`);
  }
  const pf = Number(f.paidFrom), pt = Number(f.paidTo);
  if (pf || pt) {
    if (pf && pt && utcDay(pf) === utcDay(pt)) parts.push(`Paid ${utcDay(pf)}, ${utcTime(pf)}–${utcTime(pt)} UTC`);
    else if (pf && pt) parts.push(`Paid ${utcDay(pf)} ${utcTime(pf)} to ${utcDay(pt)} ${utcTime(pt)} UTC`);
    else parts.push(pf ? `Paid after ${utcDay(pf)} ${utcTime(pf)} UTC` : `Paid before ${utcDay(pt)} ${utcTime(pt)} UTC`);
  }
  if (f.minScore || f.maxScore) parts.push(f.minScore && f.maxScore ? `Rating ${f.minScore / 10}–${f.maxScore / 10}` : f.minScore ? `Rating ${f.minScore / 10}+` : `Rating up to ${f.maxScore / 10}`);
  if (f.bitsFrom || f.bitsTo) parts.push(f.bitsFrom && f.bitsTo ? `Bits ${f.bitsFrom}–${f.bitsTo}` : f.bitsFrom ? `Bits ${f.bitsFrom}+` : `Bits up to ${f.bitsTo}`);
  const a = Number(f.idFrom), b = Number(f.idTo);
  if (a || b) parts.push(a && b ? `#${a.toLocaleString('en-US')}–${b.toLocaleString('en-US')}` : a ? `#${a.toLocaleString('en-US')}+` : `Up to #${b.toLocaleString('en-US')}`);
  if (allowlistSize) parts.push(`${allowlistSize} listed Credits`);
  return parts.join(' · ');
}

/// A trait page's card: "Sparse · Credit Union", and how many Credits have it.
export function traitCard(name: string, count: number | null): Card {
  const description = count === null ? 'Every Credit with it, and the Credit Unions that take them.' : `${count.toLocaleString('en-US')} ${count === 1 ? 'Credit has' : 'Credits have'} it, of 122,154.`;
  return { title: `${name} · Credit Union`, description, image: '/og/home.png' };
}

/// /credits' card: how many Credits the edition holds.
export function creditsCard(count: number): Card {
  return { ...CARDS.credits, description: `All ${count.toLocaleString('en-US')} Credits, the ones for sale first, cheapest first.` };
}

/// A /time window's card: how many Credits were paid in it.
export function timeCard(count: number): Card {
  return { ...CARDS.time, description: `${count.toLocaleString('en-US')} ${count === 1 ? 'Credit was' : 'Credits were'} paid in this window of the mint.` };
}

/// A /rating or /bits range's card: how many Credits are in it.
export function rangeCard(kind: 'rating' | 'bits', count: number, lo: string, hi: string): Card {
  const c = `${count.toLocaleString('en-US')} ${count === 1 ? 'Credit' : 'Credits'}`;
  return { ...CARDS[kind], description: kind === 'rating' ? `${c} rated ${lo} to ${hi}, of 122,154.` : `${c} with ${lo} to ${hi} Bits, of 122,154.` };
}

/// One Credit's card: its number, and its art drawn from the edition.
export function creditCard(id: number): Card {
  return { title: `Credit #${id.toLocaleString('en-US')} · Credit Union`, description: 'Its rating, its owner, and the Credit Unions it fits.', image: `/og/credit/${id}.png` };
}
