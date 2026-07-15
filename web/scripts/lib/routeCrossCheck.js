// Cross-check api-schema.json against the ACTUAL Express routes, so the schema can't
// silently drift from the code the way it did before (it kept describing removed
// identity routes for weeks). Used by scripts/check-api-schema.js.
//
// Scope: the schema is the /api/* surface + the first-run installer (see the schema's
// own `info.description`). It deliberately EXCLUDES the OIDC browser routes (/auth/*),
// the SSO event receiver (/backchannel/events — covered by docs/security/openapi-
// videosite-s2s.yaml), and static assets. So we only compare routes under those in-scope
// prefixes.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');

// file -> mount prefix (matches server.js app.use(...) wiring)
const MOUNTS = [
  { file: 'routes/api/app.js', prefix: '/api' },
  { file: 'routes/api/pages.js', prefix: '/api' },
  { file: 'routes/api/admin.js', prefix: '/api' },
  { file: 'routes/api/upload.js', prefix: '/api' },
  { file: 'routes/api/videos.js', prefix: '/api' },
  { file: 'routes/api/worker.js', prefix: '/api' },
  { file: 'routes/api/mfa-admin.js', prefix: '/api' },
  { file: 'routes/api/materials.js', prefix: '/api' },
  { file: 'routes/api/sso.js', prefix: '/api' },
  { file: 'routes/install.js', prefix: '' }, // paths written full (/api/install/*, /install)
];

const ROUTE_RE = /\brouter\s*\.\s*(get|post|put|delete|patch)\s*\(\s*['"]([^'"]+)['"]/g;

// :param -> {param}; collapse a trailing wildcard the same way OpenAPI would template it
const toTemplate = (p) => p.replace(/:([A-Za-z0-9_]+)\??/g, '{$1}');

/** Every (METHOD, path) the in-scope route files define. */
function routesFromCode() {
  const out = new Set();
  for (const { file, prefix } of MOUNTS) {
    const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
    let m;
    while ((m = ROUTE_RE.exec(src)) !== null) {
      const method = m[1].toUpperCase();
      let full = prefix + m[2];
      full = toTemplate(full).replace(/\/+/g, '/');
      out.add(`${method} ${full}`);
    }
  }
  return out;
}

/** Every (METHOD, path) the schema declares, restricted to the in-scope prefixes. */
function routesFromSchema(schema) {
  const out = new Set();
  for (const [p, ops] of Object.entries(schema.paths || {})) {
    if (!(p === '/install' || p.startsWith('/api/'))) continue; // ignore anything out of scope
    for (const method of Object.keys(ops)) {
      if (['get', 'post', 'put', 'delete', 'patch'].includes(method)) {
        out.add(`${method.toUpperCase()} ${p}`);
      }
    }
  }
  return out;
}

/**
 * @returns {{ok: boolean, missingInSchema: string[], missingInCode: string[], checked: number}}
 */
function crossCheck(schema) {
  const code = routesFromCode();
  const spec = routesFromSchema(schema);
  const missingInSchema = [...code].filter((r) => !spec.has(r)).sort();
  const missingInCode = [...spec].filter((r) => !code.has(r)).sort();
  return {
    ok: missingInSchema.length === 0 && missingInCode.length === 0,
    missingInSchema, // real routes with no schema entry (API Shield would flag them "unknown")
    missingInCode, // schema entries with no route (phantom/stale — the old failure mode)
    checked: code.size,
  };
}

module.exports = { crossCheck, routesFromCode, routesFromSchema };
