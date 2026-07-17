#!/usr/bin/env node
/**
 * Update LinkedIn profile photos for imported accounts.
 *
 * Photos live in:
 *   /app/private/linkedin-photos/{username-slug}.jpg
 *
 * Usage:
 *   node src/scripts/update-linkedin-photos.js
 *   node src/scripts/update-linkedin-photos.js 277
 *   node src/scripts/update-linkedin-photos.js 290-329
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const pool = require('../services/db');
const playwrightService = require('../services/playwrightService');

const PHOTO_DIR = process.env.LINKEDIN_PHOTO_DIR || path.join(__dirname, '../../private/linkedin-photos');

function slugFromProfile(url) {
  const m = String(url || '').match(/linkedin\.com\/in\/([^\/?#]+)/i);
  return m ? m[1] : null;
}

function findPhoto(slug, username) {
  const candidates = [
    path.join(PHOTO_DIR, `${slug}.jpg`),
    path.join(PHOTO_DIR, `${slug}.png`),
    path.join(PHOTO_DIR, `${username}.jpg`),
    path.join(PHOTO_DIR, `${username}.png`),
  ].filter(Boolean);
  for (const p of candidates) {
    if (p && fs.existsSync(p)) return p;
  }
  return null;
}

async function main() {
  const arg = process.argv[2] || null;
  let q;
  let params = [];
  if (arg && arg.includes('-')) {
    const [lo, hi] = arg.split('-').map(Number);
    q = `SELECT id, username, email, credentials->>'profile_url' AS profile_url
         FROM social_accounts WHERE platform = 'linkedin' AND id BETWEEN $1 AND $2
         ORDER BY id`;
    params = [lo, hi];
  } else if (arg) {
    q = `SELECT id, username, email, credentials->>'profile_url' AS profile_url
         FROM social_accounts WHERE platform = 'linkedin' AND id = $1`;
    params = [Number(arg)];
  } else {
    q = `SELECT id, username, email, credentials->>'profile_url' AS profile_url
         FROM social_accounts WHERE platform = 'linkedin' AND status = 'active'
         ORDER BY id`;
  }
  const { rows } = await pool.query(q, params);
  if (!rows.length) {
    console.error('No LinkedIn accounts found');
    process.exit(1);
  }

  console.log(`Photo dir: ${PHOTO_DIR}`);
  console.log(`Updating ${rows.length} LinkedIn profile photo(s)…`);

  const results = [];
  for (const row of rows) {
    const slug = slugFromProfile(row.profile_url) || row.username;
    const photoPath = findPhoto(slug, row.username);
    console.log(`\n=== #${row.id} ${row.email} slug=${slug} ===`);
    if (!photoPath) {
      console.log('No photo file found — skip');
      results.push({ accountId: row.id, email: row.email, success: false, error: 'photo_missing' });
      continue;
    }
    console.log(`Using ${photoPath}`);
    const result = await playwrightService.updateLinkedInProfilePhoto(row.id, photoPath, {
      requireProxy: false,
    });
    results.push(result);
    console.log(JSON.stringify(result));
    await new Promise((r) => setTimeout(r, 6000 + Math.floor(Math.random() * 5000)));
  }

  console.log('\n===== SUMMARY =====');
  console.table(
    results.map((r) => ({
      id: r.accountId,
      email: (r.email || '').slice(0, 28),
      ok: !!r.success,
      err: (r.error || '').slice(0, 40),
    }))
  );
  const ok = results.filter((r) => r.success).length;
  console.log(`Done: ${ok}/${results.length}`);
  await pool.end().catch(() => {});
  process.exit(ok > 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  await pool.end().catch(() => {});
  process.exit(1);
});
