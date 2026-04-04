const nodemailer = require('nodemailer');

let transporter = null;

function getTransporter() {
    if (!transporter) {
        const port = parseInt(process.env.SMTP_PORT || '465');
        const secure = process.env.SMTP_SECURE !== undefined
            ? process.env.SMTP_SECURE === 'true'
            : true;

        const config = {
            host: process.env.SMTP_HOST,
            port,
            secure,
        };

        // Only include auth if credentials are provided
        if (process.env.SMTP_USER && process.env.SMTP_PASS) {
            config.auth = {
                user: process.env.SMTP_USER,
                pass: process.env.SMTP_PASS,
            };
        }

        transporter = nodemailer.createTransport(config);
    }
    return transporter;
}

function getEmailDefaults() {
    const fromName = process.env.SMTP_FROM_NAME || 'VideoSite';
    const fromAddress = process.env.SMTP_FROM_ADDRESS || process.env.SMTP_USER;
    const replyTo = process.env.SMTP_REPLY_TO;

    return {
        from: fromAddress ? `"${fromName}" <${fromAddress}>` : undefined,
        replyTo: replyTo || undefined,
    };
}

function isEmailConfigured() {
    return !!process.env.SMTP_HOST;
}

function resetTransporter() {
    if (transporter) {
        transporter.close();
        transporter = null;
    }
}

module.exports = { getTransporter, getEmailDefaults, isEmailConfigured, resetTransporter };
