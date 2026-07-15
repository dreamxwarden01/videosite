import { apiPost } from '../api';
import { startUploadHeartbeat } from './uploadHeartbeat';

// Mirror of the server-side limits in routes/api/materials.js. The client
// checks are UX (fail fast); the server is the source of truth.
export const MATERIAL_MAX_BYTES = 100 * 1024 * 1024; // 100 MB
export const BLOCKED_EXTENSIONS = ['.mp4', '.mkv', '.avi', '.mov', '.wmv', '.flv', '.webm', '.ts', '.m3u8'];

// Case-insensitive extension test against the blocklist.
export function isBlockedFile(name) {
  const dot = (name || '').lastIndexOf('.');
  const ext = dot >= 0 ? name.substring(dot).toLowerCase() : '';
  return BLOCKED_EXTENSIONS.includes(ext);
}

// Presigned PUT to R2. The URL is signed with the Content-Type sent at
// create time, so the request MUST echo the same value or R2 rejects the
// signature. Resolves on 2xx, rejects otherwise; '__aborted__' distinguishes
// an abort() (user cancel or heartbeat timeout) from a real failure.
function putFile(uploadUrl, file, contentType, onPct, setXhr) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    setXhr(xhr);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onPct) onPct(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new Error(`Upload failed (HTTP ${xhr.status}).`));
    };
    xhr.onerror = () => reject(new Error('Upload failed.'));
    xhr.onabort = () => reject(new Error('__aborted__'));
    xhr.open('PUT', uploadUrl);
    xhr.setRequestHeader('Content-Type', contentType);
    xhr.send(file);
  });
}

// Uploads a single item end to end. NEVER throws — resolves to a per-item
// result so one failure can't reject the whole batch. Every started session
// has its heartbeat stopped and (on failure/abort) a best-effort /abort.
async function uploadOne(courseId, item, { onUpdate, signal }) {
  const { id, file, moduleNumber } = item;
  const report = (patch) => { if (onUpdate) onUpdate(id, patch); };
  const contentType = file.type || 'application/octet-stream';

  let uploadId = null;
  let hb = null;
  let xhr = null;

  const aborted = () => !!(signal && signal.aborted);
  const onAbort = () => { if (xhr) xhr.abort(); };
  if (signal) signal.addEventListener('abort', onAbort);

  const finishError = (error) => {
    if (hb) { hb.stop(); hb = null; }
    if (uploadId) apiPost(`/api/materials/${uploadId}/abort`).catch(() => {});
    if (signal) signal.removeEventListener('abort', onAbort);
    report({ status: 'error', error });
    return { id, status: 'error', error };
  };

  try {
    if (aborted()) return finishError('Upload cancelled.');
    report({ status: 'uploading', pct: 0 });

    const createRes = await apiPost(`/api/materials/courses/${courseId}/upload`, {
      filename: file.name,
      fileSize: file.size,
      contentType,
      module_number: moduleNumber,
    });
    if (!createRes.ok || !createRes.data?.uploadUrl) {
      throw new Error(createRes.data?.error || 'Failed to start upload.');
    }
    uploadId = createRes.data.uploadId;
    if (aborted()) return finishError('Upload cancelled.');

    hb = startUploadHeartbeat(`/api/materials/${uploadId}/heartbeat`, {
      onTimeout: () => { if (xhr) xhr.abort(); },
    });

    await putFile(createRes.data.uploadUrl, file, contentType, (pct) => report({ pct }), (x) => { xhr = x; });

    const completeRes = await apiPost(`/api/materials/${uploadId}/complete`, { module_number: moduleNumber });
    if (!completeRes.ok) {
      throw new Error(completeRes.status === 410 ? 'Course was deleted; upload discarded.' : (completeRes.data?.error || 'Failed to finish upload.'));
    }

    hb.stop(); hb = null;
    if (signal) signal.removeEventListener('abort', onAbort);
    const materialId = completeRes.data?.materialId ?? null;
    report({ status: 'done', pct: 100, materialId });
    return { id, status: 'done', materialId };
  } catch (err) {
    let error;
    if (aborted()) error = 'Upload cancelled.';
    else if (err?.message === '__aborted__') error = 'Upload timed out.';
    else error = err?.message || 'Upload failed.';
    return finishError(error);
  }
}

/**
 * Uploads a batch of materials through a worker pool of exactly
 * `concurrency` (default 3 — see the heartbeat starvation note below).
 *
 * items: Array<{ id, file, moduleNumber }>
 * onUpdate(id, patch): patch is a partial of
 *   { status: 'queued'|'uploading'|'done'|'error', pct, error, materialId }
 *
 * Each in-flight session runs a 5s heartbeat that self-aborts after 60s
 * without a successful beat, so an unbounded fan-out would starve its own
 * sessions — hence the capped pool.
 *
 * Resolves to Array<{ id, status, materialId?, error? }> in item order.
 * Never rejects: a per-item failure is captured as its own 'error' result.
 */
export async function uploadMaterialBatch(courseId, items, { concurrency = 3, onUpdate, signal } = {}) {
  const results = items.map((it) => ({ id: it.id, status: 'queued' }));
  let next = 0;

  const worker = async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await uploadOne(courseId, items[i], { onUpdate, signal });
    }
  };

  const pool = [];
  const n = Math.min(concurrency, items.length);
  for (let k = 0; k < n; k++) pool.push(worker());
  await Promise.all(pool);
  return results;
}
