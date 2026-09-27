/// Link previews: every page is the same index.html, so the worker rewrites its head per route with the title,
/// description and card image a crawler (X, Telegram, iMessage) reads. Images: public/og/*.png (scripts/og.ts).

export type Card = { title: string; description: string; image: string };

const SITE = 'Credit Union';
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
  credits: { title: 'Credits · Credit Union', description: 'Every Credit by its traits: palette, eights, print, weight, time, rating and Bits.', image: '/og/home.png' },
  credit: { title: 'Credit · Credit Union', description: 'A Credit: its rating, its owner, and the Credit Unions it fits.', image: '/og/home.png' },
  time: { title: 'Time · Credit Union', description: 'Pick a stretch of the mint and see every Credit paid in it.', image: '/og/home.png' },
  rating: { title: 'Rating · Credit Union', description: 'Pick a range of ratings and see every Credit in it.', image: '/og/home.png' },
  bits: { title: 'Bits · Credit Union', description: 'Pick a range of Bits and see every Credit in it.', image: '/og/home.png' },
  og: { title: 'Link previews · Credit Union', description: 'Every page’s link card.', image: '/og/home.png' },
};

/// The card for a path, or null for paths that aren't pages.
export function cardFor(path: string): Card | null {
  const first = path.split('/')[1] ?? '';
  if (first === '') return CARDS.home;
  if (first === 'b' || first === 'party' || first === 'union') return CARDS.party;
  if (first === 'unions') return CARDS.parties;
  if (first === 'member') return CARDS.member;
  if (first === 'docs' || first === 'how') return CARDS.about;
  if (first === 'new') return CARDS.create;
  return CARDS[first] ?? null;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

/// index.html with this route's head tags.
export function withCard(html: Response, card: Card, url: URL): Response {
  const image = `${url.origin}${card.image}`;
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
    .on('head', { element: (e) => void e.append(`  ${tags}\n`, { html: true }) })
    .transform(html);
  const out = new Response(res.body, res);
  out.headers.set('cache-control', 'no-cache'); // always revalidate: a stale shell would point at old asset hashes after a deploy
  return out;
}

/// A party page's card, from the party itself: its name and where it stands, and its own drawn image.
export function partyCard(address: string, name: string, state: string, count: number, highBid: string, stamp: string): Card {
  const n = name || 'A Credit Union';
  const where =
    state === 'Settled' ? `Sold for ${highBid}.`
    : state === 'Auction' ? (highBid ? `At auction, high bid ${highBid}.` : 'At auction. The clock starts with the first bid.')
    : state === 'Full' ? 'Full: 80 Credits, ready to become a Statement.'
    : `${count} of 80 Credits in. Join with yours, leave any time before it fills.`;
  return { title: `${n} · Credit Union`, description: where, image: `/og/party/${address.toLowerCase()}.png?s=${stamp}` };
}

/// A trait page's card: "Sparse · Credit Union", and how many Credits have it.
export function traitCard(name: string, count: number | null): Card {
  const description = count === null ? 'Every Credit with it, and the Credit Unions that take them.' : `${count.toLocaleString('en-US')} ${count === 1 ? 'Credit has' : 'Credits have'} it, of 122,154.`;
  return { title: `${name} · Credit Union`, description, image: '/og/home.png' };
}

/// The Credits overview's card: how many Credits the edition holds.
export function creditsCard(count: number): Card {
  return { ...CARDS.credits, description: `${count.toLocaleString('en-US')} Credits by trait: Palette, Eights, Print, Weight, Time, Rating and Bits.` };
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
