// A request to this site that brings no signal of its own gives up after 30 s, so an answer that stalls ends in the
// page's error (and its Try again) instead of a spinner for good. Requests with their own signal (the chain client's,
// with its timeout and retry), other sites, and the edition's data files (.bin, from the edge: slow only on a slow
// connection) are left as they are. Imported first in main.ts, before anything fetches.
const native = window.fetch.bind(window);
window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
  if (init?.signal || input instanceof Request) return native(input, init);
  const url = new URL(String(input), location.href);
  if (url.origin !== location.origin || url.pathname.endsWith('.bin')) return native(input, init);
  return native(input, { ...init, signal: AbortSignal.timeout(30_000) });
};

export {};
