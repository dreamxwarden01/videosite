import { useState, useCallback, useRef } from 'react';
import { apiFetch } from '../api';

/**
 * Hook for page-load MFA protection.
 * Wraps apiFetch to detect 403+requireMFA on GETs and set a page-level block.
 * Separate from useMfaChallenge which handles modal-based mutation retries.
 */
export default function useMfaPageGuard() {
  const [mfaBlock, setMfaBlock] = useState(null);
  const [mfaSetupBlock, setMfaSetupBlock] = useState(null);
  const [autoShowModal, setAutoShowModal] = useState(false);
  const [mfaVerifiedKey, setMfaVerifiedKey] = useState(0);
  const lastPageChallengeIdRef = useRef(null);
  const mfaBlockRef = useRef(null);

  // Keep ref in sync with state
  mfaBlockRef.current = mfaBlock;

  const mfaPageFetch = useCallback(async (url, options = {}) => {
    const headers = { ...(options.headers || {}) };
    if (lastPageChallengeIdRef.current) {
      headers['X-MFA-Challenge'] = lastPageChallengeIdRef.current;
    }
    const result = await apiFetch(url, { ...options, headers });

    // Intercept mfaSetupRequired — user needs to configure MFA before accessing this page
    if (result.status === 403 && result.data?.requireMFA && result.data?.mfaSetupRequired) {
      setMfaSetupBlock({
        mfaEnabled: result.data.mfaEnabled !== false,
        requiredMethods: result.data.requiredMethods || []
      });
      return result;
    }

    // Only intercept origin JSON 403 with requireMFA (not Cloudflare HTML 403)
    if (result.status === 403 && result.data?.requireMFA && !result.data?.mfaSetupRequired) {
      // Only set block if not already set (handles concurrent GETs)
      if (!mfaBlockRef.current) {
        setMfaBlock({
          challengeId: result.data.challengeId,
          allowedMethods: result.data.allowedMethods,
          maskedEmail: result.data.maskedEmail,
          pendingTtlSeconds: result.data.pendingTtlSeconds || 900,
          receivedAt: Date.now(),
        });
        setAutoShowModal(true);
      }
      return result;
    }

    // Successful fetch clears any previous block
    if (mfaBlockRef.current || mfaSetupBlock) {
      setMfaBlock(null);
      setMfaSetupBlock(null);
      lastPageChallengeIdRef.current = null;
    }
    return result;
  }, []);

  const handlePageMfaSuccess = useCallback((challengeId) => {
    const block = mfaBlockRef.current;
    if (!block) return;

    const elapsed = (Date.now() - block.receivedAt) / 1000;
    const halfTtl = block.pendingTtlSeconds / 2;

    if (elapsed < halfTtl) {
      // Enough TTL — store challenge ID, clear block, trigger re-fetch
      lastPageChallengeIdRef.current = challengeId;
      setMfaBlock(null);
      setAutoShowModal(false);
      setMfaVerifiedKey(k => k + 1);
    } else {
      // TTL too low — reload to get fresh session-reuse pass-through
      window.location.reload();
    }
  }, []);

  const handlePageMfaCancel = useCallback(() => {
    // Close modal but keep page-level prompt
    setAutoShowModal(false);
  }, []);

  const retryVerification = useCallback(() => {
    const block = mfaBlockRef.current;
    if (!block) return;

    const elapsed = (Date.now() - block.receivedAt) / 1000;
    const halfTtl = block.pendingTtlSeconds / 2;

    if (elapsed < halfTtl) {
      // Challenge still valid — reopen modal
      setAutoShowModal(true);
    } else {
      // Challenge expired or near-expired — reload for fresh challenge
      window.location.reload();
    }
  }, []);

  return {
    mfaBlock,
    mfaSetupBlock,
    autoShowModal,
    mfaPageFetch,
    handlePageMfaSuccess,
    handlePageMfaCancel,
    retryVerification,
    mfaVerifiedKey,
  };
}
