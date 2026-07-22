/**
 * In-memory live state for AccountOpsBrain — ring buffer + SSE fan-out.
 * Never blocks workers; all publishes are sync + fire-and-forget.
 */
const { EventEmitter } = require('events');

const MAX_RECENT = 100;
const MAX_TICK_HISTORY = 30;

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
}

module.exports = new BrainLiveState();
