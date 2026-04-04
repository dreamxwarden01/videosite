import { useState, useEffect } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import Header from './Header';
import Sidebar from './Sidebar';
import Footer from './Footer';

export default function AppShell() {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const location = useLocation();

  const hasSidebar = location.pathname.startsWith('/admin') || location.pathname === '/profile';
  const isWatchPage = location.pathname.startsWith('/watch/');

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
          <Outlet />
        </main>
      ) : (
        <>
          <main className="container">
            <Outlet />
          </main>
          <Footer />
        </>
      )}
    </>
  );
}
