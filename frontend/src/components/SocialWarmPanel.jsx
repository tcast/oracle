import React, { useEffect, useState } from 'react';
import api from '../utils/api';

const SocialWarmPanel = () => {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(null);

  const load = async () => {
    try {
      setLoading(true);
      const res = await api.get('/api/social-warm/status');
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

  const toggle = async (platform) => {
    const current = data?.settings?.[platform];
    if (!current) return;
    try {
      setSaving(platform);
      await api.patch(`/api/social-warm/settings/${platform}`, {
        enabled: !current.enabled,
        warm: true,
      });
      await load();
    } catch (err) {
      alert(err.response?.data?.error || err.message);
    } finally {
      setSaving(null);
    }
  };

  if (loading && !data) {
    return <div className="text-sm text-gray-500 py-4">Loading IG/TikTok warming…</div>;
  }
  if (error && !data) {
    return <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-xl text-sm">{error}</div>;
  }

  const settings = data.settings || {};
  const jobs = data.jobs || [];
  const recent = data.recent || [];
  const today = data.today_by_platform || [];

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-gray-900">IG / TikTok warming</h2>
        <p className="text-sm text-gray-500 mt-1">
          Browse → follow sports/DFS/celeb accounts → light likes. Slow daily cadence.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {['instagram', 'tiktok'].map((platform) => {
          const s = settings[platform] || {};
          const todayN = today.find((t) => t.platform === platform)?.n || 0;
          return (
            <div key={platform} className="bg-white border border-gray-200 rounded-xl p-4 flex items-center justify-between gap-3">
              <div>
                <div className="font-medium text-gray-900 capitalize">{platform}</div>
                <div className="text-xs text-gray-500 mt-1">
                  {s.min_per_day}–{s.max_per_day}/day · today {todayN} · follow {s.do_follow ? 'on' : 'off'} · like{' '}
                  {s.do_like ? 'on' : 'off'}
                </div>
              </div>
              <button
                type="button"
                disabled={saving === platform}
                onClick={() => toggle(platform)}
                className={`px-3 py-1.5 rounded-lg text-sm font-medium ${
                  s.enabled ? 'bg-emerald-600 text-white' : 'bg-gray-200 text-gray-800'
                }`}
              >
                {s.enabled ? 'Enabled' : 'Disabled'}
              </button>
            </div>
          );
        })}
      </div>

      <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-100 text-sm font-medium">Account schedule</div>
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-gray-50 text-gray-500 text-left">
              <tr>
                <th className="px-4 py-2">Platform</th>
                <th className="px-4 py-2">Account</th>
                <th className="px-4 py-2">Warmup</th>
                <th className="px-4 py-2">Today</th>
                <th className="px-4 py-2">Next</th>
                <th className="px-4 py-2">Status</th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((j) => (
                <tr key={j.id} className="border-t border-gray-100">
                  <td className="px-4 py-2 capitalize">{j.platform}</td>
                  <td className="px-4 py-2">@{j.username}</td>
                  <td className="px-4 py-2">{j.warmup_status || '—'}</td>
                  <td className="px-4 py-2">
                    {j.actions_today}/{j.daily_target || '—'}
                  </td>
                  <td className="px-4 py-2 text-gray-600">
                    {j.next_due_at ? new Date(j.next_due_at).toLocaleString() : '—'}
                  </td>
                  <td className="px-4 py-2">
                    {j.status}
                    {j.last_error && (
                      <div className="text-xs text-red-600 truncate max-w-xs">{j.last_error}</div>
                    )}
                  </td>
                </tr>
              ))}
              {!jobs.length && (
                <tr>
                  <td colSpan={6} className="px-4 py-6 text-center text-gray-500">
                    No jobs yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-100 text-sm font-medium">Recent actions</div>
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-gray-50 text-gray-500 text-left">
              <tr>
                <th className="px-4 py-2">When</th>
                <th className="px-4 py-2">Account</th>
                <th className="px-4 py-2">Type</th>
                <th className="px-4 py-2">Handle</th>
                <th className="px-4 py-2">Status</th>
              </tr>
            </thead>
            <tbody>
              {recent.slice(0, 40).map((a) => (
                <tr key={a.id} className="border-t border-gray-100">
                  <td className="px-4 py-2 text-gray-600">
                    {a.created_at ? new Date(a.created_at).toLocaleString() : '—'}
                  </td>
                  <td className="px-4 py-2">
                    @{a.username} <span className="text-gray-400">({a.platform})</span>
                  </td>
                  <td className="px-4 py-2">{a.action_type}</td>
                  <td className="px-4 py-2">{a.handle ? `@${a.handle}` : '—'}</td>
                  <td className="px-4 py-2">{a.status}</td>
                </tr>
              ))}
              {!recent.length && (
                <tr>
                  <td colSpan={5} className="px-4 py-6 text-center text-gray-500">
                    No actions yet.
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

export default SocialWarmPanel;
