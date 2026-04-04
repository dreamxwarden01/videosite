/**
 * Shared fetch wrapper.
 * - Auto-sets Content-Type for JSON bodies
 * - Parses JSON responses safely (handles non-JSON like Cloudflare 429 HTML)
 * - On 401: signals auth failure via registered callback (triggers ProtectedRoute redirect)
 * - Returns { data, status, ok } — callers still receive 401 responses normally
 */

// Module-level auth failure callback — registered by AuthProvider
let onAuthFailure = null;
export function setAuthFailureHandler(fn) { onAuthFailure = fn; }
export function triggerAuthFailure() { if (onAuthFailure) onAuthFailure(); }

export async function apiFetch(url, options = {}) {
  const { body, headers: extraHeaders, ...rest } = options;

  const headers = { ...extraHeaders };
  if (body && typeof body === 'object' && !(body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
  }

  const resp = await fetch(url, {
    ...rest,
    headers,
    body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
  });

  // Try to parse JSON; fall back to null for non-JSON responses
  let data = null;
  const contentType = resp.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    try {
      data = await resp.json();
    } catch {
      data = null;
    }
  }

  // Signal session expired — ProtectedRoute handles the redirect
  if (resp.status === 401 && onAuthFailure) {
    onAuthFailure();
  }

  return { data, status: resp.status, ok: resp.ok };
}

/** Shorthand for GET requests */
export function apiGet(url) {
  return apiFetch(url);
}

/** Shorthand for POST requests with JSON body */
export function apiPost(url, body) {
  return apiFetch(url, { method: 'POST', body });
}

/** Shorthand for PUT requests with JSON body */
export function apiPut(url, body) {
  return apiFetch(url, { method: 'PUT', body });
}

/** Shorthand for DELETE requests */
export function apiDelete(url, body) {
  return apiFetch(url, { method: 'DELETE', body });
}
