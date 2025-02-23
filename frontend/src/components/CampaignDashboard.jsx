import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import NetworkSelector from './NetworkSelector';
import CampaignForm from './CampaignForm';

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
      const response = await fetch('/api/campaigns');
      if (!response.ok) {
        throw new Error('Failed to fetch campaigns');
      }
      const data = await response.json();
      setCampaigns(data);
      setLoading(false);
    } catch (err) {
      console.error('Error fetching campaigns:', err);
      setError(err.message);
      setLoading(false);
    }
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

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <h1 className="text-2xl font-bold text-gray-900">Campaigns</h1>
        <button
          onClick={() => setShowNewCampaignForm(true)}
          className="px-4 py-2 bg-indigo-600 text-white rounded-md hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
        >
          New Campaign
        </button>
      </div>

      {showNewCampaignForm && (
        <CampaignForm
          onClose={() => setShowNewCampaignForm(false)}
          onSuccess={() => {
            setShowNewCampaignForm(false);
            fetchCampaigns();
          }}
        />
      )}

      <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
        {campaigns.map(campaign => (
          <Link
            key={campaign.id}
            to={`/campaigns/${campaign.id}`}
            className="block bg-white rounded-lg shadow hover:shadow-md transition-shadow duration-200"
          >
            <div className="p-6">
              <div className="flex justify-between items-start">
                <div>
                  <h2 className="text-xl font-semibold text-gray-900">{campaign.name}</h2>
                  <p className="mt-1 text-sm text-gray-500 line-clamp-2">{campaign.campaign_overview}</p>
                </div>
                <span className={`px-2 py-1 text-xs font-semibold rounded-full ${
                  campaign.is_running
                    ? 'bg-green-100 text-green-800'
                    : 'bg-gray-100 text-gray-800'
                }`}>
                  {campaign.is_running ? 'Active' : 'Inactive'}
                </span>
              </div>
              
              <div className="mt-4">
                <div className="flex flex-wrap gap-2">
                  {campaign.platform?.map(platform => (
                    <span
                      key={platform}
                      className="px-2 py-1 bg-indigo-100 text-indigo-800 text-xs font-medium rounded"
                    >
                      {platform}
                    </span>
                  ))}
                </div>
              </div>

              <div className="mt-4 text-sm text-gray-500">
                Created {new Date(campaign.created_at).toLocaleDateString()}
              </div>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
};

export default CampaignDashboard;