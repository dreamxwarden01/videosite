#!/usr/bin/env node
/**
 * Tiny structural validator for web/api-schema.json.
 *
 * Run with: `npm run check:schema` (from web/) or directly:
 *   node web/scripts/check-api-schema.js
 *
 * Catches the things CF API Shield will reject AT UPLOAD TIME but won't
 * tell you about until you click the button:
 *   - JSON parse errors
 *   - missing top-level openapi / info / paths / servers
 *   - operations without operationId, or duplicate operationIds
 *   - path templates whose parameters aren't declared
 *   - schema size over 5 MB (free plan ceiling)
 *
 * Does NOT enforce request bodies on POST/PUT — many endpoints (toggles,
 * key generators, terminate-all) are legitimately bodyless. Does NOT
 * cross-check the schema against actual Express routers; drift between
 * schema and code is caught by updating both in the same commit.
 */

const fs = require('fs');
const path = require('path');

const SCHEMA_PATH = path.join(__dirname, '..', 'api-schema.json');
const MAX_SIZE_BYTES = 5 * 1024 * 1024;

const errors = [];
const fail = (msg) => errors.push(msg);

let raw, schema;
try {
    raw = fs.readFileSync(SCHEMA_PATH, 'utf8');
} catch (err) {
    console.error(`Cannot read ${SCHEMA_PATH}: ${err.message}`);
    process.exit(1);
}

try {
    schema = JSON.parse(raw);
} catch (err) {
    console.error(`Invalid JSON in api-schema.json: ${err.message}`);
    process.exit(1);
}

if (Buffer.byteLength(raw) > MAX_SIZE_BYTES) {
    fail(`Schema is ${Buffer.byteLength(raw)} bytes — over Cloudflare API Shield's 5 MB limit on the free plan.`);
}

if (!schema.openapi || !schema.openapi.startsWith('3.0')) {
    fail(`Top-level openapi must start with "3.0" (CF API Shield doesn't support 3.1). Got: ${schema.openapi}`);
}
if (!schema.info || !schema.info.title || !schema.info.version) {
    fail(`Top-level info.title and info.version are required.`);
}
if (!schema.paths || typeof schema.paths !== 'object') {
    fail(`Top-level paths must be an object.`);
}
if (!Array.isArray(schema.servers) || schema.servers.length === 0) {
    fail(`Top-level servers must contain at least one entry.`);
}

const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options']);
const seenOpIds = new Map(); // operationId → "METHOD path"
let opCount = 0;

for (const [pathStr, pathItem] of Object.entries(schema.paths || {})) {
    if (!pathStr.startsWith('/')) {
        fail(`Path "${pathStr}" must start with /.`);
    }

    // Collect path-level + operation-level params for the templated-vars check
    const pathLevelParams = new Set();
    if (Array.isArray(pathItem.parameters)) {
        for (const p of pathItem.parameters) {
            if (p.in === 'path' && p.name) pathLevelParams.add(p.name);
        }
    }

    // Templated params declared in the path string (e.g. /users/{id})
    const templated = [...pathStr.matchAll(/\{([^}]+)\}/g)].map(m => m[1]);

    for (const [method, op] of Object.entries(pathItem)) {
        if (method === 'parameters' || method === 'summary' || method === 'description') continue;
        if (!HTTP_METHODS.has(method)) {
            fail(`${pathStr}: unrecognised method "${method}".`);
            continue;
        }
        opCount++;

        if (!op.operationId) {
            fail(`${method.toUpperCase()} ${pathStr}: missing operationId.`);
        } else if (seenOpIds.has(op.operationId)) {
            fail(`Duplicate operationId "${op.operationId}" — used by both ${seenOpIds.get(op.operationId)} and ${method.toUpperCase()} ${pathStr}.`);
        } else {
            seenOpIds.set(op.operationId, `${method.toUpperCase()} ${pathStr}`);
        }

        // Every templated param has to be declared somewhere (path-level or op-level)
        const opParams = new Set(pathLevelParams);
        if (Array.isArray(op.parameters)) {
            for (const p of op.parameters) {
                if (p.in === 'path' && p.name) opParams.add(p.name);
            }
        }
        for (const t of templated) {
            if (!opParams.has(t)) {
                fail(`${method.toUpperCase()} ${pathStr}: path template "{${t}}" has no matching parameter declaration.`);
            }
        }

    }
}

if (opCount === 0) {
    fail('No operations found — schema appears empty.');
}

if (errors.length > 0) {
    console.error(`api-schema.json: ${errors.length} issue${errors.length === 1 ? '' : 's'}\n`);
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
}

console.log(`api-schema.json OK — ${opCount} operations, ${Buffer.byteLength(raw)} bytes`);
