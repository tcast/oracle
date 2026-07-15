#!/usr/bin/env node
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const proxyService = require('../services/proxyService');
const pool = require('../services/db');

async function main() {
  const fs = require('fs');
  const path = require('path');
  const migration = path.join(__dirname, '../../../database/migrations/029_organic_commenting.sql');
  if (fs.existsSync(migration)) {
    const sql = fs.readFileSync(migration, 'utf8');
    await pool.query(sql);
    console.log('Applied migration 029_organic_commenting.sql');
  }

  const before = await proxyService.getProxyMappingStatus();
  console.log('Before:', before.overview);

  const result = await proxyService.reconcileProxyAccountMapping({ createMissing: true });
  console.log('Created accounts:', result.created_accounts);
  console.log('Assignments:', result.assignments.length);
  console.log('After:', result.status.overview);
  console.log('OK:', result.status.ok);

  await pool.end();
}

main().catch(async (err) => {
  console.error(err);
  try { await pool.end(); } catch { /* ignore */ }
  process.exit(1);
});
