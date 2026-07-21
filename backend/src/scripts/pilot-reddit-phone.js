#!/usr/bin/env node
/**
 * One-shot Reddit create via phone OTP (SMS-Man USA).
 * Usage:
 *   PILOT_PROXY_IDS=104,90 node src/scripts/pilot-reddit-phone.js
 * Env:
 *   REDDIT_CREATE_VERIFY=phone (default)
 *   PILOT_WARM=0 to skip warm
 */
require('dotenv').config();
const fs = require('fs');
const accountCreationService = require('../services/accountCreationService');
const proxyService = require('../services/proxyService');
const pool = require('../services/db');
const smsManService = require('../services/smsManService');
const fiveSimService = require('../services/fiveSimService');

const LOG = process.env.PILOT_LOG || '/tmp/reddit-phone-pilot.log';
const forcedProxyIds = String(process.env.PILOT_PROXY_IDS || '126,124,146,161')
  .split(',')
  .map((s) => parseInt(s.trim(), 10))
  .filter((n) => Number.isFinite(n) && n > 0);
const maxProxyTries = Math.min(
  parseInt(process.env.PILOT_MAX_TRIES || '2', 10) || 2,
  forcedProxyIds.length || 2
);

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try {
    fs.appendFileSync(LOG, `${line}\n`);
  } catch (_) {
    /* ignore */
  }
}

async function checkSms() {
  const smsMan = await smsManService.healthCheck();
  let fiveSim = { status: 'unavailable', message: 'skipped' };
  try {
    fiveSim = await fiveSimService.healthCheck();
  } catch (e) {
    fiveSim = { status: 'error', message: e.message };
  }
  log(`sms_health ${JSON.stringify({ smsMan, fiveSim })}`);
  if (smsMan.status !== 'online' && fiveSim.status !== 'online') {
    throw new Error(`No SMS provider online: smsMan=${smsMan.status} fiveSim=${fiveSim.status}`);
  }
  return { smsMan, fiveSim };
}

async function main() {
  const health = await checkSms();
  log(`start proxies=${forcedProxyIds.join(',')} smsManBalance=${health.smsMan.balance}`);

  // Prefer forced ProxyBase ids; do NOT fall through to random pool (burns SMS).
  let cursor = 0;
  accountCreationService.claimProxyForNewAccount = async () => {
    while (cursor < Math.min(forcedProxyIds.length, maxProxyTries)) {
      const id = forcedProxyIds[cursor++];
      const row = (await pool.query('SELECT * FROM proxies WHERE id=$1', [id])).rows[0];
      if (!row) {
        log(`proxy ${id} missing`);
        continue;
      }
      if (!proxyService.isAssignableProxy(row)) {
        log(`proxy ${id} not assignable`);
        continue;
      }
      log(`using proxy ${id} provider=${row.provider}`);
      return id;
    }
    return null;
  };

  const organicBefore = (
    await pool.query('SELECT enabled FROM organic_comment_settings WHERE id=1')
  ).rows[0];
  log(`organic_before ${JSON.stringify(organicBefore)}`);

  const results = await accountCreationService.createRedditFromPool(1, {
    warm: process.env.PILOT_WARM !== '0',
    source: 'pilot_phone',
    verifyMode: process.env.REDDIT_CREATE_VERIFY || 'phone',
  });

  const organicAfter = (
    await pool.query('SELECT enabled FROM organic_comment_settings WHERE id=1')
  ).rows[0];
  log(`organic_after ${JSON.stringify(organicAfter)}`);
  if (organicBefore?.enabled && !organicAfter?.enabled) {
    await pool.query('UPDATE organic_comment_settings SET enabled=true WHERE id=1');
    log('organic re-enabled');
  }

  log(`result ${JSON.stringify(results)}`);
  const created = results.created?.[0];
  if (created?.username) {
    const row = (
      await pool.query(
        `SELECT id, username, status, credentials->>'phone' AS phone, created_at
         FROM social_accounts WHERE id=$1`,
        [created.accountId]
      )
    ).rows[0];
    log(`YES ${JSON.stringify(row)}`);
    console.log(`YES ${row.username}`);
  } else {
    const err =
      results.errors?.[0]?.error ||
      results.blocked?.[0]?.error ||
      results.skipped?.[0]?.reason ||
      'unknown';
    console.log(`NO ${err}`);
    process.exitCode = 1;
  }
}

main()
  .catch((e) => {
    console.error('FATAL', e.message);
    process.exit(1);
  })
  .finally(async () => {
    try {
      await pool.end();
    } catch (_) {
      /* ignore */
    }
  });
