#!/usr/bin/env node
/**
 * Careful Reddit create pilot via email pool.
 * Usage: node src/scripts/pilot-reddit-catchall.js [count] [providerHint]
 * providerHint: catchall|yahoo|bashed (default catchall prefer)
 */
require('dotenv').config();
const fs = require('fs');
const accountCreationService = require('../services/accountCreationService');
const pool = require('../services/db');

const LOG = process.env.PILOT_LOG || '/tmp/reddit-catchall-pilot.log';
const count = Math.min(Math.max(parseInt(process.argv[2] || '1', 10) || 1, 1), 3);
const hint = String(process.argv[3] || 'catchall').toLowerCase();

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try {
    fs.appendFileSync(LOG, `${line}\n`);
  } catch (_) {
    /* ignore */
  }
}

async function claimPreferred() {
  if (hint === 'yahoo') {
    const r = await pool.query(
      `SELECT ea.* FROM email_accounts ea
       WHERE ea.status='active' AND ea.provider='yahoo'
         AND COALESCE(ea.metadata->>'linked_reddit','')=''
         AND NOT EXISTS (SELECT 1 FROM social_accounts sa WHERE sa.email_account_id=ea.id)
         AND NOT EXISTS (SELECT 1 FROM social_accounts sa WHERE sa.email IS NOT NULL AND lower(sa.email)=lower(ea.email))
       ORDER BY ea.id DESC LIMIT 1`
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
       ORDER BY ea.id DESC LIMIT 1`
    );
    return r.rows[0] || null;
  }
  return accountCreationService.claimEmailFromPool();
}

async function main() {
  const preferred = await claimPreferred();
  if (!preferred) throw new Error(`No claimable email for hint=${hint}`);
  accountCreationService.claimEmailFromPool = async () => preferred;

  log(
    `claim ${JSON.stringify({
      id: preferred.id,
      email: preferred.email,
      provider: preferred.provider,
      hint,
    })}`
  );
  log(`START count=${count}`);
  try {
    const result = await accountCreationService.createAccounts('reddit', count, null, null, [], {
      useEmailPool: true,
      warm: true,
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
