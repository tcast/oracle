import React, { useEffect, useState } from 'react';
import api from '../utils/api';

const PLATFORM_OPTS = [
  { id: 'x', label: 'X (Twitter)' },
  { id: 'instagram', label: 'Instagram' },
  { id: 'tiktok', label: 'TikTok' },
  { id: 'linkedin', label: 'LinkedIn' },
];

const ImportAccountsForm = ({ onClose, onSuccess, initialPlatform = 'x' }) => {
  const [platform, setPlatform] = useState(initialPlatform);
  const [text, setText] = useState('');
  const [formats, setFormats] = useState({});
  const [verify, setVerify] = useState(true);
  const [enableOrganic, setEnableOrganic] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await api.get('/api/social-accounts/import/formats');
        if (!cancelled) setFormats(res.data?.formats || {});
      } catch {
        /* ignore — formats are optional help */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const res = await api.post('/api/social-accounts/import', {
        platform,
        text,
        verify,
        enableOrganic,
        max: 25,
        verifyLimit: 3,
      });
      setResult(res.data);
      if (res.data?.imported?.length) {
        onSuccess?.(res.data);
      }
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="bg-white rounded-2xl shadow-xl border border-gray-100 p-6 max-w-2xl w-full">
      <div className="flex items-start justify-between mb-4">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">Import accounts</h2>
          <p className="text-sm text-gray-500 mt-1">
            Paste a vendor dump. We assign proxies, verify sessions carefully, and enable organic when live.
          </p>
        </div>
        <button type="button" onClick={onClose} className="text-gray-400 hover:text-gray-600">
          ✕
        </button>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="label">Platform</label>
          <select
            className="input-field"
            value={platform}
            onChange={(e) => setPlatform(e.target.value)}
          >
            {PLATFORM_OPTS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="label">Expected format</label>
          <code className="block text-xs bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-slate-700 break-all">
            {formats[platform] || 'Loading…'}
          </code>
        </div>

        <div>
          <label className="label">Account dump</label>
          <textarea
            className="input-field font-mono text-xs min-h-[160px]"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="One account per line…"
            required
          />
        </div>

        <div className="flex flex-wrap gap-4 text-sm text-gray-700">
          <label className="inline-flex items-center gap-2">
            <input
              type="checkbox"
              checked={verify}
              onChange={(e) => setVerify(e.target.checked)}
              className="rounded border-gray-300"
            />
            Verify sessions (max 3, staggered)
          </label>
          <label className="inline-flex items-center gap-2">
            <input
              type="checkbox"
              checked={enableOrganic}
              onChange={(e) => setEnableOrganic(e.target.checked)}
              className="rounded border-gray-300"
            />
            Enable organic when verify succeeds
          </label>
        </div>

        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-xl text-sm">
            {error}
          </div>
        )}

        {result && (
          <div className="bg-slate-50 border border-slate-200 text-slate-700 px-4 py-3 rounded-xl text-sm space-y-1">
            <div>{result.message}</div>
            <div>
              Imported {result.imported?.length || 0} · failed {result.failed?.length || 0} ·
              verified live{' '}
              {(result.verified || []).filter((v) => v.success).length}/
              {(result.verified || []).length}
            </div>
            {(result.failed || []).slice(0, 5).map((f) => (
              <div key={`${f.line}-${f.error}`} className="text-amber-700 text-xs">
                Line {f.line}: {f.error}
              </div>
            ))}
          </div>
        )}

        <div className="flex justify-end gap-3 pt-4 border-t border-gray-100">
          <button type="button" onClick={onClose} className="btn-secondary">
            Close
          </button>
          <button type="submit" disabled={loading || !text.trim()} className="btn-primary">
            {loading ? 'Importing…' : 'Import'}
          </button>
        </div>
      </form>
    </div>
  );
};

export default ImportAccountsForm;
