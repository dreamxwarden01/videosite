import { useState, useEffect, useCallback } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useSite } from '../../context/SiteContext';
import { useAuth } from '../../context/AuthContext';
import { useToast } from '../../context/ToastContext';
import { useConfirm } from '../../components/ConfirmModal';
import useMfaPageGuard from '../../hooks/useMfaPageGuard';
import useMfaChallenge from '../../hooks/useMfaChallenge';
import MfaPageGuard, { MfaSetupRequiredModal } from '../../components/MfaPageGuard';
import MfaChallengeUI from '../../components/MfaChallengeUI';
import Pagination from '../../components/Pagination';
import LoadingSpinner from '../../components/LoadingSpinner';

export default function UsersPage() {
  const { siteName } = useSite();
  const { user } = useAuth();
  const { showToast } = useToast();
  const confirm = useConfirm();
  const [searchParams, setSearchParams] = useSearchParams();

  const { mfaBlock, mfaSetupBlock, autoShowModal, mfaPageFetch, handlePageMfaSuccess, handlePageMfaCancel, retryVerification, mfaVerifiedKey } = useMfaPageGuard();
  const { mfaFetch, mfaState, mfaSetupState, onMfaSuccess, onMfaCancel, dismissMfaSetup } = useMfaChallenge();

  const [users, setUsers] = useState([]);
  const [page, setPage] = useState(parseInt(searchParams.get('page')) || 1);
  const [totalPages, setTotalPages] = useState(1);
  const [total, setTotal] = useState(0);
  const [limit, setLimit] = useState(10);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  // Activity modal
  const [activityUser, setActivityUser] = useState(null);
  const [sessions, setSessions] = useState([]);
  const [sessionsLoading, setSessionsLoading] = useState(false);

  useEffect(() => {
    document.title = `User Management - ${siteName}`;
  }, [siteName]);

  const fetchUsers = useCallback(async () => {
    if (!loading) setRefreshing(true);
    try {
      const { data, ok } = await mfaPageFetch(`/api/admin/users?page=${page}&limit=${limit}`);
      if (ok && data) {
        setUsers(data.users || []);
        setTotalPages(data.totalPages || 1);
        setTotal(data.total || 0);
      }
    } catch {
      // ignore
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [page, limit, mfaPageFetch]);

  useEffect(() => {
    fetchUsers();
  }, [fetchUsers, mfaVerifiedKey]);

  if (!user?.permissions?.manageUser) {
    return <p className="text-muted">Permission denied.</p>;
  }

  const handleDelete = async (userId, username) => {
    if (!await confirm(`Delete user '${username}'?`)) return;
    try {
      const { ok, data } = await mfaFetch(`/api/admin/users/${userId}`, { method: 'DELETE' });
      if (ok) {
        showToast('User deleted.', 'success');
        fetchUsers();
      } else {
        showToast(data?.error || 'Failed to delete user.');
      }
    } catch (err) {
      showToast(err.message);
    }
  };

  const openActivityModal = async (u) => {
    setActivityUser(u);
    setSessions([]);
    setSessionsLoading(true);

    try {
      const { data, ok } = await mfaFetch(`/api/admin/users/${u.user_id}/sessions`, { method: 'GET' });
      if (ok && data) {
        setSessions(data.sessions || []);
      }
    } catch (err) {
      showToast('Failed to load sessions: ' + err.message);
    } finally {
      setSessionsLoading(false);
    }
  };

  const handleTerminateAll = async () => {
    if (!activityUser) return;
    if (!await confirm('Terminate all sessions for this user? They will be signed out everywhere.')) return;

    try {
      const { ok, data } = await mfaFetch(`/api/admin/users/${activityUser.user_id}/sessions/terminate-all`, { method: 'POST' });
      if (ok) {
        showToast('All sessions terminated.', 'success');
        setSessions([]);
      } else {
        showToast('Failed: ' + (data?.error || 'Unknown error'));
      }
    } catch (err) {
      showToast('Failed: ' + err.message);
    }
  };

  const handlePageChange = (newPage) => {
    setPage(newPage);
    setSearchParams({ page: newPage });
  };

  const handleLimitChange = (newLimit) => {
    setLimit(newLimit);
    setPage(1);
    setSearchParams({ page: 1 });
  };

  if (loading) return <LoadingSpinner />;

  return (
    <MfaPageGuard mfaBlock={mfaBlock} mfaSetupBlock={mfaSetupBlock} autoShowModal={autoShowModal}
      onSuccess={handlePageMfaSuccess} onCancel={handlePageMfaCancel} onRetry={retryVerification}>
      <div>
        <div className="flex-between mb-3">
          <h1>User Management</h1>
          {user.permissions.addUser && (
            <Link to="/admin/users/new" className="btn btn-primary">Add User</Link>
          )}
        </div>

        <div className="card">
          <div className={`table-wrap${refreshing ? ' data-loading' : ''}`}>
            <table>
              <thead>
                <tr>
                  <th>Username</th>
                  <th>Display Name</th>
                  <th>Role</th>
                  <th>Status</th>
                  <th>Created</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {users.map(u => (
                  <tr key={u.user_id}>
                    <td>{u.username}</td>
                    <td>{u.display_name}</td>
                    <td>{u.role_name}</td>
                    <td>
                      <span className={`status ${u.is_active ? 'status-finished' : 'status-error'}`}>
                        {u.is_active ? 'Active' : 'Inactive'}
                      </span>
                    </td>
                    <td>{new Date(u.created_at).toLocaleDateString()}</td>
                    <td>
                      {user.permissions.changeUser && (
                        <>
                          <Link to={`/admin/users/${u.user_id}/edit`} className="btn btn-secondary btn-sm">Edit</Link>
                          <button
                            className="btn btn-secondary btn-sm"
                            onClick={() => openActivityModal(u)}
                          >
                            Activity
                          </button>
                        </>
                      )}
                      {user.permissions.deleteUser && (
                        <button
                          className="btn btn-danger btn-sm"
                          onClick={() => handleDelete(u.user_id, u.username)}
                        >
                          Delete
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
                {users.length === 0 && (
                  <tr>
                    <td colSpan="6" className="text-muted" style={{ textAlign: 'center', padding: '20px' }}>
                      No users found
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <Pagination
            page={page}
            totalPages={totalPages}
            total={total}
            limit={limit}
            onPageChange={handlePageChange}
            onLimitChange={handleLimitChange}
            itemLabel="user"
          />
        </div>

        {/* Activity / Sessions Modal */}
        {activityUser && (
          <div className="modal-overlay active" onClick={() => setActivityUser(null)}>
            <div className="modal" style={{ maxWidth: '640px' }} onClick={e => e.stopPropagation()}>
              <div className="modal-header">
                <h3>Sessions &mdash; {activityUser.username}</h3>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  {sessions.length > 0 && (
                    <button className="btn btn-danger btn-sm" onClick={handleTerminateAll}>Terminate All</button>
                  )}
                  <button className="modal-close" onClick={() => setActivityUser(null)}>&times;</button>
                </div>
              </div>
              <div className="modal-body" style={{ padding: 0 }}>
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Device</th>
                        <th>IP Address</th>
                        <th>Last Activity</th>
                        <th>Signed In</th>
                      </tr>
                    </thead>
                    <tbody>
                      {sessionsLoading && (
                        <tr>
                          <td colSpan="4" className="text-muted" style={{ textAlign: 'center', padding: '16px' }}>Loading...</td>
                        </tr>
                      )}
                      {!sessionsLoading && sessions.length === 0 && (
                        <tr>
                          <td colSpan="4" className="text-muted" style={{ textAlign: 'center', padding: '16px' }}>No active sessions</td>
                        </tr>
                      )}
                      {!sessionsLoading && sessions.map((s, i) => (
                        <tr key={i}>
                          <td>{s.deviceName || 'Unknown'}</td>
                          <td>{s.ip_address || 'Unknown'}</td>
                          <td>{new Date(s.last_activity).toLocaleString()}</td>
                          <td>{new Date(s.last_sign_in).toLocaleString()}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
              <div className="modal-footer" style={{ justifyContent: 'flex-end' }}>
                <button className="btn btn-secondary" onClick={() => setActivityUser(null)}>OK</button>
              </div>
            </div>
          </div>
        )}
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
