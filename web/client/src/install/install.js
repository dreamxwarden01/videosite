// Standalone install page JS (no React)
(function() {
  // Override SPA overflow restrictions for scrollable install page
  document.documentElement.style.overflow = 'auto';
  document.documentElement.style.height = 'auto';
  document.body.style.overflow = 'auto';
  document.body.style.height = 'auto';

  const root = document.getElementById('install-root');

  root.innerHTML = `
    <main class="container" style="max-width: 700px; margin: 40px auto; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
      <div style="background: #fff; border-radius: 8px; border: 1px solid #e5e7eb; padding: 24px;">
        <h1 style="margin-bottom: 8px;">VideoSite Installation</h1>
        <p style="color: #6b7280; margin-bottom: 24px;">Configure your database, storage, and create the superadmin account.</p>

        <div id="installError" style="display: none; padding: 12px 16px; border-radius: 6px; font-size: 14px; background: #fee2e2; color: #991b1b; border: 1px solid #fca5a5; margin-bottom: 12px;"></div>

        <form id="installForm">
          <h2 style="margin: 20px 0 12px; font-size: 16px;">Database Configuration</h2>
          <div style="display: flex; gap: 8px;">
            <div style="flex: 3;">
              <label for="dbHost" style="display: block; margin-bottom: 4px; font-size: 14px; font-weight: 500;">Host <span style="color: #9ca3af; font-weight: 400; font-size: 12px;">required</span></label>
              <input type="text" id="dbHost" name="dbHost" value="localhost" required data-nospace
                style="width: 100%; padding: 8px 12px; border: 1px solid #d1d5db; border-radius: 6px; font-size: 14px; box-sizing: border-box;">
              <div class="field-err" data-for="dbHost" style="display: none; color: #dc3545; font-size: 13px; margin-top: 4px;"></div>
            </div>
            <div style="flex: 1;">
              <label for="dbPort" style="display: block; margin-bottom: 4px; font-size: 14px; font-weight: 500;">Port <span style="color: #9ca3af; font-weight: 400; font-size: 12px;">required</span></label>
              <input type="text" id="dbPort" name="dbPort" value="3306" required data-nospace
                style="width: 100%; padding: 8px 12px; border: 1px solid #d1d5db; border-radius: 6px; font-size: 14px; box-sizing: border-box;">
              <div class="field-err" data-for="dbPort" style="display: none; color: #dc3545; font-size: 13px; margin-top: 4px;"></div>
            </div>
          </div>
          <div style="margin-top: 12px;">
            <label for="dbUser" style="display: block; margin-bottom: 4px; font-size: 14px; font-weight: 500;">Username <span style="color: #9ca3af; font-weight: 400; font-size: 12px;">required</span></label>
            <input type="text" id="dbUser" name="dbUser" required data-nospace
              style="width: 100%; padding: 8px 12px; border: 1px solid #d1d5db; border-radius: 6px; font-size: 14px; box-sizing: border-box;">
            <div class="field-err" data-for="dbUser" style="display: none; color: #dc3545; font-size: 13px; margin-top: 4px;"></div>
          </div>
          <div style="margin-top: 12px;">
            <label for="dbPassword" style="display: block; margin-bottom: 4px; font-size: 14px; font-weight: 500;">Password <span style="color: #9ca3af; font-weight: 400; font-size: 12px;">required</span></label>
            <input type="password" id="dbPassword" name="dbPassword" required data-nospace
              style="width: 100%; padding: 8px 12px; border: 1px solid #d1d5db; border-radius: 6px; font-size: 14px; box-sizing: border-box;">
            <div class="field-err" data-for="dbPassword" style="display: none; color: #dc3545; font-size: 13px; margin-top: 4px;"></div>
          </div>
          <div style="margin-top: 12px;">
            <label for="dbName" style="display: block; margin-bottom: 4px; font-size: 14px; font-weight: 500;">Database Name <span style="color: #9ca3af; font-weight: 400; font-size: 12px;">required</span></label>
            <input type="text" id="dbName" name="dbName" value="videosite" required data-nospace
              style="width: 100%; padding: 8px 12px; border: 1px solid #d1d5db; border-radius: 6px; font-size: 14px; box-sizing: border-box;">
            <div class="field-err" data-for="dbName" style="display: none; color: #dc3545; font-size: 13px; margin-top: 4px;"></div>
          </div>

          <h2 style="margin: 24px 0 12px; font-size: 16px;">Cloudflare R2 Configuration</h2>
          <div style="margin-top: 12px;">
            <label for="r2Endpoint" style="display: block; margin-bottom: 4px; font-size: 14px; font-weight: 500;">Endpoint URL <span style="color: #9ca3af; font-weight: 400; font-size: 12px;">required</span></label>
            <input type="text" id="r2Endpoint" name="r2Endpoint" placeholder="https://ACCOUNT_ID.r2.cloudflarestorage.com" required data-nospace
              style="width: 100%; padding: 8px 12px; border: 1px solid #d1d5db; border-radius: 6px; font-size: 14px; box-sizing: border-box;">
            <div class="field-err" data-for="r2Endpoint" style="display: none; color: #dc3545; font-size: 13px; margin-top: 4px;"></div>
          </div>
          <div style="margin-top: 12px;">
            <label for="r2BucketName" style="display: block; margin-bottom: 4px; font-size: 14px; font-weight: 500;">Bucket Name <span style="color: #9ca3af; font-weight: 400; font-size: 12px;">required</span></label>
            <input type="text" id="r2BucketName" name="r2BucketName" required data-nospace
              style="width: 100%; padding: 8px 12px; border: 1px solid #d1d5db; border-radius: 6px; font-size: 14px; box-sizing: border-box;">
            <div class="field-err" data-for="r2BucketName" style="display: none; color: #dc3545; font-size: 13px; margin-top: 4px;"></div>
          </div>
          <div style="margin-top: 12px;">
            <label for="r2AccessKeyId" style="display: block; margin-bottom: 4px; font-size: 14px; font-weight: 500;">Access Key ID <span style="color: #9ca3af; font-weight: 400; font-size: 12px;">required</span></label>
            <input type="text" id="r2AccessKeyId" name="r2AccessKeyId" required data-nospace
              style="width: 100%; padding: 8px 12px; border: 1px solid #d1d5db; border-radius: 6px; font-size: 14px; box-sizing: border-box;">
            <div class="field-err" data-for="r2AccessKeyId" style="display: none; color: #dc3545; font-size: 13px; margin-top: 4px;"></div>
          </div>
          <div style="margin-top: 12px;">
            <label for="r2SecretAccessKey" style="display: block; margin-bottom: 4px; font-size: 14px; font-weight: 500;">Secret Access Key <span style="color: #9ca3af; font-weight: 400; font-size: 12px;">required</span></label>
            <input type="password" id="r2SecretAccessKey" name="r2SecretAccessKey" required data-nospace
              style="width: 100%; padding: 8px 12px; border: 1px solid #d1d5db; border-radius: 6px; font-size: 14px; box-sizing: border-box;">
            <div class="field-err" data-for="r2SecretAccessKey" style="display: none; color: #dc3545; font-size: 13px; margin-top: 4px;"></div>
          </div>
          <div style="margin-top: 12px;">
            <label for="r2PublicDomain" style="display: block; margin-bottom: 4px; font-size: 14px; font-weight: 500;">Public Domain <span style="color: #9ca3af; font-weight: 400; font-size: 12px;">required</span></label>
            <input type="text" id="r2PublicDomain" name="r2PublicDomain" placeholder="video.yourdomain.com" required data-nospace
              style="width: 100%; padding: 8px 12px; border: 1px solid #d1d5db; border-radius: 6px; font-size: 14px; box-sizing: border-box;">
            <div class="field-err" data-for="r2PublicDomain" style="display: none; color: #dc3545; font-size: 13px; margin-top: 4px;"></div>
          </div>

          <h2 style="margin: 24px 0 12px; font-size: 16px;">Site</h2>
          <div style="margin-top: 12px;">
            <label for="siteName" style="display: block; margin-bottom: 4px; font-size: 14px; font-weight: 500;">Site Name <span style="color: #9ca3af; font-weight: 400; font-size: 12px;">required</span></label>
            <input type="text" id="siteName" name="siteName" value="VideoSite" required
              style="width: 100%; max-width: 300px; padding: 8px 12px; border: 1px solid #d1d5db; border-radius: 6px; font-size: 14px; box-sizing: border-box;">
            <div class="field-err" data-for="siteName" style="display: none; color: #dc3545; font-size: 13px; margin-top: 4px;"></div>
          </div>
          <div style="margin-top: 12px;">
            <label for="siteHostname" style="display: block; margin-bottom: 4px; font-size: 14px; font-weight: 500;">Site Hostname <span style="color: #9ca3af; font-weight: 400; font-size: 12px;">required</span></label>
            <div style="display: flex; gap: 0; max-width: 400px;">
              <select id="siteProtocol" name="siteProtocol"
                style="width: 100px; padding: 8px 12px; border: 1px solid #d1d5db; border-radius: 6px 0 0 6px; font-size: 14px; box-sizing: border-box; background: #fff; flex-shrink: 0;">
                <option value="https">https://</option>
                <option value="http">http://</option>
              </select>
              <input type="text" id="siteHostname" name="siteHostname" placeholder="stream.yourdomain.com" required data-nospace
                style="flex: 1; padding: 8px 12px; border: 1px solid #d1d5db; border-left: none; border-radius: 0 6px 6px 0; font-size: 14px; box-sizing: border-box;">
            </div>
            <div class="field-err" data-for="siteHostname" style="display: none; color: #dc3545; font-size: 13px; margin-top: 4px;"></div>
          </div>

          <h2 style="margin: 24px 0 12px; font-size: 16px;">Email (SMTP) <span style="color: #9ca3af; font-weight: 400; font-size: 13px;">— optional, configure later</span></h2>
          <p style="color: #9ca3af; font-size: 13px; margin-bottom: 12px;">Required for email MFA, password reset, and invitation emails.</p>
          <div style="display: flex; gap: 8px;">
            <div style="flex: 3;">
              <label for="smtpHost" style="display: block; margin-bottom: 4px; font-size: 14px; font-weight: 500;">SMTP Host</label>
              <input type="text" id="smtpHost" name="smtpHost" placeholder="smtp.server.com" data-nospace
                style="width: 100%; padding: 8px 12px; border: 1px solid #d1d5db; border-radius: 6px; font-size: 14px; box-sizing: border-box;">
              <div class="field-err" data-for="smtpHost" style="display: none; color: #dc3545; font-size: 13px; margin-top: 4px;"></div>
            </div>
            <div style="flex: 1;">
              <label for="smtpPort" style="display: block; margin-bottom: 4px; font-size: 14px; font-weight: 500;">Port</label>
              <input type="text" id="smtpPort" name="smtpPort" value="465" data-nospace
                style="width: 100%; padding: 8px 12px; border: 1px solid #d1d5db; border-radius: 6px; font-size: 14px; box-sizing: border-box;">
              <div class="field-err" data-for="smtpPort" style="display: none; color: #dc3545; font-size: 13px; margin-top: 4px;"></div>
            </div>
          </div>
          <div style="display: flex; gap: 8px; margin-top: 12px;">
            <div style="flex: 1;">
              <label for="smtpUser" style="display: block; margin-bottom: 4px; font-size: 14px; font-weight: 500;">Username</label>
              <input type="text" id="smtpUser" name="smtpUser" data-nospace
                style="width: 100%; padding: 8px 12px; border: 1px solid #d1d5db; border-radius: 6px; font-size: 14px; box-sizing: border-box;">
              <div class="field-err" data-for="smtpUser" style="display: none; color: #dc3545; font-size: 13px; margin-top: 4px;"></div>
            </div>
            <div style="flex: 1;">
              <label for="smtpPass" style="display: block; margin-bottom: 4px; font-size: 14px; font-weight: 500;">Password</label>
              <input type="password" id="smtpPass" name="smtpPass" data-nospace
                style="width: 100%; padding: 8px 12px; border: 1px solid #d1d5db; border-radius: 6px; font-size: 14px; box-sizing: border-box;">
              <div class="field-err" data-for="smtpPass" style="display: none; color: #dc3545; font-size: 13px; margin-top: 4px;"></div>
            </div>
          </div>
          <div style="margin-top: 12px;">
            <label for="smtpSecure" style="display: block; margin-bottom: 4px; font-size: 14px; font-weight: 500;">Use SSL/TLS</label>
            <select id="smtpSecure" name="smtpSecure"
              style="width: 100%; padding: 8px 12px; border: 1px solid #d1d5db; border-radius: 6px; font-size: 14px; box-sizing: border-box; background: #fff;">
              <option value="true">Yes (port 465)</option>
              <option value="false">No (port 587 / STARTTLS)</option>
            </select>
          </div>
          <div style="margin-top: 12px;">
            <label for="smtpFromName" style="display: block; margin-bottom: 4px; font-size: 14px; font-weight: 500;">From Name</label>
            <input type="text" id="smtpFromName" name="smtpFromName" placeholder="My App"
              style="width: 100%; padding: 8px 12px; border: 1px solid #d1d5db; border-radius: 6px; font-size: 14px; box-sizing: border-box;">
          </div>
          <div style="display: flex; gap: 8px; margin-top: 12px;">
            <div style="flex: 1;">
              <label for="smtpFromAddress" style="display: block; margin-bottom: 4px; font-size: 14px; font-weight: 500;">From Address</label>
              <input type="text" id="smtpFromAddress" name="smtpFromAddress" placeholder="noreply@yourdomain.com" data-nospace
                style="width: 100%; padding: 8px 12px; border: 1px solid #d1d5db; border-radius: 6px; font-size: 14px; box-sizing: border-box;">
              <div class="field-err" data-for="smtpFromAddress" style="display: none; color: #dc3545; font-size: 13px; margin-top: 4px;"></div>
            </div>
            <div style="flex: 1;">
              <label for="smtpReplyTo" style="display: block; margin-bottom: 4px; font-size: 14px; font-weight: 500;">Reply-To Address</label>
              <input type="text" id="smtpReplyTo" name="smtpReplyTo" placeholder="support@yourdomain.com" data-nospace
                style="width: 100%; padding: 8px 12px; border: 1px solid #d1d5db; border-radius: 6px; font-size: 14px; box-sizing: border-box;">
              <div class="field-err" data-for="smtpReplyTo" style="display: none; color: #dc3545; font-size: 13px; margin-top: 4px;"></div>
            </div>
          </div>

          <h2 style="margin: 24px 0 12px; font-size: 16px;">Cloudflare Turnstile <span style="color: #9ca3af; font-weight: 400; font-size: 13px;">— optional, configure later</span></h2>
          <p style="color: #9ca3af; font-size: 13px; margin-bottom: 12px;">Bot protection for login and registration pages.</p>
          <div style="margin-top: 12px;">
            <label for="turnstileSiteKey" style="display: block; margin-bottom: 4px; font-size: 14px; font-weight: 500;">Site Key</label>
            <input type="text" id="turnstileSiteKey" name="turnstileSiteKey" data-nospace
              style="width: 100%; padding: 8px 12px; border: 1px solid #d1d5db; border-radius: 6px; font-size: 14px; box-sizing: border-box;">
            <div class="field-err" data-for="turnstileSiteKey" style="display: none; color: #dc3545; font-size: 13px; margin-top: 4px;"></div>
          </div>
          <div style="margin-top: 12px;">
            <label for="turnstileSecretKey" style="display: block; margin-bottom: 4px; font-size: 14px; font-weight: 500;">Secret Key</label>
            <input type="password" id="turnstileSecretKey" name="turnstileSecretKey" data-nospace
              style="width: 100%; padding: 8px 12px; border: 1px solid #d1d5db; border-radius: 6px; font-size: 14px; box-sizing: border-box;">
            <div class="field-err" data-for="turnstileSecretKey" style="display: none; color: #dc3545; font-size: 13px; margin-top: 4px;"></div>
          </div>

          <h2 style="margin: 24px 0 12px; font-size: 16px;">Superadmin Account</h2>
          <div style="margin-top: 12px;">
            <label for="adminUsername" style="display: block; margin-bottom: 4px; font-size: 14px; font-weight: 500;">Username <span style="color: #9ca3af; font-weight: 400; font-size: 12px;">required</span></label>
            <input type="text" id="adminUsername" name="adminUsername" required
              minlength="3" maxlength="20" pattern="[A-Za-z0-9_\\-]+"
              style="width: 100%; padding: 8px 12px; border: 1px solid #d1d5db; border-radius: 6px; font-size: 14px; box-sizing: border-box;">
            <small style="color: #9ca3af; font-size: 12px;">3\u201320 characters. Letters, digits, dashes, underscores only.</small>
            <div id="adminUsernameError" style="display: none; color: #dc3545; font-size: 13px; margin-top: 4px;"></div>
          </div>
          <div style="margin-top: 12px;">
            <label for="adminDisplayName" style="display: block; margin-bottom: 4px; font-size: 14px; font-weight: 500;">Display Name <span style="color: #9ca3af; font-weight: 400; font-size: 12px;">required</span></label>
            <input type="text" id="adminDisplayName" name="adminDisplayName" required
              maxlength="30" pattern="[A-Za-z0-9 ]+"
              style="width: 100%; padding: 8px 12px; border: 1px solid #d1d5db; border-radius: 6px; font-size: 14px; box-sizing: border-box;">
            <small style="color: #9ca3af; font-size: 12px;">Up to 30 characters. Letters, digits, and spaces only.</small>
            <div id="adminDisplayNameError" style="display: none; color: #dc3545; font-size: 13px; margin-top: 4px;"></div>
          </div>
          <div style="margin-top: 12px;">
            <label for="adminPassword" style="display: block; margin-bottom: 4px; font-size: 14px; font-weight: 500;">Password <span style="color: #9ca3af; font-weight: 400; font-size: 12px;">required</span></label>
            <input type="password" id="adminPassword" name="adminPassword" required minlength="8"
              style="width: 100%; padding: 8px 12px; border: 1px solid #d1d5db; border-radius: 6px; font-size: 14px; box-sizing: border-box;">
            <small style="color: #9ca3af; font-size: 12px;">Min 8 characters, no spaces. Must include 3 of: uppercase, lowercase, digits, special characters.</small>
            <div id="adminPasswordError" style="display: none; color: #dc3545; font-size: 13px; margin-top: 4px;"></div>
          </div>
          <div style="margin-top: 12px;">
            <label for="adminPasswordConfirm" style="display: block; margin-bottom: 4px; font-size: 14px; font-weight: 500;">Confirm Password <span style="color: #9ca3af; font-weight: 400; font-size: 12px;">required</span></label>
            <input type="password" id="adminPasswordConfirm" name="adminPasswordConfirm" required minlength="8"
              style="width: 100%; padding: 8px 12px; border: 1px solid #d1d5db; border-radius: 6px; font-size: 14px; box-sizing: border-box;">
            <div id="adminPasswordConfirmError" style="display: none; color: #dc3545; font-size: 13px; margin-top: 4px;"></div>
          </div>

          <button type="submit" id="installBtn" disabled
            style="width: 100%; margin-top: 20px; padding: 10px; background: #3b82f6; color: #fff; border: none; border-radius: 6px; font-size: 14px; font-weight: 500; cursor: pointer; opacity: 0.5;">
            Install
          </button>
        </form>
      </div>
    </main>
  `;

  var form = document.getElementById('installForm');
  var errorDiv = document.getElementById('installError');
  var installBtn = document.getElementById('installBtn');

  // Strip protocol/path from hostname fields on blur
  function stripToHostname(el) {
    el.addEventListener('blur', function() {
      this.value = this.value.trim().replace(/^https?:\/\//, '').split('/')[0];
    });
  }
  stripToHostname(document.getElementById('siteHostname'));
  stripToHostname(document.getElementById('smtpHost'));
  stripToHostname(document.getElementById('r2PublicDomain'));

  // Auto-extract bucket name from endpoint URL on blur
  document.getElementById('r2Endpoint').addEventListener('blur', function() {
    try {
      var u = new URL(this.value.trim());
      var p = u.pathname.replace(/^\/+|\/+$/g, '');
      if (p) {
        var b = document.getElementById('r2BucketName');
        if (!b.value) b.value = p;
        this.value = u.origin;
      }
    } catch (e) {}
  });

  // Field error helper
  var errorBorder = '1px solid #dc3545';
  var normalBorder = '1px solid #d1d5db';
  function showFieldError(input, errorDiv, msg) {
    errorDiv.textContent = msg;
    errorDiv.style.display = msg ? 'block' : 'none';
    input.style.border = msg ? errorBorder : normalBorder;
  }

  // Superadmin field blur validation
  var usernameInput = document.getElementById('adminUsername');
  var usernameErr = document.getElementById('adminUsernameError');
  usernameInput.addEventListener('blur', function() {
    var v = this.value.trim();
    if (!v) { showFieldError(this, usernameErr, 'Username is required.'); return; }
    if (v.length < 3 || v.length > 20) { showFieldError(this, usernameErr, 'Username must be between 3 and 20 characters.'); return; }
    if (!/^[A-Za-z0-9_-]+$/.test(v)) { showFieldError(this, usernameErr, 'Only letters, digits, dashes, and underscores allowed.'); return; }
    if (['root', 'admin', 'superadmin'].indexOf(v.toLowerCase()) !== -1) { showFieldError(this, usernameErr, 'Username cannot be "root", "admin", or "superadmin".'); return; }
    showFieldError(this, usernameErr, '');
  });

  var displayNameInput = document.getElementById('adminDisplayName');
  var displayNameErr = document.getElementById('adminDisplayNameError');
  displayNameInput.addEventListener('blur', function() {
    var v = this.value.trim();
    if (!v) { showFieldError(this, displayNameErr, 'Display name is required.'); return; }
    if (v.length > 30) { showFieldError(this, displayNameErr, 'Display name must be 30 characters or fewer.'); return; }
    if (!/^[A-Za-z0-9 ]+$/.test(v)) { showFieldError(this, displayNameErr, 'Only letters, digits, and spaces allowed.'); return; }
    showFieldError(this, displayNameErr, '');
  });

  var passwordInput = document.getElementById('adminPassword');
  var passwordErr = document.getElementById('adminPasswordError');
  var confirmInput = document.getElementById('adminPasswordConfirm');
  var confirmErr = document.getElementById('adminPasswordConfirmError');

  function validatePassword() {
    var pw = passwordInput.value;
    if (!pw) { showFieldError(passwordInput, passwordErr, 'Password is required.'); return; }
    if (pw.length < 8) { showFieldError(passwordInput, passwordErr, 'Password must be at least 8 characters.'); return; }
    if (pw.indexOf(' ') !== -1) { showFieldError(passwordInput, passwordErr, 'Password cannot contain spaces.'); return; }
    var cats = 0;
    if (/[A-Z]/.test(pw)) cats++;
    if (/[a-z]/.test(pw)) cats++;
    if (/[0-9]/.test(pw)) cats++;
    if (/[^A-Za-z0-9]/.test(pw)) cats++;
    if (cats < 3) { showFieldError(passwordInput, passwordErr, 'Must include at least 3 of: uppercase, lowercase, digits, special characters.'); return; }
    showFieldError(passwordInput, passwordErr, '');
    // Re-validate confirm if it has a value
    if (confirmInput.value) validateConfirm();
  }

  function validateConfirm() {
    var c = confirmInput.value;
    if (!c) { showFieldError(confirmInput, confirmErr, 'Please confirm your password.'); return; }
    if (c !== passwordInput.value) { showFieldError(confirmInput, confirmErr, 'Passwords do not match.'); return; }
    showFieldError(confirmInput, confirmErr, '');
  }

  passwordInput.addEventListener('blur', validatePassword);
  confirmInput.addEventListener('blur', validateConfirm);

  // Block spaces in password fields
  passwordInput.addEventListener('keydown', function(e) { if (e.key === ' ') e.preventDefault(); });
  confirmInput.addEventListener('keydown', function(e) { if (e.key === ' ') e.preventDefault(); });

  // No-space blur validation for all data-nospace inputs + required empty check for non-superadmin
  var superadminIds = ['adminUsername', 'adminDisplayName', 'adminPassword', 'adminPasswordConfirm'];
  var nospaceInputs = form.querySelectorAll('input[data-nospace]');
  for (var g = 0; g < nospaceInputs.length; g++) {
    (function(input) {
      var errDiv = form.querySelector('.field-err[data-for="' + input.id + '"]');
      input.addEventListener('blur', function() {
        var v = this.value;
        if (this.hasAttribute('required') && !v.trim()) {
          this.style.border = errorBorder;
          if (errDiv) { errDiv.textContent = 'This field is required.'; errDiv.style.display = 'block'; }
        } else if (v && /\s/.test(v)) {
          this.style.border = errorBorder;
          if (errDiv) { errDiv.textContent = 'Spaces are not allowed.'; errDiv.style.display = 'block'; }
        } else {
          this.style.border = normalBorder;
          if (errDiv) { errDiv.textContent = ''; errDiv.style.display = 'none'; }
        }
      });
      input.addEventListener('input', function() {
        if (!(/\s/.test(this.value)) && (!this.hasAttribute('required') || this.value.trim())) {
          this.style.border = normalBorder;
          if (errDiv) { errDiv.textContent = ''; errDiv.style.display = 'none'; }
        }
      });
    })(nospaceInputs[g]);
  }

  // Required empty check for non-superadmin, non-nospace required fields (siteName)
  var genericRequired = form.querySelectorAll('input[required]:not([data-nospace])');
  for (var gr = 0; gr < genericRequired.length; gr++) {
    if (superadminIds.indexOf(genericRequired[gr].id) === -1) {
      (function(input) {
        var errDiv = form.querySelector('.field-err[data-for="' + input.id + '"]');
        input.addEventListener('blur', function() {
          if (!this.value.trim()) {
            this.style.border = errorBorder;
            if (errDiv) { errDiv.textContent = 'This field is required.'; errDiv.style.display = 'block'; }
          } else {
            this.style.border = normalBorder;
            if (errDiv) { errDiv.textContent = ''; errDiv.style.display = 'none'; }
          }
        });
        input.addEventListener('input', function() {
          if (this.value.trim()) {
            this.style.border = normalBorder;
            if (errDiv) { errDiv.textContent = ''; errDiv.style.display = 'none'; }
          }
        });
      })(genericRequired[gr]);
    }
  }

  // Install button state: disabled until all required fields filled and no validation errors on any field
  function updateInstallBtn() {
    var requiredInputs = form.querySelectorAll('input[required]');
    var allFilled = true;
    for (var i = 0; i < requiredInputs.length; i++) {
      if (!requiredInputs[i].value.trim()) { allFilled = false; break; }
    }
    var hasErrors = false;
    var allInputs = form.querySelectorAll('input');
    for (var j = 0; j < allInputs.length; j++) {
      if (allInputs[j].style.border === errorBorder) { hasErrors = true; break; }
    }
    var enabled = allFilled && !hasErrors;
    installBtn.disabled = !enabled;
    installBtn.style.opacity = enabled ? '1' : '0.5';
    installBtn.style.cursor = enabled ? 'pointer' : 'not-allowed';
  }

  // Listen on all inputs for input + blur to update button state
  var allInputs = form.querySelectorAll('input');
  for (var r = 0; r < allInputs.length; r++) {
    allInputs[r].addEventListener('input', updateInstallBtn);
    allInputs[r].addEventListener('blur', function() {
      // Defer so field blur validators run first
      setTimeout(updateInstallBtn, 0);
    });
  }

  form.addEventListener('submit', async function(e) {
    e.preventDefault();
    errorDiv.style.display = 'none';
    installBtn.disabled = true;
    installBtn.style.opacity = '0.5';
    installBtn.style.cursor = 'not-allowed';
    installBtn.textContent = 'Installing...';

    var body = {};
    var inputs = form.querySelectorAll('input, select');
    for (var i = 0; i < inputs.length; i++) {
      if (inputs[i].name) body[inputs[i].name] = inputs[i].value;
    }

    try {
      var resp = await fetch('/api/install', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });

      var data = null;
      var ct = resp.headers.get('content-type') || '';
      if (ct.indexOf('application/json') !== -1) {
        data = await resp.json();
      }

      if (resp.ok && data && data.success) {
        window.location.href = '/login';
        return;
      }

      var msg = (data && data.error) || 'Installation failed. Please check your configuration.';
      errorDiv.textContent = msg;
      errorDiv.style.display = 'block';
    } catch (err) {
      errorDiv.textContent = 'Unable to reach the server. Please check your connection.';
      errorDiv.style.display = 'block';
    }

    installBtn.textContent = 'Install';
    updateInstallBtn();
  });
})();
