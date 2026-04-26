// Site settings cache. The whole site_settings table is loaded into a single
// JSON blob (keys are short, table has ~30 rows) so a request that reads
// multiple settings only pays for one Redis GET. Any settings UPDATE blows
// the whole blob; settings change rarely so this is fine.

const { getClient } = require('../redis');
const { getPool } = require('../../config/database');

const KEY = 'site:settings';
const TTL = 30 * 60; // 30 min

async function loadFromDb() {
    const pool = getPool();
    const [rows] = await pool.execute('SELECT setting_key, setting_value FROM site_settings');
    const obj = {};
    for (const row of rows) obj[row.setting_key] = row.setting_value;
    return obj;
}

async function getAllSettings() {
    const redis = getClient();
    const cached = await redis.get(KEY);
    if (cached) return JSON.parse(cached);

    const obj = await loadFromDb();
    await redis.set(KEY, JSON.stringify(obj), 'EX', TTL);
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
    await getClient().del(KEY);
}

module.exports = { getAllSettings, getSetting, invalidate };
