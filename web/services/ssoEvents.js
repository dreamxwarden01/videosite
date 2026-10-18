'use strict';
const backgroundTasks = require('../lib/backgroundTasks');
const oidc = require('../lib/oidc');
const { s2sFetch } = require('./s2sFetch');
const { getClient } = require('./redis');
const { getPool } = require('../config/database');
const { createCatalogStore } = require('./ssoCatalogStore');
const { EVENT_TOKEN_LIMIT } = require('../lib/ssoRoleProtocol');
const store = () => createCatalogStore(getPool());
let timer = null, draining = null;
function kick() {
    if (timer) return;
    timer = backgroundTasks.timeout(() => { timer = null; drain().catch(() => console.error('sso event delivery unavailable')); }, 2000);
    timer?.unref?.();
}
async function enqueue(type, payload = {}) {
    return backgroundTasks.track(store().enqueue(type, payload).then(result => { kick(); return result; }));
}
async function reportRoles() {
    return backgroundTasks.track(store().snapshot({ force: true }).then(result => { kick(); return result; }));
}
async function composeRolesPayload() { return (await reportRoles()).payload; }
async function deliver() {
    const db = store();
    await db.snapshot();
    try { await db.importLegacy(getClient()); } catch { console.error('legacy sso event import pending'); }
    for (let count = 0; count < 100 && !backgroundTasks.stopping; count++) {
        const job = await db.claim(); if (!job) break;
        let ok = false, permanent = false;
        try {
            const token = await oidc.signEventToken([job.event]);
            if (token.length > EVENT_TOKEN_LIMIT) permanent = true;
            else {
                const response = await s2sFetch(oidc.ssoEventsUrl(), { method: 'POST',
                    headers: { 'content-type': 'application/x-www-form-urlencoded' },
                    body: new URLSearchParams({ event_token: token }), signal: AbortSignal.timeout(5000) });
                ok = response.status === 204;
            }
        } catch { /* Immutable SQL job remains available for retry. */ }
        if (!(await db.finish(job, ok, { permanent })) || !ok) break;
    }
}
function drain() {
    if (draining) return draining;
    draining = backgroundTasks.run(deliver).finally(() => { draining = null; });
    return draining;
}
function start() {
    if (backgroundTasks.stopping) return;
    backgroundTasks.run(() => reportRoles().then(drain)).catch(() => console.error('sso catalog boot reconciliation unavailable'));
    const interval = backgroundTasks.interval(() => drain().catch(() => console.error('sso catalog reconciliation unavailable')), 60000);
    interval?.unref?.();
    require('./ssoRoleAuthority').start();
}
module.exports = { enqueue, reportRoles, drain, start, composeRolesPayload };
