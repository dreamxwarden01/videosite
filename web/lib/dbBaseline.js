// Guards db/schema.sql and db/seed.sql against drifting apart.
//
// THE CONTRACT
//
// db/schema.sql is a generated dump of a database with migrations 001..N applied,
// and db/seed.sql marks exactly those N as already-applied. The two are a matched
// pair — a BASELINE — and db/baseline.json pins it (the id list + a hash of
// schema.sql). A fresh install lays down the baseline and then runs every
// migration AFTER it, which is the same code path an existing install takes.
//
// SO: to add a migration, append it to db/migrations.js and touch nothing else.
// Do not add it to seed.sql. Do not regenerate schema.sql. The new migration runs
// on fresh installs and on upgrades alike, and there is nothing left to keep in
// sync — which is the point.
//
// The pair only moves when you deliberately re-snapshot schema.sql from a
// fully-migrated database (to collapse a long migration tail). That is what
// `npm run db:bless` is for: it rewrites seed.sql's applied list and baseline.json
// together, so they cannot move independently.
//
// WHY THIS EXISTS: seed.sql once claimed 001..024 while schema.sql had already
// grown post-024 columns, so a fresh install replayed 25 migrations onto a schema
// that already had their changes and died on `Duplicate column name 'video_type'`.
// The mirror-image mistake — marking a migration applied that schema.sql does NOT
// contain — is worse: the migration is skipped, the column is silently absent, and
// nothing fails until something reads it.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// VIDEOSITE_DB_DIR lets the self-test run these checks against throwaway copies of
// the four files. Production always uses ./db.
const dbDir = () => process.env.VIDEOSITE_DB_DIR || path.join(__dirname, '..', 'db');
const MIGRATIONS_FILE = () => path.join(dbDir(), 'migrations.js');
const SCHEMA_FILE = () => path.join(dbDir(), 'schema.sql');
const SEED_FILE = () => path.join(dbDir(), 'seed.sql');
const BASELINE_FILE = () => path.join(dbDir(), 'baseline.json');

// The seed's bookkeeping statement, as one regex, used to both read and rewrite it.
const SEED_INSERT_RE = /INSERT\s+INTO\s+schema_migrations\s*\(\s*migration_id\s*\)\s*VALUES([\s\S]*?);/i;

const sha256 = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

/**
 * Hash of schema.sql's DDL — comments and blank lines stripped, so rewording the
 * header does not trip the guard while any change to an actual table does. Only
 * FULL-LINE comments are dropped; a `--` inside a string literal is left alone
 * because no DDL line ever starts with one.
 */
function schemaHash() {
    const body = fs
        .readFileSync(SCHEMA_FILE(), 'utf8')
        .replace(/\r\n/g, '\n')
        .split('\n')
        .filter((l) => {
            const t = l.trim();
            return t !== '' && !t.startsWith('--');
        })
        .join('\n');
    return sha256(body);
}

/** Migration ids, in the order runMigrations() executes them. */
function readMigrationIds() {
    const src = fs.readFileSync(MIGRATIONS_FILE(), 'utf8');
    const ids = [];
    // Only the migration objects: `id: '049_drop_password_columns'`.
    const re = /\bid:\s*'(\d{3}_[a-z0-9_]+)'/gi;
    let m;
    while ((m = re.exec(src)) !== null) ids.push(m[1]);
    return ids;
}

/** The ids seed.sql pre-marks as applied, i.e. the ones schema.sql already contains. */
function readSeedApplied() {
    const src = fs.readFileSync(SEED_FILE(), 'utf8');
    const stmt = src.match(SEED_INSERT_RE);
    if (!stmt) return null; // caller reports it; an absent statement is itself drift
    const ids = [];
    const re = /\(\s*'([^']+)'\s*\)/g;
    let m;
    while ((m = re.exec(stmt[1])) !== null) ids.push(m[1]);
    return ids;
}

function readBaseline() {
    return JSON.parse(fs.readFileSync(BASELINE_FILE(), 'utf8'));
}

function dupes(list) {
    const seen = new Set();
    const out = new Set();
    for (const x of list) (seen.has(x) ? out : seen).add(x);
    return [...out];
}

/**
 * @returns {{ ok: boolean, errors: string[], migrationIds: string[], applied: string[] }}
 */
function checkDbBaseline() {
    const errors = [];
    const migrationIds = readMigrationIds();
    const applied = readSeedApplied();

    if (migrationIds.length === 0) {
        errors.push('db/migrations.js: no migrations found — the id regex in lib/dbBaseline.js is stale.');
        return { ok: false, errors, migrationIds, applied: applied || [] };
    }
    const migDupes = dupes(migrationIds);
    if (migDupes.length) {
        errors.push(`db/migrations.js: duplicate migration id(s): ${migDupes.join(', ')}. Ids are the primary key of schema_migrations, so a duplicate silently skips the second one.`);
    }

    if (applied === null) {
        errors.push('db/seed.sql: no `INSERT INTO schema_migrations (migration_id) VALUES ...` statement. Without it a fresh install replays every migration over a schema.sql that already contains them.');
        return { ok: false, errors, migrationIds, applied: [] };
    }

    const seedDupes = dupes(applied);
    if (seedDupes.length) {
        errors.push(`db/seed.sql: duplicate id(s) in the applied list: ${seedDupes.join(', ')}. schema_migrations.migration_id is a PRIMARY KEY, so the insert fails and the whole install dies.`);
    }

    // The applied list must be a PREFIX of the execution order. Anything else means a
    // migration would be skipped on fresh installs (its schema change silently absent)
    // or replayed onto a schema that already has it.
    if (applied.length > migrationIds.length) {
        errors.push(`db/seed.sql marks ${applied.length} migrations applied but db/migrations.js only defines ${migrationIds.length}.`);
    }
    for (let i = 0; i < Math.min(applied.length, migrationIds.length); i++) {
        if (applied[i] === migrationIds[i]) continue;
        if (!migrationIds.includes(applied[i])) {
            errors.push(`db/seed.sql marks '${applied[i]}' applied, but no such migration exists in db/migrations.js. It can never run, so whatever it changed is missing from every fresh install.`);
        } else {
            errors.push(`Migration order drift: db/seed.sql has '${applied[i]}' at position ${i + 1}, db/migrations.js has '${migrationIds[i]}'. New migrations must be APPENDED to db/migrations.js — inserting one before the baseline makes schema.sql claim a change it does not have.`);
        }
        break; // one clear message beats a cascade of them
    }

    // The baseline pins the pair. If either half moves alone, say so.
    let baseline;
    try {
        baseline = readBaseline();
    } catch (err) {
        errors.push(`db/baseline.json is missing or unreadable (${err.message}). It pins schema.sql to seed.sql's applied list; regenerate it with \`npm run db:bless\`.`);
        return { ok: errors.length === 0, errors, migrationIds, applied };
    }

    const baseApplied = baseline.applied || [];
    if (baseApplied.join('\n') !== applied.join('\n')) {
        errors.push(`db/seed.sql's applied list no longer matches db/baseline.json (${applied.length} vs ${baseApplied.length} ids). seed.sql's list is FROZEN at the schema.sql baseline: a new migration goes in db/migrations.js ONLY. If you re-snapshotted schema.sql from a fully-migrated database, run \`npm run db:bless\`.`);
    }
    if (baseline.through && baseline.through !== applied[applied.length - 1]) {
        errors.push(`db/baseline.json says the baseline runs through '${baseline.through}', but seed.sql's list ends at '${applied[applied.length - 1]}'.`);
    }

    if (schemaHash() !== baseline.schemaSha256) {
        errors.push(`db/schema.sql's DDL has changed but db/baseline.json still pins the old one.\n    Adding a migration must NOT touch schema.sql — the migration runs on fresh installs by itself.\n    If you deliberately re-snapshotted schema.sql from a fully-migrated database, run \`npm run db:bless\` to move seed.sql and baseline.json with it.`);
    }

    return { ok: errors.length === 0, errors, migrationIds, applied };
}

/** Throws with every problem at once. Called by the installer before it touches a database. */
function assertDbBaseline() {
    const { ok, errors } = checkDbBaseline();
    if (!ok) {
        const err = new Error(
            'This build\'s database files are inconsistent — refusing to install:\n  - ' +
            errors.join('\n  - ')
        );
        err.code = 'DB_BASELINE_DRIFT';
        throw err;
    }
}

/**
 * Re-snapshot: schema.sql is now a dump of a database with EVERY current migration
 * applied, so rewrite seed.sql's list and baseline.json to say exactly that. The two
 * move together or not at all.
 */
function blessDbBaseline() {
    const migrationIds = readMigrationIds();
    if (migrationIds.length === 0) throw new Error('db/migrations.js: no migrations found.');
    const migDupes = dupes(migrationIds);
    if (migDupes.length) throw new Error(`db/migrations.js has duplicate ids (${migDupes.join(', ')}) — fix that before blessing.`);

    const seedSrc = fs.readFileSync(SEED_FILE(), 'utf8');
    if (!SEED_INSERT_RE.test(seedSrc)) {
        throw new Error('db/seed.sql has no `INSERT INTO schema_migrations (migration_id) VALUES ...` statement to rewrite.');
    }
    const before = readSeedApplied();

    const values = migrationIds.map((id) => `    ('${id}')`).join(',\n');
    const nextSeed = seedSrc.replace(
        SEED_INSERT_RE,
        `INSERT INTO schema_migrations (migration_id) VALUES\n${values};`
    );
    fs.writeFileSync(SEED_FILE(), nextSeed);

    const baseline = {
        _: 'Pins db/schema.sql to the migrations db/seed.sql marks applied. See lib/dbBaseline.js. Regenerate with `npm run db:bless` — never by hand.',
        through: migrationIds[migrationIds.length - 1],
        schemaSha256: schemaHash(),
        applied: migrationIds,
    };
    fs.writeFileSync(BASELINE_FILE(), JSON.stringify(baseline, null, 2) + '\n');

    return { before, after: migrationIds, through: baseline.through };
}

module.exports = { checkDbBaseline, assertDbBaseline, blessDbBaseline, readMigrationIds, readSeedApplied };
