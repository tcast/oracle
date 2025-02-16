import React, { useState, useEffect } from 'react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts';
import NetworkSelector from './NetworkSelector';
import SimulationControls from './SimulationControls';
import SubredditManager from './SubredditManager';
import CampaignPosts from './CampaignPosts';
import MediaUploader from './MediaUploader';
import ConfirmationModal from './ConfirmationModal';

const CampaignDashboard = () => {
  const [campaigns, setCampaigns] = useState([]);
  const [selectedCampaign, setSelectedCampaign] = useState(null);
  const [analytics, setAnalytics] = useState([]);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [newCampaign, setNewCampaign] = useState({
    name: '',
    goal: '',
    target_sentiment: 'positive',
    is_live: false,
    networks: [],
    target_url: '',
    media_assets: []
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    fetchCampaigns();
  }, []);

  useEffect(() => {
    if (selectedCampaign) {
      fetchAnalytics(selectedCampaign.id);
      const interval = setInterval(() => {
        fetchAnalytics(selectedCampaign.id);
      }, 5000); // Update every 5 seconds
      return () => clearInterval(interval);
    }
  }, [selectedCampaign]);

  const fetchAnalytics = async (campaignId) => {
    try {
      const response = await fetch(`/api/campaigns/${campaignId}/analytics`);
      if (!response.ok) throw new Error('Failed to fetch analytics');
      const data = await response.json();
      setAnalytics(data);
    } catch (err) {
      console.error('Error fetching analytics:', err);
    }
  };

  const fetchCampaigns = async () => {
    try {
      setLoading(true);
      const response = await fetch('/api/campaigns');
      if (!response.ok) throw new Error('Failed to fetch campaigns');
      const data = await response.json();
      setCampaigns(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleCreateCampaign = async (e) => {
    e.preventDefault();
    try {
      setLoading(true);
      const response = await fetch('/api/campaigns', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(newCampaign),
      });
      
      if (!response.ok) throw new Error('Failed to create campaign');
      
      const campaign = await response.json();
      await fetchCampaigns();
      setSelectedCampaign(campaign);
      setNewCampaign({
        name: '',
        goal: '',
        target_sentiment: 'positive',
        is_live: false,
        networks: [],
        target_url: '',
        media_assets: []
      });
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleDeleteCampaign = async () => {
    try {
      setLoading(true);
      const response = await fetch(`/api/campaigns/${selectedCampaign.id}`, {
        method: 'DELETE'
      });
      if (!response.ok) throw new Error('Failed to delete campaign');
      await fetchCampaigns();
      setSelectedCampaign(null);
      setShowDeleteModal(false);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-6">
      {error && (
        <div className="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded relative">
          <span className="block sm:inline">{error}</span>
        </div>
      )}

      {/* Create Campaign Form */}
      <div className="bg-white shadow rounded-lg p-6">
        <h2 className="text-xl font-semibold mb-4">Create New Campaign</h2>
        <form onSubmit={handleCreateCampaign} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700">Campaign Name</label>
            <input
              type="text"
              className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500"
              value={newCampaign.name}
              onChange={(e) => setNewCampaign({...newCampaign, name: e.target.value})}
              required
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700">Campaign Goal</label>
            <textarea
              className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500"
              value={newCampaign.goal}
              onChange={(e) => setNewCampaign({...newCampaign, goal: e.target.value})}
              required
              rows={3}
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700">Target Sentiment</label>
            <select
              className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500"
              value={newCampaign.target_sentiment}
              onChange={(e) => setNewCampaign({...newCampaign, target_sentiment: e.target.value})}
            >
              <option value="positive">Positive</option>
              <option value="neutral">Neutral</option>
              <option value="negative">Negative</option>
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700">Target URL (Optional)</label>
            <div className="mt-1 flex rounded-md shadow-sm">
              <span className="inline-flex items-center px-3 rounded-l-md border border-r-0 border-gray-300 bg-gray-50 text-gray-500 sm:text-sm">
                https://
              </span>
              <input
                type="text"
                className="flex-1 min-w-0 block w-full px-3 py-2 rounded-none rounded-r-md border-gray-300 focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
                placeholder="example.com/your-link"
                value={newCampaign.target_url}
                onChange={(e) => setNewCampaign({...newCampaign, target_url: e.target.value})}
              />
            </div>
            <p className="mt-1 text-sm text-gray-500">
              Add a URL that you want to direct users to (e.g., book purchase page, website)
            </p>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700">Media Assets (Optional)</label>
            <MediaUploader
              onMediaUpload={(url, type) => {
                setNewCampaign(prev => ({
                  ...prev,
                  media_assets: [...prev.media_assets, { url, type }]
                }));
              }}
              onMediaRemove={(index) => {
                setNewCampaign(prev => ({
                  ...prev,
                  media_assets: prev.media_assets.filter((_, i) => i !== index)
                }));
              }}
              mediaList={newCampaign.media_assets}
            />
            <p className="mt-1 text-sm text-gray-500">
              Add images that can be used in posts (particularly effective for LinkedIn)
            </p>
          </div>

          <NetworkSelector
            onNetworksChange={(networks) => setNewCampaign({...newCampaign, networks})}
            campaign={newCampaign}
          />

          <div className="flex items-center">
            <input
              type="checkbox"
              id="is_live"
              className="h-4 w-4 text-indigo-600 focus:ring-indigo-500 border-gray-300 rounded"
              checked={newCampaign.is_live}
              onChange={(e) => setNewCampaign({...newCampaign, is_live: e.target.checked})}
            />
            <label htmlFor="is_live" className="ml-2 block text-sm text-gray-900">
              Live Mode
            </label>
            {newCampaign.is_live && (
              <span className="ml-2 inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-800">
                Will post to actual social platforms
              </span>
            )}
          </div>

          <button
            type="submit"
            disabled={loading}
            className="w-full flex justify-center py-2 px-4 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500 disabled:bg-gray-400"
          >
            {loading ? 'Creating...' : 'Create Campaign'}
          </button>
        </form>
      </div>

      {/* Campaign List */}
      <div className="bg-white shadow rounded-lg p-6">
        <h2 className="text-xl font-semibold mb-4">Active Campaigns</h2>
        {loading ? (
          <div className="text-center">Loading campaigns...</div>
        ) : (
          <div className="space-y-4">
            {campaigns.length === 0 ? (
              <div className="text-center text-gray-500">No active campaigns</div>
            ) : (
              campaigns.map((campaign) => (
                <div
                  key={campaign.id}
                  className={`border rounded-lg p-4 hover:bg-gray-50 cursor-pointer ${
                    selectedCampaign?.id === campaign.id ? 'border-indigo-500 bg-indigo-50' : ''
                  }`}
                  onClick={() => setSelectedCampaign(campaign)}
                >
                  <h3 className="font-semibold">{campaign.name}</h3>
                  <p className="text-sm text-gray-600 mt-1">{campaign.goal}</p>
                  <div className="mt-2 flex justify-between text-sm text-gray-500">
                    <span>Sentiment: {campaign.target_sentiment}</span>
                    <span>Created: {new Date(campaign.created_at).toLocaleDateString()}</span>
                  </div>
                </div>
              ))
            )}
          </div>
        )}
      </div>

      {selectedCampaign && (
        <div className="space-y-6">
          <div className="bg-white shadow rounded-lg p-6">
            <div className="flex justify-between items-center mb-4">
              <h2 className="text-xl font-semibold">Campaign Details: {selectedCampaign.name}</h2>
              <button
                onClick={() => setShowDeleteModal(true)}
                className="px-4 py-2 text-sm font-medium text-white bg-red-600 rounded-md hover:bg-red-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-red-500"
              >
                Delete Campaign
              </button>
            </div>

            <div className="mb-8">
              <SubredditManager campaignId={selectedCampaign.id} />
            </div>

            <div className="mb-8">
              <SimulationControls 
                campaignId={selectedCampaign.id} 
                isLive={selectedCampaign.is_live} 
              />
            </div>

            <div className="mt-6 mb-8">
              <h3 className="text-lg font-medium mb-4">Activity Overview</h3>
              <div className="h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={analytics}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis 
                      dataKey="date" 
                      tickFormatter={(timestamp) => new Date(timestamp).toLocaleDateString()} 
                    />
                    <YAxis />
                    <Tooltip 
                      labelFormatter={(timestamp) => new Date(timestamp).toLocaleDateString()}
                    />
                    <Legend />
                    <Line type="monotone" dataKey="posts" stroke="#8884d8" name="Posts" />
                    <Line type="monotone" dataKey="comments" stroke="#82ca9d" name="Comments" />
                    <Line type="monotone" dataKey="engagement" stroke="#ffc658" name="Engagement" />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>
          </div>
          
          <div className="bg-white shadow rounded-lg p-6">
            <h2 className="text-xl font-semibold mb-4">Campaign Posts</h2>
            <CampaignPosts campaignId={selectedCampaign.id} />
          </div>
        </div>
      )}

      <ConfirmationModal
        isOpen={showDeleteModal}
        onClose={() => setShowDeleteModal(false)}
        onConfirm={handleDeleteCampaign}
        title="Delete Campaign"
        message="Are you sure you want to delete this campaign? This action cannot be undone and will remove all associated posts, comments, and data."
      />
    </div>
  );
};

export default CampaignDashboard;