'use strict';
const crypto = require('node:crypto');
const {performance} = require('node:perf_hooks');
const PREPUBLICATION_MS = 300000, RETENTION_MS = 86400000;
const TABLE = 'oidc_client_signing_state';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const SELECT = `SELECT CAST(version AS CHAR) AS version, encrypted_state,
 DATE_FORMAT(UTC_TIMESTAMP(6),'%Y-%m-%dT%H:%i:%s.%fZ') AS now_utc FROM ${TABLE} WHERE singleton=1`;

class ClientSigningKeyError extends Error {
    constructor() { super('Client signing-key state is unavailable.');this.code = 'client_key_unavailable'; }
}
function need(value) { if (!value) throw new ClientSigningKeyError(); }
function date(value) { need(typeof value === 'string' && Number.isFinite(Date.parse(value)));return value; }
function thumbprint(jwk) { return crypto.createHash('sha256').update(JSON.stringify({ crv: 'Ed25519', kty: 'OKP', x: jwk.x })).digest('base64url'); }
function publicKey(value) {
    need(value && value.kty === 'OKP' && value.crv === 'Ed25519' && typeof value.x === 'string' && typeof value.kid === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value.x)
        && /^[A-Za-z0-9_-]{1,200}$/.test(value.kid) && (value.alg === undefined || value.alg === 'EdDSA'));
    return { kty: 'OKP', crv: 'Ed25519', x: value.x, kid: value.kid, alg: 'EdDSA', use: 'sig' };
}
function privateKey(value) {
    const pub = publicKey(value);need(typeof value.d === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value.d));
    const key = crypto.createPrivateKey({ key: { ...pub, d: value.d }, format: 'jwk' });
    need(crypto.createPublicKey(key).export({ format: 'jwk' }).x === pub.x);
    return { ...pub, d: value.d };
}
function generate() {
    const pair = crypto.generateKeyPairSync('ed25519'), value = pair.privateKey.export({ format: 'jwk' });
    value.kid = thumbprint(value);value.alg = 'EdDSA';
    const proof = Buffer.from('videosite-client-key-self-test');
    need(crypto.verify(null, proof, pair.publicKey, crypto.sign(null, proof, pair.privateKey)));
    return privateKey(value);
}
function decodeState(raw) {
    const value = JSON.parse(raw);need(value && value.version === 1 && value.current && Array.isArray(value.retired) && value.retired.length <= 512);
    const current = privateKey(value.current), rotated_at = value.rotated_at === null ? null : date(value.rotated_at);
    const retired = value.retired.map(row => ({ key: publicKey(row.key), retired_at: date(row.retired_at) }));
    let pending = null;
    if (value.pending !== null) {
        const row = value.pending;need(row && UUID.test(row.id));
        need((row.published_at === null) === (row.activate_after === null));
        if (row.published_at !== null) need(Date.parse(date(row.activate_after)) - Date.parse(date(row.published_at)) >= PREPUBLICATION_MS);
        pending = { id: row.id, key: privateKey(row.key), created_at: date(row.created_at), published_at: row.published_at, activate_after: row.activate_after };
    }
    const kids = [current.kid, ...(pending ? [pending.key.kid] : []), ...retired.map(row => row.key.kid)];
    need(new Set(kids).size === kids.length);
    return { version: 1, current, rotated_at, pending, retired };
}
function legacyState(raw, at) {
    const file = JSON.parse(raw), keys = Array.isArray(file.keys) ? file.keys : [file];need(keys.length > 0 && keys.length <= 512);
    const current = privateKey(keys[0]);let retired = [];
    const rotated_at = file.rotated_at ? date(file.rotated_at) : null;
    if (rotated_at && at - Date.parse(rotated_at) < RETENTION_MS) retired = keys.slice(1).map(key => ({ key: publicKey(key), retired_at: rotated_at }));
    return decodeState(JSON.stringify({ version: 1, current, rotated_at, pending: null, retired }));
}
function publicJwks(state, at) {
    return { keys: [publicKey(state.current), ...(state.pending ? [publicKey(state.pending.key)] : []),
        ...state.retired.filter(row => at - Date.parse(row.retired_at) < RETENTION_MS).map(row => publicKey(row.key))] };
}
function status(state) {
    return { kid: state.current.kid, rotated_at: state.rotated_at, state: state.pending ? 'pending' : 'active',
        rotation: state.pending ? { id: state.pending.id, kid: state.pending.key.kid, published_at: state.pending.published_at, activate_after: state.pending.activate_after } : null };
}
function version(value) { need(typeof value === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(value) && BigInt(value) < 18446744073709551615n);return value; }
function aad(revision) { return Buffer.from(`videosite/${TABLE}/1/state/${version(revision)}`); }
function secretKey() { const raw = process.env.SETTINGS_SECRET_ENCRYPTION_KEY;need(typeof raw === 'string' && /^[a-fA-F0-9]{64}$/.test(raw));return Buffer.from(raw, 'hex'); }
function seal(state, revision, encryptionKey = secretKey()) {
    const nonce = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey, nonce);cipher.setAAD(aad(revision));
    const bytes = Buffer.concat([cipher.update(JSON.stringify(state), 'utf8'), cipher.final()]);
    return `oidc:v1:${nonce.toString('base64url')}:${cipher.getAuthTag().toString('base64url')}:${bytes.toString('base64url')}`;
}
function unseal(stored, revision, encryptionKey = secretKey()) {
    need(typeof stored === 'string' && stored.length <= 512 * 1024);
    const parts = /^oidc:v1:([A-Za-z0-9_-]{16}):([A-Za-z0-9_-]{22}):([A-Za-z0-9_-]+)$/.exec(stored);need(parts);
    const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey, Buffer.from(parts[1], 'base64url'));decipher.setAAD(aad(revision));decipher.setAuthTag(Buffer.from(parts[2], 'base64url'));
    return decodeState(Buffer.concat([decipher.update(Buffer.from(parts[3], 'base64url')), decipher.final()]).toString('utf8'));
}

class ClientSigningKeyStore {
    constructor(pool, readLegacy, codec = { seal, unseal }, newKey = generate) {
        this.pool = pool;this.readLegacy = readLegacy;this.codec = codec;this.newKey = newKey;
    }
    async row(db = this.pool, lock = false) {
        const started=performance.now();
        const [rows] = await db.query({sql:SELECT + (lock ? ' FOR UPDATE' : ''),timeout:5000});
        need(performance.now()-started<=5000 && rows.length === 1);
        const row = rows[0];version(row.version);date(row.now_utc);
        need(row.encrypted_state === null ? row.version === '0' : typeof row.encrypted_state === 'string');
        return { ...row, at: Date.parse(row.now_utc), state: row.encrypted_state === null ? null : this.codec.unseal(row.encrypted_state, row.version) };
    }
    async transaction(work) {
        const db = await this.pool.getConnection();let previous, destroyed=false;
        try {
            const [settings] = await db.query('SELECT @@session.innodb_lock_wait_timeout AS row_timeout, @@session.lock_wait_timeout AS metadata_timeout');
            previous = settings[0];need(Number.isSafeInteger(Number(previous.row_timeout)) && Number.isSafeInteger(Number(previous.metadata_timeout)));
            await db.query('SET SESSION innodb_lock_wait_timeout=3, SESSION lock_wait_timeout=3');
            await db.beginTransaction();const result = await work(db);await db.commit();return result;
        } catch (error) {
            // mysql2's query timer rejects its callback without cancelling the
            // wire operation. Destroy this owned connection instead of waiting
            // for a rollback behind that unsettled query or returning it to pool.
            if (error?.code === 'PROTOCOL_SEQUENCE_TIMEOUT' || error?.fatal) { db.destroy();destroyed=true; }
            else await db.rollback().catch(() => {});
            throw error;
        }
        finally {
            try { if (!destroyed) { if (previous) await db.query('SET SESSION innodb_lock_wait_timeout=?, SESSION lock_wait_timeout=?', [Number(previous.row_timeout), Number(previous.metadata_timeout)]);db.release(); } }
            catch { db.destroy(); }
        }
    }
    async write(db, row, state) {
        const next = (BigInt(row.version) + 1n).toString(), encrypted = this.codec.seal(state, next);
        const [result] = await db.execute(`UPDATE ${TABLE} SET version=?,encrypted_state=?,modified_at=UTC_TIMESTAMP(6) WHERE singleton=1 AND version=?`, [next, encrypted, row.version]);
        need(result.affectedRows === 1);
    }
    async reconcile(kid) {
        await this.transaction(async db => {
            const row = await this.row(db, true), state = row.state;need(state);
            const pending = state.pending;if (!pending || pending.key.kid !== kid) return;
            if (!pending.published_at) {
                // A prior transaction has already made this key publicly visible.
                pending.published_at = new Date(row.at).toISOString();pending.activate_after = new Date(row.at + PREPUBLICATION_MS).toISOString();
            } else {
                if (row.at < Date.parse(pending.activate_after)) return;
                state.retired = [...state.retired.filter(key => row.at - Date.parse(key.retired_at) < RETENTION_MS),
                    { key: publicKey(state.current), retired_at: new Date(row.at).toISOString() }];
                state.current = pending.key;state.rotated_at = new Date(row.at).toISOString();state.pending = null;
            }
            await this.write(db, row, state);
        });
    }
    async read(reconcile = false, strictReconcile = true) {
        let row = await this.row();
        if (!row.state) return { state: legacyState(await this.readLegacy(), row.at), at: row.at, legacy: true };
        if (reconcile && row.state.pending && (!row.state.pending.published_at || row.at >= Date.parse(row.state.pending.activate_after))) {
            try { await this.reconcile(row.state.pending.key.kid); }
            catch (error) { if (strictReconcile) throw error; }
            // Failed maintenance cannot justify using an old process snapshot.
            row = await this.row();need(row.state);
        }
        return { state: row.state, at: row.at, legacy: false };
    }
    async schedule() {
        const kid = await this.transaction(async db => {
            const row = await this.row(db, true), state = row.state || legacyState(await this.readLegacy(), row.at);
            if (state.pending) return state.pending.key.kid;
            state.retired = state.retired.filter(key => row.at - Date.parse(key.retired_at) < RETENTION_MS);
            need(state.retired.length < 511);
            const key = this.newKey();state.pending = { id: crypto.randomUUID(), key, created_at: new Date(row.at).toISOString(), published_at: null, activate_after: null };
            // Import and authority marker commit with the first published pending key.
            await this.write(db, row, state);return key.kid;
        });
        await this.reconcile(kid);return status((await this.read(true)).state);
    }
    async signingKey() { const { state } = await this.read(true, false);return { kid: state.current.kid, jwk: state.current }; }
    async jwks() { const { state, at } = await this.read();return publicJwks(state, at); }
    async info() { return status((await this.read(true)).state); }
    async authoritative() { return (await this.row()).state !== null; }
}

module.exports = { ClientSigningKeyStore, ClientSigningKeyError, PREPUBLICATION_MS, RETENTION_MS,
    legacyState, publicJwks, publicKey, privateKey, generate, seal, unseal, status };
