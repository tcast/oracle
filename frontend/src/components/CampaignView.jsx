import React, { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts';
import SimulationControls from './SimulationControls';
import SubredditManager from './SubredditManager';
import CampaignPosts from './CampaignPosts';
import NetworkSelector from './NetworkSelector';
import ImageUploader from './ImageUploader';
import VideoUploader from './VideoUploader';
import ConfirmationModal from './ConfirmationModal';
import api from '../utils/api';

const ExpandableText = ({ text, maxLength = 500 }) => {
  const [isExpanded, setIsExpanded] = useState(false);
  if (!text) return null;
  const shouldTruncate = text.length > maxLength;
  const displayText = !shouldTruncate || isExpanded ? text : text.slice(0, maxLength) + '...';
  return (
    <div className="space-y-2 text-sm text-gray-700 leading-relaxed">
      {displayText.split('\n\n').map((paragraph, i) => (
        <p key={i}>{paragraph}</p>
      ))}
      {shouldTruncate && (
        <button onClick={() => setIsExpanded(!isExpanded)} className="text-oracle-600 hover:text-oracle-700 text-sm font-medium">
          {isExpanded ? 'Show Less' : 'Read More'}
        </button>
      )}
    </div>
  );
};

const CampaignView = () => {
  const { id } = useParams();
  const navigate = useNavigate();
  const [campaign, setCampaign] = useState(null);
  const [analytics, setAnalytics] = useState([]);
  const [stats, setStats] = useState({ posts: 0, comments: 0, engagement: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [editingCampaign, setEditingCampaign] = useState(null);

  const fetchCampaign = useCallback(async () => {
    try {
      const { data } = await api.get(`/api/campaigns/${id}`);
      setCampaign(data);
      setLoading(false);
    } catch (err) {
      console.error('Error fetching campaign:', err);
      setError(err.response?.data?.error || err.message);
      setLoading(false);
    }
  }, [id]);

  const fetchAnalytics = useCallback(async () => {
    try {
      const { data } = await api.get(`/api/campaigns/${id}/analytics`);
      setAnalytics(data);
    } catch (err) {
      if (err.response?.status !== 404) console.error('Error fetching analytics:', err.message);
    }
  }, [id]);

  const fetchStats = useCallback(async () => {
    try {
      const { data } = await api.get(`/api/campaigns/${id}/simulation/stats`);
      setStats(data);
    } catch (err) {
      if (err.response?.status !== 404) console.error('Error fetching stats:', err.message);
    }
  }, [id]);

  const latestPoint = analytics.length > 0 ? analytics[analytics.length - 1] : null;

  useEffect(() => {
    fetchCampaign();
    fetchAnalytics();
    fetchStats();
    const campaignInterval = setInterval(fetchCampaign, 5000);
    const analyticsInterval = setInterval(fetchAnalytics, 5000);
    const statsInterval = setInterval(fetchStats, 5000);
    return () => {
      clearInterval(campaignInterval);
      clearInterval(analyticsInterval);
      clearInterval(statsInterval);
    };
  }, [id, fetchCampaign, fetchAnalytics, fetchStats]);

  const handleDeleteCampaign = async () => {
    try {
      setLoading(true);
      await api.delete(`/api/campaigns/${id}`);
      navigate('/');
    } catch (err) {
      setError(err.response?.data?.error || err.message);
      setLoading(false);
    }
  };

  const handleEditCampaign = async (e) => {
    e.preventDefault();
    try {
      setLoading(true);
      const { data } = await api.put(`/api/campaigns/${id}`, editingCampaign);
      setCampaign(data);
      setIsEditing(false);
      setEditingCampaign(null);
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setLoading(false);
    }
  };

  const startEditing = () => {
    setEditingCampaign({
      ...campaign,
      platform: campaign.platform || [],
      media_assets: campaign.media_assets || [],
    });
    setIsEditing(true);
  };

  if (loading) {
    return (
      <div className="flex justify-center items-center py-20">
        <div className="animate-spin rounded-full h-10 w-10 border-2 border-oracle-400 border-t-transparent"></div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-xl text-sm">
        {error}
      </div>
    );
  }

  if (!campaign) {
    return (
      <div className="card p-12 text-center">
        <h2 className="text-xl font-bold text-gray-900">Campaign not found</h2>
        <p className="mt-2 text-gray-500">The campaign you're looking for doesn't exist or has been deleted.</p>
        <button onClick={() => navigate('/')} className="btn-primary mt-4">
          Return to Dashboard
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-3">
        <div className="flex items-center space-x-3 min-w-0">
          <button onClick={() => navigate('/')} className="flex-shrink-0 text-gray-400 hover:text-gray-600 p-1 rounded-lg hover:bg-gray-100 transition-colors">
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M10 19l-7-7m0 0l7-7m-7 7h18" />
            </svg>
          </button>
          <h1 className="page-title truncate">{campaign.name}</h1>
          <span className={`badge flex-shrink-0 ${
            campaign.is_running ? 'badge-success' : 'badge-neutral'
          }`}>
            <span className={`w-1.5 h-1.5 rounded-full mr-1.5 ${
              campaign.is_running ? 'bg-emerald-500' : 'bg-gray-400'
            }`}></span>
            {campaign.is_running ? 'Active' : 'Inactive'}
          </span>
        </div>
        <div className="flex space-x-2 sm:space-x-3">
          <button onClick={startEditing} className="btn-secondary text-sm flex-1 sm:flex-none">
            Edit
          </button>
          <button onClick={() => setShowDeleteModal(true)} className="btn-danger text-sm flex-1 sm:flex-none">
            Delete
          </button>
        </div>
      </div>

      {isEditing ? (
        <div className="card p-6 animate-slide-up">
          <form onSubmit={handleEditCampaign}>
            <div className="space-y-4">
              <div>
                <label className="label">Campaign Name</label>
                <input
                  type="text"
                  value={editingCampaign.name}
                  onChange={(e) => setEditingCampaign({...editingCampaign, name: e.target.value})}
                  className="input-field"
                />
              </div>
              <div>
                <label className="label">Campaign Overview</label>
                <textarea
                  value={editingCampaign.campaign_overview}
                  onChange={(e) => setEditingCampaign({...editingCampaign, campaign_overview: e.target.value})}
                  rows={3}
                  className="input-field"
                />
              </div>
              <div>
                <label className="label">Campaign Goal</label>
                <textarea
                  value={editingCampaign.campaign_goal}
                  onChange={(e) => setEditingCampaign({...editingCampaign, campaign_goal: e.target.value})}
                  rows={2}
                  className="input-field"
                />
              </div>
              <div>
                <label className="label">Post Goal</label>
                <textarea
                  value={editingCampaign.post_goal}
                  onChange={(e) => setEditingCampaign({...editingCampaign, post_goal: e.target.value})}
                  rows={2}
                  className="input-field"
                />
              </div>
              <div>
                <label className="label">Comment Goal</label>
                <textarea
                  value={editingCampaign.comment_goal}
                  onChange={(e) => setEditingCampaign({...editingCampaign, comment_goal: e.target.value})}
                  rows={2}
                  className="input-field"
                />
              </div>
              <div>
                <label className="label mb-2">Social Networks</label>
                <NetworkSelector
                  onNetworksChange={(networks) => setEditingCampaign({...editingCampaign, platform: networks})}
                  campaign={editingCampaign}
                />
              </div>
              <div className="flex justify-end space-x-3 pt-4 border-t border-gray-100">
                <button type="button" onClick={() => { setIsEditing(false); setEditingCampaign(null); }} className="btn-secondary">
                  Cancel
                </button>
                <button type="submit" className="btn-primary">
                  Save Changes
                </button>
              </div>
            </div>
          </form>
        </div>
      ) : (
        <div className="card divide-y divide-gray-100">
          <div className="px-6 py-5">
            <h3 className="section-header">Campaign Details</h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 sm:gap-6">
              <div className="space-y-4">
                <div>
                  <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Overview</h4>
                  <ExpandableText text={campaign.campaign_overview} />
                </div>
                <div>
                  <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Campaign Goal</h4>
                  <ExpandableText text={campaign.campaign_goal} />
                </div>
              </div>
              <div className="space-y-4">
                <div>
                  <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Post Goal</h4>
                  <ExpandableText text={campaign.post_goal} maxLength={500} />
                </div>
                <div>
                  <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Comment Goal</h4>
                  <ExpandableText text={campaign.comment_goal} maxLength={500} />
                </div>
              </div>
            </div>
            {campaign.platform?.length > 0 && (
              <div className="mt-4 pt-4 border-t border-gray-100">
                <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Networks</h4>
                <div className="flex flex-wrap gap-2">
                  {campaign.platform.map(platform => (
                    <span key={platform} className="badge-info">
                      {platform.charAt(0).toUpperCase() + platform.slice(1)}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      <div className="card">
        <div className="px-6 py-5">
          <SimulationControls campaignId={id} isLive={campaign.is_live} />
        </div>
      </div>

      <div className="card">
        <div className="px-6 py-5">
          <h3 className="section-header">Activity Overview</h3>
          <div className="h-72">
            {analytics.length > 0 ? (
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={analytics}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                  <XAxis dataKey="date" tickFormatter={(t) => new Date(t).toLocaleDateString()} tick={{ fontSize: 12 }} stroke="#9ca3af" />
                  <YAxis tick={{ fontSize: 12 }} stroke="#9ca3af" />
                  <Tooltip
                    labelFormatter={(t) => new Date(t).toLocaleDateString()}
                    formatter={(value, name) => [value, name.charAt(0).toUpperCase() + name.slice(1)]}
                    contentStyle={{ borderRadius: '12px', border: '1px solid #e5e7eb', boxShadow: '0 4px 6px -1px rgba(0,0,0,0.1)' }}
                  />
                  <Legend />
                  <Line type="monotone" dataKey="posts" stroke="#6366f1" strokeWidth={2} dot={false} />
                  <Line type="monotone" dataKey="comments" stroke="#10b981" strokeWidth={2} dot={false} />
                  <Line type="monotone" dataKey="engagement" stroke="#f59e0b" strokeWidth={2} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            ) : (
              <div className="flex items-center justify-center h-full text-gray-400 text-sm">No analytics data yet</div>
            )}
          </div>
        </div>
      </div>

      <div className="card">
        <div className="px-6 py-5">
          <SubredditManager campaignId={id} />
        </div>
      </div>

      <div className="card">
        <div className="px-6 py-5">
          <CampaignPosts campaignId={id} />
        </div>
      </div>

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

export default CampaignView;
