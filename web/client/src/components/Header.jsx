import { useState, useRef, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useSite } from '../context/SiteContext';
import Avatar from './Avatar';

// The account-portal-style top bar: brand (mark + site name) on the left,
// avatar dropdown on the right. Navigation lives entirely in the sidebar now,
// so the header carries no links or hamburger.
export default function Header({ onBrand }) {
  const { user, logout, refresh } = useAuth();
  const { siteName } = useSite();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef(null);

  useEffect(() => {
    if (!menuOpen) return undefined;
    function handleClick(e) {
      if (menuRef.current && !menuRef.current.contains(e.target)) setMenuOpen(false);
    }
    function handleKey(e) {
      if (e.key === 'Escape') setMenuOpen(false);
    }
    document.addEventListener('click', handleClick);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('click', handleClick);
      document.removeEventListener('keydown', handleKey);
    };
  }, [menuOpen]);

  // Clicking the site title is a "start fresh" gesture — drop the per-course
  // pagination memory so every course opens on page 1 again.
  const clearCoursePages = () => {
    try {
      Object.keys(sessionStorage).forEach((k) => { if (k.startsWith('course:')) sessionStorage.removeItem(k); });
    } catch { /* sessionStorage unavailable — nothing to clear */ }
  };

  const name = user?.display_name || user?.username || '';

  return (
    <header className="vs-topbar">
      <Link to="/" className="vs-brand" onClick={() => { clearCoursePages(); onBrand?.(); refresh?.(); }}>
        <span className="vs-brand-mark" aria-hidden="true">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>
        </span>
        <span className="vs-brand-name">{siteName}</span>
      </Link>
      {user && (
        <div className="vs-topbar-right">
          <div className="vs-pmenu" ref={menuRef}>
            <button
              className="vs-pmenu-trigger"
              aria-label="Profile menu"
              aria-expanded={menuOpen}
              aria-haspopup="true"
              onClick={(e) => { e.stopPropagation(); setMenuOpen((v) => !v); }}
            >
              <span className="vs-pmenu-uname">{name}</span>
              <Avatar user={user} name={name} className="vs-pmenu-av-sm" />
            </button>
            {menuOpen && (
              <div className="vs-pmenu-panel">
                <div className="vs-pmenu-top">
                  <span className="vs-pmenu-org">{user.org_name || ''}</span>
                  <button className="vs-pmenu-signout" onClick={logout}>Sign out</button>
                </div>
                <div className="vs-pmenu-body">
                  <Avatar user={user} name={name} className="vs-pmenu-av" />
                  <div className="vs-pmenu-info">
                    <p className="vs-pmenu-name">{name}</p>
                    {user.email && <p className="vs-pmenu-email">{user.email}</p>}
                    {user.account_portal && (
                      <a className="vs-pmenu-link" href={user.account_portal} target="_blank" rel="noreferrer">
                        View account
                      </a>
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </header>
  );
}
