import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts';
import SimulationControls from './SimulationControls';
import SubredditManager from './SubredditManager';
import CampaignPosts from './CampaignPosts';
import NetworkSelector from './NetworkSelector';
import ImageUploader from './ImageUploader';
import VideoUploader from './VideoUploader';
import ConfirmationModal from './ConfirmationModal';

const ExpandableText = ({ text, maxLength = 500 }) => {
  const [isExpanded, setIsExpanded] = useState(false);
  
  if (!text) return null;
  
  const shouldTruncate = text.length > maxLength;
  const displayText = !shouldTruncate || isExpanded ? text : text.slice(0, maxLength) + '...';
  
  return (
    <div className="space-y-2">
      {displayText.split('\n\n').map((paragraph, i) => (
        <p key={i} className="text-gray-700">{paragraph}</p>
      ))}
      {shouldTruncate && (
        <button
          onClick={() => setIsExpanded(!isExpanded)}
          className="text-indigo-600 hover:text-indigo-800 text-sm font-medium"
        >
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

  // Calculate latest point from analytics
  const latestPoint = analytics.length > 0 ? analytics[analytics.length - 1] : null;

  useEffect(() => {
    fetchCampaign();
    fetchAnalytics();
    fetchStats(); // Initial fetch
    
    // Set up intervals
    const campaignInterval = setInterval(fetchCampaign, 5000);
    const analyticsInterval = setInterval(fetchAnalytics, 5000);
    const statsInterval = setInterval(fetchStats, 5000);
    
    return () => {
      clearInterval(campaignInterval);
      clearInterval(analyticsInterval);
      clearInterval(statsInterval);
    };
  }, [id]);

  const fetchCampaign = async () => {
    try {
      const response = await fetch(`/api/campaigns/${id}`);
      if (!response.ok) {
        throw new Error('Failed to fetch campaign');
      }
      const data = await response.json();
      setCampaign(data);
      setLoading(false);
    } catch (err) {
      console.error('Error fetching campaign:', err);
      setError(err.message);
      setLoading(false);
    }
  };

  const fetchAnalytics = async () => {
    try {
      const response = await fetch(`/api/campaigns/${id}/analytics`, {
        headers: {
          'Accept': 'application/json',
          'Cache-Control': 'no-cache'
        }
      });
      
      if (!response.ok) {
        throw new Error('Failed to fetch analytics');
      }
      
      const data = await response.json();
      setAnalytics(data);
    } catch (err) {
      // Silently handle analytics fetch errors
    }
  };

  const fetchStats = async () => {
    try {
      const response = await fetch(`/api/campaigns/${id}/simulation/stats`, {
        headers: {
          'Accept': 'application/json',
          'Cache-Control': 'no-cache'
        }
      });
      
      if (!response.ok) {
        throw new Error('Failed to fetch stats');
      }
      
      const data = await response.json();
      setStats(data);
    } catch (err) {
      // Silently handle stats fetch errors
    }
  };

  const handleDeleteCampaign = async () => {
    try {
      setLoading(true);
      const response = await fetch(`/api/campaigns/${id}`, {
        method: 'DELETE'
      });
      if (!response.ok) throw new Error('Failed to delete campaign');
      navigate('/');
    } catch (err) {
      setError(err.message);
      setLoading(false);
    }
  };

  const handleEditCampaign = async (e) => {
    e.preventDefault();
    try {
      setLoading(true);
      const response = await fetch(`/api/campaigns/${id}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(editingCampaign),
      });
      
      if (!response.ok) throw new Error('Failed to update campaign');
      
      const updatedCampaign = await response.json();
      setCampaign(updatedCampaign);
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
      ...campaign,
      platform: campaign.platform || [],
      media_assets: campaign.media_assets || [],
    });
    setIsEditing(true);
  };

  if (loading) {
    return (
      <div className="flex justify-center items-center py-8">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-600"></div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded">
        {error}
      </div>
    );
  }

  if (!campaign) {
    return (
      <div className="text-center py-8">
        <h2 className="text-2xl font-bold text-gray-900">Campaign not found</h2>
        <p className="mt-2 text-gray-600">The campaign you're looking for doesn't exist or has been deleted.</p>
        <button
          onClick={() => navigate('/')}
          className="mt-4 px-4 py-2 bg-indigo-600 text-white rounded-md hover:bg-indigo-700"
        >
          Return to Dashboard
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <h1 className="text-2xl font-bold text-gray-900">{campaign.name}</h1>
        <div className="flex space-x-4">
          <button
            onClick={startEditing}
            className="px-4 py-2 bg-white text-gray-700 border border-gray-300 rounded-md hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
          >
            Edit Campaign
          </button>
          <button
            onClick={() => setShowDeleteModal(true)}
            className="px-4 py-2 bg-red-600 text-white rounded-md hover:bg-red-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-red-500"
          >
            Delete Campaign
          </button>
        </div>
      </div>

      {isEditing ? (
        <div className="bg-white shadow rounded-lg p-6">
          <form onSubmit={handleEditCampaign}>
            <div className="space-y-4">
              <div>
                <label htmlFor="name" className="block text-sm font-medium text-gray-700">Campaign Name</label>
                <input
                  type="text"
                  id="name"
                  value={editingCampaign.name}
                  onChange={(e) => setEditingCampaign({...editingCampaign, name: e.target.value})}
                  className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500"
                />
              </div>
              
              <div>
                <label htmlFor="campaign_overview" className="block text-sm font-medium text-gray-700">Campaign Overview</label>
                <textarea
                  id="campaign_overview"
                  value={editingCampaign.campaign_overview}
                  onChange={(e) => setEditingCampaign({...editingCampaign, campaign_overview: e.target.value})}
                  rows={3}
                  className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500"
                />
              </div>

              <div>
                <label htmlFor="campaign_goal" className="block text-sm font-medium text-gray-700">Campaign Goal</label>
                <textarea
                  id="campaign_goal"
                  value={editingCampaign.campaign_goal}
                  onChange={(e) => setEditingCampaign({...editingCampaign, campaign_goal: e.target.value})}
                  rows={2}
                  className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500"
                />
              </div>

              <div>
                <label htmlFor="post_goal" className="block text-sm font-medium text-gray-700">Post Goal</label>
                <textarea
                  id="post_goal"
                  value={editingCampaign.post_goal}
                  onChange={(e) => setEditingCampaign({...editingCampaign, post_goal: e.target.value})}
                  rows={2}
                  className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500"
                />
              </div>

              <div>
                <label htmlFor="comment_goal" className="block text-sm font-medium text-gray-700">Comment Goal</label>
                <textarea
                  id="comment_goal"
                  value={editingCampaign.comment_goal}
                  onChange={(e) => setEditingCampaign({...editingCampaign, comment_goal: e.target.value})}
                  rows={2}
                  className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">Social Networks</label>
                <NetworkSelector
                  onNetworksChange={(networks) => setEditingCampaign({...editingCampaign, platform: networks})}
                  campaign={editingCampaign}
                />
              </div>

              <div className="flex justify-end space-x-3 pt-4">
                <button
                  type="button"
                  onClick={() => {
                    setIsEditing(false);
                    setEditingCampaign(null);
                  }}
                  className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 text-sm font-medium text-white bg-indigo-600 border border-transparent rounded-md hover:bg-indigo-700"
                >
                  Save Changes
                </button>
              </div>
            </div>
          </form>
        </div>
      ) : (
        <div className="bg-white shadow rounded-lg divide-y divide-gray-200">
          <div className="px-6 py-5">
            <h3 className="text-lg font-medium text-gray-900 mb-4">Campaign Overview</h3>
            
            <div className="space-y-6">
              <div>
                <h4 className="text-sm font-medium text-gray-500">Overview</h4>
                <div className="mt-2 prose prose-sm max-w-none">
                  <ExpandableText text={campaign.campaign_overview} />
                </div>
              </div>

              <div>
                <h4 className="text-sm font-medium text-gray-500">Campaign Goal</h4>
                <div className="mt-2 prose prose-sm max-w-none">
                  <ExpandableText text={campaign.campaign_goal} />
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div>
                  <h4 className="text-sm font-medium text-gray-500">Post Goal</h4>
                  <div className="mt-2 prose prose-sm max-w-none">
                    <ExpandableText text={campaign.post_goal} maxLength={500} />
                  </div>
                </div>

                <div>
                  <h4 className="text-sm font-medium text-gray-500">Comment Goal</h4>
                  <div className="mt-2 prose prose-sm max-w-none">
                    <ExpandableText text={campaign.comment_goal} maxLength={500} />
                  </div>
                </div>
              </div>

              <div>
                <h4 className="text-sm font-medium text-gray-500">Selected Networks</h4>
                <div className="mt-2 flex flex-wrap gap-2">
                  {campaign.platform?.map(platform => (
                    <span
                      key={platform}
                      className="inline-flex items-center px-3 py-1 rounded-full text-sm font-medium bg-indigo-100 text-indigo-800"
                    >
                      {platform.charAt(0).toUpperCase() + platform.slice(1)}
                    </span>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      <div className="bg-white shadow rounded-lg overflow-hidden">
        <div className="px-4 py-5 sm:p-6">
          <SimulationControls campaignId={id} isLive={campaign.is_live} />
        </div>
      </div>

      <div className="bg-white shadow rounded-lg overflow-hidden">
        <div className="px-4 py-5 sm:p-6">
          <h3 className="text-lg font-medium text-gray-900 mb-4">Activity Overview</h3>
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
                  formatter={(value, name) => [value, name.charAt(0).toUpperCase() + name.slice(1)]}
                />
                <Legend />
                <Line 
                  type="monotone" 
                  dataKey="posts" 
                  stroke="#8884d8" 
                  name="Posts"
                  strokeWidth={2}
                  dot={false}
                />
                <Line 
                  type="monotone" 
                  dataKey="comments" 
                  stroke="#82ca9d" 
                  name="Comments"
                  strokeWidth={2}
                  dot={false}
                />
                <Line 
                  type="monotone" 
                  dataKey="engagement" 
                  stroke="#ffc658" 
                  name="Engagement"
                  strokeWidth={2}
                  dot={false}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>

      <div className="bg-white shadow rounded-lg overflow-hidden">
        <div className="px-4 py-5 sm:p-6">
          <SubredditManager campaignId={id} />
        </div>
      </div>

      <div className="bg-white shadow rounded-lg overflow-hidden">
        <div className="px-4 py-5 sm:p-6">
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