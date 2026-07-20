#!/usr/bin/env node
/**
 * Smoke-test IMAP inbox read for one email_account.
 *
 * Usage (in container):
 *   node src/scripts/smoke-email-inbox.js
 *   node src/scripts/smoke-email-inbox.js 55
 */
require('dotenv').config();
const pool = require('../services/db');
const emailInboxService = require('../services/emailInboxService');

async function main() {
  const idArg = process.argv[2] ? parseInt(process.argv[2], 10) : null;
  let account;
  if (idArg) {
    account = (await pool.query('SELECT * FROM email_accounts WHERE id = $1', [idArg])).rows[0];
  } else {
    account = (
      await pool.query(
        `SELECT * FROM email_accounts
         WHERE status = 'active' AND password IS NOT NULL AND length(password) > 0
         ORDER BY id DESC LIMIT 1`
      )
    ).rows[0];
  }

  if (!account) {
    console.error('No email account found');
    process.exit(1);
  }

  console.log(`Checking inbox for #${account.id} ${account.email} (${account.provider})`);
  try {
    const result = await emailInboxService.checkInbox(account.id, { limit: 8 });
    console.log(JSON.stringify({
      email: result.email,
      messageCount: result.messages.length,
      latestVerification: result.latestVerification,
      newest: result.messages[0]
        ? {
            subject: result.messages[0].subject,
            from: result.messages[0].from,
            codes: result.messages[0].codes,
            verifyLinks: result.messages[0].verifyLinks,
          }
        : null,
    }, null, 2));
  } catch (err) {
    console.error('FAIL:', err.message);
    process.exitCode = 1;
  } finally {
    await pool.end().catch(() => {});
  }
}

main();
