import { useState, useEffect, useRef, useCallback } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import Header from './Header';
import Sidebar from './Sidebar';
import PlaybackDisabledBanner from './PlaybackDisabledBanner';
import { useAuth } from '../context/AuthContext';
import { apiGet } from '../api';

// Refetch reconcile (mirrors the admin CoursePage mergeRows idiom): when a
// refetch returns the same data, hand setCourses an Object.is-equal value so
// React bails and nothing re-renders. Two courses are "equal" on the fields the
// sidebar actually renders — anything else (add/remove/rename/new video) is a
// real change worth a re-render.
function coursesEqual(a, b) {
  return a.course_id === b.course_id
    && a.course_code === b.course_code
    && a.course_name === b.course_name
    && a.module_label === b.module_label
    && a.video_count === b.video_count
    && (a.last_video_at || null) === (b.last_video_at || null);
}
// A different length means a course was added or removed — return `next` wholesale.
// Otherwise keep the PREVIOUS object for every unchanged course, and return the
// PREVIOUS array reference when nothing changed at all (Object.is no-op → no render).
function mergeCourseList(prev, next) {
  if (!Array.isArray(prev) || prev.length !== next.length) return next;
  let changed = false;
  const merged = next.map((c, i) => {
    if (coursesEqual(prev[i], c)) return prev[i];
    changed = true;
    return c;
  });
  return changed ? merged : prev;
}

// Whole-site shell (account-portal style): a top bar (brand + avatar menu) over
// a body of [drill-in sidebar | content]. The sidebar's Courses pane is fed the
// enrolled-course list, refetched on first load and on every revisit to home so
// a course deactivated/deleted in admin drops out of the sidebar. The list (and
// its refetcher) are shared with the content via outlet context. Which sidebar
// pane shows is derived from the route (/admin/*).
export default function AppShell() {
  const location = useLocation();
  const { user } = useAuth();
  const [courses, setCourses] = useState(null); // null = loading

  // Stable identity (empty deps) so the effect below doesn't re-run every render —
  // an unstable fetcher there would be an infinite fetch loop. A network-failed
  // REFETCH keeps the current sidebar; only the very first load resolves to [].
  const refreshCourses = useCallback(() => {
    // A failed refetch must NOT wipe a good sidebar. api.js resolves an HTTP
    // error as { ok:false } WITHOUT throwing (a transient 5xx, or a Cloudflare
    // WAF 403 with an HTML body → data:null), so the success and failure paths
    // both live in .then; only a genuine first load (prev===null) may fall to [].
    const keepOrEmpty = prev => (prev === null ? [] : prev);
    apiGet('/api/courses')
      .then(({ data, ok }) => setCourses(prev =>
        ok && data?.courses ? mergeCourseList(prev, data.courses) : keepOrEmpty(prev)))
      .catch(() => setCourses(keepOrEmpty));
  }, []);

  // Fetch on first mount (any route), then refetch only when we land back on
  // home — the false->true transition of `atHome` catches "← back to courses"
  // and any nav home after admin deactivated a course.
  const atHome = location.pathname === '/';
  const didMount = useRef(false);
  useEffect(() => {
    if (!didMount.current) {
      didMount.current = true;
      refreshCourses();
      return;
    }
    if (atHome) refreshCourses();
  }, [atHome, refreshCourses]);

  const inAdmin = location.pathname.startsWith('/admin');

  // Remember the last course-area location (path + query, so the list page is
  // preserved) so the sidebar's "← Courses" back button restores exactly where
  // the user was before they went into Admin.
  const lastCourseRef = useRef('/');
  useEffect(() => {
    if (!inAdmin) lastCourseRef.current = location.pathname + location.search;
  }, [inAdmin, location.pathname, location.search]);

  const isPlaybackPage = location.pathname === '/'
    || location.pathname.startsWith('/course/')
    || location.pathname.startsWith('/watch/');
  const missingPlay = !!user && !user.permissions?.allowPlayback;
  // Material access is irrelevant on the video-playback page (no materials there),
  // so its message only applies on the course pages — never on /watch/*.
  const missingMat = !!user && !user.permissions?.accessAttachments && !location.pathname.startsWith('/watch/');
  const showBanner = (missingPlay || missingMat) && isPlaybackPage;

  // The new student pages (welcome + course view + watch) get an
  // account-portal-style max-width; the admin pages keep the full content
  // width for their tables. Theater mode lifts the cap via CSS on the watch page.
  // The admin Courses pages (list + drilled-in course) mirror the student
  // course view, so they get the same cap — but ONLY /admin/courses*, not the
  // other (intentionally full-width) /admin pages.
  const capped = location.pathname === '/'
    || location.pathname.startsWith('/course/')
    || location.pathname.startsWith('/watch/')
    || location.pathname.startsWith('/admin/courses')
    || location.pathname.startsWith('/admin/users')
    || location.pathname.startsWith('/admin/enrollment');
  const body = (
    <>
      {showBanner && <PlaybackDisabledBanner playback={missingPlay} materials={missingMat} />}
      <Outlet context={{ courses, refreshCourses }} />
    </>
  );

  return (
    <>
      <Header onBrand={refreshCourses} />
      <div className="vs-body">
        <Sidebar courses={courses} inAdmin={inAdmin} backRef={lastCourseRef} />
        <main className="vs-content">
          {capped ? <div className="vs-content-inner">{body}</div> : body}
        </main>
      </div>
    </>
  );
}
