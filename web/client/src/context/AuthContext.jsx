import { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { apiGet, apiPost, setAuthFailureHandler, markSigningOut } from '../api';

const AuthContext = createContext(null);

// A 403-driven /api/me refetch (e.g. after a course-access denial) usually
// returns the SAME user. Compare shallow over every scalar field plus a
// set-equality on the granted permissions, so a functional setUser can bail out
// (return prev) and avoid re-rendering the whole tree when nothing changed.
// `permissions` is the rehydrated { key: true } map by the time this runs — a
// denied permission is absent, never `false`, so the granted keys ARE the set.
function sameUser(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  const ak = Object.keys(a);
  if (ak.length !== Object.keys(b).length) return false;
  for (const k of ak) {
    if (k === 'permissions') continue;
    if (a[k] !== b[k]) return false;
  }
  const ap = a.permissions || {};
  const bp = b.permissions || {};
  const apk = Object.keys(ap).filter(k => ap[k]);
  if (apk.length !== Object.keys(bp).filter(k => bp[k]).length) return false;
  for (const k of apk) if (!bp[k]) return false;
  return true;
}

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  const clearUser = useCallback(() => setUser(null), []);

  const refresh = useCallback(async () => {
    try {
      const { data, ok } = await apiGet('/api/me');
      if (ok && data && data.user) {
        // Server sends `permissions` as a list of granted keys (compact wire
        // format). Rehydrate to `{ key: true, ... }` here so the rest of the
        // app keeps using `user.permissions.X` truthy checks unchanged. Object
        // shape is also accepted as a fallback in case a stale server still
        // sends the full map — covers rolling-deploy windows.
        //
        // IMPORTANT: with this wire format a *denied* permission is
        // `undefined`, never `false`. Always use truthy/falsy checks
        // (`if (perms.X)`, `!perms.X`) — `=== false` / `!== false` will
        // silently misbehave.
        if (Array.isArray(data.user.permissions)) {
          data.user.permissions = Object.fromEntries(
            data.user.permissions.map(k => [k, true])
          );
        }
        // Merge-not-replace: only swap state when something actually changed, so
        // an unchanged refetch is a no-op re-render. Functional update reads
        // current state without adding `user` as a dep.
        setUser(prev => sameUser(prev, data.user) ? prev : data.user);
      } else {
        setUser(null);
      }
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // Register auth failure handler so apiFetch 401s clear user state
    setAuthFailureHandler(clearUser);
    refresh();
    return () => setAuthFailureHandler(null);
  }, [refresh, clearUser]);

  const logout = useCallback(async () => {
    let logoutUrl = '/auth/login';
    try {
      // Backend kills the local session and returns the SSO end_session URL
      // (RP-initiated logout) so the IdP clears its own session too.
      const { data } = await apiPost('/auth/logout');
      if (data && data.logoutUrl) logoutUrl = data.logoutUrl;
    } catch {
      // ignore — fall back to re-login
    }
    // Mark first so WatchPage's pagehide handler skips its sendBeacon — the
    // session is dead, the server would 401 the report anyway.
    markSigningOut();
    // Full navigation to the SSO end_session endpoint (clears the IdP session,
    // then redirects back to our post-logout URL).
    window.location.href = logoutUrl;
  }, []);

  return (
    <AuthContext.Provider value={{ user, loading, refresh, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
