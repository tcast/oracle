import React, { useState, useEffect } from 'react';

const NetworkSelector = ({ onNetworksChange, campaign }) => {
  const [selectedNetworks, setSelectedNetworks] = useState([]);
  const [subredditSuggestions, setSubredditSuggestions] = useState([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (campaign?.campaign_goal && isRedditSelected()) {
      fetchSubredditSuggestions();
    }
  }, [campaign?.campaign_goal]);

  const fetchSubredditSuggestions = async () => {
    try {
      setLoading(true);
      const response = await fetch('/api/subreddit-suggestions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ 
          goal: campaign.campaign_goal, 
          target_sentiment: campaign.target_sentiment 
        }),
      });
      const data = await response.json();
      setSubredditSuggestions(data);
    } catch (error) {
      console.error('Error fetching subreddit suggestions:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleNetworkToggle = (networkType) => {
    const newSelection = selectedNetworks.includes(networkType)
      ? selectedNetworks.filter(n => n !== networkType)
      : [...selectedNetworks, networkType];
    
    setSelectedNetworks(newSelection);
    onNetworksChange(newSelection);
  };

  const isRedditSelected = () => selectedNetworks.includes('reddit');

  return (
    <div className="space-y-4">
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-2">
          Select Social Networks
        </label>
        <div className="space-y-2">
          {['reddit', 'linkedin', 'x'].map(network => (
            <div key={network} className="flex items-center">
              <input
                type="checkbox"
                id={network}
                checked={selectedNetworks.includes(network)}
                onChange={() => handleNetworkToggle(network)}
                className="h-4 w-4 text-indigo-600 focus:ring-indigo-500 border-gray-300 rounded"
              />
              <label htmlFor={network} className="ml-2 block text-sm text-gray-900 capitalize">
                {network === 'x' ? 'X (Twitter)' : network}
              </label>
            </div>
          ))}
        </div>
      </div>

      {isRedditSelected() && (
        <div className="mt-4">
          <label className="block text-sm font-medium text-gray-700 mb-2">
            Suggested Subreddits
          </label>
          <div className="max-h-60 overflow-y-auto border rounded-md p-2">
            {loading ? (
              <div className="text-center py-2 text-gray-500">Loading suggestions...</div>
            ) : subredditSuggestions.length > 0 ? (
              subredditSuggestions.map((subreddit, index) => (
                <div key={index} className="p-2 hover:bg-gray-50 rounded">
                  <div className="font-medium">r/{subreddit.name}</div>
                  <div className="text-sm text-gray-600">{subreddit.reason}</div>
                </div>
              ))
            ) : (
              <div className="text-center py-2 text-gray-500">
                Enter a campaign goal to get subreddit suggestions
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default NetworkSelector;
