'use strict';
const crypto = require('node:crypto');
const { canonical, digest, roleId, MAX_REVISION, UUID } = require('../lib/ssoRoleProtocol');
function catalogName(value) {
    const points = Array.from(value.trim());
    if (value.includes('\0') || points.some(c => c.length === 1 && c.charCodeAt(0) >= 0xd800 && c.charCodeAt(0) <= 0xdfff)) throw new Error('invalid_catalog_name');
    return points.slice(0, 100).join('');
}
async function transaction(pool, work) {
    const db = await pool.getConnection();
    try {
        await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
        await db.beginTransaction(); const result = await work(db); await db.commit(); return result;
    }
    catch (error) { await db.rollback(); throw error; }
    finally { db.release(); }
}
async function stateRow(db) {
    await db.execute(`INSERT INTO sso_catalog_state(singleton,catalog_epoch) VALUES(1,?)
        ON DUPLICATE KEY UPDATE singleton=VALUES(singleton)`, [crypto.randomUUID()]);
    const [[state]] = await db.execute(`SELECT catalog_epoch,CAST(catalog_revision AS CHAR) AS catalog_revision,
        catalog_digest,event_id,snapshot,lease_token,lease_event_id,lease_until FROM sso_catalog_state WHERE singleton=1 FOR UPDATE`);
    return state;
}
async function insertEvent(db, event, status = 'pending') {
    if (!UUID.test(event.id) || !/^[a-z][a-z0-9_.-]{0,63}$/.test(event.type)) throw new Error('invalid_event');
    const hash = digest({ type: event.type, payload: event.payload });
    await db.execute(`INSERT IGNORE INTO sso_pending_events(id,kind,payload,payload_digest,status)
        VALUES(?,?,?,?,?)`, [event.id, event.type, canonical(event.payload), hash, status]);
    const [[row]] = await db.execute('SELECT payload_digest FROM sso_pending_events WHERE id=?', [event.id]);
    if (row.payload_digest !== hash) throw new Error('event_identity_conflict');
}
/** Both tables use one repeatable-read snapshot, never Redis caches. */
async function readCatalog(db) {
    const [rows] = await db.execute('SELECT role_id,role_name,permission_level,is_system FROM roles ORDER BY role_id');
    const [settings] = await db.execute(`SELECT setting_key,setting_value FROM site_settings
        WHERE setting_key IN ('registration_default_role','site_name')`);
    if (rows.length > 500) throw new Error('catalog_too_large');
    const values = Object.fromEntries(settings.map(r => [r.setting_key, r.setting_value]));
    const roles = rows.map(r => {
        roleId(r.role_id); roleId(r.permission_level);
        if (r.role_id === null || r.permission_level === null || typeof r.role_name !== 'string' || !r.role_name.trim()) throw new Error('invalid_catalog');
        return { role_id: r.role_id, name: catalogName(r.role_name), level: r.permission_level, is_system: !!r.is_system };
    });
    const raw = values.registration_default_role === undefined ? '2' : values.registration_default_role;
    const def = /^(0|[1-9][0-9]*)$/.test(raw) ? Number(raw) : null;
    return { site_name: catalogName(String(values.site_name || 'VideoSite')), roles,
        default_role: Number.isSafeInteger(def) && roles.some(r => r.role_id === def) ? def : null };
}
function createCatalogStore(pool) {
    async function snapshot({ force = false } = {}) {
        return transaction(pool, async db => {
            const state = await stateRow(db);
            const catalog = await readCatalog(db), hash = digest(catalog);
            const changed = state.catalog_digest !== hash;
            let rev = BigInt(state.catalog_revision);
            if (changed) { if (rev >= MAX_REVISION) throw new Error('catalog_revision_exhausted'); rev += 1n; }
            const payload = changed ? { ...catalog, catalog_epoch: state.catalog_epoch, catalog_revision: String(rev) }
                : JSON.parse(state.snapshot);
            const payloadHash = digest({ type: 'roles.sync', payload });
            let id = changed ? crypto.randomUUID() : state.event_id;
            if (!id) {
                const [[previous]] = await db.execute(`SELECT id FROM sso_pending_events WHERE kind='roles.sync'
                    AND payload_digest=? ORDER BY sequence DESC LIMIT 1`, [payloadHash]);
                id = previous?.id || crypto.randomUUID();
            }
            if (changed || !state.event_id) await db.execute(`UPDATE sso_catalog_state
                SET catalog_revision=?,catalog_digest=?,snapshot=?,event_id=? WHERE singleton=1`,
                [String(rev), hash, canonical(payload), id]);
            // Full snapshots make older undelivered catalogs redundant. Keep
            // immutable history, and fence any worker still sending the old ID.
            const [superseded] = await db.execute(`UPDATE sso_pending_events SET status='superseded'
                WHERE kind='roles.sync' AND id<>? AND status IN ('pending','dead')`, [id]);
            if (superseded.affectedRows) await db.execute(`UPDATE sso_catalog_state
                SET lease_token=NULL,lease_event_id=NULL,lease_until=NULL
                WHERE singleton=1 AND lease_event_id IN (
                    SELECT id FROM sso_pending_events WHERE kind='roles.sync' AND status='superseded')`);
            const event = { id, type: 'roles.sync', payload };
            const [[old]] = await db.execute(`SELECT payload_digest,status,last_error_code,
                next_attempt_at<=NOW(6) AS due FROM sso_pending_events WHERE id=?`, [id]);
            if (old && old.payload_digest !== payloadHash) throw new Error('event_identity_conflict');
            if (!old) await insertEvent(db, event);
            else if (old.status !== 'pending' && (force || (old.status === 'dead' && old.due && old.last_error_code !== 'payload_too_large'))) {
                await db.execute(`UPDATE sso_pending_events SET status='pending',delivered_at=NULL,
                    next_attempt_at=IF(?=1,NOW(6),next_attempt_at) WHERE id=?`, [force ? 1 : 0, id]);
            }
            if (superseded.affectedRows) await db.execute(`UPDATE sso_catalog_state SET next_attempt_at=COALESCE(
                (SELECT next_attempt_at FROM sso_pending_events WHERE status='pending' ORDER BY sequence LIMIT 1),NOW(6))
                WHERE singleton=1`);
            return event;
        });
    }
    async function enqueue(type, payload = {}) {
        if (type === 'roles.sync') return snapshot({ force: true });
        return transaction(pool, async db => {
            await stateRow(db); const event = { id: crypto.randomUUID(), type, payload };
            await insertEvent(db, event); return event;
        });
    }
    async function claim() {
        return transaction(pool, async db => {
            await stateRow(db); const token = crypto.randomUUID();
            const [claimed] = await db.execute(`UPDATE sso_catalog_state SET lease_token=?,lease_until=DATE_ADD(NOW(6),INTERVAL 30 SECOND)
                WHERE singleton=1 AND next_attempt_at<=NOW(6) AND (lease_until IS NULL OR lease_until<=NOW(6))`, [token]);
            if (!claimed.affectedRows) return null;
            const [[row]] = await db.execute(`SELECT id,kind,payload,attempts,next_attempt_at,next_attempt_at<=NOW(6) AS due FROM sso_pending_events
                WHERE status='pending' ORDER BY sequence LIMIT 1`);
            if (!row) { await db.execute('UPDATE sso_catalog_state SET lease_token=NULL,lease_event_id=NULL,lease_until=NULL WHERE singleton=1 AND lease_token=?', [token]); return null; }
            if (!row.due) {
                await db.execute('UPDATE sso_catalog_state SET lease_token=NULL,lease_event_id=NULL,lease_until=NULL,next_attempt_at=? WHERE singleton=1 AND lease_token=?', [row.next_attempt_at, token]);
                return null;
            }
            await db.execute('UPDATE sso_catalog_state SET lease_event_id=? WHERE singleton=1 AND lease_token=?', [row.id, token]);
            return { token, event: { id: row.id, type: row.kind, payload: JSON.parse(row.payload) }, attempts: row.attempts };
        });
    }
    async function finish(job, delivered, { permanent = false } = {}) {
        return transaction(pool, async db => {
            const state = await stateRow(db); if (state.lease_token !== job.token || state.lease_event_id !== job.event.id) return false;
            const attempts = Math.min(job.attempts + 1, 50), dead = permanent || (job.event.type !== 'roles.sync' && attempts >= 50);
            const seconds = delivered ? 0 : Math.min(3600, 60 * 2 ** Math.min(attempts - 1, 6));
            await db.execute(`UPDATE sso_pending_events SET status=?,attempts=?,delivered_at=IF(?=1,NOW(6),NULL),
                next_attempt_at=DATE_ADD(NOW(6),INTERVAL ? SECOND),last_error_code=?
                WHERE id=? AND status='pending'`, [delivered ? 'delivered' : dead ? 'dead' : 'pending', attempts,
                delivered ? 1 : 0, seconds, delivered ? null : permanent ? 'payload_too_large' : 'delivery_failed', job.event.id]);
            await db.execute(`UPDATE sso_catalog_state SET lease_token=NULL,lease_event_id=NULL,lease_until=NULL,
                next_attempt_at=DATE_ADD(NOW(6),INTERVAL ? SECOND) WHERE singleton=1 AND lease_token=?`, [dead ? 0 : seconds, job.token]);
            return true;
        });
    }
    async function importLegacy(redis) {
        if (!redis) return;
        // Legacy catalog jobs had no immutable payload. Commit a new current
        // snapshot and terminal original receipt before removing the exact member.
        const members = await redis.zrange('sso:events:out', 0, 99);
        for (const member of members) {
            let old; try { old = JSON.parse(member); } catch { throw new Error('invalid_legacy_event'); }
            if (!old || typeof old.id !== 'string' || !UUID.test(old.id) || typeof old.type !== 'string') throw new Error('invalid_legacy_event');
            if (old.type === 'roles.sync') await snapshot({ force: true });
            await transaction(pool, async db => {
                await stateRow(db);
                await insertEvent(db, { id: old.id, type: old.type, payload: old.payload || {} }, old.type === 'roles.sync' ? 'superseded' : 'pending');
            });
            await redis.zrem('sso:events:out', member);
        }
    }
    return { snapshot, enqueue, claim, finish, importLegacy };
}
module.exports = { createCatalogStore, transaction, readCatalog };
