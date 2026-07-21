#!/usr/bin/env node
/**
 * Assign X personas offline (DB write only).
 *
 * Writes credentials.x_persona, merges persona_traits, and sets profile_enrichment
 * content flags. Does NOT open Playwright or edit https://x.com/settings/profile.
 *
 * Safe sequence (live pilot — NOT this script):
 *   1. Cookie-verify accounts (e.g. 620–669) still healthy.
 *   2. Oxylabs sticky proxy bound per account (required for any live UI).
 *   3. Session restore only: allowLogin:false (cookie_only — no password login).
 *   4. Set X_PERSONA_LIVE=1 and call playwrightService.updateXPersona(page, …).
 *   5. v1 fields only: display name, bio, location, website, avatar.
 *      NO handle rename in v1 (opt-in/risky — leave username alone).
 *
 * Usage:
 *   node src/scripts/update-x-personas.js --accounts 620,621
 *   node src/scripts/update-x-personas.js --ids-file /tmp/x-ids.txt
 *   node src/scripts/update-x-personas.js --accounts 620,621 --dry-run
 *
 * Env: DATABASE_URL (via dotenv). No secrets written to disk.
 */
require('dotenv').config();
const fs = require('fs');
const pool = require('../services/db');
const { updateEnrichment } = require('../services/profileEnrichment');
const {
  generateXPersona,
  toCredentialsXPersona,
  mergePersonaTraits,
  enrichmentPatchFromPersona,
} = require('../services/xPersonas');

function arg(name, def = null) {
  const idx = process.argv.indexOf(name);
  if (idx === -1) return def;
  const v = process.argv[idx + 1];
  return v && !v.startsWith('--') ? v : true;
}

function parseIds() {
  const accounts = arg('--accounts');
  if (typeof accounts === 'string') {
    return accounts
      .split(',')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n) && n > 0);
  }
  const idsFile = arg('--ids-file');
  if (typeof idsFile === 'string') {
    const text = fs.readFileSync(idsFile, 'utf8');
    return text
      .split(/[\s,]+/)
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n) && n > 0);
  }
  throw new Error('Provide --accounts <ids> or --ids-file <path>');
}

function parseJson(value, fallback = {}) {
  if (value == null) return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

async function assignPersona(accountId, { dryRun }) {
  const { rows } = await pool.query(
    `SELECT id, platform, username, credentials, persona_traits, profile_enrichment
     FROM social_accounts WHERE id = $1`,
    [accountId]
  );
  if (!rows.length) {
    return { accountId, success: false, error: 'not found' };
  }
  const row = rows[0];
  if (row.platform !== 'x') {
    return {
      accountId,
      success: false,
      error: `platform is ${row.platform}, expected x`,
    };
  }

  const creds = parseJson(row.credentials, {});
  const existingTraits = parseJson(row.persona_traits, {});
  const persona = generateXPersona(accountId);
  const xPersona = toCredentialsXPersona(persona, { applied_live: false });
  const nextCreds = { ...creds, x_persona: xPersona };
  const nextTraits = mergePersonaTraits(existingTraits, persona);
  const enrichPatch = enrichmentPatchFromPersona(persona);

  if (dryRun) {
    return {
      accountId,
      success: true,
      dryRun: true,
      username: row.username,
      display_name: persona.display_name,
      bio: persona.bio.slice(0, 60),
      location: persona.location,
      website: persona.website,
    };
  }

  await pool.query(
    `UPDATE social_accounts
     SET credentials = $2::jsonb,
         persona_traits = $3::jsonb,
         updated_at = NOW()
     WHERE id = $1`,
    [accountId, JSON.stringify(nextCreds), JSON.stringify(nextTraits)]
  );

  await updateEnrichment(accountId, enrichPatch, { source: 'x_persona_offline' });

  return {
    accountId,
    success: true,
    username: row.username,
    display_name: persona.display_name,
    bio: persona.bio.slice(0, 60),
    location: persona.location,
    website: persona.website,
  };
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const ids = parseIds();
  if (!ids.length) throw new Error('No account ids resolved');

  console.log(
    dryRun
      ? `DRY RUN — would assign X personas to ${ids.length} account(s)`
      : `Assigning X personas (DB only) to ${ids.length} account(s)…`
  );
  console.log('Live profile UI: not called. Requires cookie-verify + X_PERSONA_LIVE=1 later.\n');

  const results = [];
  for (const id of ids) {
    const result = await assignPersona(id, { dryRun });
    results.push(result);
    if (result.success) {
      console.log(
        `#${id} @${result.username || '?'} → ${result.display_name}` +
          (result.location ? ` · ${result.location}` : '') +
          (dryRun ? ' [dry-run]' : '')
      );
    } else {
      console.log(`#${id} FAIL: ${result.error}`);
    }
  }

  console.log('\n===== SUMMARY =====');
  console.table(
    results.map((r) => ({
      id: r.accountId,
      ok: !!r.success,
      name: (r.display_name || '').slice(0, 22),
      err: (r.error || '').slice(0, 36),
    }))
  );
  const ok = results.filter((r) => r.success).length;
  console.log(`Done: ${ok}/${results.length}${dryRun ? ' (dry-run)' : ''}`);
  await pool.end().catch(() => {});
  process.exit(ok === results.length ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  await pool.end().catch(() => {});
  process.exit(1);
});
