// Site settings cache. The whole site_settings table is loaded into a single
// JSON blob (keys are short, table has ~30 rows) so a request that reads
// multiple settings only pays for one Redis GET. Any settings UPDATE blows
// the whole blob; settings change rarely so this is fine.
//
// On top of the Redis blob, an in-process memo skips the Redis round-trip
// for back-to-back reads within the same request (and across requests
// within MEMO_TTL_MS). Every authed request reads at least 2 settings via
// `getSessionLimits` (session_inactivity_days + session_max_days), and any
// MFA flow reads several `mfa_*` policies — without the memo each is a
// separate Redis GET. invalidate() clears both layers so admin changes
// apply immediately on the writing process; staleness on other processes
// is bounded by MEMO_TTL_MS (acceptable since settings rarely change).

const { getClient } = require('../redis');
const { getPool } = require('../../config/database');

const KEY = 'site:settings';
const TTL = 30 * 60;          // Redis blob TTL — 30 min
const MEMO_TTL_MS = 30 * 1000; // in-process memo — 30s

let memoBlob = null;
let memoExpiresAt = 0;

async function loadFromDb() {
    const pool = getPool();
    const [rows] = await pool.execute('SELECT setting_key, setting_value FROM site_settings');
    const obj = {};
    for (const row of rows) obj[row.setting_key] = row.setting_value;
    return obj;
}

async function getAllSettings() {
    const now = Date.now();
    if (memoBlob && now < memoExpiresAt) return memoBlob;

    const redis = getClient();
    const cached = await redis.get(KEY);
    if (cached) {
        memoBlob = JSON.parse(cached);
        memoExpiresAt = now + MEMO_TTL_MS;
        return memoBlob;
    }

    const obj = await loadFromDb();
    await redis.set(KEY, JSON.stringify(obj), 'EX', TTL);
    memoBlob = obj;
    memoExpiresAt = now + MEMO_TTL_MS;
    return obj;
}

// Convenience: single-key lookup with default. Falls through to the cache,
// so a service-level wrapper of this is cheap.
async function getSetting(key, defaultValue) {
    const all = await getAllSettings();
    const value = all[key];
    return (value !== undefined && value !== null) ? value : defaultValue;
}

async function invalidate() {
    memoBlob = null;
    memoExpiresAt = 0;
    await getClient().del(KEY);
}

module.exports = { getAllSettings, getSetting, invalidate };
