'use strict';

// Generated identifiers are ASCII opaque values. Accept the historic bounded
// forms as well as current wk_... keys; never treat a missing owner as system.
const isWorkerKeyId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value);
const isWorkerSessionId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,32}$/.test(value);

module.exports = { isWorkerKeyId, isWorkerSessionId };
