import MfaChallengeUI from './MfaChallengeUI';
import { useAuth } from '../context/AuthContext';

// MFA is managed in the account portal now (this videosite is an SSO RP); the
// local step-up flow is slated for the SSO step-up ceremony. Until then, the
// "set up MFA" prompts send the user to the portal rather than a local page.

const METHOD_LABELS = {
  authenticator: 'Authenticator App',
  passkey: 'Passkey',
  email: 'Email',
};

function formatMethods(methods) {
  return methods.map(m => METHOD_LABELS[m] || m);
}

export default function MfaPageGuard({
  mfaBlock,
  mfaSetupBlock,
  autoShowModal,
  onSuccess,
  onCancel,
  onRetry,
  children,
}) {
  const { user } = useAuth();
  if (mfaSetupBlock) {
    const methods = mfaSetupBlock.requiredMethods || [];
    const methodNames = formatMethods(methods);

    return (
      <div style={{ maxWidth: '420px', margin: '80px auto', textAlign: 'center' }}>
        <h2 style={{ marginBottom: '8px' }}>MFA Required</h2>
        <p className="text-muted" style={{ marginBottom: '16px' }}>
          {mfaSetupBlock.mfaEnabled
            ? 'Your account does not have the required verification methods to access this page.'
            : 'You must enable multi-factor authentication to access this page.'}
        </p>
        {methods.length > 0 && (
          <p className="text-muted" style={{ marginBottom: '24px' }}>
            Your account must have at least one of the following methods enabled: {methodNames.join(', ')}.
          </p>
        )}
        <a href={user?.account_portal || '/'} target="_blank" rel="noreferrer" className="btn btn-primary">Go to MFA Settings</a>
      </div>
    );
  }

  if (!mfaBlock) return children;

  return (
    <>
      <div style={{ maxWidth: '420px', margin: '80px auto', textAlign: 'center' }}>
        <h2 style={{ marginBottom: '8px' }}>Verification Required</h2>
        <p className="text-muted" style={{ marginBottom: '24px' }}>
          This section requires additional identity verification to access.
        </p>
        {!autoShowModal && (
          <button className="btn btn-primary" onClick={onRetry}>Verify</button>
        )}
      </div>

      {autoShowModal && (
        <MfaChallengeUI
          isModal={true}
          challengeId={mfaBlock.challengeId}
          allowedMethods={mfaBlock.allowedMethods}
          maskedEmail={mfaBlock.maskedEmail}
          apiBase="/api/mfa/challenge"
          onSuccess={onSuccess}
          onCancel={onCancel}
          title="Verify your identity"
        />
      )}
    </>
  );
}

/**
 * Modal popup shown when a write operation requires MFA setup.
 * Two scenarios: user has no MFA at all, or has MFA but missing required methods.
 */
export function MfaSetupRequiredModal({ mfaSetupState, onDismiss }) {
  const { user } = useAuth();

  if (!mfaSetupState) return null;

  const methods = mfaSetupState.requiredMethods || [];
  const methodNames = formatMethods(methods);

  return (
    // Overlay click is a no-op — dismissing this prompt by mis-clicking
    // outside the box would silently abandon the privileged action the
    // user was trying to perform, with no feedback. Force them through
    // the explicit OK / Go-to-Settings buttons.
    <div className="modal-overlay active" onClick={() => {}}>
      <div className="upload-modal" onClick={e => e.stopPropagation()} style={{ maxWidth: '420px' }}>
        <div className="modal-header">
          <h3>MFA Required</h3>
        </div>
        <div className="modal-body" style={{ textAlign: 'center', padding: '24px 20px' }}>
          <p style={{ marginBottom: '12px' }}>
            {mfaSetupState.mfaEnabled
              ? 'Your account does not have the required verification methods to perform this action.'
              : 'You must enable multi-factor authentication to perform this action.'}
          </p>
          {methods.length > 0 && (
            <p className="text-muted" style={{ marginBottom: '0' }}>
              Required: {methodNames.join(', ')}.
            </p>
          )}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '12px', padding: '0 20px 20px' }}>
          <button className="btn btn-primary" style={{ fontSize: '13px', padding: '4px 16px' }} onClick={() => { onDismiss(); if (user?.account_portal) window.open(user.account_portal, '_blank', 'noopener'); }}>
            Go to MFA Settings
          </button>
          <button className="btn btn-secondary" style={{ width: '100%', justifyContent: 'center' }} onClick={onDismiss}>OK</button>
        </div>
      </div>
    </div>
  );
}
