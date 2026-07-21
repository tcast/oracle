#!/usr/bin/env node
/**
 * Probe X public profiles for suspension / deleted accounts.
 *
 * Visits https://x.com/{username} via the account's Oxylabs proxy.
 * NEVER password-logs-in. Cookies are optional and not restored by default
 * (public interstitial is enough for suspended / doesn't-exist).
 *
 * On confirmed suspended or not-exist → markBannedAccount (status=banned,
 * organic disabled, proxy freed). Soft-skips proxy/tunnel/rate-limit flakes.
 *
 * Usage (inside whisper-backend):
 *   node src/scripts/probe-x-ban-status.js --dry-run
 *   node src/scripts/probe-x-ban-status.js --apply
 *   node src/scripts/probe-x-ban-status.js --apply --accounts 602,615,619
 *   node src/scripts/probe-x-ban-status.js --apply --min-id 600 --max-id 669
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const pool = require('../services/db');
const playwrightService = require('../services/playwrightService');
const organicCommentService = require('../services/organicCommentService');

const SCREENSHOT_DIR = process.env.X_BAN_SHOT_DIR || '/tmp/x-ban-probe';
const DRY = process.argv.includes('--dry-run');
const APPLY = process.argv.includes('--apply') || (!DRY && process.argv.includes('--mark'));

function arg(name, def = null) {
  const idx = process.argv.indexOf(name);
  if (idx === -1) return def;
  const v = process.argv[idx + 1];
  return v && !v.startsWith('--') ? v : true;
}

function parseAccountIds() {
  const accounts = arg('--accounts');
  if (typeof accounts === 'string') {
    return accounts
      .split(',')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n) && n > 0);
  }
  return null;
}

function isProxyError(msg) {
  return /proxy|oxylabs|ECONNREFUSED|ETIMEDOUT|tunnel|ERR_PROXY|ERR_TUNNEL|ERR_CONNECTION|net::ERR_/i.test(
    String(msg || '')
  );
}

/**
 * Classify public profile page text / url into a ban verdict.
 * Only returns banned/not_exist on unambiguous interstitials.
 */
function classifyProfilePage({ url, text, hasUserName, hasPrimaryColumn }) {
  const u = String(url || '');
  const t = String(text || '');

  if (/rate.?limit|try again later|something went wrong\.? please try again/i.test(t)) {
    return { verdict: 'rate_limit', reason: 'rate_limit_or_oops' };
  }
  if (/\/i\/flow\/login|\/login/i.test(u) && /Sign in to X|Create account/i.test(t) && !hasUserName) {
    return { verdict: 'login_wall', reason: 'login_wall' };
  }

  // Suspended interstitial (public + logged-in)
  if (
    /Account suspended/i.test(t) ||
    /This account (?:has been|is) (?:temporarily )?suspended/i.test(t) ||
    /Your account is suspended/i.test(t) ||
    /account is suspended and is not permitted/i.test(t)
  ) {
    return { verdict: 'suspended', reason: 'account_suspended' };
  }

  // Deleted / never existed
  if (
    /This account doesn.?t exist/i.test(t) ||
    /Hmm\.\.\.?this page doesn.?t exist/i.test(t) ||
    /User not found/i.test(t) ||
    /Account doesn.?t exist/i.test(t)
  ) {
    return { verdict: 'not_exist', reason: 'account_does_not_exist' };
  }

  // Healthy profile chrome (DOM or text signals from public page)
  if (hasUserName) {
    return { verdict: 'ok', reason: 'profile_ok_username' };
  }
  if (
    /@\w+/i.test(t) &&
    /Joined\s+\w+/i.test(t) &&
    /(Following|Followers)/i.test(t) &&
    /(Posts|Replies|Media)/i.test(t)
  ) {
    return { verdict: 'ok', reason: 'profile_ok_text' };
  }
  if (hasPrimaryColumn && /@\w+/i.test(t) && /Follow|Following|Posts|Replies/i.test(t)) {
    return { verdict: 'ok', reason: 'profile_ok_column' };
  }

  return { verdict: 'ambiguous', reason: 'unclear_page', snippet: t.slice(0, 240) };
}

async function loadTargets() {
  const explicit = parseAccountIds();
  const minId = Number(arg('--min-id')) || null;
  const maxId = Number(arg('--max-id')) || null;

  if (explicit?.length) {
    const { rows } = await pool.query(
      `SELECT id, username, status, warmup_status,
              COALESCE(credentials->>'session_dead_reason','') AS session_dead_reason
       FROM social_accounts
       WHERE platform = 'x'
         AND COALESCE(is_simulated, false) = false
         AND id = ANY($1::int[])
       ORDER BY id`,
      [explicit]
    );
    return rows;
  }

  const { rows } = await pool.query(
    `SELECT id, username, status, warmup_status,
            COALESCE(credentials->>'session_dead_reason','') AS session_dead_reason
     FROM social_accounts
     WHERE platform = 'x'
       AND COALESCE(is_simulated, false) = false
       AND status <> 'banned'
       AND (
         (status = 'active' AND warmup_status = 'warmed')
         OR (
           status = 'inactive'
           AND COALESCE(credentials->>'session_dead_reason','') ILIKE '%suspend%'
         )
       )
       AND ($1::int IS NULL OR id >= $1)
       AND ($2::int IS NULL OR id <= $2)
     ORDER BY id`,
    [minId, maxId]
  );
  return rows;
}

async function probeOne(row, { attempt = 1 } = {}) {
  const accountId = row.id;
  const username = row.username;
  let browser = null;
  const shotPath = path.join(SCREENSHOT_DIR, `x-ban-${accountId}.png`);

  try {
    let opened;
    try {
      await playwrightService.requireProxyForLive(accountId);
      opened = await playwrightService.createBrowserForAccount(accountId, 2, {
        requireProxy: true,
      });
    } catch (proxyAssignErr) {
      // Already-inactive accounts may have freed proxies — borrow Oxylabs for public check.
      if (!/no active proxy/i.test(proxyAssignErr.message || '')) throw proxyAssignErr;
      console.log(`  no assigned proxy — preferProvider=Oxylabs for public check`);
      opened = await playwrightService.createBrowserForAccount(accountId, 2, {
        requireProxy: true,
        preferProvider: 'Oxylabs',
      });
    }
    browser = opened.browser;
    const page = opened.page;

    // Public profile — no cookie restore, no password login.
    await page.goto(`https://x.com/${username}`, {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    });
    await playwrightService.humanLikeDelay(3500, 5500);

    // Wait briefly for either profile chrome or interstitial text.
    await Promise.race([
      page.waitForSelector('[data-testid="UserName"], [data-testid="primaryColumn"]', {
        timeout: 20000,
      }),
      page.waitForFunction(
        () =>
          /Account suspended|doesn.?t exist|Your account is suspended|Something went wrong/i.test(
            document.body?.innerText || ''
          ),
        { timeout: 20000 }
      ),
    ]).catch(() => null);

    await playwrightService.humanLikeDelay(1500, 2500);

    const snap = await page.evaluate(() => {
      const text = (document.body?.innerText || '').slice(0, 10000);
      return {
        url: location.href,
        text,
        hasUserName: !!document.querySelector('[data-testid="UserName"]'),
        hasPrimaryColumn: !!document.querySelector('[data-testid="primaryColumn"]'),
      };
    });

    await page.screenshot({ path: shotPath, fullPage: true }).catch(() => {});

    const classified = classifyProfilePage(snap);
    return {
      accountId,
      username,
      priorStatus: row.status,
      priorWarmup: row.warmup_status,
      url: snap.url,
      screenshot: shotPath,
      attempt,
      ...classified,
      snippet: (classified.snippet || snap.text || '').slice(0, 200),
    };
  } catch (err) {
    const msg = err.message || String(err);
    if (browser) {
      await browser.close().catch(() => {});
      browser = null;
      playwrightService._untrackBrowser(accountId);
    }
    if (isProxyError(msg) && attempt < 2) {
      console.log(`  proxy flake attempt ${attempt}, retrying once…`);
      await new Promise((r) => setTimeout(r, 3000 + Math.floor(Math.random() * 3000)));
      return probeOne(row, { attempt: attempt + 1 });
    }
    if (isProxyError(msg)) {
      return {
        accountId,
        username,
        priorStatus: row.status,
        verdict: 'proxy_error',
        reason: msg.slice(0, 200),
        softSkip: true,
        attempt,
      };
    }
    return {
      accountId,
      username,
      priorStatus: row.status,
      verdict: 'error',
      reason: msg.slice(0, 200),
      softSkip: true,
      attempt,
    };
  } finally {
    if (browser) await browser.close().catch(() => {});
    playwrightService._untrackBrowser(accountId);
  }
}

async function maybeMarkBanned(result) {
  if (!APPLY || DRY) return { marked: false };
  if (result.verdict !== 'suspended' && result.verdict !== 'not_exist') {
    return { marked: false };
  }
  const reason = `x_ban_probe: ${result.verdict} (${result.reason})`;
  await organicCommentService.markBannedAccount(result.accountId, reason);
  return { marked: true, reason };
}

async function main() {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

  const targets = await loadTargets();
  console.log(
    `X ban probe: ${targets.length} targets (dry=${DRY} apply=${APPLY && !DRY})`
  );
  if (!targets.length) {
    console.log('Nothing to probe');
    return;
  }

  const summary = {
    checked: 0,
    banned: 0,
    ok: 0,
    proxy_error: 0,
    rate_limit: 0,
    ambiguous: 0,
    already_inactive_suspended: 0,
    errors: 0,
    newly_banned: [],
  };

  const results = [];

  for (const row of targets) {
    if (row.status === 'inactive' && /suspend/i.test(row.session_dead_reason || '')) {
      summary.already_inactive_suspended++;
    }

    console.log(`\n=== #${row.id} @${row.username} [${row.status}/${row.warmup_status}] ===`);
    const result = await probeOne(row);
    summary.checked++;

    const mark = await maybeMarkBanned(result);
    result.markedBanned = !!mark.marked;
    if (mark.marked) {
      summary.banned++;
      summary.newly_banned.push({
        id: result.accountId,
        username: result.username,
        verdict: result.verdict,
      });
      console.log(`  → MARKED BANNED (${result.verdict})`);
    } else if (result.verdict === 'ok') {
      summary.ok++;
      console.log('  → OK');
    } else if (result.verdict === 'proxy_error') {
      summary.proxy_error++;
      console.log(`  → soft-skip proxy_error: ${result.reason}`);
    } else if (result.verdict === 'rate_limit' || result.verdict === 'login_wall') {
      summary.rate_limit++;
      console.log(`  → soft-skip ${result.verdict}`);
    } else if (result.verdict === 'suspended' || result.verdict === 'not_exist') {
      // dry-run path
      summary.banned++;
      summary.newly_banned.push({
        id: result.accountId,
        username: result.username,
        verdict: result.verdict,
        dryRun: true,
      });
      console.log(`  → would ban (${result.verdict}) dry=${DRY || !APPLY}`);
    } else if (result.verdict === 'ambiguous') {
      summary.ambiguous++;
      console.log(`  → ambiguous (not marking): ${result.snippet || result.reason}`);
    } else {
      summary.errors++;
      console.log(`  → error soft-skip: ${result.reason}`);
    }

    results.push(result);

    // Pace requests to reduce rate limits
    await new Promise((r) => setTimeout(r, 4000 + Math.floor(Math.random() * 4000)));
  }

  const healthy = await pool.query(
    `SELECT COUNT(*)::int AS n
     FROM social_accounts
     WHERE platform = 'x'
       AND COALESCE(is_simulated, false) = false
       AND status = 'active'
       AND warmup_status = 'warmed'`
  );

  console.log('\n=== SUMMARY ===');
  console.log(JSON.stringify(summary, null, 2));
  console.log(`Remaining healthy warmed X: ${healthy.rows[0].n}`);
  console.log('RESULTS_JSON=' + JSON.stringify({ summary, results }));
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end().catch(() => {});
  });
