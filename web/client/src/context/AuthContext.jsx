import { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { apiGet, apiPost, setAuthFailureHandler } from '../api';

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
