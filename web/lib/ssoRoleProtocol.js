'use strict';
const { createHash } = require('node:crypto');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_REVISION = 9223372036854775807n;
const EVENT_TOKEN_LIMIT = 262144;
const EVENT_FORM_LIMIT = EVENT_TOKEN_LIMIT + 1024;
function revision(value, positive = false) {
    if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,18})$/.test(value)
        || BigInt(value) > MAX_REVISION || (positive && value === '0')) throw new Error('invalid_revision');
    return value;
}
function version(epoch, rev) {
    if (epoch === undefined && rev === undefined) return null;
    if (typeof epoch !== 'string' || !UUID.test(epoch)) throw new Error('invalid_authority_version');
    return { epoch: epoch.toLowerCase(), revision: revision(rev) };
}
function roleId(value) {
    if (value !== null && !(typeof value === 'number' && Number.isInteger(value)
        && value >= -2147483648 && value <= 2147483647)) throw new Error('invalid_role_id');
    return value;
}
function subject(value) {
    if (typeof value !== 'string' || !UUID.test(value)) throw new Error('invalid_subject');
    return value.toLowerCase();
}
function canonical(value) {
    let nodes = 0;
    function visit(item, depth) {
        if (++nodes > 20000 || depth > 20) throw new Error('invalid_event_shape');
        if (Array.isArray(item)) return '[' + item.map(v => visit(v, depth + 1)).join(',') + ']';
        if (item && typeof item === 'object') return '{' + Object.keys(item).sort().map(k => JSON.stringify(k) + ':' + visit(item[k], depth + 1)).join(',') + '}';
        return JSON.stringify(item);
    }
    return visit(value, 0);
}
const digest = value => createHash('sha256').update(canonical(value)).digest('hex');
function observation(payload, source = 'event') {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('invalid_role_event');
    return { sub: subject(payload.sub), roleId: roleId(payload.role_id),
        version: version(payload.authority_epoch, payload.authority_revision), source };
}
/** Transport time and event IDs never participate in authority ordering. */
function compare(stored, incoming) {
    if (!stored || stored.authority_epoch === null) return 'apply';
    if (!incoming.version) return 'legacy';
    if (stored.authority_epoch !== incoming.version.epoch) return 'epoch';
    const a = BigInt(incoming.version.revision), b = BigInt(stored.authority_revision);
    if (a < b) return 'stale';
    if (a > b) return 'apply';
    return stored.role_id === incoming.roleId ? 'same' : 'conflict';
}
function sessionPermitted(authority, capturedGeneration = '0') {
    return !authority || (!authority.blocked && !authority.effects_pending
        && authority.session_generation === capturedGeneration);
}
module.exports = { UUID, MAX_REVISION, EVENT_TOKEN_LIMIT, EVENT_FORM_LIMIT, revision, version, roleId, subject, canonical, digest, observation, compare, sessionPermitted };
