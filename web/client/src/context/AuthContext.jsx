import { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { apiGet, apiPost, setAuthFailureHandler, markSigningOut } from '../api';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  const clearUser = useCallback(() => setUser(null), []);

  const refresh = useCallback(async () => {
    try {
      const { data, ok } = await apiGet('/api/me');
      if (ok && data && data.user) {
        setUser(data.user);
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
    try {
      await apiPost('/api/auth/logout');
    } catch {
      // ignore
    }
    // Mark first so WatchPage's pagehide handler skips its sendBeacon — the
    // session is dead, the server would 401 the report anyway. Set AFTER the
    // logout call so a network failure on logout (cookie still alive) doesn't
    // permanently latch the flag and silence future watch reports on retry.
    markSigningOut();
    // Full reload to /login — don't setUser(null) first, that would trigger
    // ProtectedRoute's redirect with returnTo before the reload completes (flash)
    window.location.href = '/login';
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
