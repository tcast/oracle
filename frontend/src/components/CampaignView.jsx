import React, { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import SimulationControls from './SimulationControls';
import SubredditManager from './SubredditManager';
import CampaignPosts from './CampaignPosts';
import CampaignArmyPanel from './CampaignArmyPanel';
import CampaignActivityFeed from './CampaignActivityFeed';
import CampaignScorecard from './CampaignScorecard';
import SimRunHistory from './SimRunHistory';
import AudiencePersonasPanel from './AudiencePersonasPanel';
import BrandPublishPanel from './BrandPublishPanel';
import CampaignAdsPanel from './CampaignAdsPanel';
import NetworkSelector from './NetworkSelector';
import ConfirmationModal from './ConfirmationModal';
import api from '../utils/api';

const WHISPER_TABS = [
  { id: 'work', label: 'Work', desc: 'Subreddits & posts' },
  { id: 'launch', label: 'Launch', desc: 'Sim & army' },
  { id: 'details', label: 'Details', desc: 'Campaign info' },
];

const BRAND_TABS = [
  { id: 'publish', label: 'Publish', desc: 'Brand posts' },
  { id: 'ads', label: 'Ads', desc: 'Text & visual builders' },
  { id: 'details', label: 'Details', desc: 'Campaign info' },
];

const StatPill = ({ label, value, accent }) => (
  <div className={`px-3 py-1.5 rounded-lg border text-center min-w-[72px] ${accent || 'bg-white border-gray-200'}`}>
    <p className="text-lg font-bold text-gray-900 leading-none">{value}</p>
    <p className="text-[10px] uppercase tracking-wide text-gray-500 mt-0.5">{label}</p>
  </div>
);

const CampaignView = () => {
  const { id } = useParams();
  const navigate = useNavigate();
  const [campaign, setCampaign] = useState(null);
  const [analytics, setAnalytics] = useState([]);
  const [counts, setCounts] = useState({ subsApproved: 0, postsApproved: 0, drafts: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [editingCampaign, setEditingCampaign] = useState(null);
  const [activeTab, setActiveTab] = useState(null);
  const [showOverview, setShowOverview] = useState(false);

  const isBrand = campaign?.campaign_type === 'brand';
  const tabs = isBrand ? BRAND_TABS : WHISPER_TABS;

  useEffect(() => {
    if (!campaign) return;
    const allowed = (isBrand ? BRAND_TABS : WHISPER_TABS).map((t) => t.id);
    if (!activeTab || !allowed.includes(activeTab)) {
      setActiveTab(allowed[0]);
    }
  }, [campaign, isBrand, activeTab]);

  const fetchCampaign = useCallback(async () => {
    try {
      const { data } = await api.get(`/api/campaigns/${id}`);
      setCampaign(data);
      setLoading(false);
    } catch (err) {
      setError(err.response?.data?.error || err.message);
      setLoading(false);
    }
  }, [id]);

  const fetchCounts = useCallback(async () => {
    try {
      const [subs, posts] = await Promise.all([
        api.get(`/api/subreddits/${id}`),
        api.get(`/api/campaigns/${id}/posts/list`),
      ]);
      const subList = subs.data || [];
      const postList = posts.data || [];
      setCounts({
        subsApproved: subList.filter(s => s.status === 'approved').length,
        postsApproved: postList.filter(p => p.status === 'approved').length,
        drafts: postList.filter(p => p.status === 'draft').length,
      });
    } catch {
      /* non-critical */
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

  useEffect(() => {
    fetchCampaign();
    fetchCounts();
    fetchAnalytics();
    const interval = setInterval(() => {
      fetchCampaign();
      fetchCounts();
      if (activeTab === 'details') fetchAnalytics();
    }, 8000);
    return () => clearInterval(interval);
  }, [id, fetchCampaign, fetchCounts, fetchAnalytics, activeTab]);

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
    setActiveTab('details');
  };

  if (loading && !campaign) {
    return (
      <div className="flex justify-center items-center py-20">
        <div className="animate-spin rounded-full h-10 w-10 border-2 border-whisper-400 border-t-transparent" />
      </div>
    );
  }

  if (error && !campaign) {
    return <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-xl text-sm">{error}</div>;
  }

  if (!campaign) {
    return (
      <div className="card p-12 text-center">
        <h2 className="text-xl font-bold text-gray-900">Campaign not found</h2>
        <button onClick={() => navigate('/')} className="btn-primary mt-4">Return to Dashboard</button>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Header */}
      <header className="flex-shrink-0 bg-white border-b border-gray-200 px-4 sm:px-6 py-3">
        <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <button onClick={() => navigate(isBrand ? '/brand-campaigns' : '/')} className="text-gray-400 hover:text-gray-700 p-1.5 rounded-lg hover:bg-gray-100 flex-shrink-0">
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
              </svg>
            </button>
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <h1 className="text-lg font-bold text-gray-900 truncate">{campaign.name}</h1>
                {campaign.brand_name && (
                  <span className="badge-info text-[10px]">{campaign.brand_name}</span>
                )}
                <span className="badge-info text-[10px]">{isBrand ? 'Brand' : 'Whisper'}</span>
                <span className={`badge ${campaign.is_running ? 'badge-success' : 'badge-neutral'}`}>
                  {campaign.is_running ? 'Active' : 'Draft'}
                </span>
                {campaign.platform?.map(p => (
                  <span key={p} className="badge-info text-[10px]">{p}</span>
                ))}
              </div>
              {campaign.target_url && (
                <a href={campaign.target_url} target="_blank" rel="noopener noreferrer" className="text-xs text-whisper-600 hover:underline truncate block">
                  {campaign.target_url}
                </a>
              )}
            </div>
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            <StatPill label="Subs" value={counts.subsApproved} accent="bg-emerald-50 border-emerald-200" />
            <StatPill label="Posts" value={counts.postsApproved} accent="bg-emerald-50 border-emerald-200" />
            <StatPill label="Drafts" value={counts.drafts} accent={counts.drafts > 0 ? 'bg-amber-50 border-amber-200' : undefined} />
            <div className="flex gap-1.5 ml-1">
              <button onClick={startEditing} className="btn-secondary text-xs px-3 py-1.5">Edit</button>
              <button onClick={() => setShowDeleteModal(true)} className="btn-danger text-xs px-3 py-1.5">Delete</button>
            </div>
          </div>
        </div>

        {/* Tabs */}
        <nav className="flex gap-1 mt-3 -mb-px">
          {tabs.map(tab => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`px-4 py-2 text-sm font-medium rounded-t-lg border-b-2 transition-colors ${
                activeTab === tab.id
                  ? 'border-whisper-600 text-whisper-700 bg-whisper-50/50'
                  : 'border-transparent text-gray-500 hover:text-gray-700 hover:bg-gray-50'
              }`}
            >
              {tab.label}
              <span className="hidden sm:inline text-gray-400 font-normal ml-1.5">· {tab.desc}</span>
            </button>
          ))}
        </nav>
      </header>

      {/* Content */}
      <main className="flex-1 min-h-0 overflow-hidden bg-gray-50/80">
        {!isBrand && activeTab === 'work' && (
          <div className="h-full grid grid-cols-1 xl:grid-cols-2 divide-y xl:divide-y-0 xl:divide-x divide-gray-200">
            <div className="h-full min-h-0 flex flex-col bg-white">
              <div className="flex-shrink-0 px-4 sm:px-5 py-2.5 border-b border-gray-100 bg-gray-50/80">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-gray-400">Target communities</p>
              </div>
              <div className="flex-1 min-h-0 overflow-y-auto p-4 sm:p-5">
                <SubredditManager campaignId={id} embedded onCountsChange={fetchCounts} />
              </div>
            </div>
            <div className="h-full min-h-0 flex flex-col bg-white">
              <div className="flex-shrink-0 px-4 sm:px-5 py-2.5 border-b border-gray-100 bg-gray-50/80">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-gray-400">Content review</p>
              </div>
              <div className="flex-1 min-h-0 overflow-y-auto p-4 sm:p-5">
                <CampaignPosts campaignId={id} embedded onCountsChange={fetchCounts} />
              </div>
            </div>
          </div>
        )}

        {!isBrand && activeTab === 'launch' && (
          <div className="h-full overflow-y-auto p-4 sm:p-6">
            <div className="max-w-6xl grid grid-cols-1 lg:grid-cols-2 gap-4">
              <div className="space-y-4">
                <SimulationControls
                  campaignId={id}
                  isLive={campaign.is_live}
                  compact
                  onCampaignChange={fetchCampaign}
                />
                <CampaignScorecard campaignId={id} />
                <SimRunHistory campaignId={id} />
                <CampaignActivityFeed campaignId={id} />
                {analytics.length > 0 && (
                  <div className="card p-5">
                    <h3 className="text-sm font-semibold text-gray-900 mb-4">Trends</h3>
                    <div className="h-48">
                      <ResponsiveContainer width="100%" height="100%">
                        <LineChart data={analytics}>
                          <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                          <XAxis dataKey="date" tickFormatter={(t) => new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} tick={{ fontSize: 11 }} />
                          <YAxis tick={{ fontSize: 11 }} width={32} />
                          <Tooltip labelFormatter={(t) => new Date(t).toLocaleDateString()} />
                          <Line type="monotone" dataKey="posts" stroke="#6366f1" strokeWidth={2} dot={false} name="Posts" />
                          <Line type="monotone" dataKey="comments" stroke="#10b981" strokeWidth={2} dot={false} name="Comments" />
                        </LineChart>
                      </ResponsiveContainer>
                    </div>
                  </div>
                )}
              </div>
              <div className="space-y-4">
                <AudiencePersonasPanel campaignId={id} />
                <CampaignArmyPanel campaignId={id} />
              </div>
            </div>
          </div>
        )}

        {isBrand && activeTab === 'publish' && (
          <div className="h-full overflow-y-auto p-4 sm:p-6 max-w-3xl space-y-4">
            <div className="card p-4">
              <h3 className="text-sm font-semibold text-gray-900 mb-3">Publish as brand</h3>
              <BrandPublishPanel campaignId={id} campaign={campaign} onUpdated={fetchCampaign} />
            </div>
          </div>
        )}

        {isBrand && activeTab === 'ads' && (
          <div className="h-full overflow-y-auto p-4 sm:p-6 max-w-4xl">
            <CampaignAdsPanel campaignId={id} campaign={campaign} />
          </div>
        )}

        {activeTab === 'details' && (
          <div className="h-full overflow-y-auto p-4 sm:p-6 max-w-3xl space-y-4">
            {isEditing ? (
              <div className="card p-5">
                <form onSubmit={handleEditCampaign} className="space-y-4">
                  <div>
                    <label className="label">Name</label>
                    <input className="input-field" value={editingCampaign.name} onChange={(e) => setEditingCampaign({ ...editingCampaign, name: e.target.value })} />
                  </div>
                  <div>
                    <label className="label">Overview</label>
                    <textarea className="input-field" rows={4} value={editingCampaign.campaign_overview} onChange={(e) => setEditingCampaign({ ...editingCampaign, campaign_overview: e.target.value })} />
                  </div>
                  <div>
                    <label className="label">Goal</label>
                    <textarea className="input-field" rows={2} value={editingCampaign.campaign_goal} onChange={(e) => setEditingCampaign({ ...editingCampaign, campaign_goal: e.target.value })} />
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="label">Post goal</label>
                      <input type="number" className="input-field" value={editingCampaign.post_goal} onChange={(e) => setEditingCampaign({ ...editingCampaign, post_goal: e.target.value })} />
                    </div>
                    <div>
                      <label className="label">Comment goal</label>
                      <input type="number" className="input-field" value={editingCampaign.comment_goal} onChange={(e) => setEditingCampaign({ ...editingCampaign, comment_goal: e.target.value })} />
                    </div>
                  </div>
                  <div>
                    <label className="label">Type</label>
                    <p className="text-sm text-gray-700">{isBrand ? 'Brand (overt + ads)' : 'Whisper (army)'}</p>
                  </div>
                  <NetworkSelector onNetworksChange={(networks) => setEditingCampaign({ ...editingCampaign, platform: networks })} campaign={editingCampaign} />
                  <div className="flex gap-2 pt-2">
                    <button type="submit" className="btn-primary">Save</button>
                    <button type="button" onClick={() => { setIsEditing(false); setEditingCampaign(null); }} className="btn-secondary">Cancel</button>
                  </div>
                </form>
              </div>
            ) : (
              <div className="card overflow-hidden">
                <button
                  type="button"
                  onClick={() => setShowOverview(v => !v)}
                  className="w-full px-5 py-3 flex items-center justify-between text-left hover:bg-gray-50"
                >
                  <span className="text-sm font-semibold text-gray-900">Campaign overview</span>
                  <svg className={`w-4 h-4 text-gray-400 transition-transform ${showOverview ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                  </svg>
                </button>
                {showOverview && (
                  <div className="px-5 pb-5 space-y-4 border-t border-gray-100 pt-4 text-sm text-gray-700 leading-relaxed">
                    {campaign.brand_name && (
                      <div>
                        <p className="text-xs font-semibold text-gray-400 uppercase mb-1">Brand</p>
                        <p>
                          <a href={`/brands/${campaign.brand_id}`} className="text-whisper-600 hover:underline">{campaign.brand_name}</a>
                        </p>
                      </div>
                    )}
                    <div>
                      <p className="text-xs font-semibold text-gray-400 uppercase mb-1">Type</p>
                      <p>{isBrand ? 'Brand — traditional posting & ads' : 'Whisper — bot army demand gen'}</p>
                    </div>
                    <div>
                      <p className="text-xs font-semibold text-gray-400 uppercase mb-1">Overview</p>
                      <p className="whitespace-pre-wrap">{campaign.campaign_overview}</p>
                    </div>
                    <div>
                      <p className="text-xs font-semibold text-gray-400 uppercase mb-1">Goal</p>
                      <p>{campaign.campaign_goal}</p>
                    </div>
                    <div className="flex gap-6 text-sm">
                      <span><strong>{campaign.post_goal}</strong> posts</span>
                      <span><strong>{campaign.comment_goal}</strong> comments</span>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </main>

      <ConfirmationModal
        isOpen={showDeleteModal}
        onClose={() => setShowDeleteModal(false)}
        onConfirm={handleDeleteCampaign}
        title="Delete Campaign"
        message="Are you sure? This removes all posts, subreddits, and data permanently."
      />
    </div>
  );
};

export default CampaignView;
