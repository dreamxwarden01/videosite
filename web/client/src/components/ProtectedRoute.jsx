import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import LoadingSpinner from './LoadingSpinner';

export default function ProtectedRoute() {
  const { user, loading } = useAuth();
  const location = useLocation();

  if (loading) return <LoadingSpinner />;

  if (!user) {
    const returnTo = location.pathname !== '/'
      ? `?returnTo=${encodeURIComponent(location.pathname + location.search)}`
      : '';
    return <Navigate to={`/login${returnTo}`} replace />;
  }

  return <Outlet />;
}
