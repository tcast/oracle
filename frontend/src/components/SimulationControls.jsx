import React, { useState, useEffect } from 'react';
import { useAuth } from '../contexts/AuthContext';

const SimulationControls = ({ campaignId, isLive }) => {
  const { accessToken } = useAuth();
  const [isSimulating, setIsSimulating] = useState(false);
  const [error, setError] = useState(null);
  const [stats, setStats] = useState({
    posts: 0,
    comments: 0,
    engagement: 0,
    platform_stats: {}
  });

  useEffect(() => {
    let interval;
    
    const checkStatus = async () => {
      try {
        const response = await fetch(`/api/campaigns/${campaignId}/simulation/status`);
        if (!response.ok) throw new Error('Failed to fetch simulation status');
        const status = await response.json();
        setIsSimulating(status.isRunning);
      } catch (err) {
        // Silently handle status check errors
      }
    };

    // Check initial status and fetch initial stats
    checkStatus();
    fetchSimulationStats();
    
    // Set up intervals
    interval = setInterval(() => {
      checkStatus();
      fetchSimulationStats();
    }, 5000);
    
    return () => {
      if (interval) clearInterval(interval);
    };
  }, [campaignId]);

  const fetchSimulationStats = async () => {
    try {
      const response = await fetch(`/api/campaigns/${campaignId}/simulation/stats`, {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        }
      });
      if (!response.ok) throw new Error('Failed to fetch simulation stats');
      const data = await response.json();
      setStats(data);
    } catch (err) {
      // Don't set error state for stats failures
    }
  };

  const toggleSimulation = async () => {
    try {
      if (isLive) {
        setError('Cannot run simulation on live campaign');
        return;
      }
  
      const endpoint = isSimulating ? 'stop' : 'start';
      const response = await fetch(`/api/campaigns/${campaignId}/simulation/${endpoint}`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        }
      });
  
      if (!response.ok) throw new Error(`Failed to ${endpoint} simulation`);
  
      setIsSimulating(!isSimulating);
      setError(null);
    } catch (err) {
      setError(err.message);
    }
  };

  if (isLive) {
    return (
      <div className="bg-yellow-50 border-l-4 border-yellow-400 p-4">
        <div className="flex">
          <div className="flex-shrink-0">
            <svg className="h-5 w-5 text-yellow-400" viewBox="0 0 20 20" fill="currentColor">
              <path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
            </svg>
          </div>
          <div className="ml-3">
            <p className="text-sm text-yellow-700">
              This campaign is in live mode. Simulation is not available.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-3 gap-4">
        <div className="bg-white overflow-hidden shadow rounded-lg">
          <div className="p-5">
            <div className="flex items-center">
              <div className="flex-shrink-0">
                <svg className="h-6 w-6 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                </svg>
              </div>
              <div className="ml-5 w-0 flex-1">
                <dl>
                  <dt className="text-sm font-medium text-gray-500 truncate">Total Posts</dt>
                  <dd className="text-3xl font-semibold text-gray-900">{stats.posts}</dd>
                </dl>
              </div>
            </div>
          </div>
        </div>

        <div className="bg-white overflow-hidden shadow rounded-lg">
          <div className="p-5">
            <div className="flex items-center">
              <div className="flex-shrink-0">
                <svg className="h-6 w-6 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z" />
                </svg>
              </div>
              <div className="ml-5 w-0 flex-1">
                <dl>
                  <dt className="text-sm font-medium text-gray-500 truncate">Total Comments</dt>
                  <dd className="text-3xl font-semibold text-gray-900">{stats.comments}</dd>
                </dl>
              </div>
            </div>
          </div>
        </div>

        <div className="bg-white overflow-hidden shadow rounded-lg">
          <div className="p-5">
            <div className="flex items-center">
              <div className="flex-shrink-0">
                <svg className="h-6 w-6 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13 10V3L4 14h7v7l9-11h-7z" />
                </svg>
              </div>
              <div className="ml-5 w-0 flex-1">
                <dl>
                  <dt className="text-sm font-medium text-gray-500 truncate">Total Engagement</dt>
                  <dd className="text-3xl font-semibold text-gray-900">{stats.engagement}</dd>
                </dl>
              </div>
            </div>
          </div>
        </div>
      </div>

      {stats.platform_stats && Object.keys(stats.platform_stats).length > 0 && (
        <div className="bg-white shadow rounded-lg p-6">
          <h3 className="text-lg font-medium text-gray-900 mb-4">Platform Breakdown</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {Object.entries(stats.platform_stats).map(([platform, platformStats]) => (
              <div key={platform} className="bg-gray-50 rounded-lg p-4">
                <h4 className="text-base font-medium text-gray-900 capitalize mb-2">{platform}</h4>
                <div className="space-y-2">
                  <div className="flex justify-between">
                    <span className="text-sm text-gray-500">Posts</span>
                    <span className="text-sm font-medium text-gray-900">{platformStats.posts}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-sm text-gray-500">Comments</span>
                    <span className="text-sm font-medium text-gray-900">{platformStats.comments}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-sm text-gray-500">Engagement</span>
                    <span className="text-sm font-medium text-gray-900">{platformStats.engagement}</span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {isSimulating && (
        <div className="bg-blue-50 border-l-4 border-blue-400 p-4">
          <div className="flex">
            <div className="flex-shrink-0">
              <svg className="h-5 w-5 text-blue-400" viewBox="0 0 20 20" fill="currentColor">
                <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm1-12a1 1 0 10-2 0v4a1 1 0 00.293.707l2.828 2.829a1 1 0 101.415-1.415L11 9.586V6z" clipRule="evenodd" />
              </svg>
            </div>
            <div className="ml-3">
              <p className="text-sm text-blue-700">
                Simulation running...
              </p>
            </div>
          </div>
        </div>
      )}

      {error && (
        <div className="bg-red-50 border-l-4 border-red-400 p-4">
          <div className="flex">
            <div className="flex-shrink-0">
              <svg className="h-5 w-5 text-red-400" viewBox="0 0 20 20" fill="currentColor">
                <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clipRule="evenodd" />
              </svg>
            </div>
            <div className="ml-3">
              <p className="text-sm text-red-700">
                {error}
              </p>
            </div>
          </div>
        </div>
      )}

      <div className="flex justify-end">
        <button
          onClick={toggleSimulation}
          className={`px-4 py-2 rounded-md text-sm font-medium text-white ${
            isSimulating
              ? 'bg-red-600 hover:bg-red-700'
              : 'bg-green-600 hover:bg-green-700'
          }`}
        >
          {isSimulating ? 'Stop Simulation' : 'Start Simulation'}
        </button>
      </div>
    </div>
  );
};

export default SimulationControls;