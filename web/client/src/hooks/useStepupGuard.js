import { useState, useCallback } from 'react';
import { apiFetch } from '../api';
import { useStepUp } from '../context/StepUpProvider';

// Page-level step-up guard for a scenario. Route the page's data GET through
// guardFetch: a 403 step_up_required blocks the CONTENT slot (render the page's
// header outside <StepUpPageGuard> so it stays, and the block card fills only the
// content — the blended, skeleton-friendly shape). guardAction wraps a write button
// (open a modal / save / confirm) in a pre-check: fresh → run it; stale (within the
// 3-min buffer) → save an optional draft for restore-on-return and open the modal.
// The global StepUpProvider opens the same modal from a reactive 403.
export default function useStepupGuard(scenario) {
  const { precheck, promptStepUp } = useStepUp();
  const [blocked, setBlocked] = useState(false);
  const [accepted, setAccepted] = useState(['totp', 'passkey']);

  const guardFetch = useCallback(async (url, opts) => {
    const res = await apiFetch(url, opts);
    if (res.status === 403 && res.data && res.data.code === 'step_up_required') {
      setAccepted(res.data.accepted || ['totp', 'passkey']);
      setBlocked(true);
    } else if (res.ok) {
      setBlocked(false);
    }
    return res;
  }, []);

  const verify = useCallback(() => promptStepUp(accepted), [promptStepUp, accepted]);

  // opts: { draftKey, draft } — draft is stashed (and restored on return) only if
  // the pre-check has to redirect.
  const guardAction = useCallback(async (fn, opts = {}) => {
    const ok = await precheck({ scenario, ...opts });
    if (ok) return fn();
    return undefined;
  }, [precheck, scenario]);

  return { blocked, guardFetch, verify, guardAction };
}
