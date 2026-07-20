const pool = require('./db');
const playwrightService = require('./playwrightService');

async function countListing(page, username, kind, maxPages = 8) {
  let after = null;
  let count = 0;
  let likes = 0;
  let dislikes = 0;
  let pages = 0;

  while (pages < maxPages) {
    const url = after
      ? `https://www.reddit.com/user/${encodeURIComponent(username)}/${kind}.json?limit=100&after=${after}&raw_json=1`
      : `https://www.reddit.com/user/${encodeURIComponent(username)}/${kind}.json?limit=100&raw_json=1`;

    const payload = await page.evaluate(async (fetchUrl) => {
      try {
        const res = await fetch(fetchUrl, {
          credentials: 'include',
          headers: { Accept: 'application/json' },
        });
        if (!res.ok) return { ok: false, status: res.status };
        return { ok: true, data: await res.json() };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    }, url);

    if (!payload?.ok || !payload.data?.data) break;

    const children = payload.data.data.children || [];
    count += children.length;

    for (const child of children) {
      const d = child?.data || {};
      const ups = Number(d.ups) || 0;
      const ratio = Number(d.upvote_ratio);
      likes += Math.max(0, ups);
      if (ratio > 0 && ratio < 1 && ups > 0) {
        // Estimate downs from ups + upvote_ratio
        const downs = Math.max(0, Math.round((ups * (1 - ratio)) / ratio));
        dislikes += downs;
      }
    }

    after = payload.data.data.after;
    pages += 1;
    if (!after || children.length === 0) break;
    await playwrightService.humanLikeDelay(400, 900);
  }

  return { count, likes, dislikes, pages, truncated: !!after };
}

class AccountStatsService {
  async getSettings() {
    const result = await pool.query('SELECT * FROM account_stats_audit_settings WHERE id = 1');
    if (result.rows[0]) return result.rows[0];
    const inserted = await pool.query(
      `INSERT INTO account_stats_audit_settings (id) VALUES (1)
       ON CONFLICT (id) DO UPDATE SET updated_at = NOW()
       RETURNING *`
    );
    return inserted.rows[0];
  }

  async updateSettings(patch = {}) {
    const current = await this.getSettings();
    const enabled = patch.enabled !== undefined ? !!patch.enabled : current.enabled;
    const run_hour_local = patch.run_hour_local ?? current.run_hour_local;
    const timezone = patch.timezone || current.timezone;
    const result = await pool.query(
      `UPDATE account_stats_audit_settings
       SET enabled = $1, run_hour_local = $2, timezone = $3, updated_at = NOW()
       WHERE id = 1
       RETURNING *`,
      [enabled, run_hour_local, timezone]
    );
    return result.rows[0];
  }

  async listAuditableAccounts() {
    const result = await pool.query(
      `SELECT sa.*
       FROM social_accounts sa
       WHERE sa.platform = 'reddit'
         AND sa.status = 'active'
         AND lower(sa.status) NOT IN ('banned', 'disabled')
         AND COALESCE(sa.is_simulated, false) = false
         AND COALESCE(sa.credentials->>'password', '') NOT IN ('', 'default_password')
         AND COALESCE(sa.credentials->>'needs_signup', 'false') != 'true'
         AND EXISTS (
           SELECT 1 FROM social_account_proxies sap
           WHERE sap.social_account_id = sa.id AND sap.is_active = true
         )
       ORDER BY sa.id`
    );
    return result.rows;
  }

  async scrapeRedditStats(account) {
    let browser;
    try {
      await playwrightService.requireProxyForLive(account.id);
      const result = await playwrightService.createBrowserForAccount(account.id, 2, { requireProxy: true });
      browser = result.browser;
      const page = result.page;

      const password = typeof account.credentials === 'string'
        ? JSON.parse(account.credentials).password
        : account.credentials?.password;

      await playwrightService.ensureLoggedIn(
        page, 'reddit', account.id, account.username, password
      );

      // Warm browse so same-origin fetch has cookies
      await page.goto(`https://www.reddit.com/user/${encodeURIComponent(account.username)}/`, {
        waitUntil: 'domcontentloaded',
        timeout: 90000,
      });
      await playwrightService.humanLikeDelay(1500, 3000);

      const about = await page.evaluate(async (username) => {
        const res = await fetch(`https://www.reddit.com/user/${encodeURIComponent(username)}/about.json?raw_json=1`, {
          credentials: 'include',
          headers: { Accept: 'application/json' },
        });
        if (!res.ok) return { ok: false, status: res.status };
        const json = await res.json();
        return { ok: true, data: json?.data || null };
      }, account.username);

      if (!about?.ok || !about.data) {
        throw new Error(`about.json failed${about?.status ? ` HTTP ${about.status}` : ''}`);
      }

      const submitted = await countListing(page, account.username, 'submitted', 10);
      const comments = await countListing(page, account.username, 'comments', 10);

      await playwrightService.persistSession(page, 'reddit', account.id).catch(() => {});

      return {
        total_karma: Number(about.data.total_karma ?? ((about.data.link_karma || 0) + (about.data.comment_karma || 0))) || 0,
        post_karma: Number(about.data.link_karma) || 0,
        comment_karma: Number(about.data.comment_karma) || 0,
        post_count: submitted.count,
        comment_count: comments.count,
        likes_count: submitted.likes + comments.likes,
        dislikes_count: submitted.dislikes + comments.dislikes,
        raw: {
          about: {
            total_karma: about.data.total_karma,
            link_karma: about.data.link_karma,
            comment_karma: about.data.comment_karma,
            created: about.data.created,
          },
          submitted,
          comments,
        },
      };
    } finally {
      if (browser) await browser.close();
      playwrightService._untrackBrowser(account.id);
    }
  }

  async saveStats(accountId, stats, { error = null } = {}) {
    if (error) {
      await pool.query(
        `UPDATE social_accounts
         SET stats_audit_error = $2, stats_audited_at = NOW(), updated_at = NOW()
         WHERE id = $1`,
        [accountId, error]
      );
      await pool.query(
        `INSERT INTO social_account_stats_audits
           (social_account_id, status, error)
         VALUES ($1, 'error', $2)`,
        [accountId, error]
      );
      return;
    }

    await pool.query(
      `UPDATE social_accounts SET
         total_karma = $2,
         post_karma = $3,
         comment_karma = $4,
         post_count = $5,
         comment_count = $6,
         likes_count = $7,
         dislikes_count = $8,
         stats_audited_at = NOW(),
         stats_audit_error = NULL,
         updated_at = NOW()
       WHERE id = $1`,
      [
        accountId,
        stats.total_karma,
        stats.post_karma,
        stats.comment_karma,
        stats.post_count,
        stats.comment_count,
        stats.likes_count,
        stats.dislikes_count,
      ]
    );

    await pool.query(
      `INSERT INTO social_account_stats_audits
         (social_account_id, total_karma, post_karma, comment_karma, post_count, comment_count,
          likes_count, dislikes_count, status, raw)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'ok',$9)`,
      [
        accountId,
        stats.total_karma,
        stats.post_karma,
        stats.comment_karma,
        stats.post_count,
        stats.comment_count,
        stats.likes_count,
        stats.dislikes_count,
        JSON.stringify(stats.raw || {}),
      ]
    );
  }

  async auditOne(account) {
    try {
      const stats = await this.scrapeRedditStats(account);
      await this.saveStats(account.id, stats);
      return { accountId: account.id, username: account.username, ok: true, stats };
    } catch (err) {
      await this.saveStats(account.id, null, { error: err.message });
      return { accountId: account.id, username: account.username, ok: false, error: err.message };
    }
  }

  async runDailyAudit({ limit = null } = {}) {
    const accounts = await this.listAuditableAccounts();
    const targets = limit ? accounts.slice(0, limit) : accounts;
    const results = [];

    // Sequential — proxies + Reddit rate limits
    for (const account of targets) {
      const result = await this.auditOne(account);
      results.push(result);
      console.log(
        `Account stats audit ${account.username}:`,
        result.ok ? result.stats : result.error
      );
    }

    const summary = {
      total: results.length,
      ok: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok).length,
      at: new Date().toISOString(),
    };

    const settings = await this.getSettings();
    const today = this.localDateInTimezone(settings.timezone);
    await pool.query(
      `UPDATE account_stats_audit_settings
       SET last_run_date = $2::date,
           last_run_at = NOW(),
           last_run_summary = $1,
           updated_at = NOW()
       WHERE id = 1`,
      [JSON.stringify(summary), today]
    );

    return { summary, results };
  }

  localHourInTimezone(timezone) {
    try {
      const fmt = new Intl.DateTimeFormat('en-US', {
        timeZone: timezone || 'America/New_York',
        hour: 'numeric',
        hour12: false,
      });
      return Number(fmt.format(new Date()));
    } catch {
      return new Date().getHours();
    }
  }

  localDateInTimezone(timezone) {
    try {
      return new Intl.DateTimeFormat('en-CA', {
        timeZone: timezone || 'America/New_York',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(new Date());
    } catch {
      return new Date().toISOString().slice(0, 10);
    }
  }

  async shouldRunTonight() {
    const settings = await this.getSettings();
    if (!settings.enabled) return false;
    const hour = this.localHourInTimezone(settings.timezone);
    if (hour !== Number(settings.run_hour_local)) return false;
    const today = this.localDateInTimezone(settings.timezone);
    const last = settings.last_run_date
      ? new Date(settings.last_run_date).toISOString().slice(0, 10)
      : null;
    return last !== today;
  }

  async getRecentAudits(limit = 100) {
    const result = await pool.query(
      `SELECT a.*, sa.username
       FROM social_account_stats_audits a
       JOIN social_accounts sa ON sa.id = a.social_account_id
       ORDER BY a.audited_at DESC
       LIMIT $1`,
      [limit]
    );
    return result.rows;
  }
}

module.exports = new AccountStatsService();
