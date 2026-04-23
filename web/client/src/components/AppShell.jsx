import { useState, useEffect } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import Header from './Header';
import Sidebar from './Sidebar';
import Footer from './Footer';
import PlaybackDisabledBanner from './PlaybackDisabledBanner';
import { useAuth } from '../context/AuthContext';

export default function AppShell() {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const location = useLocation();
  const { user } = useAuth();

  const hasSidebar = location.pathname.startsWith('/admin') || location.pathname === '/profile';
  const isWatchPage = location.pathname.startsWith('/watch/');

  // Banner only on the pages where the playback restriction is user-facing:
  // course list, per-course video list, and the watch page itself.
  // Admin/profile pages keep their normal chrome.
  const isPlaybackPage = location.pathname === '/'
    || location.pathname.startsWith('/course/')
    || isWatchPage;
  const showPlaybackBanner = !!user
    && user.permissions?.allowPlayback === false
    && isPlaybackPage;

  // Close sidebar on route change
  useEffect(() => {
    setSidebarOpen(false);
  }, [location.pathname]);

  // Close sidebar on outside click
  useEffect(() => {
    function handleClick(e) {
      if (sidebarOpen) {
        const sidebar = document.getElementById('adminSidebar');
        const hamburger = document.querySelector('.sidebar-hamburger');
        if (sidebar && !sidebar.contains(e.target) && hamburger && !hamburger.contains(e.target)) {
          setSidebarOpen(false);
        }
      }
    }
    document.addEventListener('click', handleClick);
    return () => document.removeEventListener('click', handleClick);
  }, [sidebarOpen]);

  return (
    <>
      <Header
        hasSidebar={hasSidebar}
        onToggleSidebar={() => setSidebarOpen(v => !v)}
      />
      {hasSidebar ? (
        <>
          <div className="admin-layout">
            <Sidebar open={sidebarOpen} onClose={() => setSidebarOpen(false)} />
            <div className="admin-content">
              <Outlet />
            </div>
          </div>
          <Footer />
        </>
      ) : isWatchPage ? (
        <main className="container container-player">
          {showPlaybackBanner && <PlaybackDisabledBanner />}
          <Outlet />
        </main>
      ) : (
        <>
          <main className="container">
            {showPlaybackBanner && <PlaybackDisabledBanner />}
            <Outlet />
          </main>
          <Footer />
        </>
      )}
    </>
  );
}
