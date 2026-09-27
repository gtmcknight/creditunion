import { defineConfig } from 'vite';
import { cloudflare } from '@cloudflare/vite-plugin';
import { bins } from './scripts/bins.mjs';

export default defineConfig({
  plugins: [cloudflare(), bins()],
});
