import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import api from '../utils/api';

const PLAT = {
  x: { color: '#e7e9ea', accent: '#1d9bf0', label: 'X' },
  reddit: { color: '#ff4500', accent: '#ff8717', label: 'REDDIT' },
  linkedin: { color: '#0a66c2', accent: '#70b5f9', label: 'LINKEDIN' },
  unknown: { color: '#64748b', accent: '#94a3b8', label: '?' },
};

const STATUS_TONE = {
  success: '#34d399',
  fail: '#f87171',
  soft_skip: '#fbbf24',
  running: '#22d3ee',
  idle: '#334155',
};

const ago = (value) => {
  if (!value && value !== 0) return '—';
  const ms = typeof value === 'number' ? value : Date.now() - new Date(value).getTime();
  if (Number.isNaN(ms)) return '—';
  const s = Math.floor(Math.abs(ms) / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h`;
};

const fmtMs = (ms) => {
  if (ms == null) return '';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
};

const emptySnapshot = () => ({
  enabled: false,
  parallel: 10,
  online: false,
  workers: Array.from({ length: 10 }, (_, i) => ({ slot: i, status: 'idle' })),
  in_flight: [],
  recent_events: [],
  pools: {},
  stats_15m: { comments: 0, follows: 0, by_platform: { x: 0, reddit: 0 } },
  capacity: { alerts: [] },
  tick: null,
  tick_age_ms: null,
});

const BrainDashboard = () => {
  const [snap, setSnap] = useState(emptySnapshot);
  const [conn, setConn] = useState('boot'); // boot | live | poll | reconnect | error
  const [clock, setClock] = useState(() => new Date());
  const [feedFlash, setFeedFlash] = useState([]);
  const esRef = useRef(null);
  const reconnectRef = useRef(null);
  const pollRef = useRef(null);
  const mountedRef = useRef(true);

  const applySnapshot = useCallback((data) => {
    if (!data || !mountedRef.current) return;
    setSnap((prev) => ({
      ...prev,
      ...data,
      workers: data.workers?.length
        ? data.workers
        : Array.from({ length: data.parallel || 10 }, (_, i) => ({ slot: i, status: 'idle' })),
    }));
  }, []);

  const pushFeed = useCallback((event) => {
    if (!event) return;
    const id = event.id || `${event.finished_at}-${event.account_id}-${event.action_type}`;
    setFeedFlash((prev) => [{ ...event, _id: id, _in: true }, ...prev].slice(0, 40));
  }, []);

  const loadSnapshot = useCallback(async () => {
    try {
      const res = await api.get('/api/brain/live');
      applySnapshot(res.data);
      if (mountedRef.current) setConn((c) => (c === 'live' ? c : 'poll'));
      return true;
    } catch (err) {
      if (mountedRef.current) setConn('error');
      return false;
    }
  }, [applySnapshot]);

  const connectStream = useCallback(() => {
    if (esRef.current) {
      try { esRef.current.close(); } catch (_) { /* */ }
      esRef.current = null;
    }
    const token = localStorage.getItem('accessToken');
    if (!token) {
      loadSnapshot();
      return;
    }
    setConn((c) => (c === 'live' ? 'reconnect' : 'boot'));
    const url = `/api/brain/stream?token=${encodeURIComponent(token)}`;
    const es = new EventSource(url);
    esRef.current = es;

    es.addEventListener('snapshot', (e) => {
      try {
        applySnapshot(JSON.parse(e.data));
        setConn('live');
      } catch (_) { /* */ }
    });

    const onTickish = (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data.snapshot) applySnapshot(data.snapshot);
        else if (data.tick) {
          setSnap((prev) => ({
            ...prev,
            tick: data.tick,
            tick_age_ms: data.tick.finished_at
              ? Date.now() - new Date(data.tick.finished_at).getTime()
              : 0,
          }));
        }
        setConn('live');
      } catch (_) { /* */ }
    };
    es.addEventListener('tick_start', onTickish);
    es.addEventListener('tick_end', onTickish);

    es.addEventListener('action_start', (e) => {
      try {
        const data = JSON.parse(e.data);
        const action = data.action;
        if (!action) return;
        setSnap((prev) => {
          const workers = [...(prev.workers || [])];
          while (workers.length < (prev.parallel || 10)) {
            workers.push({ slot: workers.length, status: 'idle' });
          }
          workers[action.slot] = { ...action, status: 'running' };
          const in_flight = workers.filter((w) => w.status === 'running');
          return { ...prev, workers, in_flight };
        });
        setConn('live');
      } catch (_) { /* */ }
    });

    es.addEventListener('action_end', (e) => {
      try {
        const data = JSON.parse(e.data);
        const event = data.event;
        const action = data.action;
        if (event) {
          pushFeed(event);
          setSnap((prev) => ({
            ...prev,
            recent_events: [event, ...(prev.recent_events || [])].slice(0, 100),
          }));
        }
        if (action && action.slot != null) {
          setSnap((prev) => {
            const workers = [...(prev.workers || [])];
            workers[action.slot] = { slot: action.slot, status: 'idle' };
            return {
              ...prev,
              workers,
              in_flight: workers.filter((w) => w.status === 'running'),
            };
          });
        }
        setConn('live');
      } catch (_) { /* */ }
    });

    es.onerror = () => {
      setConn('reconnect');
      try { es.close(); } catch (_) { /* */ }
      esRef.current = null;
      if (reconnectRef.current) clearTimeout(reconnectRef.current);
      reconnectRef.current = setTimeout(() => {
        if (mountedRef.current) connectStream();
      }, 2500);
      loadSnapshot();
    };
  }, [applySnapshot, loadSnapshot, pushFeed]);

  useEffect(() => {
    mountedRef.current = true;
    loadSnapshot().then(() => connectStream());
    pollRef.current = setInterval(() => {
      // Fallback poll if SSE dropped; cheap when live (skip if stream healthy recently)
      if (esRef.current?.readyState !== EventSource.OPEN) loadSnapshot();
    }, 8000);
    const clockT = setInterval(() => setClock(new Date()), 1000);
    return () => {
      mountedRef.current = false;
      if (esRef.current) try { esRef.current.close(); } catch (_) { /* */ }
      if (reconnectRef.current) clearTimeout(reconnectRef.current);
      if (pollRef.current) clearInterval(pollRef.current);
      clearInterval(clockT);
    };
  }, [connectStream, loadSnapshot]);

  // Seed feed from snapshot recent_events once
  useEffect(() => {
    if (snap.recent_events?.length && feedFlash.length === 0) {
      setFeedFlash(snap.recent_events.slice(0, 20).map((e, i) => ({ ...e, _id: e.id || `seed-${i}` })));
    }
  }, [snap.recent_events, feedFlash.length]);

  // Recompute ages off `clock` so idle ticks don't freeze at snapshot time
  void clock;
  const activeWorkers = (snap.in_flight || []).length || (snap.workers || []).filter((w) => w.status === 'running').length;
  const tickAge = (() => {
    if (snap.tick?.status === 'running' && snap.tick.started_at) {
      const ms = Date.now() - new Date(snap.tick.started_at).getTime();
      return Number.isNaN(ms) ? null : ms;
    }
    if (snap.tick?.finished_at) {
      const ms = Date.now() - new Date(snap.tick.finished_at).getTime();
      return Number.isNaN(ms) ? null : ms;
    }
    if (snap.tick?.started_at) {
      const ms = Date.now() - new Date(snap.tick.started_at).getTime();
      return Number.isNaN(ms) ? null : ms;
    }
    return snap.tick_age_ms != null && !Number.isNaN(snap.tick_age_ms) ? snap.tick_age_ms : null;
  })();
  const byPlat = snap.tick?.by_platform || {};
  const xShare = byPlat.x || 0;
  const rShare = byPlat.reddit || 0;
  const shareTotal = Math.max(1, xShare + rShare);
  const pools = snap.pools || {};
  const stats = snap.stats_15m || {};
  const alerts = snap.capacity?.alerts || [];
  const online = snap.enabled || snap.online;
  const clockStr = useMemo(
    () => clock.toLocaleTimeString(undefined, { hour12: false }),
    [clock]
  );

  const connLabel =
    conn === 'live' ? 'STREAM LOCKED' :
    conn === 'poll' ? 'POLL MODE' :
    conn === 'reconnect' ? 'RECONNECTING' :
    conn === 'error' ? 'UPLINK DOWN' :
    'ACQUIRING';

  return (
    <div className="brain-wall">
      <div className="brain-grid-bg" aria-hidden />
      <header className="brain-header">
        <div className="flex items-center gap-4 min-w-0">
          <div className={`brain-core ${online ? 'brain-core-on' : 'brain-core-off'}`}>
            <span className="brain-core-ring" />
            <span className="brain-core-dot" />
          </div>
          <div className="min-w-0">
            <div className="flex items-baseline gap-3 flex-wrap">
              <h1 className="brain-title">ACCOUNT OPS BRAIN</h1>
              <span className={`brain-status-pill ${online ? 'on' : 'off'}`}>
                {online ? 'BRAIN ONLINE' : 'BRAIN OFFLINE'}
              </span>
            </div>
            <div className="brain-meta">
              <span>TICK AGE {ago(tickAge)}</span>
              <span className="brain-sep">·</span>
              <span>WIDTH {activeWorkers}/{snap.parallel || 10}</span>
              <span className="brain-sep">·</span>
              <span className={conn === 'live' ? 'text-emerald-400' : 'text-amber-400'}>{connLabel}</span>
              <span className="brain-sep">·</span>
              <span className="tabular-nums">{clockStr}</span>
            </div>
          </div>
        </div>
        <div className="brain-header-stats">
          <div className="brain-stat">
            <div className="brain-stat-label">COMMENTS 15M</div>
            <div className="brain-stat-val text-cyan-300">{stats.comments ?? 0}</div>
          </div>
          <div className="brain-stat">
            <div className="brain-stat-label">FOLLOWS 15M</div>
            <div className="brain-stat-val text-sky-300">{stats.follows ?? 0}</div>
          </div>
          <div className="brain-stat">
            <div className="brain-stat-label">ALERTS</div>
            <div className={`brain-stat-val ${alerts.length ? 'text-amber-400' : 'text-slate-500'}`}>
              {alerts.length}
            </div>
          </div>
        </div>
      </header>

      <div className="brain-body">
        {/* Fair-share + pools */}
        <section className="brain-rail">
          <div className="brain-panel">
            <div className="brain-panel-head">FAIR SHARE · CURRENT TICK</div>
            <div className="brain-share-bar">
              <div
                className="brain-share-x"
                style={{ width: `${(xShare / shareTotal) * 100}%` }}
                title={`X ${xShare}`}
              />
              <div
                className="brain-share-r"
                style={{ width: `${(rShare / shareTotal) * 100}%` }}
                title={`Reddit ${rShare}`}
              />
            </div>
            <div className="brain-share-legend">
              <span><i style={{ background: PLAT.x.accent }} /> X {xShare}</span>
              <span><i style={{ background: PLAT.reddit.color }} /> REDDIT {rShare}</span>
            </div>
          </div>

          <div className="brain-panel brain-pools">
            <div className="brain-panel-head">POOLS</div>
            <div className="brain-pool-grid">
              {[
                ['LIVE X COOKIES', pools.live_x_cookies],
                ['REDDIT DUE', pools.reddit_due],
                ['ORGANIC ON', pools.organic_enabled],
                ['FOLLOWS ON', pools.follows_enabled],
              ].map(([label, val]) => (
                <div key={label} className="brain-pool-cell">
                  <div className="brain-stat-label">{label}</div>
                  <div className="brain-pool-num">{val ?? '—'}</div>
                </div>
              ))}
            </div>
          </div>

          {alerts.length > 0 && (
            <div className="brain-panel">
              <div className="brain-panel-head">CAPACITY</div>
              <ul className="brain-alerts">
                {alerts.slice(0, 5).map((a) => (
                  <li key={a.id || a.message} className={`sev-${a.severity || 'info'}`}>
                    <span className="sev">{(a.severity || 'info').toUpperCase()}</span>
                    {a.message}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>

        {/* Worker nodes */}
        <section className="brain-workers-wrap">
          <div className="brain-panel-head px-1 mb-2 flex justify-between">
            <span>WORKER MESH · {snap.parallel || 10} SLOTS</span>
            <span className={activeWorkers ? 'brain-live-pulse' : ''}>
              {activeWorkers
                ? `${activeWorkers} ACTIVE`
                : tickAge != null
                  ? `IDLE · last tick ${ago(tickAge)}`
                  : 'IDLE'}
            </span>
          </div>
          <div className="brain-workers">
            {(snap.workers || []).map((w) => {
              const running = w.status === 'running';
              const plat = PLAT[w.platform] || PLAT.unknown;
              const lastForSlot = !running
                ? (snap.recent_events || []).find((e) => e.slot === w.slot)
                : null;
              return (
                <div
                  key={w.slot}
                  className={`brain-node ${running ? 'active' : 'idle'} plat-${w.platform || 'none'}`}
                  style={running ? { borderColor: plat.color + '99', boxShadow: `0 0 0 1px ${plat.accent}33` } : undefined}
                >
                  <div className="brain-node-top">
                    <span className="brain-slot">W{String(w.slot).padStart(2, '0')}</span>
                    {running && (
                      <span className="brain-plat-chip" style={{ color: plat.accent, borderColor: plat.accent + '66' }}>
                        {plat.label}
                      </span>
                    )}
                  </div>
                  {running ? (
                    <>
                      <div className="brain-node-action">{w.action_type}</div>
                      <div className="brain-node-user" title={w.username}>
                        @{w.username || w.account_id}
                      </div>
                      <div className="brain-node-age">{ago(w.started_at)}</div>
                      <div className="brain-node-pulse" style={{ background: plat.accent }} />
                    </>
                  ) : (
                    <div className="brain-node-idle">
                      {lastForSlot?.finished_at
                        ? `IDLE · ${ago(lastForSlot.finished_at)}`
                        : tickAge != null
                          ? `IDLE · ${ago(tickAge)}`
                          : 'IDLE'}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </section>

        {/* Activity feed */}
        <section className="brain-feed-wrap">
          <div className="brain-panel h-full flex flex-col">
            <div className="brain-panel-head">ACTIVITY FEED</div>
            <div className="brain-feed">
              {(feedFlash.length ? feedFlash : snap.recent_events || []).slice(0, 50).map((e) => {
                const tone = STATUS_TONE[e.status] || STATUS_TONE.idle;
                const plat = PLAT[e.platform] || PLAT.unknown;
                return (
                  <div key={e._id || e.id || `${e.finished_at}-${e.account_id}`} className="brain-feed-item">
                    <span className="brain-feed-dot" style={{ background: tone }} />
                    <span className="brain-feed-time">{ago(e.finished_at || e.at)}</span>
                    <span className="brain-feed-plat" style={{ color: plat.accent }}>{plat.label}</span>
                    <span className="brain-feed-action">{e.action_type}</span>
                    <span className="brain-feed-user">@{e.username || e.account_id}</span>
                    <span className="brain-feed-status" style={{ color: tone }}>
                      {(e.status || '').toUpperCase()}
                    </span>
                    {e.ms != null && <span className="brain-feed-ms">{fmtMs(e.ms)}</span>}
                    {e.reason && <span className="brain-feed-reason">{e.reason}</span>}
                  </div>
                );
              })}
              {!feedFlash.length && !(snap.recent_events || []).length && (
                <div className="brain-feed-empty">Waiting for brain ticks…</div>
              )}
            </div>
          </div>
        </section>
      </div>
    </div>
  );
};

export default BrainDashboard;
