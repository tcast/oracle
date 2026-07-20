const pool = require('./db');
const { generateRealisticUsername } = require('../utils/nameGenerator');
const { generatePassword } = require('../utils/passwordGenerator');

/**
 * Namecheap-hosted catch-all pool: every *@domain lands in pool@proteusmail.net.
 * We mint unique pretty addresses across domains for social signup.
 */
const DEFAULT_DOMAINS = [
  'bashed.net',
  'casinoadvertiser.com',
  'college-tuition.net',
  'excusecreator.com',
  'faregiant.com',
  'guitarsessions.net',
  'fullfunnel.net',
  'ihotelsearch.com',
  'ketchupbuddy.com',
  'myrun.me',
  'n78mr.com',
  'new-school.net',
  'nutritional-food.com',
  'paradisepictures.net',
  'payday-direct.com',
  'potionkits.com',
  'proteusmail.net',
  'replicashop.net',
  'respondcx.com',
  'retain360.io',
  'shutookus.com',
  'starpirate.com',
  'steel-building.net',
  'topagency.net',
  'toymakers.net',
  'united-loans.com',
  'usgeek.com',
  'uspunk.com',
];

// Skip domains that may be brand-sensitive for social personas by default
const SKIP_DEFAULT = new Set(['justfucked.com', 'tastycoeds.com', 'somaliapirates.com']);

class DomainMailPoolService {
  constructor() {
    this.domains = (process.env.MAIL_POOL_DOMAINS || '')
      .split(',')
      .map((d) => d.trim().toLowerCase())
      .filter(Boolean);
    if (!this.domains.length) {
      this.domains = DEFAULT_DOMAINS.filter((d) => !SKIP_DEFAULT.has(d));
    }
    this.imapHost = process.env.MAIL_IMAP_HOST || 'mail.proteusmail.net';
    this.imapIp = process.env.MAIL_IMAP_IP || '';
    this.imapPort = Number(process.env.MAIL_IMAP_PORT || 993);
    this.poolUser = process.env.MAIL_POOL_USER || 'pool@proteusmail.net';
    this.poolPass = process.env.MAIL_POOL_PASS || '';
  }

  assertConfigured() {
    if (!this.poolPass) {
      throw new Error('MAIL_POOL_PASS not configured');
    }
  }

  pickDomain(preferred) {
    if (preferred && this.domains.includes(preferred.toLowerCase())) {
      return preferred.toLowerCase();
    }
    return this.domains[Math.floor(Math.random() * this.domains.length)];
  }

  async mintAddress({ nameStyle = 'random', domain = null } = {}) {
    this.assertConfigured();
    const d = this.pickDomain(domain);
    const base = generateRealisticUsername(nameStyle).replace(/[^a-z0-9._-]/gi, '');
    const suffix = Date.now().toString().slice(-5);
    const local = `${base}${suffix}`.toLowerCase();
    const email = `${local}@${d}`;

    // Password on the row is the pool IMAP password (catch-all login)
    const result = await pool.query(
      `INSERT INTO email_accounts
        (provider, email, username, password, phone_number, phone_provider, status, is_verified, verification_date, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,'active',true,NOW(),$7)
       RETURNING *`,
      [
        'catchall',
        email,
        local,
        this.poolPass,
        null,
        null,
        JSON.stringify({
          created_by: 'domain_mail_pool',
          catchall: true,
          domain: d,
          imap_host: this.imapIp || this.imapHost,
          imap_port: this.imapPort,
          imap_user: this.poolUser,
          imap_tls_reject_unauthorized: false,
          pool_mailbox: this.poolUser,
        }),
      ]
    );
    return result.rows[0];
  }

  async mintMany(count = 10, opts = {}) {
    const n = Math.min(Math.max(Number(count) || 1, 1), 200);
    const created = [];
    const errors = [];
    for (let i = 0; i < n; i++) {
      try {
        // Round-robin domains for variety
        const domain = opts.domain || this.domains[i % this.domains.length];
        created.push(await this.mintAddress({ ...opts, domain }));
      } catch (e) {
        errors.push({ index: i, error: e.message });
      }
    }
    return {
      successCount: created.length,
      failureCount: errors.length,
      success: created,
      failed: errors,
      domains: this.domains,
    };
  }
}

module.exports = new DomainMailPoolService();
