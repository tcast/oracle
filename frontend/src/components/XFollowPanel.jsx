import React, { useEffect, useState } from 'react';
import api from '../utils/api';

const statusClass = (status) => {
  if (status === 'followed') return 'badge-success';
  if (status === 'already') return 'badge-neutral';
  if (status === 'error') return 'badge-danger';
  return 'badge-neutral';
};

const XFollowPanel = () => {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const load = async () => {
    try {
      setLoading(true);
      const res = await api.get('/api/x-follows/status');
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
      const res = await api.patch('/api/x-follows/settings', {
        enabled: !data.settings.enabled,
        warm: true,
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
    return <div className="text-sm text-gray-500 py-4">Loading X follow campaign…</div>;
  }

  if (error && !data) {
    return (
      <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-xl text-sm">{error}</div>
    );
  }

  const settings = data.settings || {};
  const jobs = data.jobs || [];
  const recent = data.recent || [];
  const cats = data.targets_by_category || [];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">X following campaign</h2>
          <p className="text-sm text-gray-500 mt-1">
            Sports / DFS / celeb follows for army accounts — warm before commenting.
          </p>
        </div>
        <button
          type="button"
          onClick={toggleEnabled}
          disabled={saving}
          className={`px-4 py-2 rounded-lg text-sm font-medium ${
            settings.enabled
              ? 'bg-emerald-600 text-white hover:bg-emerald-700'
              : 'bg-gray-200 text-gray-800 hover:bg-gray-300'
          }`}
        >
          {settings.enabled ? 'Enabled' : 'Disabled'}
        </button>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div className="bg-white border border-gray-200 rounded-xl px-4 py-3">
          <div className="text-xs text-gray-500">Followed today</div>
          <div className="text-2xl font-semibold text-gray-900">{data.followed_today || 0}</div>
        </div>
        <div className="bg-white border border-gray-200 rounded-xl px-4 py-3">
          <div className="text-xs text-gray-500">Per account / day</div>
          <div className="text-2xl font-semibold text-gray-900">
            {settings.min_per_day}–{settings.max_per_day}
          </div>
        </div>
        <div className="bg-white border border-gray-200 rounded-xl px-4 py-3">
          <div className="text-xs text-gray-500">Target pool</div>
          <div className="text-2xl font-semibold text-gray-900">{data.targets_enabled || 0}</div>
        </div>
        <div className="bg-white border border-gray-200 rounded-xl px-4 py-3">
          <div className="text-xs text-gray-500">Jobs</div>
          <div className="text-2xl font-semibold text-gray-900">{jobs.length}</div>
        </div>
      </div>

      {cats.length > 0 && (
        <div className="flex flex-wrap gap-2 text-xs">
          {cats.map((c) => (
            <span key={c.category} className="px-2.5 py-1 rounded-full bg-gray-100 text-gray-700">
              {c.category}: {c.enabled}/{c.n}
            </span>
          ))}
        </div>
      )}

      <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-100 text-sm font-medium text-gray-800">
          Account schedule
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-gray-50 text-gray-500 text-left">
              <tr>
                <th className="px-4 py-2 font-medium">Account</th>
                <th className="px-4 py-2 font-medium">Today</th>
                <th className="px-4 py-2 font-medium">Target</th>
                <th className="px-4 py-2 font-medium">Next due</th>
                <th className="px-4 py-2 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((j) => (
                <tr key={j.id} className="border-t border-gray-100">
                  <td className="px-4 py-2">@{j.username}</td>
                  <td className="px-4 py-2">
                    {j.follows_today}/{j.daily_target || '—'}
                  </td>
                  <td className="px-4 py-2">{j.daily_target || '—'}</td>
                  <td className="px-4 py-2 text-gray-600">{formatWhen(j.next_due_at)}</td>
                  <td className="px-4 py-2">
                    <span className={statusClass(j.status)}>{j.status}</span>
                    {j.last_error && (
                      <div className="text-xs text-red-600 mt-0.5 max-w-xs truncate">{j.last_error}</div>
                    )}
                  </td>
                </tr>
              ))}
              {!jobs.length && (
                <tr>
                  <td colSpan={5} className="px-4 py-6 text-center text-gray-500">
                    No jobs yet — enable the campaign to enroll X accounts.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-100 text-sm font-medium text-gray-800">
          Recent follows
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-gray-50 text-gray-500 text-left">
              <tr>
                <th className="px-4 py-2 font-medium">When</th>
                <th className="px-4 py-2 font-medium">Account</th>
                <th className="px-4 py-2 font-medium">Handle</th>
                <th className="px-4 py-2 font-medium">Category</th>
                <th className="px-4 py-2 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {recent.slice(0, 40).map((f) => (
                <tr key={f.id} className="border-t border-gray-100">
                  <td className="px-4 py-2 text-gray-600">{formatWhen(f.created_at)}</td>
                  <td className="px-4 py-2">@{f.username}</td>
                  <td className="px-4 py-2">
                    <a
                      href={f.profile_url || `https://x.com/${f.handle}`}
                      target="_blank"
                      rel="noreferrer"
                      className="text-whisper-700 hover:underline"
                    >
                      @{f.handle}
                    </a>
                  </td>
                  <td className="px-4 py-2">{f.category || '—'}</td>
                  <td className="px-4 py-2">
                    <span className={statusClass(f.status)}>{f.status}</span>
                  </td>
                </tr>
              ))}
              {!recent.length && (
                <tr>
                  <td colSpan={5} className="px-4 py-6 text-center text-gray-500">
                    No follows logged yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};

export default XFollowPanel;
