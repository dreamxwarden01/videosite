import { useState, useEffect, useCallback } from 'react';
import { useSite } from '../../context/SiteContext';
import { useAuth } from '../../context/AuthContext';
import { useToast } from '../../context/ToastContext';
import { useConfirm } from '../../components/ConfirmModal';
import useMfaPageGuard from '../../hooks/useMfaPageGuard';
import useMfaChallenge from '../../hooks/useMfaChallenge';
import MfaPageGuard, { MfaSetupRequiredModal } from '../../components/MfaPageGuard';
import MfaChallengeUI from '../../components/MfaChallengeUI';
import LoadingSpinner from '../../components/LoadingSpinner';

export default function RolesPage() {
  const { siteName } = useSite();
  const { user } = useAuth();
  const { showToast } = useToast();
  const confirm = useConfirm();

  const { mfaBlock, mfaSetupBlock, autoShowModal, mfaPageFetch, handlePageMfaSuccess, handlePageMfaCancel, retryVerification, mfaVerifiedKey } = useMfaPageGuard();
  const { mfaFetch, mfaState, mfaSetupState, onMfaSuccess, onMfaCancel, dismissMfaSetup } = useMfaChallenge();

  const [roles, setRoles] = useState([]);
  const [rolePermissions, setRolePermissions] = useState({});
  const [allPermissions, setAllPermissions] = useState([]);
  const [adminPermissions, setAdminPermissions] = useState({});
  const [loading, setLoading] = useState(true);

  // Expanded edit rows
  const [expandedRoleId, setExpandedRoleId] = useState(null);

  // Edit form state
  const [editRoleId, setEditRoleId] = useState('');
  const [editRoleName, setEditRoleName] = useState('');
  const [editLevel, setEditLevel] = useState('');
  const [editDescription, setEditDescription] = useState('');
  const [editPerms, setEditPerms] = useState({});
  const [editSaving, setEditSaving] = useState(false);

  // Create form state
  const [newRoleId, setNewRoleId] = useState('');
  const [newLevel, setNewLevel] = useState('');
  const [newName, setNewName] = useState('');
  const [newDescription, setNewDescription] = useState('');
  const [newPerms, setNewPerms] = useState({});
  const [createSaving, setCreateSaving] = useState(false);

  useEffect(() => {
    document.title = `Role Management - ${siteName}`;
  }, [siteName]);

  const fetchRoles = useCallback(async () => {
    try {
      const { data, ok } = await mfaPageFetch('/api/admin/roles');
      if (ok && data) {
        setRoles(data.roles || []);
        setRolePermissions(data.rolePermissions || {});
        setAllPermissions(data.allPermissions || []);
        setAdminPermissions(data.adminPermissions || {});
      }
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, [mfaPageFetch]);

  useEffect(() => {
    fetchRoles();
  }, [fetchRoles, mfaVerifiedKey]);

  if (!user?.permissions?.manageRoles) {
    return <p className="text-muted">Permission denied.</p>;
  }

  if (loading) return <LoadingSpinner />;

  const toggleExpand = (role) => {
    if (expandedRoleId === role.role_id) {
      setExpandedRoleId(null);
      return;
    }
    setExpandedRoleId(role.role_id);
    setEditRoleId(String(role.role_id));
    setEditRoleName(role.role_name);
    setEditLevel(String(role.permission_level));
    setEditDescription(role.description || '');
    // Load current permissions
    const perms = rolePermissions[role.role_id] || {};
    setEditPerms({ ...perms });
  };

  const handleEditSave = async (originalRoleId) => {
    // Client-side duplicate checks
    const parsedEditId = parseInt(editRoleId);
    if (parsedEditId !== originalRoleId && roles.some(r => r.role_id === parsedEditId)) {
      showToast('Role ID already exists.');
      return;
    }
    if (editRoleName && editRoleName !== roles.find(r => r.role_id === originalRoleId)?.role_name
        && roles.some(r => r.role_name.toLowerCase() === editRoleName.toLowerCase() && r.role_id !== originalRoleId)) {
      showToast('Role name already exists.');
      return;
    }
    setEditSaving(true);
    try {
      const permissionsBody = {};
      for (const perm of allPermissions) {
        if (!adminPermissions[perm]) {
          // Preserve existing value for keys admin doesn't have
          permissionsBody[perm] = (rolePermissions[originalRoleId]?.[perm]) ? '1' : '0';
        } else {
          permissionsBody[perm] = editPerms[perm] ? '1' : '0';
        }
      }

      const { ok, data } = await mfaFetch(`/api/admin/roles/${originalRoleId}`, {
        method: 'PUT', body: {
          newRoleId: editRoleId,
          roleName: editRoleName,
          permissionLevel: editLevel,
          description: editDescription,
          permissions: permissionsBody
        }
      });
      if (ok) {
        showToast('Role updated.', 'success');
        setExpandedRoleId(null);
        fetchRoles();
      } else {
        showToast(data?.error || 'Failed to update role.');
      }
    } catch (err) {
      showToast(err.message);
    } finally {
      setEditSaving(false);
    }
  };

  const handleDelete = async (roleId, roleName) => {
    if (!await confirm(`Remove role '${roleName}'? Users with this role will be reassigned to 'user'.`)) return;
    try {
      const { ok, data } = await mfaFetch(`/api/admin/roles/${roleId}`, { method: 'DELETE' });
      if (ok) {
        showToast('Role removed.', 'success');
        fetchRoles();
      } else {
        showToast(data?.error || 'Failed to remove role.');
      }
    } catch (err) {
      showToast(err.message);
    }
  };

  const handleCreate = async (e) => {
    e.preventDefault();
    // Client-side duplicate checks
    const parsedNewId = parseInt(newRoleId);
    if (roles.some(r => r.role_id === parsedNewId)) {
      showToast('Role ID already exists.');
      return;
    }
    if (newName && roles.some(r => r.role_name.toLowerCase() === newName.toLowerCase())) {
      showToast('Role name already exists.');
      return;
    }
    setCreateSaving(true);
    try {
      const permissionsBody = {};
      for (const perm of allPermissions) {
        if (!adminPermissions[perm]) {
          permissionsBody[perm] = '0'; // default false for keys admin doesn't have
        } else {
          permissionsBody[perm] = newPerms[perm] ? '1' : '0';
        }
      }

      const { ok, data } = await mfaFetch('/api/admin/roles', {
        method: 'POST', body: {
          roleId: newRoleId,
          roleName: newName,
          permissionLevel: newLevel,
          description: newDescription,
          permissions: permissionsBody
        }
      });
      if (ok) {
        showToast('Role created.', 'success');
        setNewRoleId('');
        setNewLevel('');
        setNewName('');
        setNewDescription('');
        setNewPerms({});
        fetchRoles();
      } else {
        showToast(data?.error || 'Failed to create role.');
      }
    } catch (err) {
      showToast(err.message);
    } finally {
      setCreateSaving(false);
    }
  };

  return (
    <MfaPageGuard mfaBlock={mfaBlock} mfaSetupBlock={mfaSetupBlock} autoShowModal={autoShowModal}
      onSuccess={handlePageMfaSuccess} onCancel={handlePageMfaCancel} onRetry={retryVerification}>
    <div>
      <h1 className="mb-3">Role Management</h1>

      <div className="card">
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>ID</th>
                <th>Name</th>
                <th>Level</th>
                <th>System</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {roles.map(r => {
                const canEdit = r.permission_level > user.permission_level;
                return [
                  <tr key={r.role_id}>
                    <td>{r.role_id}</td>
                    <td>{r.role_name}</td>
                    <td>{r.permission_level}</td>
                    <td>{r.is_system ? 'Yes' : 'No'}</td>
                    <td>
                      {canEdit ? (
                        <>
                          <button
                            className="btn btn-secondary btn-sm"
                            onClick={() => toggleExpand(r)}
                          >
                            {expandedRoleId === r.role_id ? 'Close' : 'Edit'}
                          </button>
                          {!r.is_system && (
                            <button
                              className="btn btn-danger btn-sm"
                              onClick={() => handleDelete(r.role_id, r.role_name)}
                            >
                              Remove
                            </button>
                          )}
                        </>
                      ) : (
                        <span className="text-muted text-sm">Higher authority</span>
                      )}
                    </td>
                  </tr>,
                  expandedRoleId === r.role_id && canEdit && (
                    <tr key={`edit-${r.role_id}`}>
                      <td colSpan="5" style={{ padding: '16px 12px', background: '#f8f9fa' }}>
                        <div style={{ maxWidth: '700px' }}>
                          <div className="flex gap-2" style={{ flexWrap: 'wrap' }}>
                            <div className="form-group" style={{ flex: 1, minWidth: '120px' }}>
                              <label>Role ID (0-99)</label>
                              <input type="number" className="form-control"
                                value={editRoleId} onChange={e => setEditRoleId(e.target.value)}
                                min="0" max="99" required />
                            </div>
                            <div className="form-group" style={{ flex: 2, minWidth: '180px' }}>
                              <label>Role Name</label>
                              <input type="text" className="form-control"
                                value={editRoleName} onChange={e => setEditRoleName(e.target.value)} required />
                            </div>
                            <div className="form-group" style={{ flex: 1, minWidth: '120px' }}>
                              <label>Level (0-99)</label>
                              <input type="number" className="form-control"
                                value={editLevel} onChange={e => setEditLevel(e.target.value)}
                                min="0" max="99" required />
                            </div>
                          </div>
                          <div className="form-group">
                            <label>Description</label>
                            <input type="text" className="form-control"
                              value={editDescription} onChange={e => setEditDescription(e.target.value)} />
                          </div>
                          <div className="form-group">
                            <label style={{ marginBottom: '8px' }}>Permissions</label>
                            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: '4px 16px' }}>
                              {allPermissions.map(perm => {
                                const canEditPerm = !!adminPermissions[perm];
                                return (
                                  <label key={perm} style={{ display: 'flex', alignItems: 'center', gap: '6px', fontWeight: 400, fontSize: '13px', padding: '3px 0', cursor: canEditPerm ? 'pointer' : 'not-allowed', opacity: canEditPerm ? 1 : 0.4 }}>
                                    <input
                                      type="checkbox"
                                      checked={!!editPerms[perm]}
                                      onChange={e => setEditPerms(prev => ({ ...prev, [perm]: e.target.checked }))}
                                      disabled={!canEditPerm}
                                    />
                                    {perm}
                                  </label>
                                );
                              })}
                            </div>
                          </div>
                          <div className="flex gap-2">
                            <button className="btn btn-primary btn-sm" onClick={() => handleEditSave(r.role_id)} disabled={editSaving}>
                              {editSaving ? 'Saving...' : 'Save Changes'}
                            </button>
                            <button className="btn btn-secondary btn-sm" onClick={() => setExpandedRoleId(null)}>Cancel</button>
                          </div>
                        </div>
                      </td>
                    </tr>
                  )
                ];
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Add New Role */}
      <div className="card mt-3">
        <div className="card-header">
          <h2>Add New Role</h2>
        </div>
        <form onSubmit={handleCreate} style={{ maxWidth: '600px' }}>
          <div className="flex gap-2">
            <div className="form-group" style={{ flex: 1 }}>
              <label htmlFor="newRoleId">Role ID (0-99)</label>
              <input type="number" id="newRoleId" className="form-control"
                value={newRoleId} onChange={e => setNewRoleId(e.target.value)}
                min="0" max="99" required />
            </div>
            <div className="form-group" style={{ flex: 1 }}>
              <label htmlFor="newLevel">Permission Level (0-99)</label>
              <input type="number" id="newLevel" className="form-control"
                value={newLevel} onChange={e => setNewLevel(e.target.value)}
                min="0" max="99" required />
            </div>
          </div>
          <div className="form-group">
            <label htmlFor="newName">Role Name</label>
            <input type="text" id="newName" className="form-control"
              value={newName} onChange={e => setNewName(e.target.value)} required />
          </div>
          <div className="form-group">
            <label htmlFor="newDesc">Description</label>
            <input type="text" id="newDesc" className="form-control"
              value={newDescription} onChange={e => setNewDescription(e.target.value)} />
          </div>
          <div className="form-group">
            <label style={{ marginBottom: '8px' }}>Permissions</label>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: '4px 16px' }}>
              {allPermissions.map(perm => {
                const canEditPerm = !!adminPermissions[perm];
                return (
                  <label key={perm} style={{ display: 'flex', alignItems: 'center', gap: '6px', fontWeight: 400, fontSize: '13px', padding: '3px 0', cursor: canEditPerm ? 'pointer' : 'not-allowed', opacity: canEditPerm ? 1 : 0.4 }}>
                    <input
                      type="checkbox"
                      checked={!!newPerms[perm]}
                      onChange={e => setNewPerms(prev => ({ ...prev, [perm]: e.target.checked }))}
                      disabled={!canEditPerm}
                    />
                    {perm}
                  </label>
                );
              })}
            </div>
          </div>
          <button type="submit" className="btn btn-primary" disabled={createSaving}>
            {createSaving ? 'Creating...' : 'Create Role'}
          </button>
        </form>
      </div>
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
