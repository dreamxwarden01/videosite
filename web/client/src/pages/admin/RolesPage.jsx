import { useState, useEffect, useCallback, useRef } from 'react';
import { useSite } from '../../context/SiteContext';
import { useAuth } from '../../context/AuthContext';
import { useToast } from '../../context/ToastContext';
import { useConfirm } from '../../components/ConfirmModal';
import useStepupGuard from '../../hooks/useStepupGuard';
import StepUpBlock, { CardLoading } from '../../components/StepUpBlock';
import { apiPost, apiPut, apiDelete } from '../../api';
import { loadDraft, clearDraft } from '../../stepupDraft';
import VsSaveBar from '../../components/VsSaveBar';
import PermSelector from '../../components/PermSelector';
import { permissionLabel, permissionGroups, prereqReason } from '../../utils/permissionLabels';
import { prereqViolations, lockedPrereqs } from '../../utils/permissionPrereqs';

const GD_OPTIONS = [
  { value: true, label: 'Grant', tone: 'grant' },
  { value: false, label: 'Deny', tone: 'deny' },
];

export default function RolesPage() {
  const { siteName } = useSite();
  const { user } = useAuth();
  const { showToast } = useToast();
  const confirm = useConfirm();

  // Read-gated pages block on a GET 403 step_up_required (the modal also opens from
  // the same 403 via StepUpProvider); mutations 403 reactively within a lapsed
  // window. A fresh window (post-verify reload) lets everything through.
  const { blocked, guardFetch, verify, guardAction } = useStepupGuard('roles');
  const CREATE_DRAFT = 'roles:create';

  const [loading, setLoading] = useState(true);
  const [roles, setRoles] = useState([]);
  const [rolePerms, setRolePerms] = useState({});
  const [allPerms, setAllPerms] = useState([]);
  const [prereqs, setPrereqs] = useState({});
  const [adminPerms, setAdminPerms] = useState({});
  const [memberCounts, setMemberCounts] = useState({});
  const [defaultRoleId, setDefaultRoleId] = useState(null);

  const [selectedId, setSelectedId] = useState(null);
  const [staged, setStaged] = useState({});     // { key: bool } grants for the selected role
  const original = useRef({});                   // pristine grants for the selected role
  const detailRef = useRef(null);                // detail scroll column — reset to top on role switch
  const [savingPerms, setSavingPerms] = useState(false);

  // Metadata edit (name / level / description) — a plain inline Save.
  const [mName, setMName] = useState('');
  const [mLevel, setMLevel] = useState('');
  const [mDesc, setMDesc] = useState('');
  const metaOrig = useRef({});
  const [savingMeta, setSavingMeta] = useState(false);

  // Create modal.
  const [showCreate, setShowCreate] = useState(false);
  const [cName, setCName] = useState('');
  const [cLevel, setCLevel] = useState('');
  const [cDesc, setCDesc] = useState('');
  const [creating, setCreating] = useState(false);

  // Delete → replacement-default flow (409 default_role).
  const [replaceFor, setReplaceFor] = useState(null);
  const [replaceWith, setReplaceWith] = useState('');
  const [deleting, setDeleting] = useState(false);

  const myLevel = user?.permission_level ?? 0;

  useEffect(() => { if (siteName) document.title = `Roles - ${siteName}`; }, [siteName]);

  const load = useCallback(async () => {
    try {
      const { data, ok } = await guardFetch('/api/admin/roles');
      if (ok && data) {
        setRoles(data.roles || []);
        setRolePerms(data.rolePermissions || {});
        setAllPerms(data.allPermissions || []);
        setPrereqs(data.permissionPrereqs || {});
        setAdminPerms(data.adminPermissions || {});
        setMemberCounts(data.memberCounts || {});
        setDefaultRoleId(data.defaultRoleId ?? null);
        return data;
      }
    } catch { showToast('Failed to load roles.'); }
    finally { setLoading(false); }
    return null;
  }, [guardFetch]);

  useEffect(() => { load(); }, [load]);

  // Restore an in-progress "New role" modal after returning from a step-up redirect
  // (the draft is only present if the user hit Continue, not Cancel).
  useEffect(() => {
    const d = loadDraft(CREATE_DRAFT);
    if (!d) return;
    setCName(d.cName || ''); setCLevel(d.cLevel || ''); setCDesc(d.cDesc || ''); setShowCreate(true);
    // Keep the draft on an ERROR return so the error card's "Try again" (a fresh
    // redirect that doesn't re-save) still restores on the eventual success.
    const o = new URLSearchParams(window.location.search).get('stepup');
    if (o !== 'account' && o !== 'failed' && o !== 'error') clearDraft(CREATE_DRAFT);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Reset the detail column's scroll to the top whenever a different role is selected.
  useEffect(() => { if (detailRef.current) detailRef.current.scrollTop = 0; }, [selectedId]);

  const selectRole = (role, srcPerms = rolePerms, srcAll = allPerms) => {
    setSelectedId(role.role_id);
    const perms = srcPerms[role.role_id] || {};
    const g = {};
    for (const k of srcAll) g[k] = !!perms[k];
    setStaged(g);
    original.current = g;
    setMName(role.role_name || '');
    setMLevel(String(role.permission_level ?? ''));
    setMDesc(role.description || '');
    metaOrig.current = { name: role.role_name || '', level: String(role.permission_level ?? ''), desc: role.description || '' };
  };

  if (!user?.permissions?.manageRoles) {
    return <div className="vs-cv-empty">Permission denied.</div>;
  }

  const selected = roles.find((r) => r.role_id === selectedId) || null;
  const editable = !!selected && selected.permission_level > myLevel; // strictly-lower only

  // Prerequisite state for the selected role's staged grants.
  const violations = prereqViolations(staged, prereqs);
  const locked = lockedPrereqs(staged, prereqs);
  const originalViolations = prereqViolations(original.current, prereqs);
  const hasNewViolations = Object.keys(violations).some((k) => !originalViolations[k]);
  const permsDirty = allPerms.some((k) => adminPerms[k] && !!staged[k] !== !!original.current[k]);
  const metaDirty = mName !== metaOrig.current.name || mLevel !== metaOrig.current.level || mDesc !== metaOrig.current.desc;
  const metaLvl = parseInt(mLevel, 10);
  const metaValid = !!mName.trim() && Number.isInteger(metaLvl) && metaLvl > myLevel && metaLvl <= 9999;
  // Staged permission chips for the save bar (Grant → green +, Deny → red −).
  const permItems = allPerms
    .filter((k) => adminPerms[k] && !!staged[k] !== !!original.current[k])
    .map((k) => ({ label: k, tone: staged[k] ? 'add' : 'remove' }));

  const toggle = (key, val) => setStaged((prev) => ({ ...prev, [key]: val }));

  const savePerms = async () => {
    if (!permsDirty || hasNewViolations) return;
    setSavingPerms(true);
    try {
      const permissions = {};
      for (const k of allPerms) permissions[k] = staged[k] ? '1' : '0';
      const { ok, data } = await apiPut(`/api/admin/roles/${selectedId}`, { permissions });
      if (ok) { showToast('Permissions saved.', 'success'); original.current = { ...staged }; setRolePerms((p) => ({ ...p, [selectedId]: { ...staged } })); }
      else showToast(data?.error || 'Failed to save permissions.');
    } catch (err) { showToast(err.message); }
    finally { setSavingPerms(false); }
  };

  const saveMeta = async () => {
    if (!metaDirty) return;
    const lvl = parseInt(mLevel, 10);
    if (!mName.trim()) { showToast('Role name is required.'); return; }
    if (!Number.isInteger(lvl) || lvl < 0 || lvl > 9999) { showToast('Level must be between 0 and 9999.'); return; }
    if (lvl <= myLevel) { showToast(`Level must be greater than yours (${myLevel}).`); return; }
    setSavingMeta(true);
    try {
      const { ok, data } = await apiPut(`/api/admin/roles/${selectedId}`, { roleName: mName.trim(), permissionLevel: mLevel, description: mDesc });
      if (ok) { showToast('Role updated.', 'success'); await load(); metaOrig.current = { name: mName.trim(), level: mLevel, desc: mDesc }; }
      else showToast(data?.error || 'Failed to update role.');
    } catch (err) { showToast(err.message); }
    finally { setSavingMeta(false); }
  };

  const createRole = async () => {
    const lvl = parseInt(cLevel, 10);
    if (!cName.trim()) { showToast('Role name is required.'); return; }
    if (!Number.isInteger(lvl) || lvl < 0 || lvl > 9999) { showToast('Level must be between 0 and 9999.'); return; }
    if (lvl <= myLevel) { showToast('New role must be lower privilege than you (a higher level number).'); return; }
    setCreating(true);
    try {
      const { ok, data } = await apiPost('/api/admin/roles', { roleName: cName.trim(), permissionLevel: cLevel, description: cDesc });
      if (ok) {
        showToast('Role created.', 'success');
        setShowCreate(false); setCName(''); setCLevel(''); setCDesc('');
        // Initialize the new selection from the FRESH data — a bare setSelectedId
        // would leave staged/original/meta on the previously-selected role.
        const fresh = await load();
        const created = fresh?.roles?.find((r) => r.role_id === data.role_id);
        if (created) selectRole(created, fresh.rolePermissions || {}, fresh.allPermissions || []);
      } else showToast(data?.error || 'Failed to create role.');
    } catch (err) { showToast(err.message); }
    finally { setCreating(false); }
  };

  const doDelete = async (role, newDefault) => {
    setDeleting(true);
    try {
      const body = newDefault !== undefined ? { new_default: newDefault } : undefined;
      const { ok, data, status } = await apiDelete(`/api/admin/roles/${role.role_id}`, body || undefined);
      if (ok) {
        showToast('Role deleted.', 'success');
        setReplaceFor(null); setReplaceWith('');
        if (selectedId === role.role_id) setSelectedId(null);
        await load();
      } else if (status === 409 && data?.error === 'default_role') {
        setReplaceFor(role); setReplaceWith('');
      } else {
        showToast(data?.error || 'Failed to delete role.');
      }
    } catch (err) { showToast(err.message); }
    finally { setDeleting(false); }
  };

  const handleDelete = async (role) => {
    if (!await confirm({ title: 'Delete role?', message: `The role “${role.role_name}” will be deleted. Members are reassigned by the SSO.`, confirmLabel: 'Delete', danger: true })) return;
    doDelete(role);
  };

  return (
    <div className="vs-roles-page">
      <div className="vs-cv-head" style={{ alignItems: 'flex-end' }}>
        <div style={{ minWidth: 0 }}>
          <h1 className="vs-cv-title">Roles</h1>
          <p className="vs-cv-sub">Smaller level = higher privilege. You can edit only roles below your own.</p>
        </div>
        <button className="vs-btn vs-btn-primary" onClick={() => guardAction(() => { setCName(''); setCLevel(''); setCDesc(''); setShowCreate(true); })}>New role</button>
      </div>
        {/* The content's own white card, mounted always — Loading… / the verify
            reminder / the data all fill the same card. */}
        <div className={'vs-roles' + (!loading && !blocked && selected ? ' has-sel' : '')}>
          {blocked ? <StepUpBlock onVerify={verify} /> : loading ? <CardLoading /> : (<>
            <div className="vs-roles-side">
              {roles.map((r) => {
                  const ed = r.permission_level > myLevel;
                  return (
                    <button key={r.role_id} type="button"
                      className={'vs-roles-row' + (r.role_id === selectedId ? ' on' : '')}
                      onClick={() => selectRole(r)}>
                      <div className="vs-roles-mn">
                        <div className="vs-roles-name">{r.role_name}</div>
                        <div className="vs-roles-lvl">level {r.permission_level} · {memberCounts[r.role_id] || 0} {(memberCounts[r.role_id] || 0) === 1 ? 'member' : 'members'}</div>
                      </div>
                      <div className="vs-roles-pills">
                        {r.is_system && <span className="vs-roles-pill sys">system</span>}
                        {r.role_id === defaultRoleId && <span className="vs-roles-pill def">default</span>}
                        {!ed && <span className="vs-roles-pill">view only</span>}
                      </div>
                    </button>
                  );
                })}
            </div>

            <div className="vs-roles-detail" ref={detailRef}>
              {!selected ? (
                <div className="vs-cv-empty" style={{ padding: '56px 16px' }}>Select a role to view or edit it.</div>
              ) : (
                <>
                  <button type="button" className="vs-roles-back" onClick={() => setSelectedId(null)}>‹ Roles</button>
                  <div className="vs-pane-h vs-roles-detail-h">
                    <span>{selected.role_name}</span>
                    {!editable && <span className="vs-roles-pill">View only</span>}
                  </div>
                  <p className="vs-pane-sub">
                    {editable ? 'Edit this role’s details and permissions.' : 'This role is at or above your privilege — read-only.'}
                  </p>

                  {/* Settings */}
                  <div className="vs-field"><div className="vs-label">Name</div>
                      <input className="vs-input" style={{ maxWidth: 360 }} value={mName} disabled={!editable} onChange={(e) => setMName(e.target.value)} /></div>
                    <div className="vs-field"><div className="vs-label">Level</div>
                      <input className="vs-input" type="text" inputMode="numeric" value={mLevel} disabled={!editable}
                        onChange={(e) => setMLevel(e.target.value.replace(/\D/g, ''))} style={{ maxWidth: 120 }} />
                      <div className="vs-hint">Smaller = higher privilege; must stay below your own ({myLevel}).</div></div>
                    <div className="vs-field"><div className="vs-label">Description</div>
                      <input className="vs-input" style={{ maxWidth: 440 }} value={mDesc} disabled={!editable} onChange={(e) => setMDesc(e.target.value)} /></div>
                    {editable && (
                      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                        <button className="vs-btn vs-btn-primary" disabled={!metaDirty || !metaValid || savingMeta} onClick={() => guardAction(saveMeta)}>
                          {savingMeta ? 'Saving…' : 'Save details'}
                        </button>
                        {!selected.is_system
                          ? <button className="vs-btn vs-btn-danger" onClick={() => guardAction(() => handleDelete(selected))}>Delete role</button>
                          : <span className="vs-hint" style={{ marginTop: 0 }}>System role — can’t be deleted.</span>}
                      </div>
                    )}

                  <hr className="vs-roles-div" />
                  <div className="vs-roles-permh">Permissions</div>
                    {permissionGroups(allPerms).map(({ group, keys }) => (
                      <div className="vs-perm-group" key={group}>
                        <div className="vs-perm-grp">{group}</div>
                        {keys.map((key) => {
                          const canEdit = editable && !!adminPerms[key];
                          const val = !!staged[key];
                          const changed = canEdit && val !== !!original.current[key];
                          const bad = !!violations[key];
                          const lockedVals = new Set();
                          if (locked.has(key)) lockedVals.add(false); // can't Deny a needed prereq
                          return (
                            <div className={'vs-perm-row' + (canEdit ? '' : ' locked') + (changed ? ' changed' : '') + (bad ? ' bad' : '')} key={key}>
                              <div className="vs-perm-mn">
                                <div className="vs-perm-name">{permissionLabel(key)}</div>
                                <div className="vs-perm-key">{key}</div>
                                {bad && <div className="vs-perm-note">{prereqReason(violations[key])}</div>}
                              </div>
                              <PermSelector value={val} options={GD_OPTIONS} disabled={!canEdit}
                                lockedValues={lockedVals} invalid={bad} onChange={(v) => toggle(key, v)} />
                            </div>
                          );
                        })}
                      </div>
                    ))}
                  {editable && (
                    <VsSaveBar visible={permsDirty} busy={savingPerms} saveLabel="Save permissions" invalid={hasNewViolations} items={permItems}
                      onSave={() => guardAction(savePerms)} onDiscard={() => setStaged({ ...original.current })} />
                  )}
                </>
              )}
            </div>
          </>)}
        </div>

      {/* Create role modal */}
      {showCreate && (
        <div className="vs-scrim" onMouseDown={() => !creating && setShowCreate(false)}>
          <div className="vs-modal" onMouseDown={(e) => e.stopPropagation()}>
            <div className="vs-modal-head"><div className="vs-modal-title">New role</div>
              <button className="vs-modal-x" aria-label="Close" onClick={() => setShowCreate(false)}>✕</button></div>
            <div className="vs-modal-body">
              <div className="vs-field"><div className="vs-label">Name</div>
                <input className="vs-input" value={cName} autoFocus onChange={(e) => setCName(e.target.value)} placeholder="Teaching assistant" /></div>
              <div className="vs-field"><div className="vs-label">Level</div>
                <input className="vs-input" type="text" inputMode="numeric" value={cLevel}
                  onChange={(e) => setCLevel(e.target.value.replace(/\D/g, ''))} placeholder={`> ${myLevel}`} style={{ maxWidth: 140 }} />
                <div className="vs-hint">Smaller = higher privilege. Must be greater than {myLevel} (below you).</div></div>
              <div className="vs-field"><div className="vs-label">Description <span style={{ color: '#9ca3af' }}>(optional)</span></div>
                <input className="vs-input" value={cDesc} onChange={(e) => setCDesc(e.target.value)} /></div>
              <p className="vs-modal-note">Starts with the default role’s permissions — tune them after.</p>
            </div>
            <div className="vs-modal-foot">
              <button className="vs-btn" onClick={() => setShowCreate(false)} disabled={creating}>Cancel</button>
              <button className="vs-btn vs-btn-primary" onClick={() => guardAction(createRole, { draftKey: CREATE_DRAFT, draft: { cName, cLevel, cDesc } })} disabled={creating}>{creating ? 'Creating…' : 'Create role'}</button>
            </div>
          </div>
        </div>
      )}

      {/* Delete → pick a replacement default */}
      {replaceFor && (
        <div className="vs-scrim" onMouseDown={() => !deleting && setReplaceFor(null)}>
          <div className="vs-modal" onMouseDown={(e) => e.stopPropagation()}>
            <div className="vs-modal-head"><div className="vs-modal-title">Replace default role</div></div>
            <div className="vs-modal-body">
              <p className="vs-pane-sub">“{replaceFor.role_name}” is the current default role. Choose what new users get instead.</p>
              <div className="vs-field"><div className="vs-label">New default</div>
                <select className="vs-input" value={replaceWith} onChange={(e) => setReplaceWith(e.target.value)}>
                  <option value="">No access</option>
                  {roles.filter((r) => r.role_id !== replaceFor.role_id && r.permission_level > myLevel).map((r) => (
                    <option key={r.role_id} value={r.role_id}>{r.role_name} (level {r.permission_level})</option>
                  ))}
                </select></div>
            </div>
            <div className="vs-modal-foot">
              <button className="vs-btn" onClick={() => setReplaceFor(null)} disabled={deleting}>Cancel</button>
              <button className="vs-btn vs-btn-danger" disabled={deleting}
                onClick={() => guardAction(() => doDelete(replaceFor, replaceWith === '' ? null : parseInt(replaceWith, 10)))}>
                {deleting ? 'Deleting…' : 'Delete role'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
