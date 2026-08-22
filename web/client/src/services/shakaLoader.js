// Loads Shaka Player on demand from our own origin.
//
// Why not bundled: the UI build is ~1 MB (330 KB gzipped), more than twice the
// whole application bundle, and only the watch page ever uses it. Bundling it
// would make every page — the course list, admin, the login bounce — pay for a
// video player nobody on those pages needs.
//
// Why not a CDN: it previously came from cdn.jsdelivr.net with no integrity
// attribute, which put a third party in a position to execute arbitrary script
// on authenticated pages. Serving it ourselves removes that entirely and drops
// a third-party DNS + TLS handshake from the player's critical path. Files live
// under a version-stamped path emitted at build time (see vite.config.js) and
// are served immutable for a year.
//
// __SHAKA_BASE__ is injected by Vite from the installed package version, so the
// URL here cannot drift from the files that actually shipped.
const BASE = __SHAKA_BASE__;

// One promise for the whole page. Navigating between videos remounts WatchPage
// repeatedly; without memoisation each mount would inject another script tag.
let loadPromise = null;

function injectStylesheet() {
  const href = `${BASE}/controls.css`;
  if (document.querySelector(`link[data-shaka-css]`)) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = href;
  link.dataset.shakaCss = '';
  document.head.appendChild(link);
}

/**
 * Resolves with the global `shaka` namespace once the player is usable.
 * Rejects if the script fails to load, so the caller can surface a real error
 * instead of rendering a player that silently never initialises.
 */
export function loadShaka() {
  if (window.shaka) return Promise.resolve(window.shaka);
  if (loadPromise) return loadPromise;

  loadPromise = new Promise((resolve, reject) => {
    // The stylesheet goes in first so Shaka's control bar is styled the moment
    // the overlay is constructed — a late stylesheet shows unstyled controls.
    injectStylesheet();

    const script = document.createElement('script');
    script.src = `${BASE}/shaka-player.ui.js`;
    script.async = true;
    script.onload = () => {
      if (window.shaka) resolve(window.shaka);
      else reject(new Error('Shaka Player loaded but exposed no global'));
    };
    script.onerror = () => {
      // Clear the memo so a later mount can retry rather than being stuck with
      // a permanently rejected promise.
      loadPromise = null;
      reject(new Error('Failed to load the video player'));
    };
    document.head.appendChild(script);
  });
  return loadPromise;
}

/**
 * Warms the HTTP cache without blocking anything, for pages that are likely to
 * lead to playback (the course view). Uses <link rel="prefetch">, the lowest
 * priority the browser offers — it will be skipped entirely under data-saver or
 * memory pressure, which is the correct behaviour for a nice-to-have. When the
 * watch page later calls loadShaka(), the script injection is a cache hit if the
 * prefetch landed and an ordinary download if it did not.
 */
export function prefetchShaka() {
  if (window.shaka || loadPromise) return;
  if (document.querySelector('link[data-shaka-prefetch]')) return;
  const start = () => {
    const link = document.createElement('link');
    link.rel = 'prefetch';
    link.as = 'script';
    link.href = `${BASE}/shaka-player.ui.js`;
    link.dataset.shakaPrefetch = '';
    document.head.appendChild(link);
  };
  if (typeof requestIdleCallback === 'function') requestIdleCallback(start, { timeout: 3000 });
  else setTimeout(start, 1200);
}
