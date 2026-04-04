import { createContext, useContext, useState, useEffect } from 'react';
import { apiGet } from '../api';

const SiteContext = createContext(null);

export function SiteProvider({ children }) {
  const [site, setSite] = useState({
    siteName: 'VideoSite',
    turnstileSiteKey: '',
    registrationEnabled: false,
    invitationRequired: true,
  });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const { data, ok } = await apiGet('/api/settings/public');
        if (ok && data) {
          setSite({
            siteName: data.siteName || 'VideoSite',
            turnstileSiteKey: data.turnstileSiteKey || '',
            registrationEnabled: data.registrationEnabled || false,
            invitationRequired: data.invitationRequired !== false,
          });
        }
      } catch {
        // keep defaults
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  return (
    <SiteContext.Provider value={{ ...site, loading }}>
      {children}
    </SiteContext.Provider>
  );
}

export function useSite() {
  const ctx = useContext(SiteContext);
  if (!ctx) throw new Error('useSite must be used within SiteProvider');
  return ctx;
}
