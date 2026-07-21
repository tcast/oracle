const crypto = require('crypto');

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Decode(input) {
  const cleaned = String(input || '')
    .replace(/[\s\-]/g, '')
    .toUpperCase()
    .replace(/[^A-Z2-7]/g, '');
  if (!cleaned) return Buffer.alloc(0);

  let bits = '';
  for (const char of cleaned) {
    const val = BASE32.indexOf(char);
    if (val < 0) continue;
    bits += val.toString(2).padStart(5, '0');
  }

  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.slice(i, i + 8), 2));
  }
  return Buffer.from(bytes);
}

/**
 * Seconds left in the current TOTP window (1..step).
 */
function totpSecondsRemaining({ step = 30, now = Date.now() } = {}) {
  const elapsed = Math.floor(now / 1000) % step;
  return step - elapsed;
}

/**
 * Generate a 6-digit TOTP code (RFC 6238, SHA1, 30s).
 * Same algorithm Google Authenticator / Authy use for base32 secrets.
 */
function generateTotp(secret, { step = 30, digits = 6, now = Date.now() } = {}) {
  const key = base32Decode(secret);
  if (!key.length) throw new Error('Invalid TOTP secret');

  const counter = Math.floor(now / 1000 / step);
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  buf.writeUInt32BE(counter & 0xffffffff, 4);

  const hmac = crypto.createHmac('sha1', key).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  const code =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);

  return String(code % 10 ** digits).padStart(digits, '0');
}

module.exports = { generateTotp, base32Decode, totpSecondsRemaining };
