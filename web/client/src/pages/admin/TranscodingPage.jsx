import { useState, useEffect, useRef } from 'react';
import { useSite } from '../../context/SiteContext';
import { useAuth } from '../../context/AuthContext';
import { useToast } from '../../context/ToastContext';
import { useConfirm } from '../../components/ConfirmModal';
import useStepupGuard from '../../hooks/useStepupGuard';
import StepUpBlock from '../../components/StepUpBlock';
import { apiPost } from '../../api';
import TimeAgo from '../../components/TimeAgo';

const CheckIcon = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9" /><path d="m8.5 12 2.4 2.4 4.6-5" /></svg>;
const LoaderIcon = () => <svg className="vs-tc-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M12 3a9 9 0 1 0 9 9" /></svg>;
const ClockIcon = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9" /><path d="M12 7.5V12l3 1.8" /></svg>;
const AlertIcon = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9" /><path d="M12 8v4.5" /><path d="M12 16h.01" /></svg>;
const BanIcon = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9" /><path d="m6.5 6.5 11 11" /></svg>;
const ICONS = { check: CheckIcon, loader: LoaderIcon, clock: ClockIcon, alert: AlertIcon, ban: BanIcon };

// Raw job → display state. Mirrors the old getStatusLabel/getStatusClass: the
// worker sub-states (downloading/uploading) refine an otherwise generic
// "processing"; all live states share the spinner glyph (accent), the pill
// carries the phase.
function jobState(job) {
  const s = job.status, vs = job.videoStatus;
  if (s === 'error') return { label: 'Failed', role: 'danger', icon: 'alert' };
  if (s === 'completed') return { label: 'Finished', role: 'success', icon: 'check' };
  if (s === 'aborted') return { label: 'Aborted', role: 'neutral', icon: 'ban' };
  if (s === 'queued' || s === 'pending') return { label: 'Queued', role: 'neutral', icon: 'clock' };
  if (s === 'leased' || vs === 'worker_downloading') return { label: 'Downloading', role: 'accent', icon: 'loader' };
  if (s === 'processing' && vs === 'worker_uploading') return { label: 'Uploading', role: 'accent', icon: 'loader' };
  return { label: 'Processing', role: 'accent', icon: 'loader' };
}
const isActiveStatus = (s) => !['completed', 'error', 'aborted', 'queued', 'pending'].includes(s);
const isPending = (s) => s === 'queued' || s === 'pending';

const FILTERS = [
  { k: 'all', label: 'All', test: () => true },
  { k: 'active', label: 'Active', test: (j) => isActiveStatus(j.status) || isPending(j.status) },
  { k: 'finished', label: 'Finished', test: (j) => j.status === 'completed' },
  { k: 'failed', label: 'Failed', test: (j) => j.status === 'error' || j.status === 'aborted' },
];

export default function TranscodingPage() {
  const { siteName } = useSite();
  const { user } = useAuth();
  const { showToast } = useToast();
  const confirm = useConfirm();

  const { blocked, guardFetch, verify, guardAction } = useStepupGuard('transcoding');

  const [jobs, setJobs] = useState([]);
  const [hasActive, setHasActive] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [filter, setFilter] = useState('all');
  const pollRef = useRef(null);

  useEffect(() => {
    if (!siteName) return;
    document.title = `Transcoding - ${siteName}`;
  }, [siteName]);

  const fetchJobs = async () => {
    try {
      const { data, ok } = await guardFetch('/api/admin/transcoding/jobs');
      if (ok && data) {
        setJobs(data.jobs || []);
        setHasActive(data.hasActive || false);
        setLoaded(true);
      }
    } catch { /* keep the last good list on a transient error */ }
  };

  useEffect(() => {
    fetchJobs();
    pollRef.current = setInterval(fetchJobs, 5000);
    const visHandler = () => {
      if (document.hidden) {
        clearInterval(pollRef.current);
      } else {
        fetchJobs();
        pollRef.current = setInterval(fetchJobs, hasActive ? 1000 : 5000);
      }
    };
    document.addEventListener('visibilitychange', visHandler);
    return () => {
      clearInterval(pollRef.current);
      document.removeEventListener('visibilitychange', visHandler);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Poll faster while any job is active.
  useEffect(() => {
    clearInterval(pollRef.current);
    pollRef.current = setInterval(fetchJobs, hasActive ? 1000 : 5000);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasActive]);

  if (!user?.permissions?.manageSite) {
    return <div className="vs-cv-empty">Permission denied.</div>;
  }

  const handleClearFinished = async () => {
    if (!await confirm({ title: 'Clear finished jobs?', message: 'This only removes them from this view — it doesn\'t touch the videos.', confirmLabel: 'Clear', danger: false })) return;
    const { ok } = await apiPost('/api/admin/transcoding/clear-finished');
    if (ok) { showToast('Finished jobs cleared.', 'success'); fetchJobs(); }
    else showToast('Failed to clear finished jobs.');
  };

  const hasFinished = jobs.some(j => j.status === 'completed');
  const activeCount = jobs.filter(FILTERS[1].test).length;
  const filtered = jobs.filter(FILTERS.find(f => f.k === filter).test);

  return (
    <div className="vs-tc">
      <div className="vs-tc-head">
          <div className="vs-tc-headrow">
            <div style={{ minWidth: 0 }}>
              <h1 className="vs-cv-title">Transcoding</h1>
              <p className="vs-cv-sub">
                {loaded
                  ? `${jobs.length} ${jobs.length === 1 ? 'job' : 'jobs'}${activeCount ? ` · ${activeCount} active` : ''}`
                  : <span className="vs-cv-skel vs-cv-sub-skel" />}
              </p>
            </div>
            {hasFinished && <button className="vs-btn" onClick={() => guardAction(handleClearFinished)}>Clear finished</button>}
          </div>
          <div className="vs-tc-filters">
            {FILTERS.map(f => (
              <button key={f.k} type="button" className={'vs-tc-fbtn' + (filter === f.k ? ' on' : '')} onClick={() => setFilter(f.k)}>
                {f.label} <span className="n">{jobs.filter(f.test).length}</span>
              </button>
            ))}
          </div>
        </div>
        <div className="vs-tc-card">
          {blocked ? (
            <StepUpBlock onVerify={verify} />
          ) : !loaded ? (
            <div className="vs-tc-empty">Loading…</div>
          ) : filtered.length === 0 ? (
            <div className="vs-tc-empty">{jobs.length === 0 ? 'No transcoding jobs.' : 'No jobs in this view.'}</div>
          ) : (
            filtered.map(job => {
              const st = jobState(job);
              const Icon = ICONS[st.icon];
              const active = isActiveStatus(job.status);
              const worker = job.workerKeyId ? (job.workerLabel || job.workerKeyId.slice(-6)) : null;
              return (
                <div key={job.taskId || job.jobId} className="vs-tc-row">
                  <div className={`vs-tc-ic vs-tc-${st.role}`}><Icon /></div>
                  <div className="vs-tc-mn">
                    <div className="vs-tc-toprow">
                      <div className="vs-tc-title" title={job.videoTitle}>{job.videoTitle}</div>
                      <span className={`vs-tc-pill vs-tc-${st.role}`}>{st.label}{active ? ` ${job.progress}%` : ''}</span>
                    </div>
                    <div className="vs-tc-meta">
                      {job.courseName}
                      {worker && <> · {worker}</>}
                      {job.uploadTime && <> · uploaded <TimeAgo iso={job.uploadTime} /></>}
                      {job.jobId && <> · <span className="vs-tc-jid">{job.jobId}</span></>}
                    </div>
                    {active && (
                      <div className="vs-tc-pbar"><div className="vs-tc-pfill" style={{ width: `${job.progress || 0}%` }} /></div>
                    )}
                    {job.errorMessage && <div className="vs-tc-err">{job.errorMessage}</div>}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
  );
}
