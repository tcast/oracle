#!/usr/bin/env node
/**
 * Apply HR/Talent hiring personas (InsightHire-aware) to LinkedIn accounts.
 *
 * Usage:
 *   node src/scripts/update-linkedin-hiring-personas.js
 *   node src/scripts/update-linkedin-hiring-personas.js 279
 */
require('dotenv').config();
const pool = require('../services/db');
const playwrightService = require('../services/playwrightService');
const { personas } = require('../services/linkedinHiringPersonas');

async function main() {
  const onlyId = process.argv[2] ? Number(process.argv[2]) : null;
  const ids = onlyId
    ? [onlyId]
    : Object.keys(personas).map(Number).sort((a, b) => a - b);

  console.log(`Updating ${ids.length} LinkedIn hiring persona(s)…`);
  const results = [];
  for (const id of ids) {
    const persona = personas[id];
    if (!persona) {
      console.log(`No persona for #${id}, skip`);
      continue;
    }
    console.log(`\n=== #${id} ${persona.name} → ${persona.title} @ ${persona.company} ===`);
    const result = await playwrightService.updateLinkedInHiringPersona(id, persona, {
      requireProxy: false,
    });
    results.push(result);
    console.log(JSON.stringify(result));
    await new Promise((r) => setTimeout(r, 8000 + Math.floor(Math.random() * 5000)));
  }

  console.log('\n===== SUMMARY =====');
  console.table(
    results.map((r) => ({
      id: r.accountId,
      name: (r.name || '').slice(0, 22),
      ok: !!r.success,
      steps: (r.steps || []).join(','),
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
