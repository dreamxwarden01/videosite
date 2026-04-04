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
import Pagination from '../../components/Pagination';
import LoadingSpinner from '../../components/LoadingSpinner';

function formatDate(dateStr) {
  if (!dateStr) return '-';
  return new Date(dateStr).toLocaleString();
}

export default function InvitationsPage() {
  const { siteName } = useSite();
  const { user } = useAuth();
  const { showToast } = useToast();
  const confirm = useConfirm();
  const [searchParams, setSearchParams] = useSearchParams();

  const { mfaBlock, mfaSetupBlock, autoShowModal, mfaPageFetch, handlePageMfaSuccess, handlePageMfaCancel, retryVerification, mfaVerifiedKey } = useMfaPageGuard();
  const { mfaFetch, mfaState, mfaSetupState, onMfaSuccess, onMfaCancel, dismissMfaSetup } = useMfaChallenge();

  const page = parseInt(searchParams.get('page')) || 1;
  const limit = [10, 20, 50].includes(parseInt(searchParams.get('limit'))) ? parseInt(searchParams.get('limit')) : 10;

  const [codes, setCodes] = useState([]);
  const [pagination, setPagination] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  // Create modal state
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [validityHours, setValidityHours] = useState(72);
  const [creating, setCreating] = useState(false);

  // Result modal state
  const [generatedCode, setGeneratedCode] = useState(null);
  const [generatedExpires, setGeneratedExpires] = useState(null);
  const [copyLabel, setCopyLabel] = useState('Copy');

  useEffect(() => {
    document.title = `Invitation Codes - ${siteName}`;
  }, [siteName]);

  const fetchCodes = useCallback(async () => {
    if (!loading) setRefreshing(true);
    try {
      const { data, ok } = await mfaPageFetch(`/api/admin/invitations?page=${page}&limit=${limit}`);
      if (ok && data) {
        setCodes(data.codes || []);
        setPagination(data.pagination || null);
      }
    } catch {
      // ignore
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [page, limit, mfaPageFetch]);

  useEffect(() => {
    fetchCodes();
  }, [fetchCodes, mfaVerifiedKey]);

  if (!user?.permissions?.inviteUser) {
    return <p className="text-muted">Permission denied.</p>;
  }

  const handleCreate = async () => {
    setCreating(true);
    try {
      const hours = parseInt(validityHours) || 72;
      const { data, ok } = await mfaFetch('/api/admin/invitations', { method: 'POST', body: { validity_hours: hours } });
      if (!ok) throw new Error(data?.error || 'Failed to create code');

      setShowCreateModal(false);
      setGeneratedCode(data.code);
      setGeneratedExpires(data.expires_at);
      setCopyLabel('Copy');
      fetchCodes();
    } catch (err) {
      showToast(err.message);
    } finally {
      setCreating(false);
    }
  };

  const handleRemove = async (code) => {
    if (!await confirm(`Remove invitation code "${code}"?`)) return;
    try {
      const { data, ok } = await mfaFetch(`/api/admin/invitations/${code}`, { method: 'DELETE' });
      if (!ok) throw new Error(data?.error || 'Failed to remove code');
      setCodes(prev => prev.filter(c => c.code !== code));
      showToast('Invitation code removed.', 'success');
    } catch (err) {
      showToast(err.message);
    }
  };

  const handleCopy = () => {
    if (!generatedCode) return;
    navigator.clipboard.writeText(generatedCode).then(() => {
      setCopyLabel('Copied!');
      setTimeout(() => setCopyLabel('Copy'), 1500);
    }).catch(() => {});
  };

  if (loading) return <LoadingSpinner />;

  return (
    <MfaPageGuard mfaBlock={mfaBlock} mfaSetupBlock={mfaSetupBlock} autoShowModal={autoShowModal}
      onSuccess={handlePageMfaSuccess} onCancel={handlePageMfaCancel} onRetry={retryVerification}>
    <div>
      <div className="flex-between mb-3">
        <h1>Invitation Codes</h1>
        <button className="btn btn-primary" onClick={() => { setValidityHours(72); setShowCreateModal(true); }}>
          Create Code
        </button>
      </div>

      <div className="card">
        <div className={`table-wrap${refreshing ? ' data-loading' : ''}`}>
          <table>
            <thead>
              <tr>
                <th>Code</th>
                <th>Created By</th>
                <th>Created At</th>
                <th>Expires At</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {codes.map(c => (
                <tr key={c.code}>
                  <td><code>{c.code}</code></td>
                  <td>{c.creator_name || 'Unknown'}</td>
                  <td>{formatDate(c.created_at)}</td>
                  <td>{formatDate(c.expires_at)}</td>
                  <td>
                    {((c.created_by === user.user_id) || (c.creator_level !== null && c.creator_level > user.permission_level)) && (
                      <button className="btn btn-danger btn-sm" onClick={() => handleRemove(c.code)}>Remove</button>
                    )}
                  </td>
                </tr>
              ))}
              {codes.length === 0 && (
                <tr>
                  <td colSpan="5" className="text-muted" style={{ textAlign: 'center', padding: '20px' }}>
                    No invitation codes
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {pagination && (
          <Pagination
            page={pagination.page}
            totalPages={pagination.totalPages}
            total={pagination.total}
            limit={pagination.limit}
            onPageChange={(p) => setSearchParams({ page: p, limit })}
            onLimitChange={(l) => setSearchParams({ page: 1, limit: l })}
            itemLabel="code"
          />
        )}
      </div>

      {/* Create Code Modal */}
      {showCreateModal && (
        <div className="content-overlay active" onClick={() => setShowCreateModal(false)}>
          <div className="wk-modal" onClick={e => e.stopPropagation()}>
            <div className="wk-modal-header"><h3>Create Invitation Code</h3></div>
            <div className="wk-modal-body">
              <div className="form-group">
                <label htmlFor="validityHours">Validity (hours)</label>
                <input
                  type="number"
                  id="validityHours"
                  className="form-control"
                  value={validityHours}
                  onChange={e => setValidityHours(e.target.value)}
                  min="1"
                  style={{ maxWidth: '200px' }}
                />
              </div>
            </div>
            <div className="wk-modal-footer">
              <button className="btn btn-secondary btn-sm" onClick={() => setShowCreateModal(false)}>Cancel</button>
              <button className="btn btn-primary btn-sm" onClick={handleCreate} disabled={creating}>
                {creating ? 'Generating...' : 'Confirm'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Generated Code Modal */}
      {generatedCode && (
        <div className="content-overlay active" onClick={() => setGeneratedCode(null)}>
          <div className="wk-modal" onClick={e => e.stopPropagation()}>
            <div className="wk-modal-header"><h3>Invitation Code Created</h3></div>
            <div className="wk-modal-body">
              <div className="wk-field">
                <label>Code</label>
                <div className="wk-field-row">
                  <input type="text" readOnly value={generatedCode} />
                  <button type="button" className="btn btn-sm" onClick={handleCopy}>{copyLabel}</button>
                </div>
              </div>
              {generatedExpires && (
                <p className="text-muted" style={{ marginTop: '12px', fontSize: '13px' }}>
                  Expires: {new Date(generatedExpires).toLocaleString()}
                </p>
              )}
            </div>
            <div className="wk-modal-footer">
              <button className="btn btn-primary btn-sm" onClick={() => setGeneratedCode(null)}>OK</button>
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
