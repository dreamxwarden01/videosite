import { useState, useEffect, useCallback, useRef } from 'react';
import { useSite } from '../../context/SiteContext';
import { useAuth } from '../../context/AuthContext';
import { useToast } from '../../context/ToastContext';
import { useConfirm } from '../../components/ConfirmModal';
import useStepupGuard from '../../hooks/useStepupGuard';
import StepUpBlock from '../../components/StepUpBlock';
import { apiGet, apiPost } from '../../api';
import Avatar from '../../components/Avatar';
import VsSaveBar from '../../components/VsSaveBar';

const SearchIcon = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></svg>;
const XIcon = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6 6 18" /><path d="m6 6 12 12" /></svg>;
const ChevronR = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m9 18 6-6-6-6" /></svg>;
const ChevronL = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m15 18-6-6 6-6" /></svg>;

export default function EnrollmentPage() {
  const { siteName } = useSite();
  const { user } = useAuth();
  const { showToast } = useToast();
  const confirm = useConfirm();

  const { blocked, guardFetch, verify, guardAction } = useStepupGuard('enrollment');

  // Base data (students + active/enrolled courses), loaded once through the
  // page-level MFA gate. Both arrive pre-sorted from the server.
  const [students, setStudents] = useState([]);
  const [courses, setCourses] = useState([]);
  const [loading, setLoading] = useState(true);

  // Selection + this student's enrollment truth + the staged deltas.
  const [selectedId, setSelectedId] = useState(null);
  const [enrolled, setEnrolled] = useState(null); // Set<int> | null (null = still loading)
  const [staged, setStaged] = useState(new Map()); // Map<courseId, 'add' | 'remove'>
  const [busy, setBusy] = useState(false);

  // Client-side filters (both lists are already fully loaded).
  const [query, setQuery] = useState('');
  const [availQuery, setAvailQuery] = useState('');

  // Guards a late ?userId= response against a newer selection.
  const reqRef = useRef(0);

  useEffect(() => {
    if (!siteName) return;
    document.title = `Enrollment - ${siteName}`;
  }, [siteName]);

  // Base load through the page-level MFA gate; re-runs after a page-level
  // verification (mfaVerifiedKey).
  const fetchBase = useCallback(async () => {
    try {
      const { data, ok } = await guardFetch('/api/admin/enrollment');
      if (ok && data) {
        setStudents(data.students || []);
        setCourses(data.courses || []);
      }
    } catch {
      showToast('Failed to load enrollment.');
    } finally {
      setLoading(false);
    }
  }, [guardFetch]);

  useEffect(() => {
    fetchBase();
  }, [fetchBase]);

  if (!user?.permissions?.manageEnrolment) {
    return <p className="text-muted">Permission denied.</p>;
  }

  const coursesById = new Map(courses.map((c) => [c.course_id, c]));
  const selectedStudent = selectedId ? students.find((s) => s.user_id === selectedId) : null;

  // Effective enrollment folds the staged deltas over the server truth.
  const effectiveEnrolled = (id) => {
    const st = staged.get(id);
    if (st === 'add') return true;
    if (st === 'remove') return false;
    return enrolled ? enrolled.has(id) : false;
  };

  // Both derived lists preserve the server's order (course_code, course_id).
  // Enrolled = effectively-enrolled PLUS anything staged for removal (so a
  // staged removal — including an INACTIVE course that can't reappear under
  // Available — keeps a reachable Undo control). Available = active-only, not
  // effectively enrolled, and NOT staged-remove (those show under Enrolled), so
  // no course ever appears in both panes.
  const enrolledList = enrolled ? courses.filter((c) => effectiveEnrolled(c.course_id) || staged.get(c.course_id) === 'remove') : [];
  const availableBase = enrolled ? courses.filter((c) => c.is_active === 1 && !effectiveEnrolled(c.course_id) && staged.get(c.course_id) !== 'remove') : [];
  // "N enrolled" = the post-save count (staged adds in, staged removes out), so
  // the number previews what Save will produce as changes are staged.
  const effectiveCount = enrolled ? courses.filter((c) => effectiveEnrolled(c.course_id)).length : 0;
  const aq = availQuery.trim().toLowerCase();
  const availableList = aq
    ? availableBase.filter((c) =>
      (c.course_code || '').toLowerCase().includes(aq) ||
      (c.course_name || '').toLowerCase().includes(aq))
    : availableBase;

  const q = query.trim().toLowerCase();
  const filteredStudents = q
    ? students.filter((s) =>
      (s.display_name || '').toLowerCase().includes(q) ||
      (s.username || '').toLowerCase().includes(q))
    : students;

  // Switch the selected student. Unsaved staged changes must be confirmed away
  // first; on switch we clear the deltas and re-read the server truth via the
  // modal MFA fetcher.
  const pickStudent = async (id) => {
    if (busy || id === selectedId) return;
    if (staged.size > 0) {
      const ok = await confirm({ title: 'Discard unsaved changes?', message: `${staged.size} staged enrollment change${staged.size === 1 ? '' : 's'} will be lost.`, confirmLabel: 'Discard', danger: true });
      if (!ok) return;
    }
    const token = ++reqRef.current;
    setSelectedId(id);
    setStaged(new Map());
    setEnrolled(null);
    setAvailQuery('');
    try {
      const { ok, data } = await apiGet(`/api/admin/enrollment?userId=${id}`);
      if (reqRef.current !== token) return; // superseded by a newer selection
      if (ok && data) {
        setEnrolled(new Set(data.enrolledCourseIds || []));
      } else {
        showToast(data?.error || 'Failed to load enrollment.');
        setEnrolled(new Set());
      }
    } catch (err) {
      if (reqRef.current !== token) return;
      showToast(err.message);
      setEnrolled(new Set());
    }
  };

  // Mobile back: deselect to return to the student list (desktop shows the
  // "select a student" placeholder). Same unsaved-changes guard as a switch.
  const backToList = async () => {
    if (busy) return;
    if (staged.size > 0) {
      const ok = await confirm({ title: 'Discard unsaved changes?', message: `${staged.size} staged enrollment change${staged.size === 1 ? '' : 's'} will be lost.`, confirmLabel: 'Discard', danger: true });
      if (!ok) return;
    }
    setSelectedId(null);
    setStaged(new Map());
    setEnrolled(null);
    setAvailQuery('');
  };

  // One toggle for both buttons: a course's SERVER-enrolled state decides the
  // delta, and re-toggling clears it — so any staged change is reversible from
  // its own row (a staged removal stays visible under Enrolled; a staged add
  // stays visible there too). No delta ever stacks.
  const toggleCourse = (id) => {
    setStaged((prev) => {
      const next = new Map(prev);
      const cur = next.get(id);
      if (cur) { next.delete(id); return next; }          // any staged delta → undo
      if (enrolled && enrolled.has(id)) next.set(id, 'remove');
      else next.set(id, 'add');
      return next;
    });
  };

  // One atomic batch commit. On success the server returns the new enrollment
  // truth, which becomes the fresh baseline and clears the deltas.
  const handleSave = async () => {
    if (!selectedId || staged.size === 0) return;
    const adds = [];
    const removes = [];
    for (const [id, tone] of staged) {
      if (tone === 'add') adds.push(id);
      else removes.push(id);
    }
    setBusy(true);
    try {
      const { ok, data } = await apiPost('/api/admin/enrollment/batch', { userId: selectedId, adds, removes });
      if (ok && data) {
        setEnrolled(new Set(data.enrolledCourseIds || []));
        setStaged(new Map());
        showToast('Enrollment updated.', 'success');
      } else {
        showToast(data?.error || 'Failed to update enrollment.');
      }
    } catch (err) {
      showToast(err.message);
    } finally {
      setBusy(false);
    }
  };

  // Save-bar tags, sorted by course_code (then id) for a stable order.
  const saveItems = [...staged.entries()]
    .map(([id, tone]) => ({ id, tone, code: coursesById.get(id)?.course_code || '' }))
    .sort((a, b) => a.code.localeCompare(b.code) || a.id - b.id)
    .map(({ code, tone }) => ({ label: code, tone }));

  const renderCourseRow = (c, kind) => {
    const st = staged.get(c.course_id);
    const cls = 'vs-cv-row' + (st === 'add' ? ' staged-add' : st === 'remove' ? ' staged-remove' : '');
    return (
      <div key={c.course_id} className={cls}>
        <div className="vs-cv-rmn">
          <p className="vs-cv-rt vs-cs-line" title={c.course_name || c.course_code}>
            <span className="vs-cs-code">{c.course_code}</span>
            {c.course_name ? <span className="vs-cs-name">{c.course_name}</span> : null}
          </p>
        </div>
        {kind === 'enrolled' ? (
          <button className={'vs-btn vs-btn-sm' + (st ? '' : ' vs-btn-danger')} onClick={() => toggleCourse(c.course_id)}>{st ? 'Undo' : 'Remove'}</button>
        ) : (
          <button className="vs-btn vs-btn-sm" onClick={() => toggleCourse(c.course_id)}>{st === 'add' ? 'Undo' : 'Add'}</button>
        )}
      </div>
    );
  };

  return (
    <>
      <h1 className="vs-cv-title" style={{ marginBottom: 18 }}>Enrollment</h1>
        {loading ? (
          <div className="vs-enroll"><div className="vs-enroll-sel" /><div className="vs-enroll-pane" /></div>
        ) : blocked ? (
          <div className="vs-enroll"><div className="vs-enroll-pane"><StepUpBlock onVerify={verify} /></div></div>
        ) : (
      <div className={'vs-enroll' + (selectedId ? ' has-selection' : '') + (staged.size > 0 ? ' has-staged' : '')}>
        {/* LEFT — student selector (search + list; allCourseAccess users are
            excluded server-side). */}
        <div className="vs-enroll-sel">
          <div className="vs-enroll-sel-head">
            <div className="vs-search">
              <span className="vs-search-ico"><SearchIcon /></span>
              <input
                className="vs-input"
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search students"
                autoComplete="off"
                spellCheck={false}
              />
              {query && (
                <button type="button" className="vs-search-clear" onClick={() => setQuery('')} aria-label="Clear search"><XIcon /></button>
              )}
            </div>
          </div>
          <div className="vs-enroll-sel-list">
            {filteredStudents.length === 0 ? (
              <div className="vs-cv-empty">{students.length === 0 ? 'No students.' : 'No students match your search.'}</div>
            ) : (
              filteredStudents.map((s) => (
                <div
                  key={s.user_id}
                  className={'vs-enroll-srow' + (s.user_id === selectedId ? ' on' : '')}
                  onClick={() => pickStudent(s.user_id)}
                >
                  <Avatar user={s} name={s.display_name || s.username} className="vs-cv-av" />
                  <div className="vs-cv-rmn">
                    <p className="vs-cv-rt">{s.display_name || s.username}</p>
                    <p className="vs-cv-rs">@{s.username}</p>
                  </div>
                  <span className="vs-enroll-chev"><ChevronR /></span>
                </div>
              ))
            )}
          </div>
        </div>

        {/* RIGHT — detail pane (user bar + enrolled/available + save bar). */}
        <div className="vs-enroll-pane">
          <div className="vs-enroll-scroll">
            {!selectedStudent ? (
              <div className="vs-enroll-empty">Select a student</div>
            ) : (
              <>
                <button type="button" className="vs-enroll-back" onClick={backToList}><ChevronL /> Students</button>
                <div className="vs-edit-head">
                  <Avatar user={selectedStudent} name={selectedStudent.display_name || selectedStudent.username} className="vs-pmenu-av" />
                  <div className="vs-edit-idn">
                    <p className="vs-edit-name">{selectedStudent.display_name || selectedStudent.username}</p>
                    <p className="vs-edit-sub">@{selectedStudent.username}</p>
                  </div>
                  {enrolled && (
                    <div className="vs-enroll-count">
                      <div className="vs-enroll-count-n">{effectiveCount}</div>
                      <div className="vs-enroll-count-l">enrolled</div>
                    </div>
                  )}
                </div>

                {enrolled === null ? (
                  <div className="vs-cv-empty">Loading…</div>
                ) : (
                  <>
                    <div className="vs-pane-h">Enrolled courses</div>
                    <p className="vs-pane-sub">Courses this student can access. Remove to stage a change.</p>
                    <div className="vs-cv-card">
                      {enrolledList.length === 0 ? (
                        <div className="vs-cv-empty">No courses yet.</div>
                      ) : (
                        enrolledList.map((c) => renderCourseRow(c, 'enrolled'))
                      )}
                    </div>

                    <div className="vs-pane-h" style={{ marginTop: 22 }}>Available courses</div>
                    <p className="vs-pane-sub">Active courses this student is not enrolled in. Add to stage a change.</p>
                    {availableBase.length > 6 && (
                      <div className="vs-search">
                        <span className="vs-search-ico"><SearchIcon /></span>
                        <input
                          className="vs-input"
                          type="text"
                          value={availQuery}
                          onChange={(e) => setAvailQuery(e.target.value)}
                          placeholder="Filter courses"
                          autoComplete="off"
                          spellCheck={false}
                        />
                        {availQuery && (
                          <button type="button" className="vs-search-clear" onClick={() => setAvailQuery('')} aria-label="Clear filter"><XIcon /></button>
                        )}
                      </div>
                    )}
                    <div className="vs-cv-card">
                      {availableList.length === 0 ? (
                        <div className="vs-cv-empty">{aq ? 'No courses match your filter.' : 'No available courses.'}</div>
                      ) : (
                        availableList.map((c) => renderCourseRow(c, 'available'))
                      )}
                    </div>
                  </>
                )}

                <VsSaveBar
                  visible={staged.size > 0}
                  busy={busy}
                  items={saveItems}
                  onSave={() => guardAction(handleSave)}
                  onDiscard={() => setStaged(new Map())}
                  saveLabel="Save changes"
                />
              </>
            )}
          </div>
        </div>
      </div>
        )}
    </>
  );
}
