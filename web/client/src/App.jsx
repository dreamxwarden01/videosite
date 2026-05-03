import { Routes, Route, Navigate } from 'react-router-dom';
import { SiteProvider } from './context/SiteContext';
import { AuthProvider } from './context/AuthContext';
import { ToastProvider } from './context/ToastContext';
import { ConfirmProvider } from './components/ConfirmModal';
import AppShell from './components/AppShell';
import ProtectedRoute from './components/ProtectedRoute';

// Pages — lazy-loaded would be nice later, but keep it simple for now
import LoginPage from './pages/LoginPage';
import RegisterPage from './pages/RegisterPage';
import RegisterCompletePage from './pages/RegisterCompletePage';
import ResetPasswordPage from './pages/ResetPasswordPage';
import ResetPasswordConfirmPage from './pages/ResetPasswordConfirmPage';
import HomePage from './pages/HomePage';
import CoursePage from './pages/CoursePage';
import WatchPage from './pages/WatchPage';
import ProfilePage from './pages/ProfilePage';
import NotFoundPage from './pages/NotFoundPage';

// Admin pages
import CoursesPage from './pages/admin/CoursesPage';
import CourseEditPage from './pages/admin/CourseEditPage';
import UsersPage from './pages/admin/UsersPage';
import UserEditPage from './pages/admin/UserEditPage';
import EnrollmentPage from './pages/admin/EnrollmentPage';
import RolesPage from './pages/admin/RolesPage';
import InvitationsPage from './pages/admin/InvitationsPage';
import SettingsPage from './pages/admin/SettingsPage';
import TranscodingPage from './pages/admin/TranscodingPage';
import PlaybackStatsPage from './pages/admin/PlaybackStatsPage';
import MfaSettingsPage from './pages/admin/MfaSettingsPage';
import VideoManagementPage from './pages/admin/VideoManagementPage';
import VideoListPage from './pages/admin/VideoListPage';
import MaterialsPage from './pages/MaterialsPage';
import MaterialListPage from './pages/MaterialListPage';

export default function App() {
  return (
    <SiteProvider>
      <AuthProvider>
        <ToastProvider>
          <ConfirmProvider>
            <Routes>
              {/* Public — no shell */}
              <Route path="/login" element={<LoginPage />} />
              <Route path="/register" element={<RegisterPage />} />
              <Route path="/register/continue" element={<RegisterCompletePage />} />
              <Route path="/reset-password" element={<ResetPasswordPage />} />
              <Route path="/reset-password/confirm" element={<ResetPasswordConfirmPage />} />

              {/* Authenticated — with AppShell */}
              <Route element={<ProtectedRoute />}>
                <Route element={<AppShell />}>
                  <Route path="/" element={<HomePage />} />
                  <Route path="/course/:courseId" element={<CoursePage />} />
                  <Route path="/watch/:videoId" element={<WatchPage />} />
                  <Route path="/profile" element={<ProfilePage />} />
                  {/* Legacy MFA route — now a tab on /profile. Redirect via
                      Navigate so existing bookmarks land on the right tab. */}
                  <Route path="/profile/security/mfa" element={<Navigate to="/profile?tab=mfa" replace />} />

                  {/* Admin */}
                  <Route path="/admin/courses" element={<CoursesPage />} />
                  <Route path="/admin/courses/:courseId/edit" element={<CourseEditPage />} />
                  <Route path="/admin/materials" element={<MaterialsPage />} />
                  <Route path="/admin/materials/:courseId" element={<MaterialListPage />} />
                  <Route path="/admin/videos" element={<VideoManagementPage />} />
                  <Route path="/admin/videos/:courseId" element={<VideoListPage />} />
                  <Route path="/admin/users" element={<UsersPage />} />
                  <Route path="/admin/users/:id/edit" element={<UserEditPage />} />
                  <Route path="/admin/enrollment" element={<EnrollmentPage />} />
                  <Route path="/admin/roles" element={<RolesPage />} />
                  <Route path="/admin/invitations" element={<InvitationsPage />} />
                  <Route path="/admin/settings" element={<SettingsPage />} />
                  <Route path="/admin/transcoding" element={<TranscodingPage />} />
                  <Route path="/admin/playback-stats" element={<PlaybackStatsPage />} />
                  <Route path="/admin/mfa-settings" element={<MfaSettingsPage />} />
                </Route>
              </Route>

              <Route path="*" element={<NotFoundPage />} />
            </Routes>
          </ConfirmProvider>
        </ToastProvider>
      </AuthProvider>
    </SiteProvider>
  );
}
