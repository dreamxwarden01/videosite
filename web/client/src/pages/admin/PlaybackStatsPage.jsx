import { useState, useEffect, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useSite } from '../../context/SiteContext';
import { useAuth } from '../../context/AuthContext';
import { useToast } from '../../context/ToastContext';
import { useConfirm } from '../../components/ConfirmModal';
import useMfaPageGuard from '../../hooks/useMfaPageGuard';
import useMfaChallenge from '../../hooks/useMfaChallenge';
import MfaPageGuard, { MfaSetupRequiredModal } from '../../components/MfaPageGuard';
import MfaChallengeUI from '../../components/MfaChallengeUI';
import LoadingSpinner from '../../components/LoadingSpinner';

function formatWatchTime(seconds) {
  if (!seconds || seconds <= 0) return '-';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}

function formatPosition(pos) {
  if (!pos) return '-';
  const m = Math.floor(pos / 60);
  const s = Math.floor(pos % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function formatDate(dateStr) {
  if (!dateStr) return '-';
  return new Date(dateStr).toLocaleString();
}

export default function PlaybackStatsPage() {
  const { siteName } = useSite();
  const { user } = useAuth();
  const { showToast } = useToast();
  const confirm = useConfirm();
  const [searchParams, setSearchParams] = useSearchParams();

  const { mfaBlock, mfaSetupBlock, autoShowModal, mfaPageFetch, handlePageMfaSuccess, handlePageMfaCancel, retryVerification, mfaVerifiedKey } = useMfaPageGuard();
  const { mfaFetch, mfaState, mfaSetupState, onMfaSuccess, onMfaCancel, dismissMfaSetup } = useMfaChallenge();

  const userId = searchParams.get('userId');
  const courseId = searchParams.get('courseId');

  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [data, setData] = useState(null);

  useEffect(() => {
    document.title = `Playback Statistics - ${siteName}`;
  }, [siteName]);

  const fetchStats = useCallback(async () => {
    if (!loading) setRefreshing(true);
    try {
      let url = '/api/admin/playback-stats';
      const params = new URLSearchParams();
      if (userId) params.set('userId', userId);
      if (courseId) params.set('courseId', courseId);
      const qs = params.toString();
      if (qs) url += '?' + qs;

      const { data: resp, ok } = await mfaPageFetch(url);
      if (ok && resp) {
        setData(resp);
      }
    } catch {
      // ignore
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [userId, courseId, mfaPageFetch]);

  useEffect(() => {
    fetchStats();
  }, [fetchStats, mfaVerifiedKey]);

  if (!user?.permissions?.viewPlaybackStat) {
    return <p className="text-muted">Permission denied.</p>;
  }

  const handleClearAll = async () => {
    if (!await confirm('Clear ALL playback statistics? This cannot be undone.')) return;
    try {
      const { ok } = await mfaFetch('/api/admin/playback-stats', { method: 'DELETE' });
      if (ok) {
        showToast('All playback statistics cleared.', 'success');
        fetchStats();
      } else {
        showToast('Failed to clear statistics.');
      }
    } catch (err) {
      showToast(err.message);
    }
  };

  if (loading) return <LoadingSpinner />;
  if (!data) return <p className="text-muted">Failed to load statistics.</p>;

  let content;

  // Drill-down level 3: videos for a specific user + course
  if (userId && courseId && data.selectedUser && data.selectedCourse && data.courseVideos) {
    content = (
      <div>
        <div className="flex-between mb-3">
          <h1>Playback Statistics</h1>
        </div>

        <nav className="mb-3 text-sm">
          <a href="#" onClick={e => { e.preventDefault(); setSearchParams({}); }}>All Users</a>
          {' \u2192 '}
          <a href="#" onClick={e => { e.preventDefault(); setSearchParams({ userId }); }}>{data.selectedUser.display_name}</a>
          {' \u2192 '}
          <strong>{data.selectedCourse.course_name}</strong>
        </nav>

        <div className="card">
          <div className={`table-wrap${refreshing ? ' data-loading' : ''}`}>
            <table>
              <thead>
                <tr>
                  <th>Video</th>
                  <th>Watch Time</th>
                  <th>Duration</th>
                  <th>Last Position</th>
                  <th>Last Watched</th>
                </tr>
              </thead>
              <tbody>
                {data.courseVideos.map(v => (
                  <tr key={v.video_id}>
                    <td>{v.title}</td>
                    <td>{formatWatchTime(v.watch_seconds)}</td>
                    <td>{formatWatchTime(v.duration_seconds)}</td>
                    <td>{formatPosition(v.last_position)}</td>
                    <td>{formatDate(v.last_watch_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    );
  } else if (userId && data.selectedUser && data.userCourses) {
    content = (
      <div>
        <div className="flex-between mb-3">
          <h1>Playback Statistics</h1>
        </div>

        <nav className="mb-3 text-sm">
          <a href="#" onClick={e => { e.preventDefault(); setSearchParams({}); }}>All Users</a>
          {' \u2192 '}
          <strong>{data.selectedUser.display_name}</strong>
        </nav>

        <div className="card">
          <div className={`table-wrap${refreshing ? ' data-loading' : ''}`}>
            <table>
              <thead>
                <tr>
                  <th>Course</th>
                  <th>Total Watch Time</th>
                  <th>Last Watched</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {data.userCourses.map(c => (
                  <tr key={c.course_id}>
                    <td>{c.course_name}</td>
                    <td>{formatWatchTime(c.total_watch_seconds)}</td>
                    <td>{formatDate(c.last_watch_at)}</td>
                    <td>
                      <button
                        className="btn btn-secondary btn-sm"
                        onClick={() => setSearchParams({ userId, courseId: c.course_id })}
                      >
                        Details
                      </button>
                    </td>
                  </tr>
                ))}
                {data.userCourses.length === 0 && (
                  <tr>
                    <td colSpan="4" className="text-muted" style={{ textAlign: 'center' }}>No watch data</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    );
  } else {
    // Top level: all users
    content = (
    <div>
      <div className="flex-between mb-3">
        <h1>Playback Statistics</h1>
        {user?.permissions?.clearPlaybackStat && (
          <button className="btn btn-danger" onClick={handleClearAll}>Clear All Stats</button>
        )}
      </div>

      <div className="card">
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>User</th>
                <th>Total Watch Time</th>
                <th>Last Active</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {(data.users || []).map(u => (
                <tr key={u.user_id}>
                  <td>{u.display_name} ({u.username})</td>
                  <td>{formatWatchTime(u.total_watch_seconds)}</td>
                  <td>{formatDate(u.last_watch_at)}</td>
                  <td>
                    {u.total_watch_seconds > 0 && (
                      <button
                        className="btn btn-secondary btn-sm"
                        onClick={() => setSearchParams({ userId: u.user_id })}
                      >
                        View
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
    );
  }

  return (
    <MfaPageGuard mfaBlock={mfaBlock} mfaSetupBlock={mfaSetupBlock} autoShowModal={autoShowModal}
      onSuccess={handlePageMfaSuccess} onCancel={handlePageMfaCancel} onRetry={retryVerification}>
      {content}
      {mfaState && (
        <MfaChallengeUI isModal={true}
          challengeId={mfaState.challengeId} allowedMethods={mfaState.allowedMethods}
          maskedEmail={mfaState.maskedEmail} apiBase="/api/mfa/challenge"
          onSuccess={onMfaSuccess} onCancel={onMfaCancel} title="Verify to continue" />
      )}
      <MfaSetupRequiredModal mfaSetupState={mfaSetupState} onDismiss={dismissMfaSetup} />
    </MfaPageGuard>
  );
}
