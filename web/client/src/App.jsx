import { Routes, Route, Navigate } from 'react-router-dom';
import { SiteProvider } from './context/SiteContext';
import { AuthProvider } from './context/AuthContext';
import { ToastProvider } from './context/ToastContext';
import { ConfirmProvider } from './components/ConfirmModal';
import { StepUpProvider } from './context/StepUpProvider';
import AppShell from './components/AppShell';
import ProtectedRoute from './components/ProtectedRoute';

// Pages — lazy-loaded would be nice later, but keep it simple for now.
// Public auth pages (Login/Register/ResetPassword*) were removed: login is now
// the SSO via the backend /auth/* routes (login-first OIDC).
import HomePage from './pages/HomePage';
import CourseView from './pages/CourseView';
import WatchPage from './pages/WatchPage';
import NotFoundPage from './pages/NotFoundPage';

// Admin pages
import CoursesPage from './pages/admin/CoursesPage';
import CoursePage from './pages/admin/CoursePage';
import UsersPage from './pages/admin/UsersPage';
import UserEditPage from './pages/admin/UserEditPage';
import EnrollmentPage from './pages/admin/EnrollmentPage';
import RolesPage from './pages/admin/RolesPage';
import SettingsPage from './pages/admin/SettingsPage';
import TranscodingPage from './pages/admin/TranscodingPage';

export default function App() {
  return (
    <SiteProvider>
      <AuthProvider>
        <ToastProvider>
          <ConfirmProvider>
            <StepUpProvider>
            <Routes>
              {/* No in-SPA public auth routes — login is the SSO (backend
                  /auth/login). ProtectedRoute full-page-redirects there. */}

              {/* Authenticated — with AppShell */}
              <Route element={<ProtectedRoute />}>
                <Route element={<AppShell />}>
                  <Route path="/" element={<HomePage />} />
                  <Route path="/course/:courseId" element={<CourseView tab="videos" />} />
                  <Route path="/course/:courseId/materials" element={<CourseView tab="materials" />} />
                  <Route path="/watch/:videoId" element={<WatchPage />} />

                  {/* Admin */}
                  <Route path="/admin/courses" element={<CoursesPage />} />
                  <Route path="/admin/courses/:courseId" element={<CoursePage />} />
                  <Route path="/admin/users" element={<UsersPage />} />
                  <Route path="/admin/users/:id/edit" element={<UserEditPage />} />
                  <Route path="/admin/enrollment" element={<EnrollmentPage />} />
                  <Route path="/admin/roles" element={<RolesPage />} />
                  {/* Per-pane settings routes — the pane is in the URL so a
                      step-up returnTo lands back on the exact pane, and each
                      pane loads its own slice lazily. */}
                  <Route path="/admin/settings" element={<Navigate to="/admin/settings/general" replace />} />
                  <Route path="/admin/settings/:pane" element={<SettingsPage />} />
                  <Route path="/admin/transcoding" element={<TranscodingPage />} />
                  {/* MFA settings folded into the unified Settings page's MFA pane. */}
                  <Route path="/admin/mfa-settings" element={<Navigate to="/admin/settings/mfa" replace />} />
                </Route>
              </Route>

              <Route path="*" element={<NotFoundPage />} />
            </Routes>
            </StepUpProvider>
          </ConfirmProvider>
        </ToastProvider>
      </AuthProvider>
    </SiteProvider>
  );
}
