#!/usr/bin/env node
//
//   node scripts/check-db-baseline.js            check that schema.sql / seed.sql / migrations.js agree
//   node scripts/check-db-baseline.js --bless     re-pin the baseline after re-snapshotting schema.sql
//
// The rules, and why, are at the top of lib/dbBaseline.js.

const { checkDbBaseline, blessDbBaseline } = require('../lib/dbBaseline');

if (process.argv.includes('--bless')) {
    console.log('Re-pinning the database baseline.');
    console.log('This is only correct if db/schema.sql is a fresh dump of a database with EVERY');
    console.log('migration in db/migrations.js applied. If you just added a migration, you do not');
    console.log('need this — append it to db/migrations.js and leave schema.sql/seed.sql alone.\n');

    const { before, after, through } = blessDbBaseline();
    const added = after.filter((id) => !before.includes(id));
    const removed = before.filter((id) => !after.includes(id));

    console.log(`  baseline now runs through ${through} (${after.length} migrations)`);
    if (added.length) console.log(`  + marked applied: ${added.join(', ')}`);
    if (removed.length) console.log(`  - no longer applied: ${removed.join(', ')}`);
    if (!added.length && !removed.length) console.log('  applied list unchanged; re-pinned schema.sql hash');
    console.log('\n  wrote db/seed.sql, db/baseline.json');

    const { ok, errors } = checkDbBaseline();
    if (!ok) {
        console.error('\n✗ still inconsistent after blessing:\n  - ' + errors.join('\n  - '));
        process.exit(1);
    }
    console.log('\n✓ schema.sql, seed.sql and migrations.js agree');
    process.exit(0);
}

const { ok, errors, migrationIds, applied } = checkDbBaseline();

if (!ok) {
    console.error('✗ database baseline drift\n');
    for (const e of errors) console.error('  - ' + e + '\n');
    process.exit(1);
}

const pending = migrationIds.length - applied.length;
console.log(`✓ database baseline OK — schema.sql is the state at ${applied[applied.length - 1]}`);
console.log(`  ${applied.length} migrations baked into schema.sql, ${pending} run on a fresh install`);
