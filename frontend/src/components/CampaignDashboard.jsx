import React, { useState, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import api from '../utils/api';

const StatCard = ({ label, value, icon, color }) => (
  <div className="stat-card animate-fade-in">
    <div className="flex items-center justify-between">
      <span className="stat-label">{label}</span>
      <div className={`p-2 rounded-lg ${color}`}>
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d={icon} />
        </svg>
      </div>
    </div>
    <p className="stat-value">{value}</p>
  </div>
);

/**
 * @param {{ campaignType?: 'whisper' | 'brand' }} props
 */
const CampaignDashboard = ({ campaignType = 'whisper' }) => {
  const navigate = useNavigate();
  const isBrand = campaignType === 'brand';
  const [campaigns, setCampaigns] = useState([]);
  const [brands, setBrands] = useState([]);
  const [brandFilter, setBrandFilter] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    setLoading(true);
    (async () => {
      try {
        const [campRes, brandRes] = await Promise.all([
          api.get('/api/campaigns', { params: { type: campaignType } }),
          api.get('/api/brands'),
        ]);
        setCampaigns(campRes.data);
        setBrands(brandRes.data);
      } catch (err) {
        setError(err.response?.data?.error || err.message);
      } finally {
        setLoading(false);
      }
    })();
  }, [campaignType]);

  const filtered = brandFilter
    ? campaigns.filter((c) => String(c.brand_id) === brandFilter)
    : campaigns;

  const activeCount = filtered.filter(c => c.is_running).length;
  const draftCount = filtered.filter(c => !c.is_running).length;
  const newPath = isBrand ? '/brand-campaigns/new' : '/campaigns/new';

  if (loading) {
    return (
      <div className="flex justify-center items-center py-20">
        <div className="animate-spin rounded-full h-10 w-10 border-2 border-whisper-400 border-t-transparent"></div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-3">
        <div className="min-w-0">
          <h1 className="page-title">{isBrand ? 'Brand campaigns' : 'Whisper campaigns'}</h1>
          <p className="page-subtitle">
            {isBrand
              ? 'Post as the brand and run Google / Meta ads'
              : 'Bot army posting — Reddit (and more) demand generation'}
          </p>
        </div>
        <Link
          to={newPath}
          className="btn-primary flex items-center justify-center space-x-2 shadow-lg shadow-purple-500/20 sm:self-start"
        >
          <span>{isBrand ? 'New brand campaign' : 'AI Whisper builder'}</span>
        </Link>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <label className="text-sm text-gray-600">Brand</label>
        <select
          className="input-field max-w-xs"
          value={brandFilter}
          onChange={(e) => setBrandFilter(e.target.value)}
        >
          <option value="">All brands</option>
          {brands.map((b) => (
            <option key={b.id} value={b.id}>{b.name}</option>
          ))}
        </select>
      </div>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-4">
        <StatCard label="Total" value={filtered.length} color="bg-whisper-100 text-whisper-600" icon="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
        <StatCard label="Active" value={activeCount} color="bg-emerald-100 text-emerald-600" icon="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
        <StatCard label="Drafts" value={draftCount} color="bg-amber-100 text-amber-600" icon="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
      </div>

      {filtered.length === 0 && (
        <div className="card p-12 text-center animate-fade-in">
          <h3 className="text-lg font-semibold text-gray-900">No {isBrand ? 'brand' : 'Whisper'} campaigns yet</h3>
          <p className="mt-1 text-sm text-gray-500">
            {isBrand
              ? 'Create a brand campaign to publish as Authio / JockBroker / etc. and run ads.'
              : 'Use the AI builder to research a site and launch an army campaign.'}
          </p>
          <button onClick={() => navigate(newPath)} className="btn-primary mt-4">
            {isBrand ? 'New brand campaign' : 'Start AI builder'}
          </button>
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {filtered.map((campaign, index) => (
          <Link
            key={campaign.id}
            to={`/campaigns/${campaign.id}`}
            className="card group hover:border-whisper-200 hover:shadow-lg animate-fade-in"
            style={{ animationDelay: `${index * 50}ms` }}
          >
            <div className="p-5">
              <div className="flex justify-between items-start">
                <div className="flex-1 min-w-0">
                  <h2 className="text-base font-semibold text-gray-900 group-hover:text-whisper-600 transition-colors truncate">
                    {campaign.name}
                  </h2>
                  {campaign.brand_name && (
                    <p className="text-xs text-whisper-600 mt-0.5">{campaign.brand_name}</p>
                  )}
                </div>
                <span className={`ml-3 flex-shrink-0 badge ${
                  campaign.is_running ? 'badge-success' : 'badge-neutral'
                }`}>
                  {campaign.is_running ? 'Active' : 'Draft'}
                </span>
              </div>

              {campaign.campaign_overview && (
                <p className="mt-2 text-sm text-gray-500 line-clamp-2">{campaign.campaign_overview}</p>
              )}

              <div className="mt-3 flex flex-wrap gap-1.5">
                <span className="badge-info">{isBrand ? 'Brand' : 'Whisper'}</span>
                {campaign.platform?.map(platform => (
                  <span key={platform} className="badge-info">
                    {platform.charAt(0).toUpperCase() + platform.slice(1)}
                  </span>
                ))}
              </div>

              <div className="mt-4 flex items-center text-xs text-gray-400">
                {new Date(campaign.created_at).toLocaleDateString('en-US', {
                  month: 'short', day: 'numeric', year: 'numeric'
                })}
              </div>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
};

export default CampaignDashboard;
