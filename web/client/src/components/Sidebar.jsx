import { NavLink } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import {
  ProfileIcon,
  MaterialsIcon,
  VideosIcon,
  CoursesIcon,
  EnrollmentIcon,
  UsersIcon,
  InvitationIcon,
  RolesIcon,
  StatsIcon,
  TranscodingIcon,
  SettingsIcon,
  MfaIcon,
} from './SidebarIcons';

const links = [
  { to: '/profile', label: 'Profile', Icon: ProfileIcon, permission: null },
  { to: '/admin/materials', label: 'Materials', Icon: MaterialsIcon, permission: 'accessAttachments' },
  { to: '/admin/videos', label: 'Videos', Icon: VideosIcon, permissionAny: ['uploadVideo', 'changeVideo'] },
  { to: '/admin/courses', label: 'Courses', Icon: CoursesIcon, permission: 'manageCourse' },
  { to: '/admin/enrollment', label: 'Enrollment', Icon: EnrollmentIcon, permission: 'manageEnrolment' },
  { to: '/admin/users', label: 'Users', Icon: UsersIcon, permission: 'manageUser' },
  { to: '/admin/invitations', label: 'Invitation Codes', Icon: InvitationIcon, permission: 'inviteUser' },
  { to: '/admin/roles', label: 'Roles', Icon: RolesIcon, permission: 'manageRoles' },
  { to: '/admin/playback-stats', label: 'Playback Stats', Icon: StatsIcon, permission: 'viewPlaybackStat' },
  { to: '/admin/transcoding', label: 'Transcoding', Icon: TranscodingIcon, permission: 'manageSite' },
  { to: '/admin/settings', label: 'Settings', Icon: SettingsIcon, permission: 'manageSite' },
  { to: '/admin/mfa-settings', label: 'MFA Settings', Icon: MfaIcon, permission: 'manageSiteMFA' },
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
          const Icon = link.Icon;
          return (
            <NavLink
              key={link.to}
              to={link.to}
              className={({ isActive }) => `sidebar-link${isActive ? ' active' : ''}`}
              onClick={onClose}
            >
              <span className="sidebar-icon"><Icon /></span> {link.label}
            </NavLink>
          );
        })}
      </nav>
    </aside>
  );
}
