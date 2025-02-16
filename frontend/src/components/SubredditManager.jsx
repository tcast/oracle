import React, { useState, useEffect } from 'react';

const SubredditManager = ({ campaignId }) => {
  const [suggestions, setSuggestions] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (campaignId) {
      fetchSuggestions();
    }
  }, [campaignId]);

  const fetchSuggestions = async () => {
    try {
      setLoading(true);
      const response = await fetch(`/api/campaigns/${campaignId}/subreddits`);
      if (!response.ok) {
        throw new Error('Failed to fetch suggestions');
      }
      const data = await response.json();
      setSuggestions(Array.isArray(data) ? data : []);
    } catch (err) {
      console.error('Error fetching suggestions:', err);
      setError('Failed to fetch subreddit suggestions');
      setSuggestions([]);
    } finally {
      setLoading(false);
    }
  };

  const generateSuggestions = async () => {
    try {
      setLoading(true);
      const response = await fetch(`/api/campaigns/${campaignId}/generate-subreddits`, {
        method: 'POST'
      });
      if (!response.ok) {
        throw new Error('Failed to generate suggestions');
      }
      const data = await response.json();
      setSuggestions(Array.isArray(data) ? data : []);
    } catch (err) {
      console.error('Error generating suggestions:', err);
      setError('Failed to generate suggestions');
    } finally {
      setLoading(false);
    }
  };

  const updateSuggestionStatus = async (suggestionId, status) => {
    try {
      const response = await fetch(`/api/subreddit-suggestions/${suggestionId}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ status })
      });
      if (!response.ok) {
        throw new Error('Failed to update status');
      }
      const updatedSuggestion = await response.json();
      setSuggestions(prev => 
        prev.map(sug => 
          sug.id === suggestionId ? { ...sug, status } : sug
        )
      );
    } catch (err) {
      console.error('Error updating suggestion:', err);
      setError('Failed to update suggestion status');
    }
  };

  if (loading) {
    return <div className="text-center py-4">Loading suggestions...</div>;
  }

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center">
        <h3 className="text-lg font-medium">Subreddit Suggestions</h3>
        <button
          onClick={generateSuggestions}
          disabled={loading}
          className="px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600 disabled:bg-gray-400"
        >
          {loading ? 'Generating...' : 'Generate Suggestions'}
        </button>
      </div>

      {error && (
        <div className="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded">
          {error}
        </div>
      )}

      {!loading && suggestions.length === 0 && (
        <div className="text-center py-4 text-gray-500">
          No suggestions yet. Click "Generate Suggestions" to get started.
        </div>
      )}

      <div className="grid gap-4">
        {suggestions.map(suggestion => (
          <div 
            key={suggestion.id} 
            className={`p-4 rounded-lg border ${
              suggestion.status === 'approved' ? 'border-green-500 bg-green-50' :
              suggestion.status === 'rejected' ? 'border-red-500 bg-red-50' :
              'border-gray-200'
            }`}
          >
            <div className="flex justify-between items-start">
              <div>
                <h4 className="font-medium">r/{suggestion.subreddit_name}</h4>
                <p className="text-sm text-gray-600 mt-1">{suggestion.reason}</p>
                {suggestion.subscriber_count && (
                  <p className="text-sm text-gray-500 mt-1">
                    {suggestion.subscriber_count.toLocaleString()} subscribers
                  </p>
                )}
              </div>
              
              {(!suggestion.status || suggestion.status === 'pending') && (
                <div className="flex space-x-2">
                  <button
                    onClick={() => updateSuggestionStatus(suggestion.id, 'approved')}
                    className="px-3 py-1 bg-green-500 text-white rounded hover:bg-green-600"
                  >
                    Approve
                  </button>
                  <button
                    onClick={() => updateSuggestionStatus(suggestion.id, 'rejected')}
                    className="px-3 py-1 bg-red-500 text-white rounded hover:bg-red-600"
                  >
                    Reject
                  </button>
                </div>
              )}
              
              {suggestion.status && suggestion.status !== 'pending' && (
                <button
                  onClick={() => updateSuggestionStatus(suggestion.id, 'pending')}
                  className="text-sm text-gray-500 hover:text-gray-700"
                >
                  Reset
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

export default SubredditManager;