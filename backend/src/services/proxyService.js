const pool = require('./db');
const axios = require('axios');

/** Circuit-breaker thresholds — keep proxies from being burned. */
const PROTECTION = {
  cooldownAfterProxyPathFails: 2,
  cooldownAfterOtherFails: 3,
  disableAfterConsecutiveProxyPath: 5,
  disableAfterConsecutiveAny: 8,
  disableAfterTotalFailures: 10,
  healthProbeMinIntervalMs: 60_000,
  healthProbeTimeoutMs: 12_000,
};

class ProxyService {
  constructor() {
    this.proxyCache = new Map(); // Cache for frequently used proxies
    this._lastProbeAt = new Map(); // proxyId -> ms
  }

  getProtectionThresholds() {
    return { ...PROTECTION };
  }

  // Create a new proxy
  async createProxy(proxyData) {
    const {
      name,
      type = 'http',
      server,
      username,
      password,
      country,
      city,
      provider,
      is_residential = false,
      metadata = {}
    } = proxyData;

    const result = await pool.query(
      `INSERT INTO proxies 
       (name, type, server, username, password, country, city, provider, is_residential, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [name, type, server, username, password, country, city, provider, is_residential, metadata]
    );

    return result.rows[0];
  }

  // Get all active proxies
  async getActiveProxies(filters = {}) {
    let query = 'SELECT * FROM proxies WHERE is_active = true';
    const params = [];
    let paramCount = 0;

    if (filters.type) {
      paramCount++;
      query += ` AND type = $${paramCount}`;
      params.push(filters.type);
    }

    if (filters.country) {
      paramCount++;
      query += ` AND country = $${paramCount}`;
      params.push(filters.country);
    }

    if (filters.is_residential !== undefined) {
      paramCount++;
      query += ` AND is_residential = $${paramCount}`;
      params.push(filters.is_residential);
    }

    query += ' ORDER BY failure_count ASC, last_used_at ASC NULLS FIRST';

    const result = await pool.query(query, params);
    return result.rows;
  }

  // Assign proxy to social account
  async assignProxyToAccount(accountId, proxyId, priority = 1) {
    const result = await pool.query(
      `INSERT INTO social_account_proxies 
       (social_account_id, proxy_id, priority)
       VALUES ($1, $2, $3)
       ON CONFLICT (social_account_id, proxy_id) 
       DO UPDATE SET priority = $3, is_active = true
       RETURNING *`,
      [accountId, proxyId, priority]
    );

    return result.rows[0];
  }

  // Assign exactly one dedicated proxy to an account (strict 1:1)
  async assignProxiesToAccount(accountId, proxyIds) {
    if (!Array.isArray(proxyIds) || proxyIds.length !== 1) {
      throw new Error('Exactly one proxy must be assigned per account (1:1 mapping)');
    }

    const proxyId = proxyIds[0];
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      // Soft-disable existing assignments for this account
      await client.query(
        'UPDATE social_account_proxies SET is_active = false WHERE social_account_id = $1',
        [accountId]
      );

      // Free the proxy from any other account
      await client.query(
        'UPDATE social_account_proxies SET is_active = false WHERE proxy_id = $1 AND social_account_id != $2',
        [proxyId, accountId]
      );

      const existing = await client.query(
        `SELECT id FROM social_account_proxies
         WHERE social_account_id = $1 AND proxy_id = $2
         LIMIT 1`,
        [accountId, proxyId]
      );

      let result;
      if (existing.rows[0]) {
        result = await client.query(
          `UPDATE social_account_proxies
           SET priority = 1, is_active = true, assigned_at = NOW()
           WHERE id = $1
           RETURNING *`,
          [existing.rows[0].id]
        );
      } else {
        result = await client.query(
          `INSERT INTO social_account_proxies
             (social_account_id, proxy_id, priority, is_active)
           VALUES ($1, $2, 1, true)
           RETURNING *`,
          [accountId, proxyId]
        );
      }

      await client.query('COMMIT');
      return [result.rows[0]];
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async getProxyMappingStatus() {
    const overview = await pool.query(`
      SELECT
        (SELECT COUNT(*)::int FROM proxies WHERE is_active) AS active_proxies,
        (SELECT COUNT(*)::int FROM social_accounts
          WHERE COALESCE(is_simulated, false) = false) AS live_accounts,
        (SELECT COUNT(DISTINCT sap.social_account_id)::int
           FROM social_account_proxies sap
           JOIN social_accounts sa ON sa.id = sap.social_account_id
          WHERE sap.is_active = true AND COALESCE(sa.is_simulated, false) = false) AS accounts_with_proxy,
        (SELECT COUNT(*)::int FROM proxies p
          WHERE p.is_active AND NOT EXISTS (
            SELECT 1 FROM social_account_proxies sap
            WHERE sap.proxy_id = p.id AND sap.is_active = true
          )) AS unassigned_proxies,
        (SELECT COUNT(*)::int FROM social_accounts sa
          WHERE COALESCE(sa.is_simulated, false) = false
            AND NOT EXISTS (
              SELECT 1 FROM social_account_proxies sap
              WHERE sap.social_account_id = sa.id AND sap.is_active = true
            )) AS accounts_without_proxy
    `);

    const unassigned = await pool.query(`
      SELECT p.* FROM proxies p
      WHERE p.is_active = true
        AND NOT EXISTS (
          SELECT 1 FROM social_account_proxies sap
          WHERE sap.proxy_id = p.id AND sap.is_active = true
        )
      ORDER BY p.id
    `);

    const withoutProxy = await pool.query(`
      SELECT sa.id, sa.platform, sa.username, sa.status
      FROM social_accounts sa
      WHERE COALESCE(sa.is_simulated, false) = false
        AND NOT EXISTS (
          SELECT 1 FROM social_account_proxies sap
          WHERE sap.social_account_id = sa.id AND sap.is_active = true
        )
      ORDER BY sa.id
    `);

    const multi = await pool.query(`
      SELECT social_account_id, COUNT(*)::int AS proxy_count
      FROM social_account_proxies
      WHERE is_active = true
      GROUP BY social_account_id
      HAVING COUNT(*) > 1
    `);

    const shared = await pool.query(`
      SELECT proxy_id, COUNT(*)::int AS account_count
      FROM social_account_proxies
      WHERE is_active = true
      GROUP BY proxy_id
      HAVING COUNT(*) > 1
    `);

    const row = overview.rows[0];
    const ok =
      row.unassigned_proxies === 0 &&
      row.accounts_without_proxy === 0 &&
      multi.rows.length === 0 &&
      shared.rows.length === 0;

    return {
      ok,
      overview: row,
      unassigned_proxies: unassigned.rows,
      accounts_without_proxy: withoutProxy.rows,
      accounts_with_multiple_proxies: multi.rows,
      proxies_shared_across_accounts: shared.rows,
    };
  }

  /**
   * Create Reddit shell accounts for unassigned proxies and bind 1:1.
   * Shells are status=pending_setup until real Reddit credentials are filled in.
   */
  async reconcileProxyAccountMapping({ createMissing = true } = {}) {
    const commentingService = require('./commentingService');
    const created = [];
    const assigned = [];

    const unassigned = await pool.query(`
      SELECT p.* FROM proxies p
      WHERE p.is_active = true
        AND (p.cooldown_until IS NULL OR p.cooldown_until <= NOW())
        AND COALESCE(p.consecutive_failures, 0) < $1
        AND COALESCE(p.last_health_ok, true) = true
        AND NOT EXISTS (
          SELECT 1 FROM social_account_proxies sap
          WHERE sap.proxy_id = p.id AND sap.is_active = true
        )
      ORDER BY p.failure_count ASC, p.id
    `, [PROTECTION.cooldownAfterOtherFails]);

    for (const proxy of unassigned.rows) {
      let accountId = null;

      if (createMissing) {
        const persona = await commentingService.generatePersonalityTraits();
        const suffix = Math.floor(1000 + Math.random() * 9000);
        const username = `user_${Date.now().toString().slice(-6)}${suffix}`.slice(0, 20);
        const email = `${username}@pending.local`;
        const password = `Pb${Math.random().toString(36).slice(2, 10)}!A1`;

        const inserted = await pool.query(
          `INSERT INTO social_accounts
             (platform, username, email, credentials, status, is_simulated, persona_traits, warmup_status)
           VALUES ('reddit', $1, $2, $3, 'pending_setup', false, $4, 'new')
           RETURNING *`,
          [username, email, JSON.stringify({ password, needs_signup: true }), JSON.stringify(persona)]
        );
        accountId = inserted.rows[0].id;
        created.push(inserted.rows[0]);
      }

      if (accountId) {
        const rows = await this.assignProxiesToAccount(accountId, [proxy.id]);
        assigned.push({ proxy_id: proxy.id, social_account_id: accountId, assignment: rows[0] });
      }
    }

    // Also bind accounts missing a proxy to leftover unused proxies if any remain after creates
    const status = await this.getProxyMappingStatus();
    for (const account of status.accounts_without_proxy) {
      const free = await pool.query(`
        SELECT p.id FROM proxies p
        WHERE p.is_active = true
          AND (p.cooldown_until IS NULL OR p.cooldown_until <= NOW())
          AND COALESCE(p.consecutive_failures, 0) < $1
          AND COALESCE(p.last_health_ok, true) = true
          AND NOT EXISTS (
            SELECT 1 FROM social_account_proxies sap
            WHERE sap.proxy_id = p.id AND sap.is_active = true
          )
        ORDER BY p.failure_count ASC, p.id
        LIMIT 1
      `, [PROTECTION.cooldownAfterOtherFails]);
      if (!free.rows[0]) break;
      const rows = await this.assignProxiesToAccount(account.id, [free.rows[0].id]);
      assigned.push({ proxy_id: free.rows[0].id, social_account_id: account.id, assignment: rows[0] });
    }

    return {
      created_accounts: created.length,
      assignments: assigned,
      status: await this.getProxyMappingStatus(),
    };
  }

  // Get proxies assigned to an account
  async getAccountProxies(accountId, onlyActive = true) {
    const query = `
      SELECT p.*, sap.priority, sap.last_used_at as account_last_used_at, 
             sap.use_count as account_use_count
      FROM proxies p
      JOIN social_account_proxies sap ON p.id = sap.proxy_id
      WHERE sap.social_account_id = $1
      ${onlyActive ? `AND sap.is_active = true AND p.is_active = true
        AND (p.cooldown_until IS NULL OR p.cooldown_until <= NOW())` : ''}
      ORDER BY sap.priority ASC, sap.last_used_at ASC NULLS FIRST
    `;

    const result = await pool.query(query, [accountId]);
    return result.rows;
  }

  /** ProxyBase sticky mobile pools (and similar) — prefer Android fingerprints. */
  isMobileProxy(proxy) {
    if (!proxy) return false;
    const blob = [
      proxy.name,
      proxy.type,
      proxy.provider,
      proxy.server,
      JSON.stringify(proxy.metadata || {}),
    ]
      .join(' ')
      .toLowerCase();
    return /mobile|android|proxybase|sticky=.*type=mobile|type=mobile/.test(blob);
  }

  // Get next proxy for an account (with rotation)
  async getNextProxyForAccount(accountId) {
    const proxies = await this.getAccountProxies(accountId, true);
    
    if (proxies.length === 0) {
      return null;
    }

    // Simple rotation: pick the proxy that was used longest ago
    // You can implement more sophisticated strategies here
    const selectedProxy = proxies[0];

    // Update last used timestamp
    await pool.query(
      `UPDATE social_account_proxies 
       SET last_used_at = NOW(), use_count = use_count + 1
       WHERE social_account_id = $1 AND proxy_id = $2`,
      [accountId, selectedProxy.id]
    );

    await pool.query(
      'UPDATE proxies SET last_used_at = NOW() WHERE id = $1',
      [selectedProxy.id]
    );

    return this.formatProxyConfig(selectedProxy);
  }

  // Format proxy for Playwright
  formatProxyConfig(proxy) {
    if (!proxy) return null;

    const protocol = proxy.type === 'socks5' ? 'socks5://' : 'http://';
    const server = proxy.server.includes('://') ? proxy.server.split('://')[1] : proxy.server;

    return {
      server: `${protocol}${server}`,
      username: proxy.username,
      password: proxy.password,
      bypass: 'localhost,127.0.0.1,::1',
      _proxyId: proxy.id // Internal tracking for stats
    };
  }

  // Update proxy stats after use — circuit-breaker on repeated failures
  async updateProxyStats(proxyId, success, { reason = null } = {}) {
    const truncatedReason = reason ? String(reason).slice(0, 500) : null;

    if (success) {
      await pool.query(
        `UPDATE proxies
         SET success_count = success_count + 1,
             consecutive_failures = 0,
             cooldown_until = NULL,
             last_error = NULL,
             last_success_at = NOW(),
             last_used_at = NOW(),
             updated_at = NOW()
         WHERE id = $1`,
        [proxyId]
      );
      return { action: 'success' };
    }

    const result = await pool.query(
      `UPDATE proxies
       SET failure_count = failure_count + 1,
           consecutive_failures = COALESCE(consecutive_failures, 0) + 1,
           last_error = $2,
           last_failure_at = NOW(),
           last_used_at = NOW(),
           updated_at = NOW()
       WHERE id = $1
       RETURNING failure_count, consecutive_failures, is_active`,
      [proxyId, truncatedReason]
    );

    const row = result.rows[0];
    if (!row) return { action: 'missing' };

    const consecutive = row.consecutive_failures || 0;
    // Tunnel/timeout/proxy path: cool down sooner; disable before total burn
    const isProxyPath = truncatedReason && /tunnel|timed_out|timeout|proxy|err_|ECONNREFUSED|ENOTFOUND|socket/i.test(truncatedReason);
    const tripAt = isProxyPath
      ? PROTECTION.cooldownAfterProxyPathFails
      : PROTECTION.cooldownAfterOtherFails;

    let action = 'recorded';

    if (consecutive >= tripAt) {
      const hours = Math.min(24, 4 * consecutive);
      await pool.query(
        `UPDATE proxies
         SET cooldown_until = NOW() + ($2 * INTERVAL '1 hour'),
             updated_at = NOW()
         WHERE id = $1`,
        [proxyId, hours]
      );
      action = 'cooldown';
      console.warn(
        `Proxy ${proxyId} circuit open for ${hours}h after ${consecutive} failures` +
          (truncatedReason ? ` (${truncatedReason})` : '')
      );
    }

    const disableForConsecutive =
      (isProxyPath && consecutive >= PROTECTION.disableAfterConsecutiveProxyPath) ||
      consecutive >= PROTECTION.disableAfterConsecutiveAny;
    const disableForTotal = row.failure_count >= PROTECTION.disableAfterTotalFailures;

    if (row.is_active && (disableForConsecutive || disableForTotal)) {
      await this.disableProxy(proxyId);
      action = 'disabled';
      console.warn(
        `Proxy ${proxyId} disabled after ${consecutive} consecutive / ${row.failure_count} total failures` +
          (truncatedReason ? ` (${truncatedReason})` : '')
      );
    }

    return { action, consecutive, failure_count: row.failure_count, isProxyPath };
  }

  // Disable a proxy (and free it from new assignment until manually re-enabled)
  async disableProxy(proxyId) {
    await pool.query(
      `UPDATE proxies
       SET is_active = false, updated_at = NOW()
       WHERE id = $1`,
      [proxyId]
    );
  }

  // Enable a proxy — clears burn counters so it can re-enter rotation intentionally
  async enableProxy(proxyId) {
    await pool.query(
      `UPDATE proxies
       SET is_active = true,
           failure_count = 0,
           consecutive_failures = 0,
           cooldown_until = NULL,
           last_error = NULL,
           updated_at = NOW()
       WHERE id = $1`,
      [proxyId]
    );
  }

  /**
   * Lightweight egress check (ipify) via HTTP proxy — rate-limited per proxy
   * so we do not hammer Bright Data / ProxyBase.
   */
  async probeProxyHealth(proxyId, { force = false } = {}) {
    const last = this._lastProbeAt.get(Number(proxyId)) || 0;
    const elapsed = Date.now() - last;
    if (!force && elapsed < PROTECTION.healthProbeMinIntervalMs) {
      return {
        skipped: true,
        reason: 'rate_limited',
        retry_after_ms: PROTECTION.healthProbeMinIntervalMs - elapsed,
      };
    }

    const result = await pool.query('SELECT * FROM proxies WHERE id = $1', [proxyId]);
    const proxy = result.rows[0];
    if (!proxy) throw new Error('Proxy not found');

    this._lastProbeAt.set(Number(proxyId), Date.now());

    const serverRaw = proxy.server.includes('://')
      ? proxy.server.split('://')[1]
      : proxy.server;
    const [host, portStr] = serverRaw.split(':');
    const port = parseInt(portStr, 10) || 80;

    const started = Date.now();
    try {
      const response = await axios.get('https://api.ipify.org?format=json', {
        timeout: PROTECTION.healthProbeTimeoutMs,
        proxy: {
          protocol: proxy.type === 'https' ? 'https' : 'http',
          host,
          port,
          auth: proxy.username
            ? { username: proxy.username, password: proxy.password || '' }
            : undefined,
        },
        validateStatus: () => true,
      });

      const ok = response.status === 200 && response.data?.ip;
      const detectedIp = ok ? response.data.ip : null;
      const latencyMs = Date.now() - started;

      await pool.query(
        `UPDATE proxies
         SET last_health_check_at = NOW(),
             last_health_ok = $2,
             last_tested_at = NOW(),
             updated_at = NOW()
         WHERE id = $1`,
        [proxyId, ok]
      );

      if (ok) {
        await this.updateProxyStats(proxyId, true);
        return { success: true, detectedIp, latencyMs, proxy: proxy.name };
      }

      await this.updateProxyStats(proxyId, false, {
        reason: `health_probe_http_${response.status}`,
      });
      return {
        success: false,
        status: response.status,
        latencyMs,
        proxy: proxy.name,
        error: `HTTP ${response.status}`,
      };
    } catch (error) {
      const latencyMs = Date.now() - started;
      await pool.query(
        `UPDATE proxies
         SET last_health_check_at = NOW(),
             last_health_ok = false,
             last_tested_at = NOW(),
             updated_at = NOW()
         WHERE id = $1`,
        [proxyId]
      );
      await this.updateProxyStats(proxyId, false, { reason: error.message });
      return {
        success: false,
        latencyMs,
        proxy: proxy.name,
        error: error.message,
      };
    }
  }

  /** Whether a proxy row is safe to assign (active, not cooled, not burning). */
  isAssignableProxy(proxy) {
    if (!proxy || !proxy.is_active) return false;
    if (proxy.cooldown_until && new Date(proxy.cooldown_until) > new Date()) return false;
    if ((proxy.consecutive_failures || 0) >= PROTECTION.cooldownAfterOtherFails) return false;
    if (proxy.last_health_ok === false) return false;
    return true;
  }

  // Test proxy connection
  async testProxy(proxyId) {
    const result = await pool.query('SELECT * FROM proxies WHERE id = $1', [proxyId]);
    if (result.rows.length === 0) {
      throw new Error('Proxy not found');
    }

    const proxy = result.rows[0];
    const proxyConfig = this.formatProxyConfig(proxy);

    // Import playwright dynamically to avoid circular dependency
    const { chromium } = require('playwright-extra');
    const stealth = require('puppeteer-extra-plugin-stealth')();
    chromium.use(stealth);

    let browser;
    try {
      browser = await chromium.launch({
        headless: true,
        proxy: proxyConfig
      });

      const context = await browser.newContext();
      const page = await context.newPage();

      // Test by checking IP address
      await page.goto('https://api.ipify.org?format=json', { timeout: 15000 });
      const content = await page.content();
      const ipMatch = content.match(/"ip":"([^"]+)"/);
      const detectedIp = ipMatch ? ipMatch[1] : 'unknown';

      await browser.close();

      await this.updateProxyStats(proxyId, true);

      return {
        success: true,
        proxy: proxy.name,
        detectedIp,
        message: 'Proxy is working correctly'
      };
    } catch (error) {
      if (browser) await browser.close();
      
      await this.updateProxyStats(proxyId, false);

      return {
        success: false,
        proxy: proxy.name,
        error: error.message,
        message: 'Proxy test failed'
      };
    }
  }

  // Bulk import proxies
  async bulkImportProxies(proxies) {
    const results = [];
    
    for (const proxy of proxies) {
      try {
        const result = await this.createProxy(proxy);
        results.push({ success: true, proxy: result });
      } catch (error) {
        results.push({ success: false, error: error.message, data: proxy });
      }
    }

    return results;
  }

  // Get proxy statistics
  async getProxyStats() {
    const stats = await pool.query(`
      SELECT 
        COUNT(*) as total_proxies,
        COUNT(*) FILTER (WHERE is_active = true) as active_proxies,
        COUNT(*) FILTER (WHERE is_residential = true) as residential_proxies,
        COUNT(*) FILTER (
          WHERE is_active AND cooldown_until IS NOT NULL AND cooldown_until > NOW()
        ) as cooldown_proxies,
        COUNT(*) FILTER (WHERE type = 'http') as http_proxies,
        COUNT(*) FILTER (WHERE type = 'https') as https_proxies,
        COUNT(*) FILTER (WHERE type = 'socks5') as socks5_proxies,
        AVG(success_count)::int as avg_success_count,
        AVG(failure_count)::int as avg_failure_count
      FROM proxies
    `);

    const byCountry = await pool.query(`
      SELECT country, COUNT(*) as count
      FROM proxies
      WHERE country IS NOT NULL
      GROUP BY country
      ORDER BY count DESC
    `);

    const byProvider = await pool.query(`
      SELECT provider, COUNT(*) as count, 
             COUNT(*) FILTER (WHERE is_active = true) as active_count,
             COUNT(*) FILTER (
               WHERE is_active AND cooldown_until IS NOT NULL AND cooldown_until > NOW()
             ) as cooldown_count
      FROM proxies
      WHERE provider IS NOT NULL
      GROUP BY provider
      ORDER BY count DESC
    `);

    return {
      overview: stats.rows[0],
      byCountry: byCountry.rows,
      byProvider: byProvider.rows,
      protection: this.getProtectionThresholds(),
    };
  }
}

module.exports = new ProxyService();
