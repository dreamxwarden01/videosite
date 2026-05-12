// Shared upload heartbeat ticker used by both video and attachment
// upload flows.
//
// Behavior:
//   - Heartbeat fires every INTERVAL_MS (5s).
//   - Each tick can attempt up to RETRIES (5) with backoff
//     BACKOFFS_MS ([0, 1, 2, 3, 4] s). 4xx responses are terminal
//     (no retry); 5xx/network errors are retried.
//   - Only one heartbeat is in flight per ticker at any time —
//     if the previous tick is still running when the interval
//     fires, the new tick is skipped.
//   - Self-aborts if no successful heartbeat for SELF_ABORT_MS
//     (60s) — calls the onTimeout callback so the caller can
//     tear down the upload locally.
//
// Returns { stop } — call stop() on success/cancel to halt the
// ticker cleanly. Calling stop() multiple times is safe.

import { apiPost } from '../api';

const INTERVAL_MS = 5000;
const BACKOFFS_MS = [0, 1000, 2000, 3000, 4000];
const SELF_ABORT_MS = 60000;

export function startUploadHeartbeat(url, { onTimeout } = {}) {
    let stopped = false;
    let inFlight = false;
    let lastSuccessAt = Date.now();
    let timeoutFired = false;

    async function tryOnce() {
        for (let i = 0; i < BACKOFFS_MS.length; i++) {
            if (stopped) return false;
            if (BACKOFFS_MS[i] > 0) {
                await new Promise(r => setTimeout(r, BACKOFFS_MS[i]));
                if (stopped) return false;
            }
            let res;
            try {
                res = await apiPost(url);
            } catch {
                // Network error — retry.
                continue;
            }
            if (res?.ok) return true;
            // 4xx (most importantly 404 "session terminal") is non-retryable.
            if (res && res.status >= 400 && res.status < 500) {
                stopped = true;
                return false;
            }
            // Otherwise (5xx) retry.
        }
        return false;
    }

    async function tick() {
        if (stopped || inFlight) return;
        inFlight = true;
        try {
            const ok = await tryOnce();
            if (ok) {
                lastSuccessAt = Date.now();
            }
        } finally {
            inFlight = false;
        }

        // Self-abort if too long without a successful heartbeat. Fire
        // only once even if subsequent ticks observe the same condition.
        if (!timeoutFired && Date.now() - lastSuccessAt >= SELF_ABORT_MS) {
            timeoutFired = true;
            stopped = true;
            if (onTimeout) {
                try { onTimeout(); } catch { /* swallow */ }
            }
        }
    }

    // Fire immediately so a very-fast upload still emits one heartbeat,
    // then on the interval.
    tick();
    const intervalId = setInterval(tick, INTERVAL_MS);

    return {
        stop() {
            stopped = true;
            clearInterval(intervalId);
        },
    };
}
