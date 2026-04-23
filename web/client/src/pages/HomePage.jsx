import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useSite } from '../context/SiteContext';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { apiGet } from '../api';
import LoadingSpinner from '../components/LoadingSpinner';

export default function HomePage() {
  const { siteName } = useSite();
  const { user, refresh } = useAuth();
  const { showToast } = useToast();
  const [courses, setCourses] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    document.title = siteName;
  }, [siteName]);

  // Clear any saved course pagination state — user navigated away from a course
  useEffect(() => {
    Object.keys(sessionStorage).forEach(key => {
      if (key.startsWith('course:') && key.endsWith(':list')) sessionStorage.removeItem(key);
    });
  }, []);

  // If the user currently has no playback permission, re-fetch /api/me on
  // every visit to the course list. Admins can grant the permission at any
  // time; this gives the banner + greyout a chance to clear without the
  // user having to sign out and back in. We intentionally don't poll when
  // permission is already true — no upside, just extra requests.
  useEffect(() => {
    if (user && user.permissions?.allowPlayback === false) {
      refresh();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const { data, ok } = await apiGet('/api/courses');
        if (ok && data) setCourses(data.courses || []);
      } catch {
        showToast('Failed to load courses.');
      }
      setLoading(false);
    })();
  }, []);

  return (
    <div className="card card-page">
      <div className="card-header">
        <h2>My Courses</h2>
        {!loading && (
          <span className="text-muted text-sm">
            {courses.length} course{courses.length !== 1 ? 's' : ''}
          </span>
        )}
      </div>
      <div className={`card-body${loading ? ' data-loading' : ''}`}>
        {loading ? (
          <div style={{ minHeight: '120px' }}><LoadingSpinner /></div>
        ) : courses.length === 0 ? (
          <p className="text-muted">
            No courses available.
            {user && !user.permissions?.allCourseAccess && ' You are not enrolled in any courses yet.'}
          </p>
        ) : (
          <div className="course-grid">
            {courses.map(course => (
              <Link to={`/course/${course.course_id}`} key={course.course_id} className="course-card">
                <h3>{course.course_name}</h3>
                <p className="course-meta">
                  {course.video_count} video{course.video_count !== 1 ? 's' : ''}
                </p>
                {course.description && (
                  <p className="text-muted mt-1" style={{ fontSize: '13px', marginTop: '8px' }}>
                    {course.description.length > 120 ? course.description.substring(0, 120) + '...' : course.description}
                  </p>
                )}
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
