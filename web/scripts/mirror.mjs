#!/usr/bin/env node
// Builds the mirror (src/mirror): one self-contained HTML file, script inlined, for hosting anywhere static (IPFS
// behind an ENS name, GitHub Pages). The chain and factory come from wrangler.jsonc, as the site's do.
//   node scripts/mirror.mjs            → dist-mirror/index.html
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
const strip = (s) => s.replace(/("(?:[^"\\]|\\.)*")|\/\/[^\n]*/g, (_, str) => str ?? '');
const { vars } = JSON.parse(strip(readFileSync(join(WEB, 'wrangler.jsonc'), 'utf8')));
const chainId = Number(vars.CHAIN_ID);
const explorer = { 1: 'https://etherscan.io', 11155111: 'https://sepolia.etherscan.io' }[chainId] ?? 'https://etherscan.io';

// Vite's library build, as one IIFE with everything in it: the page loads nothing from anywhere.
const out = await build({
  configFile: false,
  logLevel: 'warn',
  define: { __FACTORY__: JSON.stringify(vars.FACTORY), __CHAIN_ID__: String(chainId), __EXPLORER__: JSON.stringify(explorer) },
  build: {
    write: false,
    minify: true,
    target: 'es2020',
    lib: { entry: join(WEB, 'src', 'mirror', 'main.ts'), formats: ['iife'], name: 'mirror', fileName: () => 'mirror.js' },
  },
});
// Every Credit's inks, so a union draws from its Credit numbers alone: the 4-bit CMYK mask from edition-traits.bin
// (one uint32 per Credit, id − 1, mask in the low nibble), two Credits to a byte, base64 in the page.
const traits = new Uint32Array(readFileSync(join(WEB, 'public', 'edition-traits.bin')).buffer.slice(0));
const packed = new Uint8Array(Math.ceil(traits.length / 2));
for (let i = 0; i < traits.length; i++) packed[i >> 1] |= (traits[i] & 15) << ((i & 1) * 4);
const palettes = Buffer.from(packed).toString('base64');
const chunk = (Array.isArray(out) ? out[0] : out).output.find((o) => o.type === 'chunk');
const js = chunk.code.replace(/<\/script/gi, '<\\/script');
const html = readFileSync(join(WEB, 'src', 'mirror', 'index.html'), 'utf8')
  .replace('<!--palettes-->', () => `<script type="application/octet-stream" id="palettes">${palettes}</script>`)
  .replace('<!--script-->', () => `<script>${js}</script>`);
mkdirSync(join(WEB, 'dist-mirror'), { recursive: true });
writeFileSync(join(WEB, 'dist-mirror', 'index.html'), html);
console.log(`dist-mirror/index.html · ${(html.length / 1024).toFixed(0)} KB (${traits.length} Credits' inks) · factory ${vars.FACTORY} · chain ${chainId}`);
