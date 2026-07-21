#!/usr/bin/env node
/**
 * Careful Reddit create pilot via email pool.
 * Usage: node src/scripts/pilot-reddit-catchall.js [count] [providerHint]
 * providerHint: yahoo|catchall|bashed (default yahoo)
 * Env: PILOT_PROXY_IDS=90,104  — force proxy rotation order
 */
require('dotenv').config();
const fs = require('fs');
const accountCreationService = require('../services/accountCreationService');
const pool = require('../services/db');

const LOG = process.env.PILOT_LOG || '/tmp/reddit-catchall-pilot.log';
const count = Math.min(Math.max(parseInt(process.argv[2] || '1', 10) || 1, 1), 3);
const hint = String(process.argv[3] || 'yahoo').toLowerCase();
const forcedProxyIds = String(process.env.PILOT_PROXY_IDS || '')
  .split(',')
  .map((s) => parseInt(s.trim(), 10))
  .filter((n) => Number.isFinite(n) && n > 0);

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try {
    fs.appendFileSync(LOG, `${line}\n`);
  } catch (_) {
    /* ignore */
  }
}

const claimedIds = new Set();
let proxyCursor = 0;

async function claimPreferred() {
  const forcedEmailId = parseInt(process.env.PILOT_EMAIL_ID || '', 10);
  if (Number.isFinite(forcedEmailId) && forcedEmailId > 0) {
    const r = await pool.query(`SELECT ea.* FROM email_accounts ea WHERE ea.id = $1`, [
      forcedEmailId,
    ]);
    return r.rows[0] || null;
  }
  if (hint === 'yahoo') {
    const r = await pool.query(
      `SELECT ea.* FROM email_accounts ea
       WHERE ea.status='active' AND ea.provider='yahoo'
         AND COALESCE(ea.metadata->>'linked_reddit','')=''
         AND NOT EXISTS (SELECT 1 FROM social_accounts sa WHERE sa.email_account_id=ea.id)
         AND NOT EXISTS (SELECT 1 FROM social_accounts sa WHERE sa.email IS NOT NULL AND lower(sa.email)=lower(ea.email))
         AND NOT (ea.id = ANY($1::int[]))
       ORDER BY ea.id DESC LIMIT 1`,
      [[...claimedIds]]
    );
    return r.rows[0] || null;
  }
  if (hint === 'bashed') {
    const r = await pool.query(
      `SELECT ea.* FROM email_accounts ea
       WHERE ea.status='active' AND ea.provider='catchall'
         AND lower(split_part(ea.email,'@',2))='bashed.net'
         AND COALESCE(ea.metadata->>'linked_reddit','')=''
         AND NOT EXISTS (SELECT 1 FROM social_accounts sa WHERE sa.email_account_id=ea.id)
         AND NOT EXISTS (SELECT 1 FROM social_accounts sa WHERE sa.email IS NOT NULL AND lower(sa.email)=lower(ea.email))
         AND NOT (ea.id = ANY($1::int[]))
       ORDER BY ea.id DESC LIMIT 1`,
      [[...claimedIds]]
    );
    return r.rows[0] || null;
  }
  return accountCreationService.claimEmailFromPool();
}

async function main() {
  accountCreationService.claimEmailFromPool = async () => {
    const preferred = await claimPreferred();
    if (!preferred) return null;
    claimedIds.add(preferred.id);
    log(
      `claim ${JSON.stringify({
        id: preferred.id,
        email: preferred.email,
        provider: preferred.provider,
        hint,
      })}`
    );
    return preferred;
  };

  if (forcedProxyIds.length) {
    const orig = accountCreationService.claimProxyForNewAccount.bind(accountCreationService);
    accountCreationService.claimProxyForNewAccount = async () => {
      if (proxyCursor < forcedProxyIds.length) {
        const id = forcedProxyIds[proxyCursor++];
        log(`forcedProxy ${id}`);
        return id;
      }
      return orig();
    };
  }

  log(`START count=${count} hint=${hint} forcedProxies=${forcedProxyIds.join(',') || 'auto'}`);
  try {
    const result = await accountCreationService.createAccounts('reddit', count, null, null, [], {
      useEmailPool: true,
      warm: false,
      source: `pilot_${hint}_script`,
    });
    log(`RESULT ${JSON.stringify(result).slice(0, 20000)}`);
  } catch (err) {
    log(`FATAL ${err.message}`);
    throw err;
  } finally {
    log('END');
    await pool.end().catch(() => {});
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
