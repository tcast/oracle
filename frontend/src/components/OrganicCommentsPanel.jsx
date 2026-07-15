import React, { useEffect, useState } from 'react';
import api from '../utils/api';

const OrganicCommentsPanel = () => {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

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
    const t = setInterval(load, 60000);
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

  const formatNext = (value) => {
    if (!value) return '—';
    try {
      return new Date(value).toLocaleString();
    } catch {
      return String(value);
    }
  };

  if (loading && !data) {
    return <div className="text-sm text-gray-500 py-4">Loading organic commenting…</div>;
  }

  if (error && !data) {
    return <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-xl text-sm">{error}</div>;
  }

  const settings = data.settings || {};
  const mapping = data.proxy_mapping || {};
  const jobs = data.jobs || [];
  const recent = data.recent || [];

  return (
    <div className="space-y-4">
      <div className="card p-5">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-gray-900">Organic Reddit comments</h2>
            <p className="text-sm text-gray-500 mt-1">
              Pure karma-building replies on persona-matched subs · {settings.min_per_day}–{settings.max_per_day} per account / day · no brand mentions
            </p>
          </div>
          <button
            type="button"
            className={settings.enabled ? 'btn-primary' : 'btn-secondary'}
            onClick={toggleEnabled}
            disabled={saving}
          >
            {settings.enabled ? 'Organic ON' : 'Organic OFF'}
          </button>
        </div>

        <div className="mt-4 grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
          <div className="rounded-lg bg-gray-50 px-3 py-2">
            <div className="text-gray-500 text-xs">Posted today</div>
            <div className="font-semibold text-gray-900">{data.posted_today || 0}</div>
          </div>
          <div className="rounded-lg bg-gray-50 px-3 py-2">
            <div className="text-gray-500 text-xs">Tracked jobs</div>
            <div className="font-semibold text-gray-900">{jobs.length}</div>
          </div>
          <div className="rounded-lg bg-gray-50 px-3 py-2">
            <div className="text-gray-500 text-xs">Proxy 1:1</div>
            <div className={`font-semibold ${mapping.ok ? 'text-emerald-700' : 'text-amber-700'}`}>
              {mapping.ok ? 'Healthy' : 'Needs fix'}
            </div>
          </div>
          <div className="rounded-lg bg-gray-50 px-3 py-2">
            <div className="text-gray-500 text-xs">Active proxies</div>
            <div className="font-semibold text-gray-900">
              {mapping.overview?.accounts_with_proxy ?? '—'}/{mapping.overview?.active_proxies ?? '—'}
            </div>
          </div>
        </div>
      </div>

      {jobs.length > 0 && (
        <div className="card overflow-hidden">
          <div className="px-5 py-3 border-b border-gray-100 text-sm font-semibold text-gray-900">
            Per-account cadence
          </div>
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-100 text-sm">
              <thead>
                <tr className="bg-gray-50/50 text-left text-xs font-semibold text-gray-500 uppercase">
                  <th className="px-5 py-2">Account</th>
                  <th className="px-5 py-2">Today</th>
                  <th className="px-5 py-2">Target</th>
                  <th className="px-5 py-2">Next</th>
                  <th className="px-5 py-2">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {jobs.slice(0, 40).map((job) => (
                  <tr key={job.id}>
                    <td className="px-5 py-2 text-gray-900">{job.username}</td>
                    <td className="px-5 py-2 text-gray-700">{job.comments_today ?? 0}</td>
                    <td className="px-5 py-2 text-gray-700">{job.daily_target ?? '—'}</td>
                    <td className="px-5 py-2 text-gray-500">{formatNext(job.next_due_at)}</td>
                    <td className="px-5 py-2">
                      <span className="badge badge-neutral">{job.enabled === false ? 'paused' : job.status}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {recent.length > 0 && (
        <div className="card overflow-hidden">
          <div className="px-5 py-3 border-b border-gray-100 text-sm font-semibold text-gray-900">
            Recent organic comments
          </div>
          <div className="divide-y divide-gray-50">
            {recent.slice(0, 20).map((c) => (
              <div key={c.id} className="px-5 py-3 text-sm">
                <div className="flex flex-wrap items-center gap-2 text-xs text-gray-500 mb-1">
                  <span className="font-medium text-gray-800">{c.username}</span>
                  <span>r/{c.subreddit}</span>
                  <span className="badge badge-neutral">{c.status}</span>
                  {c.ai_likeness != null && <span>ai {Number(c.ai_likeness).toFixed(2)}</span>}
                </div>
                <div className="text-gray-800">{c.content}</div>
                {c.post_url && (
                  <a href={c.post_url} target="_blank" rel="noreferrer" className="text-xs text-whisper-600 hover:underline mt-1 inline-block">
                    Open thread
                  </a>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

export default OrganicCommentsPanel;
