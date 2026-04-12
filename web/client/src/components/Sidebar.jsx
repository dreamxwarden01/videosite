import { NavLink } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

const links = [
  { to: '/profile', label: 'Profile', icon: '\u{1F464}', permission: null },
  { to: '/admin/materials', label: 'Materials', icon: '\u{1F5C2}\uFE0F', permission: 'accessAttachments' },
  { to: '/admin/videos', label: 'Videos', icon: '\u{1F3AC}', permissionAny: ['uploadVideo', 'changeVideo'] },
  { to: '/admin/courses', label: 'Courses', icon: '\u{1F4DA}', permission: 'manageCourse' },
  { to: '/admin/enrollment', label: 'Enrollment', icon: '\u{1F4CB}', permission: 'manageEnrolment' },
  { to: '/admin/users', label: 'Users', icon: '\u{1F465}', permission: 'manageUser' },
  { to: '/admin/invitations', label: 'Invitation Codes', icon: '\u{1F511}', permission: 'inviteUser' },
  { to: '/admin/roles', label: 'Roles', icon: '\u{1F510}', permission: 'manageRoles' },
  { to: '/admin/playback-stats', label: 'Playback Stats', icon: '\u{1F4CA}', permission: 'viewPlaybackStat' },
  { to: '/admin/transcoding', label: 'Transcoding', icon: '\u2699', permission: 'manageSite' },
  { to: '/admin/settings', label: 'Settings', icon: '\u2699', permission: 'manageSite' },
  { to: '/admin/mfa-settings', label: 'MFA Settings', icon: '\uD83D\uDD12', permission: 'manageSiteMFA' },
];

export default function Sidebar({ open, onClose }) {
  const { user } = useAuth();
  if (!user) return null;

  const perms = user.permissions || {};

  return (
    <aside className={`sidebar${open ? ' open' : ''}`} id="adminSidebar">
      <nav className="sidebar-nav">
        {links.map(link => {
          if (link.permissionAny) {
            if (!link.permissionAny.some(p => perms[p])) return null;
          } else if (link.permission && !perms[link.permission]) return null;
          return (
            <NavLink
              key={link.to}
              to={link.to}
              className={({ isActive }) => `sidebar-link${isActive ? ' active' : ''}`}
              onClick={onClose}
            >
              <span className="sidebar-icon">{link.icon}</span> {link.label}
            </NavLink>
          );
        })}
      </nav>
    </aside>
  );
}
