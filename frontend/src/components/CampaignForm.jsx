import React, { useState } from 'react';
import NetworkSelector from './NetworkSelector';
import ImageUploader from './ImageUploader';
import VideoUploader from './VideoUploader';

const CampaignForm = ({ onClose, onSuccess }) => {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [campaign, setCampaign] = useState({
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

  const handleSubmit = async (e) => {
    e.preventDefault();
    try {
      setLoading(true);
      const response = await fetch('/api/campaigns', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(campaign),
      });
      
      if (!response.ok) throw new Error('Failed to create campaign');
      
      onSuccess();
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="bg-white shadow rounded-lg p-6 mt-4">
      <div className="flex justify-between items-center mb-4">
        <h2 className="text-xl font-semibold">Create New Campaign</h2>
        <button
          onClick={onClose}
          className="text-gray-400 hover:text-gray-500"
        >
          <span className="sr-only">Close</span>
          <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      {error && (
        <div className="mb-4 bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded relative">
          <span className="block sm:inline">{error}</span>
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-gray-700">Campaign Name</label>
          <input
            type="text"
            className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500"
            value={campaign.name}
            onChange={(e) => setCampaign({...campaign, name: e.target.value})}
            required
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700">Campaign Overview</label>
          <textarea
            className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500"
            value={campaign.campaign_overview}
            onChange={(e) => setCampaign({...campaign, campaign_overview: e.target.value})}
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
              value={campaign.campaign_goal}
              onChange={(e) => setCampaign({...campaign, campaign_goal: e.target.value})}
              required
              rows={3}
              placeholder="What are the strategic objectives for this campaign? (e.g., drive mass adoption, increase awareness)"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700">Post Goal</label>
            <textarea
              className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500"
              value={campaign.post_goal}
              onChange={(e) => setCampaign({...campaign, post_goal: e.target.value})}
              required
              rows={3}
              placeholder="What should each post aim to achieve? (e.g., drive engagement, spark speculation)"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700">Comment Goal</label>
            <textarea
              className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500"
              value={campaign.comment_goal}
              onChange={(e) => setCampaign({...campaign, comment_goal: e.target.value})}
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
            value={campaign.target_sentiment}
            onChange={(e) => setCampaign({...campaign, target_sentiment: e.target.value})}
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
              value={campaign.target_url}
              onChange={(e) => setCampaign({...campaign, target_url: e.target.value})}
            />
          </div>
          <p className="mt-1 text-sm text-gray-500">
            Add a URL that you want to direct users to (e.g., book purchase page, website)
          </p>
        </div>

        <NetworkSelector
          onNetworksChange={(networks) => setCampaign({...campaign, platform: networks})}
          campaign={campaign}
        />

        <div>
          <label className="block text-sm font-medium text-gray-700">Media Assets</label>
          {campaign.platform.includes('tiktok') && (
            <div className="mb-4">
              <VideoUploader
                onMediaUpload={(url, type, duration) => {
                  setCampaign(prev => ({
                    ...prev,
                    media_assets: [...prev.media_assets, { url, type, duration }]
                  }));
                }}
                onMediaRemove={(index) => {
                  setCampaign(prev => ({
                    ...prev,
                    media_assets: prev.media_assets.filter((_, i) => i !== index)
                  }));
                }}
                mediaList={campaign.media_assets.filter(asset => 
                  asset.type.startsWith('video/')
                )}
                platform="tiktok"
              />
            </div>
          )}
          {(campaign.platform.includes('linkedin') || campaign.platform.includes('x')) && (
            <div>
              <ImageUploader
                onMediaUpload={(url, type) => {
                  setCampaign(prev => ({
                    ...prev,
                    media_assets: [...prev.media_assets, { url, type }]
                  }));
                }}
                onMediaRemove={(index) => {
                  setCampaign(prev => ({
                    ...prev,
                    media_assets: prev.media_assets.filter((_, i) => i !== index)
                  }));
                }}
                mediaList={campaign.media_assets.filter(asset => 
                  asset.type.startsWith('image/')
                )}
                platform={campaign.platform.includes('linkedin') ? 'linkedin' : 'x'}
              />
            </div>
          )}
          <p className="mt-1 text-sm text-gray-500">
            Add media assets for your posts. Images for LinkedIn/X, videos for TikTok.
          </p>
        </div>

        <div className="space-y-4">
          <h3 className="text-lg font-medium">Campaign Schedule</h3>
          
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700">Posts per Subreddit</label>
              <input
                type="number"
                min="1"
                className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500"
                value={campaign.posts_per_subreddit}
                onChange={(e) => setCampaign({...campaign, posts_per_subreddit: parseInt(e.target.value)})}
              />
            </div>
            
            <div>
              <label className="block text-sm font-medium text-gray-700">Posts per LinkedIn</label>
              <input
                type="number"
                min="1"
                className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500"
                value={campaign.posts_per_linkedin}
                onChange={(e) => setCampaign({...campaign, posts_per_linkedin: parseInt(e.target.value)})}
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700">Posts per X Account</label>
              <input
                type="number"
                min="1"
                className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500"
                value={campaign.posts_per_x}
                onChange={(e) => setCampaign({...campaign, posts_per_x: parseInt(e.target.value)})}
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700">Total X Posts</label>
              <input
                type="number"
                min="1"
                className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500"
                value={campaign.total_x_posts}
                onChange={(e) => setCampaign({...campaign, total_x_posts: parseInt(e.target.value)})}
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700">Posts per TikTok Account</label>
              <input
                type="number"
                min="1"
                className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500"
                value={campaign.posts_per_tiktok}
                onChange={(e) => setCampaign({...campaign, posts_per_tiktok: parseInt(e.target.value)})}
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700">Total TikTok Posts</label>
              <input
                type="number"
                min="1"
                className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500"
                value={campaign.total_tiktok_posts}
                onChange={(e) => setCampaign({...campaign, total_tiktok_posts: parseInt(e.target.value)})}
              />
            </div>
          </div>
        </div>

        <div className="flex items-center">
          <input
            type="checkbox"
            id="is_live"
            className="h-4 w-4 text-indigo-600 focus:ring-indigo-500 border-gray-300 rounded"
            checked={campaign.is_live}
            onChange={(e) => setCampaign({...campaign, is_live: e.target.checked})}
          />
          <label htmlFor="is_live" className="ml-2 block text-sm text-gray-900">
            Live Mode
          </label>
          {campaign.is_live && (
            <span className="ml-2 inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-800">
              Will post to actual social platforms
            </span>
          )}
        </div>

        {campaign.is_live && (
          <div className="space-y-4">
            <h4 className="text-md font-medium">Live Mode Settings</h4>
            
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700">Start Date</label>
                <input
                  type="date"
                  className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500"
                  value={campaign.start_date}
                  onChange={(e) => setCampaign({...campaign, start_date: e.target.value})}
                />
              </div>
              
              <div>
                <label className="block text-sm font-medium text-gray-700">End Date</label>
                <input
                  type="date"
                  className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500"
                  value={campaign.end_date}
                  onChange={(e) => setCampaign({...campaign, end_date: e.target.value})}
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
                  value={campaign.min_post_interval_hours}
                  onChange={(e) => setCampaign({...campaign, min_post_interval_hours: parseFloat(e.target.value)})}
                />
              </div>
              
              <div>
                <label className="block text-sm font-medium text-gray-700">Max Post Interval (hours)</label>
                <input
                  type="number"
                  min="0.1"
                  step="0.1"
                  className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500"
                  value={campaign.max_post_interval_hours}
                  onChange={(e) => setCampaign({...campaign, max_post_interval_hours: parseFloat(e.target.value)})}
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700">Min Reply Interval (hours)</label>
                <input
                  type="number"
                  min="0.1"
                  step="0.1"
                  className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500"
                  value={campaign.min_reply_interval_hours}
                  onChange={(e) => setCampaign({...campaign, min_reply_interval_hours: parseFloat(e.target.value)})}
                />
              </div>
              
              <div>
                <label className="block text-sm font-medium text-gray-700">Max Reply Interval (hours)</label>
                <input
                  type="number"
                  min="0.1"
                  step="0.1"
                  className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500"
                  value={campaign.max_reply_interval_hours}
                  onChange={(e) => setCampaign({...campaign, max_reply_interval_hours: parseFloat(e.target.value)})}
                />
              </div>
            </div>
            <p className="text-sm text-gray-500 italic">
              These settings only apply in live mode and control when the campaign runs and how frequently posts and replies are made.
            </p>
          </div>
        )}

        <div className="flex justify-end space-x-4">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-sm font-medium text-gray-700 bg-gray-100 rounded-md hover:bg-gray-200"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={loading}
            className="px-4 py-2 text-sm font-medium text-white bg-indigo-600 rounded-md hover:bg-indigo-700 disabled:bg-indigo-400"
          >
            {loading ? 'Creating...' : 'Create Campaign'}
          </button>
        </div>
      </form>
    </div>
  );
};

export default CampaignForm; 