#!/usr/bin/env node
/**
 * Smoke Outlook web login for a bought Reddit account's inline email creds.
 * Usage: node src/scripts/smoke-bought-outlook.js [social_account_id]
 */
require('dotenv').config();
const pool = require('../services/db');
const emailInboxService = require('../services/emailInboxService');

function parseCreds(raw) {
  if (!raw) return {};
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }
  return raw;
}

async function main() {
  const id = Number(process.argv[2] || 16);
  const { rows } = await pool.query('SELECT * FROM social_accounts WHERE id = $1', [id]);
  const account = rows[0];
  if (!account) throw new Error('not found');
  const creds = parseCreds(account.credentials);
  const emailAccount = {
    email: account.email || creds.email,
    password: creds.email_password,
    provider: String(account.email || '').includes('hotmail') ? 'hotmail' : 'outlook',
    metadata: {},
  };
  console.log(`Testing inbox for social #${id} ${account.username} <${emailAccount.email}>`);
  const start = Date.now();
  try {
    const fetched = await emailInboxService.fetchRecentMessagesWithFallback(emailAccount, {
      limit: 5,
      timeoutMs: 60000,
    });
    console.log(
      JSON.stringify(
        {
          ms: Date.now() - start,
          method: fetched.method,
          imapError: fetched.imapError || null,
          count: fetched.messages?.length || 0,
          sample: (fetched.messages || []).slice(0, 3).map((m) => ({
            subject: m.subject,
            from: m.from,
            links: (m.verifyLinks || m.urls || []).slice(0, 3),
            preview: (m.preview || '').slice(0, 120),
          })),
        },
        null,
        2
      )
    );
  } catch (err) {
    console.error(`FAIL after ${Date.now() - start}ms:`, err.message);
    process.exitCode = 1;
  } finally {
    await pool.end().catch(() => {});
  }
}

main();
