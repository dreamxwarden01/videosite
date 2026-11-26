'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const requestLog = require('../lib/r2RequestLog');

const plain = value => JSON.parse(JSON.stringify(value));
const row = (id = 1, mode = 'key', target = 'synthetic/item') => ({ id, mode, target });
const sdkError = (code, status) => Object.assign(new Error('synthetic provider failure'), {
    name: code, $metadata: { httpStatusCode: status },
});

function fixture(options = {}) {
    const rows = (options.rows || [row()]).map(item => ({ ...item, due: true }));
    const requests = [], sqlWrites = [], sleeps = [], events = [], timeline = [];
    let gets = 0, selects = 0, deletes = 0;
    const backgroundTasks = { stopping: false, run: fn => Promise.resolve().then(fn), interval() { return { unref() {} }; } };
    const pool = {
        async execute(sql, values = []) {
            if (/^\s*SELECT id, mode, target/.test(sql)) {
                selects++;
                return [rows.filter(item => item.due).slice(0, 1)];
            }
            sqlWrites.push({ sql, values: plain(values) });
            timeline.push({ type: 'sql', sql, values: plain(values) });
            if (/^DELETE FROM pending_deletes/.test(sql)) {
                deletes++;
                if (options.onDelete) await options.onDelete({ deletes, rows });
                const index = rows.findIndex(item => item.id === values[0]);
                if (index >= 0) rows.splice(index, 1);
            } else if (/^\s*UPDATE pending_deletes/.test(sql)) {
                if (options.onUpdate) await options.onUpdate({ rows });
                const item = rows.find(item => item.id === values.at(-1));
                if (item) {
                    item.due = false;
                    item.attempts = (item.attempts || 0) + values[0];
                    item.last_error = values[1];
                    item.delay_seconds = values[2];
                }
            }
            return [{ affectedRows: 1 }];
        },
    };
    class ListObjectsV2Command { constructor(input) { this.input = input; } }
    class DeleteObjectsCommand { constructor(input) { this.input = input; } }
    class DeleteObjectCommand { constructor(input) { this.input = input; } }
    const client = {
        async send(command) {
            const request = { operation: command.constructor.name, input: plain(command.input) };
            requests.push(request); timeline.push({ type: 'r2', ...request });
            if (options.send) return options.send(command, { requests, rows, backgroundTasks, timeline });
            if (command instanceof ListObjectsV2Command) return { Contents: [], IsTruncated: false };
            return {};
        },
    };
    const module = { exports: {} };
    const filename = path.join(__dirname, '../services/deletionService.js');
    const deps = {
        '../lib/backgroundTasks': backgroundTasks,
        '@aws-sdk/client-s3': { ListObjectsV2Command, DeleteObjectCommand, DeleteObjectsCommand },
        '../config/database': { getPool() { gets++; if (options.forbidPool) throw new Error('global pool forbidden'); return pool; } },
        '../config/r2': { getR2Client: () => client, getR2BucketName: () => 'synthetic-bucket' },
        '../lib/r2RequestLog': { ...requestLog, sendR2Request: (r2, command) => r2.send(command), emit: value => events.push(plain(value)) },
    };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
        module, exports: module.exports, Date,
        process: { env: {} },
        console: { log() {}, error() {}, warn() {} },
        require(name) {
            if (Object.hasOwn(deps, name)) return deps[name];
            throw new Error(`Unstubbed dependency: ${name}`);
        },
        setTimeout(callback, delay) { sleeps.push(delay); queueMicrotask(callback); return { unref() {} }; },
        clearInterval() {},
    }, { filename });
    return { service: module.exports, rows, requests, sqlWrites, sleeps, events, timeline, backgroundTasks,
        counts: () => ({ gets, selects, deletes }) };
}

test('429 keeps the durable key row after bounded retries and defers its next turn', async () => {
    const f = fixture({ send: async () => { throw sdkError('TooManyRequests', 429); } });
    await f.service.runReaper();
    assert.equal(f.requests.length, 5);
    assert.equal(f.counts().deletes, 0);
    assert.equal(f.rows.length, 1);
    assert.equal(f.rows[0].attempts, 5);
    assert.equal(f.rows[0].delay_seconds, 60);
    assert.equal(JSON.parse(f.rows[0].last_error).status, 429);
    assert.deepEqual(f.sleeps, [1000, 1000, 1000, 2000]);
    await f.service.runReaper();
    assert.equal(f.requests.length, 5, 'deferred row must not run before due again');
});

test('403 is retained after one failed attempt, with no immediate retry loop', async () => {
    const f = fixture({ send: async () => { throw sdkError('AccessDenied', 403); } });
    await f.service.runReaper();
    assert.equal(f.requests.length, 1);
    assert.equal(f.counts().deletes, 0);
    assert.equal(f.rows[0].attempts, 1);
    assert.equal(f.rows[0].delay_seconds, 300);
    assert.deepEqual(f.sleeps, []);
});

test('a deferred permanent failure does not prevent a later turn processing other due rows', async () => {
    const f = fixture({ rows: [row(1), row(2, 'key', 'synthetic/other')], send: async command => {
        if (command.input.Key === 'synthetic/item') throw sdkError('AccessDenied', 403);
        return {};
    } });
    await f.service.runReaper();
    assert.equal(f.rows.length, 2);
    await f.service.runReaper();
    assert.deepEqual(f.rows.map(item => item.id), [1]);
    assert.equal(f.counts().deletes, 1);
});

test('only explicit NoSuchKey is accepted as an absent single object', async t => {
    for (const [code, removed] of [['NoSuchKey', true], ['NotFound', false], ['NoSuchBucket', false]]) {
        await t.test(code, async () => {
            const f = fixture({ send: async () => { throw sdkError(code, 404); } });
            await f.service.runReaper();
            assert.equal(f.rows.length, removed ? 0 : 1);
            assert.equal(f.requests.length, 1);
        });
    }
});

test('HTTP 200 batch errors cause a re-list of survivors, not early queue completion', async () => {
    const surviving = new Set(['synthetic/a', 'synthetic/b']);
    let batches = 0;
    const f = fixture({ rows: [row(1, 'prefix', 'synthetic/')], send: async command => {
        if (command.constructor.name === 'ListObjectsV2Command') {
            return { Contents: [...surviving].map(Key => ({ Key })), IsTruncated: false };
        }
        batches++;
        if (batches === 1) {
            surviving.delete('synthetic/a');
            return { $metadata: { httpStatusCode: 200 }, Errors: [{ Key: 'synthetic/b', Code: 'SlowDown' }] };
        }
        for (const item of command.input.Delete.Objects) surviving.delete(item.Key);
        return {};
    } });
    await f.service.runReaper();
    const batchKeys = f.requests.filter(item => item.operation === 'DeleteObjectsCommand').map(item => item.input.Delete.Objects.map(v => v.Key));
    assert.deepEqual(batchKeys, [['synthetic/a', 'synthetic/b'], ['synthetic/b']]);
    assert.equal(f.rows.length, 0);
    assert.equal(f.counts().deletes, 1);
    assert.ok(f.requests.some(item => item.input.MaxKeys === 1), 'completion confirms an empty prefix');
    assert.equal(f.timeline.at(-1).type, 'sql');
});

test('permanent batch errors retain the prefix row and preserve object error diagnostics', async () => {
    const f = fixture({ rows: [row(1, 'prefix', 'synthetic/')], send: async command => {
        if (command.constructor.name === 'ListObjectsV2Command') return { Contents: [{ Key: 'synthetic/a' }], IsTruncated: false };
        return { $metadata: { httpStatusCode: 200 }, Errors: [{ Key: 'synthetic/a', Code: 'AccessDenied' }] };
    } });
    await f.service.runReaper();
    assert.equal(f.rows.length, 1);
    assert.equal(f.rows[0].attempts, 1);
    assert.equal(f.counts().deletes, 0);
    assert.equal(f.requests.length, 2);
    const error = JSON.parse(f.rows[0].last_error);
    assert.equal(error.object_errors, 1);
    assert.equal(error.error_codes.AccessDenied, 1);
});

test('NoSuchKey-only batch errors are idempotent success after empty-prefix confirmation', async () => {
    let listed = false;
    const f = fixture({ rows: [row(1, 'prefix', 'synthetic/')], send: async command => {
        if (command.constructor.name === 'ListObjectsV2Command') {
            if (listed) return { Contents: [], IsTruncated: false };
            listed = true;
            return { Contents: [{ Key: 'synthetic/gone' }], IsTruncated: false };
        }
        return { Errors: [{ Key: 'synthetic/gone', Code: 'NoSuchKey' }] };
    } });
    await f.service.runReaper();
    assert.equal(f.rows.length, 0);
    assert.deepEqual(f.sleeps, []);
});

test('a second-page failure never removes a prefix row after the first page succeeded', async () => {
    const f = fixture({ rows: [row(1, 'prefix', 'synthetic/')], send: async command => {
        if (command.constructor.name === 'ListObjectsV2Command') {
            return command.input.ContinuationToken
                ? { Contents: [{ Key: 'synthetic/b' }], IsTruncated: false }
                : { Contents: [{ Key: 'synthetic/a' }], IsTruncated: true, NextContinuationToken: 'next-page' };
        }
        return command.input.Delete.Objects[0].Key === 'synthetic/a' ? {}
            : { Errors: [{ Key: 'synthetic/b', Code: 'AccessDenied' }] };
    } });
    await f.service.runReaper();
    assert.equal(f.counts().deletes, 0);
    assert.equal(f.rows.length, 1);
    assert.equal(f.requests.length, 4);
});

test('missing or repeated pagination tokens fail closed and retain the prefix intent', async t => {
    for (const repeated of [false, true]) {
        await t.test(repeated ? 'repeated token' : 'missing token', async () => {
            const f = fixture({ rows: [row(1, 'prefix', 'synthetic/')], send: async command => {
                assert.equal(command.constructor.name, 'ListObjectsV2Command');
                return { Contents: [], IsTruncated: true, ...(repeated ? { NextContinuationToken: 'same-token' } : {}) };
            } });
            await f.service.runReaper();
            assert.equal(f.counts().deletes, 0);
            assert.equal(f.rows.length, 1);
            assert.ok(f.requests.length <= 10, 'malformed pagination must not loop forever');
        });
    }
});

test('a nonempty final probe triggers another sweep and completes only after a later empty probe', async () => {
    let probes = 0;
    const remaining = new Set(['synthetic/first']);
    const f = fixture({ rows: [row(1, 'prefix', 'synthetic/')], send: async command => {
        if (command.constructor.name === 'ListObjectsV2Command') {
            if (command.input.MaxKeys === 1 && probes++ === 0) remaining.add('synthetic/late');
            return { Contents: [...remaining].map(Key => ({ Key })), IsTruncated: false };
        }
        for (const item of command.input.Delete.Objects) remaining.delete(item.Key);
        return {};
    } });
    await f.service.runReaper();
    assert.equal(probes, 2);
    assert.equal(f.rows.length, 0);
    assert.deepEqual(f.requests.filter(item => item.operation === 'DeleteObjectsCommand').map(item => item.input.Delete.Objects.map(v => v.Key)),
        [['synthetic/first'], ['synthetic/late']]);
});

test('persistently nonempty final probes have bounded retries and retain the prefix row', async () => {
    const f = fixture({ rows: [row(1, 'prefix', 'synthetic/')], send: async command => {
        if (command.constructor.name === 'ListObjectsV2Command') return { Contents: [{ Key: 'synthetic/late' }], IsTruncated: false };
        return {};
    } });
    await f.service.runReaper();
    assert.equal(f.rows.length, 1);
    assert.equal(f.counts().deletes, 0);
    assert.equal(f.rows[0].attempts, 5);
    assert.equal(f.requests.filter(item => item.input.MaxKeys === 1).length, 5);
});

test('database acknowledgement failure retains the row without replaying an already successful R2 request', async () => {
    const f = fixture({ onDelete: async () => { throw Object.assign(new Error('synthetic DB outage'), { code: 'ECONNRESET' }); } });
    await f.service.runReaper();
    assert.equal(f.requests.length, 1);
    assert.equal(f.counts().deletes, 1);
    assert.equal(f.rows.length, 1);
    assert.equal(f.rows[0].attempts, 1);
    assert.equal(f.rows[0].delay_seconds, 60);
    assert.deepEqual(f.sleeps, []);
    assert.equal(f.events.find(event => event.event === 'row_failed').phase, 'db_ack');
    assert.equal(JSON.parse(f.rows[0].last_error).phase, 'db_ack');
    assert.ok(!f.events.some(event => event.event === 'row_complete'));
    await f.service.runReaper();
    assert.equal(f.requests.length, 1, 'failed acknowledgement defers the durable row instead of retrying R2 immediately');
});

test('failed database acknowledgement and failed diagnostic persistence still do not replay R2', async () => {
    const fail = async () => { throw Object.assign(new Error('synthetic DB outage'), { code: 'ECONNRESET' }); };
    const f = fixture({ onDelete: fail, onUpdate: fail });
    await f.service.runReaper();
    assert.equal(f.requests.length, 1);
    assert.equal(f.counts().deletes, 1);
    assert.equal(f.rows.length, 1);
    assert.equal(f.counts().selects, 1, 'the same failed turn must not immediately select the unacknowledged row again');
    assert.deepEqual(f.sleeps, []);
    assert.ok(!f.events.some(event => event.event === 'row_complete'));
});

test('transactional enqueue helpers use the supplied connection without touching the global pool', async () => {
    const f = fixture({ forbidPool: true });
    const inserts = [];
    const connection = { async execute(sql, values) { inserts.push({ sql, values: plain(values) }); return [{ affectedRows: 1 }]; } };
    const executeAt = new Date('2030-01-01T00:00:00Z');
    await f.service.enqueueKey('synthetic/object', { connection, execute_at: executeAt, source: 'course_delete' });
    await f.service.enqueuePrefix('synthetic/', { connection, execute_at: executeAt, source: 'course_delete', hashed_video_id: 'synthetic' });
    assert.equal(f.counts().gets, 0);
    assert.equal(inserts.length, 2);
    assert.equal(inserts[0].values[0], 'synthetic/object');
    assert.equal(inserts[1].values[0], 'synthetic/');
    assert.ok(inserts.every(item => item.sql.includes('INSERT INTO pending_deletes')));
    assert.ok(inserts.every(item => item.sql.includes('FROM_UNIXTIME(?)')));
    assert.equal(inserts[0].values[1], executeAt.getTime() / 1000);
    assert.equal(inserts[1].values[2], executeAt.getTime() / 1000);
});

test('default enqueue timestamps are finite Unix seconds rather than timezone-sensitive Date parameters', async () => {
    const f = fixture({ forbidPool: true });
    const inserts = [];
    const connection = { async execute(sql, values) { inserts.push({ sql, values: plain(values) }); return [{ affectedRows: 1 }]; } };
    const before = Date.now() / 1000;
    await f.service.enqueueKey('synthetic/object', { connection });
    await f.service.enqueuePrefix('synthetic/', { connection });
    const after = Date.now() / 1000;
    for (const [item, index] of [[inserts[0], 1], [inserts[1], 2]]) {
        assert.ok(item.sql.includes('FROM_UNIXTIME(?)'));
        assert.equal(typeof item.values[index], 'number');
        assert.ok(Number.isFinite(item.values[index]));
        assert.ok(item.values[index] >= before && item.values[index] <= after);
    }
});
