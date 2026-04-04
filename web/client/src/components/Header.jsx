import { useState, useRef, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useSite } from '../context/SiteContext';

export default function Header({ onToggleSidebar, hasSidebar }) {
  const { user, logout } = useAuth();
  const { siteName } = useSite();
  const [navOpen, setNavOpen] = useState(false);
  const navRef = useRef(null);
  const btnRef = useRef(null);

  useEffect(() => {
    function handleClick(e) {
      if (navRef.current && !navRef.current.contains(e.target) &&
          btnRef.current && !btnRef.current.contains(e.target)) {
        setNavOpen(false);
      }
    }
    document.addEventListener('click', handleClick);
    return () => document.removeEventListener('click', handleClick);
  }, []);

  return (
    <header className="top-header">
      <div className="header-inner">
        <Link to="/" className="logo">{siteName}</Link>
        {user ? (
          <>
            <div className="header-buttons">
              <button
                className="header-icon-btn"
                ref={btnRef}
                aria-label="Profile menu"
                aria-expanded={navOpen}
                onClick={(e) => { e.stopPropagation(); setNavOpen(v => !v); }}
              >
                <svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <circle cx="10" cy="7" r="3" stroke="currentColor" strokeWidth="1.6" fill="none"/>
                  <path d="M3.5 17c0-3.3 2.9-5.5 6.5-5.5s6.5 2.2 6.5 5.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" fill="none"/>
                </svg>
              </button>
              {hasSidebar && (
                <button
                  className="header-icon-btn sidebar-hamburger"
                  aria-label="Navigation menu"
                  onClick={(e) => { e.stopPropagation(); setNavOpen(false); onToggleSidebar?.(); }}
                  style={{ display: 'flex' }}
                >
                  <span></span><span></span><span></span>
                </button>
              )}
            </div>
            <nav className={`header-nav${navOpen ? ' open' : ''}`} ref={navRef}>
              <Link to="/profile" onClick={() => setNavOpen(false)}>{user.display_name}</Link>
              <button type="button" className="btn-link" onClick={logout}>Sign Out</button>
            </nav>
          </>
        ) : (
          <nav className="header-nav">
            <Link to="/login">Sign In</Link>
          </nav>
        )}
      </div>
    </header>
  );
}
