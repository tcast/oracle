/**
 * Credential gate for social account imports / self-create.
 * Rejects packs missing a real password + TOTP; prefers email access when linked.
 */

const WEAK_PASSWORDS = new Set(['', 'default_password', 'password', 'changeme']);

function isBase32Totp(secret) {
  const cleaned = String(secret || '')
    .replace(/[\s\-]/g, '')
    .toUpperCase();
  return cleaned.length >= 16 && /^[A-Z2-7]+$/.test(cleaned);
}

/**
 * @param {object} row - Import row fields
 * @param {object} opts
 * @param {boolean} [opts.requireTotp=true]
 * @param {boolean} [opts.requireEmailPassword=false] - hard-require email inbox password
 * @param {boolean} [opts.preferEmailAccess=true] - flag (not reject) when email set but no email_password
 * @returns {{ ok: boolean, errors: string[], warnings: string[] }}
 */
function validateImportCredentials(row = {}, opts = {}) {
  const {
    requireTotp = true,
    requireEmailPassword = false,
    preferEmailAccess = true,
  } = opts;

  const errors = [];
  const warnings = [];

  const password = row.password != null ? String(row.password).trim() : '';
  if (!password || WEAK_PASSWORDS.has(password.toLowerCase())) {
    errors.push('missing or weak password');
  }

  const totp =
    row.totp_secret || row.totp || row.twofa || row.two_factor_secret || null;
  if (requireTotp) {
    if (!isBase32Totp(totp)) {
      errors.push('missing or invalid totp_secret (need base32, >=16 chars)');
    }
  } else if (totp && !isBase32Totp(totp)) {
    warnings.push('totp_secret present but not valid base32');
  }

  const email = row.email != null ? String(row.email).trim() : '';
  const emailPassword =
    row.email_password != null ? String(row.email_password).trim() : '';

  if (requireEmailPassword && !emailPassword) {
    errors.push('missing email_password');
  } else if (preferEmailAccess && email && !emailPassword) {
    warnings.push('email present without email_password (inbox access preferred)');
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    totp_secret: isBase32Totp(totp) ? String(totp).replace(/[\s\-]/g, '').toUpperCase() : null,
  };
}

function assertImportCredentials(row, opts = {}) {
  const result = validateImportCredentials(row, opts);
  if (!result.ok) {
    const who = row.username || row.email || 'row';
    throw new Error(`Credential gate rejected ${who}: ${result.errors.join('; ')}`);
  }
  return result;
}

module.exports = {
  validateImportCredentials,
  assertImportCredentials,
  isBase32Totp,
};
