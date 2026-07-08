import React, { useState } from 'react';
import NetworkSelector from './NetworkSelector';
import ImageUploader from './ImageUploader';
import VideoUploader from './VideoUploader';
import api from '../utils/api';

const CollapsibleSection = ({ title, defaultOpen = true, children }) => {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="bg-gray-50/50 rounded-xl border border-gray-100">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between px-5 py-3.5 text-left"
      >
        <h3 className="text-sm font-semibold text-gray-900">{title}</h3>
        <svg className={`w-4 h-4 text-gray-400 transition-transform ${open ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {open && <div className="px-5 pb-5 space-y-4">{children}</div>}
    </div>
  );
};

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
      await api.post('/api/campaigns', campaign);
      onSuccess();
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div>
      <div className="flex justify-between items-center mb-6">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">Create New Campaign</h2>
          <p className="text-sm text-gray-500 mt-0.5">Configure your social media campaign details</p>
        </div>
        <button onClick={onClose} className="text-gray-400 hover:text-gray-600 p-1 rounded-lg hover:bg-gray-100 transition-colors">
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      {error && (
        <div className="mb-6 bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-xl text-sm animate-fade-in">
          {error}
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-5">
        <div>
          <label className="label">Campaign Name</label>
          <input
            type="text"
            className="input-field"
            value={campaign.name}
            onChange={(e) => setCampaign({...campaign, name: e.target.value})}
            required
            placeholder="Enter campaign name"
          />
        </div>

        <div>
          <label className="label">Campaign Overview</label>
          <textarea
            className="input-field"
            value={campaign.campaign_overview}
            onChange={(e) => setCampaign({...campaign, campaign_overview: e.target.value})}
            required
            rows={3}
            placeholder="Describe what you are promoting (theory, product, news, etc.) in detail"
          />
        </div>

        <CollapsibleSection title="Campaign Strategy">
          <div>
            <label className="label">Campaign Goal</label>
            <textarea
              className="input-field"
              value={campaign.campaign_goal}
              onChange={(e) => setCampaign({...campaign, campaign_goal: e.target.value})}
              required
              rows={2}
              placeholder="What are the strategic objectives? (e.g., drive mass adoption, increase awareness)"
            />
          </div>
          <div>
            <label className="label">Post Goal</label>
            <textarea
              className="input-field"
              value={campaign.post_goal}
              onChange={(e) => setCampaign({...campaign, post_goal: e.target.value})}
              required
              rows={2}
              placeholder="What should each post aim to achieve? (e.g., drive engagement, spark speculation)"
            />
          </div>
          <div>
            <label className="label">Comment Goal</label>
            <textarea
              className="input-field"
              value={campaign.comment_goal}
              onChange={(e) => setCampaign({...campaign, comment_goal: e.target.value})}
              required
              rows={2}
              placeholder="How should comments support the campaign? (e.g., provide validation, create social proof)"
            />
          </div>
        </CollapsibleSection>

        <CollapsibleSection title="Targeting & Networks">
          <div>
            <label className="label">Target Sentiment</label>
            <select
              className="input-field"
              value={campaign.target_sentiment}
              onChange={(e) => setCampaign({...campaign, target_sentiment: e.target.value})}
            >
              <option value="positive">Positive</option>
              <option value="neutral">Neutral</option>
              <option value="negative">Negative</option>
            </select>
          </div>
          <div>
            <label className="label">Target URL (Optional)</label>
            <div className="mt-1 flex rounded-lg shadow-sm">
              <span className="inline-flex items-center px-3 rounded-l-lg border border-r-0 border-gray-200 bg-gray-50 text-gray-500 text-sm">
                https://
              </span>
              <input
                type="text"
                className="flex-1 min-w-0 block w-full px-3 py-2 rounded-none rounded-r-lg border-gray-200 focus:border-oracle-500 focus:ring-oracle-500 sm:text-sm"
                placeholder="example.com/your-link"
                value={campaign.target_url}
                onChange={(e) => setCampaign({...campaign, target_url: e.target.value})}
              />
            </div>
          </div>
          <div>
            <label className="label mb-2">Social Networks</label>
            <NetworkSelector
              onNetworksChange={(networks) => setCampaign({...campaign, platform: networks})}
              campaign={campaign}
            />
          </div>
        </CollapsibleSection>

        <CollapsibleSection title="Media Assets" defaultOpen={false}>
          <p className="text-sm text-gray-500">Add media assets for your posts. Images for LinkedIn/X, videos for TikTok.</p>
          {campaign.platform.includes('tiktok') && (
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
              mediaList={campaign.media_assets.filter(asset => asset.type.startsWith('video/'))}
              platform="tiktok"
            />
          )}
          {(campaign.platform.includes('linkedin') || campaign.platform.includes('x')) && (
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
              mediaList={campaign.media_assets.filter(asset => asset.type.startsWith('image/'))}
              platform={campaign.platform.includes('linkedin') ? 'linkedin' : 'x'}
            />
          )}
        </CollapsibleSection>

        <CollapsibleSection title="Schedule & Posting Limits" defaultOpen={false}>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-4">
            {[
              { key: 'posts_per_subreddit', label: 'Posts per Subreddit' },
              { key: 'posts_per_linkedin', label: 'Posts per LinkedIn' },
              { key: 'posts_per_x', label: 'Posts per X Account' },
              { key: 'total_x_posts', label: 'Total X Posts' },
              { key: 'posts_per_tiktok', label: 'Posts per TikTok' },
              { key: 'total_tiktok_posts', label: 'Total TikTok Posts' },
            ].map(field => (
              <div key={field.key}>
                <label className="label">{field.label}</label>
                <input
                  type="number"
                  min="1"
                  className="input-field"
                  value={campaign[field.key]}
                  onChange={(e) => setCampaign({...campaign, [field.key]: parseInt(e.target.value) || 1})}
                />
              </div>
            ))}
          </div>
        </CollapsibleSection>

        <div className="flex items-center space-x-3 p-4 bg-gray-50 rounded-xl border border-gray-100">
          <input
            type="checkbox"
            id="is_live"
            className="h-4 w-4 text-oracle-600 focus:ring-oracle-500 border-gray-300 rounded"
            checked={campaign.is_live}
            onChange={(e) => setCampaign({...campaign, is_live: e.target.checked})}
          />
          <label htmlFor="is_live" className="text-sm font-medium text-gray-900 cursor-pointer">
            Live Mode
          </label>
          {campaign.is_live && (
            <span className="badge-danger text-xs">Will post to actual social platforms</span>
          )}
        </div>

        {campaign.is_live && (
          <div className="space-y-4 p-4 bg-amber-50 border border-amber-200 rounded-xl animate-slide-up">
            <h4 className="text-sm font-semibold text-amber-900">Live Mode Settings</h4>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-4">
              {[
                { key: 'start_date', label: 'Start Date', type: 'date' },
                { key: 'end_date', label: 'End Date', type: 'date' },
                { key: 'min_post_interval_hours', label: 'Min Post Interval (hrs)', type: 'number', step: '0.1' },
                { key: 'max_post_interval_hours', label: 'Max Post Interval (hrs)', type: 'number', step: '0.1' },
                { key: 'min_reply_interval_hours', label: 'Min Reply Interval (hrs)', type: 'number', step: '0.1' },
                { key: 'max_reply_interval_hours', label: 'Max Reply Interval (hrs)', type: 'number', step: '0.1' },
              ].map(field => (
                <div key={field.key}>
                  <label className="label">{field.label}</label>
                  <input
                    type={field.type}
                    min={field.type === 'number' ? '0.1' : undefined}
                    step={field.step}
                    className="input-field"
                    value={campaign[field.key]}
                    onChange={(e) => setCampaign({
                      ...campaign,
                      [field.key]: field.type === 'number' ? parseFloat(e.target.value) : e.target.value
                    })}
                  />
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="flex justify-end space-x-3 pt-4 border-t border-gray-100">
          <button type="button" onClick={onClose} className="btn-secondary">
            Cancel
          </button>
          <button type="submit" disabled={loading} className="btn-primary">
            {loading ? 'Creating...' : 'Create Campaign'}
          </button>
        </div>
      </form>
    </div>
  );
};

export default CampaignForm;
