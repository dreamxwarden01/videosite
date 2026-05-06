import { useState, useEffect, useRef } from 'react';
import { useSite } from '../../context/SiteContext';
import { useAuth } from '../../context/AuthContext';
import { useToast } from '../../context/ToastContext';
import { useConfirm } from '../../components/ConfirmModal';
import useMfaPageGuard from '../../hooks/useMfaPageGuard';
import useMfaChallenge from '../../hooks/useMfaChallenge';
import MfaPageGuard, { MfaSetupRequiredModal } from '../../components/MfaPageGuard';
import MfaChallengeUI from '../../components/MfaChallengeUI';

function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function formatTime(dateStr) {
  if (!dateStr) return '-';
  return new Date(dateStr).toLocaleString();
}

function getStatusLabel(job) {
  if (job.status === 'leased' || job.videoStatus === 'worker_downloading') return 'downloading';
  if (job.status === 'processing' && job.videoStatus === 'worker_uploading') return 'uploading';
  return job.videoStatus || job.status;
}

function getCardClass(job) {
  if (job.status === 'error') return 'job-error';
  if (job.status === 'completed') return 'job-finished';
  if (job.status === 'aborted') return 'job-aborted';
  return 'job-active';
}

function getStatusClass(job) {
  if (job.status === 'error') return 'status-error';
  if (job.status === 'completed') return 'status-completed';
  if (job.status === 'aborted') return 'status-aborted';
  if (job.status === 'queued' || job.status === 'pending') return 'status-queued';
  return 'status-processing';
}

export default function TranscodingPage() {
  const { siteName } = useSite();
  const { user } = useAuth();
  const { showToast } = useToast();
  const confirm = useConfirm();

  const { mfaBlock, mfaSetupBlock, autoShowModal, mfaPageFetch, handlePageMfaSuccess, handlePageMfaCancel, retryVerification, mfaVerifiedKey } = useMfaPageGuard();
  const { mfaFetch, mfaState, mfaSetupState, onMfaSuccess, onMfaCancel, dismissMfaSetup } = useMfaChallenge();

  const [jobs, setJobs] = useState([]);
  const [hasActive, setHasActive] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const pollRef = useRef(null);

  useEffect(() => {
    if (!siteName) return;
    document.title = `Transcoding Status - ${siteName}`;
  }, [siteName]);

  if (!user?.permissions?.manageSite) {
    return <p className="text-muted">Permission denied.</p>;
  }

  const fetchJobs = async () => {
    try {
      const { data, ok } = await mfaPageFetch('/api/admin/transcoding/jobs');
      if (ok && data) {
        setJobs(data.jobs || []);
        setHasActive(data.hasActive || false);
        setLoaded(true);
      }
    } catch {}
  };

  useEffect(() => {
    fetchJobs();
    pollRef.current = setInterval(fetchJobs, 5000);

    const visHandler = () => {
      if (document.hidden) {
        clearInterval(pollRef.current);
      } else {
        fetchJobs();
        pollRef.current = setInterval(fetchJobs, 5000);
      }
    };
    document.addEventListener('visibilitychange', visHandler);

    return () => {
      clearInterval(pollRef.current);
      document.removeEventListener('visibilitychange', visHandler);
    };
  }, []);

  // Adjust polling speed based on active jobs
  useEffect(() => {
    clearInterval(pollRef.current);
    const interval = hasActive ? 1000 : 5000;
    pollRef.current = setInterval(fetchJobs, interval);
  }, [hasActive]);

  const handleClearFinished = async () => {
    if (!await confirm('Clear all finished jobs from the list?')) return;
    const { ok } = await mfaFetch('/api/admin/transcoding/clear-finished', { method: 'POST' });
    if (ok) {
      showToast('Finished jobs cleared.', 'success');
      fetchJobs();
    } else {
      showToast('Failed to clear finished jobs.');
    }
  };

  const hasFinished = jobs.some(j => j.status === 'completed');

  return (
    <MfaPageGuard mfaBlock={mfaBlock} mfaSetupBlock={mfaSetupBlock} autoShowModal={autoShowModal}
      onSuccess={handlePageMfaSuccess} onCancel={handlePageMfaCancel} onRetry={retryVerification}>
    <div>
      <div className="flex-between mb-3">
        <h1>Transcoding Status</h1>
        {hasFinished && (
          <button className="btn btn-sm" onClick={handleClearFinished}>Clear Finished</button>
        )}
      </div>

      {!loaded ? (
        <p className="text-muted">Loading...</p>
      ) : jobs.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '40px', color: '#999' }}>No transcoding jobs</div>
      ) : (
        jobs.map(job => {
          const showProgress = !['completed', 'error', 'aborted', 'queued'].includes(job.status);
          return (
            <div key={job.taskId || job.jobId} className={`job-card ${getCardClass(job)}`}>
              <div className="job-header">
                <span className="job-title">{job.videoTitle}</span>
                <span className={`job-status ${getStatusClass(job)}`}>{getStatusLabel(job)}</span>
              </div>
              <div className="job-meta">
                {job.courseName}
                {job.jobId && <> &middot; Job: {job.jobId}</>}
                &middot; Uploaded: {formatTime(job.uploadTime)}
              </div>
              {showProgress && (
                <>
                  <div className="progress-bar-wrap">
                    <div className="progress-bar-fill" style={{ width: `${job.progress}%` }} />
                  </div>
                  <div className="job-meta" style={{ marginTop: '4px' }}>{job.progress}%</div>
                </>
              )}
              {job.errorMessage && <div className="job-error-msg">{job.errorMessage}</div>}
            </div>
          );
        })
      )}

      <style>{`
        .job-card { border: 1px solid #e0e0e0; border-radius: 6px; padding: 14px 18px; margin-bottom: 10px; background: #fff; }
        .job-card.job-error { background: #fff9e6; border-color: #f0d060; }
        .job-card.job-active { background: #f0f7ff; border-color: #b0d0f0; }
        .job-card.job-finished { background: #f0faf0; border-color: #b0e0b0; }
        .job-card.job-aborted { background: #f5f5f5; border-color: #ccc; }
        .job-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; }
        .job-title { font-weight: 600; font-size: 14px; }
        .job-meta { font-size: 12px; color: #666; }
        .job-status { display: inline-block; padding: 2px 8px; border-radius: 3px; font-size: 11px; font-weight: 600; text-transform: uppercase; }
        .status-queued, .status-pending { background: #e0e0e0; color: #555; }
        .status-leased, .status-processing { background: #d0e8ff; color: #2060a0; }
        .status-completed { background: #d0f0d0; color: #208020; }
        .status-error { background: #ffe0a0; color: #806000; }
        .status-aborted { background: #e0e0e0; color: #888; }
        .progress-bar-wrap { height: 6px; background: #e0e0e0; border-radius: 3px; margin-top: 8px; overflow: hidden; }
        .progress-bar-fill { height: 100%; background: #4a90d9; border-radius: 3px; transition: width 0.3s ease; }
        .job-error-msg { color: #a06000; font-size: 12px; margin-top: 6px; word-break: break-word; }
      `}</style>
    </div>

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
