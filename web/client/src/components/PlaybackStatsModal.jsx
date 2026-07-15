import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useToast } from '../context/ToastContext';
import { useConfirm } from './ConfirmModal';
import useMfaChallenge from '../hooks/useMfaChallenge';
import MfaChallengeUI from './MfaChallengeUI';
import { MfaSetupRequiredModal } from './MfaPageGuard';
import Avatar from './Avatar';
import TimeAgo from './TimeAgo';
import { fmtWatch, fmtClock } from '../utils/timeFormat';

const CloseIcon = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6 6 18" /><path d="m6 6 12 12" /></svg>;
const BackIcon = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m15 18-6-6 6-6" /></svg>;
const SearchIcon = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></svg>;
const TrashIcon = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18" /><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" /></svg>;

// Course-page "Playback stats" modal. Left = the roster (enrolled + all-access
// watchers), searchable; right = course-overall aggregates by default, or the
// selected student's per-video stats. All fetches go through mfaFetch so the
// route's step-up requirement is honoured (challenge UI moves to the SSO later).
export default function PlaybackStatsModal({ courseId, courseCode, courseName, canReset, onClose }) {
  const { showToast } = useToast();
  const confirm = useConfirm();
  const { mfaFetch, mfaState, mfaSetupState, onMfaSuccess, onMfaCancel, dismissMfaSetup } = useMfaChallenge();

  const [loading, setLoading] = useState(true);
  const [data, setData] = useState(null); // { overall, students }
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState(null);
  const [videos, setVideos] = useState(null);
  const [videosLoading, setVideosLoading] = useState(false);
  const [resetting, setResetting] = useState(false);
  // Monotonic token so a slow per-student response can't overwrite a newer
  // selection (or a return to the overall pane) with stale watch data.
  const reqSeq = useRef(0);

  const loadCourse = useCallback(async () => {
    setLoading(true);
    try {
      const { data: d, ok } = await mfaFetch(`/api/admin/courses/${courseId}/playback-stats`, { method: 'GET' });
      if (ok && d) setData(d);
      else showToast(d?.error || 'Failed to load playback statistics.');
    } catch (err) { showToast(err.message); }
    finally { setLoading(false); }
  }, [courseId, mfaFetch, showToast]);

  useEffect(() => { loadCourse(); }, [loadCourse]);

  const pickStudent = async (id) => {
    const seq = ++reqSeq.current;
    setSelectedId(id);
    setVideos(null);
    setVideosLoading(true);
    try {
      const { data: d, ok } = await mfaFetch(`/api/admin/courses/${courseId}/playback-stats?userId=${encodeURIComponent(id)}`, { method: 'GET' });
      if (reqSeq.current !== seq) return; // superseded by a newer selection / back
      if (ok && d) setVideos(d.videos || []);
      else { showToast(d?.error || 'Failed to load this student.'); setVideos([]); }
    } catch (err) {
      if (reqSeq.current !== seq) return;
      showToast(err.message); setVideos([]);
    } finally { if (reqSeq.current === seq) setVideosLoading(false); }
  };

  // Return to the overall pane, cancelling any in-flight student fetch.
  const backToOverall = () => { reqSeq.current++; setSelectedId(null); setVideos(null); };

  const handleResetCourse = async () => {
    const label = courseName ? `${courseCode} · ${courseName}` : courseCode;
    if (!await confirm({ title: 'Reset playback statistics?', message: `Every student's watch history and resume positions in ${label} will be permanently deleted. This can't be undone.`, confirmLabel: 'Reset all', danger: true })) return;
    setResetting(true);
    try {
      const { ok, data: d } = await mfaFetch(`/api/admin/courses/${courseId}/playback-stats`, { method: 'DELETE' });
      if (ok) { showToast('Course playback stats reset.', 'success'); setSelectedId(null); setVideos(null); await loadCourse(); }
      else showToast(d?.error || 'Failed to reset statistics.');
    } catch (err) { showToast(err.message); }
    finally { setResetting(false); }
  };

  const students = data?.students || [];
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return students;
    return students.filter((s) =>
      (s.display_name || '').toLowerCase().includes(q) ||
      (s.username || '').toLowerCase().includes(q));
  }, [students, query]);

  const selected = students.find((s) => s.user_id === selectedId) || null;

  return (
    <>
      <div className="vs-scrim" onMouseDown={onClose}>
        <div className={'vs-ps-modal' + (selectedId ? ' has-sel' : '')} onMouseDown={(e) => e.stopPropagation()}>
          <div className="vs-ps-head">
            <div style={{ minWidth: 0 }}>
              <div className="vs-ps-title">Playback stats</div>
              <div className="vs-ps-sub"><span>{courseCode}</span>{courseName ? ` · ${courseName}` : ''}</div>
            </div>
            <button className="vs-ps-x" aria-label="Close" onClick={onClose}><CloseIcon /></button>
          </div>

          <div className="vs-ps-body">
            {/* Roster */}
            <div className="vs-ps-side">
              <div className="vs-ps-search-wrap">
                <div className="vs-ps-search">
                  <SearchIcon />
                  <input type="text" placeholder="Search students" value={query} onChange={(e) => setQuery(e.target.value)} />
                </div>
                <div className="vs-ps-count">{loading ? ' ' : `${students.length} ${students.length === 1 ? 'student' : 'students'}`}</div>
              </div>
              <div className="vs-ps-slist">
                {loading ? (
                  Array.from({ length: 6 }).map((_, i) => (
                    <div className="vs-ps-srow" key={i}>
                      <div className="vs-cv-av vs-ps-skav" />
                      <div className="vs-ps-sinfo"><div className="vs-skln" style={{ width: 110 }}>&nbsp;</div><div className="vs-skln" style={{ width: 70, marginTop: 4 }}>&nbsp;</div></div>
                    </div>
                  ))
                ) : filtered.length === 0 ? (
                  <div className="vs-ps-empty">{students.length === 0 ? 'No viewers yet.' : 'No matches.'}</div>
                ) : (
                  filtered.map((s) => (
                    <button type="button" key={s.user_id} className={'vs-ps-srow' + (s.user_id === selectedId ? ' on' : '')} onClick={() => pickStudent(s.user_id)}>
                      <Avatar user={s} name={s.display_name || s.username} className="vs-cv-av" />
                      <div className="vs-ps-sinfo">
                        <div className="vs-ps-sname">{s.display_name || s.username}</div>
                        <div className="vs-ps-suser">@{s.username}</div>
                      </div>
                      <div className="vs-ps-stot">{fmtWatch(s.total_watch_seconds)}</div>
                    </button>
                  ))
                )}
              </div>
            </div>

            {/* Detail */}
            <div className="vs-ps-main">
              {!selectedId ? (
                <>
                  <div className="vs-ps-mhead">
                    <div style={{ minWidth: 0 }}>
                      <div className="vs-ps-mh-t">Course overall</div>
                      <div className="vs-ps-mh-s">
                        {loading || !data ? ' ' : `${data.overall.videoCount} ${data.overall.videoCount === 1 ? 'video' : 'videos'} · ${fmtWatch(data.overall.totalDuration)} of content · ${data.overall.viewerCount} ${data.overall.viewerCount === 1 ? 'viewer' : 'viewers'}`}
                      </div>
                    </div>
                    {canReset && !loading && data && (
                      <button type="button" className="vs-ps-reset" onClick={handleResetCourse} disabled={resetting}>
                        <TrashIcon />{resetting ? 'Resetting…' : 'Reset'}
                      </button>
                    )}
                  </div>
                  {loading ? (
                    <div className="vs-ps-vlist">{Array.from({ length: 5 }).map((_, i) => (
                      <div className="vs-ps-vrow" key={i}><div className="vs-ps-vmn"><div className="vs-skln" style={{ width: 180 }}>&nbsp;</div><div className="vs-skln" style={{ width: 90, marginTop: 4 }}>&nbsp;</div></div></div>
                    ))}</div>
                  ) : !data ? (
                    <div className="vs-ps-empty vs-ps-empty-lg">Couldn’t load playback stats. Close and try again.</div>
                  ) : data.overall.videos.length === 0 ? (
                    <div className="vs-ps-empty vs-ps-empty-lg">This course has no videos yet.</div>
                  ) : (
                    <div className="vs-ps-vlist">
                      {data.overall.videos.map((v) => (
                        <div className="vs-ps-vrow" key={v.video_id}>
                          <div className="vs-ps-vmn">
                            <div className="vs-ps-vt" title={v.title}>{v.title}</div>
                            <div className="vs-ps-vd">Duration {fmtClock(v.duration_seconds)}</div>
                          </div>
                          <div className="vs-ps-vr">
                            <div className="vs-ps-vr1">{v.viewers} {v.viewers === 1 ? 'viewer' : 'viewers'}</div>
                            <div className="vs-ps-vr2">{fmtWatch(v.total_watch_seconds)} watched</div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </>
              ) : (
                <>
                  <button type="button" className="vs-ps-backrow" onClick={backToOverall}>
                    <BackIcon />
                    <Avatar user={selected} name={selected?.display_name || selected?.username} className="vs-cv-av vs-ps-backav" />
                    <div className="vs-ps-sinfo">
                      <div className="vs-ps-sname">
                        {selected?.display_name || selected?.username}
                        {selected?.source === 'all-access' && <span className="vs-ps-tag">all-access</span>}
                      </div>
                      <div className="vs-ps-suser">@{selected?.username}</div>
                    </div>
                  </button>
                  {videosLoading ? (
                    <div className="vs-ps-vlist">{Array.from({ length: 5 }).map((_, i) => (
                      <div className="vs-ps-vrow" key={i}><div className="vs-ps-vmn"><div className="vs-skln" style={{ width: 180 }}>&nbsp;</div><div className="vs-skln" style={{ width: 90, marginTop: 4 }}>&nbsp;</div></div></div>
                    ))}</div>
                  ) : (videos || []).length === 0 ? (
                    <div className="vs-ps-empty vs-ps-empty-lg">No videos in this course.</div>
                  ) : (
                    <div className="vs-ps-vlist">
                      {videos.map((v) => (
                        <div className={'vs-ps-vrow' + (v.watched ? '' : ' none')} key={v.video_id}>
                          <div className="vs-ps-vmn">
                            <div className="vs-ps-vt" title={v.title}>{v.title}</div>
                            <div className="vs-ps-vd">Duration {fmtClock(v.duration_seconds)}</div>
                          </div>
                          <div className="vs-ps-vr">
                            <div className="vs-ps-vr1">{v.watched ? `${fmtWatch(v.watch_seconds)} watched` : 'Not watched'}</div>
                            {v.watched && (
                              <div className="vs-ps-vr2">resumes {fmtClock(v.last_position)} · <TimeAgo iso={v.last_watch_at} /></div>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      </div>

      {mfaState && (
        <MfaChallengeUI isModal challengeId={mfaState.challengeId} allowedMethods={mfaState.allowedMethods}
          apiBase="/api/mfa/challenge"
          onSuccess={onMfaSuccess} onCancel={onMfaCancel} title="Verify to continue" />
      )}
      <MfaSetupRequiredModal mfaSetupState={mfaSetupState} onDismiss={dismissMfaSetup} />
    </>
  );
}
