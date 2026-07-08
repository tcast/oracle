import React, { useState, useEffect } from 'react';
import api from '../utils/api';

const StatBox = ({ label, value, icon }) => (
  <div className="stat-card">
    <div className="flex items-center justify-between">
      <span className="stat-label">{label}</span>
      <svg className="w-5 h-5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d={icon} />
      </svg>
    </div>
    <p className="stat-value">{value}</p>
  </div>
);

const SimulationControls = ({ campaignId, isLive }) => {
  const [isSimulating, setIsSimulating] = useState(false);
  const [error, setError] = useState(null);
  const [stats, setStats] = useState({ posts: 0, comments: 0, engagement: 0, platform_stats: {} });

  useEffect(() => {
    let interval;
    const checkStatus = async () => {
      try {
        const { data } = await api.get(`/api/campaigns/${campaignId}/simulation/status`);
        setIsSimulating(data.isRunning);
      } catch (err) {
        if (err.response?.status !== 404) console.error('Status check error:', err.message);
      }
    };
    checkStatus();
    fetchSimulationStats();
    interval = setInterval(() => {
      checkStatus();
      fetchSimulationStats();
    }, 5000);
    return () => { if (interval) clearInterval(interval); };
  }, [campaignId]);

  const fetchSimulationStats = async () => {
    try {
      const { data } = await api.get(`/api/campaigns/${campaignId}/simulation/stats`);
      setStats(data);
    } catch (err) {
      if (err.response?.status !== 404) console.error('Stats fetch error:', err.message);
    }
  };

  const toggleSimulation = async () => {
    try {
      if (isLive) { setError('Cannot run simulation on live campaign'); return; }
      const endpoint = isSimulating ? 'stop' : 'start';
      await api.post(`/api/campaigns/${campaignId}/simulation/${endpoint}`);
      setIsSimulating(!isSimulating);
      setError(null);
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    }
  };

  if (isLive) {
    return (
      <div className="bg-amber-50 border border-amber-200 rounded-xl px-5 py-4">
        <div className="flex items-center space-x-3">
          <div className="w-8 h-8 bg-amber-100 rounded-lg flex items-center justify-center flex-shrink-0">
            <svg className="w-4 h-4 text-amber-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
          </div>
          <p className="text-sm text-amber-800">This campaign is in live mode. Simulation is not available.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 sm:gap-4">
        <StatBox label="Total Posts" value={stats.posts} icon="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
        <StatBox label="Total Comments" value={stats.comments} icon="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z" />
        <StatBox label="Total Engagement" value={stats.engagement} icon="M13 10V3L4 14h7v7l9-11h-7z" />
      </div>

      {stats.platform_stats && Object.keys(stats.platform_stats).length > 0 && (
        <div className="bg-gray-50/50 rounded-xl border border-gray-100 p-5">
          <h3 className="text-sm font-semibold text-gray-900 mb-3">Platform Breakdown</h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {Object.entries(stats.platform_stats).map(([platform, ps]) => (
              <div key={platform} className="bg-white rounded-lg border border-gray-100 p-4">
                <h4 className="text-sm font-semibold text-gray-900 capitalize mb-3">{platform}</h4>
                <div className="space-y-2 text-sm">
                  <div className="flex justify-between"><span className="text-gray-500">Posts</span><span className="font-medium">{ps.posts}</span></div>
                  <div className="flex justify-between"><span className="text-gray-500">Comments</span><span className="font-medium">{ps.comments}</span></div>
                  <div className="flex justify-between"><span className="text-gray-500">Engagement</span><span className="font-medium">{ps.engagement}</span></div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {isSimulating && (
        <div className="bg-blue-50 border border-blue-200 rounded-xl px-5 py-4 animate-fade-in">
          <div className="flex items-center space-x-3">
            <svg className="animate-spin h-4 w-4 text-blue-500" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
            </svg>
            <p className="text-sm text-blue-700">Simulation running...</p>
          </div>
        </div>
      )}

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-xl px-5 py-4 animate-fade-in">
          <div className="flex items-center space-x-3">
            <div className="w-6 h-6 bg-red-100 rounded-lg flex items-center justify-center flex-shrink-0">
              <svg className="w-3.5 h-3.5 text-red-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </div>
            <p className="text-sm text-red-700">{error}</p>
          </div>
        </div>
      )}

      <div className="flex justify-end">
        <button
          onClick={toggleSimulation}
          className={`px-5 py-2 rounded-xl text-sm font-medium text-white transition-all shadow-sm ${
            isSimulating
              ? 'bg-red-500 hover:bg-red-600 shadow-red-500/20'
              : 'bg-emerald-500 hover:bg-emerald-600 shadow-emerald-500/20'
          }`}
        >
          {isSimulating ? 'Stop Simulation' : 'Start Simulation'}
        </button>
      </div>
    </div>
  );
};

export default SimulationControls;
