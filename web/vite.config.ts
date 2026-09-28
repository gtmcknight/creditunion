import { defineConfig, type Plugin } from 'vite';
import { cloudflare } from '@cloudflare/vite-plugin';
import { bins } from './scripts/bins.mjs';
import { assetHeaders } from './src/worker/headers.ts';

/// _headers in the client build: what the asset layer serves without the Worker gets the Worker's security headers,
/// and the content-hashed build files a year's cache.
const headers = (): Plugin => ({
  name: 'asset-headers',
  generateBundle() {
    if (this.environment?.name === 'client') this.emitFile({ type: 'asset', fileName: '_headers', source: assetHeaders() });
  },
});

export default defineConfig({
  plugins: [cloudflare(), bins(), headers()],
});
