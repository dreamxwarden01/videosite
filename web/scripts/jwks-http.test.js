'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const { publicJwksRouter } = require('../routes/publicJwks');

async function fixture(readKeys, use) {
    const app = express();
    app.disable('etag');
    app.use(publicJwksRouter(readKeys));
    // Matches server ordering: parsing and installation/session processing come later.
    app.use(express.json({ limit: '1kb' }));
    let gated = 0;
    app.use((_req, res) => { gated++;res.status(503).end(); });
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve, reject) => { server.once('listening', resolve);server.once('error', reject); });
    const request = (method = 'GET', path = '/.well-known/jwks.json', body = undefined) => new Promise((resolve, reject) => {
        const headers = body === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) };
        const req = http.request({ host: '127.0.0.1', port: server.address().port, method, path, headers }, res => {
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));res.on('error', reject);
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
        });
        req.on('error', reject);req.end(body);
    });
    try { await use(request, () => gated); }
    finally { server.closeAllConnections();await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
}

test('GET publishes the current public key set with exactly two minutes of caching', async () => {
    const previous = { kty: 'OKP', crv: 'Ed25519', kid: 'previous-public-fixture', x: 'previous', use: 'sig', alg: 'EdDSA' };
    const current = { ...previous, kid: 'current-public-fixture', x: 'current' };
    let reads = 0, keys = { keys: [current, previous] };
    await fixture(async () => { reads++;await Promise.resolve();return keys; }, async (request, gated) => {
        const response = await request();
        assert.equal(response.status, 200);assert.equal(response.headers['cache-control'], 'public, max-age=120, must-revalidate');
        assert.match(response.headers['content-type'], /^application\/json/);assert.equal(response.headers['set-cookie'], undefined);
        assert.deepEqual(JSON.parse(response.body), keys);assert.equal(gated(), 0);
        // The endpoint does not keep another in-process key cache or alter overlap.
        keys = { keys: [current] };
        const next = await request('GET', '/.WELL-KNOWN/JWKS.JSON/');
        assert.equal(next.status, 200);assert.deepEqual(JSON.parse(next.body), keys);assert.equal(reads, 2);
    });
});

test('HEAD and other non-GET methods are explicit405 without key reads or body parsing', async () => {
    let reads = 0;
    await fixture(() => { reads++;throw Error('must not read keys'); }, async (request, gated) => {
        for (const method of ['HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'TRACE']) {
            for (const path of ['/.well-known/jwks.json', '/.WELL-KNOWN/JWKS.JSON/']) {
                const response = await request(method, path, method === 'HEAD' ? undefined : '{ malformed ' + 'x'.repeat(2048));
                assert.equal(response.status, 405);assert.equal(response.headers.allow, 'GET');
                assert.equal(response.headers['cache-control'], 'no-store');assert.equal(response.headers['set-cookie'], undefined);
                if (method === 'HEAD') assert.equal(response.body, '');
                else assert.deepEqual(JSON.parse(response.body), { error: 'method_not_allowed' });
            }
        }
        assert.equal(reads, 0);assert.equal(gated(), 0);
    });
});

test('missing public keys remain an uncached error and do not prevent later success', async () => {
    let fail = true;
    await fixture(async () => { await Promise.resolve();if (fail) throw Error('synthetic private detail');return { keys: [] }; }, async request => {
        const unavailable = await request();
        assert.equal(unavailable.status, 500);assert.equal(unavailable.headers['cache-control'], 'no-store');
        assert.deepEqual(JSON.parse(unavailable.body), { error: 'keys_unavailable' });assert.ok(!unavailable.body.includes('synthetic private detail'));
        fail = false;
        const available = await request();assert.equal(available.status, 200);assert.equal(available.headers['cache-control'], 'public, max-age=120, must-revalidate');
    });
});
