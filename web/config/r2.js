const { S3Client } = require('@aws-sdk/client-s3');

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
        });
    }
    return r2Client;
}

function createR2Client(endpoint, accessKeyId, secretAccessKey) {
    return new S3Client({
        region: 'auto',
        endpoint,
        credentials: { accessKeyId, secretAccessKey },
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
