import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import Header from '../components/Header';
import { useSite } from '../context/SiteContext';

export default function NotFoundPage() {
  const { siteName } = useSite();

  useEffect(() => {
    if (!siteName) return;
    document.title = `Not Found - ${siteName}`;
  }, [siteName]);

  return (
    <>
      <Header hasSidebar={false} />
      <main className="container" style={{ textAlign: 'center', paddingTop: '80px' }}>
        <h1>404</h1>
        <p style={{ color: '#6b7280', marginBottom: '24px' }}>The page you are looking for does not exist.</p>
        <Link to="/" className="btn btn-primary">Go Home</Link>
      </main>
    </>
  );
}
