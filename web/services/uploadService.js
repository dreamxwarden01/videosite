const {
    CreateMultipartUploadCommand,
    UploadPartCommand,
    CompleteMultipartUploadCommand,
    AbortMultipartUploadCommand
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

async function getPresignedPartUrls(objectKey, uploadId, partNumbers) {
    const r2 = getR2Client();
    const bucket = getR2BucketName();

    const urls = await Promise.all(partNumbers.map(async (partNumber) => {
        const command = new UploadPartCommand({
            Bucket: bucket,
            Key: objectKey,
            UploadId: uploadId,
            PartNumber: partNumber,
        });
        const url = await getSignedUrl(r2, command, { expiresIn: 3600 });
        return { partNumber, url };
    }));

    return urls;
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
    PART_SIZE
};
