/**
 * Mint Oxylabs sticky residential proxy rows on demand.
 * Concurrent sessions are effectively unlimited — empty free pool is NOT a shortage.
 */
const pool = require('./db');
const proxyService = require('./proxyService');

const PROVIDER = 'Oxylabs';

function buildUsername(base, country, sessid, sesstime) {
  const b = String(base || '').startsWith('customer-') ? String(base) : `customer-${base}`;
  return `${b}-cc-${country}-sessid-${sessid}-sesstime-${sesstime}`;
}

/** Extract customer-USER from a full sticky username. */
function parseBaseUsername(fullUsername) {
  const s = String(fullUsername || '');
  const m = s.match(/^(customer-[^-]+(?:_[^-]+)?)/);
  if (m) return m[1];
  // Fallback: everything before -cc-
  const idx = s.indexOf('-cc-');
  if (idx > 0) return s.slice(0, idx);
  return s.startsWith('customer-') ? s : null;
}

class OxylabsStickyService {
  constructor() {
    this.lastProvisionError = null;
    this.lastProvisionAt = null;
  }

  getConfigFromEnv() {
    const username = process.env.OXYLABS_USERNAME || null;
    const password = process.env.OXYLABS_PASSWORD || null;
    return {
      username,
      password,
      host: process.env.OXYLABS_HOST || 'pr.oxylabs.io',
      port: Number(process.env.OXYLABS_PORT || 7777),
      country: process.env.OXYLABS_COUNTRY || 'US',
      sesstime: Math.min(120, Math.max(1, Number(process.env.OXYLABS_SESSTIME || 30))),
      source: username && password ? 'env' : null,
    };
  }

  /** Prefer env; else reuse creds from any active Oxylabs proxy row. */
  async resolveCredentials() {
    const fromEnv = this.getConfigFromEnv();
    if (fromEnv.username && fromEnv.password) return fromEnv;

    const { rows } = await pool.query(
      `SELECT username, password, server, country, metadata
       FROM proxies
       WHERE provider = $1 AND is_active = true
         AND password IS NOT NULL AND username IS NOT NULL
       ORDER BY id DESC
       LIMIT 1`,
      [PROVIDER]
    );
    const row = rows[0];
    if (!row) {
      return {
        ...fromEnv,
        username: null,
        password: null,
        source: null,
      };
    }

    const base = parseBaseUsername(row.username);
    const meta = row.metadata && typeof row.metadata === 'object' ? row.metadata : {};
    let host = fromEnv.host;
    let port = fromEnv.port;
    if (row.server && row.server.includes(':')) {
      const [h, p] = row.server.split(':');
      host = h || host;
      port = Number(p) || port;
    }
    const sesstime = Math.min(
      120,
      Math.max(1, Number(meta.sesstime_min || process.env.OXYLABS_SESSTIME || fromEnv.sesstime || 30))
    );
    return {
      username: base || fromEnv.username,
      password: row.password || fromEnv.password,
      host: meta.host || host,
      port: Number(meta.port) || port,
      country: row.country || meta.country || fromEnv.country,
      sesstime,
      source: 'existing_proxy',
    };
  }

  async hasCredentials() {
    const c = await this.resolveCredentials();
    return Boolean(c.username && c.password);
  }

  getLastProvisionError() {
    return this.lastProvisionError;
  }

  /**
   * Create or refresh a sticky Oxylabs proxy for one account and bind 1:1.
   * @param {number} accountId
   * @param {{ replace?: boolean, sessid?: string }} [opts]
   * @returns {{ proxyId, created, updated, assigned }}
   */
  async ensureStickyForAccount(accountId, { replace = false, sessid = null, rotateMeta = null } = {}) {
    const creds = await this.resolveCredentials();
    if (!creds.username || !creds.password) {
      const err = new Error('Oxylabs credentials missing (OXYLABS_USERNAME/PASSWORD)');
      this.lastProvisionError = err.message;
      throw err;
    }

    const acct = await pool.query(
      `SELECT id, username, platform FROM social_accounts WHERE id = $1`,
      [accountId]
    );
    if (!acct.rows[0]) throw new Error(`account ${accountId} not found`);

    const { username: acctName, platform } = acct.rows[0];
    const stickyId = sessid || `acct${accountId}`;
    const server = `${creds.host}:${creds.port}`;
    const proxyUsername = buildUsername(creds.username, creds.country, stickyId, creds.sesstime);
    const name = `Oxylabs ${creds.country} sticky ${stickyId}`;

    const existing = await pool.query(
      `SELECT id FROM proxies WHERE provider = $1 AND username = $2 AND server = $3 LIMIT 1`,
      [PROVIDER, proxyUsername, server]
    );

    const metadata = {
      provider: PROVIDER,
      product: 'residential',
      sticky: true,
      sessid: stickyId,
      sesstime_min: creds.sesstime,
      country: creds.country,
      host: creds.host,
      port: creds.port,
      bound_account_id: accountId,
      bound_platform: platform,
      minted_on_demand: true,
      ...(rotateMeta && typeof rotateMeta === 'object' ? rotateMeta : {}),
    };

    let proxyId;
    let created = 0;
    let updated = 0;

    if (existing.rows[0]) {
      proxyId = existing.rows[0].id;
      await pool.query(
        `UPDATE proxies SET name=$1, type='http', password=$2, country=$3,
           is_residential=true, metadata=$4::jsonb, is_active=true,
           cooldown_until=NULL, consecutive_failures=0, updated_at=NOW()
         WHERE id=$5`,
        [name, creds.password, creds.country, JSON.stringify(metadata), proxyId]
      );
      updated = 1;
    } else {
      const proxy = await proxyService.createProxy({
        name,
        type: 'http',
        server,
        username: proxyUsername,
        password: creds.password,
        country: creds.country,
        city: null,
        provider: PROVIDER,
        is_residential: true,
        metadata,
      });
      proxyId = proxy.id;
      created = 1;
    }

    if (replace) {
      await pool.query(
        `UPDATE social_account_proxies SET is_active=false WHERE social_account_id=$1`,
        [accountId]
      );
    }
    await proxyService.assignProxiesToAccount(accountId, [proxyId]);
    this.lastProvisionError = null;
    this.lastProvisionAt = new Date().toISOString();
    return {
      proxyId,
      created,
      updated,
      assigned: 1,
      accountId,
      account: acctName,
      platform,
    };
  }

  /**
   * Mint a NEW Oxylabs sticky sessid for an X account (exit IP rotation).
   * Cap: one rotate per account per calendar day for a given failure_class.
   * Does not re-login — only rebinds proxy for the next soft-skip window.
   * Daily-cap marker lives on proxies.metadata (social_accounts has no metadata col).
   */
  async rotateStickyForAccount(accountId, { failureClass = 'proxy_error' } = {}) {
    const dayKey = new Date().toISOString().slice(0, 10);

    const acct = await pool.query(
      `SELECT id, platform, username FROM social_accounts WHERE id = $1`,
      [accountId]
    );
    const row = acct.rows[0];
    if (!row) throw new Error(`account ${accountId} not found`);
    const plat = String(row.platform || '').toLowerCase();
    if (plat !== 'x' && plat !== 'twitter') {
      return { rotated: false, reason: 'not_x' };
    }

    const already = await pool.query(
      `SELECT p.id
       FROM proxies p
       JOIN social_account_proxies sap ON sap.proxy_id = p.id
       WHERE sap.social_account_id = $1
         AND p.metadata->>'rotate_day' = $2
         AND p.metadata->>'rotate_failure_class' = $3
       LIMIT 1`,
      [accountId, dayKey, failureClass]
    );
    if (already.rows[0]) {
      return { rotated: false, reason: 'daily_cap', day: dayKey, failureClass };
    }

    const suffix = `${dayKey.replace(/-/g, '')}${Math.floor(Math.random() * 90 + 10)}`;
    const sessid = `acct${accountId}r${suffix}`.slice(0, 64);
    const result = await this.ensureStickyForAccount(accountId, {
      replace: true,
      sessid,
      rotateMeta: {
        rotate_day: dayKey,
        rotate_failure_class: failureClass,
        rotated_at: new Date().toISOString(),
        rotated_from: failureClass,
      },
    });

    console.warn(
      `Oxylabs sticky rotated account=${accountId} (@${row.username}) sessid=${sessid} class=${failureClass}`
    );
    return { rotated: true, ...result, sessid, failureClass, day: dayKey };
  }

  /**
   * Mint + bind stickies for unbound active X accounts.
   * Parallel batches keep this fast for dozens of accounts.
   */
  async bindUnboundXAccounts(limit = 80, { concurrency = 8 } = {}) {
    const unbound = await pool.query(
      `SELECT sa.id
       FROM social_accounts sa
       WHERE sa.status = 'active'
         AND COALESCE(sa.is_simulated, false) = false
         AND lower(sa.platform) = ANY($1::text[])
         AND NOT EXISTS (
           SELECT 1 FROM social_account_proxies sap
           WHERE sap.social_account_id = sa.id AND sap.is_active = true
         )
       ORDER BY sa.id
       LIMIT $2`,
      [['x', 'twitter'], limit]
    );

    const ids = unbound.rows.map((r) => r.id);
    const summary = {
      unbound: ids.length,
      created: 0,
      updated: 0,
      bound: 0,
      failed: 0,
      errors: [],
    };

    if (!ids.length) return summary;

    const credsOk = await this.hasCredentials();
    if (!credsOk) {
      const msg = 'Oxylabs credentials missing — cannot mint sticky sessions';
      this.lastProvisionError = msg;
      summary.failed = ids.length;
      summary.errors.push(msg);
      return summary;
    }

    let cursor = 0;
    const workers = Array.from({ length: Math.min(concurrency, ids.length) }, async () => {
      while (cursor < ids.length) {
        const i = cursor++;
        const accountId = ids[i];
        try {
          const r = await this.ensureStickyForAccount(accountId, { replace: false });
          summary.created += r.created;
          summary.updated += r.updated;
          summary.bound += r.assigned;
        } catch (err) {
          summary.failed += 1;
          const msg = err?.message || String(err);
          this.lastProvisionError = msg;
          if (summary.errors.length < 5) summary.errors.push(`account ${accountId}: ${msg}`);
          console.warn(`Oxylabs sticky mint failed account=${accountId}:`, msg);
        }
      }
    });

    await Promise.all(workers);
    this.lastProvisionAt = new Date().toISOString();
    return summary;
  }
}

module.exports = new OxylabsStickyService();
