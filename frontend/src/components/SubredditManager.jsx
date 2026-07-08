import React, { useState, useEffect } from 'react';
import api from '../utils/api';

const SubredditManager = ({ campaignId }) => {
  const [suggestions, setSuggestions] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (campaignId) fetchSuggestions();
  }, [campaignId]);

  const fetchSuggestions = async () => {
    try {
      setLoading(true);
      const response = await api.get(`/api/subreddits/${campaignId}`);
      setSuggestions(Array.isArray(response.data) ? response.data : []);
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
      setError(null);
      const response = await api.post(`/api/subreddits/${campaignId}/generate`);
      setSuggestions(Array.isArray(response.data) ? response.data : []);
    } catch (err) {
      console.error('Error generating suggestions:', err);
      setError('Failed to generate subreddit suggestions');
    } finally {
      setLoading(false);
    }
  };

  const updateSuggestionStatus = async (suggestionId, status) => {
    try {
      setLoading(true);
      const response = await fetch(`/api/subreddit-suggestions/${suggestionId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status })
      });
      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Failed to update status');
      }
      setSuggestions(prev =>
        prev.map(s => s.id === suggestionId ? { ...s, status } : s)
      );
    } catch (err) {
      console.error('Error updating suggestion:', err);
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center">
        <h3 className="section-header mb-0">Subreddit Suggestions</h3>
        <button onClick={generateSuggestions} disabled={loading} className="btn-primary text-sm">
          {loading ? 'Generating...' : 'Generate Suggestions'}
        </button>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-xl text-sm animate-fade-in">
          {error}
        </div>
      )}

      {!loading && suggestions.length === 0 && (
        <div className="text-center py-8 text-gray-400 bg-gray-50 rounded-xl">
          <svg className="w-8 h-8 mx-auto mb-2 text-gray-300" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          No suggestions yet. Click "Generate Suggestions" to get started.
        </div>
      )}

      <div className="grid gap-3">
        {suggestions.map(suggestion => (
          <div
            key={suggestion.id}
            className={`rounded-xl border-2 p-4 transition-all ${
              suggestion.status === 'approved' ? 'border-emerald-300 bg-emerald-50/50' :
              suggestion.status === 'rejected' ? 'border-red-300 bg-red-50/50' :
              'border-gray-100 bg-white hover:border-gray-200'
            }`}
          >
            <div className="flex justify-between items-start">
              <div className="flex-1 min-w-0">
                <div className="flex items-center space-x-2">
                  <h4 className="font-semibold text-gray-900">r/{suggestion.subreddit_name}</h4>
                  <span className={`badge ${
                    suggestion.status === 'approved' ? 'badge-success' :
                    suggestion.status === 'rejected' ? 'badge-danger' :
                    'badge-neutral'
                  }`}>
                    {suggestion.status || 'pending'}
                  </span>
                </div>
                <p className="text-sm text-gray-600 mt-1">{suggestion.reason}</p>
                {suggestion.subscriber_count && (
                  <p className="text-xs text-gray-400 mt-1 flex items-center">
                    <svg className="w-3.5 h-3.5 mr-1" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" />
                    </svg>
                    {suggestion.subscriber_count.toLocaleString()} subscribers
                  </p>
                )}
              </div>
              {(!suggestion.status || suggestion.status === 'pending') && (
                <div className="flex space-x-2 ml-4">
                  <button
                    onClick={() => updateSuggestionStatus(suggestion.id, 'approved')}
                    className="px-3 py-1.5 text-xs font-medium bg-emerald-500 text-white rounded-lg hover:bg-emerald-600 transition-colors"
                  >
                    Approve
                  </button>
                  <button
                    onClick={() => updateSuggestionStatus(suggestion.id, 'rejected')}
                    className="px-3 py-1.5 text-xs font-medium bg-red-500 text-white rounded-lg hover:bg-red-600 transition-colors"
                  >
                    Reject
                  </button>
                </div>
              )}
              {suggestion.status && suggestion.status !== 'pending' && (
                <button
                  onClick={() => updateSuggestionStatus(suggestion.id, 'pending')}
                  className="text-xs text-gray-400 hover:text-gray-600 ml-4 transition-colors"
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
