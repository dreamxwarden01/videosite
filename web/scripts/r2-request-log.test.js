'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { S3Client, DeleteObjectsCommand, ListObjectsV2Command } = require('@aws-sdk/client-s3');
const { ConfiguredRetryStrategy } = require('@smithy/util-retry');
const { HttpResponse } = require('@smithy/protocol-http');
const { sendR2Request } = require('../lib/r2RequestLog');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const bucket = 'private-bucket-canary';
const key = 'private/path/email@example.test-secret-canary';
function fixture(handle, logger) {
    const records = [], requests = [];
    const client = new S3Client({ region: 'auto', endpoint: 'https://synthetic.example.invalid',
        credentials: { accessKeyId: 'ACCESS_KEY_CANARY', secretAccessKey: 'SECRET_KEY_CANARY' },
        retryStrategy: new ConfiguredRetryStrategy(3, 0), requestChecksumCalculation: 'WHEN_REQUIRED',
        requestHandler: { async handle(request) { requests.push(request); return handle(request, requests.length); }, destroy() {} } });
    return { client, records, requests, logger: logger || { log: line => records.push(JSON.parse(line)) } };
}
function response(statusCode, body, id = 'synthetic-request-id') {
    return { response: new HttpResponse({ statusCode, headers: { 'content-type': 'application/xml', 'x-amz-request-id': id }, body: Readable.from([Buffer.from(body)]) }) };
}

test('real SDK retries are logged individually, including HTTP200 per-key errors', async () => {
    const f = fixture((_request, n) => n === 1
        ? response(429, '<Error><Code>SlowDown</Code><Message>private/path must not be logged</Message></Error>', 'attempt-one')
        : response(200, `<DeleteResult><Error><Key>${key}</Key><Code>AccessDenied</Code><Message>private details</Message></Error></DeleteResult>`, 'attempt-two'));
    const result = await sendR2Request(f.client, new DeleteObjectsCommand({ Bucket: bucket, Delete: { Quiet: true, Objects: [{ Key: key }] } }), { row_id: 17, row_attempt: 2 }, f.logger);
    assert.equal(result.Errors.length, 1);
    assert.equal(f.requests.length, 2);
    assert.deepEqual(f.records.map(r => r.event), ['request_start', 'request_error', 'sdk_retry_start', 'request_result', 'call_complete']);
    assert.equal(f.records[1].status, 429);
    assert.equal(f.records[1].error_code, 'SlowDown');
    assert.equal(f.records[1].r2_request_id, 'attempt-one');
    assert.equal(f.records[2].attempt, 2);
    assert.ok(f.records[2].wait_since_previous_attempt_ms >= 0);
    const done = f.records.at(-1);
    assert.equal(done.outcome, 'object_errors');
    assert.equal(done.attempts, 2);
    assert.equal(done.object_errors, 1);
    assert.equal(done.error_codes.AccessDenied, 1);
    assert.equal(done.key_count, 1);
    assert.equal(done.row_id, '17');
    assert.equal(done.row_attempt, 2);
    assert.equal(new Set(f.records.map(r => r.call_id)).size, 1);
    assert.equal(new Set(f.records.map(r => r.batch_hash)).size, 1);
    const text = JSON.stringify(f.records);
    for (const secret of [bucket, key, 'SECRET_KEY_CANARY', 'ACCESS_KEY_CANARY', 'synthetic.example.invalid', 'private details', 'Authorization']) assert.equal(text.includes(secret), false, secret);
    f.client.destroy();
});

test('permission rejection is logged once and original SDK error is preserved', async () => {
    const f = fixture(() => response(403, '<Error><Code>AccessDenied</Code><Message>do-not-log-this</Message></Error>'));
    await assert.rejects(sendR2Request(f.client, new ListObjectsV2Command({ Bucket: bucket, Prefix: key }), {}, f.logger), e => e.name === 'AccessDenied' && e.$metadata.httpStatusCode === 403);
    assert.equal(f.requests.length, 1);
    assert.equal(f.records.at(-1).outcome, 'failed');
    assert.equal(f.records.at(-1).attempts, 1);
    assert.equal(f.records.at(-1).prefix_hash.length, 20);
    assert.equal(JSON.stringify(f.records).includes('do-not-log-this'), false);
    f.client.destroy();
});

test('network failures expose retry count, not raw error payload or request headers', async () => {
    const f = fixture(() => { throw Object.assign(new Error(`request ${key} SECRET_KEY_CANARY`), { code: 'ECONNRESET' }); });
    await assert.rejects(sendR2Request(f.client, new ListObjectsV2Command({ Bucket: bucket }), {}, f.logger), e => e.code === 'ECONNRESET');
    assert.equal(f.requests.length, 3);
    assert.equal(f.records.filter(r => r.event === 'sdk_retry_start').length, 2);
    assert.equal(f.records.at(-1).attempts, 3);
    assert.equal(f.records.at(-1).error_code, 'ECONNRESET');
    assert.equal(JSON.stringify(f.records).includes('SECRET_KEY_CANARY'), false);
    f.client.destroy();
});

test('logging failures cannot turn a successful request into an SDK retry', async () => {
    const f = fixture(() => response(200, '<ListBucketResult><KeyCount>0</KeyCount><IsTruncated>false</IsTruncated></ListBucketResult>'), { log() { throw new Error('logger down'); } });
    const result = await sendR2Request(f.client, new ListObjectsV2Command({ Bucket: bucket }), {}, f.logger);
    assert.equal(result.KeyCount, 0);
    assert.equal(f.requests.length, 1);
    f.client.destroy();
});

test('reaper integrates real SDK parsing and telemetry without acknowledging partial failure', async () => {
    const f = fixture(request => request.method === 'GET'
        ? response(200, `<ListBucketResult><IsTruncated>false</IsTruncated><KeyCount>1</KeyCount><Contents><Key>${key}</Key></Contents></ListBucketResult>`)
        : response(200, `<DeleteResult><Error><Key>${key}</Key><Code>AccessDenied</Code></Error></DeleteResult>`));
    const sqlCalls = [];
    const pool = { async execute(sql, args) {
        sqlCalls.push({ sql, args });
        if (sql.startsWith('SELECT id')) return [[{ id: 19, mode: 'prefix', target: 'private/' }]];
        if (sql.includes('UPDATE pending_deletes')) return [{ affectedRows: 1 }];
        throw new Error('Unexpected queue settlement: ' + sql);
    } };
    const logs = require('../lib/r2RequestLog');
    const deps = {
        '../lib/backgroundTasks': { stopping: false, run: fn => fn() },
        '../config/database': { getPool: () => pool },
        '../config/r2': { getR2Client: () => f.client, getR2BucketName: () => bucket },
        '@aws-sdk/client-s3': require('@aws-sdk/client-s3'),
        '../lib/r2RequestLog': { ...logs, sendR2Request: (client, command, context) => sendR2Request(client, command, context, f.logger), emit: record => logs.emit(record, f.logger) },
    };
    const module = { exports: {} };
    const filename = path.join(__dirname, '../services/deletionService.js');
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module, exports: module.exports, process: { env: {} }, Date, setTimeout, clearInterval,
        require: name => { assert.ok(Object.hasOwn(deps, name)); return deps[name]; } }, { filename });
    await module.exports.runReaper();
    assert.equal(f.requests.length, 2);
    assert.equal(sqlCalls.filter(x => x.sql.startsWith('DELETE FROM pending_deletes')).length, 0);
    assert.equal(sqlCalls.at(-1).args[0], 1);
    assert.equal(JSON.parse(sqlCalls.at(-1).args[1]).phase, 'r2');
    assert.equal(f.records.find(x => x.event === 'call_complete' && x.operation === 'DeleteObjects').error_codes.AccessDenied, 1);
    assert.equal(f.records.at(-1).event, 'row_failed');
    assert.equal(f.records.at(-1).object_errors, 1);
    assert.equal(JSON.stringify(f.records).includes(key), false);
    f.client.destroy();
});
