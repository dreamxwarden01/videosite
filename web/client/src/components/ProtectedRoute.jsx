import { Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import LoadingSpinner from './LoadingSpinner';

export default function ProtectedRoute() {
  const { user, loading } = useAuth();
  const location = useLocation();

  if (loading) return <LoadingSpinner />;

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
