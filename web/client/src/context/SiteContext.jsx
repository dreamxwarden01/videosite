import { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { apiGet } from '../api';

const SiteContext = createContext(null);

export function SiteProvider({ children }) {
  // turnstileSiteKey: null means "Turnstile is off site-wide" — no widget,
  // no token required by submits. A real string means "render the widget."
  // The server returns null (not '') from /api/settings/public when either
  // the site key or secret key env var is missing.
  const [site, setSite] = useState({
    siteName: 'VideoSite',
    turnstileSiteKey: null,
    registrationEnabled: false,
    invitationRequired: true,
  });
  const [loading, setLoading] = useState(true);

  // Re-fetch /api/settings/public. Form pages call this when the server
  // rejects a submit with errors.turnstile while the local site key was
  // null — i.e., admin enabled Turnstile after the page loaded. The page
  // then re-renders with the widget visible so the user can try again.
  const refreshSiteSettings = useCallback(async () => {
    try {
      const { data, ok } = await apiGet('/api/settings/public');
      if (ok && data) {
        setSite({
          siteName: data.siteName || 'VideoSite',
          turnstileSiteKey: data.turnstileSiteKey || null,
          registrationEnabled: data.registrationEnabled || false,
          invitationRequired: data.invitationRequired !== false,
        });
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
