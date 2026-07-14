import React, { useState, useEffect } from 'react';
import api from '../utils/api';

const gradeColor = (grade) => {
  if (grade === 'A' || grade === 'B') return 'text-emerald-700 bg-emerald-50 border-emerald-200';
  if (grade === 'C') return 'text-amber-700 bg-amber-50 border-amber-200';
  return 'text-red-700 bg-red-50 border-red-200';
};

const FindingsBlock = ({ findings }) => {
  if (!findings) return <p className="text-xs text-gray-500">No findings stored for this run.</p>;
  const sections = [
    { key: 'do_more', label: 'Do more' },
    { key: 'avoid', label: 'Avoid' },
    { key: 'comment_style', label: 'Comment style' },
    { key: 'post_angles', label: 'Post angles' },
    { key: 'detection_fixes', label: 'Detection fixes' },
  ];
  return (
    <div className="space-y-2 mt-2">
      {findings.summary && <p className="text-xs text-gray-700">{findings.summary}</p>}
      {sections.map((s) => {
        const items = findings[s.key];
        if (!Array.isArray(items) || !items.length) return null;
        return (
          <div key={s.key}>
            <p className="text-[10px] font-semibold uppercase tracking-wide text-gray-400">{s.label}</p>
            <ul className="mt-0.5 space-y-0.5">
              {items.map((item, i) => (
                <li key={i} className="text-xs text-gray-600 pl-2 border-l-2 border-gray-200">
                  {item}
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </div>
  );
};

const SimRunHistory = ({ campaignId, refreshKey = 0 }) => {
  const [runs, setRuns] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [expandedId, setExpandedId] = useState(null);
  const [detail, setDetail] = useState(null);

  const load = async () => {
    try {
      setError(null);
      const { data } = await api.get(`/api/campaigns/${campaignId}/sim-runs`);
      setRuns(Array.isArray(data) ? data : []);
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    const interval = setInterval(load, 12000);
    return () => clearInterval(interval);
  }, [campaignId, refreshKey]);

  const toggle = async (runId) => {
    if (expandedId === runId) {
      setExpandedId(null);
      setDetail(null);
      return;
    }
    setExpandedId(runId);
    try {
      const { data } = await api.get(`/api/campaigns/${campaignId}/sim-runs/${runId}`);
      setDetail(data);
    } catch (err) {
      setDetail({ error: err.response?.data?.error || err.message });
    }
  };

  if (loading && !runs.length) {
    return <div className="card p-5 text-sm text-gray-500">Loading sim history…</div>;
  }

  return (
    <div className="card p-5 space-y-3">
      <div>
        <h3 className="text-sm font-semibold text-gray-900">Sim run history</h3>
        <p className="text-xs text-gray-500 mt-0.5">
          Each stop is its own scored run. Findings auto-apply to the next sim and live generation.
        </p>
      </div>

      {error && <p className="text-xs text-red-600">{error}</p>}

      {!runs.length && (
        <p className="text-xs text-gray-500">No completed simulations yet. Start and stop a sim to create a run.</p>
      )}

      <ul className="space-y-2">
        {runs.map((run) => {
          const grade = run.grade || '—';
          const score = run.overall_score != null ? Math.round(Number(run.overall_score)) : null;
          const open = expandedId === run.id;
          return (
            <li key={run.id} className="border border-gray-100 rounded-lg overflow-hidden">
              <button
                type="button"
                onClick={() => toggle(run.id)}
                className="w-full flex items-center gap-3 px-3 py-2.5 text-left hover:bg-gray-50"
              >
                <div className={`px-2 py-1 rounded-md border text-center min-w-[48px] ${gradeColor(grade)}`}>
                  <p className="text-sm font-bold leading-none">{grade}</p>
                  {score != null && <p className="text-[9px] mt-0.5">{score}</p>}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-semibold text-gray-900">Run #{run.id}</span>
                    <span className="text-[10px] uppercase tracking-wide text-gray-400">{run.status}</span>
                  </div>
                  <p className="text-[11px] text-gray-500 truncate">
                    {run.summary || (run.started_at ? new Date(run.started_at).toLocaleString() : '—')}
                  </p>
                </div>
                <span className="text-[10px] text-gray-400">{open ? 'Hide' : 'Details'}</span>
              </button>
              {open && (
                <div className="px-3 pb-3 border-t border-gray-50 bg-gray-50/50">
                  {detail?.error && <p className="text-xs text-red-600 mt-2">{detail.error}</p>}
                  {!detail?.error && (
                    <>
                      <div className="flex flex-wrap gap-2 mt-2 text-[10px] text-gray-500">
                        {detail?.started_at && (
                          <span>Started {new Date(detail.started_at).toLocaleString()}</span>
                        )}
                        {detail?.ended_at && (
                          <span>Ended {new Date(detail.ended_at).toLocaleString()}</span>
                        )}
                        {detail?.drafts_rewritten_at && (
                          <span className="text-emerald-700">Drafts rewritten</span>
                        )}
                      </div>
                      <FindingsBlock findings={detail?.findings || run.findings} />
                      {detail?.scorecard?.dimensions && (
                        <div className="mt-2 flex flex-wrap gap-1">
                          {Object.entries(detail.scorecard.dimensions).map(([k, v]) => (
                            <span key={k} className="text-[10px] px-1.5 py-0.5 rounded bg-white border border-gray-100 text-gray-600">
                              {k.replace(/_/g, ' ')}: {v}
                            </span>
                          ))}
                        </div>
                      )}
                    </>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
};

export default SimRunHistory;
