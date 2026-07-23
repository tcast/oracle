/**
 * Durable cross-platform activity log.
 * Append-only events for Social Accounts → Log (and Brain consumers).
 */
const pool = require('./db');

const PLATFORM_ALIASES = { twitter: 'x' };

let schemaReady = false;
let schemaPromise = null;
let backfillPromise = null;

function normalizePlatform(platform) {
  const p = String(platform || 'unknown').toLowerCase();
  return PLATFORM_ALIASES[p] || p;
}

function normalizeResult(result) {
  const r = String(result || 'success').toLowerCase();
  if (['success', 'ok', 'posted', 'followed', 'already', 'pending'].includes(r)) return 'success';
  if (['soft_skip', 'skipped', 'skip'].includes(r)) return 'soft_skip';
  if (['fail', 'failed', 'error', 'login_failed'].includes(r)) return 'fail';
  if (r === 'simulated') return 'simulated';
  return r.slice(0, 32);
}

/** Map brain live action types onto durable activity actions. */
function mapBrainAction(actionType, status, reason) {
  const t = String(actionType || '').toLowerCase();
  const reasonStr = String(reason || '');
  if (/id.?verif|government.?id|checkpoint/i.test(reasonStr)) {
    if (/id.?verif|government.?id/i.test(reasonStr)) return 'id_verification';
    return 'checkpoint';
  }
  if (/session_dead|cookie_session_dead|no_live_session/i.test(reasonStr)) return 'session_dead';
  if (/login_failed|bad_credentials/i.test(reasonStr)) return 'login_failed';
  if (t === 'profile_gap') return 'profile_updated';
  if (t === 'search_comment' || t === 'home_comment' || t === 'organic_comment') return 'commented';
  if (t === 'follow' || t === 'network') return 'followed';
  if (t === 'accept_follows') return 'accept_follows';
  if (t === 'discover_targets') return 'discover_targets';
  if (status === 'soft_skip') return 'soft_skip';
  return t || 'action';
}

function profileLink(platform, username) {
  if (!username) return null;
  const u = String(username).replace(/^@/, '');
  switch (normalizePlatform(platform)) {
    case 'x':
      return `https://x.com/${encodeURIComponent(u)}`;
    case 'reddit':
      return `https://www.reddit.com/user/${encodeURIComponent(u)}/`;
    case 'linkedin':
      if (/^https?:\/\//i.test(u)) return u;
      if (u.includes('/')) return `https://www.linkedin.com/${u.replace(/^\//, '')}`;
      return `https://www.linkedin.com/in/${encodeURIComponent(u)}`;
    case 'instagram':
      return `https://www.instagram.com/${encodeURIComponent(u)}/`;
    case 'tiktok':
      return `https://www.tiktok.com/@${encodeURIComponent(u)}`;
    default:
      return null;
  }
}

function followLink(platform, handle, profileUrl) {
  if (profileUrl && /^https?:\/\//i.test(profileUrl)) return profileUrl;
  return profileLink(platform, handle);
}

class ActivityEventService {
  async ensureSchema() {
    if (schemaReady) return;
    if (schemaPromise) return schemaPromise;
    schemaPromise = (async () => {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS activity_events (
          id BIGSERIAL PRIMARY KEY,
          occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          platform VARCHAR(32) NOT NULL,
          action VARCHAR(64) NOT NULL,
          account_id INTEGER REFERENCES social_accounts(id) ON DELETE SET NULL,
          username VARCHAR(255),
          result VARCHAR(32) NOT NULL DEFAULT 'success',
          link TEXT,
          detail TEXT,
          meta JSONB NOT NULL DEFAULT '{}'::jsonb,
          source VARCHAR(64),
          source_id BIGINT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await pool.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_activity_events_source_unique
          ON activity_events (source, source_id)
          WHERE source IS NOT NULL AND source_id IS NOT NULL
      `);
      await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_activity_events_occurred
          ON activity_events (occurred_at DESC)
      `);
      await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_activity_events_platform_occurred
          ON activity_events (platform, occurred_at DESC)
      `);
      await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_activity_events_action_occurred
          ON activity_events (action, occurred_at DESC)
      `);
      await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_activity_events_account_occurred
          ON activity_events (account_id, occurred_at DESC)
      `);
      schemaReady = true;
    })().catch((err) => {
      schemaPromise = null;
      throw err;
    });
    return schemaPromise;
  }

  /**
   * Append one activity event. Never throws to callers (logging must not break ops).
   */
  async log(event = {}) {
    try {
      await this.ensureSchema();
      const platform = normalizePlatform(event.platform);
      const action = String(event.action || 'action').slice(0, 64);
      const result = normalizeResult(event.result);
      const meta = event.meta && typeof event.meta === 'object' ? event.meta : {};
      const occurredAt = event.occurred_at ? new Date(event.occurred_at) : new Date();

      const inserted = await pool.query(
        `INSERT INTO activity_events
           (occurred_at, platform, action, account_id, username, result, link, detail, meta, source, source_id)
         SELECT $1::timestamptz, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11
         WHERE $10::text IS NULL OR $11::bigint IS NULL
            OR NOT EXISTS (
              SELECT 1 FROM activity_events ae
              WHERE ae.source = $10 AND ae.source_id = $11
            )
         RETURNING *`,
        [
          occurredAt.toISOString(),
          platform,
          action,
          event.account_id != null ? Number(event.account_id) : null,
          event.username ? String(event.username).slice(0, 255) : null,
          result,
          event.link || null,
          event.detail ? String(event.detail).slice(0, 2000) : null,
          JSON.stringify(meta),
          event.source || null,
          event.source_id != null ? Number(event.source_id) : null,
        ]
      );
      return inserted.rows[0] || null;
    } catch (err) {
      console.warn('activityEvent log failed:', err.message);
      return null;
    }
  }

  /** Log brain ring-buffer events (skips success comment/follow — services own those + links). */
  async logBrainEvent(evt = {}) {
    const status = evt.status || 'success';
    const actionType = evt.action_type || evt.action;
    const skipSuccess = new Set(['search_comment', 'home_comment', 'organic_comment', 'follow', 'network']);
    if (status === 'success' && skipSuccess.has(String(actionType || '').toLowerCase())) {
      return null;
    }
    const action = mapBrainAction(actionType, status, evt.reason);
    const platform = normalizePlatform(evt.platform);
    let link = evt.link || null;
    if (!link && action === 'profile_updated' && evt.username) {
      link = profileLink(platform, evt.username);
    }
    return this.log({
      occurred_at: evt.finished_at || evt.at || new Date(),
      platform,
      action,
      account_id: evt.account_id,
      username: evt.username,
      result: status,
      link,
      detail: evt.reason || evt.detail || null,
      meta: {
        brain_action: actionType,
        ms: evt.ms,
        slot: evt.slot,
        ...(evt.meta || {}),
      },
      source: 'brain',
      source_id: null,
    });
  }

  async logOrganicComment({ account, comment, platform }) {
    if (!comment?.id) return null;
    const plat = normalizePlatform(platform || account?.platform);
    const status = String(comment.status || '').toLowerCase();
    let result = 'success';
    if (status === 'simulated') result = 'simulated';
    else if (status === 'error' || status === 'failed' || status === 'skipped') result = status === 'skipped' ? 'soft_skip' : 'fail';
    return this.log({
      occurred_at: comment.created_at,
      platform: plat,
      action: 'commented',
      account_id: account?.id || comment.social_account_id,
      username: account?.username,
      result,
      link: comment.post_url || null,
      detail: comment.post_title || comment.content?.slice(0, 160) || comment.error || null,
      meta: {
        subreddit: comment.subreddit || null,
        platform_comment_id: comment.platform_comment_id || null,
      },
      source: 'organic_comments',
      source_id: comment.id,
    });
  }

  async logFollow({ account, platform, row, handle, profileUrl }) {
    const id = row?.id;
    if (id == null) return null;
    const plat = normalizePlatform(platform || account?.platform);
    const status = String(row.status || '').toLowerCase();
    const result = /follow|already|pending/i.test(status) ? 'success' : 'fail';
    const src =
      plat === 'reddit' ? 'reddit_follows' : plat === 'linkedin' ? 'linkedin_follows' : 'x_follows';
    return this.log({
      occurred_at: row.created_at || new Date(),
      platform: plat,
      action: 'followed',
      account_id: account?.id || row.social_account_id,
      username: account?.username,
      result: row.error ? 'fail' : result,
      link: followLink(plat, handle || row.handle, profileUrl || row.profile_url),
      detail: handle || row.handle ? `@${String(handle || row.handle).replace(/^@/, '')}` : row.error || null,
      meta: { status: row.status, category: row.category || null },
      source: src,
      source_id: id,
    });
  }

  async logAccountStatus({ accountId, username, platform, action, detail }) {
    return this.log({
      platform: platform || 'unknown',
      action,
      account_id: accountId,
      username,
      result: action === 'banned' || action === 'session_dead' ? 'fail' : 'success',
      link: profileLink(platform, username),
      detail,
      source: 'account_ops',
      source_id: null,
    });
  }

  async list({
    platform,
    action,
    account_id,
    result,
    since,
    until,
    limit = 100,
    offset = 0,
  } = {}) {
    await this.ensureSchema();
    await this.ensureBackfill();

    const where = [];
    const params = [];
    let i = 1;

    if (platform && platform !== 'all') {
      where.push(`platform = $${i++}`);
      params.push(normalizePlatform(platform));
    }
    if (action && action !== 'all') {
      where.push(`action = $${i++}`);
      params.push(String(action));
    }
    if (account_id) {
      where.push(`account_id = $${i++}`);
      params.push(Number(account_id));
    }
    if (result && result !== 'all') {
      where.push(`result = $${i++}`);
      params.push(normalizeResult(result));
    }
    if (since) {
      where.push(`occurred_at >= $${i++}`);
      params.push(new Date(since).toISOString());
    }
    if (until) {
      where.push(`occurred_at <= $${i++}`);
      params.push(new Date(until).toISOString());
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const lim = Math.min(Math.max(Number(limit) || 100, 1), 500);
    const off = Math.max(Number(offset) || 0, 0);

    const [rows, countRes, platformsRes, actionsRes] = await Promise.all([
      pool.query(
        `SELECT id, occurred_at, platform, action, account_id, username, result, link, detail, meta, source, source_id
         FROM activity_events
         ${whereSql}
         ORDER BY occurred_at DESC, id DESC
         LIMIT $${i} OFFSET $${i + 1}`,
        [...params, lim, off]
      ),
      pool.query(`SELECT COUNT(*)::int AS total FROM activity_events ${whereSql}`, params),
      pool.query(
        `SELECT platform, COUNT(*)::int AS n FROM activity_events GROUP BY platform ORDER BY n DESC`
      ),
      pool.query(
        `SELECT action, COUNT(*)::int AS n FROM activity_events GROUP BY action ORDER BY n DESC`
      ),
    ]);

    return {
      events: rows.rows,
      total: countRes.rows[0]?.total || 0,
      limit: lim,
      offset: off,
      platforms: platformsRes.rows,
      actions: actionsRes.rows,
    };
  }

  async ensureBackfill() {
    if (backfillPromise) return backfillPromise;
    backfillPromise = this.backfillRecent({ days: 14, perSource: 500 }).catch((err) => {
      console.warn('activityEvent backfill failed:', err.message);
      backfillPromise = null;
    });
    return backfillPromise;
  }

  resetBackfillGate() {
    backfillPromise = null;
  }

  /** One-shot-ish backfill from existing operational tables. */
  async backfillRecent({ days = 14, perSource = 500 } = {}) {
    await this.ensureSchema();
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

    const comments = await pool.query(
      `SELECT oc.*, sa.username, sa.platform
       FROM organic_comments oc
       JOIN social_accounts sa ON sa.id = oc.social_account_id
       WHERE oc.created_at >= $1
       ORDER BY oc.created_at DESC
       LIMIT $2`,
      [since, perSource]
    );
    for (const row of comments.rows) {
      await this.logOrganicComment({
        account: { id: row.social_account_id, username: row.username, platform: row.platform },
        comment: row,
        platform: row.platform,
      });
    }

    const followSources = [
      { table: 'x_follows', platform: 'x' },
      { table: 'reddit_follows', platform: 'reddit' },
      { table: 'linkedin_follows', platform: 'linkedin' },
    ];
    for (const src of followSources) {
      try {
        const follows = await pool.query(
          `SELECT f.*, sa.username, sa.platform
           FROM ${src.table} f
           JOIN social_accounts sa ON sa.id = f.social_account_id
           WHERE f.created_at >= $1
           ORDER BY f.created_at DESC
           LIMIT $2`,
          [since, perSource]
        );
        for (const row of follows.rows) {
          await this.logFollow({
            account: { id: row.social_account_id, username: row.username, platform: row.platform },
            platform: src.platform,
            row,
            handle: row.handle,
            profileUrl: row.profile_url,
          });
        }
      } catch (err) {
        if (!/does not exist/i.test(err.message || '')) {
          console.warn(`activity backfill ${src.table}:`, err.message);
        }
      }
    }

    const count = await pool.query('SELECT COUNT(*)::int AS n FROM activity_events');
    return { events: count.rows[0]?.n || 0 };
  }
}

module.exports = new ActivityEventService();
module.exports.profileLink = profileLink;
module.exports.normalizePlatform = normalizePlatform;
module.exports.mapBrainAction = mapBrainAction;
