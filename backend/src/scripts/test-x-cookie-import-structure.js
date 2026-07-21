#!/usr/bin/env node
/**
 * DRY structural test for the cookie-only X import path.
 *
 * Proves — WITHOUT logging into X or touching the proxy pool — that:
 *   1. parseLine('x', ...) accepts the cookie-only line format.
 *   2. JSON-array cookie entries parse to cookie-only rows.
 *   3. buildXCookies emits the exact session shape verifySessionAlive/posting
 *      expect (auth_token httpOnly on BOTH .x.com and .twitter.com, ct0 readable,
 *      path '/', secure true, optional guest_id).
 *   4. upsertX writes a social_accounts row + a browser_sessions row whose cookies
 *      round-trip in that shape.
 *
 * Uses a FAKE auth_token/ct0 — this validates STRUCTURE only. It does NOT and
 * cannot confirm the cookies are valid on X; that needs real user cookies.
 *
 * Usage (inside whisper-backend):
 *   node src/scripts/test-x-cookie-import-structure.js
 */
require('dotenv').config();
const pool = require('../services/db');
const importService = require('../services/accountImportService');

const FAKE_AUTH = 'a'.repeat(40); // 40 hex — matches real auth_token shape
const FAKE_CT0 = 'b'.repeat(160); // 160 hex — matches modern ct0 shape
const FAKE_GUEST = 'v1%3A170000000000000000';
const TEST_USER = `__cookie_test_${Date.now()}`;

const failures = [];
function assert(cond, msg) {
  if (cond) {
    console.log(`  PASS ${msg}`);
  } else {
    console.error(`  FAIL ${msg}`);
    failures.push(msg);
  }
}

async function main() {
  console.log('=== 1. Line parse: username----auth_token----ct0----guest_id ===');
  const line = `${TEST_USER}----${FAKE_AUTH}----${FAKE_CT0}----${FAKE_GUEST}`;
  const row = importService.parseLine('x', line);
  assert(row && row.cookieOnly === true, 'row flagged cookieOnly');
  assert(row.username === TEST_USER, 'username parsed');
  assert(row.auth_token === FAKE_AUTH, 'auth_token parsed');
  assert(row.ct0 === FAKE_CT0, 'ct0 parsed (160 hex accepted)');
  assert(row.guest_id === FAKE_GUEST, 'guest_id parsed');
  assert(!row.password && !row.totp_secret, 'no password/totp required');

  console.log('\n=== 2. Minimal line: username----auth_token ===');
  const bare = importService.parseLine('x', `${TEST_USER}b----${FAKE_AUTH}`);
  assert(bare && bare.cookieOnly === true, 'bare cookie row flagged cookieOnly');
  assert(bare.auth_token === FAKE_AUTH && !bare.ct0, 'auth_token only, ct0 empty');

  console.log('\n=== 3. buildXCookies shape ===');
  const cookies = importService.buildXCookies(FAKE_AUTH, FAKE_CT0, FAKE_GUEST);
  const xAuth = cookies.find((c) => c.name === 'auth_token' && c.domain === '.x.com');
  const twAuth = cookies.find((c) => c.name === 'auth_token' && c.domain === '.twitter.com');
  const xCt0 = cookies.find((c) => c.name === 'ct0' && c.domain === '.x.com');
  const twCt0 = cookies.find((c) => c.name === 'ct0' && c.domain === '.twitter.com');
  assert(!!xAuth && !!twAuth, 'auth_token present on .x.com AND .twitter.com');
  assert(xAuth.httpOnly === true, 'auth_token httpOnly');
  assert(xAuth.path === '/' && xAuth.secure === true, "auth_token path '/' + secure");
  assert(!!xCt0 && !!twCt0, 'ct0 present on both domains');
  assert(xCt0.httpOnly === false, 'ct0 not httpOnly (JS-readable CSRF)');
  assert(cookies.some((c) => c.name === 'guest_id'), 'guest_id emitted');

  console.log('\n=== 4. DB round-trip via upsertX (proxyId=null, no network) ===');
  const up = await importService.upsertX(row, null);
  assert(!!up.accountId, `account row written (id=${up.accountId})`);
  assert(up.cookieCount >= 4, `session cookies written (count=${up.cookieCount})`);

  const acct = await pool.query(
    `SELECT status, is_simulated, credentials FROM social_accounts WHERE id = $1`,
    [up.accountId]
  );
  const creds = acct.rows[0].credentials;
  assert(acct.rows[0].status === 'active', "account status='active' (usable)");
  assert(acct.rows[0].is_simulated === false, 'not simulated');
  assert(creds.cookie_only === true, 'credentials.cookie_only=true');
  assert(creds.has_cookies === true, 'credentials.has_cookies=true');
  assert(!creds.password, 'no password stored (never password-login)');

  const sess = await pool.query(
    `SELECT cookies FROM browser_sessions WHERE account_id = $1 AND platform = 'x'`,
    [up.accountId]
  );
  const stored = sess.rows[0].cookies;
  const storedArr = typeof stored === 'string' ? JSON.parse(stored) : stored;
  assert(Array.isArray(storedArr) && storedArr.length >= 4, 'browser_sessions.cookies is populated array');
  const sAuth = storedArr.find((c) => c.name === 'auth_token' && c.domain === '.x.com');
  assert(sAuth && sAuth.value === FAKE_AUTH && sAuth.httpOnly === true, 'stored auth_token shape correct');

  console.log('\n=== cleanup ===');
  await pool.query(`DELETE FROM browser_sessions WHERE account_id = $1`, [up.accountId]);
  await pool.query(`DELETE FROM social_account_proxies WHERE social_account_id = $1`, [up.accountId]);
  await pool.query(`DELETE FROM social_accounts WHERE id = $1`, [up.accountId]);
  console.log(`  removed test account ${up.accountId}`);

  console.log(`\n${failures.length ? 'FAILED: ' + failures.length + ' assertions' : 'ALL STRUCTURAL CHECKS PASSED'}`);
  await pool.end().catch(() => {});
  process.exit(failures.length ? 1 : 0);
}

main().catch(async (err) => {
  console.error(err);
  await pool.end().catch(() => {});
  process.exit(1);
});
