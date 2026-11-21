import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import fs from 'fs';
import { createRequire } from 'module';
import { createHash } from 'node:crypto';

const require = createRequire(import.meta.url);

// Shaka Player is served from our own origin, but is deliberately NOT bundled.
// It is ~1 MB (330 KB gzipped) of player that only the watch page ever needs —
// more than twice the entire app bundle — so it stays a separate script the
// watch page loads on demand (see src/services/shakaLoader.js).
//
// The npm package is a build-time source of files, not an import: nothing in
// src/ imports 'shaka-player', so it contributes nothing to the bundle graph.
// Taking it from npm rather than committing the blob keeps the version in
// package.json, makes the build reproducible, and means `npm audit` sees it.
const SHAKA_VERSION = require('shaka-player/package.json').version;
const SHAKA_DIR = path.dirname(require.resolve('shaka-player/package.json'));

// The compiled UI build and its stylesheet. The trailing sourceMappingURL is
// stripped rather than shipping ~2.8 MB of maps we would never read — without
// it devtools 404s on every page load.
const SHAKA_FILES = [
  { from: 'dist/shaka-player.ui.js', to: 'shaka-player.ui.js' },
  { from: 'dist/controls.css', to: 'controls.css' },
];

function readShakaAsset(rel) {
  const src = fs.readFileSync(path.join(SHAKA_DIR, rel), 'utf8');
  let asset = src.replace(/\r?\n?\/\/# sourceMappingURL=.*$/, '')
                 .replace(/\r?\n?\/\*# sourceMappingURL=.*?\*\/\s*$/, '');
  if (rel.endsWith('.css')) {
    // Shaka's UI stylesheet bundles a remote Roboto face. Only its UI font is
    // replaced; icon families and subtitle/cue preference rules stay intact.
    asset = asset.replace(/@font-face\s*\{(?=[^{}]*font-family:\s*["']?Roboto["']?\s*;)(?=[^{}]*src:\s*url\(["']?https:\/\/fonts\.gstatic\.com\/)[^{}]*\}/gi, '')
      .replace(/--shaka-font-family:roboto,sans-serif/g, '--shaka-font-family:var(--font-ui)')
      .replace(/font-family:roboto,sans-serif/g, 'font-family:var(--font-ui)')
      .replace(/font-family:monospace/g, 'font-family:var(--font-mono)');
  }
  return asset;
}

// Include the exact transformed bytes in the URL. Package version alone would
// reuse an already immutable controls.css when local font handling changes.
const shakaDigest = createHash('sha256');
for (const file of SHAKA_FILES) shakaDigest.update(file.to + '\0' + readShakaAsset(file.from));
const shakaBase = `vendor/shaka-${SHAKA_VERSION}-${shakaDigest.digest('hex').slice(0, 12)}`;

function shakaVendorPlugin() {
  return {
    name: 'vendor-shaka',
    // Build: emit into the version/content-stamped vendor directory.
    generateBundle() {
      for (const f of SHAKA_FILES) {
        this.emitFile({ type: 'asset', fileName: `${shakaBase}/${f.to}`, source: readShakaAsset(f.from) });
      }
    },
    // Dev server: the same URLs and transformations from node_modules, so
    // the watch page matches the production image.
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const hit = SHAKA_FILES.find((f) => req.url && req.url.split('?')[0] === `/${shakaBase}/${f.to}`);
        if (!hit) return next();
        res.setHeader('Content-Type', hit.to.endsWith('.css') ? 'text/css' : 'application/javascript');
        res.end(readShakaAsset(hit.from));
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), shakaVendorPlugin()],
  root: '.',
  // Single source of truth for the version: whatever npm actually installed.
  // The loader builds its URLs from this, so the path and the shipped files
  // can never disagree.
  define: { __SHAKA_BASE__: JSON.stringify('/' + shakaBase) },
  build: {
    outDir: 'dist',
    rolldownOptions: {
      input: {
        main: path.resolve(__dirname, 'index.html'),
        install: path.resolve(__dirname, 'install.html'),
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3000',
      '/auth': 'http://localhost:3000',
    },
  },
});
