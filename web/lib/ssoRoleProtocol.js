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
function profileText(value, max) {
    if (typeof value !== 'string' || !value.trim() || /[\u0000-\u001f\u007f]/.test(value)) return false;
    const points = Array.from(value);
    return points.length <= max && !points.some(point => point.length === 1
        && point.charCodeAt(0) >= 0xd800 && point.charCodeAt(0) <= 0xdfff);
}
// An optional creation seed, not a profile-update event. Scope groups are
// complete or absent so a missing claim never implies permission to disclose it.
function profileSeed(value, sub) {
    if (value === undefined) return undefined;
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_profile_seed');
    const allowed = new Set(['preferred_username', 'name', 'picture', 'email', 'email_verified']);
    if (Object.keys(value).some(key => !allowed.has(key))) throw new Error('invalid_profile_seed');
    const has = key => Object.prototype.hasOwnProperty.call(value, key);
    const group = ['preferred_username', 'name', 'picture'];
    if (group.some(has) && (!group.every(has) || !profileText(value.preferred_username, 20)
        || !profileText(value.name, 100) || !(value.picture === null || (typeof value.picture === 'string'
            && new RegExp('^' + subject(sub) + '-[0-9a-f]{16}\\.webp$').test(value.picture))))) throw new Error('invalid_profile_seed');
    const email = ['email', 'email_verified'];
    if (email.some(has) && (!email.every(has) || !(value.email === null || profileText(value.email, 254))
        || typeof value.email_verified !== 'boolean')) throw new Error('invalid_profile_seed');
    return { ...value };
}
function observation(payload, source = 'event') {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('invalid_role_event');
    const accountStatus = payload.account_status;
    if (accountStatus !== undefined && !['active', 'disabled', 'locked', 'deleted', 'not_found'].includes(accountStatus)) throw new Error('invalid_account_status');
    const result = { sub: subject(payload.sub), roleId: roleId(payload.role_id),
        version: version(payload.authority_epoch, payload.authority_revision), source, accountStatus };
    if (payload.profile !== undefined) {
        if (source !== 'event' || accountStatus !== 'active' || result.roleId === null || !result.version) throw new Error('invalid_profile_seed');
        result.profile = profileSeed(payload.profile, result.sub);
    }
    return result;
}
/** Transport time and event IDs never participate in authority ordering. */
function compare(stored, incoming) {
    if (!stored || stored.authority_epoch === null) return 'apply';
    if (!incoming.version) return 'legacy';
    if (stored.authority_epoch !== incoming.version.epoch) return 'epoch';
    const a = BigInt(incoming.version.revision), b = BigInt(stored.authority_revision);
    if (a < b) return 'stale';
    if (a > b) return 'apply';
    if (stored.role_id !== incoming.roleId) return 'conflict';
    // Only new signed events promise that status changes advance the source
    // revision. Legacy current pulls can change status at an unchanged role
    // revision and remain fenced by the local observation generation.
    if (incoming.source === 'event' && incoming.accountStatus !== undefined && stored.account_status != null
        && stored.account_status !== incoming.accountStatus) return 'conflict';
    return 'same';
}
function sessionPermitted(authority, capturedGeneration = '0') {
    return !authority || (!authority.blocked && !authority.effects_pending
        && authority.session_generation === capturedGeneration);
}
module.exports = { UUID, MAX_REVISION, EVENT_TOKEN_LIMIT, EVENT_FORM_LIMIT, revision, version, roleId, subject, canonical, digest, profileText, profileSeed, observation, compare, sessionPermitted };
