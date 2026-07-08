const pool = require('./db');

class ProxyService {
  constructor() {
    this.proxyCache = new Map(); // Cache for frequently used proxies
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

  // Assign multiple proxies to an account
  async assignProxiesToAccount(accountId, proxyIds) {
    const client = await pool.connect();
    
    try {
      await client.query('BEGIN');

      // Remove existing inactive assignments
      await client.query(
        'UPDATE social_account_proxies SET is_active = false WHERE social_account_id = $1',
        [accountId]
      );

      // Add new assignments
      const assignments = [];
      for (let i = 0; i < proxyIds.length; i++) {
        const result = await client.query(
          `INSERT INTO social_account_proxies 
           (social_account_id, proxy_id, priority)
           VALUES ($1, $2, $3)
           ON CONFLICT (social_account_id, proxy_id) 
           DO UPDATE SET priority = $3, is_active = true
           RETURNING *`,
          [accountId, proxyIds[i], i + 1]
        );
        assignments.push(result.rows[0]);
      }

      await client.query('COMMIT');
      return assignments;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  // Get proxies assigned to an account
  async getAccountProxies(accountId, onlyActive = true) {
    const query = `
      SELECT p.*, sap.priority, sap.last_used_at as account_last_used_at, 
             sap.use_count as account_use_count
      FROM proxies p
      JOIN social_account_proxies sap ON p.id = sap.proxy_id
      WHERE sap.social_account_id = $1
      ${onlyActive ? 'AND sap.is_active = true AND p.is_active = true' : ''}
      ORDER BY sap.priority ASC, sap.last_used_at ASC NULLS FIRST
    `;

    const result = await pool.query(query, [accountId]);
    return result.rows;
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

  // Update proxy stats after use
  async updateProxyStats(proxyId, success) {
    const column = success ? 'success_count' : 'failure_count';
    
    await pool.query(
      `UPDATE proxies 
       SET ${column} = ${column} + 1, 
           last_used_at = NOW(),
           updated_at = NOW()
       WHERE id = $1`,
      [proxyId]
    );

    // Disable proxy if too many failures
    if (!success) {
      const result = await pool.query(
        'SELECT failure_count FROM proxies WHERE id = $1',
        [proxyId]
      );
      
      if (result.rows[0]?.failure_count > 10) {
        await this.disableProxy(proxyId);
      }
    }
  }

  // Disable a proxy
  async disableProxy(proxyId) {
    await pool.query(
      'UPDATE proxies SET is_active = false, updated_at = NOW() WHERE id = $1',
      [proxyId]
    );
  }

  // Enable a proxy
  async enableProxy(proxyId) {
    await pool.query(
      'UPDATE proxies SET is_active = true, failure_count = 0, updated_at = NOW() WHERE id = $1',
      [proxyId]
    );
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
             COUNT(*) FILTER (WHERE is_active = true) as active_count
      FROM proxies
      WHERE provider IS NOT NULL
      GROUP BY provider
      ORDER BY count DESC
    `);

    return {
      overview: stats.rows[0],
      byCountry: byCountry.rows,
      byProvider: byProvider.rows
    };
  }
}

module.exports = new ProxyService();
