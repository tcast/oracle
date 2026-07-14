import React, { useState, useEffect } from 'react';
import api from '../utils/api';

const DIMENSIONS = [
  { key: 'reach', label: 'Reach' },
  { key: 'conversation', label: 'Conversation' },
  { key: 'sentiment', label: 'Sentiment' },
  { key: 'reception', label: 'Post reception' },
  { key: 'objective_fit', label: 'Objective fit' },
  { key: 'community_trust', label: 'Community trust' },
  { key: 'stealth', label: 'Stealth (anti-detect)' },
  { key: 'risk', label: 'Safety (inverse risk)' },
];

const gradeColor = (grade) => {
  if (grade === 'A' || grade === 'B') return 'text-emerald-700 bg-emerald-50 border-emerald-200';
  if (grade === 'C') return 'text-amber-700 bg-amber-50 border-amber-200';
  return 'text-red-700 bg-red-50 border-red-200';
};

const barColor = (n) => {
  if (n >= 75) return 'bg-emerald-500';
  if (n >= 55) return 'bg-amber-500';
  return 'bg-red-500';
};

const CampaignScorecard = ({ campaignId, refreshKey = 0 }) => {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = async () => {
    try {
      setError(null);
      const { data: res } = await api.get(`/api/campaigns/${campaignId}/scorecard`);
      setData(res);
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    const interval = setInterval(load, 8000);
    return () => clearInterval(interval);
  }, [campaignId, refreshKey]);

  if (loading && !data) {
    return <div className="card p-5 text-sm text-gray-500">Loading scorecard…</div>;
  }

  const sc = data?.scorecard;
  if (!sc) {
    return (
      <div className="card p-5 space-y-2">
        <h3 className="text-sm font-semibold text-gray-900">Sim scorecard</h3>
        <p className="text-xs text-gray-500">Run a simulation to score messaging against objectives.</p>
        {error && <p className="text-xs text-red-600">{error}</p>}
      </div>
    );
  }

  const mix = sc.stats?.reception_mix || {};
  const commentMix = sc.stats?.comment_reception_mix || {};
  const rep = sc.reputation || {};
  const comps = rep.components || {};

  return (
    <div className="card p-5 space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold text-gray-900">Sim scorecard</h3>
            <span className="text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded bg-whisper-100 text-whisper-700">
              Sim only
            </span>
            {data.live_preview && (
              <span className="text-[10px] text-blue-700 bg-blue-50 px-1.5 py-0.5 rounded">Live preview</span>
            )}
          </div>
          <p className="text-xs text-gray-500 mt-0.5 line-clamp-2">
            {sc.objectives?.campaign_goal || 'Campaign objective'}
          </p>
        </div>
        <div className={`px-3 py-2 rounded-xl border text-center min-w-[64px] ${gradeColor(sc.grade)}`}>
          <p className="text-2xl font-bold leading-none">{sc.grade}</p>
          <p className="text-[10px] mt-0.5">{sc.overall}/100</p>
        </div>
      </div>

      {data?.active_learnings && (
        <div className="rounded-lg border border-whisper-100 bg-whisper-50/60 px-3 py-2 space-y-1">
          <div className="flex items-center gap-2">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-whisper-700">
              Active learnings
              {data.active_learnings_run_id ? ` from Run #${data.active_learnings_run_id}` : ''}
            </p>
            <span className="text-[9px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded bg-whisper-100 text-whisper-700">
              Auto-applied
            </span>
          </div>
          {data.active_learnings.summary && (
            <p className="text-xs text-gray-700">{data.active_learnings.summary}</p>
          )}
          {(data.active_learnings.avoid || []).slice(0, 2).map((a) => (
            <p key={a} className="text-[11px] text-gray-600">Avoid: {a}</p>
          ))}
          {(data.active_learnings.do_more || []).slice(0, 2).map((a) => (
            <p key={a} className="text-[11px] text-gray-600">Do more: {a}</p>
          ))}
        </div>
      )}

      <div className="grid grid-cols-2 gap-2">
        <div className="rounded-lg border border-emerald-100 bg-emerald-50/50 px-3 py-2 text-center">
          <p className="text-lg font-bold text-emerald-800">{rep.community_trust ?? sc.dimensions?.community_trust ?? '—'}</p>
          <p className="text-[10px] uppercase tracking-wide text-emerald-700">Community trust</p>
        </div>
        <div className="rounded-lg border border-red-100 bg-red-50/50 px-3 py-2 text-center">
          <p className="text-lg font-bold text-red-800">{rep.detection_risk ?? '—'}</p>
          <p className="text-[10px] uppercase tracking-wide text-red-700">Detection risk</p>
        </div>
      </div>

      <div className="space-y-2">
        {DIMENSIONS.map(d => {
          const val = sc.dimensions?.[d.key] ?? 0;
          return (
            <div key={d.key}>
              <div className="flex justify-between text-[11px] mb-0.5">
                <span className="text-gray-600">{d.label}</span>
                <span className="font-medium text-gray-900">{val}</span>
              </div>
              <div className="h-1.5 rounded-full bg-gray-100 overflow-hidden">
                <div className={`h-full rounded-full ${barColor(val)}`} style={{ width: `${val}%` }} />
              </div>
            </div>
          );
        })}
      </div>

      <div className="grid grid-cols-3 gap-2 text-center">
        <div className="bg-gray-50 rounded-lg px-2 py-1.5 border border-gray-100">
          <p className="text-sm font-bold text-gray-900">{sc.stats?.posts ?? 0}</p>
          <p className="text-[10px] text-gray-500">Posts</p>
        </div>
        <div className="bg-gray-50 rounded-lg px-2 py-1.5 border border-gray-100">
          <p className="text-sm font-bold text-gray-900">{sc.stats?.comments ?? 0}</p>
          <p className="text-[10px] text-gray-500">Comments</p>
        </div>
        <div className="bg-gray-50 rounded-lg px-2 py-1.5 border border-gray-100">
          <p className="text-sm font-bold text-gray-900">
            {typeof sc.stats?.mean_sentiment === 'number' ? sc.stats.mean_sentiment.toFixed(2) : '—'}
          </p>
          <p className="text-[10px] text-gray-500">Sentiment</p>
        </div>
      </div>

      <div>
        <p className="text-[10px] font-semibold uppercase tracking-wide text-gray-400 mb-1">Post reception</p>
        <div className="flex flex-wrap gap-1">
          {Object.entries(mix).map(([k, v]) => (
            <span key={k} className="text-[10px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-600">
              {k}: {v}
            </span>
          ))}
        </div>
      </div>

      {Object.keys(commentMix).length > 0 && (
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-wide text-gray-400 mb-1">Comment reception</p>
          <div className="flex flex-wrap gap-1">
            {Object.entries(commentMix).map(([k, v]) => (
              <span key={k} className="text-[10px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-600">
                {k}: {v}
              </span>
            ))}
          </div>
        </div>
      )}

      <div className="rounded-lg border border-gray-100 bg-gray-50/80 px-3 py-2 space-y-1">
        <p className="text-[10px] font-semibold uppercase tracking-wide text-gray-400">Detection breakdown</p>
        <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[11px] text-gray-600">
          <span>AI likeness</span>
          <span className="text-right font-medium text-gray-900">{comps.avg_ai_likeness ?? sc.stats?.avg_ai_likeness ?? '—'}</span>
          <span>Spam score</span>
          <span className="text-right font-medium text-gray-900">{comps.avg_spam_score ?? sc.stats?.avg_spam_score ?? '—'}</span>
          <span>Coordination</span>
          <span className="text-right font-medium text-gray-900">{comps.coordination_score ?? sc.stats?.coordination_score ?? '—'}</span>
          <span>Voice similarity</span>
          <span className="text-right font-medium text-gray-900">{comps.voice_similarity ?? '—'}</span>
        </div>
      </div>

      {sc.risks?.length > 0 && (
        <div className="space-y-1">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-gray-400">Risks / notes</p>
          {sc.risks.slice(0, 6).map((r) => (
            <p key={r} className="text-xs text-gray-600">• {r}</p>
          ))}
        </div>
      )}

      {error && <p className="text-xs text-red-600">{error}</p>}
      <button onClick={load} className="text-xs text-whisper-700 hover:underline">Refresh score</button>
    </div>
  );
};

export default CampaignScorecard;
