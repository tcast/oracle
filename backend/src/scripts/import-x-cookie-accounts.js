#!/usr/bin/env node
/**
 * Import X accounts that ship with auth cookies (no password login).
 *
 * Formats (auto-detected), one account per line:
 *
 * 1) Pipe + full cookie string:
 *   username|password|totp_secret|email|email_password|<cookie_string>
 *   cookie_string must include auth_token and ct0.
 *
 * 2) Colon token dump:
 *   login:pass:email:emailpass:2fa:auth_token:ct0:phone
 *
 * Dual-domain cookies (.x.com + .twitter.com) are written for auth_token/ct0
 * so restoreSession/verifySessionAlive get a coherent session.
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

function cookieEntry(name, value) {
  const base = {
    name,
    value,
    path: '/',
    secure: true,
    httpOnly: HTTP_ONLY.has(name),
    sameSite: name === 'ct0' ? 'Lax' : 'None',
  };
  const out = [{ ...base, domain: '.x.com' }];
  if (DUAL_DOMAIN.has(name)) out.push({ ...base, domain: '.twitter.com' });
  return out;
}

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
    out.push(...cookieEntry(name, value));
  }
  return out;
}

function parseColonTokenLine(raw) {
  // login:pass:email:emailpass:2fa:auth_token:ct0:phone
  // Values themselves contain no colons; email may have none; split carefully.
  const f = raw.split(':');
  if (f.length < 7) throw new Error(`Expected ≥7 colon fields, got ${f.length}`);
  const username = f[0].trim();
  const password = f[1].trim();
  const email = f[2].trim();
  const email_password = f[3].trim();
  const totp_secret = f[4].trim();
  const authToken = f[5].trim();
  const ct0 = f[6].trim();
  const phone = (f[7] || '').trim() || null;
  if (!username) throw new Error('missing username');
  if (!authToken) throw new Error('missing auth_token');
  if (!ct0) throw new Error('missing ct0');
  const cookies = [...cookieEntry('auth_token', authToken), ...cookieEntry('ct0', ct0)];
  return {
    username,
    password,
    totp_secret,
    email,
    email_password,
    phone,
    cookies,
    authToken,
    ct0,
    source: 'manual_colon_token_import',
  };
}

function parsePipeCookieLine(raw) {
  const f = raw.split('|');
  if (f.length < 6) throw new Error(`Expected 6 pipe fields, got ${f.length}`);
  const username = f[0].trim();
  const password = f[1].trim();
  const totp_secret = f[2].trim();
  const email = f[3].trim();
  const email_password = f[4].trim();
  const cookieStr = f.slice(5).join('|').trim();

  const cookies = parseCookieString(cookieStr);
  const auth = cookies.find((c) => c.name === 'auth_token');
  const ct0 = cookies.find((c) => c.name === 'ct0');
  if (!auth) throw new Error('no auth_token in cookie string');
  if (!ct0) throw new Error('no ct0 in cookie string');

  return {
    username,
    password,
    totp_secret,
    email,
    email_password,
    phone: null,
    cookies,
    authToken: auth.value,
    ct0: ct0.value,
    source: 'manual_cookie_import',
  };
}

function parseLine(line) {
  const raw = String(line || '').trim();
  if (!raw || raw.startsWith('#')) return null;
  if (raw.includes('|')) return parsePipeCookieLine(raw);
  if (raw.includes(':')) return parseColonTokenLine(raw);
  throw new Error('unrecognized line format (need | cookies or : tokens)');
}

async function upsert(row) {
  const credentials = {
    password: row.password,
    email: row.email,
    email_password: row.email_password || null,
    totp_secret: row.totp_secret,
    auth_token: row.authToken,
    ct0: row.ct0,
    phone: row.phone || null,
    has_cookies: true,
    cookie_only: true,
    source: row.source || 'manual_cookie_import',
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
      if (line.trim()) {
        const u = line.split(/[|:]/)[0] || '?';
        console.error(`  SKIP @${u}: ${e.message}`);
      }
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
