const { getTransporter, getEmailDefaults, isEmailConfigured } = require('../config/email');

const RETRYABLE_CODES = new Set([
    'ECONNREFUSED', 'ETIMEDOUT', 'ECONNRESET', 'ESOCKET',
    'ENOTFOUND', 'EAI_AGAIN', 'EPIPE',
]);

const RETRY_DELAY_MS = 1000;

function classifyError(err) {
    const code = err.code || '';
    const message = (err.message || '').toLowerCase();
    const responseCode = err.responseCode || 0;

    // Auth failure — wrong credentials
    if (code === 'EAUTH') {
        return {
            retryable: false,
            userMessage: 'Email service authentication failed',
        };
    }

    // Sender address rejected by server (553, 550 on MAIL FROM)
    if (responseCode === 553 || (responseCode === 550 && message.includes('sender'))) {
        return {
            retryable: false,
            userMessage: 'Email sender address is not allowed by the server',
        };
    }

    // Recipient rejected (550, 551, 552, 553 on RCPT TO)
    if ([550, 551, 552].includes(responseCode) && !message.includes('sender')) {
        return {
            retryable: false,
            userMessage: 'Failed to send email to the specified address',
        };
    }

    // TLS errors — retryable (could be transient handshake issue)
    if (message.includes('tls') || message.includes('ssl') ||
        message.includes('certificate') || message.includes('unable_to_verify') ||
        code.startsWith('ERR_TLS')) {
        return {
            retryable: true,
            userMessage: 'Failed to establish a secure connection to the email server',
        };
    }

    // Network / connection errors — retryable
    if (RETRYABLE_CODES.has(code)) {
        return {
            retryable: true,
            userMessage: 'Failed to send email, please try again later',
        };
    }

    // Everything else — not retryable, generic message
    return {
        retryable: false,
        userMessage: 'Failed to send email',
    };
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function attemptSend(transporter, mailOptions) {
    return transporter.sendMail(mailOptions);
}

/**
 * Send an email via SMTP.
 * @param {Object} options
 * @param {string} options.to - Recipient email address
 * @param {string} options.subject - Email subject
 * @param {string} [options.html] - HTML body
 * @param {string} [options.text] - Plain text body
 * @returns {Promise<{success: boolean, message: string}>}
 */
async function sendEmail({ to, subject, html, text }) {
    // Check configuration first
    if (!isEmailConfigured()) {
        console.error('[Email] SMTP is not configured (SMTP_HOST missing)');
        return { success: false, message: 'Email service is not configured' };
    }

    const transporter = getTransporter();
    const defaults = getEmailDefaults();

    const mailOptions = {
        from: defaults.from,
        to,
        subject,
    };

    if (defaults.replyTo) {
        mailOptions.replyTo = defaults.replyTo;
    }
    if (html) mailOptions.html = html;
    if (text) mailOptions.text = text;

    let lastError;

    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            await attemptSend(transporter, mailOptions);
            return { success: true, message: 'Email sent successfully' };
        } catch (err) {
            lastError = err;
            const classification = classifyError(err);

            console.error(`[Email] Send attempt ${attempt + 1} failed:`, {
                code: err.code,
                responseCode: err.responseCode,
                message: err.message,
                retryable: classification.retryable,
            });

            if (!classification.retryable || attempt === 1) {
                return { success: false, message: classification.userMessage };
            }

            // Wait before retry
            await sleep(RETRY_DELAY_MS);
        }
    }

    // Should not reach here, but just in case
    return { success: false, message: 'Failed to send email' };
}

module.exports = { sendEmail };
