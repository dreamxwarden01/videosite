import { useEffect } from 'react';
import { useOutletContext } from 'react-router-dom';
import { useSite } from '../context/SiteContext';
import { useAuth } from '../context/AuthContext';

// Landing shown at "/" — no course selected yet. The courses live in the
// sidebar, so this is a calm welcome that points the user there.
export default function HomePage() {
  const { siteName } = useSite();
  const { user } = useAuth();
  const { courses } = useOutletContext() ?? {};

  useEffect(() => {
    if (siteName) document.title = siteName;
  }, [siteName]);

  const first = (user?.display_name || user?.username || '').trim().split(/\s+/)[0];
  const noCourses = Array.isArray(courses) && courses.length === 0;

  return (
    <div className="vs-welcome">
      <svg className="vs-welcome-ico" width="52" height="52" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M5 4m0 1a1 1 0 0 1 1 -1h2a1 1 0 0 1 1 1v14a1 1 0 0 1 -1 1h-2a1 1 0 0 1 -1 -1z" />
        <path d="M9 4m0 1a1 1 0 0 1 1 -1h2a1 1 0 0 1 1 1v14a1 1 0 0 1 -1 1h-2a1 1 0 0 1 -1 -1z" />
        <path d="M5 8h4" />
        <path d="M9 16h4" />
        <path d="M13.803 4.56l2.184 -.53c.562 -.135 1.133 .19 1.282 .732l3.695 13.418a1.02 1.02 0 0 1 -.634 1.219l-.133 .041l-2.184 .53c-.562 .135 -1.133 -.19 -1.282 -.732l-3.695 -13.418a1.02 1.02 0 0 1 .634 -1.219l.133 -.041z" />
        <path d="M14 9l4 -1" />
        <path d="M16 16l3.923 -.98" />
      </svg>
      <h1>{first ? `Welcome back, ${first}` : `Welcome to ${siteName || 'your media center'}`}</h1>
      <p>
        {noCourses
          ? 'You aren’t enrolled in any courses yet. Once you are, they’ll appear in the sidebar and you can start watching here.'
          : 'Choose a course from the sidebar to pick up your lectures and materials.'}
      </p>
    </div>
  );
}
