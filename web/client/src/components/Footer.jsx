import { useSite } from '../context/SiteContext';

export default function Footer() {
  const { siteName } = useSite();

  return (
    <footer className="site-footer">
      <div className="footer-inner">
        <span>&copy; {new Date().getFullYear()} {siteName}</span>
      </div>
    </footer>
  );
}
