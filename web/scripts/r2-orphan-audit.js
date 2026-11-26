#!/usr/bin/env node
'use strict';

// Prefix-only inventory. There is deliberately no apply/delete mode, no DB
// connection, and no production-credential fallback. See --help for the
// snapshot contract and the separate post-scan verification step.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const VIDEO_HASH = /^[A-Za-z0-9]{64}$/;
const UPLOAD_ID = /^[A-Za-z0-9]{12}$/;
const COURSE_ID = /^[1-9][0-9]*$/;
const VIDEO_STATUSES = new Set(['queued', 'worker_downloading', 'processing', 'worker_uploading', 'finished', 'error']);
const UPLOAD_STATUSES = new Set(['active', 'completing', 'completed', 'aborted']);
// upload.js awaits the new video/source UPDATE before markCompleted; a failure
// before ownership is recorded leaves the session completing. Historical
// completed sessions must not reserve old replacement sources indefinitely.
// This relies on the documented consistent DB snapshot, not separate SELECTs
// from different points in the upload lifecycle. Candidates still need review.
const ACTIVE_UPLOADS = new Set(['active', 'completing']);
const SCOPES = ['', 'attachments/', 'source/', 'posters/'];

class AuditError extends Error {}
function fail(message) { throw new AuditError(message); }
function object(value, name) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`Invalid ${name}`);
}
function id(value, name) {
    if (typeof value === 'number' && !Number.isSafeInteger(value)) fail(`Invalid ${name}`);
    const result = String(value);
    if (!COURSE_ID.test(result)) fail(`Invalid ${name}`);
    return result;
}
function timestamp(value, name) {
    if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(value) || !Number.isFinite(Date.parse(value))) fail(`Invalid ${name}`);
    return new Date(value).toISOString();
}
function key(value, name) {
    if (typeof value !== 'string' || !value || Buffer.byteLength(value) > 1024 || /[\x00-\x1f\x7f]/.test(value)) fail(`Invalid ${name}`);
    return value;
}
function sortedUniqueRows(value, name, normalize, uniqueKey) {
    if (!Array.isArray(value)) fail(`Missing ${name} array`);
    const rows = value.map(normalize);
    const seen = new Set();
    for (const row of rows) {
        const k = uniqueKey(row);
        if (seen.has(k)) fail(`Duplicate ${name} identifier`);
        seen.add(k);
    }
    return rows.sort((a, b) => uniqueKey(a).localeCompare(uniqueKey(b), 'en'));
}

function normalizeSnapshot(input) {
    object(input, 'snapshot');
    if (input.schema_version !== 1 || input.complete !== true) fail('Snapshot must be complete schema_version 1');
    if (typeof input.bucket !== 'string' || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(input.bucket)) fail('Invalid snapshot bucket');
    const out = {
        schema_version: 1,
        captured_at: timestamp(input.captured_at, 'snapshot captured_at'),
        complete: true,
        bucket: input.bucket,
    };
    out.courses = sortedUniqueRows(input.courses, 'courses', row => {
        object(row, 'course'); return { course_id: id(row.course_id, 'course_id') };
    }, row => row.course_id);
    const courseIds = new Set(out.courses.map(row => row.course_id));
    const course = value => {
        const valueId = id(value, 'course_id');
        if (!courseIds.has(valueId)) fail('Snapshot contains a reference to an absent course');
        return valueId;
    };
    out.videos = sortedUniqueRows(input.videos, 'videos', row => {
        object(row, 'video');
        if (typeof row.hashed_video_id !== 'string' || !VIDEO_HASH.test(row.hashed_video_id)) fail('Invalid video hash; refusing incomplete ownership map');
        if (!VIDEO_STATUSES.has(row.status)) fail('Invalid video status');
        return {
            video_id: id(row.video_id, 'video_id'), course_id: course(row.course_id),
            hashed_video_id: row.hashed_video_id,
            r2_source_key: row.r2_source_key == null ? null : key(row.r2_source_key, 'video source key'),
            status: row.status,
        };
    }, row => row.video_id);
    if (new Set(out.videos.map(row => row.hashed_video_id)).size !== out.videos.length) fail('Duplicate video hash');
    const videoIds = new Set(out.videos.map(row => row.video_id));
    out.materials = sortedUniqueRows(input.materials, 'materials', row => {
        object(row, 'material');
        const courseId = course(row.course_id);
        const objectKey = key(row.object_key, 'material object key');
        if (!objectKey.startsWith(`attachments/${courseId}/`)) fail('Material key does not match its course');
        return { material_id: id(row.material_id, 'material_id'), course_id: courseId, object_key: objectKey };
    }, row => row.material_id);
    out.upload_sessions = sortedUniqueRows(input.upload_sessions, 'upload_sessions', row => {
        object(row, 'upload session');
        if (typeof row.upload_id !== 'string' || !UPLOAD_ID.test(row.upload_id)) fail('Invalid upload_id');
        if (!UPLOAD_STATUSES.has(row.status) || !['video', 'attachment'].includes(row.type)) fail('Invalid upload session status or type');
        const videoId = row.video_id == null ? null : id(row.video_id, 'upload video_id');
        if (videoId != null && !videoIds.has(videoId)) fail('Upload references an absent video');
        return {
            upload_id: row.upload_id, course_id: course(row.course_id), video_id: videoId,
            object_key: key(row.object_key, 'upload object key'), status: row.status, type: row.type,
        };
    }, row => row.upload_id);
    out.pending_deletes = sortedUniqueRows(input.pending_deletes, 'pending_deletes', row => {
        object(row, 'pending delete');
        if (!['key', 'prefix'].includes(row.mode)) fail('Invalid pending delete mode');
        return {
            id: id(row.id, 'pending delete id'), mode: row.mode,
            target: key(row.target, 'pending delete target'),
            execute_at: timestamp(row.execute_at, 'pending delete execute_at'),
        };
    }, row => row.id);
    return out;
}

function ownershipFingerprint(snapshot) {
    const normalized = normalizeSnapshot(snapshot);
    delete normalized.captured_at;
    return crypto.createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

function classifyPrefix(prefix, snapshot) {
    const videos = snapshot.videos;
    const active = snapshot.upload_sessions.filter(row => ACTIVE_UPLOADS.has(row.status));
    const pending = snapshot.pending_deletes.filter(row => row.mode === 'key'
        ? row.target.startsWith(prefix)
        : row.target.startsWith(prefix) || prefix.startsWith(row.target));
    const common = { prefix, pending_delete_ids: pending.map(row => row.id) };
    const protectedBy = active.filter(row => row.object_key.startsWith(prefix));
    const finish = (kind, owner, extra = {}) => {
        let classification = owner ? 'referenced' : 'orphan_candidate';
        if (!owner && protectedBy.length) classification = 'active_upload';
        else if (!owner && pending.length) classification = 'pending_cleanup_overlap';
        return { ...common, kind, classification, active_upload_ids: protectedBy.map(row => row.upload_id), ...extra };
    };
    if (prefix.split('/').length === 2 && VIDEO_HASH.test(prefix.slice(0, -1))) {
        const owner = videos.find(row => `${row.hashed_video_id}/` === prefix);
        return finish('video_output', Boolean(owner), owner ? { video_id: owner.video_id, course_id: owner.course_id } : {});
    }
    const source = /^source\/([A-Za-z0-9]{12})\/$/.exec(prefix);
    if (source) {
        const owners = videos.filter(row => row.r2_source_key && row.r2_source_key.startsWith(prefix));
        return finish('video_source', owners.length > 0, { video_ids: owners.map(row => row.video_id) });
    }
    const grouped = /^(attachments|posters)\/([1-9][0-9]*)\/$/.exec(prefix);
    if (grouped) {
        const courseId = grouped[2];
        const owner = snapshot.courses.some(row => row.course_id === courseId);
        const extra = { course_id: courseId };
        if (grouped[1] === 'attachments') extra.material_rows = snapshot.materials.filter(row => row.course_id === courseId).length;
        return finish(grouped[1] === 'attachments' ? 'course_attachments' : 'course_posters', owner, extra);
    }
    if (['source/', 'attachments/', 'posters/'].includes(prefix)) return { ...common, kind: 'namespace', classification: 'namespace' };
    return { ...common, kind: 'unknown', classification: 'unclassified' };
}

async function collectLevel(listPage, bucket, prefix, state, options) {
    const prefixes = new Set(), objects = new Set(), tokens = new Set();
    let continuation;
    do {
        if (state.calls >= options.maxPages) fail('Page limit reached; no complete inventory produced');
        const input = { Bucket: bucket, Prefix: prefix, Delimiter: '/', MaxKeys: 1000 };
        if (continuation) input.ContinuationToken = continuation;
        const began = Date.now();
        const page = await listPage(input);
        state.calls++;
        state.duration_ms += Date.now() - began;
        object(page, 'ListObjectsV2 result');
        if (page.CommonPrefixes != null && !Array.isArray(page.CommonPrefixes)) fail('Invalid prefix list');
        if (page.Contents != null && !Array.isArray(page.Contents)) fail('Invalid object list');
        for (const item of page.CommonPrefixes || []) {
            const value = key(item?.Prefix, 'listed prefix');
            const relative = value.slice(prefix.length);
            if (!value.startsWith(prefix) || !relative || !relative.endsWith('/') || relative.slice(0, -1).includes('/')) fail('Unexpected prefix outside requested delimiter level');
            if (prefixes.has(value)) fail('Duplicate prefix across pages; inventory may have changed');
            prefixes.add(value);
        }
        for (const item of page.Contents || []) {
            const value = key(item?.Key, 'listed object');
            if (!value.startsWith(prefix) || value.slice(prefix.length).includes('/')) fail('Unexpected object outside requested delimiter level');
            if (objects.has(value)) fail('Duplicate object across pages; inventory may have changed');
            objects.add(value);
        }
        if (state.entries + prefixes.size + objects.size > options.maxEntries) fail('Entry limit reached; no complete inventory produced');
        state.sdk_attempts += Number.isInteger(page.$metadata?.attempts) ? page.$metadata.attempts : 1;
        state.sdk_retry_delay_ms += Number.isFinite(page.$metadata?.totalRetryDelay) ? page.$metadata.totalRetryDelay : 0;
        if (typeof page.IsTruncated !== 'boolean') fail('Missing or invalid truncation flag; inventory completeness is unknown');
        continuation = undefined;
        if (page.IsTruncated) {
            const next = page.NextContinuationToken;
            if (typeof next !== 'string' || !next || tokens.has(next)) fail('Missing or repeated continuation token');
            tokens.add(next); continuation = next;
        }
    } while (continuation);
    state.entries += prefixes.size + objects.size;
    return { prefix, prefixes: [...prefixes].sort(), objects: [...objects].sort() };
}

async function scanPrefixes(snapshotInput, listPage, options = {}) {
    const snapshot = normalizeSnapshot(snapshotInput);
    const started = new Date();
    const age = started.getTime() - Date.parse(snapshot.captured_at);
    if (age < -300000 || age > 86400000) fail('Snapshot must be captured within the preceding 24 hours');
    const limits = { maxPages: options.maxPages ?? 10000, maxEntries: options.maxEntries ?? 1000000 };
    for (const value of Object.values(limits)) if (!Number.isSafeInteger(value) || value < 1) fail('Invalid inventory bound');
    const state = { calls: 0, entries: 0, duration_ms: 0, sdk_attempts: 0, sdk_retry_delay_ms: 0 };
    const levels = [];
    for (const prefix of SCOPES) levels.push(await collectLevel(listPage, snapshot.bucket, prefix, state, limits));
    const findings = [];
    for (const level of levels) {
        for (const prefix of level.prefixes) findings.push(classifyPrefix(prefix, snapshot));
        for (const objectKey of level.objects) findings.push({ prefix: objectKey, kind: 'unexpected_object', classification: 'unclassified' });
    }
    const present = new Set(levels[0].prefixes);
    const missing = snapshot.videos.filter(row => !present.has(`${row.hashed_video_id}/`)).map(row => ({
        video_id: row.video_id, course_id: row.course_id, prefix: `${row.hashed_video_id}/`, status: row.status,
    }));
    const summary = {};
    for (const finding of findings) {
        const label = `${finding.kind}:${finding.classification}`;
        summary[label] = (summary[label] || 0) + 1;
    }
    return {
        schema_version: 1, audit_kind: 'r2-prefix-ownership-readonly', status: 'snapshot_unconfirmed',
        bucket: snapshot.bucket, started_at: started.toISOString(), finished_at: new Date().toISOString(),
        snapshot_captured_at: snapshot.captured_at, snapshot_fingerprint: ownershipFingerprint(snapshot),
        snapshot_counts: Object.fromEntries(['courses', 'videos', 'materials', 'upload_sessions', 'pending_deletes'].map(name => [name, snapshot[name].length])),
        listing: { ...state, scopes: SCOPES, delimiter: '/', complete: true },
        summary, findings, database_videos_without_output_prefix: missing,
        limitations: [
            'Only prefixes and direct objects at the listed delimiter levels were enumerated; no media/object bodies were read.',
            'Orphan candidates are not deletion authorization. Unknown namespaces and pending cleanup overlap require review.',
            'A live course prefix does not prove every attachment/poster inside it has a live database row.',
            'A referenced video prefix does not prove all jobs, playlists or segments inside it are complete or referenced.',
            'A missing output prefix can be expected for queued, failed or unfinished videos.',
            'R2 pagination and database snapshots are not one atomic cross-system snapshot; matching before/after snapshots cannot exclude transient activity.',
        ],
    };
}

function finalizeReport(report, beforeInput, afterInput) {
    object(report, 'report');
    if (report.schema_version !== 1 || report.audit_kind !== 'r2-prefix-ownership-readonly' || report.listing?.complete !== true) fail('Report is not a complete prefix inventory');
    const before = normalizeSnapshot(beforeInput), after = normalizeSnapshot(afterInput);
    const start = Date.parse(timestamp(report.started_at, 'scan start'));
    const end = Date.parse(timestamp(report.finished_at, 'scan finish'));
    if (start > end || Date.parse(before.captured_at) > start + 5000 || Date.parse(after.captured_at) < end - 5000 || Date.parse(after.captured_at) < Date.parse(before.captured_at)) fail('Snapshots do not bracket the scan');
    if (report.bucket !== before.bucket || report.bucket !== after.bucket || report.snapshot_captured_at !== before.captured_at || report.snapshot_fingerprint !== ownershipFingerprint(before)) fail('Report does not match supplied before snapshot');
    const afterFingerprint = ownershipFingerprint(after);
    return {
        ...report,
        status: afterFingerprint === report.snapshot_fingerprint ? 'snapshot_stable' : 'snapshot_changed',
        verification: {
            verified_at: new Date().toISOString(), before_captured_at: before.captured_at,
            after_captured_at: after.captured_at, after_fingerprint: afterFingerprint,
            ownership_unchanged: afterFingerprint === report.snapshot_fingerprint,
            note: 'Changed ownership makes candidate conclusions stale; review or repeat the scan. Even stable snapshots are not deletion authorization.',
        },
    };
}

function readJson(filename) {
    const stat = fs.statSync(filename);
    if (!stat.isFile() || stat.size > 32 * 1024 * 1024) fail('JSON input must be a regular file no larger than 32 MiB');
    try { return JSON.parse(fs.readFileSync(filename, 'utf8')); } catch { fail('Invalid JSON input'); }
}

function readCredentials(filename) {
    let fd;
    try {
        fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || stat.size > 8192 || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) fail('Credentials require an owner-only regular file (mode 0600)');
        const values = {};
        for (const line of fs.readFileSync(fd, 'utf8').split(/\r?\n/)) {
            if (!line.trim() || line.trimStart().startsWith('#')) continue;
            const match = /^(R2_ACCESS_KEY_ID|R2_SECRET_ACCESS_KEY)=([^\r\n]*)$/.exec(line.trim());
            if (!match || Object.hasOwn(values, match[1])) fail('Invalid or duplicate credential field');
            let value = match[2].trim();
            if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
            if (!/^[A-Za-z0-9/+_=.-]{16,256}$/.test(value)) fail('Credential field is empty or malformed');
            values[match[1]] = value;
        }
        if (!values.R2_ACCESS_KEY_ID || !values.R2_SECRET_ACCESS_KEY) fail('Both read-only S3 credential fields are required');
        return { accessKeyId: values.R2_ACCESS_KEY_ID, secretAccessKey: values.R2_SECRET_ACCESS_KEY };
    } finally { if (fd !== undefined) fs.closeSync(fd); }
}

function validateEndpoint(value) {
    let url; try { url = new URL(value); } catch { fail('Invalid R2 endpoint'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.port || !['', '/'].includes(url.pathname) || url.search || url.hash || !/^[a-f0-9]{32}(?:\.(?:eu|fedramp))?\.r2\.cloudflarestorage\.com$/.test(url.hostname)) fail('Endpoint must be a Cloudflare R2 HTTPS account endpoint');
    return url.origin;
}

function markdown(report) {
    const lines = ['# Read-only R2 prefix ownership audit', '', `Status: **${report.status}**`, '',
        `Scan: ${report.started_at} → ${report.finished_at}`, '',
        `List API calls: ${report.listing.calls}; SDK attempts: ${report.listing.sdk_attempts}; reported SDK retry delay: ${report.listing.sdk_retry_delay_ms} ms.`, '',
        'No objects or database rows were written or deleted.', '', '| Category | Prefix count |', '|---|---:|'];
    for (const [name, count] of Object.entries(report.summary)) lines.push(`| ${name} | ${count} |`);
    lines.push('', '## Candidates requiring review', '');
    const candidates = report.findings.filter(row => row.classification === 'orphan_candidate');
    if (!candidates.length) lines.push('No unreferenced prefixes found within this scan scope. This is not a full per-object integrity proof.');
    for (const row of candidates) lines.push(`- ${row.kind}: \`${row.prefix}\``);
    lines.push('', '## Limits', '', ...report.limitations.map(value => `- ${value}`), '');
    return lines.join('\n');
}

function writeReport(filename, report) {
    const resolved = path.resolve(filename);
    if (!resolved.endsWith('.json')) fail('Output must be a new .json file');
    const md = resolved.slice(0, -5) + '.md';
    if (fs.existsSync(resolved) || fs.existsSync(md)) fail('Refusing to overwrite an existing report');
    fs.mkdirSync(path.dirname(resolved), { recursive: true, mode: 0o700 });
    fs.writeFileSync(resolved, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    fs.writeFileSync(md, markdown(report), { flag: 'wx', mode: 0o600 });
}

const HELP = `Read-only prefix audit. No delete/apply mode exists.

Scan:
  node scripts/r2-orphan-audit.js --snapshot before.json --credentials readonly.env --endpoint https://ACCOUNT.r2.cloudflarestorage.com --bucket BUCKET --output scan.json
Verify after collecting a second consistent DB snapshot (no R2 requests):
  node scripts/r2-orphan-audit.js --verify-report scan.json --snapshot before.json --snapshot-after after.json --output final.json

Snapshot JSON schema_version=1, complete=true, bucket, captured_at (ISO with timezone), and ALL rows from these tables in one READ ONLY consistent transaction:
  courses: {course_id}
  videos: {video_id, course_id, hashed_video_id, r2_source_key, status}
  materials: {material_id, course_id, object_key}
  upload_sessions: {upload_id, course_id, video_id?, object_key, type, status}
  pending_deletes: {id, mode, target, execute_at (ISO with timezone)}
Include inactive courses and every remaining video; do not filter by successful status. Do not include user data or credential fields.
The owner-only credential file contains R2_ACCESS_KEY_ID=... and R2_SECRET_ACCESS_KEY=... . Values are parsed as data, never shell code.
Only ListObjectsV2 with Delimiter '/' is used, serially, at root/source/attachments/posters levels. Prefix ownership is not per-object verification. Snapshot freshness is limited to24h; before/after agreement does not prove absence of transient activity.
`;

async function main(argv) {
    if (argv.length === 1 && argv[0] === '--help') { console.log(HELP); return; }
    const allowed = new Set(['--snapshot', '--snapshot-after', '--credentials', '--endpoint', '--bucket', '--output', '--verify-report']);
    const opts = {};
    for (let i = 0; i < argv.length; i += 2) {
        if (!allowed.has(argv[i]) || !argv[i + 1] || argv[i + 1].startsWith('--') || opts[argv[i]]) fail('Invalid arguments; see --help');
        opts[argv[i]] = argv[i + 1];
    }
    if (!opts['--snapshot'] || !opts['--output']) fail('Snapshot and new output paths are required');
    const snapshot = normalizeSnapshot(readJson(opts['--snapshot']));
    let report;
    if (opts['--verify-report']) {
        if (!opts['--snapshot-after'] || opts['--credentials'] || opts['--endpoint'] || opts['--bucket']) fail('Verification requires only report, before/after snapshots and output paths');
        report = finalizeReport(readJson(opts['--verify-report']), snapshot, readJson(opts['--snapshot-after']));
    } else {
        if (!opts['--credentials'] || !opts['--endpoint'] || !opts['--bucket'] || opts['--snapshot-after']) fail('Scan requires explicit credentials, endpoint and bucket');
        if (opts['--bucket'] !== snapshot.bucket) fail('Bucket does not match snapshot');
        const endpoint = validateEndpoint(opts['--endpoint']);
        const credentials = readCredentials(opts['--credentials']);
        const { S3Client, ListObjectsV2Command } = require('@aws-sdk/client-s3');
        const client = new S3Client({ region: 'auto', endpoint, credentials, maxAttempts: 3, retryMode: 'standard', requestChecksumCalculation: 'WHEN_REQUIRED',
            requestHandler: { connectionTimeout: 5000, requestTimeout: 30000, socketTimeout: 30000, throwOnRequestTimeout: true },
        });
        try { report = await scanPrefixes(snapshot, input => client.send(new ListObjectsV2Command(input))); }
        finally { client.destroy(); }
    }
    writeReport(opts['--output'], report);
    console.log(JSON.stringify({ status: report.status, listing_calls: report.listing.calls, summary: report.summary, missing_output_prefixes: report.database_videos_without_output_prefix.length }));
}

if (require.main === module) main(process.argv.slice(2)).catch(error => {
    // SDK messages may include endpoints or signed request details. Print only
    // our fixed validation messages or a bounded service code/status.
    console.error(JSON.stringify({ error: error instanceof AuditError ? error.message : 'Audit failed; no complete report produced',
        ...(error instanceof AuditError ? {} : { code: /^[A-Za-z0-9_]{1,64}$/.test(error.code || error.name) ? error.code || error.name : 'AuditError', status: error.$metadata?.httpStatusCode ?? null }) }));
    process.exitCode = 1;
});

module.exports = { normalizeSnapshot, ownershipFingerprint, classifyPrefix, scanPrefixes, finalizeReport, readCredentials, validateEndpoint, writeReport, markdown };
