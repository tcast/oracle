#!/usr/bin/env node
/**
 * Import X accounts that ship with a FULL browser cookie string (the reliable,
 * scalable path — no password login, no FunCaptcha).
 *
 * Line format (pipe-delimited), one per line:
 *   username|password|totp_secret|email|email_password|<cookie_string>
 *
 * <cookie_string> is a normal "k=v; k=v; ..." document.cookie dump and must
 * contain at least auth_token and ct0 (guest_id / twid / personalization_id
 * are stored too when present). Real X auth_token cookies are 40-hex (NOT the
 * old "M." AccsMarket form), so we store the raw cookie values as-is.
 *
 * Stores the complete cookie set on both .x.com and .twitter.com so
 * restoreSession/verifySessionAlive get a full, coherent session.
 *
 * Usage (in whisper-backend, no browser needed):
 *   node src/scripts/import-x-cookie-accounts.js /app/private/x-cookie-accounts.txt
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const pool = require('../services/db');

// Cookies we mirror onto .twitter.com as well as .x.com.
const DUAL_DOMAIN = new Set(['auth_token', 'ct0', 'guest_id', 'twid', 'personalization_id']);
const HTTP_ONLY = new Set(['auth_token', 'guest_id', '__cf_bm']);

function parseCookieString(str) {
  const out = [];
  const seen = new Set();
  for (const part of String(str).split(';')) {
    const s = part.trim();
    if (!s) continue;
    const eq = s.indexOf('=');
    if (eq === -1) continue;
    const name = s.slice(0, eq).trim();
    let value = s.slice(eq + 1).trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    // Playwright rejects surrounding quotes in some cases; keep as-is (X sets
    // personalization_id quoted and expects it back quoted), just trim spaces.
    const base = {
      name,
      value,
      path: '/',
      secure: true,
      httpOnly: HTTP_ONLY.has(name),
      sameSite: name === 'ct0' ? 'Lax' : 'None',
    };
    out.push({ ...base, domain: '.x.com' });
    if (DUAL_DOMAIN.has(name)) out.push({ ...base, domain: '.twitter.com' });
  }
  return out;
}

function parseLine(line) {
  const raw = String(line || '').trim();
  if (!raw || raw.startsWith('#')) return null;
  const f = raw.split('|');
  if (f.length < 6) throw new Error(`Expected 6 pipe fields, got ${f.length}`);
  const username = f[0].trim();
  const password = f[1].trim();
  const totp_secret = f[2].trim();
  const email = f[3].trim();
  const email_password = f[4].trim();
  const cookieStr = f.slice(5).join('|').trim(); // cookie has no pipes, but be safe

  const cookies = parseCookieString(cookieStr);
  const auth = cookies.find((c) => c.name === 'auth_token');
  const ct0 = cookies.find((c) => c.name === 'ct0');
  if (!auth) throw new Error('no auth_token in cookie string');
  if (!ct0) throw new Error('no ct0 in cookie string');

  return { username, password, totp_secret, email, email_password, cookies, authToken: auth.value, ct0: ct0.value };
}

async function upsert(row) {
  const credentials = {
    password: row.password,
    email: row.email,
    email_password: row.email_password || null,
    totp_secret: row.totp_secret,
    auth_token: row.authToken,
    ct0: row.ct0,
    has_cookies: true,
    cookie_only: true,
    source: 'manual_cookie_import',
  };

  const existing = await pool.query(
    `SELECT id FROM social_accounts WHERE platform = 'x' AND lower(username) = lower($1) LIMIT 1`,
    [row.username]
  );

  let accountId;
  if (existing.rows[0]) {
    accountId = existing.rows[0].id;
    await pool.query(
      `UPDATE social_accounts
       SET email = $2, credentials = $3::jsonb, status = 'active', is_simulated = false,
           warmup_status = 'pending', updated_at = NOW()
       WHERE id = $1`,
      [accountId, row.email, JSON.stringify(credentials)]
    );
  } else {
    const ins = await pool.query(
      `INSERT INTO social_accounts (platform, username, email, credentials, status, is_simulated, warmup_status)
       VALUES ('x', $1, $2, $3::jsonb, 'active', false, 'pending') RETURNING id`,
      [row.username, row.email, JSON.stringify(credentials)]
    );
    accountId = ins.rows[0].id;
  }

  await pool.query(
    `INSERT INTO browser_sessions (account_id, platform, cookies, session_data, user_agent)
     VALUES ($1, 'x', $2::jsonb, '{}'::jsonb, NULL)
     ON CONFLICT (account_id, platform)
     DO UPDATE SET cookies = $2::jsonb, updated_at = NOW()`,
    [accountId, JSON.stringify(row.cookies)]
  );

  return { accountId, username: row.username, cookieCount: row.cookies.length };
}

async function main() {
  const file = process.argv[2];
  if (!file || !fs.existsSync(file)) {
    console.error('Usage: node src/scripts/import-x-cookie-accounts.js <txt>');
    process.exit(1);
  }
  const lines = fs.readFileSync(path.resolve(file), 'utf8').split(/\r?\n/);
  const rows = [];
  for (const line of lines) {
    try {
      const p = parseLine(line);
      if (p) rows.push(p);
    } catch (e) {
      if (line.trim()) console.error(`  SKIP: ${e.message} :: ${line.slice(0, 40)}…`);
    }
  }
  console.log(`Parsed ${rows.length} cookie accounts`);

  const ids = [];
  for (const row of rows) {
    try {
      const r = await upsert(row);
      ids.push(r.accountId);
      console.log(`  #${r.accountId} @${r.username} cookies=${r.cookieCount}`);
    } catch (e) {
      console.error(`  FAIL @${row.username}: ${e.message}`);
    }
  }
  ids.sort((a, b) => a - b);
  console.log(`\nImported ${ids.length}. IDS=${ids.join(',')}`);
  await pool.end().catch(() => {});
}

main().catch(async (e) => { console.error(e); await pool.end().catch(() => {}); process.exit(1); });
