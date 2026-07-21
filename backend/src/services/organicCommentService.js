const pool = require('./db');
const openai = require('./openai');
const playwrightService = require('./playwrightService');
const proxyService = require('./proxyService');
const organicDiscoveryService = require('./organicDiscoveryService');
const commentingService = require('./commentingService');
const { scoreAiLikeness, scoreSpamSignals } = require('./campaignReputationService');
const { generationCompletionOptions } = require('../config/openaiModels');
const { classifyFailure, cooldownUntil } = require('./failureClassifier');

const BAD_OPENERS = [
  /^great post[!.,\s]/i,
  /^thanks for (sharing|this)[!.,\s]/i,
  /^this is (so |very )?(interesting|insightful|important)[!.,\s]/i,
  /^as an ai\b/i,
  /^i completely agree[!.,\s]/i,
  /^absolutely[!.,\s]/i,
  /^couldn't agree more/i,
];

const URL_RE = /https?:\/\/|www\.|\bbit\.ly\b|\bt\.co\b/i;

class OrganicCommentService {
  async getSettings() {
    const result = await pool.query('SELECT * FROM organic_comment_settings WHERE id = 1');
    if (result.rows[0]) return result.rows[0];
    const inserted = await pool.query(
      `INSERT INTO organic_comment_settings (id, enabled)
       VALUES (1, false)
       ON CONFLICT (id) DO UPDATE SET updated_at = NOW()
       RETURNING *`
    );
    return inserted.rows[0];
  }

  async updateSettings(patch) {
    const current = await this.getSettings();
    const enabled = patch.enabled !== undefined ? !!patch.enabled : current.enabled;
    const min_per_day = patch.min_per_day ?? current.min_per_day;
    const max_per_day = patch.max_per_day ?? current.max_per_day;
    const quiet_hours_start = patch.quiet_hours_start ?? current.quiet_hours_start;
    const quiet_hours_end = patch.quiet_hours_end ?? current.quiet_hours_end;
    const max_concurrent = patch.max_concurrent ?? current.max_concurrent;

    if (min_per_day < 1 || max_per_day < min_per_day || max_per_day > 10) {
      throw new Error('min_per_day/max_per_day must satisfy 1 <= min <= max <= 10');
    }
    if (max_concurrent < 1 || max_concurrent > 10) {
      throw new Error('max_concurrent must be between 1 and 10');
    }

    const result = await pool.query(
      `UPDATE organic_comment_settings
       SET enabled = $1,
           min_per_day = $2,
           max_per_day = $3,
           quiet_hours_start = $4,
           quiet_hours_end = $5,
           max_concurrent = $6,
           updated_at = NOW()
       WHERE id = 1
       RETURNING *`,
      [enabled, min_per_day, max_per_day, quiet_hours_start, quiet_hours_end, max_concurrent]
    );
    const settings = result.rows[0];

    const cadenceUp =
      min_per_day > current.min_per_day ||
      max_per_day > current.max_per_day ||
      max_concurrent > current.max_concurrent ||
      patch.reroll_targets === true ||
      patch.warm === true;

    if (cadenceUp) {
      await this.applyThroughputBoost(settings, { warm: patch.warm !== false });
    }
    return settings;
  }

  /**
   * Raise today's targets into the new min/max band and optionally make under-target
   * accounts due soon so higher cadence kicks in immediately.
   */
  async applyThroughputBoost(settings, { warm = true } = {}) {
    const min = settings.min_per_day || 1;
    const max = settings.max_per_day || 3;
    const jobs = await pool.query(
      `SELECT id, comments_today, daily_target, next_due_at
       FROM organic_comment_jobs
       WHERE enabled = true`
    );
    for (const job of jobs.rows) {
      let target;
      if (warm && job.comments_today < max) {
        const floor = Math.max(min, job.comments_today + (job.comments_today >= (job.daily_target || 0) ? 1 : 0));
        const lo = Math.min(floor, max);
        target = lo + Math.floor(Math.random() * (max - lo + 1));
      } else {
        target = Math.max(this.rollDailyTarget(settings), job.comments_today);
      }

      let nextDue = job.next_due_at;
      if (warm && job.comments_today < target) {
        nextDue = new Date(Date.now() + Math.floor(Math.random() * 45 * 60 * 1000));
      }

      await pool.query(
        `UPDATE organic_comment_jobs
         SET daily_target = $2,
             next_due_at = $3,
             status = CASE WHEN status = 'error' THEN 'idle' ELSE status END,
             updated_at = NOW()
         WHERE id = $1`,
        [job.id, target, nextDue]
      );
    }
  }

  async getBrandBanTerms() {
    try {
      const result = await pool.query('SELECT name, website FROM brands');
      const terms = new Set();
      for (const row of result.rows) {
        if (row.name) terms.add(String(row.name).toLowerCase());
        if (row.website) {
          try {
            const host = new URL(
              row.website.startsWith('http') ? row.website : `https://${row.website}`
            ).hostname.replace(/^www\./, '');
            if (host) terms.add(host);
          } catch { /* ignore */ }
        }
      }
      return [...terms].filter((t) => t && t.length >= 3);
    } catch {
      return [];
    }
  }

  async ensureJob(accountId) {
    const existing = await pool.query(
      'SELECT * FROM organic_comment_jobs WHERE social_account_id = $1',
      [accountId]
    );
    if (existing.rows[0]) return existing.rows[0];

    const settings = await this.getSettings();
    const target = this.rollDailyTarget(settings);
    const next = this.computeNextDue(settings, 0);

    const inserted = await pool.query(
      `INSERT INTO organic_comment_jobs
         (social_account_id, enabled, next_due_at, comments_today, day_key, daily_target, status)
       VALUES ($1, true, $2, 0, CURRENT_DATE, $3, 'idle')
       ON CONFLICT (social_account_id) DO UPDATE SET updated_at = NOW()
       RETURNING *`,
      [accountId, next, target]
    );
    return inserted.rows[0];
  }

  rollDailyTarget(settings) {
    const min = settings.min_per_day || 1;
    const max = settings.max_per_day || 3;
    return min + Math.floor(Math.random() * (max - min + 1));
  }

  inQuietHours(settings, date = new Date()) {
    const hour = date.getHours();
    const start = settings.quiet_hours_start ?? 1;
    const end = settings.quiet_hours_end ?? 7;
    if (start === end) return false;
    if (start < end) return hour >= start && hour < end;
    return hour >= start || hour < end;
  }

  computeNextDue(settings, commentsToday, warnings = {}) {
    const now = new Date();
    const target = warnings.daily_target || settings.max_per_day || 3;
    const maxPerDay = settings.max_per_day || 3;
    // Spread comments across ~16 waking hours; denser when daily cap is higher
    const wakingHours = 16;
    const baseGapH = Math.max(0.5, (wakingHours / Math.max(maxPerDay, 1)) * 0.7);

    let gapMs = (baseGapH * 0.5 + Math.random() * baseGapH) * 60 * 60 * 1000;
    if (commentsToday === 0 && !warnings.immediate) {
      // First of day: sooner start so the day can actually fill the higher target
      gapMs = Math.random() * Math.min(1.5, baseGapH) * 60 * 60 * 1000;
    }

    let due = new Date(now.getTime() + gapMs);
    let guard = 0;
    while (this.inQuietHours(settings, due) && guard < 24) {
      due = new Date(due.getTime() + 60 * 60 * 1000);
      guard += 1;
    }

    // Don't schedule past end of day if target already reachable
    const endOfDay = new Date(now);
    endOfDay.setHours(22, 30, 0, 0);
    if (due > endOfDay && commentsToday < target) {
      // park until tomorrow morning after quiet hours
      const tomorrow = new Date(now);
      tomorrow.setDate(tomorrow.getDate() + 1);
      tomorrow.setHours((settings.quiet_hours_end ?? 7) + Math.floor(Math.random() * 3), Math.floor(Math.random() * 60), 0, 0);
      return tomorrow;
    }
    return due;
  }

  async refreshDayState(job, settings) {
    const today = new Date().toISOString().slice(0, 10);
    const dayKey = job.day_key ? new Date(job.day_key).toISOString().slice(0, 10) : null;
    if (dayKey === today && job.daily_target) return job;

    const target = this.rollDailyTarget(settings);
    const next = this.computeNextDue(settings, 0);
    const result = await pool.query(
      `UPDATE organic_comment_jobs
       SET day_key = CURRENT_DATE,
           comments_today = 0,
           daily_target = $2,
           next_due_at = $3,
           status = 'idle',
           updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [job.id, target, next]
    );
    return result.rows[0];
  }

  parsePersona(account) {
    let traits = account.persona_traits;
    if (typeof traits === 'string') {
      try { traits = JSON.parse(traits); } catch { traits = {}; }
    }
    return traits || {};
  }

  async generateOrganicComment(account, thread) {
    const persona = this.parsePersona(account);
    const brandTerms = await this.getBrandBanTerms();
    const platform = String(account.platform || thread.platform || 'reddit').toLowerCase();
    const place =
      platform === 'reddit'
        ? `Subreddit: r/${thread.subreddit}`
        : platform === 'linkedin'
          ? 'Network: LinkedIn feed'
          : platform === 'instagram'
            ? 'Network: Instagram'
            : platform === 'x' || platform === 'twitter'
              ? 'Network: X (Twitter)'
              : `Network: ${platform}`;

    const system = `You write short social comments that sound like a real person, not a brand or an AI.

Hard rules:
- Purely helpful / conversational. Never promote products, companies, services, waitlists, or links.
- Never mention these brands/products: ${brandTerms.slice(0, 40).join(', ') || '(none)'}.
- No URLs. No hashtags. No "Great post!". No "As an AI".
- 15–45 words. Prefer 1–2 sentences OR one specific question.
- React to ONE concrete detail from the title/body. Add a small personal take or clarifying question.
- Sound mid-conversation, slightly imperfect is fine.
- Ban marketing tone, cheerleading, and corporate polish.
${platform === 'linkedin' ? '- Keep it professional-casual (LinkedIn). Avoid slang.' : ''}
${platform === 'instagram' ? '- Keep it brief and natural (Instagram).' : ''}
${platform === 'x' || platform === 'twitter' ? '- Keep it concise (X).' : ''}

Persona:
- writingStyle: ${persona.writingStyle || 'casual'}
- tone: ${persona.tone || 'neutral'}
- quirks: ${(persona.quirks || []).join(', ') || 'none'}
- expertise: ${(persona.expertise || []).join(', ') || 'general'}
- engagementStyle: ${persona.engagementStyle || 'questioner'}
- responseLength: concise`;

    const user = `${place}
Title: ${thread.title}
Body excerpt: ${thread.selftext || '(no body — title-only post)'}

Write only the comment text.`;

    const completion = await openai.chat.completions.create(
      generationCompletionOptions({
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      })
    );

    let content = (completion.choices?.[0]?.message?.content || '').trim();
    content = content.replace(/^["']|["']$/g, '').trim();
    return content;
  }

  async validateComment(content, brandTerms = []) {
    const reasons = [];
    if (!content || content.length < 12) reasons.push('too_short');
    if (content.length > 320) reasons.push('too_long');
    if (URL_RE.test(content)) reasons.push('contains_url');
    for (const opener of BAD_OPENERS) {
      if (opener.test(content)) {
        reasons.push('bad_opener');
        break;
      }
    }
    const lower = content.toLowerCase();
    for (const term of brandTerms) {
      if (term && lower.includes(term)) {
        reasons.push(`brand:${term}`);
        break;
      }
    }

    const ai = scoreAiLikeness(content);
    const spam = scoreSpamSignals(content, {});
    if (ai.ai_likeness > 0.45) reasons.push('ai_likeness');
    if (spam.spam_score > 0.3) reasons.push('spam_score');

    return {
      ok: reasons.length === 0,
      reasons,
      ai_likeness: ai.ai_likeness,
      spam_score: spam.spam_score,
    };
  }

  async generateWithGate(account, thread, attempts = 3) {
    const brandTerms = await this.getBrandBanTerms();
    let last = null;
    for (let i = 0; i < attempts; i++) {
      const content = await this.generateOrganicComment(account, thread);
      const gate = await this.validateComment(content, brandTerms);
      last = { content, gate };
      if (gate.ok) return last;
    }
    return last;
  }

  async listEligibleAccounts() {
    const platforms = organicDiscoveryService.getSupportedPlatforms();
    const result = await pool.query(
      `SELECT sa.*
       FROM social_accounts sa
       LEFT JOIN organic_comment_jobs j ON j.social_account_id = sa.id
       WHERE sa.platform = ANY($1::text[])
         AND COALESCE(sa.is_simulated, false) = false
         AND sa.status = 'active'
         AND lower(sa.status) NOT IN ('banned', 'disabled')
         AND COALESCE(sa.credentials->>'password', '') NOT IN ('', 'default_password')
         AND COALESCE(sa.credentials->>'needs_signup', 'false') != 'true'
         AND (j.cooldown_until IS NULL OR j.cooldown_until <= NOW())
         AND COALESCE(j.failure_class, '') NOT IN ('bad_credentials', 'session_dead')
         AND EXISTS (
           SELECT 1 FROM social_account_proxies sap
           JOIN proxies p ON p.id = sap.proxy_id
           WHERE sap.social_account_id = sa.id AND sap.is_active = true
             AND p.is_active = true
             AND (p.cooldown_until IS NULL OR p.cooldown_until <= NOW())
         )
         -- Only run accounts that have an enabled job (or reddit legacy: auto-pick)
         AND (
           COALESCE(j.enabled, false) = true
           OR (sa.platform = 'reddit' AND (j.id IS NULL OR j.enabled = true))
         )`,
      [platforms]
    );
    return result.rows;
  }

  /**
   * Cookie sessions cannot be refreshed. Mark the account inactive, disable
   * organic, and free its dedicated proxy so working accounts keep capacity.
   */
  async markDeadSessionAccount(accountId, reason = 'session_dead') {
    const msg = String(reason || 'session_dead');
    await pool.query(
      `UPDATE social_accounts
       SET status = 'inactive',
           warmup_status = 'failed',
           credentials = COALESCE(credentials, '{}'::jsonb)
             || jsonb_build_object(
                  'session_dead', true,
                  'session_dead_at', NOW()::text,
                  'session_dead_reason', $2::text
                ),
           updated_at = NOW()
       WHERE id = $1`,
      [accountId, msg.slice(0, 500)]
    );
    await pool.query(
      `UPDATE organic_comment_jobs
       SET enabled = false,
           status = 'error',
           failure_class = 'session_dead',
           last_error = $2,
           cooldown_until = NOW() + INTERVAL '365 days',
           next_due_at = NOW() + INTERVAL '365 days',
           updated_at = NOW()
       WHERE social_account_id = $1`,
      [accountId, msg.slice(0, 1000)]
    );
    await pool.query(
      `UPDATE social_account_proxies
       SET is_active = false
       WHERE social_account_id = $1 AND is_active = true`,
      [accountId]
    );
    console.warn(`Account ${accountId} marked session_dead — ${msg.slice(0, 120)}`);
    return { accountId, status: 'inactive', failureClass: 'session_dead' };
  }

  /**
   * Platform-level ban / suspension / deleted profile. Distinct from session_dead
   * (dead cookies). Matches Reddit mark-banned path: status=banned, free proxy,
   * disable organic with failure_class=banned.
   */
  async markBannedAccount(accountId, reason = 'banned') {
    const msg = String(reason || 'banned');
    await pool.query(
      `UPDATE social_accounts
       SET status = 'banned',
           warmup_status = 'failed',
           credentials = COALESCE(credentials, '{}'::jsonb)
             || jsonb_build_object(
                  'banned', true,
                  'banned_at', NOW()::text,
                  'banned_reason', $2::text
                ),
           updated_at = NOW()
       WHERE id = $1`,
      [accountId, msg.slice(0, 500)]
    );
    await pool.query(
      `UPDATE organic_comment_jobs
       SET enabled = false,
           status = 'error',
           failure_class = 'banned',
           last_error = $2,
           cooldown_until = NOW() + INTERVAL '365 days',
           next_due_at = NOW() + INTERVAL '365 days',
           updated_at = NOW()
       WHERE social_account_id = $1`,
      [accountId, msg.slice(0, 1000)]
    );
    await pool.query(
      `UPDATE social_account_proxies
       SET is_active = false
       WHERE social_account_id = $1 AND is_active = true`,
      [accountId]
    );
    console.warn(`Account ${accountId} marked banned — ${msg.slice(0, 120)}`);
    return { accountId, status: 'banned', failureClass: 'banned' };
  }

  async applyFailureQuarantine(job, errorMessage) {
    const failureClass = classifyFailure(errorMessage);
    const consecutive = (job.consecutive_failures || 0) + 1;
    const until = cooldownUntil(failureClass, consecutive);
    // Terminal: bad password, dead cookies, or platform ban — disable until replaced
    const disable =
      failureClass === 'bad_credentials' ||
      failureClass === 'session_dead' ||
      failureClass === 'banned';

    if (failureClass === 'banned') {
      await this.markBannedAccount(job.social_account_id, errorMessage);
      return { failureClass, consecutive, until, disable: true };
    }

    if (failureClass === 'session_dead') {
      await this.markDeadSessionAccount(job.social_account_id, errorMessage);
      return { failureClass, consecutive, until, disable: true };
    }

    // Transient login/proxy flakes: quarantine only, do not permanently kill.

    await pool.query(
      `UPDATE organic_comment_jobs
       SET status = 'error',
           last_error = $2,
           failure_class = $3,
           consecutive_failures = $4,
           cooldown_until = $5,
           next_due_at = $5,
           enabled = CASE WHEN $6 THEN false ELSE enabled END,
           updated_at = NOW()
       WHERE id = $1`,
      [job.id, errorMessage, failureClass, consecutive, until, disable]
    );

    console.warn(
      `Account job ${job.social_account_id} quarantined as ${failureClass} ` +
        `until ${until.toISOString()} (failures=${consecutive})` +
        (disable ? ' — disabled' : '')
    );

    return { failureClass, consecutive, until, disable };
  }

  async clearFailureState(jobId) {
    await pool.query(
      `UPDATE organic_comment_jobs
       SET consecutive_failures = 0,
           failure_class = NULL,
           cooldown_until = NULL,
           last_error = NULL,
           status = 'idle',
           updated_at = NOW()
       WHERE id = $1`,
      [jobId]
    );
  }

  /**
   * Recover jobs left status=running after crash/OOM/worker stall.
   * Without this, tick() skips them forever and capacity silently dies.
   */
  async reclaimStaleRunningJobs(staleMinutes = 25) {
    const result = await pool.query(
      `UPDATE organic_comment_jobs
       SET status = 'idle',
           last_error = COALESCE(last_error, 'reclaimed_stale_running'),
           updated_at = NOW()
       WHERE status = 'running'
         AND updated_at < NOW() - ($1::int * INTERVAL '1 minute')
       RETURNING id, social_account_id, updated_at`,
      [staleMinutes]
    );
    if (result.rows.length) {
      console.warn(
        `Reclaimed ${result.rows.length} stale organic running job(s):`,
        result.rows.map((r) => r.social_account_id)
      );
    }
    return result.rows;
  }

  async getDashboard() {
    const settings = await this.getSettings();
    const mapping = await proxyService.getProxyMappingStatus();
    const jobs = await pool.query(
      `SELECT j.*, sa.username, sa.status AS account_status
       FROM organic_comment_jobs j
       JOIN social_accounts sa ON sa.id = j.social_account_id
       ORDER BY j.next_due_at NULLS LAST`
    );
    const recent = await pool.query(
      `SELECT oc.*, sa.username
       FROM organic_comments oc
       JOIN social_accounts sa ON sa.id = oc.social_account_id
       ORDER BY oc.created_at DESC
       LIMIT 200`
    );
    const todayStats = await pool.query(
      `SELECT COUNT(*)::int AS posted_today
       FROM organic_comments
       WHERE status = 'posted' AND created_at::date = CURRENT_DATE`
    );

    return {
      settings,
      proxy_mapping: mapping,
      jobs: jobs.rows,
      recent: recent.rows,
      posted_today: todayStats.rows[0]?.posted_today || 0,
    };
  }

  async setAccountEnabled(accountId, enabled) {
    await this.ensureJob(accountId);
    const result = await pool.query(
      `UPDATE organic_comment_jobs
       SET enabled = $2, updated_at = NOW()
       WHERE social_account_id = $1
       RETURNING *`,
      [accountId, !!enabled]
    );
    return result.rows[0];
  }

  async runOneForAccount(account, { dryRun = false } = {}) {
    const settings = await this.getSettings();
    let job = await this.ensureJob(account.id);
    job = await this.refreshDayState(job, settings);

    if (!job.enabled) {
      return { skipped: true, reason: 'account_disabled' };
    }
    if (job.cooldown_until && new Date(job.cooldown_until) > new Date()) {
      return { skipped: true, reason: 'cooldown', until: job.cooldown_until, class: job.failure_class };
    }
    if (job.failure_class === 'bad_credentials') {
      return { skipped: true, reason: 'bad_credentials' };
    }
    if (job.comments_today >= (job.daily_target || settings.max_per_day)) {
      return { skipped: true, reason: 'daily_cap' };
    }
    if (job.next_due_at && new Date(job.next_due_at) > new Date()) {
      return { skipped: true, reason: 'not_due' };
    }
    if (this.inQuietHours(settings)) {
      const next = this.computeNextDue(settings, job.comments_today, { daily_target: job.daily_target });
      await pool.query(
        `UPDATE organic_comment_jobs SET next_due_at = $2, status = 'idle', updated_at = NOW() WHERE id = $1`,
        [job.id, next]
      );
      return { skipped: true, reason: 'quiet_hours' };
    }

    await pool.query(
      `UPDATE organic_comment_jobs SET status = 'running', last_error = NULL, updated_at = NOW() WHERE id = $1`,
      [job.id]
    );

    let settled = false;
    const proxies = await proxyService.getAccountProxies(account.id, true);
    if (proxies.length !== 1) {
      const msg = proxies.length === 0
        ? 'No dedicated proxy assigned (or proxy in cooldown)'
        : 'Account has multiple active proxies; enforce 1:1';
      await this.applyFailureQuarantine(job, msg);
      settled = true;
      return { skipped: true, reason: 'proxy', error: msg };
    }

    try {
      // Ensure persona exists
      if (!account.persona_traits) {
        const traits = await commentingService.generatePersonalityTraits();
        await pool.query(
          'UPDATE social_accounts SET persona_traits = $2 WHERE id = $1',
          [account.id, JSON.stringify(traits)]
        );
        account.persona_traits = traits;
      }

      const thread = await organicDiscoveryService.findCommentableThread(account);
      const generated = await this.generateWithGate(account, thread, 3);
      if (!generated?.gate?.ok) {
        const reason = (generated?.gate?.reasons || ['gate_failed']).join(',');
        // Soft skip: bump due later, do NOT burn daily budget or quarantine
        const next = this.computeNextDue(settings, job.comments_today, { daily_target: job.daily_target });
        await pool.query(
          `UPDATE organic_comment_jobs
           SET status = 'idle', last_error = $2, next_due_at = $3, updated_at = NOW()
           WHERE id = $1`,
          [job.id, `gate_failed:${reason}`, next]
        );
        settled = true;
        return { skipped: true, reason: 'gate_failed', details: generated?.gate, thread };
      }

      const content = generated.content;
      let platformCommentId = null;
      let status = 'simulated';
      const platform = String(account.platform || 'reddit').toLowerCase();
      // X cookies are fragile / rate-limited — never password-submit from organic.
      // LinkedIn/IG: prefer session; allow password only for linkedin/instagram when needed.
      const allowLogin = platform === 'reddit' || platform === 'linkedin' || platform === 'instagram';

      if (!dryRun) {
        if (platform !== 'linkedin') {
          await playwrightService.requireProxyForLive(account.id);
        }
        platformCommentId = await playwrightService.postComment(
          platform === 'twitter' ? 'x' : platform,
          account.id,
          thread.post_url,
          content,
          null,
          {
            requireProxy: platform !== 'linkedin',
            allowLogin: platform === 'x' || platform === 'twitter' ? false : allowLogin,
          }
        );
        status = 'posted';
      }

      const inserted = await pool.query(
        `INSERT INTO organic_comments
           (social_account_id, proxy_id, subreddit, post_url, post_title, content, status,
            ai_likeness, spam_score, platform_comment_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         RETURNING *`,
        [
          account.id,
          proxies[0].id,
          thread.subreddit,
          thread.post_url,
          thread.title,
          content,
          status,
          generated.gate.ai_likeness,
          generated.gate.spam_score,
          platformCommentId,
        ]
      );

      const commentsToday = job.comments_today + 1;
      const next = this.computeNextDue(settings, commentsToday, { daily_target: job.daily_target });
      await pool.query(
        `UPDATE organic_comment_jobs
         SET comments_today = $2,
             next_due_at = $3,
             status = 'idle',
             last_error = NULL,
             consecutive_failures = 0,
             failure_class = NULL,
             cooldown_until = NULL,
             updated_at = NOW()
         WHERE id = $1`,
        [job.id, commentsToday, next]
      );
      settled = true;

      return {
        success: true,
        comment: inserted.rows[0],
        thread,
        comments_today: commentsToday,
        next_due_at: next,
      };
    } catch (error) {
      const msg = error.message || String(error);
      // Soft operational misses: short delay, no long quarantine.
      // Match all platforms' empty-discovery strings ("No commentable X home posts",
      // "...threads", "...LinkedIn posts", "...Instagram posts") plus transient
      // browser teardown under concurrent organic ticks.
      if (
        /No commentable|gate_failed|duplicate key|has been closed|Target closed|browser.*closed/i.test(
          msg
        )
      ) {
        const next = this.computeNextDue(settings, job.comments_today, { daily_target: job.daily_target });
        await pool.query(
          `UPDATE organic_comment_jobs
           SET status = 'idle', last_error = $2, next_due_at = $3, updated_at = NOW()
           WHERE id = $1`,
          [job.id, msg, next]
        );
        settled = true;
        return { skipped: true, reason: 'soft_error', error: msg };
      }

      await this.applyFailureQuarantine(job, msg);
      settled = true;
      return { skipped: true, reason: 'error', error: msg };
    } finally {
      // Crash/hang mid-run is handled by reclaimStaleRunningJobs; this covers
      // unexpected early returns that forgot to settle status.
      if (!settled) {
        await pool.query(
          `UPDATE organic_comment_jobs
           SET status = 'idle',
               last_error = COALESCE(last_error, 'run_interrupted'),
               updated_at = NOW()
           WHERE id = $1 AND status = 'running'`,
          [job.id]
        ).catch(() => {});
      }
    }
  }
}

module.exports = new OrganicCommentService();
