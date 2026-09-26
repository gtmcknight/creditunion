/// A party's state in a few characters, stamped on shared links (?s=…) and on its card image. Social sites cache a
/// card per link for days (X about 7, Telegram until asked), so each new state needs a new link to show fresh.
/// Filling: the count ("43"). At auction: "a" with no bids, else "b" and the bid in ETH ("b1.25"). Sold: "s".
export function stamp(state: string, count: number, highBidWei: bigint): string {
  if (state === 'Settled') return 's';
  if (state === 'Auction') return highBidWei > 0n ? `b${(Number(highBidWei) / 1e18).toFixed(4).replace(/\.?0+$/, '')}` : 'a';
  return String(count);
}
