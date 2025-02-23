import React, { useState, useEffect } from 'react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts';
import NetworkSelector from './NetworkSelector';
import SimulationControls from './SimulationControls';
import SubredditManager from './SubredditManager';
import CampaignPosts from './CampaignPosts';
import ImageUploader from './ImageUploader';
import VideoUploader from './VideoUploader';
import ConfirmationModal from './ConfirmationModal';

const CampaignDashboard = () => {
  const [campaigns, setCampaigns] = useState([]);
  const [selectedCampaign, setSelectedCampaign] = useState(null);
  const [analytics, setAnalytics] = useState([]);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [editingCampaign, setEditingCampaign] = useState(null);
  const [newCampaign, setNewCampaign] = useState({
    name: '',
    campaign_overview: '',
    campaign_goal: '',
    post_goal: '',
    comment_goal: '',
    target_sentiment: 'positive',
    is_live: false,
    platform: [],
    target_url: '',
    media_assets: [],
    start_date: '',
    end_date: '',
    posts_per_subreddit: 1,
    posts_per_linkedin: 1,
    posts_per_x: 1,
    posts_per_tiktok: 1,
    total_x_posts: 5,
    total_tiktok_posts: 5,
    min_post_interval_hours: 1,
    max_post_interval_hours: 24,
    min_reply_interval_hours: 0.5,
    max_reply_interval_hours: 12
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
      const response = await fetch(`/api/campaigns/${campaignId}/analytics`, {
        headers: {
          'Accept': 'application/json',
          'Cache-Control': 'no-cache'
        },
      });

      if (!response.ok) {
        // Check if response is HTML
        const contentType = response.headers.get('content-type');
        if (contentType && contentType.includes('text/html')) {
          console.warn('Received HTML instead of JSON - session may have expired');
          return; // Silently fail for analytics
        }
        throw new Error(`Failed to fetch analytics: ${response.status} ${response.statusText}`);
      }

      // Verify we have JSON content
      const contentType = response.headers.get('content-type');
      if (!contentType || !contentType.includes('application/json')) {
        console.warn(`Expected JSON but received ${contentType}`);
        return; // Silently fail for analytics
      }

      const data = await response.json();
      setAnalytics(data);
    } catch (err) {
      console.error('Error fetching analytics:', err);
      // Don't set error state for analytics failures since they're not critical
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
        campaign_overview: '',
        campaign_goal: '',
        post_goal: '',
        comment_goal: '',
        target_sentiment: 'positive',
        is_live: false,
        platform: [],
        target_url: '',
        media_assets: [],
        start_date: '',
        end_date: '',
        posts_per_subreddit: 1,
        posts_per_linkedin: 1,
        posts_per_x: 1,
        posts_per_tiktok: 1,
        total_x_posts: 5,
        total_tiktok_posts: 5,
        min_post_interval_hours: 1,
        max_post_interval_hours: 24,
        min_reply_interval_hours: 0.5,
        max_reply_interval_hours: 12
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

  const handleEditCampaign = async (e) => {
    e.preventDefault();
    try {
      setLoading(true);
      const response = await fetch(`/api/campaigns/${editingCampaign.id}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(editingCampaign),
      });
      
      if (!response.ok) throw new Error('Failed to update campaign');
      
      const updatedCampaign = await response.json();
      await fetchCampaigns();
      setSelectedCampaign(updatedCampaign);
      setIsEditing(false);
      setEditingCampaign(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const startEditing = () => {
    setEditingCampaign({
      ...selectedCampaign,
      platform: selectedCampaign.platform || [],
      media_assets: selectedCampaign.media_assets || [],
      posts_per_subreddit: selectedCampaign.posts_per_subreddit || 1,
      posts_per_linkedin: selectedCampaign.posts_per_linkedin || 1,
      posts_per_x: selectedCampaign.posts_per_x || 1,
      posts_per_tiktok: selectedCampaign.posts_per_tiktok || 1,
      total_x_posts: selectedCampaign.total_x_posts || 5,
      total_tiktok_posts: selectedCampaign.total_tiktok_posts || 5,
      min_post_interval_hours: selectedCampaign.min_post_interval_hours || 1,
      max_post_interval_hours: selectedCampaign.max_post_interval_hours || 24,
      min_reply_interval_hours: selectedCampaign.min_reply_interval_hours || 0.5,
      max_reply_interval_hours: selectedCampaign.max_reply_interval_hours || 12
    });
    setIsEditing(true);
  };

  return (
    <div className="space-y-6">
      {error && (
        <div className="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded relative">
          <span className="block sm:inline">{error}</span>
        </div>
      )}

      {/* Create Campaign Button */}
      <div className="flex justify-end">
        <button
          onClick={() => setShowCreateForm(!showCreateForm)}
          className="bg-indigo-600 text-white px-4 py-2 rounded-md hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2"
        >
          {showCreateForm ? 'Cancel' : 'Create New Campaign'}
        </button>
      </div>

      {/* Create Campaign Form */}
      {showCreateForm && (
        <div className="bg-white shadow rounded-lg p-6 mt-4">
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
              <label className="block text-sm font-medium text-gray-700">Campaign Overview</label>
              <textarea
                className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500"
                value={newCampaign.campaign_overview}
                onChange={(e) => setNewCampaign({...newCampaign, campaign_overview: e.target.value})}
                required
                rows={4}
                placeholder="Describe what you are promoting (theory, product, news, etc.) in detail"
              />
            </div>

            <div className="space-y-4 bg-gray-50 p-4 rounded-lg">
              <h3 className="text-lg font-medium text-gray-900">Campaign Strategy</h3>
              
              <div>
                <label className="block text-sm font-medium text-gray-700">Campaign Goal</label>
                <textarea
                  className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500"
                  value={newCampaign.campaign_goal}
                  onChange={(e) => setNewCampaign({...newCampaign, campaign_goal: e.target.value})}
                  required
                  rows={3}
                  placeholder="What are the strategic objectives for this campaign? (e.g., drive mass adoption, increase awareness)"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700">Post Goal</label>
                <textarea
                  className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500"
                  value={newCampaign.post_goal}
                  onChange={(e) => setNewCampaign({...newCampaign, post_goal: e.target.value})}
                  required
                  rows={3}
                  placeholder="What should each post aim to achieve? (e.g., drive engagement, spark speculation)"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700">Comment Goal</label>
                <textarea
                  className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500"
                  value={newCampaign.comment_goal}
                  onChange={(e) => setNewCampaign({...newCampaign, comment_goal: e.target.value})}
                  required
                  rows={3}
                  placeholder="How should comments support the campaign? (e.g., provide validation, create social proof)"
                />
              </div>
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
              <label className="block text-sm font-medium text-gray-700">Media Assets</label>
              {newCampaign.platform.includes('tiktok') && (
                <div className="mb-4">
                  <VideoUploader
                    onMediaUpload={(url, type, duration) => {
                      setNewCampaign(prev => ({
                        ...prev,
                        media_assets: [...prev.media_assets, { url, type, duration }]
                      }));
                    }}
                    onMediaRemove={(index) => {
                      setNewCampaign(prev => ({
                        ...prev,
                        media_assets: prev.media_assets.filter((_, i) => i !== index)
                      }));
                    }}
                    mediaList={newCampaign.media_assets.filter(asset => 
                      asset.type.startsWith('video/')
                    )}
                    platform="tiktok"
                  />
                </div>
              )}
              {(newCampaign.platform.includes('linkedin') || newCampaign.platform.includes('x')) && (
                <div>
                  <ImageUploader
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
                    mediaList={newCampaign.media_assets.filter(asset => 
                      asset.type.startsWith('image/')
                    )}
                    platform={newCampaign.platform.includes('linkedin') ? 'linkedin' : 'x'}
                  />
                </div>
              )}
              <p className="mt-1 text-sm text-gray-500">
                Add media assets for your posts. Images for LinkedIn/X, videos for TikTok.
              </p>
            </div>

            <NetworkSelector
              onNetworksChange={(networks) => setNewCampaign({...newCampaign, platform: networks})}
              campaign={newCampaign}
            />

            {/* Campaign Schedule */}
            <div className="space-y-4">
              <h3 className="text-lg font-medium">Campaign Schedule</h3>
              
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700">Posts per Subreddit</label>
                  <input
                    type="number"
                    min="1"
                    className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500"
                    value={newCampaign.posts_per_subreddit}
                    onChange={(e) => setNewCampaign({...newCampaign, posts_per_subreddit: parseInt(e.target.value)})}
                  />
                </div>
                
                <div>
                  <label className="block text-sm font-medium text-gray-700">Posts per LinkedIn</label>
                  <input
                    type="number"
                    min="1"
                    className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500"
                    value={newCampaign.posts_per_linkedin}
                    onChange={(e) => setNewCampaign({...newCampaign, posts_per_linkedin: parseInt(e.target.value)})}
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700">Posts per X Account</label>
                  <input
                    type="number"
                    min="1"
                    className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500"
                    value={newCampaign.posts_per_x}
                    onChange={(e) => setNewCampaign({...newCampaign, posts_per_x: parseInt(e.target.value)})}
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700">Total X Posts</label>
                  <input
                    type="number"
                    min="1"
                    className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500"
                    value={newCampaign.total_x_posts}
                    onChange={(e) => setNewCampaign({...newCampaign, total_x_posts: parseInt(e.target.value)})}
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700">Posts per TikTok Account</label>
                  <input
                    type="number"
                    min="1"
                    className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500"
                    value={newCampaign.posts_per_tiktok}
                    onChange={(e) => setNewCampaign({...newCampaign, posts_per_tiktok: parseInt(e.target.value)})}
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700">Total TikTok Posts</label>
                  <input
                    type="number"
                    min="1"
                    className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500"
                    value={newCampaign.total_tiktok_posts}
                    onChange={(e) => setNewCampaign({...newCampaign, total_tiktok_posts: parseInt(e.target.value)})}
                  />
                </div>
              </div>

              {/* Live Mode Settings */}
              <div className={`space-y-4 ${newCampaign.is_live ? '' : 'opacity-50 pointer-events-none'}`}>
                <h4 className="text-md font-medium">Live Mode Settings</h4>
                
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700">Start Date</label>
                    <input
                      type="date"
                      className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500"
                      value={newCampaign.start_date}
                      onChange={(e) => setNewCampaign({...newCampaign, start_date: e.target.value})}
                    />
                  </div>
                  
                  <div>
                    <label className="block text-sm font-medium text-gray-700">End Date</label>
                    <input
                      type="date"
                      className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500"
                      value={newCampaign.end_date}
                      onChange={(e) => setNewCampaign({...newCampaign, end_date: e.target.value})}
                    />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700">Min Post Interval (hours)</label>
                    <input
                      type="number"
                      min="0.1"
                      step="0.1"
                      className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500"
                      value={newCampaign.min_post_interval_hours}
                      onChange={(e) => setNewCampaign({...newCampaign, min_post_interval_hours: parseFloat(e.target.value)})}
                    />
                  </div>
                  
                  <div>
                    <label className="block text-sm font-medium text-gray-700">Max Post Interval (hours)</label>
                    <input
                      type="number"
                      min="0.1"
                      step="0.1"
                      className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500"
                      value={newCampaign.max_post_interval_hours}
                      onChange={(e) => setNewCampaign({...newCampaign, max_post_interval_hours: parseFloat(e.target.value)})}
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700">Min Reply Interval (hours)</label>
                    <input
                      type="number"
                      min="0.1"
                      step="0.1"
                      className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500"
                      value={newCampaign.min_reply_interval_hours}
                      onChange={(e) => setNewCampaign({...newCampaign, min_reply_interval_hours: parseFloat(e.target.value)})}
                    />
                  </div>
                  
                  <div>
                    <label className="block text-sm font-medium text-gray-700">Max Reply Interval (hours)</label>
                    <input
                      type="number"
                      min="0.1"
                      step="0.1"
                      className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500"
                      value={newCampaign.max_reply_interval_hours}
                      onChange={(e) => setNewCampaign({...newCampaign, max_reply_interval_hours: parseFloat(e.target.value)})}
                    />
                  </div>
                </div>
                <p className="text-sm text-gray-500 italic">
                  These settings only apply in live mode and control when the campaign runs and how frequently posts and replies are made.
                </p>
              </div>
            </div>

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
              className="w-full flex justify-center py-2 px-4 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500 disabled:bg-indigo-400"
            >
              {loading ? 'Creating...' : 'Create Campaign'}
            </button>
          </form>
        </div>
      )}

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
                  <p className="text-sm text-gray-600 mt-1">{campaign.campaign_goal}</p>
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
              <div className="space-x-4">
                <button
                  onClick={startEditing}
                  className="px-4 py-2 text-sm font-medium text-white bg-indigo-600 rounded-md hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
                >
                  Edit Campaign
                </button>
                <button
                  onClick={() => setShowDeleteModal(true)}
                  className="px-4 py-2 text-sm font-medium text-white bg-red-600 rounded-md hover:bg-red-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-red-500"
                >
                  Delete Campaign
                </button>
              </div>
            </div>

            {isEditing ? (
              <form onSubmit={handleEditCampaign} className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700">Campaign Name</label>
                  <input
                    type="text"
                    className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500"
                    value={editingCampaign.name}
                    onChange={(e) => setEditingCampaign({...editingCampaign, name: e.target.value})}
                    required
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700">Campaign Overview</label>
                  <textarea
                    className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500"
                    value={editingCampaign.campaign_overview}
                    onChange={(e) => setEditingCampaign({...editingCampaign, campaign_overview: e.target.value})}
                    required
                    rows={4}
                  />
                </div>

                <div className="space-y-4 bg-gray-50 p-4 rounded-lg">
                  <h3 className="text-lg font-medium text-gray-900">Campaign Strategy</h3>
                  
                  <div>
                    <label className="block text-sm font-medium text-gray-700">Campaign Goal</label>
                    <textarea
                      className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500"
                      value={editingCampaign.campaign_goal}
                      onChange={(e) => setEditingCampaign({...editingCampaign, campaign_goal: e.target.value})}
                      required
                      rows={3}
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700">Post Goal</label>
                    <textarea
                      className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500"
                      value={editingCampaign.post_goal}
                      onChange={(e) => setEditingCampaign({...editingCampaign, post_goal: e.target.value})}
                      required
                      rows={3}
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700">Comment Goal</label>
                    <textarea
                      className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500"
                      value={editingCampaign.comment_goal}
                      onChange={(e) => setEditingCampaign({...editingCampaign, comment_goal: e.target.value})}
                      required
                      rows={3}
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700">Target Sentiment</label>
                  <select
                    className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500"
                    value={editingCampaign.target_sentiment}
                    onChange={(e) => setEditingCampaign({...editingCampaign, target_sentiment: e.target.value})}
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
                      value={editingCampaign.target_url}
                      onChange={(e) => setEditingCampaign({...editingCampaign, target_url: e.target.value})}
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700">Media Assets</label>
                  {editingCampaign.platform.includes('tiktok') && (
                    <div className="mb-4">
                      <VideoUploader
                        onMediaUpload={(url, type, duration) => {
                          setEditingCampaign(prev => ({
                            ...prev,
                            media_assets: [...prev.media_assets, { url, type, duration }]
                          }));
                        }}
                        onMediaRemove={(index) => {
                          setEditingCampaign(prev => ({
                            ...prev,
                            media_assets: prev.media_assets.filter((_, i) => i !== index)
                          }));
                        }}
                        mediaList={editingCampaign.media_assets.filter(asset => 
                          asset.type.startsWith('video/')
                        )}
                        platform="tiktok"
                      />
                    </div>
                  )}
                  {(editingCampaign.platform.includes('linkedin') || editingCampaign.platform.includes('x')) && (
                    <div>
                      <ImageUploader
                        onMediaUpload={(url, type) => {
                          setEditingCampaign(prev => ({
                            ...prev,
                            media_assets: [...prev.media_assets, { url, type }]
                          }));
                        }}
                        onMediaRemove={(index) => {
                          setEditingCampaign(prev => ({
                            ...prev,
                            media_assets: prev.media_assets.filter((_, i) => i !== index)
                          }));
                        }}
                        mediaList={editingCampaign.media_assets.filter(asset => 
                          asset.type.startsWith('image/')
                        )}
                        platform={editingCampaign.platform.includes('linkedin') ? 'linkedin' : 'x'}
                      />
                    </div>
                  )}
                </div>

                <NetworkSelector
                  onNetworksChange={(networks) => setEditingCampaign({...editingCampaign, platform: networks})}
                  campaign={editingCampaign}
                />

                <div className="space-y-4">
                  <h3 className="text-lg font-medium">Campaign Schedule</h3>
                  
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="block text-sm font-medium text-gray-700">Posts per Subreddit</label>
                      <input
                        type="number"
                        min="1"
                        className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500"
                        value={editingCampaign.posts_per_subreddit}
                        onChange={(e) => setEditingCampaign({...editingCampaign, posts_per_subreddit: parseInt(e.target.value)})}
                      />
                    </div>
                    
                    <div>
                      <label className="block text-sm font-medium text-gray-700">Posts per LinkedIn</label>
                      <input
                        type="number"
                        min="1"
                        className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500"
                        value={editingCampaign.posts_per_linkedin}
                        onChange={(e) => setEditingCampaign({...editingCampaign, posts_per_linkedin: parseInt(e.target.value)})}
                      />
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-gray-700">Posts per X Account</label>
                      <input
                        type="number"
                        min="1"
                        className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500"
                        value={editingCampaign.posts_per_x}
                        onChange={(e) => setEditingCampaign({...editingCampaign, posts_per_x: parseInt(e.target.value)})}
                      />
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-gray-700">Total X Posts</label>
                      <input
                        type="number"
                        min="1"
                        className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500"
                        value={editingCampaign.total_x_posts}
                        onChange={(e) => setEditingCampaign({...editingCampaign, total_x_posts: parseInt(e.target.value)})}
                      />
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-gray-700">Posts per TikTok Account</label>
                      <input
                        type="number"
                        min="1"
                        className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500"
                        value={editingCampaign.posts_per_tiktok}
                        onChange={(e) => setEditingCampaign({...editingCampaign, posts_per_tiktok: parseInt(e.target.value)})}
                      />
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-gray-700">Total TikTok Posts</label>
                      <input
                        type="number"
                        min="1"
                        className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500"
                        value={editingCampaign.total_tiktok_posts}
                        onChange={(e) => setEditingCampaign({...editingCampaign, total_tiktok_posts: parseInt(e.target.value)})}
                      />
                    </div>
                  </div>
                </div>

                <div className="flex justify-end space-x-4">
                  <button
                    type="button"
                    onClick={() => {
                      setIsEditing(false);
                      setEditingCampaign(null);
                    }}
                    className="px-4 py-2 text-sm font-medium text-gray-700 bg-gray-100 rounded-md hover:bg-gray-200 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-gray-500"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={loading}
                    className="px-4 py-2 text-sm font-medium text-white bg-indigo-600 rounded-md hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500 disabled:bg-indigo-400"
                  >
                    {loading ? 'Saving...' : 'Save Changes'}
                  </button>
                </div>
              </form>
            ) : (
              <>
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
              </>
            )}
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