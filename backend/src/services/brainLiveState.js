/**
 * In-memory live state for AccountOpsBrain — ring buffer + SSE fan-out.
 * Persists recent events + last tick to Redis so restarts don't blank the feed;
 * seeds from organic_comments / x_follows when Redis is empty.
 */
const { EventEmitter } = require('events');

const MAX_RECENT = 100;
const MAX_TICK_HISTORY = 30;
const REDIS_KEY = 'brain:live:v1';
const PERSIST_DEBOUNCE_MS = 400;

class BrainLiveState extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(50);
    this.seq = 0;
    this.enabled = false;
    this.parallel = 10;
    this.inFlight = new Map(); // slot -> action
    this.recentEvents = [];
    this.tickHistory = [];
    this.lastTick = null;
    this.pools = {
      live_x_cookies: 0,
      reddit_due: 0,
      organic_enabled: 0,
      follows_enabled: 0,
      refreshed_at: null,
    };
    this.stats15m = {
      comments: 0,
      follows: 0,
      by_platform: { x: 0, reddit: 0 },
      refreshed_at: null,
    };
    this.capacity = { alerts: [], computed_at: null, stats: {} };
    this._redis = null;
    this._persistTimer = null;
    this._hydrated = false;
  }

  _nextSeq() {
    this.seq += 1;
    return this.seq;
  }

  _pushRecent(evt) {
    this.recentEvents.unshift(evt);
    if (this.recentEvents.length > MAX_RECENT) {
      this.recentEvents.length = MAX_RECENT;
    }
    this._schedulePersist();
  }

  /** Broadcast without awaiting listeners. */
  publish(type, payload = {}) {
    const event = {
      type,
      seq: this._nextSeq(),
      at: new Date().toISOString(),
      ...payload,
    };
    try {
      this.emit('update', event);
    } catch (err) {
      console.warn('brainLiveState emit failed:', err.message);
    }
    return event;
  }

  setMeta({ enabled, parallel } = {}) {
    if (enabled != null) this.enabled = !!enabled;
    if (parallel != null) this.parallel = Number(parallel) || this.parallel;
  }

  setCapacity(capacity) {
    if (capacity) this.capacity = capacity;
  }

  setPools(pools) {
    this.pools = { ...this.pools, ...pools, refreshed_at: new Date().toISOString() };
  }

  setStats15m(stats) {
    this.stats15m = { ...this.stats15m, ...stats, refreshed_at: new Date().toISOString() };
  }

  tickStart({ workers, by_platform, planned }) {
    const tick = {
      started_at: new Date().toISOString(),
      finished_at: null,
      workers,
      by_platform: by_platform || {},
      planned: planned || [],
      status: 'running',
    };
    this.lastTick = tick;
    this._schedulePersist();
    this.publish('tick_start', { tick });
    return tick;
  }

  tickEnd({ workers, by_platform, results_summary, quiet, enrolled, bound }) {
    const finished_at = new Date().toISOString();
    const tick = {
      ...(this.lastTick || {}),
      finished_at,
      workers,
      by_platform: by_platform || {},
      status: 'idle',
      results_summary: results_summary || [],
      quiet: quiet || null,
      enrolled: enrolled || null,
      bound: bound || null,
    };
    this.lastTick = tick;
    this.tickHistory.unshift({
      at: finished_at,
      workers,
      by_platform,
      ok: (results_summary || []).filter((r) => r.status === 'success').length,
      fail: (results_summary || []).filter((r) => r.status === 'fail').length,
      soft_skip: (results_summary || []).filter((r) => r.status === 'soft_skip').length,
    });
    if (this.tickHistory.length > MAX_TICK_HISTORY) {
      this.tickHistory.length = MAX_TICK_HISTORY;
    }
    // Clear any stale in-flight from this tick
    this.inFlight.clear();
    this._schedulePersist();
    this.publish('tick_end', { tick });
    return tick;
  }

  actionStart(action) {
    const slot = action.slot != null ? action.slot : this.inFlight.size;
    const entry = {
      slot,
      account_id: action.account_id,
      username: action.username || null,
      platform: action.platform || 'unknown',
      action_type: action.action_type,
      started_at: action.started_at || new Date().toISOString(),
      status: 'running',
    };
    this.inFlight.set(slot, entry);
    this.publish('action_start', { action: entry });
    return entry;
  }

  actionEnd(action) {
    const slot = action.slot;
    const started = this.inFlight.get(slot);
    const finished_at = new Date().toISOString();
    const status = action.status || 'success';
    const evt = {
      id: `e${this.seq + 1}`,
      account_id: action.account_id ?? started?.account_id,
      username: action.username ?? started?.username,
      platform: action.platform ?? started?.platform,
      action_type: action.action_type ?? started?.action_type,
      status,
      reason: action.reason || null,
      ms: action.ms != null ? action.ms : null,
      started_at: started?.started_at || null,
      finished_at,
      slot,
    };
    this.inFlight.delete(slot);
    this._pushRecent(evt);
    this.publish('action_end', { event: evt, action: { ...evt, status: 'done' } });
    return evt;
  }

  /** Full snapshot for GET /live and SSE connect. */
  getSnapshot() {
    const workers = [];
    for (let i = 0; i < this.parallel; i++) {
      workers.push(this.inFlight.get(i) || { slot: i, status: 'idle' });
    }
    const tickAgeMs = this.lastTick?.finished_at
      ? Date.now() - new Date(this.lastTick.finished_at).getTime()
      : this.lastTick?.started_at
        ? Date.now() - new Date(this.lastTick.started_at).getTime()
        : null;

    return {
      enabled: this.enabled,
      parallel: this.parallel,
      online: this.enabled,
      seq: this.seq,
      at: new Date().toISOString(),
      tick: this.lastTick,
      tick_age_ms: tickAgeMs,
      workers,
      in_flight: [...this.inFlight.values()],
      recent_events: this.recentEvents.slice(0, MAX_RECENT),
      tick_history: this.tickHistory,
      pools: this.pools,
      stats_15m: this.stats15m,
      capacity: {
        alerts: this.capacity?.alerts || [],
        computed_at: this.capacity?.computed_at || null,
        stats: this.capacity?.stats || {},
      },
    };
  }

  subscribe(listener) {
    this.on('update', listener);
    return () => this.off('update', listener);
  }

  _redisClient() {
    if (this._redis) return this._redis;
    try {
      const Redis = require('ioredis');
      this._redis = new Redis({
        host: process.env.REDIS_HOST || '127.0.0.1',
        port: parseInt(process.env.REDIS_PORT || '6379', 10),
        maxRetriesPerRequest: 1,
        enableReadyCheck: false,
        lazyConnect: true,
      });
      this._redis.on('error', (err) => {
        console.warn('brainLiveState redis:', err.message);
      });
    } catch (err) {
      console.warn('brainLiveState redis unavailable:', err.message);
      return null;
    }
    return this._redis;
  }

  _schedulePersist() {
    if (this._persistTimer) clearTimeout(this._persistTimer);
    this._persistTimer = setTimeout(() => {
      this._persistTimer = null;
      this._persistToRedis().catch((err) => {
        console.warn('brainLiveState persist failed:', err.message);
      });
    }, PERSIST_DEBOUNCE_MS);
  }

  async _persistToRedis() {
    const redis = this._redisClient();
    if (!redis) return;
    if (redis.status !== 'ready') {
      try {
        await redis.connect();
      } catch (_) {
        /* may already be connecting */
      }
    }
    const payload = JSON.stringify({
      seq: this.seq,
      lastTick: this.lastTick,
      tickHistory: this.tickHistory.slice(0, MAX_TICK_HISTORY),
      recentEvents: this.recentEvents.slice(0, MAX_RECENT),
      saved_at: new Date().toISOString(),
    });
    await redis.set(REDIS_KEY, payload, 'EX', 7 * 24 * 60 * 60);
  }

  async _loadFromRedis() {
    const redis = this._redisClient();
    if (!redis) return false;
    try {
      if (redis.status !== 'ready') await redis.connect();
      const raw = await redis.get(REDIS_KEY);
      if (!raw) return false;
      const data = JSON.parse(raw);
      if (Array.isArray(data.recentEvents) && data.recentEvents.length) {
        this.recentEvents = data.recentEvents.slice(0, MAX_RECENT);
      }
      if (data.lastTick) this.lastTick = data.lastTick;
      if (Array.isArray(data.tickHistory)) {
        this.tickHistory = data.tickHistory.slice(0, MAX_TICK_HISTORY);
      }
      if (Number.isFinite(data.seq)) this.seq = Math.max(this.seq, data.seq);
      return this.recentEvents.length > 0 || !!this.lastTick;
    } catch (err) {
      console.warn('brainLiveState redis load failed:', err.message);
      return false;
    }
  }

  async _seedFromDb() {
    try {
      const pool = require('./db');
      const [comments, follows] = await Promise.all([
        pool.query(`
          SELECT oc.id, oc.social_account_id, oc.status, oc.error, oc.created_at,
                 sa.username, sa.platform
          FROM organic_comments oc
          JOIN social_accounts sa ON sa.id = oc.social_account_id
          WHERE oc.status IN ('posted', 'failed', 'error', 'skipped')
          ORDER BY oc.created_at DESC
          LIMIT 40
        `),
        pool.query(`
          SELECT xf.id, xf.social_account_id, xf.handle, xf.status, xf.created_at,
                 sa.username, sa.platform
          FROM x_follows xf
          JOIN social_accounts sa ON sa.id = xf.social_account_id
          ORDER BY xf.created_at DESC
          LIMIT 40
        `).catch(() => ({ rows: [] })),
      ]);

      const events = [];
      for (const row of comments.rows || []) {
        const plat = /twitter|^x$/i.test(row.platform || '') ? 'x' : String(row.platform || 'unknown').toLowerCase();
        const ok = row.status === 'posted';
        events.push({
          id: `oc-${row.id}`,
          account_id: row.social_account_id,
          username: row.username,
          platform: plat,
          action_type: 'search_comment',
          status: ok ? 'success' : row.status === 'skipped' ? 'soft_skip' : 'fail',
          reason: row.error || null,
          ms: null,
          started_at: null,
          finished_at: row.created_at ? new Date(row.created_at).toISOString() : null,
          slot: null,
          _seeded: true,
        });
      }
      for (const row of follows.rows || []) {
        const ok = /follow|already/i.test(row.status || '');
        events.push({
          id: `xf-${row.id}`,
          account_id: row.social_account_id,
          username: row.username,
          platform: 'x',
          action_type: 'follow',
          status: ok ? 'success' : 'fail',
          reason: row.handle ? `@${row.handle}` : row.status,
          ms: null,
          started_at: null,
          finished_at: row.created_at ? new Date(row.created_at).toISOString() : null,
          slot: null,
          _seeded: true,
        });
      }

      events.sort((a, b) => {
        const ta = a.finished_at ? new Date(a.finished_at).getTime() : 0;
        const tb = b.finished_at ? new Date(b.finished_at).getTime() : 0;
        return tb - ta;
      });

      if (events.length) {
        this.recentEvents = events.slice(0, MAX_RECENT);
        if (!this.lastTick && events[0]?.finished_at) {
          this.lastTick = {
            started_at: events[0].finished_at,
            finished_at: events[0].finished_at,
            workers: 0,
            by_platform: {},
            status: 'idle',
            results_summary: [],
            seeded: true,
          };
        }
        this._schedulePersist();
        console.log(`brainLiveState seeded ${this.recentEvents.length} events from DB`);
        return true;
      }
    } catch (err) {
      console.warn('brainLiveState DB seed failed:', err.message);
    }
    return false;
  }

  /**
   * Load ring buffer from Redis, else seed from recent DB rows.
   * Safe to call multiple times; only hydrates once per process.
   */
  async hydrate() {
    if (this._hydrated) return this.getSnapshot();
    this._hydrated = true;
    const fromRedis = await this._loadFromRedis();
    if (!fromRedis || this.recentEvents.length === 0) {
      await this._seedFromDb();
    } else {
      console.log(
        `brainLiveState restored ${this.recentEvents.length} events from Redis` +
          (this.lastTick ? ' (+lastTick)' : '')
      );
    }
    return this.getSnapshot();
  }
}

module.exports = new BrainLiveState();
