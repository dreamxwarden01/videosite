const { S3Client } = require('@aws-sdk/client-s3');

// The SDK defaults to WHEN_SUPPORTED, which bakes an x-amz-checksum-crc32 of the
// EMPTY body ("AAAAAA==") into every presigned URL as a signed query param. R2
// ignores it today — verified — so uploads work, but nothing guarantees that, and
// the day it starts being honoured every presigned PUT breaks (a real body can
// never match the empty-body checksum). We sign content-length instead, which is
// the property we actually want, so the checksum is pure liability here.
const CHECKSUM = { requestChecksumCalculation: 'WHEN_REQUIRED' };

let r2Client = null;

function getR2Client() {
    if (!r2Client) {
        r2Client = new S3Client({
            region: 'auto',
            endpoint: process.env.R2_ENDPOINT,
            credentials: {
                accessKeyId: process.env.R2_ACCESS_KEY_ID,
                secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
            },
            ...CHECKSUM,
        });
    }
    return r2Client;
}

function createR2Client(endpoint, accessKeyId, secretAccessKey) {
    return new S3Client({
        region: 'auto',
        endpoint,
        credentials: { accessKeyId, secretAccessKey },
        ...CHECKSUM,
    });
}

function resetR2Client() {
    r2Client = null;
}

function getR2BucketName() {
    return process.env.R2_BUCKET_NAME;
}

function getR2PublicDomain() {
    return process.env.R2_PUBLIC_DOMAIN;
}

module.exports = { getR2Client, createR2Client, resetR2Client, getR2BucketName, getR2PublicDomain };
