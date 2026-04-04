// ---------------------------------------------------------------------------
// MFA / OTP email templates
// ---------------------------------------------------------------------------
// Each builder returns { subject, html, text } matching the inline-CSS style
// used in registrationService.js.
// ---------------------------------------------------------------------------

function escapeHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/**
 * Render the OTP code with letter-spacing so each digit is visually distinct.
 */
function codeBlock(code) {
    return `
        <div style="margin: 28px 0; text-align: center;">
            <span style="display: inline-block; padding: 14px 28px; background: #f4f6f8; border-radius: 6px; font-family: 'SF Mono', SFMono-Regular, Consolas, 'Liberation Mono', Menlo, monospace; font-size: 32px; letter-spacing: 8px; color: #1a73e8; font-weight: 600;">
                ${escapeHtml(code)}
            </span>
        </div>`;
}

/**
 * Wrap body content in the shared outer template.
 */
function wrapHtml(siteName, bodyInner) {
    return `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 560px; margin: 0 auto; padding: 32px 16px;">
            <h2 style="color: #333; margin-bottom: 24px;">${escapeHtml(siteName)}</h2>
            ${bodyInner}
        </div>`;
}

function disclaimer(text) {
    return `
            <p style="color: #888; font-size: 13px; margin-top: 32px; border-top: 1px solid #eee; padding-top: 16px;">
                ${escapeHtml(text)}
            </p>`;
}

// ---------------------------------------------------------------------------
// 1. Login OTP
// ---------------------------------------------------------------------------

function buildLoginOtpEmail(code, siteName, validityMinutes) {
    const subject = 'Your sign-in verification code';

    const html = wrapHtml(siteName, `
            <p style="color: #555; line-height: 1.6;">
                Your verification code for signing in to <strong>${escapeHtml(siteName)}</strong> is:
            </p>
            ${codeBlock(code)}
            <p style="color: #555; line-height: 1.6;">
                This code expires in ${escapeHtml(String(validityMinutes))} minutes.
            </p>
            ${disclaimer("If you didn't try to sign in, someone may have your password. Consider changing it.")}
    `);

    const text = [
        siteName,
        '',
        `Your verification code for signing in to ${siteName} is:`,
        '',
        `    ${code}`,
        '',
        `This code expires in ${validityMinutes} minutes.`,
        '',
        "If you didn't try to sign in, someone may have your password. Consider changing it."
    ].join('\n');

    return { subject, html, text };
}

// ---------------------------------------------------------------------------
// 2. Password Reset OTP
// ---------------------------------------------------------------------------

function buildPasswordResetOtpEmail(code, siteName, validityMinutes) {
    const subject = 'Password reset verification code';

    const html = wrapHtml(siteName, `
            <p style="color: #555; line-height: 1.6;">
                Your verification code for resetting your password on <strong>${escapeHtml(siteName)}</strong> is:
            </p>
            ${codeBlock(code)}
            <p style="color: #555; line-height: 1.6;">
                This code expires in ${escapeHtml(String(validityMinutes))} minutes.
            </p>
            ${disclaimer("If you didn't request a password reset, you can safely ignore this email.")}
    `);

    const text = [
        siteName,
        '',
        `Your verification code for resetting your password on ${siteName} is:`,
        '',
        `    ${code}`,
        '',
        `This code expires in ${validityMinutes} minutes.`,
        '',
        "If you didn't request a password reset, you can safely ignore this email."
    ].join('\n');

    return { subject, html, text };
}

// ---------------------------------------------------------------------------
// 3. MFA / Security Change OTP
// ---------------------------------------------------------------------------

function buildMfaChangeOtpEmail(code, siteName, validityMinutes, operation) {
    const subject = 'Security change verification code';

    const html = wrapHtml(siteName, `
            <p style="color: #555; line-height: 1.6;">
                Your verification code for <strong>${escapeHtml(operation)}</strong> on <strong>${escapeHtml(siteName)}</strong> is:
            </p>
            ${codeBlock(code)}
            <p style="color: #555; line-height: 1.6;">
                This code expires in ${escapeHtml(String(validityMinutes))} minutes.
            </p>
            ${disclaimer("If you didn't make this request, please secure your account immediately.")}
    `);

    const text = [
        siteName,
        '',
        `Your verification code for ${operation} on ${siteName} is:`,
        '',
        `    ${code}`,
        '',
        `This code expires in ${validityMinutes} minutes.`,
        '',
        "If you didn't make this request, please secure your account immediately."
    ].join('\n');

    return { subject, html, text };
}

// ---------------------------------------------------------------------------
// 4. Admin Operation OTP
// ---------------------------------------------------------------------------

function buildAdminOperationOtpEmail(code, siteName, validityMinutes, operation) {
    const subject = 'Admin action verification code';

    const html = wrapHtml(siteName, `
            <p style="color: #555; line-height: 1.6;">
                Your verification code for <strong>${escapeHtml(operation)}</strong> on <strong>${escapeHtml(siteName)}</strong> is:
            </p>
            ${codeBlock(code)}
            <p style="color: #555; line-height: 1.6;">
                This code expires in ${escapeHtml(String(validityMinutes))} minutes.
            </p>
            ${disclaimer("If you didn't initiate this action, please contact your administrator.")}
    `);

    const text = [
        siteName,
        '',
        `Your verification code for ${operation} on ${siteName} is:`,
        '',
        `    ${code}`,
        '',
        `This code expires in ${validityMinutes} minutes.`,
        '',
        "If you didn't initiate this action, please contact your administrator."
    ].join('\n');

    return { subject, html, text };
}

// ---------------------------------------------------------------------------
// 5. Email Verification OTP
// ---------------------------------------------------------------------------

function buildEmailVerificationOtpEmail(code, siteName, validityMinutes) {
    const subject = 'Verify your email address';

    const html = wrapHtml(siteName, `
            <p style="color: #555; line-height: 1.6;">
                Your verification code for confirming your email on <strong>${escapeHtml(siteName)}</strong> is:
            </p>
            ${codeBlock(code)}
            <p style="color: #555; line-height: 1.6;">
                This code expires in ${escapeHtml(String(validityMinutes))} minutes.
            </p>
            ${disclaimer("If you didn't request this, you can ignore this email.")}
    `);

    const text = [
        siteName,
        '',
        `Your verification code for confirming your email on ${siteName} is:`,
        '',
        `    ${code}`,
        '',
        `This code expires in ${validityMinutes} minutes.`,
        '',
        "If you didn't request this, you can ignore this email."
    ].join('\n');

    return { subject, html, text };
}

module.exports = {
    buildLoginOtpEmail,
    buildPasswordResetOtpEmail,
    buildMfaChangeOtpEmail,
    buildAdminOperationOtpEmail,
    buildEmailVerificationOtpEmail
};
