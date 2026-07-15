import { useEffect, useRef, useState } from 'react';
import { NavLink, Link, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import {
  CoursesIcon,
  EnrollmentIcon,
  UsersIcon,
  RolesIcon,
  TranscodingIcon,
  SettingsIcon,
} from './SidebarIcons';

// Admin nav (pane 2 of the drill rail). Same permission gates as before.
const ADMIN = [
  { to: '/admin/courses', label: 'Courses', Icon: CoursesIcon, perm: 'manageCourse' },
  { to: '/admin/enrollment', label: 'Enrollment', Icon: EnrollmentIcon, perm: 'manageEnrolment' },
  { to: '/admin/users', label: 'Users', Icon: UsersIcon, perm: 'manageUser' },
  { to: '/admin/roles', label: 'Roles', Icon: RolesIcon, perm: 'manageRoles' },
  { to: '/admin/transcoding', label: 'Transcoding', Icon: TranscodingIcon, perm: 'manageSite' },
  { to: '/admin/settings', label: 'Settings', Icon: SettingsIcon, perm: 'manageSite' },
];

const BookIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
    <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" /><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
  </svg>
);
const AdminIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
    <line x1="4" y1="6" x2="20" y2="6" /><line x1="4" y1="12" x2="20" y2="12" /><line x1="4" y1="18" x2="20" y2="18" />
    <circle cx="9" cy="6" r="2" fill="currentColor" stroke="none" /><circle cx="15" cy="12" r="2" fill="currentColor" stroke="none" /><circle cx="9" cy="18" r="2" fill="currentColor" stroke="none" />
  </svg>
);
const ChevronRight = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m9 18 6-6-6-6" /></svg>
);
const ChevronDown = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m6 9 6 6 6-6" /></svg>
);
const ArrowLeft = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="m12 19-7-7 7-7" /><path d="M19 12H5" /></svg>
);

// The whole-site drill rail. On desktop it's the full left rail: a Courses pane
// (enrolled list, scrollable, Admin entry pinned) that slides to an Admin pane.
// On narrow screens it collapses to a single bar showing the current course /
// admin page; tapping it drops the full list down (route-driven pane, same as
// desktop). Selecting an item (or a route change) re-collapses it.
export default function Sidebar({ courses, inAdmin, backRef }) {
  const { user } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const [expanded, setExpanded] = useState(false);
  const ref = useRef(null);

  useEffect(() => { setExpanded(false); }, [location.pathname]);
  useEffect(() => {
    if (!expanded) return undefined;
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setExpanded(false); };
    document.addEventListener('click', onDoc);
    return () => document.removeEventListener('click', onDoc);
  }, [expanded]);

  if (!user) return null;

  const perms = user.permissions || {};
  const adminLinks = ADMIN.filter((l) => (l.any ? l.any.some((p) => perms[p]) : perms[l.perm]));
  const hasAdmin = adminLinks.length > 0;
  const firstAdmin = adminLinks[0]?.to || '/admin/courses';

  // Collapsed-bar context (narrow only).
  let curLabel, CurIcon, moreCount;
  if (inAdmin) {
    const active = adminLinks.find((l) => location.pathname.startsWith(l.to));
    curLabel = active ? active.label : 'Admin';
    CurIcon = active ? active.Icon : AdminIcon;
    moreCount = Math.max(0, adminLinks.length - (active ? 1 : 0));
  } else {
    const m = location.pathname.match(/^\/course\/([^/]+)/);
    const cur = m && courses ? courses.find((c) => String(c.course_id) === m[1]) : null;
    curLabel = cur ? cur.course_code : 'Courses';
    CurIcon = BookIcon;
    moreCount = courses ? Math.max(0, courses.length - (cur ? 1 : 0)) : 0;
  }

  return (
    <nav className={'vs-side' + (expanded ? ' expanded' : '')} ref={ref}>
      <button
        className="vs-side-collapsed"
        aria-expanded={expanded}
        onClick={(e) => { e.stopPropagation(); setExpanded((v) => !v); }}
      >
        <span className="vs-nav-ico"><CurIcon /></span>
        <span className="vs-cc-label">{curLabel}</span>
        {moreCount > 0 && <span className="vs-cc-more">+{moreCount} more</span>}
        <span className="vs-cc-chev"><ChevronDown /></span>
      </button>

      <div className={'vs-side-track' + (inAdmin ? ' admin' : '')}>
        {/* Courses pane */}
        <div className="vs-side-pane">
          <div className="vs-side-label">Courses</div>
          <div className="vs-nav-scroll">
            {courses === null ? (
              Array.from({ length: 6 }).map((_, i) => <div key={i} className="vs-nav-skel" />)
            ) : courses.length === 0 ? (
              <p className="vs-side-empty">You aren&rsquo;t enrolled in any courses yet.</p>
            ) : (
              courses.map((c) => (
                <NavLink
                  key={c.course_id}
                  to={`/course/${c.course_id}`}
                  className={({ isActive }) => 'vs-nav' + (isActive ? ' active' : '')}
                  title={c.course_name || c.course_code}
                >
                  <span className="vs-nav-ico"><BookIcon /></span>
                  <span className="vs-nav-label">{c.course_code}</span>
                </NavLink>
              ))
            )}
          </div>
          {hasAdmin && (
            <div className="vs-admin-entry">
              <Link to={firstAdmin} className="vs-nav">
                <span className="vs-nav-ico"><AdminIcon /></span>
                <span className="vs-nav-label">Admin</span>
                <span className="vs-nav-chev"><ChevronRight /></span>
              </Link>
            </div>
          )}
        </div>

        {/* Admin pane */}
        <div className="vs-side-pane">
          <button
            type="button"
            className="vs-nav vs-nav-back"
            onClick={() => navigate((backRef && backRef.current) || '/')}
          >
            <span className="vs-nav-ico"><ArrowLeft /></span>
            <span className="vs-nav-label">Courses</span>
          </button>
          <div className="vs-nav-scroll">
            {adminLinks.map((l) => (
              <NavLink
                key={l.to}
                to={l.to}
                className={({ isActive }) => 'vs-nav' + (isActive ? ' active' : '')}
              >
                <span className="vs-nav-ico"><l.Icon /></span>
                <span className="vs-nav-label">{l.label}</span>
              </NavLink>
            ))}
          </div>
        </div>
      </div>
    </nav>
  );
}
