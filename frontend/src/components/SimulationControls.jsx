import React, { useState, useEffect } from 'react';
import { useAuth } from '../contexts/AuthContext';

const SimulationControls = ({ campaignId, isLive }) => {
  const { accessToken } = useAuth();  // Add this line here
  const [isSimulating, setIsSimulating] = useState(false);
  const [error, setError] = useState(null);
  const [stats, setStats] = useState({
    posts: 0,
    comments: 0,
    engagement: 0
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
        console.error('Error checking simulation status:', err);
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
      console.log('Fetching stats for campaign:', campaignId);
      const response = await fetch(`/api/campaigns/${campaignId}/simulation/stats`, {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        }
      });
      if (!response.ok) throw new Error('Failed to fetch simulation stats');
      const data = await response.json();
      console.log('Received stats:', data);
      setStats(data);
    } catch (err) {
      console.error('Error fetching simulation stats:', err);
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
    <div className="space-y-4">
      <div className="flex justify-between items-center">
        <h3 className="text-lg font-medium">Simulation Controls</h3>
        <button
          onClick={toggleSimulation}
          className={`px-4 py-2 rounded text-white ${
            isSimulating 
              ? 'bg-red-500 hover:bg-red-600' 
              : 'bg-green-500 hover:bg-green-600'
          }`}
        >
          {isSimulating ? 'Stop Simulation' : 'Start Simulation'}
        </button>
      </div>

      {error && (
        <div className="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded">
          {error}
        </div>
      )}

      <div className="mt-4 space-y-4">
        <div className="grid grid-cols-3 gap-4">
          <div className="bg-gray-50 p-3 rounded">
            <div className="text-sm text-gray-500">Posts</div>
            <div className="text-xl font-semibold">{stats.posts}</div>
          </div>
          <div className="bg-gray-50 p-3 rounded">
            <div className="text-sm text-gray-500">Comments</div>
            <div className="text-xl font-semibold">{stats.comments}</div>
          </div>
          <div className="bg-gray-50 p-3 rounded">
            <div className="text-sm text-gray-500">Engagement</div>
            <div className="text-xl font-semibold">{stats.engagement}</div>
          </div>
        </div>

        {isSimulating && (
          <div className="flex items-center justify-between">
            <div className="flex items-center">
              <div className="animate-pulse mr-2 h-3 w-3 bg-green-500 rounded-full"></div>
              <p className="text-sm text-gray-600">Simulation running...</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default SimulationControls;