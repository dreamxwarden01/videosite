'use strict';

const { createHash, randomUUID } = require('node:crypto');
const { performance } = require('node:perf_hooks');

const hash = value => createHash('sha256').update(String(value)).digest('hex').slice(0, 20);
function safeCode(value) {
    return typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,100}$/.test(value) ? value : 'UnknownError';
}
function errorCode(error) { return safeCode(error?.Code || error?.code || error?.name); }
function errorSummary(errors) {
    const counts = new Map();
    for (const error of Array.isArray(errors) ? errors : []) {
        const code = errorCode(error);
        counts.set(code, (counts.get(code) || 0) + 1);
    }
    return { object_errors: Array.isArray(errors) ? errors.length : 0,
        error_codes: Object.fromEntries([...counts].slice(0, 12)) };
}
function requestMetadata(output) {
    const metadata = output?.$metadata || {};
    return {
        status: Number.isInteger(metadata.httpStatusCode) ? metadata.httpStatusCode : null,
        r2_request_id: typeof metadata.requestId === 'string' && /^[A-Za-z0-9_+=/:-]{1,200}$/.test(metadata.requestId)
            ? metadata.requestId : null,
    };
}
function describeCommand(command) {
    const input = command.input || {};
    const keys = input.Delete?.Objects?.map(item => item.Key) || (input.Key ? [input.Key] : []);
    return {
        operation: command.constructor.name.replace(/Command$/, ''),
        ...(input.Prefix !== undefined ? { prefix_hash: hash(input.Prefix) } : {}),
        ...(keys.length ? { key_count: keys.length, batch_hash: hash(JSON.stringify([...keys].sort())) } : {}),
    };
}
function emit(record, logger = console) {
    // Logging must neither replace the original error nor turn success into retry.
    // Never include command input, raw errors/headers, signed URLs or credentials.
    try { logger.log(JSON.stringify({ timestamp: new Date().toISOString(), ...record })); } catch { /* best effort */ }
}

/** Instrument the actual SDK retry boundary for this command, not other clients. */
async function sendR2Request(client, command, context = {}, logger = console) {
    const base = { component: 'r2_deletion', call_id: randomUUID(), ...describeCommand(command) };
    if (/^\d{1,20}$/.test(String(context.row_id))) base.row_id = String(context.row_id);
    if (Number.isInteger(context.row_attempt)) base.row_attempt = context.row_attempt;
    let attempts = 0, previousEnd = null;
    const started = performance.now();
    command.middlewareStack.addRelativeTo(next => async args => {
        const attempt = ++attempts;
        const attemptStart = performance.now();
        const wait = previousEnd === null ? 0 : Math.max(0, Math.round(attemptStart - previousEnd));
        emit({ ...base, event: attempt === 1 ? 'request_start' : 'sdk_retry_start', attempt, wait_since_previous_attempt_ms: wait }, logger);
        try {
            const result = await next(args);
            const output = result.output;
            previousEnd = performance.now();
            emit({ ...base, event: 'request_result', attempt, duration_ms: Math.round(previousEnd - attemptStart),
                ...requestMetadata(output), ...errorSummary(output?.Errors),
                ...(Number.isInteger(output?.KeyCount) ? { listed_keys: output.KeyCount } : {}) }, logger);
            return result;
        } catch (error) {
            previousEnd = performance.now();
            emit({ ...base, event: 'request_error', attempt, duration_ms: Math.round(previousEnd - attemptStart),
                ...requestMetadata(error), error_code: errorCode(error) }, logger);
            throw error;
        }
    }, { name: 'r2DeletionAttemptLogger', relation: 'after', toMiddleware: 'retryMiddleware', override: true });
    try {
        const result = await client.send(command);
        emit({ ...base, event: 'call_complete', outcome: result.Errors?.length ? 'object_errors' : 'success',
            duration_ms: Math.round(performance.now() - started), attempts: result.$metadata?.attempts ?? attempts,
            sdk_retry_delay_ms: result.$metadata?.totalRetryDelay ?? null, ...requestMetadata(result), ...errorSummary(result.Errors) }, logger);
        return result;
    } catch (error) {
        emit({ ...base, event: 'call_complete', outcome: 'failed', duration_ms: Math.round(performance.now() - started),
            attempts: error.$metadata?.attempts ?? attempts, sdk_retry_delay_ms: error.$metadata?.totalRetryDelay ?? null,
            ...requestMetadata(error), error_code: errorCode(error) }, logger);
        throw error;
    }
}

module.exports = { sendR2Request, errorCode, errorSummary, hash, emit };
