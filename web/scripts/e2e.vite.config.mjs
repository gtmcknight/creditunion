// Vite config for the end-to-end matrix (scripts/e2e-matrix.mjs): the same app and Worker as `vite`, but with a
// generated wrangler config (local anvil addresses, no .dev.vars, no rate limits) and no persisted Worker state,
// so it runs beside the normal dev server without touching it.
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { cloudflare } from '@cloudflare/vite-plugin';

export default defineConfig({
  root: fileURLToPath(new URL('..', import.meta.url)),
  cacheDir: 'node_modules/.vite-e2e',
  plugins: [cloudflare({ configPath: process.env.E2E_WRANGLER, persistState: false })],
  server: { port: Number(process.env.E2E_PORT ?? 5191), strictPort: true, host: '127.0.0.1' },
});
