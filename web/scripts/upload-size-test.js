#!/usr/bin/env node
// Upload size-binding regression test.
//
// Presigned upload URLs used to sign only `host`, which made Content-Length a
// suggestion: a URL minted for a 1 KB file would happily store gigabytes (proven
// against R2 — a "1 KB" material URL accepted and stored 3 MB), and the size we
// recorded in the DB was whatever the client claimed. Both presigns now SIGN
// content-length, so R2 rejects a mismatched body with SignatureDoesNotMatch
// before accepting any bytes.
//
// That makes the signed length safety-critical in a second way: if the server
// signs a length the browser doesn't send, EVERY upload breaks. The server's
// per-part length must therefore agree exactly with the client's slicing in
// client/src/services/uploadService.js:
//     start = (partNumber - 1) * partSize
//     end   = min(start + partSize, file.size)
// This test pins that agreement, and pins that content-length stays signed.
//
// Needs no R2 credentials or network — pure signing/maths.
// Run: npm run test:upload

process.env.R2_ENDPOINT ||= 'https://example.r2.cloudflarestorage.com';
process.env.R2_ACCESS_KEY_ID ||= 'test';
process.env.R2_SECRET_ACCESS_KEY ||= 'test';
process.env.R2_BUCKET_NAME ||= 'test-bucket';

const { partContentLength, getPresignedPartUrls, PART_SIZE, calculateTotalParts } =
    require('../services/uploadService');
const { getPresignedUploadUrl } = require('../services/materialService');

let fail = 0;
const ok = (c, label, extra = '') => {
    console.log(`${c ? '✓' : '✗ FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
    if (!c) fail++;
};

// Exactly what the browser does when it builds each part's Blob.
function clientBlobSize(fileSize, partNumber, partSize = PART_SIZE) {
    const start = (partNumber - 1) * partSize;
    const end = Math.min(start + partSize, fileSize);
    return end - start;
}

(async () => {
    console.log('\n--- server-signed part length matches the client blob ---');
    const sizes = [
        1,                          // single tiny part
        PART_SIZE - 1,              // just under one part
        PART_SIZE,                  // exactly one part, no remainder
        PART_SIZE + 1,              // spills a 1-byte last part
        2 * PART_SIZE,              // exact multiple
        250 * 1024 * 1024,          // 100 / 100 / 50
        50 * 1024 * 1024 * 1024,    // the 50 GB ceiling
    ];
    let mismatches = 0, checked = 0;
    for (const fileSize of sizes) {
        const total = calculateTotalParts(fileSize);
        for (let n = 1; n <= total; n++) {
            checked++;
            if (partContentLength(fileSize, n) !== clientBlobSize(fileSize, n)) {
                mismatches++;
                console.log(`   mismatch: size=${fileSize} part=${n} server=${partContentLength(fileSize, n)} client=${clientBlobSize(fileSize, n)}`);
            }
        }
    }
    ok(mismatches === 0, `every part length agrees with the client (${checked} parts across ${sizes.length} file sizes)`);

    // Spot-check the shape everyone reasons about.
    const f = 250 * 1024 * 1024;
    ok(partContentLength(f, 1) === PART_SIZE, 'first part is a full PART_SIZE');
    ok(partContentLength(f, 3) === 50 * 1024 * 1024, 'last part is the remainder, not a full part',
        `${partContentLength(f, 3)} B`);
    ok(partContentLength(PART_SIZE, 1) === PART_SIZE, 'exact-multiple file has no stray trailing part');

    console.log('\n--- content-length stays signed (the actual control) ---');
    const partUrls = await getPresignedPartUrls('k.bin', 'upload-id', [1, 2, 3], f);
    const allSigned = partUrls.every(
        (p) => new URL(p.url).searchParams.get('X-Amz-SignedHeaders') === 'content-length;host'
    );
    ok(allSigned, 'video part URLs sign content-length;host');

    const matUrl = new URL(await getPresignedUploadUrl('k.pdf', 'application/pdf', 1024));
    ok(matUrl.searchParams.get('X-Amz-SignedHeaders') === 'content-length;host',
        'material URL signs content-length;host', matUrl.searchParams.get('X-Amz-SignedHeaders'));

    // The SDK otherwise bakes a crc32 of the EMPTY body into the URL. R2 ignores
    // it today, but if it ever stops ignoring it every presigned PUT breaks.
    const checksumParams = [...matUrl.searchParams.keys()].filter((k) => k.includes('checksum'));
    ok(checksumParams.length === 0, 'no empty-body checksum baked into the URL',
        checksumParams.join(',') || '(none)');

    console.log(fail ? `\n${fail} FAILED\n` : '\nall passed\n');
    process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
