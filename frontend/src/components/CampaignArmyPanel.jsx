import React, { useState, useEffect } from 'react';
import api from '../utils/api';

const CampaignArmyPanel = ({ campaignId }) => {
  const [assigned, setAssigned] = useState([]);
  const [available, setAvailable] = useState([]);
  const [targets, setTargets] = useState([]);
  const [targetUrl, setTargetUrl] = useState('');
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [warmingId, setWarmingId] = useState(null);

  const load = async () => {
    try {
      setError(null);
      const [a, all, t] = await Promise.all([
        api.get(`/api/campaigns/${campaignId}/accounts`),
        api.get('/api/social-accounts?platform=reddit'),
        api.get(`/api/campaigns/${campaignId}/engagement-targets`),
      ]);
      setAssigned(a.data || []);
      const assignedIds = new Set((a.data || []).map(x => x.social_account_id));
      const pool = Array.isArray(all.data) ? all.data : (all.data?.accounts || []);
      setAvailable(pool.filter(acc => !assignedIds.has(acc.id) && !acc.is_simulated));
      setTargets(t.data || []);
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [campaignId]);

  const assign = async (accountId) => {
    try {
      await api.post(`/api/campaigns/${campaignId}/accounts`, { social_account_id: accountId });
      await load();
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    }
  };

  const unassign = async (accountId) => {
    try {
      await api.delete(`/api/campaigns/${campaignId}/accounts/${accountId}`);
      await load();
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    }
  };

  const warmup = async (accountId) => {
    try {
      setWarmingId(accountId);
      setError(null);
      await api.post(`/api/campaigns/${campaignId}/accounts/${accountId}/warmup`);
      await load();
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setWarmingId(null);
    }
  };

  const addTarget = async (e) => {
    e.preventDefault();
    if (!targetUrl.trim()) return;
    try {
      await api.post(`/api/campaigns/${campaignId}/engagement-targets`, { target_url: targetUrl.trim() });
      setTargetUrl('');
      await load();
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    }
  };

  const removeTarget = async (id) => {
    try {
      await api.delete(`/api/campaigns/${campaignId}/engagement-targets/${id}`);
      await load();
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    }
  };

  if (loading) {
    return <div className="card p-5 text-sm text-gray-500">Loading army…</div>;
  }

  return (
    <div className="space-y-4">
      {error && <p className="text-sm text-red-600 bg-red-50 px-3 py-2 rounded-lg">{error}</p>}

      <div className="card p-5 space-y-3">
        <div>
          <h3 className="text-sm font-semibold text-gray-900">Bot accounts</h3>
          <p className="text-xs text-gray-500 mt-0.5">
            Assign real Reddit accounts to this campaign. Live mode requires credentials + proxies.
          </p>
        </div>

        {assigned.length === 0 ? (
          <p className="text-xs text-amber-700 bg-amber-50 px-3 py-2 rounded-lg">
            No accounts assigned — simulation can use any real account (or create sim personas). Live requires assignments.
          </p>
        ) : (
          <div className="space-y-1.5">
            {assigned.map(a => (
              <div key={a.id} className="flex items-center gap-2 text-sm px-2.5 py-2 rounded-lg border border-gray-100 bg-white">
                <span className="font-medium text-gray-900">u/{a.username}</span>
                <span className="text-[10px] text-gray-400">{a.platform}</span>
                {a.has_proxy ? (
                  <span className="text-[10px] text-emerald-700 bg-emerald-50 px-1.5 py-0.5 rounded">proxy</span>
                ) : (
                  <span className="text-[10px] text-amber-700 bg-amber-50 px-1.5 py-0.5 rounded">no proxy</span>
                )}
                <span className="text-[10px] text-gray-500">{a.warmup_status || 'new'}</span>
                <div className="ml-auto flex gap-1">
                  <button
                    onClick={() => warmup(a.social_account_id)}
                    disabled={warmingId === a.social_account_id}
                    className="text-[10px] px-2 py-1 rounded border border-gray-200 hover:bg-gray-50 disabled:opacity-50"
                  >
                    {warmingId === a.social_account_id ? '…' : 'Warm up'}
                  </button>
                  <button onClick={() => unassign(a.social_account_id)} className="text-[10px] text-red-600 px-2 py-1">
                    Remove
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        {available.length > 0 && (
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-wide text-gray-400 mb-1.5">Available</p>
            <div className="flex flex-wrap gap-1.5">
              {available.slice(0, 20).map(acc => (
                <button
                  key={acc.id}
                  onClick={() => assign(acc.id)}
                  className="text-xs px-2.5 py-1 rounded-full border border-gray-200 hover:border-whisper-400 hover:bg-whisper-50"
                >
                  + u/{acc.username}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="card p-5 space-y-3">
        <div>
          <h3 className="text-sm font-semibold text-gray-900">External threads</h3>
          <p className="text-xs text-gray-500 mt-0.5">
            Comment on existing Reddit posts (not just your own). Pending URLs are picked up when the campaign runs.
          </p>
        </div>
        <form onSubmit={addTarget} className="flex gap-2">
          <input
            value={targetUrl}
            onChange={(e) => setTargetUrl(e.target.value)}
            placeholder="https://www.reddit.com/r/.../comments/..."
            className="input-field text-sm flex-1"
          />
          <button type="submit" className="btn-primary text-xs px-3 whitespace-nowrap">Add</button>
        </form>
        {targets.length === 0 ? (
          <p className="text-xs text-gray-400">No external targets yet</p>
        ) : (
          <div className="space-y-1.5">
            {targets.map(t => (
              <div key={t.id} className="flex items-start gap-2 text-xs px-2.5 py-2 rounded-lg border border-gray-100">
                <span className={`flex-shrink-0 px-1.5 py-0.5 rounded ${
                  t.status === 'engaged' ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700'
                }`}>{t.status}</span>
                <a href={t.target_url} target="_blank" rel="noreferrer" className="flex-1 text-whisper-700 hover:underline truncate">
                  {t.target_url}
                </a>
                <button onClick={() => removeTarget(t.id)} className="text-red-500 flex-shrink-0">×</button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

export default CampaignArmyPanel;
