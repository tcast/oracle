#!/usr/bin/env node
/**
 * LIVE apply X personas via cookie session + Oxylabs sticky proxy.
 *
 * Prerequisites:
 *   - credentials.x_persona assigned (update-x-personas.js)
 *   - Cookie session healthy (no password login — allowLogin:false)
 *   - X_PERSONA_LIVE=1
 *
 * Usage:
 *   X_PERSONA_LIVE=1 node src/scripts/apply-x-personas-live.js --accounts 618,620,600
 *   X_PERSONA_LIVE=1 node src/scripts/apply-x-personas-live.js --accounts 618 --with-photo
 *   X_PERSONA_LIVE=1 node src/scripts/apply-x-personas-live.js --ids-file /tmp/x-ids.txt --dry-run
 *
 * Soft-skips rate_limit / proxy_error (does not mark account dead).
 * Session dead → markDeadSessionAccount and continue.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const pool = require('../services/db');
const playwrightService = require('../services/playwrightService');

const PHOTO_DIR =
  process.env.X_PHOTO_DIR || path.join(__dirname, '../../private/x-photos');

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

function classifyApplyError(msg) {
  const m = String(msg || '');
  if (
    /account_suspended|is suspended|no_live_session|session_not_logged_in|not.?logged.?in|login_wall|no_session/i.test(
      m
    )
  ) {
    return 'session_dead';
  }
  if (/x_persona_verify_failed/i.test(m)) {
    return 'verify_failed';
  }
  if (/rate.?limit|try again later|something went wrong|x_profile_error/i.test(m)) {
    return 'rate_limit';
  }
  if (/proxy|oxylabs|ECONNREFUSED|ETIMEDOUT|tunnel|ERR_PROXY/i.test(m)) {
    return 'proxy_error';
  }
  if (/challenge|unusual activity|verify you/i.test(m)) {
    return 'challenge';
  }
  return 'other';
}

function resolvePhotoPath(accountId) {
  const candidates = [
    path.join(PHOTO_DIR, `${accountId}.jpg`),
    path.join(PHOTO_DIR, `${accountId}.png`),
    path.join(PHOTO_DIR, `pilot-${accountId}.jpg`),
    path.join(PHOTO_DIR, `pilot-${accountId}.png`),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

async function ensureOfflinePersona(accountId, { dryRun }) {
  const { rows } = await pool.query(
    `SELECT id, platform, username, credentials, status, warmup_status
     FROM social_accounts WHERE id = $1`,
    [accountId]
  );
  if (!rows.length) {
    return { ok: false, error: 'not found' };
  }
  const row = rows[0];
  if (row.platform !== 'x') {
    return { ok: false, error: `platform is ${row.platform}` };
  }
  if (row.status === 'inactive' || row.warmup_status === 'failed') {
    return {
      ok: false,
      error: `skip inactive/failed (status=${row.status}, warmup=${row.warmup_status})`,
      soft: true,
    };
  }

  const creds = parseJson(row.credentials, {});
  if (creds.x_persona?.display_name && creds.x_persona?.bio) {
    return {
      ok: true,
      username: row.username,
      persona: creds.x_persona,
      alreadyAssigned: true,
    };
  }

  if (dryRun) {
    return {
      ok: true,
      username: row.username,
      needsAssign: true,
      dryRun: true,
    };
  }

  // Assign offline via the same generator as update-x-personas.js
  const {
    generateXPersona,
    toCredentialsXPersona,
    mergePersonaTraits,
    enrichmentPatchFromPersona,
  } = require('../services/xPersonas');
  const { updateEnrichment } = require('../services/profileEnrichment');

  const { rows: full } = await pool.query(
    `SELECT credentials, persona_traits FROM social_accounts WHERE id = $1`,
    [accountId]
  );
  const existingCreds = parseJson(full[0]?.credentials, {});
  const existingTraits = parseJson(full[0]?.persona_traits, {});
  const persona = generateXPersona(accountId);
  const xPersona = toCredentialsXPersona(persona, { applied_live: false });
  const nextCreds = { ...existingCreds, x_persona: xPersona };
  const nextTraits = mergePersonaTraits(existingTraits, persona);

  await pool.query(
    `UPDATE social_accounts
     SET credentials = $2::jsonb,
         persona_traits = $3::jsonb,
         updated_at = NOW()
     WHERE id = $1`,
    [accountId, JSON.stringify(nextCreds), JSON.stringify(nextTraits)]
  );
  await updateEnrichment(accountId, enrichmentPatchFromPersona(persona), {
    source: 'x_persona_offline',
  });

  return {
    ok: true,
    username: row.username,
    persona: xPersona,
    assignedNow: true,
  };
}

async function applyOne(accountId, { withPhoto, dryRun, delayMs }) {
  const ensure = await ensureOfflinePersona(accountId, { dryRun });
  if (!ensure.ok) {
    return {
      accountId,
      success: false,
      soft: !!ensure.soft,
      error: ensure.error,
      class: 'skip',
    };
  }

  if (dryRun) {
    const photoPath = withPhoto ? resolvePhotoPath(accountId) : null;
    return {
      accountId,
      success: true,
      dryRun: true,
      username: ensure.username,
      display_name: ensure.persona?.display_name || '(would assign)',
      photo: !!photoPath,
      photoPath,
      needsAssign: !!ensure.needsAssign,
    };
  }

  let photoPath = null;
  if (withPhoto) {
    photoPath = resolvePhotoPath(accountId);
    if (!photoPath) {
      console.warn(`#${accountId}: --with-photo but no file in ${PHOTO_DIR} — continuing text-only`);
    }
  }

  try {
    const result = await playwrightService.applyXPersonaLive(accountId, {
      photoPath,
      requireProxy: true,
    });
    // applyXPersonaLive only returns success after live read-back verification
    if (!result?.success) {
      return {
        accountId,
        success: false,
        error: result?.error || 'apply returned without success',
        class: 'verify_failed',
        username: result?.username,
        verified: result?.verified,
        skipped: result?.skipped,
      };
    }
    return {
      accountId,
      success: true,
      username: result.username,
      display_name: result.display_name,
      photo: !!result.photo,
      verified: result.verified,
      skipped: result.skipped,
    };
  } catch (err) {
    const msg = err.message || String(err);
    const cls = classifyApplyError(msg);

    if (cls === 'session_dead') {
      const organicCommentService = require('../services/organicCommentService');
      await organicCommentService
        .markDeadSessionAccount(accountId, `x_persona_live: ${msg}`)
        .catch(() => {});
      return {
        accountId,
        success: false,
        error: msg,
        class: cls,
        accountMarkedDead: true,
      };
    }

    return {
      accountId,
      success: false,
      error: msg,
      class: cls,
      // verify_failed is a hard fail — must not be treated as soft OK
      soft: cls === 'rate_limit' || cls === 'proxy_error' || cls === 'challenge',
    };
  } finally {
    if (delayMs > 0) {
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

async function main() {
  if (process.env.X_PERSONA_LIVE !== '1' && !process.argv.includes('--dry-run')) {
    console.error('Refusing: set X_PERSONA_LIVE=1 (or pass --dry-run)');
    process.exit(2);
  }

  const dryRun = process.argv.includes('--dry-run');
  const withPhoto = process.argv.includes('--with-photo');
  const delayMs = Number(arg('--delay-ms', '8000')) || 8000;
  const ids = parseIds();
  if (!ids.length) throw new Error('No account ids resolved');

  console.log(
    dryRun
      ? `DRY RUN — would live-apply X personas to ${ids.length} account(s)`
      : `LIVE apply X personas to ${ids.length} account(s) (cookie-only, delay ${delayMs}ms)`
  );
  console.log(`Photos: ${withPhoto ? `yes (${PHOTO_DIR})` : 'no'}\n`);

  const results = [];
  for (const id of ids) {
    console.log(`\n----- #${id} -----`);
    const result = await applyOne(id, { withPhoto, dryRun, delayMs });
    results.push(result);
    if (result.success) {
      const v = result.verified
        ? ` verified[name=${!!result.verified.display_name},bio=${!!result.verified.bio},photo=${!!result.verified.photo}]`
        : '';
      console.log(
        `#${id} OK @${result.username || '?'} → ${result.display_name || '?'}` +
          (result.photo ? ' +photo' : '') +
          v +
          (dryRun ? ' [dry-run]' : '')
      );
    } else {
      console.log(
        `#${id} FAIL [${result.class || '?'}]${result.soft ? ' (soft-skip)' : ''}` +
          `${result.accountMarkedDead ? ' [marked dead]' : ''}: ${result.error}`
      );
    }
  }

  console.log('\n===== SUMMARY =====');
  console.table(
    results.map((r) => ({
      id: r.accountId,
      ok: !!r.success,
      soft: !!r.soft,
      dead: !!r.accountMarkedDead,
      photo: !!r.photo,
      name: (r.display_name || '').slice(0, 22),
      err: (r.error || r.class || '').slice(0, 40),
    }))
  );
  const ok = results.filter((r) => r.success).length;
  const soft = results.filter((r) => !r.success && r.soft).length;
  const hard = results.filter((r) => !r.success && !r.soft).length;
  console.log(`Done: ${ok} ok / ${soft} soft-skip / ${hard} hard-fail of ${results.length}`);
  await pool.end().catch(() => {});
  process.exit(hard > 0 ? 1 : 0);
}

main().catch(async (err) => {
  console.error(err);
  await pool.end().catch(() => {});
  process.exit(1);
});
