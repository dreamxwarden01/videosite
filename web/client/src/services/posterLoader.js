export const MAX_POSTER_RETRIES = 10;

export function posterIdentity(input) {
  return JSON.stringify([input.domain || '', String(input.courseId), String(input.videoId),
    input.path || '']);
}

const processing = (input) => input.status !== 'finished' && input.status !== 'error';
let nextLoaderId = 0;

// The server's ready flag is authoritative. Each accepted list response supplies
// a path and latest token; paths identify immutable poster generations. Failed
// processing images wait for a NEW response, while ordinary posters retain
// bounded short retries. A loaded image ignores token rotation, but never a
// cleared ready flag.
export function createPosterLoader({ onChange, schedule = setTimeout, cancel = clearTimeout }) {
  const loaderId = ++nextLoaderId;
  let input = null;
  let identity = null;
  let serial = 0;
  let timedRetries = 0;
  let failedRevision = -1;
  let timer = null;
  let disposed = false;
  let state = { phase: 'idle', id: null, src: null };

  const clearTimer = () => { if (timer !== null) cancel(timer); timer = null; };
  const emit = (next) => { state = next; if (!disposed) onChange({ ...state }); };
  const eligible = () => input?.ready === true && !!(input?.token && input?.domain)
    && typeof input.path === 'string' && input.path.startsWith('/posters/') && !/[?#]/.test(input.path);
  const start = () => {
    if (disposed || !eligible()) return false;
    clearTimer();
    // The deployed WAF accepts the verify-only query. Changing the image key
    // retries a failed request; cache generation is the server-issued path,
    // never extra query parameters or a locally invented URL nonce.
    const src = `https://${input.domain}${input.path}?verify=${encodeURIComponent(input.token)}`;
    emit({ phase: 'loading', id: `${loaderId}:${++serial}`, src });
    return true;
  };
  const retryLater = () => {
    if (timer !== null || disposed || !eligible()) return;
    if (timedRetries >= MAX_POSTER_RETRIES) {
      emit({ ...state, phase: 'exhausted' });
      return;
    }
    const key = identity;
    timer = schedule(() => {
      timer = null;
      if (disposed || identity !== key || state.phase !== 'failed' || processing(input)) return;
      timedRetries++;
      start();
    }, 500 + timedRetries * 500);
  };

  return {
    update(next) {
      if (disposed) return;
      const key = posterIdentity(next);
      const wasProcessing = input && processing(input);
      input = next;
      if (identity !== key || input.ready !== true) {
        const changed = identity !== key || state.phase !== 'idle';
        clearTimer();
        identity = key;
        timedRetries = 0;
        failedRevision = -1;
        state = { phase: 'idle', id: null, src: null };
        if (!start() && changed) emit(state);
        return;
      }
      if (state.phase === 'loaded' || state.phase === 'loading') return;
      if (!eligible()) { clearTimer(); return; }
      if (state.phase === 'idle') { start(); return; }
      if (state.phase === 'exhausted') return;
      if (processing(input)) {
        clearTimer();
        if (!wasProcessing) failedRevision = input.revision;
        if (input.revision > failedRevision) {
          start();
        }
      } else {
        // A finished/error row with an explicitly ready poster may no longer
        // cause list polling. Its usual bounded retry budget still applies.
        if (wasProcessing) timedRetries = 0;
        retryLater();
      }
    },
    loaded(id) {
      if (disposed || state.phase !== 'loading' || state.id !== id) return;
      clearTimer();
      emit({ ...state, phase: 'loaded' });
    },
    failed(id) {
      if (disposed || state.phase !== 'loading' || state.id !== id) return;
      failedRevision = input.revision;
      emit({ ...state, phase: 'failed' });
      if (!processing(input)) retryLater();
    },
    dispose() { disposed = true; clearTimer(); },
  };
}
