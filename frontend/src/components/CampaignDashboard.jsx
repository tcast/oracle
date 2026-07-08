import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import CampaignForm from './CampaignForm';
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

const CampaignDashboard = () => {
  const [campaigns, setCampaigns] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [showNewCampaignForm, setShowNewCampaignForm] = useState(false);

  useEffect(() => {
    fetchCampaigns();
  }, []);

  const fetchCampaigns = async () => {
    try {
      const { data } = await api.get('/api/campaigns');
      setCampaigns(data);
      setLoading(false);
    } catch (err) {
      console.error('Error fetching campaigns:', err);
      setError(err.response?.data?.error || err.message);
      setLoading(false);
    }
  };

  const activeCount = campaigns.filter(c => c.is_running).length;
  const draftCount = campaigns.filter(c => !c.is_running).length;
  const totalPosts = campaigns.reduce((sum, c) => sum + (c.post_goal || 0), 0);

  if (loading) {
    return (
      <div className="flex justify-center items-center py-20">
        <div className="animate-spin rounded-full h-10 w-10 border-2 border-oracle-400 border-t-transparent"></div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-3">
        <div className="min-w-0">
          <h1 className="page-title">Campaigns</h1>
          <p className="page-subtitle">Manage and monitor your social media campaigns</p>
        </div>
        <button
          onClick={() => setShowNewCampaignForm(true)}
          className="btn-primary flex items-center justify-center space-x-2 shadow-lg shadow-oracle-500/20 sm:self-start"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
          </svg>
          <span>New Campaign</span>
        </button>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-4">
        <StatCard label="Total Campaigns" value={campaigns.length} color="bg-oracle-100 text-oracle-600" icon="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
        <StatCard label="Active" value={activeCount} color="bg-emerald-100 text-emerald-600" icon="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
        <StatCard label="Drafts" value={draftCount} color="bg-amber-100 text-amber-600" icon="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
      </div>

      {showNewCampaignForm && (
        <div className="card p-6 animate-slide-up">
          <CampaignForm
            onClose={() => setShowNewCampaignForm(false)}
            onSuccess={() => {
              setShowNewCampaignForm(false);
              fetchCampaigns();
            }}
          />
        </div>
      )}

      {campaigns.length === 0 && (
        <div className="card p-12 text-center animate-fade-in">
          <div className="w-16 h-16 mx-auto bg-gray-100 rounded-2xl flex items-center justify-center mb-4">
            <svg className="w-8 h-8 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M11 3.055A9.001 9.001 0 1020.945 13H11V3.055z" />
            </svg>
          </div>
          <h3 className="text-lg font-semibold text-gray-900">No campaigns yet</h3>
          <p className="mt-1 text-sm text-gray-500">Create your first campaign to get started.</p>
          <button
            onClick={() => setShowNewCampaignForm(true)}
            className="btn-primary mt-4"
          >
            Create Campaign
          </button>
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {campaigns.map((campaign, index) => (
          <Link
            key={campaign.id}
            to={`/campaigns/${campaign.id}`}
            className="card group hover:border-oracle-200 hover:shadow-lg animate-fade-in"
            style={{ animationDelay: `${index * 50}ms` }}
          >
            <div className="p-5">
              <div className="flex justify-between items-start">
                <div className="flex-1 min-w-0">
                  <h2 className="text-base font-semibold text-gray-900 group-hover:text-oracle-600 transition-colors truncate">
                    {campaign.name}
                  </h2>
                </div>
                <span className={`ml-3 flex-shrink-0 badge ${
                  campaign.is_running ? 'badge-success' : 'badge-neutral'
                }`}>
                  <span className={`w-1.5 h-1.5 rounded-full mr-1.5 ${
                    campaign.is_running ? 'bg-emerald-500' : 'bg-gray-400'
                  }`}></span>
                  {campaign.is_running ? 'Active' : 'Draft'}
                </span>
              </div>

              {campaign.campaign_overview && (
                <p className="mt-2 text-sm text-gray-500 line-clamp-2">{campaign.campaign_overview}</p>
              )}

              <div className="mt-4 flex flex-wrap gap-1.5">
                {campaign.platform?.map(platform => (
                  <span
                    key={platform}
                    className="badge-info"
                  >
                    {platform.charAt(0).toUpperCase() + platform.slice(1)}
                  </span>
                ))}
              </div>

              <div className="mt-4 flex items-center text-xs text-gray-400">
                <svg className="w-3.5 h-3.5 mr-1" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
                </svg>
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
