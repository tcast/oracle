import React, { useState, useEffect } from 'react';
import api from '../utils/api';

const AudiencePersonasPanel = ({ campaignId }) => {
  const [personas, setPersonas] = useState([]);
  const [expanded, setExpanded] = useState(null);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState(null);

  const load = async () => {
    try {
      setError(null);
      const { data } = await api.get(`/api/campaigns/${campaignId}/personas`);
      setPersonas(Array.isArray(data) ? data : []);
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [campaignId]);

  const regenerate = async () => {
    try {
      setGenerating(true);
      setError(null);
      const { data } = await api.post(`/api/campaigns/${campaignId}/personas/generate`, {});
      setPersonas(data.all || data.added || []);
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setGenerating(false);
    }
  };

  if (loading) {
    return <div className="card p-5 text-sm text-gray-500">Loading personas…</div>;
  }

  return (
    <div className="card p-5 space-y-3">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-gray-900">Audience personas</h3>
          <p className="text-xs text-gray-500 mt-0.5">
            Per-subreddit models of cynical Reddit audiences — used for drafts, comments, and sim scoring.
          </p>
        </div>
        <button
          onClick={regenerate}
          disabled={generating}
          className="btn-secondary text-xs px-2.5 py-1.5 whitespace-nowrap disabled:opacity-50"
        >
          {generating ? '…' : 'Regenerate'}
        </button>
      </div>

      {error && <p className="text-xs text-red-600 bg-red-50 px-2 py-1.5 rounded-lg">{error}</p>}

      {personas.length === 0 ? (
        <p className="text-xs text-amber-700 bg-amber-50 px-3 py-2 rounded-lg">
          No personas yet. Approve subreddits (auto-generates) or hit Regenerate.
        </p>
      ) : (
        <div className="space-y-1.5">
          {personas.map((row) => {
            const p = row.persona || {};
            const key = `${row.scope_type}:${row.scope_key}`;
            const open = expanded === key;
            return (
              <div key={row.id || key} className="rounded-lg border border-gray-100 overflow-hidden">
                <button
                  type="button"
                  onClick={() => setExpanded(open ? null : key)}
                  className="w-full flex items-center gap-2 px-2.5 py-2 text-left hover:bg-gray-50"
                >
                  <span className="text-xs font-semibold text-gray-900">
                    {row.scope_type === 'subreddit' ? `r/${row.scope_key}` : row.scope_key}
                  </span>
                  <span className="text-[10px] text-gray-400 truncate flex-1">{p.summary || p.tone}</span>
                  <span className="text-[10px] text-gray-500">
                    skep {(Number(p.skepticism) || 0).toFixed(2)}
                  </span>
                </button>
                {open && (
                  <div className="px-2.5 pb-2.5 space-y-1.5 border-t border-gray-50 pt-2 text-xs text-gray-600">
                    <p><span className="font-medium text-gray-800">Tone:</span> {p.tone}</p>
                    <p><span className="font-medium text-gray-800">Hooks:</span> {(p.hooks || []).join('; ') || '—'}</p>
                    <p><span className="font-medium text-gray-800">Taboos:</span> {(p.taboos || []).join('; ') || '—'}</p>
                    <p><span className="font-medium text-gray-800">Works:</span> {(p.what_works || []).join('; ') || '—'}</p>
                    <p><span className="font-medium text-gray-800">Fails:</span> {(p.what_fails || []).join('; ') || '—'}</p>
                    {p.jargon?.length > 0 && (
                      <p><span className="font-medium text-gray-800">Jargon:</span> {p.jargon.join(', ')}</p>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

export default AudiencePersonasPanel;
