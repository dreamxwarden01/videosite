import { Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

export default function ProtectedRoute() {
  const { user, loading } = useAuth();
  const location = useLocation();

  // Blank (not a spinner) during the initial auth check — avoids a loading icon
  // flashing on first paint before the app or the SSO redirect resolves.
  if (loading) return null;

  if (!user) {
    // Login is the SSO: full-page redirect to the backend /auth/login (which
    // bounces to the IdP), not an in-SPA route. Render nothing meanwhile.
    const returnTo = location.pathname !== '/'
      ? `?returnTo=${encodeURIComponent(location.pathname + location.search)}`
      : '';
    window.location.replace(`/auth/login${returnTo}`);
    return null;
  }

  return <Outlet />;
}
