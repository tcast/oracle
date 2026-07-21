#!/usr/bin/env node
/**
 * Import X accounts from pipe+cookie dumps:
 *   username|password|totp|email|email_pass|cookie_string
 * where cookie_string contains auth_token=...;ct0=...;guest_id=...
 *
 * Cookie-only path — NO password login. Optionally bind Oxylabs sticky sessions.
 *
 * Usage:
 *   node src/scripts/import-x-cookie-pipe-dump.js /path/to/dump.txt [--verify=1] [--oxylabs]
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const pool = require('../services/db');
const accountImportService = require('../services/accountImportService');

function cookieVal(blob, name) {
  const re = new RegExp(`(?:^|;)\\s*${name}=([^;]+)`);
  const m = String(blob || '').match(re);
  return m ? m[1].trim() : '';
}

function convertPipeLine(line) {
  const raw = String(line || '').trim();
  if (!raw || raw.startsWith('#')) return null;
  // Split on | but cookie field may contain | in rare cases — take first 5 pipes, rest is cookies
  const parts = raw.split('|');
  if (parts.length < 6) throw new Error(`Need ≥6 pipe fields, got ${parts.length}`);
  const username = parts[0].trim();
  const password = parts[1].trim();
  const totp = parts[2].trim();
  const email = parts[3].trim();
  const email_password = parts[4].trim();
  const cookies = parts.slice(5).join('|');
  const auth_token = cookieVal(cookies, 'auth_token');
  const ct0 = cookieVal(cookies, 'ct0');
  const guest_id = cookieVal(cookies, 'guest_id');
  if (!username) throw new Error('missing username');
  if (!auth_token) throw new Error(`${username}: missing auth_token`);
  if (!ct0) throw new Error(`${username}: missing ct0`);
  // Convert to cookie-only ---- line for the importer
  const fields = [username, auth_token, ct0];
  if (guest_id) fields.push(guest_id);
  return {
    line: fields.join('----'),
    meta: { username, password, totp, email, email_password, auth_token, ct0, guest_id },
  };
}

async function bindOxylabs(accountIds) {
  if (!accountIds.length) return;
  const username = process.env.OXYLABS_USERNAME;
  const password = process.env.OXYLABS_PASSWORD;
  if (!username || !password) {
    console.warn('OXYLABS_* env missing — skip Oxylabs bind');
    return;
  }
  // Reuse the import script logic via spawning would be heavy; inline minimal bind.
  const { spawnSync } = require('child_process');
  const ids = accountIds.join(',');
  const r = spawnSync(
    process.execPath,
    [path.join(__dirname, 'import-oxylabs-proxies.js'), '--accounts', ids, '--replace'],
    {
      env: process.env,
      encoding: 'utf8',
      timeout: 120000,
    }
  );
  process.stdout.write(r.stdout || '');
  process.stderr.write(r.stderr || '');
  if (r.status !== 0) throw new Error(`Oxylabs bind failed status=${r.status}`);
}

async function main() {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith('--'));
  const verifyN = Number((args.find((a) => a.startsWith('--verify=')) || '--verify=0').split('=')[1] || 0);
  const doOxylabs = args.includes('--oxylabs');
  if (!file) {
    console.error('Usage: node src/scripts/import-x-cookie-pipe-dump.js <dump.txt> [--verify=N] [--oxylabs]');
    process.exit(1);
  }
  const abs = path.resolve(file);
  const lines = fs.readFileSync(abs, 'utf8').split(/\r?\n/);
  const converted = [];
  const metas = [];
  for (let i = 0; i < lines.length; i++) {
    try {
      const c = convertPipeLine(lines[i]);
      if (!c) continue;
      converted.push(c.line);
      metas.push(c.meta);
      console.log(`OK ${c.meta.username} auth=${c.meta.auth_token.slice(0, 8)}… ct0len=${c.meta.ct0.length}`);
    } catch (e) {
      console.error(`Line ${i + 1}: ${e.message}`);
    }
  }
  console.log(`Converted ${converted.length} cookie-only rows`);

  const result = await accountImportService.importFromText({
    platform: 'x',
    text: converted.join('\n'),
    verify: verifyN > 0,
    verifyLimit: verifyN,
    enableOrganic: false,
  });

  console.log(JSON.stringify({
    imported: result.imported,
    failed: result.failed,
    verified: result.verified,
    message: result.message,
  }, null, 2));

  // Enrich credentials with password/totp/email for future (cookie_only stays true so no auto password login)
  for (const m of metas) {
    await pool.query(
      `UPDATE social_accounts
       SET credentials = COALESCE(credentials, '{}'::jsonb)
         || jsonb_build_object(
              'password', $2::text,
              'totp_secret', $3::text,
              'email', $4::text,
              'email_password', $5::text,
              'cookie_only', true,
              'has_cookies', true,
              'source', 'api_import_cookie_pipe'
            ),
           email = COALESCE(email, $4),
           updated_at = NOW()
       WHERE platform = 'x' AND lower(username) = lower($1)`,
      [m.username, m.password, m.totp, m.email, m.email_password]
    );
  }

  const ids = (result.imported || []).map((a) => a.accountId).filter(Boolean);
  if (doOxylabs && ids.length) {
    console.log(`Binding ${ids.length} accounts to Oxylabs…`);
    await bindOxylabs(ids);
  }

  await pool.end().catch(() => {});
  process.exit((result.failed || 0) > 0 && ids.length === 0 ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  await pool.end().catch(() => {});
  process.exit(1);
});
