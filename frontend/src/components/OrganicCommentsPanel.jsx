import React, { useEffect, useState } from 'react';
import api from '../utils/api';

const statusClass = (status) => {
  if (status === 'posted') return 'badge-success';
  if (status === 'error') return 'badge-danger';
  if (status === 'simulated') return 'badge-warning';
  return 'badge-neutral';
};

const OrganicCommentsPanel = ({ standalone = false }) => {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [filter, setFilter] = useState('all');

  const load = async () => {
    try {
      setLoading(true);
      const res = await api.get('/api/organic-comments/status');
      setData(res.data);
      setError(null);
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    const t = setInterval(load, 30000);
    return () => clearInterval(t);
  }, []);

  const toggleEnabled = async () => {
    if (!data?.settings) return;
    try {
      setSaving(true);
      const res = await api.patch('/api/organic-comments/settings', {
        enabled: !data.settings.enabled,
      });
      setData({ ...data, settings: res.data });
    } catch (err) {
      alert(err.response?.data?.error || err.message);
    } finally {
      setSaving(false);
    }
  };

  const formatWhen = (value) => {
    if (!value) return '—';
    try {
      return new Date(value).toLocaleString();
    } catch {
      return String(value);
    }
  };

  if (loading && !data) {
    return <div className="text-sm text-gray-500 py-4">Loading organic activity…</div>;
  }

  if (error && !data) {
    return <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-xl text-sm">{error}</div>;
  }

  const settings = data.settings || {};
  const mapping = data.proxy_mapping || {};
  const jobs = data.jobs || [];
  const recent = data.recent || [];
  const filtered = recent.filter((c) => {
    if (filter === 'all') return true;
    return c.status === filter;
  });

  return (
    <div className="space-y-4">
      {standalone && (
        <div className="min-w-0">
          <h1 className="page-title">Organic activity</h1>
          <p className="page-subtitle">
            Live log of karma-building Reddit comments — click through to see each thread
          </p>
        </div>
      )}

      <div className="card p-5">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-gray-900">
              {standalone ? 'Controls' : 'Organic Reddit comments'}
            </h2>
            <p className="text-sm text-gray-500 mt-1">
              {settings.min_per_day}–{settings.max_per_day} comments/day per account · refreshes every 30s
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button type="button" className="btn-secondary" onClick={load} disabled={loading}>
              Refresh
            </button>
            <button
              type="button"
              className={settings.enabled ? 'btn-primary' : 'btn-secondary'}
              onClick={toggleEnabled}
              disabled={saving}
            >
              {settings.enabled ? 'Organic ON' : 'Organic OFF'}
            </button>
          </div>
        </div>

        <div className="mt-4 grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
          <div className="rounded-lg bg-gray-50 px-3 py-2">
            <div className="text-gray-500 text-xs">Posted today</div>
            <div className="font-semibold text-gray-900">{data.posted_today || 0}</div>
          </div>
          <div className="rounded-lg bg-gray-50 px-3 py-2">
            <div className="text-gray-500 text-xs">Logged comments</div>
            <div className="font-semibold text-gray-900">{recent.length}</div>
          </div>
          <div className="rounded-lg bg-gray-50 px-3 py-2">
            <div className="text-gray-500 text-xs">Accounts scheduled</div>
            <div className="font-semibold text-gray-900">{jobs.length}</div>
          </div>
          <div className="rounded-lg bg-gray-50 px-3 py-2">
            <div className="text-gray-500 text-xs">Proxy 1:1</div>
            <div className={`font-semibold ${mapping.ok ? 'text-emerald-700' : 'text-amber-700'}`}>
              {mapping.ok ? 'Healthy' : 'Needs fix'}
            </div>
          </div>
        </div>
      </div>

      <div className="card overflow-hidden">
        <div className="px-5 py-3 border-b border-gray-100 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
          <h2 className="text-sm font-semibold text-gray-900">Comment log</h2>
          <div className="flex gap-1 text-xs">
            {['all', 'posted', 'error', 'simulated'].map((key) => (
              <button
                key={key}
                type="button"
                onClick={() => setFilter(key)}
                className={`px-2.5 py-1 rounded-lg border ${
                  filter === key
                    ? 'border-whisper-300 bg-whisper-50 text-whisper-800'
                    : 'border-gray-200 text-gray-600 hover:bg-gray-50'
                }`}
              >
                {key}
              </button>
            ))}
          </div>
        </div>

        {filtered.length === 0 ? (
          <div className="px-5 py-8 text-sm text-gray-500 text-center">
            No organic comments logged yet. When the scheduler posts, they appear here with Reddit links.
          </div>
        ) : (
          <div className="divide-y divide-gray-50">
            {filtered.map((c) => (
              <div key={c.id} className="px-5 py-4">
                <div className="flex flex-wrap items-center gap-2 text-xs text-gray-500 mb-1.5">
                  <span className="font-semibold text-gray-800">{c.username}</span>
                  <span>r/{c.subreddit}</span>
                  <span className={`badge ${statusClass(c.status)}`}>{c.status}</span>
                  <span>{formatWhen(c.created_at)}</span>
                  {c.ai_likeness != null && <span>ai {Number(c.ai_likeness).toFixed(2)}</span>}
                  {c.spam_score != null && <span>spam {Number(c.spam_score).toFixed(2)}</span>}
                </div>

                {c.post_title && (
                  <div className="text-xs text-gray-500 mb-1 line-clamp-1">
                    Thread: {c.post_title}
                  </div>
                )}

                <div className="text-sm text-gray-900 whitespace-pre-wrap">{c.content}</div>

                {c.error && (
                  <div className="mt-1 text-xs text-red-600">{c.error}</div>
                )}

                <div className="mt-2 flex flex-wrap gap-3">
                  {c.post_url && (
                    <a
                      href={c.post_url}
                      target="_blank"
                      rel="noreferrer"
                      className="text-sm font-medium text-whisper-700 hover:underline"
                    >
                      Open on Reddit →
                    </a>
                  )}
                  {c.post_url && (
                    <button
                      type="button"
                      className="text-xs text-gray-500 hover:text-gray-800"
                      onClick={() => navigator.clipboard?.writeText(c.post_url)}
                    >
                      Copy link
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {jobs.length > 0 && (
        <div className="card overflow-hidden">
          <div className="px-5 py-3 border-b border-gray-100 text-sm font-semibold text-gray-900">
            Per-account schedule
          </div>
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-100 text-sm">
              <thead>
                <tr className="bg-gray-50/50 text-left text-xs font-semibold text-gray-500 uppercase">
                  <th className="px-5 py-2">Account</th>
                  <th className="px-5 py-2">Today</th>
                  <th className="px-5 py-2">Target</th>
                  <th className="px-5 py-2">Next due</th>
                  <th className="px-5 py-2">Status</th>
                  <th className="px-5 py-2">Last error</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {jobs.map((job) => (
                  <tr key={job.id}>
                    <td className="px-5 py-2 text-gray-900">{job.username}</td>
                    <td className="px-5 py-2 text-gray-700">{job.comments_today ?? 0}</td>
                    <td className="px-5 py-2 text-gray-700">{job.daily_target ?? '—'}</td>
                    <td className="px-5 py-2 text-gray-500 whitespace-nowrap">{formatWhen(job.next_due_at)}</td>
                    <td className="px-5 py-2">
                      <span className="badge badge-neutral">{job.enabled === false ? 'paused' : job.status}</span>
                    </td>
                    <td className="px-5 py-2 text-xs text-red-600 max-w-xs truncate" title={job.last_error || ''}>
                      {job.last_error || '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
};

export default OrganicCommentsPanel;
