import React, { useCallback, useEffect, useState } from 'react';
import api from '../utils/api';

const PLATFORMS = [
  { id: 'all', label: 'All' },
  { id: 'x', label: 'X' },
  { id: 'reddit', label: 'Reddit' },
  { id: 'linkedin', label: 'LinkedIn' },
  { id: 'instagram', label: 'Instagram' },
  { id: 'tiktok', label: 'TikTok' },
];

const PLATFORM_BADGE = {
  x: 'bg-gray-900 text-white',
  reddit: 'bg-orange-500 text-white',
  linkedin: 'bg-sky-700 text-white',
  instagram: 'bg-pink-600 text-white',
  tiktok: 'bg-neutral-800 text-white',
};

const RESULT_BADGE = {
  success: 'badge-success',
  fail: 'badge-danger',
  soft_skip: 'badge-warning',
  simulated: 'badge-neutral',
};

const ACTION_LABELS = {
  commented: 'commented',
  followed: 'followed',
  posted: 'posted',
  profile_updated: 'profile updated',
  accept_follows: 'accept follows',
  discover_targets: 'discover targets',
  soft_skip: 'soft skip',
  session_dead: 'session dead',
  login_failed: 'login failed',
  id_verification: 'ID verification',
  checkpoint: 'checkpoint',
  banned: 'banned',
  organic_enabled: 'organic enabled',
  session_restored: 'session restored',
  logged_in: 'logged in',
};

const formatWhen = (value) => {
  if (!value) return '—';
  try {
    return new Date(value).toLocaleString();
  } catch {
    return String(value);
  }
};

const platformLabel = (p) => {
  if (p === 'x' || p === 'twitter') return 'X';
  if (!p) return '?';
  return p.charAt(0).toUpperCase() + p.slice(1);
};

const linkLabel = (platform, link) => {
  if (!link) return null;
  const p = String(platform || '').toLowerCase();
  if (p === 'x' || p === 'twitter') return 'Open on X →';
  if (p === 'reddit') return 'Open on Reddit →';
  if (p === 'linkedin') return 'Open on LinkedIn →';
  if (p === 'instagram') return 'Open on Instagram →';
  if (p === 'tiktok') return 'Open on TikTok →';
  return 'Open link →';
};

const ActivityLogPanel = () => {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [platform, setPlatform] = useState('all');
  const [action, setAction] = useState('all');
  const [result, setResult] = useState('all');

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const params = new URLSearchParams({ limit: '150' });
      if (platform && platform !== 'all') params.set('platform', platform);
      if (action && action !== 'all') params.set('action', action);
      if (result && result !== 'all') params.set('result', result);
      const res = await api.get(`/api/activity?${params}`);
      setData(res.data);
      setError(null);
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setLoading(false);
    }
  }, [platform, action, result]);

  useEffect(() => {
    load();
    const t = setInterval(load, 30000);
    return () => clearInterval(t);
  }, [load]);

  const events = data?.events || [];
  const actionOptions = [
    { id: 'all', label: 'All actions' },
    ...(data?.actions || []).map((a) => ({
      id: a.action,
      label: `${ACTION_LABELS[a.action] || a.action} (${a.n})`,
    })),
  ];

  return (
    <div className="space-y-4">
      <div className="card p-4 sm:p-5">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-gray-900">Activity log</h2>
            <p className="text-sm text-gray-500 mt-1">
              All platforms — comments, follows, profile, session events. Refreshes every 30s.
            </p>
          </div>
          <button type="button" className="btn-secondary" onClick={load} disabled={loading}>
            Refresh
          </button>
        </div>

        <div className="mt-4 flex flex-wrap gap-1.5">
          {PLATFORMS.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => setPlatform(p.id)}
              className={`px-2.5 py-1 rounded-lg border text-xs font-medium ${
                platform === p.id
                  ? 'border-whisper-300 bg-whisper-50 text-whisper-800'
                  : 'border-gray-200 text-gray-600 hover:bg-gray-50'
              }`}
            >
              {p.label}
              {p.id !== 'all' && data?.platforms
                ? ` (${data.platforms.find((x) => x.platform === p.id)?.n || 0})`
                : ''}
            </button>
          ))}
        </div>

        <div className="mt-3 flex flex-wrap gap-2">
          <select
            className="input-field text-sm max-w-xs"
            value={action}
            onChange={(e) => setAction(e.target.value)}
          >
            {actionOptions.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </select>
          <div className="flex gap-1 text-xs">
            {['all', 'success', 'fail', 'soft_skip'].map((key) => (
              <button
                key={key}
                type="button"
                onClick={() => setResult(key)}
                className={`px-2.5 py-1 rounded-lg border ${
                  result === key
                    ? 'border-whisper-300 bg-whisper-50 text-whisper-800'
                    : 'border-gray-200 text-gray-600 hover:bg-gray-50'
                }`}
              >
                {key}
              </button>
            ))}
          </div>
        </div>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-xl text-sm">
          {error}
        </div>
      )}

      <div className="card overflow-hidden">
        <div className="px-5 py-3 border-b border-gray-100 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-gray-900">
            {loading && !data ? 'Loading…' : `${data?.total ?? 0} event${(data?.total ?? 0) !== 1 ? 's' : ''}`}
          </h2>
        </div>

        {events.length === 0 ? (
          <div className="px-5 py-8 text-sm text-gray-500 text-center">
            {loading ? 'Loading activity…' : 'No activity yet. New comments, follows, and brain actions will appear here.'}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-100 text-sm">
              <thead>
                <tr className="bg-gray-50/50 text-left text-xs font-semibold text-gray-500 uppercase">
                  <th className="px-4 py-2 whitespace-nowrap">Time</th>
                  <th className="px-4 py-2">Platform</th>
                  <th className="px-4 py-2">Action</th>
                  <th className="px-4 py-2">Account</th>
                  <th className="px-4 py-2">Result</th>
                  <th className="px-4 py-2">Detail</th>
                  <th className="px-4 py-2">Link</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {events.map((e) => (
                  <tr key={e.id} className="hover:bg-gray-50/50">
                    <td className="px-4 py-2.5 text-gray-500 whitespace-nowrap text-xs">
                      {formatWhen(e.occurred_at)}
                    </td>
                    <td className="px-4 py-2.5">
                      <span
                        className={`inline-flex px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide ${
                          PLATFORM_BADGE[e.platform] || 'bg-gray-200 text-gray-700'
                        }`}
                      >
                        {platformLabel(e.platform)}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-gray-900 font-medium">
                      {ACTION_LABELS[e.action] || e.action}
                    </td>
                    <td className="px-4 py-2.5 text-gray-800">
                      {e.username ? `@${e.username.replace(/^@/, '')}` : e.account_id ? `#${e.account_id}` : '—'}
                    </td>
                    <td className="px-4 py-2.5">
                      <span className={`badge ${RESULT_BADGE[e.result] || 'badge-neutral'}`}>
                        {e.result}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-xs text-gray-500 max-w-xs truncate" title={e.detail || ''}>
                      {e.detail || '—'}
                    </td>
                    <td className="px-4 py-2.5 whitespace-nowrap">
                      {e.link ? (
                        <a
                          href={e.link}
                          target="_blank"
                          rel="noreferrer"
                          className="text-sm font-medium text-whisper-700 hover:underline"
                        >
                          {linkLabel(e.platform, e.link)}
                        </a>
                      ) : (
                        <span className="text-gray-400">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
};

export default ActivityLogPanel;
