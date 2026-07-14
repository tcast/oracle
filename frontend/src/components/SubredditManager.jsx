import React, { useState, useEffect } from 'react';
import api from '../utils/api';

const SubredditRow = ({ suggestion, onUpdateStatus }) => {
  const pending = !suggestion.status || suggestion.status === 'pending';
  return (
    <div className={`flex items-center gap-2 px-3 py-2 rounded-lg border text-sm ${
      suggestion.status === 'approved' ? 'border-emerald-200 bg-emerald-50/60' :
      suggestion.status === 'rejected' ? 'border-red-100 bg-red-50/40 opacity-60' :
      'border-gray-100 bg-white hover:border-gray-200'
    }`}>
      <span className="font-semibold text-gray-900 whitespace-nowrap">r/{suggestion.subreddit_name}</span>
      <p className="flex-1 text-xs text-gray-500 truncate min-w-0">{suggestion.reason}</p>
      {pending && (
        <div className="flex gap-1 flex-shrink-0">
          <button type="button" onClick={() => onUpdateStatus(suggestion.id, 'approved')} className="p-1.5 rounded-md bg-emerald-500 text-white hover:bg-emerald-600" title="Approve">
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" /></svg>
          </button>
          <button type="button" onClick={() => onUpdateStatus(suggestion.id, 'rejected')} className="p-1.5 rounded-md border border-red-200 text-red-500 hover:bg-red-50" title="Reject">
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
          </button>
        </div>
      )}
      {suggestion.status === 'approved' && (
        <button onClick={() => onUpdateStatus(suggestion.id, 'pending')} className="text-[10px] text-emerald-700 hover:underline flex-shrink-0">Remove</button>
      )}
      {suggestion.status === 'rejected' && (
        <button onClick={() => onUpdateStatus(suggestion.id, 'pending')} className="text-[10px] text-gray-400 hover:underline flex-shrink-0">Restore</button>
      )}
    </div>
  );
};

const SubredditManager = ({ campaignId, embedded = false, onCountsChange }) => {
  const [suggestions, setSuggestions] = useState([]);
  const [personasBySub, setPersonasBySub] = useState({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [refineHint, setRefineHint] = useState('');
  const [showManualAdd, setShowManualAdd] = useState(false);
  const [manualName, setManualName] = useState('');
  const [showRejected, setShowRejected] = useState(false);

  const approved = suggestions.filter(s => s.status === 'approved');
  const pending = suggestions.filter(s => !s.status || s.status === 'pending');
  const rejected = suggestions.filter(s => s.status === 'rejected');

  useEffect(() => {
    if (campaignId) fetchSuggestions();
  }, [campaignId]);

  const fetchPersonas = async () => {
    try {
      const { data } = await api.get(`/api/campaigns/${campaignId}/personas`);
      const map = {};
      (Array.isArray(data) ? data : []).forEach((row) => {
        if (row.scope_type === 'subreddit') {
          map[String(row.scope_key).toLowerCase()] = row.persona?.summary || row.persona?.tone;
        }
      });
      setPersonasBySub(map);
    } catch {
      /* non-critical */
    }
  };

  const fetchSuggestions = async () => {
    try {
      setLoading(true);
      const { data } = await api.get(`/api/subreddits/${campaignId}`);
      setSuggestions(Array.isArray(data) ? data : []);
      onCountsChange?.();
      fetchPersonas();
    } catch (err) {
      setError('Failed to load subreddits');
      setSuggestions([]);
    } finally {
      setLoading(false);
    }
  };

  const mergeSuggestions = (response) => {
    if (response.data?.all) setSuggestions(response.data.all);
    else if (Array.isArray(response.data)) setSuggestions(response.data);
    onCountsChange?.();
  };

  const generateSuggestions = async () => {
    try {
      setLoading(true);
      setError(null);
      const response = await api.post(`/api/subreddits/${campaignId}/generate`);
      mergeSuggestions(response);
    } catch (err) {
      setError(err.response?.data?.error || 'Generate failed');
    } finally {
      setLoading(false);
    }
  };

  const refineSuggestions = async () => {
    try {
      setLoading(true);
      setError(null);
      const response = await api.post(`/api/subreddits/${campaignId}/refine`, {
        seedSubreddits: approved.map(s => s.subreddit_name),
        hint: refineHint.trim(),
      });
      mergeSuggestions(response);
    } catch (err) {
      setError(err.response?.data?.error || 'Refine failed');
    } finally {
      setLoading(false);
    }
  };

  const addManualSubreddit = async (e) => {
    e.preventDefault();
    if (!manualName.trim()) return;
    try {
      setLoading(true);
      const { data } = await api.post(`/api/subreddits/${campaignId}/add`, { subreddit_name: manualName.trim() });
      setSuggestions(prev => [...prev, data]);
      setManualName('');
      setShowManualAdd(false);
      onCountsChange?.();
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setLoading(false);
    }
  };

  const updateSuggestionStatus = async (suggestionId, status) => {
    const previous = suggestions.find(s => s.id === suggestionId);
    // Optimistic update so the row moves immediately
    setSuggestions(prev => prev.map(s => (s.id === suggestionId ? { ...s, status } : s)));
    setError(null);
    try {
      const { data } = await api.patch(`/api/subreddits/subreddit-suggestions/${suggestionId}`, { status });
      setSuggestions(prev => prev.map(s => (s.id === suggestionId ? { ...s, ...data } : s)));
      onCountsChange?.();
      if (status === 'approved') {
        // Persona generates in background on approve
        setTimeout(fetchPersonas, 2500);
      } else {
        fetchPersonas();
      }
    } catch (err) {
      if (previous) {
        setSuggestions(prev => prev.map(s => (s.id === suggestionId ? previous : s)));
      }
      setError(err.response?.data?.error || 'Update failed');
    }
  };

  return (
    <div className={embedded ? 'space-y-3' : 'space-y-6'}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className={`font-semibold text-gray-900 ${embedded ? 'text-sm' : 'section-header mb-0'}`}>
          Subreddits {approved.length > 0 && <span className="text-emerald-600 font-normal">({approved.length} saved)</span>}
        </h3>
        <div className="flex flex-wrap gap-1.5">
          <button onClick={generateSuggestions} disabled={loading} className="btn-primary text-xs px-2.5 py-1.5">
            {loading ? '…' : 'Generate'}
          </button>
          <button onClick={refineSuggestions} disabled={loading || !approved.length} className="btn-secondary text-xs px-2.5 py-1.5 disabled:opacity-40" title="Find more like approved">
            Refine
          </button>
          <button onClick={() => setShowManualAdd(v => !v)} className="btn-secondary text-xs px-2.5 py-1.5">+ Add</button>
        </div>
      </div>

      {approved.length > 0 && (
        <input
          type="text"
          value={refineHint}
          onChange={(e) => setRefineHint(e.target.value)}
          placeholder="Refine hint (optional)…"
          className="input-field text-xs py-1.5"
        />
      )}

      {showManualAdd && (
        <form onSubmit={addManualSubreddit} className="flex gap-2">
          <div className="flex flex-1">
            <span className="inline-flex items-center px-2 rounded-l-lg border border-r-0 border-gray-200 bg-gray-100 text-gray-500 text-xs">r/</span>
            <input value={manualName} onChange={(e) => setManualName(e.target.value)} className="input-field rounded-l-none text-sm flex-1" placeholder="subreddit" autoFocus />
          </div>
          <button type="submit" disabled={!manualName.trim()} className="btn-primary text-xs px-3">Add</button>
        </form>
      )}

      {error && <p className="text-xs text-red-600 bg-red-50 px-2 py-1.5 rounded-lg">{error}</p>}

      {approved.length > 0 && (
        <div className="space-y-1.5">
          <div className="flex flex-wrap gap-1.5">
            {approved.map(s => (
              <span key={s.id} className="inline-flex items-center gap-1 pl-2.5 pr-1 py-1 rounded-full bg-emerald-100 text-emerald-800 text-xs font-medium">
                r/{s.subreddit_name}
                <button onClick={() => updateSuggestionStatus(s.id, 'pending')} className="p-0.5 rounded-full hover:bg-emerald-200/80 text-emerald-700">
                  <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
                </button>
              </span>
            ))}
          </div>
          {approved.some(s => personasBySub[s.subreddit_name.toLowerCase()]) && (
            <div className="space-y-0.5">
              {approved.map(s => {
                const summary = personasBySub[s.subreddit_name.toLowerCase()];
                if (!summary) return null;
                return (
                  <p key={`p-${s.id}`} className="text-[10px] text-gray-500 truncate">
                    <span className="font-medium text-gray-600">r/{s.subreddit_name}:</span> {summary}
                  </p>
                );
              })}
            </div>
          )}
        </div>
      )}

      <div className="space-y-1">
        {pending.length === 0 && !loading && suggestions.length === 0 && (
          <p className="text-xs text-gray-400 py-6 text-center">Generate subreddit suggestions to start</p>
        )}
        {pending.length === 0 && suggestions.length > 0 && (
          <p className="text-xs text-gray-400 py-2 text-center">All reviewed</p>
        )}
        {pending.map(s => (
          <SubredditRow key={s.id} suggestion={s} onUpdateStatus={updateSuggestionStatus} />
        ))}
      </div>

      {rejected.length > 0 && (
        <button onClick={() => setShowRejected(v => !v)} className="text-xs text-gray-400 hover:text-gray-600">
          {showRejected ? '▼' : '▶'} Rejected ({rejected.length})
        </button>
      )}
      {showRejected && rejected.map(s => (
        <SubredditRow key={s.id} suggestion={s} onUpdateStatus={updateSuggestionStatus} />
      ))}
    </div>
  );
};

export default SubredditManager;
