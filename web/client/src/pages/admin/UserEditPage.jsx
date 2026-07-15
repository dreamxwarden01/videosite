import { useState, useEffect, useCallback, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useSite } from '../../context/SiteContext';
import { useAuth } from '../../context/AuthContext';
import { useToast } from '../../context/ToastContext';
import { useConfirm } from '../../components/ConfirmModal';
import useStepupGuard from '../../hooks/useStepupGuard';
import StepUpBlock from '../../components/StepUpBlock';
import { apiGet, apiPost, apiPut, apiDelete } from '../../api';
import Avatar from '../../components/Avatar';
import VsSaveBar from '../../components/VsSaveBar';
import { permissionLabel, permissionGroups, prereqReason } from '../../utils/permissionLabels';
import { prereqViolations, lockedPrereqs } from '../../utils/permissionPrereqs';
import PermSelector from '../../components/PermSelector';
import { fmtWatch, fmtClock } from '../../utils/timeFormat';
import TimeAgo from '../../components/TimeAgo';

const TRI_OPTIONS = [
  { value: 0, label: 'Inherit', tone: 'inherit' },
  { value: 1, label: 'Grant', tone: 'grant' },
  { value: 2, label: 'Deny', tone: 'deny' },
];

const ChevronL = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m15 18-6-6 6-6" /></svg>;
const DetailsIcon = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="4" y="3" width="16" height="18" rx="2" /><path d="M9 8h6" /><path d="M9 12h6" /><path d="M9 16h4" /></svg>;
const ShieldIcon = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /></svg>;
const MonitorIcon = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="3" width="20" height="14" rx="2" /><path d="M8 21h8" /><path d="M12 17v4" /></svg>;
const StatsIcon = () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M3 3v18h18" /><rect x="7" y="11" width="3" height="6" /><rect x="12" y="7" width="3" height="10" /><rect x="17" y="13" width="3" height="4" /></svg>;

// Read-only value under a .vs-label — the design system has no read-only field
// primitive, so match .vs-input's type ramp without the box.
const RO_VAL = { fontSize: '13.5px', color: '#1f2937', wordBreak: 'break-word' };
function RoField({ label, children }) {
  return (
    <div className="vs-field">
      <div className="vs-label">{label}</div>
      <div style={RO_VAL}>{children}</div>
    </div>
  );
}

// Compact relative time for the session rows; falls back to an absolute date.
function when(ts) {
  if (!ts) return 'unknown';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return 'unknown';
  const sec = Math.round((Date.now() - d.getTime()) / 1000);
  if (sec < 45) return 'just now';
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 7) return `${day}d ago`;
  return d.toLocaleDateString();
}

export default function UserEditPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { siteName } = useSite();
  const { user } = useAuth();
  const { showToast } = useToast();
  const confirm = useConfirm();

  const { blocked, guardFetch, verify, guardAction } = useStepupGuard('user');

  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState('details');

  // User details (read-only — identity + role are managed at the SSO)
  const [targetUser, setTargetUser] = useState(null);

  // Permissions
  const [allPermissions, setAllPermissions] = useState([]);
  const [overrides, setOverrides] = useState({});
  const [canChangePermissions, setCanChangePermissions] = useState(false);
  const [adminPermissions, setAdminPermissions] = useState({});
  const [savingPerms, setSavingPerms] = useState(false);
  const originalOverrides = useRef({});
  const [permPrereqs, setPermPrereqs] = useState({});

  // Sessions (lazy-loaded when the tab is first opened)
  const [sessions, setSessions] = useState([]);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const sessionsLoaded = useRef(false);

  // Playback stats (lazy-loaded when the tab is first opened)
  const [pbCourses, setPbCourses] = useState(null); // null = not loaded
  const [pbCoursesLoading, setPbCoursesLoading] = useState(false);
  const pbLoaded = useRef(false);
  const [pbCourseId, setPbCourseId] = useState(null);
  const [pbVideos, setPbVideos] = useState(null);
  const [pbVideosLoading, setPbVideosLoading] = useState(false);
  const [pbResetting, setPbResetting] = useState(''); // '' | 'course' | 'all'
  // Monotonic token so a slow per-course response can't overwrite a newer chip
  // selection with stale watch data.
  const pbReqSeq = useRef(0);

  useEffect(() => {
    if (!siteName) return;
    document.title = `Edit User - ${siteName}`;
  }, [siteName]);

  const fetchUser = useCallback(async () => {
    try {
      const { data, ok } = await guardFetch(`/api/admin/users/${id}/edit`);
      if (ok && data) {
        setTargetUser(data.targetUser || null);
        setAllPermissions(data.allPermissions || []);
        setAdminPermissions(data.adminPermissions || {});
        setOverrides(data.overrides || {});
        originalOverrides.current = data.overrides || {};
        setPermPrereqs(data.permissionPrereqs || {});
        setCanChangePermissions(data.canChangePermissions || false);
      }
    } catch {
      showToast('Failed to load user.');
    } finally {
      setLoading(false);
    }
  }, [id, guardFetch]);

  useEffect(() => {
    fetchUser();
  }, [fetchUser]);

  const loadSessions = useCallback(async () => {
    setSessionsLoading(true);
    try {
      const { data, ok } = await apiGet(`/api/admin/users/${id}/sessions`);
      if (ok && data) setSessions(data.sessions || []);
    } catch {
      showToast('Failed to load sessions.');
    } finally {
      setSessionsLoading(false);
    }
  }, [id]);

  // Lazy-load sessions the first time the Sessions tab is opened.
  useEffect(() => {
    if (activeTab !== 'sessions' || sessionsLoaded.current) return;
    sessionsLoaded.current = true;
    loadSessions();
  }, [activeTab, loadSessions]);

  // Playback stats: load this user's per-video stats for one watched course.
  const selectPbCourse = useCallback(async (cid) => {
    const seq = ++pbReqSeq.current;
    setPbCourseId(cid);
    setPbVideos(null);
    setPbVideosLoading(true);
    try {
      const { data, ok } = await apiGet(`/api/admin/users/${id}/playback-stats?courseId=${cid}`);
      if (pbReqSeq.current !== seq) return; // superseded by a newer chip
      setPbVideos(ok && data ? (data.videos || []) : []);
    } catch {
      if (pbReqSeq.current !== seq) return;
      showToast('Failed to load videos.'); setPbVideos([]);
    } finally { if (pbReqSeq.current === seq) setPbVideosLoading(false); }
  }, [id]);

  // Load the watched-course list, then auto-select the most recent.
  const loadPbCourses = useCallback(async () => {
    setPbCoursesLoading(true);
    try {
      const { data, ok } = await apiGet(`/api/admin/users/${id}/playback-stats`);
      const list = ok && data ? (data.courses || []) : [];
      setPbCourses(list);
      if (list.length > 0) selectPbCourse(list[0].course_id);
      else { setPbCourseId(null); setPbVideos(null); }
    } catch { showToast('Failed to load playback stats.'); setPbCourses([]); }
    finally { setPbCoursesLoading(false); }
  }, [id, selectPbCourse]);

  useEffect(() => {
    if (activeTab !== 'playback' || pbLoaded.current) return;
    pbLoaded.current = true;
    loadPbCourses();
  }, [activeTab, loadPbCourses]);

  const resetPbAll = async () => {
    if (!await confirm({ title: 'Reset playback statistics?', message: `${name}'s watch history and resume positions across every course will be permanently deleted. This can't be undone.`, confirmLabel: 'Reset all', danger: true })) return;
    setPbResetting('all');
    try {
      const { ok, data } = await apiDelete(`/api/admin/users/${id}/playback-stats`);
      if (ok) { showToast('Playback stats reset.', 'success'); await loadPbCourses(); }
      else showToast(data?.error || 'Failed to reset statistics.');
    } catch (err) { showToast(err.message); }
    finally { setPbResetting(''); }
  };

  const resetPbCourse = async () => {
    if (!pbCourseId) return;
    const c = (pbCourses || []).find((x) => x.course_id === pbCourseId);
    const label = c ? (c.course_name ? `${c.course_code} · ${c.course_name}` : c.course_code) : 'this course';
    if (!await confirm({ title: 'Reset playback statistics?', message: `${name}'s watch history and resume positions in ${label} will be permanently deleted. This can't be undone.`, confirmLabel: 'Reset', danger: true })) return;
    setPbResetting('course');
    try {
      const { ok, data } = await apiDelete(`/api/admin/users/${id}/playback-stats?courseId=${pbCourseId}`);
      if (ok) { showToast('Course playback stats reset.', 'success'); await loadPbCourses(); }
      else showToast(data?.error || 'Failed to reset statistics.');
    } catch (err) { showToast(err.message); }
    finally { setPbResetting(''); }
  };

  if (!user?.permissions?.changeUser) {
    return <div className="vs-cv-empty">Permission denied.</div>;
  }

  // SSO account-portal link — user_id is the dash-less sub (32-char hex);
  // re-dash it to UUID form 8-4-4-4-12 for the portal URL.
  const accountPortal = user.account_portal;
  const sub = targetUser?.user_id || '';
  const dashedSub = sub.length === 32
    ? `${sub.slice(0, 8)}-${sub.slice(8, 12)}-${sub.slice(12, 16)}-${sub.slice(16, 20)}-${sub.slice(20)}`
    : sub;

  // Dirty tracking — only the keys this admin can actually change count.
  const dirty = (allPermissions || []).some(k => adminPermissions[k] && (overrides[k] || 0) !== (originalOverrides.current[k] || 0));

  // Validate the OVERRIDE set alone (inherit satisfies nothing) — prerequisites
  // must be secured at the override level, since the role can change out from
  // under it. Save is blocked only on NEW violations (delta-aware, matching the
  // server); pre-existing ones show red but don't wedge an unrelated edit.
  const grantsOnly = (ov) => {
    const e = {};
    for (const [k, v] of Object.entries(ov)) if (v === 1) e[k] = true;
    return e;
  };
  const violations = prereqViolations(grantsOnly(overrides), permPrereqs);
  const locked = lockedPrereqs(grantsOnly(overrides), permPrereqs);
  const originalViolations = prereqViolations(grantsOnly(originalOverrides.current), permPrereqs);
  const hasNewViolations = Object.keys(violations).some((k) => !originalViolations[k]);
  // Staged-change chips for the save bar (same tag rail as enrollment). Grant →
  // green +, Deny → red −, Inherit (reset) → neutral chip.
  const permItems = (allPermissions || [])
    .filter((k) => adminPermissions[k] && (overrides[k] || 0) !== (originalOverrides.current[k] || 0))
    .map((k) => { const v = overrides[k] || 0; return { label: k, tone: v === 1 ? 'add' : v === 2 ? 'remove' : undefined }; });

  const stage = (key, v) => setOverrides(prev => ({ ...prev, [key]: v }));

  const savePermissions = async () => {
    if (!dirty || hasNewViolations) return;
    setSavingPerms(true);
    try {
      // Send only the keys that actually changed, so the PUT payload stays
      // minimal and the server only writes what's different.
      const permissions = {};
      for (const key of allPermissions) {
        if (!adminPermissions[key]) continue;
        const o = originalOverrides.current[key] || 0;
        const c = overrides[key] || 0;
        if (o !== c) permissions[key] = c;
      }
      const { ok, data } = await apiPut(`/api/admin/users/${id}/permissions`, { permissions });
      if (ok) {
        showToast('Permissions updated.', 'success');
        // Rebuild the pristine baseline from current state, dropping inherits
        // since the backend deletes the row for value 0.
        const next = {};
        for (const [k, v] of Object.entries(overrides)) {
          if (v !== 0) next[k] = v;
        }
        originalOverrides.current = next;
      } else {
        showToast(data?.error || 'Failed to update permissions.');
      }
    } catch (err) { showToast(err.message); }
    finally { setSavingPerms(false); }
  };

  const handleTerminateAll = async () => {
    if (!await confirm({ title: 'Sign out all sessions?', message: 'This user will be signed out everywhere.', confirmLabel: 'Sign out', danger: true })) return;
    try {
      const { ok, data } = await apiPost(`/api/admin/users/${id}/sessions/terminate-all`);
      if (ok) {
        showToast('All sessions signed out.', 'success');
        await loadSessions();
      } else {
        showToast(data?.error || 'Failed to sign out sessions.');
      }
    } catch (err) { showToast(err.message); }
  };

  const tabs = [
    { key: 'details', label: 'User details', icon: <DetailsIcon /> },
    ...(canChangePermissions ? [{ key: 'permissions', label: 'Permissions', icon: <ShieldIcon /> }] : []),
    { key: 'sessions', label: 'Sessions', icon: <MonitorIcon /> },
    { key: 'playback', label: 'Playback stats', icon: <StatsIcon /> },
  ];

  const name = targetUser ? (targetUser.display_name || targetUser.username) : '';

  return (
    <>
      {blocked ? (
        <StepUpBlock onVerify={verify} />
      ) : loading ? (
        <div className="vs-cv-empty" style={{ padding: '64px 16px' }}>Loading…</div>
      ) : !targetUser ? (
        <div className="vs-cv-empty">User not found.</div>
      ) : (
        <>
          <button className="vs-back" onClick={() => navigate('/admin/users')}><ChevronL />Users</button>

          {/* Identity header */}
          <div className="vs-edit-head">
            <Avatar user={targetUser} name={name} className="vs-pmenu-av" />
            <div className="vs-edit-idn">
              <p className="vs-edit-name">{name}</p>
              <p className="vs-edit-sub">{targetUser.username} · {targetUser.email || '—'}</p>
            </div>
            <span className="vs-edit-role">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /></svg>
              {targetUser.role_name || 'No role'} (level {targetUser.permission_level})
            </span>
          </div>

          {/* Rail + pane split */}
          <div className="vs-edit-split">
            <div className="vs-split-rail">
              {tabs.map(t => (
                <button key={t.key} type="button" className={`vs-rail-item${activeTab === t.key ? ' on' : ''}`} onClick={() => setActiveTab(t.key)}>
                  {t.icon} {t.label}
                </button>
              ))}
            </div>

            <div className="vs-split-pane">
              {/* ===== USER DETAILS ===== */}
              {activeTab === 'details' && (
                <>
                  <div className="vs-pane-h">User details</div>
                  <p className="vs-pane-sub">Identity and role for this user. These are read-only here.</p>

                  <RoField label="Display name">{targetUser.display_name || '—'}</RoField>
                  <RoField label="Username">{targetUser.username}</RoField>
                  <RoField label="Email">{targetUser.email || '—'}</RoField>
                  <RoField label="Role">{targetUser.role_name || 'No role'}</RoField>
                  <RoField label="Created">{targetUser.created_at ? new Date(targetUser.created_at).toLocaleString() : '—'}</RoField>

                  <p className="vs-pane-sub" style={{ marginTop: '18px', marginBottom: 0 }}>
                    Identity (name, email, password, MFA) and role are managed at the SSO.
                    {accountPortal && (
                      <>
                        {' '}
                        <a href={`${accountPortal}/organization/users/${dashedSub}`} target="_blank" rel="noreferrer">
                          Manage this user in the account portal
                        </a>
                      </>
                    )}
                  </p>
                </>
              )}

              {/* ===== PERMISSIONS ===== */}
              {activeTab === 'permissions' && canChangePermissions && (
                <>
                  <div className="vs-pane-h">Permissions</div>
                  <p className="vs-pane-sub">
                    Grant or Deny overrides this user&rsquo;s role default for a permission. Inherit falls back to the role.
                  </p>

                  {permissionGroups(allPermissions).map(({ group, keys }) => (
                    <div className="vs-perm-group" key={group}>
                      <div className="vs-perm-grp">{group}</div>
                      {keys.map(key => {
                        const canEdit = !!adminPermissions[key];
                        const val = overrides[key] || 0;
                        const changed = canEdit && val !== (originalOverrides.current[key] || 0);
                        const bad = !!violations[key];
                        // Override-level: only Grant keeps a prereq secured, so a
                        // prereq other overrides depend on can move to neither
                        // Inherit nor Deny until those dependents are cleared.
                        const lockedVals = new Set();
                        if (locked.has(key)) { lockedVals.add(0); lockedVals.add(2); }
                        return (
                          <div className={'vs-perm-row' + (canEdit ? '' : ' locked') + (changed ? ' changed' : '') + (bad ? ' bad' : '')} key={key}>
                            <div className="vs-perm-mn">
                              <div className="vs-perm-name">{permissionLabel(key)}</div>
                              <div className="vs-perm-key">{key}</div>
                              {bad && <div className="vs-perm-note">{prereqReason(violations[key])}</div>}
                            </div>
                            <PermSelector value={val} options={TRI_OPTIONS} disabled={!canEdit}
                              lockedValues={lockedVals} invalid={bad} onChange={(v) => stage(key, v)} />
                          </div>
                        );
                      })}
                    </div>
                  ))}

                  <VsSaveBar visible={dirty} busy={savingPerms} saveLabel="Save permissions" invalid={hasNewViolations} items={permItems}
                    onSave={() => guardAction(savePermissions)} onDiscard={() => setOverrides({ ...originalOverrides.current })} />
                </>
              )}

              {/* ===== SESSIONS ===== */}
              {activeTab === 'sessions' && (
                <>
                  <div className="vs-pane-h">Sessions</div>
                  <p className="vs-pane-sub">Devices where this user is currently signed in.</p>

                  {sessionsLoading ? (
                    <p className="vs-pane-sub" style={{ marginBottom: 0 }}>Loading…</p>
                  ) : sessions.length === 0 ? (
                    <p className="vs-pane-sub" style={{ marginBottom: 0 }}>No active sessions.</p>
                  ) : (
                    <>
                      <div>
                        {sessions.map((s, i) => (
                          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: '11px 0', borderTop: i === 0 ? 'none' : '1px solid #f4f5f6' }}>
                            <div className="vs-cv-av">
                              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="3" width="20" height="14" rx="2" /><path d="M8 21h8" /><path d="M12 17v4" /></svg>
                            </div>
                            <div className="vs-cv-rmn">
                              <p className="vs-cv-rt">{s.deviceName || 'Unknown device'}</p>
                              <p className="vs-cv-rs">
                                {`${s.ip_address ? s.ip_address + ' · ' : ''}signed in ${when(s.last_sign_in)} · active ${when(s.last_seen)}`}
                              </p>
                            </div>
                          </div>
                        ))}
                      </div>

                      <button type="button" className="vs-btn vs-btn-danger" style={{ marginTop: '18px' }} onClick={() => guardAction(handleTerminateAll)}>
                        Sign out all sessions
                      </button>
                    </>
                  )}
                </>
              )}

              {/* ===== PLAYBACK STATS ===== */}
              {activeTab === 'playback' && (
                <>
                  <div className="vs-pane-h vs-ps-panehead">
                    <span>Playback stats</span>
                    <span className="vs-ps-resets">
                      <button type="button" className="vs-ps-reset" disabled={!!pbResetting || !pbCourseId} onClick={() => guardAction(resetPbCourse)}>
                        {pbResetting === 'course' ? 'Resetting…' : 'Reset current course'}
                      </button>
                      <button type="button" className="vs-ps-reset" disabled={!!pbResetting || !(pbCourses && pbCourses.length)} onClick={() => guardAction(resetPbAll)}>
                        {pbResetting === 'all' ? 'Resetting…' : 'Reset all'}
                      </button>
                    </span>
                  </div>

                  {pbCourses === null ? (
                    <p className="vs-pane-sub" style={{ marginBottom: 0 }}>Loading…</p>
                  ) : pbCourses.length === 0 ? (
                    <p className="vs-pane-sub" style={{ marginBottom: 0 }}>This user hasn&rsquo;t watched any videos yet.</p>
                  ) : (
                    <>
                      <div className="vs-pane-sub" style={{ marginBottom: '8px' }}>Courses watched</div>
                      <div className="vs-ps-chips">
                        {pbCourses.map((c) => (
                          <button key={c.course_id} type="button"
                            className={'vs-ps-chip' + (c.course_id === pbCourseId ? ' on' : '')}
                            onClick={() => selectPbCourse(c.course_id)} title={c.course_name || c.course_code}>
                            <span className="vs-ps-chip-code">{c.course_code}</span>
                            {c.course_name && <span className="vs-ps-chip-name">{c.course_name}</span>}
                          </button>
                        ))}
                      </div>

                      {pbVideosLoading ? (
                        <div className="vs-ps-vlist">
                          {Array.from({ length: 4 }).map((_, i) => (
                            <div className="vs-ps-vrow" key={i}><div className="vs-ps-vmn"><div className="vs-skln" style={{ width: 180 }}>&nbsp;</div><div className="vs-skln" style={{ width: 90, marginTop: 4 }}>&nbsp;</div></div></div>
                          ))}
                        </div>
                      ) : (pbVideos || []).length === 0 ? (
                        <div className="vs-ps-empty vs-ps-empty-lg">No videos in this course.</div>
                      ) : (
                        <div className="vs-ps-vlist">
                          {pbVideos.map((v) => (
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
                </>
              )}
            </div>
          </div>
        </>
      )}
    </>
  );
}
