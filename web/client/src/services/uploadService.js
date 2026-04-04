import { apiPost } from '../api';

// --- Error classes ---

export class UploadConflictError extends Error {
  constructor(conflictData) {
    super('Upload conflict detected');
    this.name = 'UploadConflictError';
    this.conflictData = conflictData; // { type, videoId?, uploadId? }
  }
}

export class UploadAbortedError extends Error {
  constructor() {
    super('Upload cancelled');
    this.name = 'UploadAbortedError';
  }
}

export class UploadRetryExhaustedError extends Error {
  constructor(partNumber) {
    super(`Failed to upload part ${partNumber} after all retries`);
    this.name = 'UploadRetryExhaustedError';
  }
}

// --- API call retry helper (5xx / network only, 3 attempts, 0/1/2s backoff) ---

async function apiPostRetry(url, body, maxRetries = 3) {
  const delays = [0, 1000, 2000];
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      if (delays[attempt] > 0) await new Promise(r => setTimeout(r, delays[attempt]));
      const res = await apiPost(url, body);
      // Only retry on 5xx
      if (res.status >= 500 && attempt < maxRetries - 1) continue;
      return res;
    } catch (err) {
      // Network error — retry unless last attempt
      if (attempt === maxRetries - 1) throw err;
    }
  }
}

// --- XHR part upload ---

function xhrPut(url, blob, onUploadProgress, xhrRef) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    if (xhrRef) xhrRef.current = xhr;
    xhr.open('PUT', url);
    if (onUploadProgress) {
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) onUploadProgress(e.loaded);
      };
    }
    xhr.onload = () => {
      if (xhrRef) xhrRef.current = null;
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(xhr.getResponseHeader('ETag'));
      } else {
        reject(new Error(`HTTP ${xhr.status}`));
      }
    };
    xhr.onerror = () => { if (xhrRef) xhrRef.current = null; reject(new Error('Network error')); };
    xhr.onabort = () => { if (xhrRef) xhrRef.current = null; reject(new Error('Upload aborted')); };
    xhr.send(blob);
  });
}

async function uploadPartWithRetry(url, blob, maxRetries = 5, onUploadProgress, xhrRef, abortedRef) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    if (abortedRef && abortedRef.current) throw new Error('Upload aborted');
    try {
      if (onUploadProgress) onUploadProgress(0);
      return await xhrPut(url, blob, onUploadProgress, xhrRef);
    } catch (err) {
      if (abortedRef && abortedRef.current) throw new Error('Upload aborted');
      if (attempt === maxRetries - 1) throw err;
      await new Promise(r => setTimeout(r, attempt * 1000));
    }
  }
}

// --- Presign batching ---
const PRESIGN_BATCH_SIZE = 10;

/**
 * Multipart upload with server-side session tracking, retry, and heartbeat.
 *
 * @param {Object} opts
 * @param {File}     opts.file        - File to upload
 * @param {string}   opts.createUrl   - '/api/upload/create' or '/api/upload/replace'
 * @param {Object}   opts.createBody  - Body for session creation
 * @param {Function} opts.onProgress  - (percent, uploadedBytes, totalBytes) => void
 * @param {Object}   opts.onAbortRef  - ref whose .current is set to an abort function
 */
export async function multipartUpload({ file, createUrl, createBody, onProgress, onAbortRef }) {
  // 1. Create session (with retry)
  const createRes = await apiPostRetry(createUrl, createBody);

  if (createRes.status === 409 && createRes.data?.conflict) {
    throw new UploadConflictError(createRes.data);
  }
  if (!createRes.ok) throw new Error(createRes.data?.error || 'Failed to create upload session');

  const { uploadId, totalParts, partSize } = createRes.data;

  // 2. Start heartbeat interval
  const abortedRef = { current: false };
  const activeXhrs = new Set();
  const heartbeatInterval = setInterval(() => {
    if (!abortedRef.current) {
      apiPost(`/api/upload/${uploadId}/heartbeat`).catch(() => {});
    }
  }, 10000);

  // 3. Set up abort handler — stops XHRs first, then reports abort
  if (onAbortRef) {
    onAbortRef.current = async () => {
      abortedRef.current = true;
      clearInterval(heartbeatInterval);
      // Abort all in-flight XHRs immediately
      for (const xhrRef of activeXhrs) {
        if (xhrRef.current) xhrRef.current.abort();
      }
      // Report abort to server (best-effort with retry, treat failure as success)
      try {
        await apiPostRetry(`/api/upload/${uploadId}/abort`);
      } catch {}
    };
  }

  try {
    // 4. Upload parts with 3 concurrent workers and presign batching
    const completedParts = [];
    const partProgress = new Map(); // partNumber -> bytes uploaded so far

    function reportProgress() {
      if (!onProgress) return;
      let total = 0;
      for (const bytes of partProgress.values()) total += bytes;
      onProgress(Math.round((total / file.size) * 100), total, file.size);
    }

    // Build part queue
    const partQueue = [];
    for (let i = 1; i <= totalParts; i++) partQueue.push(i);

    // Pre-fetch presigned URLs in batches
    const presignedUrls = new Map(); // partNumber -> url

    async function ensurePresigned(partNumbers) {
      const needed = partNumbers.filter(pn => !presignedUrls.has(pn));
      if (needed.length === 0) return;

      const res = await apiPostRetry(`/api/upload/${uploadId}/presign`, { partNumbers: needed });
      if (!res.ok) throw new Error('Failed to get presigned URLs');
      for (const { partNumber, url } of res.data.urls) {
        presignedUrls.set(partNumber, url);
      }
    }

    // Pre-fetch first batch
    const firstBatch = partQueue.slice(0, PRESIGN_BATCH_SIZE);
    await ensurePresigned(firstBatch);

    let partIndex = 0;
    const uploadPart = async () => {
      const xhrRef = { current: null };
      activeXhrs.add(xhrRef);
      try {
        while (partIndex < partQueue.length && !abortedRef.current) {
          const idx = partIndex++;
          const partNumber = partQueue[idx];

          // Ensure this part and upcoming parts have presigned URLs
          if (idx % PRESIGN_BATCH_SIZE === 0 && idx > 0) {
            if (abortedRef.current) break;
            const nextBatch = partQueue.slice(idx, idx + PRESIGN_BATCH_SIZE);
            await ensurePresigned(nextBatch);
          }

          if (abortedRef.current) break;

          const url = presignedUrls.get(partNumber);
          if (!url) {
            // Fallback: fetch individually
            await ensurePresigned([partNumber]);
          }

          const start = (partNumber - 1) * partSize;
          const end = Math.min(start + partSize, file.size);
          const blob = file.slice(start, end);
          const partBytes = end - start;

          partProgress.set(partNumber, 0);

          let etag;
          try {
            etag = await uploadPartWithRetry(presignedUrls.get(partNumber), blob, 5, (loaded) => {
              partProgress.set(partNumber, Math.min(loaded, partBytes));
              reportProgress();
            }, xhrRef, abortedRef);
          } catch (err) {
            if (abortedRef.current) break;
            throw new UploadRetryExhaustedError(partNumber);
          }

          partProgress.set(partNumber, partBytes);
          completedParts.push({ partNumber, etag });
          reportProgress();
        }
      } finally {
        activeXhrs.delete(xhrRef);
      }
    };

    const workers = [];
    for (let i = 0; i < 3; i++) workers.push(uploadPart());
    await Promise.all(workers);

    if (abortedRef.current) throw new UploadAbortedError();

    // 5. Complete upload (with retry)
    completedParts.sort((a, b) => a.partNumber - b.partNumber);

    const completeRes = await apiPostRetry(`/api/upload/${uploadId}/complete`, {
      parts: completedParts
    });
    if (!completeRes.ok) throw new Error(completeRes.data?.error || 'Failed to finalize upload');

    clearInterval(heartbeatInterval);
    return { uploadId };
  } catch (err) {
    clearInterval(heartbeatInterval);
    // If not already aborted, abort the session on error (best-effort)
    if (!abortedRef.current && !(err instanceof UploadAbortedError)) {
      apiPostRetry(`/api/upload/${uploadId}/abort`).catch(() => {});
    }
    throw err;
  }
}
