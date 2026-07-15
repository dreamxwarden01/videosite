// sessionStorage drafts for the step-up redirect ceremony. A write-gated action
// saves its in-progress form under a stable key before the browser leaves for the
// SSO; on return (?stepup=done) the page reads it back and clears it. Namespaced
// 'stepup:' with try/catch, matching the app's existing sessionStorage convention
// (Header.clearCoursePages sweeps the 'course:' prefix the same way).
const PREFIX = 'stepup:';

export function saveDraft(key, value) {
  try { sessionStorage.setItem(PREFIX + key, JSON.stringify(value)); } catch { /* sessionStorage unavailable */ }
}

export function loadDraft(key) {
  try {
    const raw = sessionStorage.getItem(PREFIX + key);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

export function clearDraft(key) {
  try { sessionStorage.removeItem(PREFIX + key); } catch { /* sessionStorage unavailable */ }
}

// Sweep every step-up draft. Called right before a new draft is saved so at most
// one survives into a redirect — a user who closes the challenge tab (instead of
// Cancel) leaves a stale draft that would otherwise restore spuriously on the next
// visit to that page. Object.keys snapshots first, so removing while iterating is safe.
export function clearAllDrafts() {
  try {
    Object.keys(sessionStorage).forEach((k) => { if (k.startsWith(PREFIX)) sessionStorage.removeItem(k); });
  } catch { /* sessionStorage unavailable */ }
}
