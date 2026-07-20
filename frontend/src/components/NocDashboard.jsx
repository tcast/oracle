import React, { useCallback, useEffect, useState } from 'react';
import api from '../utils/api';

const POLL_MS = 5000;

const fmt = (value) => {
  if (!value) return '—';
  try {
    return new Date(value).toLocaleString();
  } catch {
    return String(value);
  }
};

const ago = (value) => {
  if (!value) return '—';
  const ms = Date.now() - new Date(value).getTime();
  if (Number.isNaN(ms)) return '—';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ago`;
  return fmt(value);
};

const Stat = ({ label, value, tone }) => {
  const toneClass =
    tone === 'good' ? 'text-emerald-700' :
    tone === 'bad' ? 'text-red-700' :
    tone === 'warn' ? 'text-amber-700' :
    'text-gray-900';
  return (
    <div className="min-w-0">
      <div className="stat-label">{label}</div>
      <div className={`stat-value ${toneClass}`}>{value ?? '—'}</div>
    </div>
  );
};

const Section = ({ title, children, action }) => (
  <section className="bg-white border border-gray-200 rounded-lg">
    <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100">
      <h2 className="text-sm font-semibold text-gray-900 tracking-wide uppercase">{title}</h2>
      {action}
    </div>
    <div className="p-4">{children}</div>
  </section>
);

const NocDashboard = () => {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [probing, setProbing] = useState(false);
  const [lastFetchMs, setLastFetchMs] = useState(null);

  const load = useCallback(async () => {
    const started = Date.now();
    try {
      const res = await api.get('/api/noc/dashboard');
      setData(res.data);
      setError(null);
      setLastFetchMs(Date.now() - started);
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, POLL_MS);
    return () => clearInterval(t);
  }, [load]);

  const runProbeBatch = async () => {
    try {
      setProbing(true);
      await api.post('/api/noc/proxies/probe-batch', { limit: 3 });
      await load();
    } catch (err) {
      alert(err.response?.data?.error || err.message);
    } finally {
      setProbing(false);
    }
  };

  if (loading && !data) {
    return <div className="text-sm text-gray-500 py-8">Loading NOC…</div>;
  }

  if (error && !data) {
    return (
      <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm">
        {error}
      </div>
    );
  }

  const px = data.proxies || {};
  const ov = px.overview || {};
  const accounts = data.accounts || {};
  const posting = data.posting || {};
  const errors = data.errors || {};
  const mapping = data.mapping || {};
  const queue = data.queue || {};
  const protection = data.protection || {};
  const organic = posting.organic || {};

  const overallTone =
    !ov.active || ov.in_cooldown > 5 || (ov.error_rate || 0) > 40 ? 'bad' :
    ov.degraded > 0 || ov.in_cooldown > 0 ? 'warn' : 'good';

  return (
    <div className="space-y-5">
      <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3">
        <div className="min-w-0">
          <h1 className="page-title">NOC</h1>
          <p className="page-subtitle">
            Proxy health, account status, posting, and errors — live ops view
          </p>
        </div>
        <div className="flex items-center gap-3 text-xs text-gray-500">
          <span className={`inline-flex items-center gap-1.5 ${overallTone === 'good' ? 'text-emerald-600' : overallTone === 'bad' ? 'text-red-600' : 'text-amber-600'}`}>
            <span className={`w-2 h-2 rounded-full ${overallTone === 'good' ? 'bg-emerald-500 animate-pulse' : overallTone === 'bad' ? 'bg-red-500 animate-pulse' : 'bg-amber-500 animate-pulse'}`} />
            Live · {POLL_MS / 1000}s
          </span>
          <span>{lastFetchMs != null ? `${lastFetchMs}ms` : ''}</span>
          <span>{data.generated_at ? ago(data.generated_at) : ''}</span>
          <button type="button" onClick={load} className="btn-secondary text-xs py-1.5 px-2.5">
            Refresh
          </button>
        </div>
      </div>

      {error && (
        <div className="bg-amber-50 border border-amber-200 text-amber-800 px-3 py-2 rounded-lg text-sm">
          Last refresh failed: {error}
        </div>
      )}

      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3">
        <div className="stat-card"><Stat label="Proxies active" value={ov.active} tone="good" /></div>
        <div className="stat-card"><Stat label="Healthy" value={ov.healthy} tone="good" /></div>
        <div className="stat-card"><Stat label="Cooldown" value={ov.in_cooldown} tone={ov.in_cooldown ? 'warn' : undefined} /></div>
        <div className="stat-card"><Stat label="Degraded" value={ov.degraded} tone={ov.degraded ? 'warn' : undefined} /></div>
        <div className="stat-card"><Stat label="Inactive" value={ov.inactive} tone={ov.inactive ? 'bad' : undefined} /></div>
        <div className="stat-card"><Stat label="Error rate" value={`${ov.error_rate ?? 0}%`} tone={(ov.error_rate || 0) > 25 ? 'bad' : undefined} /></div>
      </div>

      <div className="grid lg:grid-cols-2 gap-4">
        <Section
          title="Proxy fleet"
          action={
            <button
              type="button"
              disabled={probing}
              onClick={runProbeBatch}
              className="btn-secondary text-xs py-1 px-2"
            >
              {probing ? 'Probing…' : 'Probe batch'}
            </button>
          }
        >
          <div className="grid grid-cols-2 gap-3 mb-4 text-sm">
            <div>Assigned <span className="font-semibold text-gray-900">{ov.assigned}</span></div>
            <div>Free <span className="font-semibold text-gray-900">{ov.free}</span></div>
            <div>Mapping {mapping.ok ? <span className="badge-success">OK</span> : <span className="badge-warning">Gaps</span>}</div>
            <div>Without proxy <span className="font-semibold">{mapping.accounts_without_proxy ?? 0}</span></div>
          </div>

          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wider text-gray-500 border-b border-gray-100">
                  <th className="py-2 pr-3 font-medium">Provider / zone</th>
                  <th className="py-2 pr-3 font-medium">Active</th>
                  <th className="py-2 pr-3 font-medium">Cool</th>
                  <th className="py-2 pr-3 font-medium">Free</th>
                  <th className="py-2 font-medium">Assigned</th>
                </tr>
              </thead>
              <tbody>
                {(px.by_provider || []).map((row) => (
                  <tr key={`${row.provider}-${row.zone}`} className="border-b border-gray-50">
                    <td className="py-2 pr-3">
                      <div className="font-medium text-gray-900">{row.provider}</div>
                      {row.zone ? <div className="text-xs text-gray-500">{row.zone}</div> : null}
                    </td>
                    <td className="py-2 pr-3">{row.active}/{row.total}</td>
                    <td className="py-2 pr-3">{row.in_cooldown || 0}</td>
                    <td className="py-2 pr-3">{row.free}</td>
                    <td className="py-2">{row.assigned}</td>
                  </tr>
                ))}
                {!px.by_provider?.length && (
                  <tr><td colSpan={5} className="py-3 text-gray-500">No proxies</td></tr>
                )}
              </tbody>
            </table>
          </div>

          <p className="mt-3 text-xs text-gray-500">
            Protection: cooldown after {protection.cooldownAfterProxyPathFails} proxy-path /
            {' '}{protection.cooldownAfterOtherFails} other fails · disable at{' '}
            {protection.disableAfterConsecutiveProxyPath} consecutive proxy-path or{' '}
            {protection.disableAfterConsecutiveAny} any · total ≥ {protection.disableAfterTotalFailures}
          </p>
        </Section>

        <Section title="Unhealthy / cooling">
          <div className="overflow-x-auto max-h-80 overflow-y-auto">
            <table className="min-w-full text-sm">
              <thead className="sticky top-0 bg-white">
                <tr className="text-left text-xs uppercase tracking-wider text-gray-500 border-b border-gray-100">
                  <th className="py-2 pr-2 font-medium">ID</th>
                  <th className="py-2 pr-2 font-medium">Status</th>
                  <th className="py-2 pr-2 font-medium">Fails</th>
                  <th className="py-2 pr-2 font-medium">Account</th>
                  <th className="py-2 font-medium">Last error</th>
                </tr>
              </thead>
              <tbody>
                {(px.unhealthy || []).map((p) => {
                  const cooled = p.cooldown_until && new Date(p.cooldown_until) > new Date();
                  const status = !p.is_active ? 'off' : cooled ? 'cool' : 'degraded';
                  return (
                    <tr key={p.id} className="border-b border-gray-50 align-top">
                      <td className="py-2 pr-2 font-mono text-xs">{p.id}</td>
                      <td className="py-2 pr-2">
                        <span className={
                          status === 'off' ? 'badge-danger' :
                          status === 'cool' ? 'badge-warning' : 'badge-neutral'
                        }>
                          {status}
                        </span>
                        {p.zone ? <div className="text-[11px] text-gray-400 mt-0.5">{p.zone}</div> : null}
                      </td>
                      <td className="py-2 pr-2">
                        {p.consecutive_failures}/{p.failure_count}
                        <div className="text-[11px] text-gray-400">{ago(p.last_failure_at)}</div>
                      </td>
                      <td className="py-2 pr-2 text-xs">
                        {p.account_username
                          ? `${p.account_platform}/${p.account_username}`
                          : '—'}
                      </td>
                      <td className="py-2 text-xs text-gray-600 max-w-[220px] truncate" title={p.last_error || ''}>
                        {p.last_error || '—'}
                      </td>
                    </tr>
                  );
                })}
                {!px.unhealthy?.length && (
                  <tr><td colSpan={5} className="py-3 text-emerald-700">All clear</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </Section>
      </div>

      <div className="grid lg:grid-cols-2 gap-4">
        <Section title="Accounts">
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wider text-gray-500 border-b border-gray-100">
                  <th className="py-2 pr-3 font-medium">Platform</th>
                  <th className="py-2 pr-3 font-medium">Active</th>
                  <th className="py-2 pr-3 font-medium">Banned</th>
                  <th className="py-2 pr-3 font-medium">Error</th>
                  <th className="py-2 pr-3 font-medium">Warm</th>
                  <th className="py-2 font-medium">Proxy</th>
                </tr>
              </thead>
              <tbody>
                {(accounts.by_platform || []).map((row) => (
                  <tr key={row.platform} className="border-b border-gray-50">
                    <td className="py-2 pr-3 font-medium capitalize">{row.platform}</td>
                    <td className="py-2 pr-3">{row.active}</td>
                    <td className="py-2 pr-3">{row.banned}</td>
                    <td className="py-2 pr-3">{row.error}</td>
                    <td className="py-2 pr-3">{row.warming}</td>
                    <td className="py-2">{row.with_proxy}/{row.total}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {(accounts.recent_failures || []).length > 0 && (
            <div className="mt-4 space-y-2">
              <div className="text-xs font-medium text-gray-500 uppercase tracking-wider">Recent job failures</div>
              {(accounts.recent_failures || []).slice(0, 8).map((f, i) => (
                <div key={i} className="text-xs border-l-2 border-amber-300 pl-2 py-1">
                  <span className="font-medium text-gray-800">{f.platform}/{f.username}</span>
                  {' · '}
                  <span className="text-gray-500">{f.source}</span>
                  {f.failure_class ? <span className="badge-warning ml-1">{f.failure_class}</span> : null}
                  <div className="text-gray-600 truncate" title={f.last_error || ''}>{f.last_error || '—'}</div>
                </div>
              ))}
            </div>
          )}
        </Section>

        <Section title="Posting / organic">
          <div className="grid grid-cols-2 gap-3 mb-4">
            <Stat
              label="Organic"
              value={organic.enabled ? 'ON' : 'OFF'}
              tone={organic.enabled ? 'good' : 'warn'}
            />
            <Stat
              label="Quiet hours"
              value={organic.quiet_hours?.active ? 'ACTIVE' : 'open'}
              tone={organic.quiet_hours?.active ? 'warn' : undefined}
            />
            <Stat label="Posted today" value={organic.today?.posted ?? 0} tone="good" />
            <Stat label="Failed today" value={organic.today?.failed ?? 0} tone={organic.today?.failed ? 'bad' : undefined} />
            <Stat label="Jobs enabled" value={organic.jobs?.enabled ?? 0} />
            <Stat label="Due now" value={organic.jobs?.due_now ?? 0} />
          </div>
          <div className="text-sm text-gray-600 space-y-1">
            <div>
              Quiet window: {organic.quiet_hours?.start ?? '—'}–{organic.quiet_hours?.end ?? '—'}
              {' · '}cap {organic.min_per_day ?? '?'}–{organic.max_per_day ?? '?'}/day
            </div>
            <div>
              X follows today: {posting.x_follow?.today?.followed ?? 0} ok /
              {' '}{posting.x_follow?.today?.failed ?? 0} fail
              {' · '}jobs {posting.x_follow?.jobs?.enabled ?? 0} enabled
            </div>
            <div>
              Warm today: {posting.warm?.today?.ok ?? 0} ok /
              {' '}{posting.warm?.today?.failed ?? 0} fail
            </div>
            <div>
              Queue: {queue.started ? 'running' : 'stopped'}
              {queue.error ? ` (${queue.error})` : ''}
            </div>
          </div>
        </Section>
      </div>

      <Section title="Errors (24h)">
        <div className="flex flex-wrap gap-2 mb-4">
          {(errors.last_24h_by_class || []).map((c) => (
            <span key={c.failure_class} className="badge-neutral">
              {c.failure_class}: <strong className="ml-1">{c.count}</strong>
            </span>
          ))}
          {!errors.last_24h_by_class?.length && (
            <span className="text-sm text-emerald-700">No classified failures in the last 24h</span>
          )}
        </div>
        <div className="space-y-2 max-h-72 overflow-y-auto">
          {(errors.samples || []).map((s, i) => (
            <div key={i} className="flex gap-3 text-sm border-b border-gray-50 pb-2">
              <span className="badge-neutral shrink-0">{s.class}</span>
              <span className="text-xs text-gray-400 shrink-0 w-16">{s.source}</span>
              <span className="font-semibold text-gray-800 shrink-0">×{s.count}</span>
              <span className="text-gray-600 truncate flex-1" title={s.message}>{s.message}</span>
              <span className="text-xs text-gray-400 shrink-0">{ago(s.last_seen)}</span>
            </div>
          ))}
        </div>
      </Section>
    </div>
  );
};

export default NocDashboard;
