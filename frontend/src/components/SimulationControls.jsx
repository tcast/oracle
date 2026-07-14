import React, { useState, useEffect } from 'react';
import api from '../utils/api';

const SimulationControls = ({ campaignId, isLive: campaignIsLiveFlag, compact = false, onCampaignChange }) => {
  const [status, setStatus] = useState({ isRunning: false, simulationMode: true, isLive: false });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [stats, setStats] = useState({ posts: 0, comments: 0, engagement: 0 });

  const refresh = async () => {
    try {
      const [{ data: st }, { data: statsData }] = await Promise.all([
        api.get(`/api/campaigns/${campaignId}/simulation/status`),
        api.get(`/api/campaigns/${campaignId}/simulation/stats`),
      ]);
      setStatus(st);
      setStats(statsData);
    } catch (err) {
      if (err.response?.status !== 404) console.error('Status check error:', err.message);
    }
  };

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 5000);
    return () => clearInterval(interval);
  }, [campaignId]);

  const startSimulation = async () => {
    try {
      setBusy(true);
      setError(null);
      setStats({ posts: 0, comments: 0, engagement: 0 });
      await api.post(`/api/campaigns/${campaignId}/simulation/start`);
      await refresh();
      onCampaignChange?.();
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setBusy(false);
    }
  };

  const startLive = async () => {
    try {
      setBusy(true);
      setError(null);
      await api.post(`/api/campaigns/${campaignId}/live/start`);
      await refresh();
      onCampaignChange?.();
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setBusy(false);
    }
  };

  const stop = async () => {
    try {
      setBusy(true);
      setError(null);
      const endpoint = status.isLive || (!status.simulationMode && status.isRunning)
        ? 'live/stop'
        : 'simulation/stop';
      await api.post(`/api/campaigns/${campaignId}/${endpoint}`);
      await refresh();
      onCampaignChange?.();
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setBusy(false);
    }
  };

  const running = status.isRunning;
  const runningLive = running && !status.simulationMode;

  return (
    <div className={compact ? 'card p-5 space-y-4' : 'space-y-6'}>
      <div className="space-y-3">
        <div>
          <h3 className="text-base font-semibold text-gray-900">
            {runningLive ? 'Live campaign running' : running ? 'Simulation running' : 'Launch'}
          </h3>
          <p className="text-sm text-gray-500 mt-0.5">
            Publishes <strong>approved</strong> drafts first (then generates if the queue is empty).
            Comments on recent posts and any pending external Reddit URLs.
          </p>
        </div>
        <div className="flex flex-row flex-wrap items-center gap-2">
          {!running ? (
            <>
              <button
                onClick={startSimulation}
                disabled={busy}
                className="inline-flex items-center justify-center px-4 py-2 rounded-xl text-sm font-semibold text-white bg-emerald-500 hover:bg-emerald-600 disabled:opacity-50 whitespace-nowrap shrink-0"
              >
                Start simulation
              </button>
              <button
                onClick={startLive}
                disabled={busy}
                className="inline-flex items-center justify-center px-4 py-2 rounded-xl text-sm font-semibold text-white bg-red-600 hover:bg-red-700 disabled:opacity-50 whitespace-nowrap shrink-0"
              >
                Go live
              </button>
            </>
          ) : (
            <button
              onClick={stop}
              disabled={busy}
              className="inline-flex items-center justify-center px-4 py-2 rounded-xl text-sm font-semibold text-white bg-gray-800 hover:bg-gray-900 disabled:opacity-50 whitespace-nowrap shrink-0"
            >
              Stop
            </button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-3 gap-3">
        {[
          { label: 'Posts', value: stats.posts },
          { label: 'Comments', value: stats.comments },
          { label: 'Engagement', value: stats.engagement },
        ].map(s => (
          <div key={s.label} className="bg-gray-50 rounded-lg px-3 py-2 text-center border border-gray-100">
            <p className="text-xl font-bold text-gray-900">{s.value}</p>
            <p className="text-[10px] uppercase tracking-wide text-gray-500">{s.label}</p>
          </div>
        ))}
      </div>

      {running && (
        <div className={`flex items-center gap-2 text-sm px-3 py-2 rounded-lg ${
          runningLive ? 'text-red-800 bg-red-50' : 'text-blue-700 bg-blue-50'
        }`}>
          <svg className="animate-spin h-4 w-4" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
          {runningLive ? 'Live posting active — real accounts & proxies required' : 'Simulation active — approved drafts preferred'}
        </div>
      )}

      {campaignIsLiveFlag && !running && (
        <p className="text-xs text-amber-700 bg-amber-50 px-3 py-2 rounded-lg">
          Campaign flagged live. Use Go live to start the live queue (requires real accounts + proxies).
        </p>
      )}

      {error && <p className="text-sm text-red-600 bg-red-50 px-3 py-2 rounded-lg">{error}</p>}
    </div>
  );
};

export default SimulationControls;
