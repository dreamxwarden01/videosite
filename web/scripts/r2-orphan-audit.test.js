'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
    normalizeSnapshot, ownershipFingerprint, classifyPrefix, scanPrefixes,
    finalizeReport, readCredentials, validateEndpoint, writeReport,
} = require('./r2-orphan-audit');

const A = 'A'.repeat(64), B = 'B'.repeat(64), C = 'C'.repeat(64);
const U = 'U'.repeat(12), V = 'V'.repeat(12), W = 'W'.repeat(12);
const now = () => new Date().toISOString();
function snapshot() {
    return {
        schema_version: 1, captured_at: now(), complete: true, bucket: 'example-bucket',
        courses: [{ course_id: 1 }, { course_id: 2 }],
        videos: [{ video_id: 1, course_id: 1, hashed_video_id: A, r2_source_key: `source/${U}/source.mp4`, status: 'finished' }],
        materials: [{ material_id: 1, course_id: 1, object_key: 'attachments/1/material.pdf' }],
        upload_sessions: [{ upload_id: V, course_id: 2, object_key: `source/${V}/source.mp4`, type: 'video', status: 'active' }],
        pending_deletes: [{ id: '1', mode: 'prefix', target: `${B}/`, execute_at: now() }],
    };
}
const prefixes = values => ({ CommonPrefixes: values.map(Prefix => ({ Prefix })), IsTruncated: false });
function fakeListing(data, calls = []) {
    return async input => {
        calls.push(structuredClone(input));
        const rows = data[input.Prefix];
        assert.ok(rows?.length, `Unexpected List scope ${input.Prefix}`);
        return structuredClone(rows.shift());
    };
}
function listing() {
    return {
        '': [prefixes([`${A}/`, `${B}/`, `${C}/`, 'attachments/', 'posters/', 'source/', 'other/'])],
        'attachments/': [prefixes(['attachments/1/', 'attachments/2/', 'attachments/3/'])],
        'source/': [prefixes([`source/${U}/`, `source/${V}/`, `source/${W}/`])],
        'posters/': [prefixes(['posters/1/', 'posters/3/'])],
    };
}

test('classifies live, pending, active-upload and candidate prefixes without reading bodies', async () => {
    const s = snapshot(), calls = [];
    const report = await scanPrefixes(s, fakeListing(listing(), calls));
    const byPrefix = new Map(report.findings.map(row => [row.prefix, row]));
    assert.equal(report.status, 'snapshot_unconfirmed');
    assert.equal(byPrefix.get(`${A}/`).classification, 'referenced');
    assert.equal(byPrefix.get(`${B}/`).classification, 'pending_cleanup_overlap');
    assert.equal(byPrefix.get(`${C}/`).classification, 'orphan_candidate');
    assert.equal(byPrefix.get(`source/${V}/`).classification, 'active_upload');
    assert.equal(byPrefix.get(`source/${W}/`).classification, 'orphan_candidate');
    assert.equal(byPrefix.get('attachments/2/').classification, 'referenced');
    assert.equal(byPrefix.get('attachments/2/').material_rows, 0);
    assert.equal(byPrefix.get('attachments/3/').classification, 'orphan_candidate');
    assert.equal(byPrefix.get('other/').classification, 'unclassified');
    assert.deepEqual(calls.map(call => call.Prefix), ['', 'attachments/', 'source/', 'posters/']);
    assert.ok(calls.every(call => call.Delimiter === '/' && call.MaxKeys === 1000));
    assert.deepEqual(report.database_videos_without_output_prefix, []);
});

test('follows every page with opaque tokens, reports calls and SDK retries', async () => {
    const pages = listing(), calls = [];
    pages[''] = [
        { ...prefixes([`${A}/`]), IsTruncated: true, NextContinuationToken: 'opaque&token=1', $metadata: { attempts: 2, totalRetryDelay: 750 } },
        prefixes([`${C}/`, 'source/', 'posters/', 'attachments/']),
    ];
    const report = await scanPrefixes(snapshot(), fakeListing(pages, calls));
    assert.equal(calls[1].ContinuationToken, 'opaque&token=1');
    assert.equal(report.listing.calls, 5);
    assert.equal(report.listing.sdk_attempts, 6);
    assert.equal(report.listing.sdk_retry_delay_ms, 750);
});

test('lists serially even with multiple scopes and pages', async () => {
    let concurrent = 0, maximum = 0;
    const report = await scanPrefixes(snapshot(), async () => {
        concurrent++; maximum = Math.max(maximum, concurrent);
        await new Promise(resolve => setTimeout(resolve, 2)); concurrent--;
        return prefixes([]);
    });
    assert.equal(maximum, 1);
    assert.equal(report.listing.calls, 4);
    assert.equal(report.database_videos_without_output_prefix[0].status, 'finished');
});

test('pending child key or child prefix prevents whole-prefix orphan declaration', () => {
    const s = normalizeSnapshot(snapshot());
    s.pending_deletes.push({ id: '2', mode: 'key', target: 'attachments/3/one.pdf', execute_at: now() });
    s.pending_deletes.push({ id: '3', mode: 'prefix', target: `${C}/job/`, execute_at: now() });
    assert.equal(classifyPrefix('attachments/3/', s).classification, 'pending_cleanup_overlap');
    assert.equal(classifyPrefix(`${C}/`, s).classification, 'pending_cleanup_overlap');
    assert.equal(classifyPrefix('attachments/30/', s).classification, 'orphan_candidate');
});

test('completed/aborted upload sessions do not reserve an unreferenced source forever', () => {
    for (const status of ['completed', 'aborted']) {
        const s = normalizeSnapshot(snapshot()); s.upload_sessions[0].status = status;
        assert.equal(classifyPrefix(`source/${V}/`, s).classification, 'orphan_candidate');
    }
});

test('root objects and unfamiliar folder names are unclassified, never deletion candidates', async () => {
    const pages = listing(); pages[''][0].Contents = [{ Key: 'legacy-file.mp4' }];
    pages['source/'][0].CommonPrefixes.push({ Prefix: 'source/unfamiliar-name/' });
    const r = await scanPrefixes(snapshot(), fakeListing(pages));
    assert.ok(r.findings.filter(x => ['legacy-file.mp4', 'source/unfamiliar-name/'].includes(x.prefix)).every(x => x.classification === 'unclassified'));
});

test('empty but explicitly complete database is supported, not confused with missing arrays', async () => {
    const s = snapshot(); for (const name of ['courses', 'videos', 'materials', 'upload_sessions', 'pending_deletes']) s[name] = [];
    const r = await scanPrefixes(s, fakeListing(listing()));
    assert.equal(r.findings.find(x => x.prefix === `${A}/`).classification, 'orphan_candidate');
    assert.equal(r.status, 'snapshot_unconfirmed');
    delete s.videos;
    assert.throws(() => normalizeSnapshot(s), /Missing videos/);
});

test('rejects missing completeness, partial relationships, invalid hashes and duplicate ownership', () => {
    const variants = [
        s => { delete s.complete; },
        s => { s.videos[0].course_id = 3; },
        s => { s.videos[0].hashed_video_id = 'legacy-short'; },
        s => { s.videos.push({ ...s.videos[0], video_id: 2 }); },
        s => { s.videos.push({ ...s.videos[0] }); },
        s => { s.materials[0].object_key = 'attachments/9/file.pdf'; },
        s => { s.upload_sessions[0].video_id = 999; },
        s => { s.pending_deletes[0].target = ''; },
    ];
    for (const change of variants) { const s = snapshot(); change(s); assert.throws(() => normalizeSnapshot(s)); }
});

test('fails before any API call for stale or future snapshots', async () => {
    for (const skew of [-86400001, 600000]) {
        const s = snapshot(); s.captured_at = new Date(Date.now() + skew).toISOString();
        let called = false;
        await assert.rejects(scanPrefixes(s, async () => { called = true; }), /Snapshot must/);
        assert.equal(called, false);
    }
});

test('fails on incomplete or looping pagination, including duplicated prefixes', async () => {
    for (const pages of [
        [{ ...prefixes([]), IsTruncated: true }],
        [{ ...prefixes([]), IsTruncated: true, NextContinuationToken: 'a' }, { ...prefixes([]), IsTruncated: true, NextContinuationToken: 'a' }],
        [{ ...prefixes([`${A}/`]), IsTruncated: true, NextContinuationToken: 'a' }, prefixes([`${A}/`])],
    ]) await assert.rejects(scanPrefixes(snapshot(), fakeListing({ '': pages })));
});

test('missing or non-boolean final pagination flag cannot silently certify a complete inventory', async () => {
    for (const flag of [undefined, null, 0, 'false']) {
        const response = prefixes([`${A}/`]);
        if (flag === undefined) delete response.IsTruncated;
        else response.IsTruncated = flag;
        await assert.rejects(scanPrefixes(snapshot(), async () => response), /truncation flag/);
    }
});

test('fails closed on response prefix escape and malformed delimiter-level objects', async () => {
    for (const response of [prefixes(['nested/deeper/']), { Contents: [{ Key: 'nested/object' }] }, { CommonPrefixes: {} }]) {
        await assert.rejects(scanPrefixes(snapshot(), async () => response));
    }
});

test('bounded API calls and entries prevent an unbounded prefix walk', async () => {
    let calls = 0;
    await assert.rejects(scanPrefixes(snapshot(), async () => { calls++; return { ...prefixes([]), IsTruncated: true, NextContinuationToken: String(calls) }; }, { maxPages: 2 }), /Page limit/);
    assert.equal(calls, 2);
    await assert.rejects(scanPrefixes(snapshot(), async () => prefixes([`${A}/`, `${B}/`]), { maxEntries: 1 }), /Entry limit/);
});

test('does not emit a completed report when an API request fails', async () => {
    await assert.rejects(scanPrefixes(snapshot(), async () => { throw Object.assign(new Error('simulated'), { $metadata: { httpStatusCode: 403 } }); }), /simulated/);
});

test('fingerprint is order-independent and ignores capture time, but retains lifecycle changes', () => {
    const a = snapshot(), b = structuredClone(a);
    b.courses.reverse(); b.captured_at = new Date(Date.now() + 1000).toISOString();
    assert.equal(ownershipFingerprint(a), ownershipFingerprint(b));
    b.upload_sessions[0].status = 'completed';
    assert.notEqual(ownershipFingerprint(a), ownershipFingerprint(b));
});

test('separate verification detects stable versus changed ownership with no listing', async () => {
    const before = snapshot(), report = await scanPrefixes(before, fakeListing(listing()));
    const after = structuredClone(before); after.captured_at = now();
    assert.equal(finalizeReport(report, before, after).status, 'snapshot_stable');
    after.videos[0].status = 'processing';
    const changed = finalizeReport(report, before, after);
    assert.equal(changed.status, 'snapshot_changed');
    assert.equal(changed.verification.ownership_unchanged, false);
});

test('verification rejects wrong bucket/snapshot, incomplete reports and non-bracketing capture times', async () => {
    const before = snapshot(), report = await scanPrefixes(before, fakeListing(listing()));
    const after = structuredClone(before); after.captured_at = now();
    const wrong = structuredClone(before); wrong.videos[0].status = 'queued';
    assert.throws(() => finalizeReport(report, wrong, after), /does not match/);
    assert.throws(() => finalizeReport({ ...report, listing: { complete: false } }, before, after));
    const past = { ...after, captured_at: new Date(Date.parse(report.finished_at) - 60000).toISOString() };
    assert.throws(() => finalizeReport(report, before, past), /bracket/);
    assert.throws(() => finalizeReport(report, before, { ...after, bucket: 'other-bucket' }), /does not match/);
});

function temp(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'videosite-r2-audit-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
}
const fakeCredentials = `R2_ACCESS_KEY_ID=${'a'.repeat(32)}\nR2_SECRET_ACCESS_KEY=${'b'.repeat(64)}\n`;

test('credential reader accepts only local owner-only fields as data', t => {
    const file = path.join(temp(t), 'readonly.env');
    fs.writeFileSync(file, '# synthetic\n' + fakeCredentials, { mode: 0o600 });
    assert.deepEqual(readCredentials(file), { accessKeyId: 'a'.repeat(32), secretAccessKey: 'b'.repeat(64) });
    fs.chmodSync(file, 0o644);
    assert.throws(() => readCredentials(file), /owner-only/);
});

test('credential reader rejects symlinks, shell syntax, empty fields and duplicate fields', t => {
    const dir = temp(t), file = path.join(dir, 'readonly.env'), link = path.join(dir, 'link.env');
    fs.writeFileSync(file, fakeCredentials, { mode: 0o600 }); fs.symlinkSync(file, link);
    assert.throws(() => readCredentials(link));
    for (const content of [
        'R2_ACCESS_KEY_ID=\nR2_SECRET_ACCESS_KEY=\n',
        fakeCredentials + `R2_ACCESS_KEY_ID=${'c'.repeat(32)}\n`,
        fakeCredentials.replace('a'.repeat(32), '$(touch unexpected-file)'),
        fakeCredentials + 'UNKNOWN=value\n',
    ]) { fs.writeFileSync(file, content); assert.throws(() => readCredentials(file)); }
    assert.equal(fs.existsSync(path.join(dir, 'unexpected-file')), false);
});

test('endpoint validation prevents credential submission to non-R2 hosts or URL parameters', () => {
    const host = `${'a'.repeat(32)}.r2.cloudflarestorage.com`;
    assert.equal(validateEndpoint(`https://${host}/`), `https://${host}`);
    assert.ok(validateEndpoint(`https://${'b'.repeat(32)}.eu.r2.cloudflarestorage.com`));
    for (const url of [`http://${host}`, `https://user@${host}`, `https://${host}/path`, `https://${host}?x=1`, `https://${host}:4433`, 'https://example.com', `https://${host}.evil.example`]) assert.throws(() => validateEndpoint(url));
});

test('writes new private reports and refuses overwrite', async t => {
    const report = await scanPrefixes(snapshot(), fakeListing(listing()));
    const file = path.join(temp(t), 'report.json'); writeReport(file, report);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(fs.statSync(file.replace('.json', '.md')).mode & 0o777, 0o600);
    assert.throws(() => writeReport(file, report), /overwrite/);
    assert.match(fs.readFileSync(file.replace('.json', '.md'), 'utf8'), /No objects or database rows were written or deleted/);
});

test('CLI rejects write-like options and credential fallback before any API setup', () => {
    const run = spawnSync(process.execPath, [path.join(__dirname, 'r2-orphan-audit.js'), '--apply'], { encoding: 'utf8' });
    assert.equal(run.status, 1);
    assert.match(run.stderr, /Invalid arguments/);
    assert.equal(run.stdout, '');
});
