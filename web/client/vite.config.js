import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import fs from 'fs';
import { createRequire } from 'module';

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

// Version in the PATH, not a content hash: these files are copied verbatim, so
// Vite never hashes them. Serving an unhashed URL with immutable + 1y would make
// a Shaka upgrade unreachable for a year; a versioned directory makes the
// upgrade a new URL and lets the old one age out on its own.
const shakaBase = `vendor/shaka-${SHAKA_VERSION}`;

// The compiled UI build and its stylesheet. The trailing sourceMappingURL is
// stripped rather than shipping ~2.8 MB of maps we would never read — without
// it devtools 404s on every page load.
const SHAKA_FILES = [
  { from: 'dist/shaka-player.ui.js', to: 'shaka-player.ui.js' },
  { from: 'dist/controls.css', to: 'controls.css' },
];

function readShakaAsset(rel) {
  const src = fs.readFileSync(path.join(SHAKA_DIR, rel), 'utf8');
  return src.replace(/\r?\n?\/\/# sourceMappingURL=.*$/, '')
            .replace(/\r?\n?\/\*# sourceMappingURL=.*?\*\/\s*$/, '');
}

function shakaVendorPlugin() {
  return {
    name: 'vendor-shaka',
    // Build: emit into dist/vendor/shaka-<version>/ alongside the bundle.
    generateBundle() {
      for (const f of SHAKA_FILES) {
        this.emitFile({ type: 'asset', fileName: `${shakaBase}/${f.to}`, source: readShakaAsset(f.from) });
      }
    },
    // Dev server: same URLs, served straight out of node_modules so the watch
    // page behaves identically under `vite` as it does in a built image.
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
