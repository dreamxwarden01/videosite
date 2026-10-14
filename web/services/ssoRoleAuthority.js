'use strict';
const { observation, compare, subject, digest, UUID } = require('../lib/ssoRoleProtocol');
const { transaction } = require('./ssoCatalogStore');
const columns = `subject_id,authority_epoch,CAST(authority_revision AS CHAR) AS authority_revision,
    role_id,CAST(generation AS CHAR) AS generation,CAST(session_generation AS CHAR) AS session_generation,blocked,effects_pending,refresh_pending`;
const hex = sub => sub.replace(/-/g, '');
const dashed = id => id.includes('-') ? subject(id) : subject(id.replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5'));

function createAuthorityService({ pool, updateUser, invalidateUser, deleteUserSessions, fetchAccessState }) {
    async function repairProjection(db, sub, role) {
        const [[user]] = await db.execute('SELECT role_id FROM users WHERE user_id=?', [Buffer.from(hex(sub), 'hex')]);
        if (!user || user.role_id === role) return false;
        await updateUser(hex(sub), { role_id: role }, { connection: db, invalidate: false });
        return true;
    }
    async function read(sub) {
        const [[row]] = await pool.execute(`SELECT ${columns} FROM sso_role_authority WHERE subject_id=?`, [subject(sub)]);
        return row || null;
    }
    async function completeEffects(sub) {
        const row = await read(sub);
        if (!row || !row.effects_pending) return;
        // The durable gate remains closed throughout cache/session work, including
        // failures and process death. Old completions cannot clear a newer gate.
        await invalidateUser(hex(sub));
        if (row.blocked) await deleteUserSessions(hex(sub));
        await pool.execute(`UPDATE sso_role_authority SET effects_pending=0 WHERE subject_id=? AND generation=?`, [sub, row.generation]);
    }
    async function apply(input, { eventId = null, fence = undefined, eventPayload = null, source = 'event' } = {}) {
        const incoming = observation(input, source);
        if (eventId !== null && (typeof eventId !== 'string' || !UUID.test(eventId))) throw new Error('invalid_event_id');
        let observationGeneration = null;
        const outcome = await transaction(pool, async db => {
            await db.execute(`INSERT INTO sso_role_authority(subject_id) VALUES(?)
                ON DUPLICATE KEY UPDATE subject_id=VALUES(subject_id)`, [incoming.sub]);
            const [[row]] = await db.execute(`SELECT ${columns} FROM sso_role_authority WHERE subject_id=? FOR UPDATE`, [incoming.sub]);
            if (fence !== undefined && row.generation !== fence) return 'stale';
            // Account status has no role revision. A fresh authenticated pull may
            // deny a non-active account even while its catalog is unmanaged;
            // preserve every role/lineage/conflict field, and never grant here.
            if (source === 'pull' && !incoming.version && input.denied === true
                && ['disabled','locked','deleted','not_found'].includes(input.account_status)) {
                const revoke = row.blocked ? 0 : 1;
                await db.execute(`UPDATE sso_role_authority SET blocked=1,generation=generation+1,
                    session_generation=session_generation+?,effects_pending=IF(?=1,1,effects_pending),updated_at=NOW(6)
                    WHERE subject_id=?`, [revoke, revoke, incoming.sub]);
                observationGeneration = (BigInt(row.generation) + 1n).toString();
                return 'applied';
            }
            let decision = compare(row, incoming);
            if (eventId) {
                const hash = digest({ type: 'account.roles_change', payload: eventPayload || input });
                const [[prior]] = await db.execute('SELECT payload_digest FROM sso_role_inbox WHERE event_id=?', [eventId.toLowerCase()]);
                if (prior && prior.payload_digest === hash) return 'duplicate';
                if (prior && (decision === 'stale' || decision === 'legacy')) return decision;
                if (prior) decision = 'conflict';
                else await db.execute('INSERT INTO sso_role_inbox(event_id,subject_id,payload_digest) VALUES(?,?,?)', [eventId.toLowerCase(), incoming.sub, hash]);
            }
            if (decision === 'stale' || decision === 'legacy') return decision;
            // A fresh same-lineage read may resolve a conflicting event at the
            // same revision. A foreign epoch always requires explicit recovery.
            const authoritative = incoming.source === 'pull';
            const settlingConflict = authoritative && row.blocked && row.refresh_pending;
            const conflict = decision === 'epoch' || (decision === 'conflict' && !settlingConflict)
                || (!authoritative && decision === 'same' && row.blocked && row.refresh_pending);
            const [[known]] = incoming.roleId === null ? [[]] : await db.execute('SELECT role_id FROM roles WHERE role_id=?', [incoming.roleId]);
            // A role revision does not supersede a separately confirmed account
            // denial. Only a fresh allowed account query may remove that block.
            const heldGrant = !authoritative && !!row.blocked && !!known;
            const blocked = conflict || heldGrant || incoming.roleId === null || !known || (authoritative && input.denied === true);
            const refresh = conflict || heldGrant || (incoming.roleId !== null && !known);
            if (decision === 'same' && !authoritative && (known || incoming.roleId === null || (row.blocked && row.refresh_pending))) {
                if (row.blocked && row.refresh_pending) return 'conflict';
                if (incoming.source === 'login' && !row.blocked && known) {
                    // An event may pin an unknown subject before JIT creation.
                    // Repair that new user's placeholder without changing the
                    // authority version or revocation generation.
                    const repaired = await repairProjection(db, incoming.sub, incoming.roleId);
                    await db.execute('UPDATE sso_role_authority SET generation=generation+1,effects_pending=IF(?,1,effects_pending) WHERE subject_id=?', [repaired ? 1 : 0, incoming.sub]);
                }
                return 'same';
            }
            if (conflict && row.blocked && row.refresh_pending) return decision;
            if (authoritative && decision === 'same' && !!row.blocked === blocked && !row.refresh_pending) {
                // Even an unchanged accepted observation fences older in-flight
                // reads. This is a local generation, not an SSO state revision.
                const repaired = known && !blocked ? await repairProjection(db, incoming.sub, incoming.roleId) : false;
                await db.execute('UPDATE sso_role_authority SET generation=generation+1,effects_pending=IF(?,1,effects_pending),updated_at=NOW(6) WHERE subject_id=?', [repaired ? 1 : 0, incoming.sub]);
                observationGeneration = (BigInt(row.generation) + 1n).toString();
                return 'same';
            }
            const revokeGeneration = blocked && !row.blocked ? 1 : 0;
            if (!conflict) {
                if (known) await updateUser(hex(incoming.sub), { role_id: incoming.roleId }, { connection: db, invalidate: false });
                await db.execute(`UPDATE sso_role_authority SET authority_epoch=?,authority_revision=?,role_id=?,blocked=?,
                    generation=generation+1,session_generation=session_generation+?,effects_pending=1,refresh_pending=?,refresh_after=NOW(6),updated_at=NOW(6)
                    WHERE subject_id=?`, [incoming.version?.epoch || null, incoming.version?.revision || null,
                    incoming.roleId, blocked ? 1 : 0, revokeGeneration, refresh ? 1 : 0, incoming.sub]);
            } else {
                await db.execute(`UPDATE sso_role_authority SET blocked=1,generation=generation+1,session_generation=session_generation+?,effects_pending=1,
                    refresh_pending=1,refresh_after=NOW(6),updated_at=NOW(6) WHERE subject_id=?`, [revokeGeneration, incoming.sub]);
            }
            if (!conflict) observationGeneration = (BigInt(row.generation) + 1n).toString();
            return conflict ? decision : 'applied';
        });
        await completeEffects(incoming.sub);
        return { outcome, observationGeneration, state: await read(incoming.sub) };
    }
    async function processEvent(event) {
        return apply(event.payload, { eventId: event.id, eventPayload: event.payload });
    }
    async function applyLogin(claims) {
        // An unmanaged token is not a signed denial and must not revoke existing
        // sessions or create an authority row as a side effect of failed login.
        if (claims.app_role === undefined) throw new Error('role_out_of_sync');
        const result = await apply({ sub: claims.sub, role_id: claims.app_role ?? null,
            authority_epoch: claims.app_role_epoch, authority_revision: claims.app_role_revision }, { source: 'login' });
        const permitted = value => value && ['applied','same'].includes(value.outcome)
            && value.state && !value.state.blocked && !value.state.effects_pending;
        if (permitted(result)) return result.state;
        // A disabled account can reactivate without changing its app-role
        // revision. The token alone cannot clear that block: ask the current
        // authority once, apply with the captured generation CAS, and require an
        // allowed result. A foreign token lineage still cannot establish login.
        const current = await refresh(claims.sub).catch(() => null);
        if (result.outcome === 'epoch' || !permitted(current) || !current.allowed
            || (current.version?.epoch || null) !== current.state.authority_epoch) throw new Error('role_out_of_sync');
        return current.state;
    }
    async function refresh(sub) {
        sub = subject(sub);
        const row = await transaction(pool, async db => {
            const [[state]] = await db.execute(`SELECT ${columns} FROM sso_role_authority WHERE subject_id=? FOR UPDATE`, [sub]);
            if (!state) return null;
            await db.execute('UPDATE sso_role_authority SET refresh_after=DATE_ADD(NOW(6),INTERVAL 60 SECOND) WHERE subject_id=?', [sub]);
            return state;
        });
        if (!row) return;
        const state = await fetchAccessState(sub);
        const result = await apply({ sub, role_id: state.roleId, authority_epoch: state.version?.epoch,
            authority_revision: state.version?.revision, denied: !state.allowed, account_status: state.accountStatus }, { fence: row.generation, source: 'pull' });
        if (['applied','same'].includes(result.outcome) && result.observationGeneration !== null) {
            await pool.execute(`UPDATE sso_role_authority SET refresh_after=DATE_ADD(NOW(6),INTERVAL 300 SECOND)
                WHERE subject_id=? AND generation=? AND refresh_pending=0`, [sub, result.observationGeneration]);
        }
        return { ...result, allowed: state.allowed === true, version: state.version || null };
    }
    async function sweep() {
        const [pending] = await pool.execute(`SELECT subject_id FROM sso_role_authority WHERE effects_pending=1 LIMIT 100`);
        for (const row of pending) await completeEffects(row.subject_id).catch(() => {});
        // Reserve routine capacity even when a permanent conflict keeps retrying.
        // Unknown subjects retain a watermark but are not polled indefinitely.
        const [urgent] = await pool.execute(`SELECT subject_id FROM sso_role_authority
            WHERE refresh_pending=1 AND refresh_after<=NOW(6) ORDER BY refresh_after,subject_id LIMIT 75`);
        const [[setting]] = await pool.execute("SELECT setting_value FROM site_settings WHERE setting_key='session_max_days'");
        const parsedDays = Number.parseInt(setting?.setting_value || '3', 10);
        const maxDays = Number.isSafeInteger(parsedDays) && parsedDays > 0 && parsedDays <= 36500 ? parsedDays : 3;
        const [routine] = await pool.execute(`SELECT a.subject_id FROM sso_role_authority a
            WHERE a.refresh_pending=0 AND a.refresh_after<=NOW(6) AND EXISTS (
                SELECT 1 FROM sessions s JOIN users u ON u.user_id=s.user_id
                WHERE s.user_id=UNHEX(REPLACE(a.subject_id,'-','')) AND s.sso_role_generation=a.session_generation
                  AND (s.sso_expires_at IS NULL OR s.sso_expires_at>NOW(6))
                  AND s.last_sign_in>DATE_SUB(NOW(6),INTERVAL ? DAY))
            ORDER BY a.refresh_after,a.subject_id LIMIT ${100 - urgent.length}`, [maxDays]);
        const rows = [...urgent, ...routine];
        for (const row of rows) await refresh(row.subject_id).catch(() => {});
    }
    async function sessionState(userId) { return read(dashed(userId)); }
    return { read, apply, processEvent, applyLogin, completeEffects, refresh, sweep, sessionState };
}
let singleton;
function service() {
    if (!singleton) singleton = createAuthorityService({
        pool: require('../config/database').getPool(),
        updateUser: (...args) => require('./userService').updateUser(...args),
        invalidateUser: userId => require('./userService').invalidateUserCaches(userId),
        deleteUserSessions: userId => require('../config/session').deleteUserSessions(userId),
        fetchAccessState: sub => require('../lib/oidc').fetchAccessState(sub),
    });
    return singleton;
}
let sweeping = null;
function sweep() { if (!sweeping) sweeping = service().sweep().finally(() => { sweeping = null; }); return sweeping; }
function start() {
    sweep().catch(() => console.error('sso authority reconciliation unavailable'));
    const timer = setInterval(() => sweep().catch(() => console.error('sso authority reconciliation unavailable')), 60000); timer.unref?.();
}
module.exports = { createAuthorityService, service, start };
