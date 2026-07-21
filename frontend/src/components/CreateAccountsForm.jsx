import React, { useEffect, useState } from 'react';
import api from '../utils/api';

const READINESS_LABEL = {
  ready: { text: 'Ready', className: 'bg-emerald-50 text-emerald-700' },
  needs_accounts_bought: { text: 'Buy + import', className: 'bg-amber-50 text-amber-700' },
  import_ready: { text: 'Import ready', className: 'bg-sky-50 text-sky-700' },
  not_implemented: { text: 'Import only', className: 'bg-gray-100 text-gray-600' },
  blocked: { text: 'Blocked', className: 'bg-red-50 text-red-700' },
};

const CreateAccountsForm = ({ onClose, onSuccess }) => {
  const [formData, setFormData] = useState({
    platform: 'reddit',
    count: 1,
    useEmailPool: true,
    usernamePrefix: '',
    emailDomain: '',
    warm: true,
  });
  const [eligibility, setEligibility] = useState(null);
  const [loading, setLoading] = useState(false);
  const [loadingElig, setLoadingElig] = useState(true);
  const [error, setError] = useState(null);
  const [resultSummary, setResultSummary] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await api.get('/api/social-accounts/create/eligibility');
        if (!cancelled) setEligibility(res.data);
      } catch (err) {
        if (!cancelled) setError(err.response?.data?.error || err.message);
      } finally {
        if (!cancelled) setLoadingElig(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const selectedMeta = eligibility?.platforms?.find((p) => p.platform === formData.platform);
  const maxCount = formData.useEmailPool ? Math.min(5, eligibility?.max_batch || 5) : 3;
  const isReadySelfCreate = selectedMeta?.readiness === 'ready' && selectedMeta?.selfCreate;

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setResultSummary(null);
    try {
      const payload = {
        platform: formData.platform,
        count: Math.min(formData.count, maxCount),
        useEmailPool: formData.useEmailPool,
        warm: formData.warm,
      };
      if (formData.useEmailPool) {
        if (formData.usernamePrefix) payload.usernamePrefix = formData.usernamePrefix;
      } else {
        payload.emailDomain = formData.emailDomain;
        payload.usernamePrefix = formData.usernamePrefix;
      }
      const response = await api.post('/api/social-accounts/create', payload);
      const data = response.data;
      const created = data.created?.length || data.accounts?.length || 0;
      const failed = (data.errors?.length || 0) + (data.blocked?.length || 0);
      setResultSummary({
        created,
        failed,
        skipped: data.skipped?.length || 0,
        mode: data.mode,
        message: data.message,
      });
      if (created > 0 || onSuccess) {
        onSuccess?.(data);
      }
      if (created > 0 && failed === 0 && !data.message) {
        onClose();
      }
    } catch (err) {
      setError(
        err.response?.data?.error ||
          err.response?.data?.message ||
          err.message ||
          'Failed to create accounts'
      );
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-5">
        <h3 className="text-lg font-semibold text-gray-900">Create Social Accounts</h3>
        <button onClick={onClose} className="text-gray-400 hover:text-gray-600 p-1 rounded-lg hover:bg-gray-100">
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      {loadingElig ? (
        <p className="text-sm text-gray-500 mb-4">Checking eligibility…</p>
      ) : eligibility ? (
        <div className="mb-4 rounded-xl border border-gray-100 bg-gray-50 px-3 py-2 text-xs text-gray-600 space-y-1">
          <div>
            Email pool: <strong>{eligibility.email_pool?.available ?? 0}</strong> available
            ({eligibility.email_pool?.catchall ?? 0} catchall)
            {' · '}
            Healthy US proxies: <strong>{eligibility.proxies?.healthy_us ?? 0}</strong>
          </div>
          {eligibility.batch_running ? (
            <div className="text-amber-700">A create batch is already running — wait for it to finish.</div>
          ) : null}
          <div className="flex flex-wrap gap-1.5 pt-1">
            {(eligibility.platforms || []).map((p) => {
              const badge = READINESS_LABEL[p.readiness] || READINESS_LABEL.not_implemented;
              return (
                <span
                  key={p.platform}
                  className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 ${badge.className}`}
                >
                  <span className="capitalize font-medium">{p.platform}</span>
                  <span>{badge.text}</span>
                  <span className="opacity-70">{p.today?.created ?? 0}/{p.today?.attempted ?? 0} today</span>
                </span>
              );
            })}
          </div>
        </div>
      ) : null}

      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="label">Platform</label>
          <select
            value={formData.platform}
            onChange={(e) => setFormData({ ...formData, platform: e.target.value })}
            className="input-field"
          >
            {(eligibility?.platforms || [
              { platform: 'reddit' },
              { platform: 'x' },
              { platform: 'instagram' },
              { platform: 'tiktok' },
              { platform: 'linkedin' },
            ]).map((p) => (
              <option key={p.platform} value={p.platform}>
                {p.label || p.platform}
                {p.readiness && p.readiness !== 'ready' ? ` (${p.readiness.replace(/_/g, ' ')})` : ''}
              </option>
            ))}
          </select>
          {selectedMeta?.notes ? (
            <p className="mt-1 text-xs text-gray-500">{selectedMeta.notes}</p>
          ) : null}
        </div>

        <div>
          <label className="label">Number of Accounts</label>
          <input
            type="number"
            min="1"
            max={maxCount}
            value={formData.count}
            onChange={(e) =>
              setFormData({ ...formData, count: Math.min(maxCount, parseInt(e.target.value, 10) || 1) })
            }
            className="input-field"
          />
          <p className="mt-1 text-xs text-gray-500">
            Controlled batch: max {maxCount} · serial · healthy proxies only
          </p>
        </div>

        <div className="flex items-center gap-2">
          <input
            id="useEmailPool"
            type="checkbox"
            checked={formData.useEmailPool}
            onChange={(e) => setFormData({ ...formData, useEmailPool: e.target.checked })}
            className="rounded border-gray-300"
            disabled={formData.platform !== 'reddit'}
          />
          <label htmlFor="useEmailPool" className="text-sm text-gray-700">
            Use durable email from Email Accounts pool (recommended)
          </label>
        </div>

        {formData.useEmailPool && formData.platform === 'reddit' && (
          <div className="flex items-center gap-2">
            <input
              id="warmAfter"
              type="checkbox"
              checked={formData.warm}
              onChange={(e) => setFormData({ ...formData, warm: e.target.checked })}
              className="rounded border-gray-300"
            />
            <label htmlFor="warmAfter" className="text-sm text-gray-700">
              Warm account after create
            </label>
          </div>
        )}

        {!formData.useEmailPool && (
          <div>
            <label className="label">Email Domain</label>
            <div className="flex rounded-lg shadow-sm">
              <span className="inline-flex items-center px-3 rounded-l-lg border border-r-0 border-gray-200 bg-gray-50 text-gray-500 text-sm">@</span>
              <input
                type="text"
                value={formData.emailDomain}
                onChange={(e) => setFormData({ ...formData, emailDomain: e.target.value })}
                placeholder="example.com"
                className="flex-1 min-w-0 block w-full px-3 py-2 rounded-none rounded-r-lg border-gray-200 focus:border-whisper-500 focus:ring-whisper-500 sm:text-sm"
                required={!formData.useEmailPool}
              />
            </div>
          </div>
        )}

        <div>
          <label className="label">Username Prefix {formData.useEmailPool ? '(optional)' : ''}</label>
          <input
            type="text"
            value={formData.usernamePrefix}
            onChange={(e) => setFormData({ ...formData, usernamePrefix: e.target.value })}
            placeholder="user"
            className="input-field"
            required={!formData.useEmailPool}
          />
        </div>

        {selectedMeta && !isReadySelfCreate && (
          <div className="bg-amber-50 border border-amber-200 text-amber-800 px-4 py-3 rounded-xl text-sm">
            {selectedMeta.readiness === 'import_ready' || selectedMeta.readiness === 'needs_accounts_bought'
              ? `Use Import for ${formData.platform} (paste dump → verify → organic). Self-create stays gated.`
              : `Self-create is gated for ${formData.platform}. Submitting will record a skipped attempt for NOC (no mass create). Prefer buying/importing accounts.`}
          </div>
        )}

        {selectedMeta && isReadySelfCreate && !selectedMeta.can_self_create && (
          <div className="bg-amber-50 border border-amber-200 text-amber-800 px-4 py-3 rounded-xl text-sm">
            Reddit create is ready but eligibility is low (need email pool + healthy US proxy).
            Fix resources before launching a batch.
          </div>
        )}

        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-xl text-sm animate-fade-in">
            {error}
          </div>
        )}

        {resultSummary && (
          <div className="bg-slate-50 border border-slate-200 text-slate-700 px-4 py-3 rounded-xl text-sm">
            Created {resultSummary.created} · failed {resultSummary.failed} · skipped {resultSummary.skipped}
            {resultSummary.message ? ` — ${resultSummary.message}` : ''}
          </div>
        )}

        <div className="flex justify-end space-x-3 pt-4 border-t border-gray-100">
          <button type="button" onClick={onClose} className="btn-secondary">Cancel</button>
          <button
            type="submit"
            disabled={
              loading ||
              eligibility?.batch_running ||
              (isReadySelfCreate && !selectedMeta?.can_self_create)
            }
            className="btn-primary"
          >
            {loading ? 'Creating…' : isReadySelfCreate ? 'Create Accounts' : 'Record gated attempt'}
          </button>
        </div>
      </form>
    </div>
  );
};

export default CreateAccountsForm;
