#!/usr/bin/env node
// Guard: no TEXT column may collide with the BINARY(16) typeCast.
//
// config/database.js hands binary(16) UUIDs back as 32-char hex, and identifies
// them as "mysql2 type STRING with field.length === 16". field.length is the
// column's max width in BYTES, so under utf8mb4 a 4-character column is 16 too —
// mysql2 reports BINARY, CHAR and ENUM alike as STRING and exposes neither flags
// nor charset on the typeCast field, so type and length cannot separate them.
//
// That is not theoretical: videos.video_type enum('ts','cmaf') was served as
// "636d6166" for weeks, and the player — which tests `videoType === 'cmaf'` —
// silently fell back to HLS on every browser that should have used DASH.
//
// The typeCast now also requires the VALUE to be exactly 16 bytes, which every
// UUID is and 'cmaf' (4) is not. This check enforces the assumption that keeps
// that safe: for every non-binary column whose max width is 16 octets, NO
// possible value may be 16 bytes.
//   ENUM        -> provably safe when the longest member is under 16 bytes.
//   CHAR/VARCHAR-> a value COULD be 16 bytes, so it is a genuine hazard.
//
// Run inside the app container (env comes from its env_file):
//   docker exec <container> node scripts/check-typecast-collisions.js
const mysql = require('mysql2/promise');

(async () => {
    const conn = await mysql.createConnection({
        host: process.env.DB_HOST, port: process.env.DB_PORT || 3306,
        user: process.env.DB_USER, password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME,
    });

    const [cols] = await conn.execute(
        `SELECT TABLE_NAME, COLUMN_NAME, DATA_TYPE, COLUMN_TYPE
           FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = ? AND CHARACTER_OCTET_LENGTH = 16
          ORDER BY TABLE_NAME, COLUMN_NAME`,
        [process.env.DB_NAME]
    );
    await conn.end();

    const binary = cols.filter((c) => ['binary', 'varbinary'].includes(c.DATA_TYPE));
    const text = cols.filter((c) => !['binary', 'varbinary'].includes(c.DATA_TYPE));

    console.log(`\n16-octet columns: ${cols.length}  (${binary.length} binary — intended, ${text.length} text)`);

    const hazards = [];
    for (const c of text) {
        const where = `${c.TABLE_NAME}.${c.COLUMN_NAME}`;
        if (c.DATA_TYPE === 'enum' || c.DATA_TYPE === 'set') {
            // Longest member decides: nothing stored can exceed it.
            const members = (c.COLUMN_TYPE.match(/'((?:[^']|'')*)'/g) || [])
                .map((m) => Buffer.byteLength(m.slice(1, -1).replace(/''/g, "'"), 'utf8'));
            const longest = members.length ? Math.max(...members) : 0;
            if (longest >= 16) hazards.push(`${where}  ${c.COLUMN_TYPE}  — longest member is ${longest} bytes`);
            else console.log(`  ok   ${where}  ${c.DATA_TYPE}, longest member ${longest}B — can never be 16`);
        } else {
            hazards.push(`${where}  ${c.COLUMN_TYPE}  — a 16-byte value would be hex-encoded`);
        }
    }

    if (hazards.length) {
        console.error('\nTYPECAST COLLISION:');
        for (const h of hazards) console.error(`  ✗ ${h}`);
        console.error('\nA value of exactly 16 bytes in one of these is indistinguishable from a');
        console.error('binary(16) UUID and will be handed to the app as hex. Either widen/narrow the');
        console.error('column so it is not 16 octets, or store it as something the typeCast skips.\n');
        process.exit(1);
    }
    console.log('\nno collisions — every 16-octet column is either binary or provably under 16 bytes\n');
})().catch((e) => { console.error('check failed:', e.message); process.exit(1); });
