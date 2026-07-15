#!/usr/bin/env node
//
// Self-test for the schema.sql/seed.sql drift guard (lib/dbBaseline.js).
//
// Copies db/ to a scratch dir, breaks it in each of the ways a real change can
// break it, and asserts the guard notices. The two that matter most:
//
//   - "append a migration and touch nothing else" must stay GREEN. That is the new
//     contract; if the guard rejected it, everyone would go back to hand-editing
//     seed.sql and we would be exactly where we started.
//   - "append a migration AND mark it applied in seed.sql" must go RED. This is the
//     silent one — the migration is skipped on fresh installs and its column is just
//     missing, with no error at install time or after.
//
// Run:  node scripts/db-baseline-test.js       (from videosite-local)

const fs = require('fs');
const os = require('os');
const path = require('path');

const REAL_DB = path.join(__dirname, '..', 'db');
let pass = 0;
let fail = 0;

const check = (name, ok, detail) => {
    if (ok) { pass++; console.log('  ✓ ' + name); }
    else { fail++; console.error('  ✗ ' + name, detail !== undefined ? JSON.stringify(detail) : ''); }
};

/** Run the guard against a throwaway copy of db/, mutated by `mutate`. */
function withDb(mutate) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-baseline-'));
    for (const f of ['migrations.js', 'schema.sql', 'seed.sql', 'baseline.json']) {
        fs.copyFileSync(path.join(REAL_DB, f), path.join(dir, f));
    }
    const read = (f) => fs.readFileSync(path.join(dir, f), 'utf8');
    const write = (f, s) => fs.writeFileSync(path.join(dir, f), s);
    mutate({ dir, read, write });

    process.env.VIDEOSITE_DB_DIR = dir;
    delete require.cache[require.resolve('../lib/dbBaseline')];
    const { checkDbBaseline } = require('../lib/dbBaseline');
    let result;
    try {
        result = checkDbBaseline();
    } finally {
        delete process.env.VIDEOSITE_DB_DIR;
        fs.rmSync(dir, { recursive: true, force: true });
    }
    return result;
}

/** Append a new migration to migrations.js the way a developer would. */
const appendMigration = (id) => ({ read, write }) => {
    const src = read('migrations.js');
    const at = src.lastIndexOf('        ];');
    if (at === -1) throw new Error('could not find the end of the migrations array');
    const entry = `            {\n                id: '${id}',\n                up: async () => {\n                    await pool.execute('ALTER TABLE users ADD COLUMN nickname VARCHAR(64) NULL');\n                }\n            },\n`;
    write('migrations.js', src.slice(0, at) + entry + src.slice(at));
};

/** Add an id to seed.sql's applied list — the thing nobody should ever do by hand. */
const markApplied = (id) => ({ read, write }) => {
    const src = read('seed.sql');
    write('seed.sql', src.replace(
        /(\('049_drop_password_columns'\));/,
        `$1,\n    ('${id}');`
    ));
};

const both = (...fns) => (ctx) => fns.forEach((f) => f(ctx));
const errorText = (r) => r.errors.join(' | ');

console.log('\ndb baseline guard\n');

// The repo as it stands must be clean, or every assertion below is meaningless.
{
    const r = withDb(() => {});
    check('the checked-in db/ passes', r.ok, r.errors);
}

// THE HAPPY PATH. Adding a migration touches migrations.js and nothing else.
{
    const r = withDb(appendMigration('050_add_nickname'));
    check('append a migration, touch nothing else → OK', r.ok, r.errors);
    check('  ...and it is left to run on a fresh install',
        r.migrationIds.length === r.applied.length + 1,
        { defined: r.migrationIds.length, baked: r.applied.length });
}

// THE SILENT KILLER. Marked applied, but schema.sql never got the column, so the
// migration is skipped and `users.nickname` simply does not exist.
{
    const r = withDb(both(appendMigration('050_add_nickname'), markApplied('050_add_nickname')));
    check('append a migration AND mark it applied in seed.sql → REJECTED', !r.ok);
    check('  ...and the message says seed.sql is frozen',
        /frozen|baseline\.json/i.test(errorText(r)), errorText(r));
}

// The loud one we actually hit: schema.sql moved on, seed.sql did not.
{
    const r = withDb(({ read, write }) => {
        write('schema.sql', read('schema.sql').replace(
            'CREATE TABLE IF NOT EXISTS `bmfa_tokens` (',
            'CREATE TABLE IF NOT EXISTS `nicknames` (\n  `id` int(11) NOT NULL\n) ENGINE=InnoDB;\n\nCREATE TABLE IF NOT EXISTS `bmfa_tokens` ('
        ));
    });
    check('schema.sql DDL changed without a bless → REJECTED', !r.ok);
    check('  ...and the message points at db:bless',
        /db:bless/.test(errorText(r)), errorText(r));
}

// Editing the header prose must NOT trip it — a guard that cries wolf gets disabled.
{
    const r = withDb(({ read, write }) => {
        write('schema.sql', '-- a new comment line\n--\n' + read('schema.sql'));
    });
    check('schema.sql comment-only edit → still OK (no false positive)', r.ok, r.errors);
}

// A migration inserted mid-array: schema.sql would claim a change it never got.
{
    const r = withDb(({ read, write }) => {
        const src = read('migrations.js');
        const marker = "                id: '025_worker_sessions',";
        write('migrations.js', src.replace(
            marker,
            "                id: '050_sneaked_in',\n                up: async () => {}\n            },\n            {\n" + marker
        ));
    });
    check('migration inserted BEFORE the baseline end → REJECTED', !r.ok);
    check('  ...and the message says to append',
        /APPENDED/i.test(errorText(r)), errorText(r));
}

// seed.sql names a migration that no longer exists (renamed or deleted in migrations.js).
{
    const r = withDb(({ read, write }) => {
        write('seed.sql', read('seed.sql').replace("('048_session_stepup')", "('048_session_step_up')"));
    });
    check('seed.sql names a migration migrations.js does not define → REJECTED', !r.ok);
    check('  ...and the message says it can never run',
        /never run/i.test(errorText(r)), errorText(r));
}

// A dropped id: the migration re-runs on fresh installs, onto a schema that has it.
{
    const r = withDb(({ read, write }) => {
        write('seed.sql', read('seed.sql').replace("    ('030_cloudflare_turnstile_worker_gate'),\n", ''));
    });
    check('an id dropped from seed.sql\'s list → REJECTED', !r.ok, errorText(r));
}

// Duplicate id in migrations.js — the second one silently never runs.
{
    const r = withDb(appendMigration('031_pending_deletes'));
    check('duplicate migration id in migrations.js → REJECTED', !r.ok);
    check('  ...and the message names the duplicate',
        /031_pending_deletes/.test(errorText(r)), errorText(r));
}

// The bookkeeping statement itself going missing.
{
    const r = withDb(({ read, write }) => {
        write('seed.sql', read('seed.sql').replace(
            /INSERT INTO schema_migrations[\s\S]*?;/,
            '-- (removed)'
        ));
    });
    check('seed.sql loses its schema_migrations INSERT → REJECTED', !r.ok, errorText(r));
}

// The pin itself going missing.
{
    const r = withDb(({ dir }) => fs.rmSync(path.join(dir, 'baseline.json')));
    check('baseline.json missing → REJECTED', !r.ok);
    check('  ...and the message points at db:bless',
        /db:bless/.test(errorText(r)), errorText(r));
}

// The installer calls assertDbBaseline() before it touches a database, so a drifted
// build dies with the reason instead of a duplicate-column error halfway through.
{
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-baseline-'));
    for (const f of ['migrations.js', 'schema.sql', 'seed.sql', 'baseline.json']) {
        fs.copyFileSync(path.join(REAL_DB, f), path.join(dir, f));
    }
    fs.rmSync(path.join(dir, 'baseline.json'));

    process.env.VIDEOSITE_DB_DIR = dir;
    delete require.cache[require.resolve('../lib/dbBaseline')];
    const { assertDbBaseline } = require('../lib/dbBaseline');
    let thrown = null;
    try { assertDbBaseline(); } catch (e) { thrown = e; }
    delete process.env.VIDEOSITE_DB_DIR;
    fs.rmSync(dir, { recursive: true, force: true });

    check('assertDbBaseline() throws on drift (the installer refuses to run)', !!thrown);
    check('  ...tagged DB_BASELINE_DRIFT, with the reason in the message',
        thrown?.code === 'DB_BASELINE_DRIFT' && /baseline\.json/.test(thrown.message),
        thrown?.message);
}

console.log(`\ndb baseline guard: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
