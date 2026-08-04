const {
    CreateMultipartUploadCommand,
    UploadPartCommand,
    CompleteMultipartUploadCommand,
    AbortMultipartUploadCommand,
    HeadObjectCommand
} = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { getR2Client, getR2BucketName } = require('../config/r2');

const PART_SIZE = 100 * 1024 * 1024; // 100MB per part

async function initiateMultipartUpload(objectKey, contentType) {
    const r2 = getR2Client();
    const bucket = getR2BucketName();

    const command = new CreateMultipartUploadCommand({
        Bucket: bucket,
        Key: objectKey,
        ContentType: contentType || 'application/octet-stream',
    });

    const response = await r2.send(command);
    return response.UploadId;
}

// Exact byte length of a part, given the whole file's size. Every part is
// PART_SIZE except the last, which is the remainder. Mirrors the client's
// slicing (start = (n-1)*PART_SIZE, end = min(start+PART_SIZE, size)), so the
// signed length always matches the blob the browser actually sends.
function partContentLength(fileSize, partNumber) {
    const start = (partNumber - 1) * PART_SIZE;
    return Math.min(PART_SIZE, fileSize - start);
}

// fileSize lets us SIGN each part's content-length. Without it only `host` is
// signed, so a URL minted for a 100 MB part accepts an arbitrarily large body —
// and with the part count unbounded too, a "1 MB" upload could store terabytes.
// R2 now rejects any mismatched body with SignatureDoesNotMatch up front.
async function getPresignedPartUrls(objectKey, uploadId, partNumbers, fileSize) {
    const r2 = getR2Client();
    const bucket = getR2BucketName();

    const urls = await Promise.all(partNumbers.map(async (partNumber) => {
        const command = new UploadPartCommand({
            Bucket: bucket,
            Key: objectKey,
            UploadId: uploadId,
            PartNumber: partNumber,
            ContentLength: partContentLength(fileSize, partNumber),
        });
        const url = await getSignedUrl(r2, command, {
            expiresIn: 3600,
            signableHeaders: new Set(['content-length']),
        });
        return { partNumber, url };
    }));

    return urls;
}

// Assembled object size, straight from R2 — the number we didn't take on trust.
async function getObjectSize(objectKey) {
    try {
        const r = await getR2Client().send(new HeadObjectCommand({
            Bucket: getR2BucketName(),
            Key: objectKey,
        }));
        return r.ContentLength ?? null;
    } catch {
        return null;
    }
}

async function completeMultipartUpload(objectKey, uploadId, parts) {
    const r2 = getR2Client();
    const bucket = getR2BucketName();

    const command = new CompleteMultipartUploadCommand({
        Bucket: bucket,
        Key: objectKey,
        UploadId: uploadId,
        MultipartUpload: {
            Parts: parts.map(p => ({
                PartNumber: p.partNumber,
                ETag: p.etag,
            })),
        },
    });

    await r2.send(command);
}

async function abortMultipartUpload(objectKey, uploadId) {
    const r2 = getR2Client();
    const bucket = getR2BucketName();

    const command = new AbortMultipartUploadCommand({
        Bucket: bucket,
        Key: objectKey,
        UploadId: uploadId,
    });

    await r2.send(command);
}

function calculateTotalParts(fileSize) {
    return Math.ceil(fileSize / PART_SIZE);
}

module.exports = {
    initiateMultipartUpload,
    getPresignedPartUrls,
    completeMultipartUpload,
    abortMultipartUpload,
    calculateTotalParts,
    partContentLength,
    getObjectSize,
    PART_SIZE
};
