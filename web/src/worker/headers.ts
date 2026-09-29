/// The security headers every page carries. The Worker sets them on what it serves (index.ts secure()); the build
/// writes the same into _headers (vite.config.ts) for what the asset layer serves without the Worker: index.html on
/// a trailing-slash or unknown path, and every static file.
export const CSP = [
  "default-src 'self'",
  "script-src 'self' https://static.cloudflareinsights.com", // Cloudflare Web Analytics beacon
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com", // inline style attributes size the sheets
  'font-src https://fonts.gstatic.com',
  "img-src 'self' data: blob: https://metadata.ens.domains", // blob: a picture uploaded on /create or /printer
  "connect-src 'self' https://cloudflareinsights.com",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "object-src 'none'",
  "form-action 'self'",
].join('; ');

export const HSTS = 'max-age=31536000; includeSubDomains';

/// Set everywhere, local dev included (CSP and HSTS are production only).
export const ALWAYS: [string, string][] = [
  ['x-frame-options', 'DENY'],
  ['x-content-type-options', 'nosniff'],
  ['referrer-policy', 'strict-origin-when-cross-origin'],
  ['permissions-policy', 'camera=(), microphone=(), geolocation=(), payment=()'],
];

/// The asset layer's _headers: the security headers on every path, and a year's cache for Vite's content-hashed
/// build files (the asset layer's default makes every visit ask again).
export const assetHeaders = () =>
  [
    '/*',
    ...[['content-security-policy', CSP], ...ALWAYS, ['strict-transport-security', HSTS]].map(([k, v]) => `  ${k}: ${v}`),
    '/assets/*',
    '  cache-control: public, max-age=31536000, immutable',
    '',
  ].join('\n');
