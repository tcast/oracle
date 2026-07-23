#!/usr/bin/env node
/**
 * Import LinkedIn cookie accounts (JSONL) — DB + proxy bind only. No browser.
 *
 * Each line:
 *   { username, password, email, email_password, user_agent, cookies: [...] }
 *
 * Cookies are normalized for Playwright (expires, sameSite). UA is stored as a
 * sticky Android device_profile so first session matches the export fingerprint.
 *
 * Usage (in container):
 *   node src/scripts/import-linkedin-cookie-accounts.js /app/private/linkedin-cookie-accounts-2026-07-23.jsonl
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const pool = require('../services/db');

const PROXY_PROVIDER = process.env.LINKEDIN_PROXY_PROVIDER || 'ProxyBase';
const BATCH_TAG = process.env.LINKEDIN_IMPORT_BATCH || '2026-07-23-cookies';

function normalizeSameSite(v) {
  const s = String(v || '').toLowerCase();
  if (s === 'no_restriction' || s === 'none') return 'None';
  if (s === 'lax') return 'Lax';
  if (s === 'strict') return 'Strict';
  return undefined; // omit Unspecified / junk
}

/** Chrome-export cookies → Playwright addCookies shape. */
function normalizeCookies(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const c of raw) {
    if (!c || !c.name || c.value == null) continue;
    let domain = String(c.domain || '').trim();
    if (!domain) continue;
    // Keep LinkedIn + auth-related only; skip ad trackers that confuse context.
    const d = domain.replace(/^\./, '');
    if (
      !/(^|\.)linkedin\.com$/i.test(d) &&
      !/(^|\.)www\.linkedin\.com$/i.test(d)
    ) {
      continue;
    }
    const key = `${domain}|${c.name}|${c.path || '/'}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const entry = {
      name: c.name,
      value: String(c.value),
      domain,
      path: c.path || '/',
      secure: !!c.secure,
      httpOnly: !!c.httpOnly,
    };
    const ss = normalizeSameSite(c.sameSite);
    if (ss) entry.sameSite = ss;

    const exp = c.expirationDate != null ? Number(c.expirationDate) : (c.expires != null ? Number(c.expires) : null);
    // Chrome uses -62135596800 for session; Playwright wants omit or -1
    if (exp != null && Number.isFinite(exp) && exp > 0) {
      entry.expires = Math.floor(exp);
    }
    out.push(entry);
  }
  return out;
}

function mobileProfileFromUa(ua) {
  const userAgent = String(ua || '').trim();
  return {
    label: 'import-android-chrome',
    platform: 'android',
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 2.625,
    userAgent:
      userAgent ||
      'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Mobile Safari/537.36',
    viewport: { width: 412, height: 915 },
    screen: { width: 412, height: 915, availWidth: 412, availHeight: 915, colorDepth: 24, pixelDepth: 24 },
    maxTouchPoints: 5,
    hardwareConcurrency: 8,
    deviceMemory: 8,
    webglVendor: 'Qualcomm',
    webglRenderer: 'Adreno (TM) 730',
    sticky_import_ua: true,
  };
}

async function pickFreshProxyId(client) {
  const { rows } = await client.query(
    `SELECT p.id
     FROM proxies p
     WHERE p.is_active = true
       AND lower(p.provider) = lower($1)
       AND (p.cooldown_until IS NULL OR p.cooldown_until <= NOW())
       AND COALESCE(p.consecutive_failures, 0) < 3
       AND COALESCE(p.last_health_ok, true) = true
       AND NOT EXISTS (
         SELECT 1 FROM social_account_proxies sap
         WHERE sap.proxy_id = p.id AND sap.is_active = true
       )
     ORDER BY p.failure_count ASC, p.last_used_at ASC NULLS FIRST, p.id ASC
     FOR UPDATE SKIP LOCKED
     LIMIT 1`,
    [PROXY_PROVIDER]
  );
  return rows[0] ? rows[0].id : null;
}

async function upsertAccount(row) {
  const username = row.username;
  const cookies = normalizeCookies(row.cookies);
  const hasLiAt = cookies.some((c) => c.name === 'li_at');
  if (!hasLiAt) throw new Error('no li_at cookie after normalize');

  const credentials = {
    password: row.password,
    email: row.email,
    email_password: row.email_password || null,
    profile_url: `https://www.linkedin.com/in/${username}/`,
    source: 'manual_cookie_import',
    import_batch: BATCH_TAG,
    has_cookies: true,
    cookie_only: false, // password present for emergency, but probes use allowLogin:false
    prefer_cookie_session: true,
    organic_enabled: false,
  };
  const deviceProfile = mobileProfileFromUa(row.user_agent);

  const existing = await pool.query(
    `SELECT id, credentials FROM social_accounts
     WHERE platform = 'linkedin' AND (lower(username) = lower($1) OR lower(email) = lower($2))
     LIMIT 1`,
    [username, row.email]
  );

  let accountId;
  let created;
  if (existing.rows[0]) {
    accountId = existing.rows[0].id;
    const prev =
      typeof existing.rows[0].credentials === 'string'
        ? JSON.parse(existing.rows[0].credentials)
        : existing.rows[0].credentials || {};
    const merged = { ...prev, ...credentials };
    await pool.query(
      `UPDATE social_accounts
       SET username = $2, email = $3, credentials = $4::jsonb,
           device_profile = $5::jsonb, status = 'active', is_simulated = false,
           warmup_status = 'pending', updated_at = NOW()
       WHERE id = $1`,
      [accountId, username, row.email, JSON.stringify(merged), JSON.stringify(deviceProfile)]
    );
    created = false;
  } else {
    const ins = await pool.query(
      `INSERT INTO social_accounts
         (platform, username, email, credentials, device_profile, status, is_simulated, warmup_status)
       VALUES ('linkedin', $1, $2, $3::jsonb, $4::jsonb, 'active', false, 'pending')
       RETURNING id`,
      [username, row.email, JSON.stringify(credentials), JSON.stringify(deviceProfile)]
    );
    accountId = ins.rows[0].id;
    created = true;
  }

  await pool.query(
    `INSERT INTO browser_sessions (account_id, platform, cookies, session_data, user_agent)
     VALUES ($1, 'linkedin', $2::jsonb, '{}'::jsonb, $3)
     ON CONFLICT (account_id, platform)
     DO UPDATE SET cookies = $2::jsonb, user_agent = $3, updated_at = NOW()`,
    [accountId, JSON.stringify(cookies), deviceProfile.userAgent]
  );

  return { accountId, created, cookieCount: cookies.length, username };
}

async function bindProxyIfMissing(accountId) {
  const has = await pool.query(
    `SELECT 1 FROM social_account_proxies
     WHERE social_account_id = $1 AND is_active = true LIMIT 1`,
    [accountId]
  );
  if (has.rows.length) return { already: true };

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const proxyId = await pickFreshProxyId(client);
    if (!proxyId) {
      await client.query('ROLLBACK');
      return { exhausted: true };
    }
    const existingPair = await client.query(
      `SELECT id FROM social_account_proxies
       WHERE social_account_id = $1 AND proxy_id = $2 LIMIT 1`,
      [accountId, proxyId]
    );
    if (existingPair.rows[0]) {
      await client.query(
        `UPDATE social_account_proxies
         SET is_active = true, priority = 1, assigned_at = NOW()
         WHERE id = $1`,
        [existingPair.rows[0].id]
      );
    } else {
      await client.query(
        `INSERT INTO social_account_proxies (social_account_id, proxy_id, priority, is_active)
         VALUES ($1, $2, 1, true)`,
        [accountId, proxyId]
      );
    }
    await client.query('COMMIT');
    return { proxyId };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

async function main() {
  const file = process.argv[2];
  if (!file || !fs.existsSync(file)) {
    console.error('Usage: node src/scripts/import-linkedin-cookie-accounts.js <jsonl>');
    process.exit(1);
  }
  const lines = fs.readFileSync(path.resolve(file), 'utf8').split(/\r?\n/).filter(Boolean);
  console.log(`Importing ${lines.length} LinkedIn cookie accounts (batch=${BATCH_TAG}, provider=${PROXY_PROVIDER})`);

  const results = [];
  for (const line of lines) {
    let row;
    try {
      row = JSON.parse(line);
    } catch (e) {
      console.error(`SKIP bad json: ${e.message}`);
      continue;
    }
    try {
      const up = await upsertAccount(row);
      const px = await bindProxyIfMissing(up.accountId);
      const rec = {
        id: up.accountId,
        username: up.username,
        created: up.created,
        cookies: up.cookieCount,
        proxy: px.proxyId || (px.already ? 'kept' : px.exhausted ? 'EXHAUSTED' : '?'),
      };
      results.push(rec);
      console.log(JSON.stringify(rec));
      if (px.exhausted) {
        console.warn('Proxy pool exhausted — stopping further binds');
        break;
      }
    } catch (e) {
      console.error(`FAIL ${row.username || row.email}: ${e.message}`);
      results.push({ username: row.username, error: e.message });
    }
  }

  console.log(`\nDone: ${results.filter((r) => r.id).length}/${lines.length} imported`);
  await pool.end().catch(() => {});
}

main().catch(async (e) => {
  console.error(e);
  await pool.end().catch(() => {});
  process.exit(1);
});
