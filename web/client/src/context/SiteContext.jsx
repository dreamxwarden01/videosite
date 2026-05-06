import { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { apiGet } from '../api';

const SiteContext = createContext(null);

// localStorage key for the site name cache. Persists indefinitely;
// every /api/settings/public response overwrites it on success, so the
// "TTL" is effectively until the next visit.
const SITE_NAME_KEY = 'vs:siteName';

function readCachedSiteName() {
  try {
    return localStorage.getItem(SITE_NAME_KEY) || '';
  } catch {
    // localStorage can throw in private mode / sandboxed iframes.
    return '';
  }
}

function writeCachedSiteName(name) {
  try {
    if (name) localStorage.setItem(SITE_NAME_KEY, name);
  } catch {
    // ignore — cache miss next visit is fine
  }
}

export function SiteProvider({ children }) {
  // turnstileSiteKey: null means "Turnstile is off site-wide" — no widget,
  // no token required by submits. A real string means "render the widget."
  // The server returns null (not '') from /api/settings/public when either
  // the site key or secret key env var is missing.
  //
  // siteName: lazy-init from localStorage so returning visitors get the
  // correct header + tab title on first paint. First-time visitors start
  // with '' and pages skip setting document.title until the response
  // populates it (see usePageTitle).
  const [site, setSite] = useState(() => ({
    siteName: readCachedSiteName(),
    turnstileSiteKey: null,
    registrationEnabled: false,
    invitationRequired: true,
  }));
  const [loading, setLoading] = useState(true);

  // Re-fetch /api/settings/public. Form pages call this when the server
  // rejects a submit with errors.turnstile while the local site key was
  // null — i.e., admin enabled Turnstile after the page loaded. The page
  // then re-renders with the widget visible so the user can try again.
  const refreshSiteSettings = useCallback(async () => {
    try {
      const { data, ok } = await apiGet('/api/settings/public');
      if (ok && data) {
        const siteName = data.siteName || '';
        setSite({
          siteName,
          turnstileSiteKey: data.turnstileSiteKey || null,
          registrationEnabled: data.registrationEnabled || false,
          invitationRequired: data.invitationRequired !== false,
        });
        // Refresh the cache on every successful response so an admin
        // rename propagates to returning visitors after one round-trip.
        writeCachedSiteName(siteName);
      }
    } catch {
      // keep current values on transient failure
    }
  }, []);

  useEffect(() => {
    (async () => {
      await refreshSiteSettings();
      setLoading(false);
    })();
  }, [refreshSiteSettings]);

  return (
    <SiteContext.Provider value={{ ...site, loading, refreshSiteSettings }}>
      {children}
    </SiteContext.Provider>
  );
}

export function useSite() {
  const ctx = useContext(SiteContext);
  if (!ctx) throw new Error('useSite must be used within SiteProvider');
  return ctx;
}
