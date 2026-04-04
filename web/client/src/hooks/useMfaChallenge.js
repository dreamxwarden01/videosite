import { useState, useCallback, useRef } from 'react';
import { apiFetch } from '../api';

export default function useMfaChallenge() {
  const [mfaState, setMfaState] = useState(null);
  const [mfaSetupState, setMfaSetupState] = useState(null);
  const [lastChallengeId, setLastChallengeId] = useState(null);
  const pendingRef = useRef(null);

  const mfaFetch = useCallback(async (url, options = {}) => {
    const result = await apiFetch(url, options);

    // Check for MFA requirement
    if (result.status === 403 && result.data?.requireMFA) {
      if (result.data.mfaSetupRequired) {
        // Show setup-required popup and wait for user to dismiss
        return new Promise((resolve) => {
          pendingRef.current = { resolve, result };
          setMfaSetupState({
            mfaEnabled: result.data.mfaEnabled !== false,
            requiredMethods: result.data.requiredMethods || []
          });
        });
      }

      // MFA challenge needed — show modal and wait for resolution
      return new Promise((resolve, reject) => {
        pendingRef.current = { url, options, resolve, reject };
        setMfaState({
          challengeId: result.data.challengeId,
          allowedMethods: result.data.allowedMethods,
          maskedEmail: result.data.maskedEmail
        });
      });
    }

    return result;
  }, []);

  const onMfaSuccess = useCallback(async (challengeId) => {
    setLastChallengeId(challengeId);
    const pending = pendingRef.current;
    if (!pending) return;
    pendingRef.current = null;
    setMfaState(null);

    // Retry the original request with the MFA challenge header
    try {
      const retryOptions = {
        ...pending.options,
        headers: {
          ...(pending.options.headers || {}),
          'X-MFA-Challenge': challengeId
        }
      };
      const result = await apiFetch(pending.url, retryOptions);
      pending.resolve(result);
    } catch (err) {
      pending.reject(err);
    }
  }, []);

  const onMfaCancel = useCallback(() => {
    const pending = pendingRef.current;
    if (pending) {
      // Resolve with the original 403 so the caller doesn't hang
      pending.resolve({ data: { error: 'Verification cancelled' }, status: 403, ok: false });
    }
    pendingRef.current = null;
    setMfaState(null);
  }, []);

  const dismissMfaSetup = useCallback(() => {
    const pending = pendingRef.current;
    if (pending) {
      pending.resolve({ data: { error: 'MFA setup required' }, status: 403, ok: false });
    }
    pendingRef.current = null;
    setMfaSetupState(null);
  }, []);

  const clearMfa = useCallback(() => {
    pendingRef.current = null;
    setMfaState(null);
    setMfaSetupState(null);
  }, []);

  return { mfaFetch, mfaState, mfaSetupState, onMfaSuccess, onMfaCancel, dismissMfaSetup, clearMfa, lastChallengeId };
}
