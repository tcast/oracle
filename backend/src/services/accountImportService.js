/**
 * Unified social account import (X / Instagram / TikTok / LinkedIn).
 * Parses vendor dump formats, upserts accounts + sessions, assigns proxies,
 * optionally smoke-verifies sessions, and enables organic jobs when live.
 */
const pool = require('./db');
const proxyService = require('./proxyService');
const playwrightService = require('./playwrightService');
const organicCommentService = require('./organicCommentService');
const { assertImportCredentials } = require('../utils/credentialGate');

const SUPPORTED = ['x', 'instagram', 'tiktok', 'linkedin'];

const FORMAT_HELP = {
  x:
    'COOKIE-ONLY (recommended): username----auth_token----ct0 [----guest_id] ' +
    'OR JSON array [{"username","auth_token","ct0","guest_id"}]. ' +
    'Legacy password dumps still work: ' +
    'username----password----email|email_password|auth_token|batch_uuid----totp_secret----ct0 ' +
    'OR username----password----email----email_password----totp----auth_token[----ct0]',
  instagram: 'username:password:totp_secret:email:email_password',
  tiktok: 'username,password[,email]',
  linkedin: 'email:linkedin_password:email_password:totp_secret:profile_url',
};

function looksLikeXAuthToken(token) {
  const t = String(token || '').trim();
  if (!t) return false;
  if (t.startsWith('M.')) return true;
  // Fresh dumps / DevTools exports ship 40+ hex auth_token without the AccsMarket M. prefix
  return /^[0-9a-f]{40,}$/i.test(t);
}

// Modern X ct0 (CSRF) cookies are 40 hex historically but now commonly 160 hex.
function looksLikeCt0(token) {
  return /^[0-9a-f]{32,}$/i.test(String(token || '').trim());
}

// guest_id looks like "v1%3A123456789012345678" (URL-encoded) or the decoded "v1:...".
function looksLikeGuestId(token) {
  const t = String(token || '').trim();
  return /^v1(%3A|:)\d{8,}$/i.test(t) || /^\d{15,}$/.test(t);
}

/**
 * Build the Playwright cookie array X expects. Emits each cookie on BOTH
 * `.x.com` and `.twitter.com` so restoreSession/verifySessionAlive/posting all
 * see a live session regardless of which host X redirects to. auth_token stays
 * httpOnly; ct0 (CSRF) is readable by JS; guest_id optional.
 */
function buildXCookies(authToken, ct0, guestId) {
  const base = { path: '/', secure: true };
  const domains = ['.x.com', '.twitter.com'];
  const cookies = [];
  for (const domain of domains) {
    cookies.push({
      ...base,
      name: 'auth_token',
      value: String(authToken).trim(),
      domain,
      httpOnly: true,
      sameSite: 'None',
    });
    if (ct0 && looksLikeCt0(ct0)) {
      cookies.push({
        ...base,
        name: 'ct0',
        value: String(ct0).trim(),
        domain,
        httpOnly: false,
        sameSite: 'Lax',
      });
    }
    if (guestId) {
      cookies.push({
        ...base,
        name: 'guest_id',
        value: String(guestId).trim(),
        domain,
        httpOnly: false,
        sameSite: 'None',
      });
    }
  }
  return cookies;
}

/**
 * Cookie-only X row: no password / TOTP. The user logged in manually on a clean
 * IP and exported auth_token + ct0 (+ optional guest_id). We never automate
 * X password login for these — cookies are the whole credential.
 *
 * Accepted line shapes (2–4 `----` fields, auth_token in field 2):
 *   username----auth_token
 *   username----auth_token----ct0
 *   username----auth_token----ct0----guest_id   (extra fields tolerated)
 * The ct0 / guest_id fields are classified by shape, not position, so order is forgiving.
 */
function parseXCookieOnlyRow(username, extras) {
  let ct0 = '';
  let guest_id = '';
  for (const field of extras) {
    const v = String(field || '').trim();
    if (!v) continue;
    if (!ct0 && looksLikeCt0(v)) ct0 = v;
    else if (!guest_id && looksLikeGuestId(v)) guest_id = v;
  }
  return {
    username: String(username || '').trim(),
    auth_token: undefined, // set by caller
    ct0,
    guest_id,
    cookieOnly: true,
  };
}

function parseXLine(line) {
  const raw = String(line || '').trim();
  if (!raw || raw.startsWith('#')) return null;
  const dash = raw.split('----').map((s) => s.trim());

  // Cookie-only path: short line (2–4 fields) with the auth_token in field 2.
  // Distinguishes cleanly from the 5/6/7-field password dumps (password in field 2).
  if (dash.length >= 2 && dash.length <= 4 && looksLikeXAuthToken(dash[1])) {
    const username = dash[0];
    if (!username) throw new Error('Missing username');
    const row = parseXCookieOnlyRow(username, dash.slice(2));
    row.auth_token = dash[1];
    if (row.ct0 && !looksLikeCt0(row.ct0)) {
      throw new Error(`ct0 must be 32+ hex when present, got len=${row.ct0.length}`);
    }
    return row;
  }

  let username;
  let password;
  let email;
  let email_password;
  let auth_token;
  let batch_uuid = '';
  let totp_secret;
  let ct0 = '';

  if (dash.length === 5 && dash[2].includes('|')) {
    // AccsMarket: username----password----email|email_pass|auth_token|batch----totp----ct0
    username = dash[0].trim();
    password = dash[1].trim();
    const mid = dash[2].split('|');
    if (mid.length !== 4) {
      throw new Error(`Expected email|email_pass|auth_token|batch_uuid, got ${mid.length} pipe fields`);
    }
    email = mid[0].trim();
    email_password = mid[1].trim();
    auth_token = mid[2].trim();
    batch_uuid = mid[3].trim();
    totp_secret = dash[3].trim();
    ct0 = dash[4].trim();
  } else if (dash.length === 6 || dash.length === 7) {
    // Flat: username----password----email----email_password----totp----auth_token[----ct0]
    username = dash[0].trim();
    password = dash[1].trim();
    email = dash[2].trim();
    email_password = dash[3].trim();
    totp_secret = dash[4].trim();
    auth_token = dash[5].trim();
    ct0 = (dash[6] || '').trim();
  } else {
    throw new Error(
      `Expected 5 (pipe mid) or 6–7 ---- fields, got ${dash.length}`
    );
  }

  if (!username || !password) throw new Error('Missing username/password');
  if (!/@/.test(email)) throw new Error(`Invalid email: ${email}`);
  if (!looksLikeXAuthToken(auth_token)) {
    throw new Error('auth_token does not look like X cookie (need M.* or 40+ hex)');
  }
  if (ct0 && !looksLikeCt0(ct0)) {
    throw new Error(`ct0 must be 32+ hex when present, got len=${ct0.length}`);
  }
  const row = {
    username,
    password,
    email,
    email_password,
    auth_token,
    batch_uuid,
    totp_secret,
    ct0,
  };
  assertImportCredentials(row, { requireTotp: true, preferEmailAccess: true });
  return row;
}

function parseInstagramLine(line) {
  const raw = String(line || '').trim();
  if (!raw || raw.startsWith('#')) return null;
  const parts = raw.split(':');
  if (parts.length < 5) {
    throw new Error(`Expected username:password:totp:email:email_password, got ${parts.length} fields`);
  }
  const [username, password, totp_secret, email, ...rest] = parts;
  const email_password = rest.join(':');
  const row = { username, password, totp_secret, email, email_password };
  assertImportCredentials(row, { requireTotp: true, preferEmailAccess: true });
  return row;
}

function parseTikTokLine(line) {
  const raw = String(line || '').trim();
  if (!raw || raw.startsWith('#')) return null;
  const parts = raw.split(',');
  if (parts.length < 2) {
    throw new Error(`Expected username,password[,email], got ${parts.length} fields`);
  }
  const username = parts[0].trim();
  const password = parts[1].trim();
  const email = (parts[2] || '').trim() || null;
  if (!username || !password) throw new Error(`Invalid line: ${raw.slice(0, 40)}`);
  assertImportCredentials(
    { username, password, email },
    { requireTotp: false, preferEmailAccess: false }
  );
  return { username, password, email };
}

function parseLinkedInLine(line) {
  const raw = String(line || '').trim();
  if (!raw || raw.startsWith('#')) return null;
  const parts = raw.split(':');
  if (parts.length < 5) {
    throw new Error(`Expected email:pass:email_pass:totp:profile_url, got ${parts.length} fields`);
  }
  const email = parts[0];
  const password = parts[1];
  const email_password = parts[2];
  const totp_secret = parts[3];
  const profile_url = parts.slice(4).join(':');
  if (!/@/.test(email)) throw new Error(`Invalid email: ${email}`);
  if (!/linkedin\.com/i.test(profile_url)) throw new Error(`Invalid profile URL: ${profile_url}`);
  const row = { email, password, email_password, totp_secret, profile_url };
  assertImportCredentials(row, { requireTotp: true, preferEmailAccess: true });
  return row;
}

function slugFromProfile(url) {
  const m = String(url).match(/linkedin\.com\/in\/([^\/?#]+)/i);
  return m ? m[1] : null;
}

function parseLine(platform, line) {
  switch (platform) {
    case 'x':
      return parseXLine(line);
    case 'instagram':
      return parseInstagramLine(line);
    case 'tiktok':
      return parseTikTokLine(line);
    case 'linkedin':
      return parseLinkedInLine(line);
    default:
      throw new Error(`Unsupported platform: ${platform}`);
  }
}

class AccountImportService {
  getFormats() {
    return { ...FORMAT_HELP };
  }

  async takeProxiesFromPendingShells(needed) {
    if (needed <= 0) return [];
    const shells = await pool.query(
      `SELECT sa.id AS account_id, sap.proxy_id
       FROM social_accounts sa
       JOIN social_account_proxies sap ON sap.social_account_id = sa.id AND sap.is_active = true
       WHERE sa.status = 'pending_setup'
       ORDER BY sa.id
       LIMIT $1`,
      [needed]
    );
    const proxyIds = [];
    for (const row of shells.rows) {
      await pool.query(
        `UPDATE social_account_proxies SET is_active = false
         WHERE social_account_id = $1 AND proxy_id = $2`,
        [row.account_id, row.proxy_id]
      );
      await pool.query(`DELETE FROM social_account_proxies WHERE social_account_id = $1`, [
        row.account_id,
      ]);
      await pool.query(
        `DELETE FROM social_accounts WHERE id = $1 AND status = 'pending_setup'`,
        [row.account_id]
      );
      proxyIds.push(row.proxy_id);
    }
    return proxyIds;
  }

  async takeFreeProxies(needed, { preferIspProxy4 = true } = {}) {
    if (needed <= 0) return [];
    // Prefer free healthy BrightData isp_proxy4; skip cooled / degraded.
    const free = await pool.query(
      `SELECT p.id
       FROM proxies p
       WHERE p.is_active = true
         AND (p.cooldown_until IS NULL OR p.cooldown_until <= NOW())
         AND COALESCE(p.consecutive_failures, 0) < 3
         AND COALESCE(p.last_health_ok, true) = true
         AND NOT EXISTS (
           SELECT 1 FROM social_account_proxies sap
           WHERE sap.proxy_id = p.id AND sap.is_active = true
         )
       ORDER BY
         CASE
           WHEN $2::boolean
             AND p.provider ILIKE '%brightdata%'
             AND COALESCE(p.metadata->>'zone', '') = 'isp_proxy4'
             THEN 0
           WHEN p.provider ILIKE '%brightdata%'
             AND COALESCE(p.metadata->>'zone', '') IN ('isp_proxy3', 'isp_proxy4')
             THEN 1
           ELSE 2
         END,
         p.failure_count ASC NULLS FIRST,
         p.id
       LIMIT $1`,
      [needed, preferIspProxy4]
    );
    return free.rows.map((r) => r.id);
  }

  async assignProxy(accountId, proxyId) {
    if (!proxyId) return;
    await pool.query(
      `UPDATE social_account_proxies SET is_active = false
       WHERE social_account_id = $1 AND is_active = true`,
      [accountId]
    );
    await proxyService.assignProxiesToAccount(accountId, [proxyId]);
  }

  async upsertX(row, proxyId) {
    // Cookie-only imports carry no password/TOTP — the exported cookies ARE the
    // credential. Merge (don't clobber) with any credentials already on file so
    // re-importing fresh cookies for an existing password account keeps both.
    const cookieOnly = !!row.cookieOnly;
    const existing = await pool.query(
      `SELECT id, credentials FROM social_accounts
       WHERE platform = 'x' AND lower(username) = lower($1) LIMIT 1`,
      [row.username]
    );
    const prior = existing.rows[0]
      ? (typeof existing.rows[0].credentials === 'string'
          ? JSON.parse(existing.rows[0].credentials)
          : existing.rows[0].credentials) || {}
      : {};

    const credentials = {
      ...prior,
      auth_token: row.auth_token || prior.auth_token,
      ct0: row.ct0 || prior.ct0,
      guest_id: row.guest_id || prior.guest_id,
      source: cookieOnly ? 'api_import_cookie_only' : 'api_import',
      has_cookies: true,
      cookie_only: cookieOnly || prior.cookie_only === true,
    };
    if (!cookieOnly) {
      credentials.password = row.password;
      credentials.email = row.email;
      credentials.email_password = row.email_password;
      credentials.totp_secret = row.totp_secret;
      credentials.batch_uuid = row.batch_uuid;
    }
    const email = cookieOnly ? (row.email || prior.email || null) : row.email;

    let accountId;
    if (existing.rows[0]) {
      accountId = existing.rows[0].id;
      await pool.query(
        `UPDATE social_accounts
         SET email = COALESCE($2, email), credentials = $3::jsonb, status = 'active',
             is_simulated = false,
             warmup_status = CASE
               WHEN warmup_status IN ('new', 'failed') THEN 'pending'
               ELSE warmup_status END,
             updated_at = NOW()
         WHERE id = $1`,
        [accountId, email, JSON.stringify(credentials)]
      );
    } else {
      const inserted = await pool.query(
        `INSERT INTO social_accounts
           (platform, username, email, credentials, status, is_simulated, warmup_status)
         VALUES ('x', $1, $2, $3::jsonb, 'active', false, 'pending')
         RETURNING id`,
        [row.username, email, JSON.stringify(credentials)]
      );
      accountId = inserted.rows[0].id;
    }
    await this.assignProxy(accountId, proxyId);
    const cookies = buildXCookies(
      credentials.auth_token,
      credentials.ct0,
      credentials.guest_id
    );
    if (cookies.length) {
      await pool.query(
        `INSERT INTO browser_sessions (account_id, platform, cookies, session_data, user_agent)
         VALUES ($1, 'x', $2::jsonb, '{}'::jsonb, NULL)
         ON CONFLICT (account_id, platform)
         DO UPDATE SET cookies = $2::jsonb, updated_at = NOW()`,
        [accountId, JSON.stringify(cookies)]
      );
    }
    return { accountId, username: row.username, cookieCount: cookies.length };
  }

  async upsertInstagram(row, proxyId) {
    const credentials = {
      password: row.password,
      email: row.email,
      email_password: row.email_password,
      totp_secret: row.totp_secret,
      source: 'api_import',
    };
    const existing = await pool.query(
      `SELECT id FROM social_accounts WHERE platform = 'instagram' AND username = $1`,
      [row.username]
    );
    let accountId;
    if (existing.rows[0]) {
      accountId = existing.rows[0].id;
      await pool.query(
        `UPDATE social_accounts
         SET email = $2, credentials = $3::jsonb, status = 'active',
             is_simulated = false, updated_at = NOW()
         WHERE id = $1`,
        [accountId, row.email, JSON.stringify(credentials)]
      );
    } else {
      const inserted = await pool.query(
        `INSERT INTO social_accounts
           (platform, username, email, credentials, status, is_simulated, warmup_status)
         VALUES ('instagram', $1, $2, $3::jsonb, 'active', false, 'pending')
         RETURNING id`,
        [row.username, row.email, JSON.stringify(credentials)]
      );
      accountId = inserted.rows[0].id;
    }
    await this.assignProxy(accountId, proxyId);
    return { accountId, username: row.username };
  }

  async upsertTikTok(row, proxyId) {
    const credentials = {
      password: row.password,
      email: row.email,
      source: 'api_import',
    };
    const existing = await pool.query(
      `SELECT id FROM social_accounts WHERE platform = 'tiktok' AND username = $1`,
      [row.username]
    );
    let accountId;
    if (existing.rows[0]) {
      accountId = existing.rows[0].id;
      await pool.query(
        `UPDATE social_accounts
         SET email = $2, credentials = $3::jsonb, status = 'active',
             is_simulated = false, updated_at = NOW()
         WHERE id = $1`,
        [accountId, row.email, JSON.stringify(credentials)]
      );
    } else {
      const inserted = await pool.query(
        `INSERT INTO social_accounts
           (platform, username, email, credentials, status, is_simulated, warmup_status)
         VALUES ('tiktok', $1, $2, $3::jsonb, 'active', false, 'pending')
         RETURNING id`,
        [row.username, row.email || null, JSON.stringify(credentials)]
      );
      accountId = inserted.rows[0].id;
    }
    await this.assignProxy(accountId, proxyId);
    return { accountId, username: row.username };
  }

  async upsertLinkedIn(row, proxyId) {
    const slug = slugFromProfile(row.profile_url);
    const username = slug || row.email.split('@')[0];
    const credentials = {
      password: row.password,
      email: row.email,
      email_password: row.email_password,
      totp_secret: row.totp_secret,
      profile_url: row.profile_url,
      source: 'api_import',
    };
    const existing = await pool.query(
      `SELECT id FROM social_accounts
       WHERE platform = 'linkedin'
         AND (lower(username) = lower($1) OR lower(email) = lower($2))
       LIMIT 1`,
      [username, row.email]
    );
    let accountId;
    if (existing.rows[0]) {
      accountId = existing.rows[0].id;
      await pool.query(
        `UPDATE social_accounts
         SET username = $2, email = $3, credentials = $4::jsonb, status = 'active',
             is_simulated = false, updated_at = NOW()
         WHERE id = $1`,
        [accountId, username, row.email, JSON.stringify(credentials)]
      );
    } else {
      const inserted = await pool.query(
        `INSERT INTO social_accounts
           (platform, username, email, credentials, status, is_simulated, warmup_status)
         VALUES ('linkedin', $1, $2, $3::jsonb, 'active', false, 'pending')
         RETURNING id`,
        [username, row.email, JSON.stringify(credentials)]
      );
      accountId = inserted.rows[0].id;
    }
    await this.assignProxy(accountId, proxyId);
    return { accountId, username };
  }

  async upsert(platform, row, proxyId) {
    switch (platform) {
      case 'x':
        return this.upsertX(row, proxyId);
      case 'instagram':
        return this.upsertInstagram(row, proxyId);
      case 'tiktok':
        return this.upsertTikTok(row, proxyId);
      case 'linkedin':
        return this.upsertLinkedIn(row, proxyId);
      default:
        throw new Error(`Unsupported platform: ${platform}`);
    }
  }

  async smokeVerify(platform, accountId) {
    switch (platform) {
      case 'x': {
        // Cookie-only — never password-storm X.
        let browser;
        try {
          await playwrightService.requireProxyForLive(accountId);
          const result = await playwrightService.createBrowserForAccount(accountId, 2, {
            requireProxy: true,
          });
          browser = result.browser;
          const restored = await playwrightService.restoreSession(
            result.page,
            'x',
            accountId
          );
          const alive =
            restored && (await playwrightService.verifySessionAlive(result.page, 'x'));
          if (alive) {
            await playwrightService.persistSession(result.page, 'x', accountId);
            await pool.query(
              `UPDATE social_accounts
               SET warmup_status = 'warmed', warmed_up_at = NOW(),
                   last_used_at = NOW(), updated_at = NOW()
               WHERE id = $1`,
              [accountId]
            );
          }
          return { success: !!alive, accountId, mode: 'cookie_only' };
        } finally {
          if (browser) await browser.close().catch(() => {});
          playwrightService._untrackBrowser(accountId);
        }
      }
      case 'instagram':
        return playwrightService.smokeTestInstagramLogin(accountId, { requireProxy: true });
      case 'tiktok':
        return playwrightService.smokeTestTikTokLogin(accountId, { requireProxy: false });
      case 'linkedin':
        return playwrightService.smokeTestLinkedInLogin(accountId, { requireProxy: false });
      default:
        return { success: false, error: 'no smoke for platform' };
    }
  }

  /**
   * Import accounts from paste text.
   * @param {object} opts
   * @param {string} opts.platform
   * @param {string} opts.text - multiline dump
   * @param {boolean} [opts.verify=true] - smoke sessions after import
   * @param {boolean} [opts.enableOrganic=true] - enable organic jobs when smoke ok
   * @param {number} [opts.max=25] - hard cap per request
   * @param {number} [opts.verifyLimit=3] - max smoke tests (avoid rate storms)
   */
  async importFromText({
    platform,
    text,
    verify = true,
    enableOrganic = true,
    max = 25,
    verifyLimit = 3,
  } = {}) {
    if (!SUPPORTED.includes(platform)) {
      throw new Error(`Platform must be one of: ${SUPPORTED.join(', ')}`);
    }
    const rows = [];
    const parseErrors = [];
    const trimmed = String(text || '').trim();
    const looksJson = trimmed.startsWith('[') || trimmed.startsWith('{');

    if (platform === 'x' && looksJson) {
      // JSON array/object of cookie-only entries: {username, auth_token, ct0, guest_id}
      let entries;
      try {
        const parsedJson = JSON.parse(trimmed);
        entries = Array.isArray(parsedJson) ? parsedJson : [parsedJson];
      } catch (err) {
        return {
          success: false,
          imported: [],
          failed: [{ line: 0, error: `Invalid JSON: ${err.message}` }],
          message: `Could not parse JSON. Expected format: ${FORMAT_HELP.x}`,
          format: FORMAT_HELP.x,
        };
      }
      entries.forEach((entry, idx) => {
        try {
          const username = String(entry.username || entry.screen_name || '').trim();
          const auth_token = String(entry.auth_token || entry.authToken || '').trim();
          const ct0 = String(entry.ct0 || entry.csrf || '').trim();
          const guest_id = String(entry.guest_id || entry.guestId || '').trim();
          if (!username) throw new Error('Missing username');
          if (!looksLikeXAuthToken(auth_token)) {
            throw new Error('auth_token missing/invalid (need M.* or 40+ hex)');
          }
          if (ct0 && !looksLikeCt0(ct0)) {
            throw new Error(`ct0 must be 32+ hex when present, got len=${ct0.length}`);
          }
          rows.push({
            line: idx + 1,
            username,
            auth_token,
            ct0,
            guest_id: looksLikeGuestId(guest_id) ? guest_id : '',
            cookieOnly: true,
          });
        } catch (err) {
          parseErrors.push({ line: idx + 1, error: err.message, username: entry.username });
        }
      });
    } else {
      const lines = String(text || '').split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        try {
          const parsed = parseLine(platform, lines[i]);
          if (parsed) rows.push({ line: i + 1, ...parsed });
        } catch (err) {
          if (String(lines[i] || '').trim()) {
            parseErrors.push({ line: i + 1, error: err.message });
          }
        }
      }
    }
    if (!rows.length) {
      return {
        success: false,
        imported: [],
        failed: parseErrors,
        message: `No valid rows. Expected format: ${FORMAT_HELP[platform]}`,
        format: FORMAT_HELP[platform],
      };
    }

    const capped = rows.slice(0, Math.min(max, 50));
    const needed = capped.length;
    let proxyIds = [];
    if (platform === 'x') {
      // X: prefer unused healthy BrightData isp_proxy4 (1:1). Avoid burning cooled proxies.
      proxyIds = await this.takeFreeProxies(needed, { preferIspProxy4: true });
      if (proxyIds.length < needed) {
        const more = await this.takeProxiesFromPendingShells(needed - proxyIds.length);
        proxyIds = proxyIds.concat(more);
      }
    } else {
      proxyIds = await this.takeProxiesFromPendingShells(needed);
      if (proxyIds.length < needed) {
        const free = await this.takeFreeProxies(needed - proxyIds.length);
        proxyIds = proxyIds.concat(free);
      }
    }

    const imported = [];
    const failed = [...parseErrors];
    for (let i = 0; i < capped.length; i++) {
      const row = capped[i];
      try {
        const up = await this.upsert(platform, row, proxyIds[i] || null);
        imported.push({
          accountId: up.accountId,
          username: up.username,
          proxyId: proxyIds[i] || null,
          line: row.line,
        });
      } catch (err) {
        failed.push({ line: row.line, error: err.message, username: row.username || row.email });
      }
    }

    const verified = [];
    if (verify && imported.length) {
      const toVerify = imported.slice(0, Math.max(0, Math.min(verifyLimit, 5)));
      for (const item of toVerify) {
        try {
          const result = await this.smokeVerify(platform, item.accountId);
          const ok = !!result?.success;
          verified.push({
            accountId: item.accountId,
            username: item.username,
            success: ok,
            detail: result,
          });
          if (ok && enableOrganic) {
            await organicCommentService.setAccountEnabled(item.accountId, true);
            await pool.query(
              `UPDATE organic_comment_jobs
               SET next_due_at = NOW() + (random() * interval '20 minutes'),
                   status = 'idle', updated_at = NOW()
               WHERE social_account_id = $1`,
              [item.accountId]
            );
          }
          // Stagger to avoid rate storms
          await new Promise((r) => setTimeout(r, 4000 + Math.floor(Math.random() * 4000)));
        } catch (err) {
          verified.push({
            accountId: item.accountId,
            username: item.username,
            success: false,
            error: err.message,
          });
          // Stop verifying on rate-limit style failures
          if (/rate.?limit|try again later|temporarily limited|captcha/i.test(err.message)) {
            break;
          }
        }
      }
    }

    return {
      success: imported.length > 0,
      platform,
      format: FORMAT_HELP[platform],
      imported,
      failed,
      verified,
      proxies_assigned: imported.filter((i) => i.proxyId).length,
      message: `Imported ${imported.length}, verify ${verified.filter((v) => v.success).length}/${verified.length} live`,
    };
  }
}

module.exports = new AccountImportService();
module.exports.SUPPORTED = SUPPORTED;
module.exports.FORMAT_HELP = FORMAT_HELP;
module.exports.parseLine = parseLine;
module.exports.buildXCookies = buildXCookies;
