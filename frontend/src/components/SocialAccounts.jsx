import React, { useState, useEffect } from 'react';
import CreateAccountsForm from './CreateAccountsForm';
import OrganicCommentsPanel from './OrganicCommentsPanel';
import api from '../utils/api';

const TABS = [
  { id: 'users', label: 'Users' },
  { id: 'schedule', label: 'Schedule' },
  { id: 'log', label: 'Log' },
];

const fmt = (n) => (n == null ? '—' : Number(n).toLocaleString());

const SocialAccounts = () => {
  const [tab, setTab] = useState(() => {
    const q = new URLSearchParams(window.location.search).get('tab');
    return TABS.some((t) => t.id === q) ? q : 'users';
  });
  const [accounts, setAccounts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [filters, setFilters] = useState({ search: '', platform: '', status: '' });
  const [filterOptions, setFilterOptions] = useState({ platforms: [], statuses: [] });
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [auditSettings, setAuditSettings] = useState(null);
  const [auditing, setAuditing] = useState(false);

  useEffect(() => { fetchFilterOptions(); fetchAuditSettings(); }, []);
  useEffect(() => {
    if (tab === 'users') fetchAccounts();
  }, [filters, tab]);

  useEffect(() => {
    const url = new URL(window.location.href);
    url.searchParams.set('tab', tab);
    window.history.replaceState({}, '', url);
  }, [tab]);

  const fetchFilterOptions = async () => {
    try {
      const response = await api.get('/api/social-accounts/filters');
      if (response.status !== 200) throw new Error('Failed to fetch filter options');
      setFilterOptions(response.data);
    } catch (err) {
      console.error('Error fetching filter options:', err);
    }
  };

  const fetchAuditSettings = async () => {
    try {
      const res = await api.get('/api/account-stats/settings');
      setAuditSettings(res.data);
    } catch (err) {
      console.error('Error fetching audit settings:', err);
    }
  };

  const fetchAccounts = async () => {
    try {
      setLoading(true);
      const queryParams = new URLSearchParams();
      if (filters.search) queryParams.append('search', filters.search);
      if (filters.platform) queryParams.append('platform', filters.platform);
      if (filters.status) queryParams.append('status', filters.status);
      const response = await api.get(`/api/social-accounts?${queryParams}`);
      if (response.status !== 200) throw new Error('Failed to fetch accounts');
      setAccounts(response.data);
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const runAuditNow = async (limit = null) => {
    if (!confirm(limit ? `Audit ${limit} Reddit account(s) now?` : 'Run full Reddit stats audit now? This can take a while.')) {
      return;
    }
    try {
      setAuditing(true);
      await api.post('/api/account-stats/run', limit ? { limit } : {});
      await fetchAccounts();
      await fetchAuditSettings();
    } catch (err) {
      alert(err.response?.data?.error || err.message);
    } finally {
      setAuditing(false);
    }
  };

  const handleCreateSuccess = () => {
    fetchAccounts();
    setShowCreateForm(false);
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-3">
        <div className="min-w-0">
          <h1 className="page-title">Social Accounts</h1>
          <p className="page-subtitle">Users, organic schedule, and comment log</p>
        </div>
        {tab === 'users' && (
          <button onClick={() => setShowCreateForm(true)} className="btn-primary flex items-center justify-center space-x-2 sm:self-start">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
            </svg>
            <span>Create Accounts</span>
          </button>
        )}
      </div>

      <div className="flex gap-1 border-b border-gray-200">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={`px-4 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors ${
              tab === t.id
                ? 'border-whisper-600 text-whisper-800'
                : 'border-transparent text-gray-500 hover:text-gray-800'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {showCreateForm && (
        <div className="fixed z-50 inset-0 overflow-y-auto">
          <div className="flex items-center justify-center min-h-screen px-4">
            <div className="fixed inset-0 bg-gray-900/60 backdrop-blur-sm transition-opacity" onClick={() => setShowCreateForm(false)}></div>
            <div className="relative bg-white rounded-2xl shadow-2xl w-full max-w-lg transform transition-all animate-slide-up">
              <CreateAccountsForm onClose={() => setShowCreateForm(false)} onSuccess={handleCreateSuccess} />
            </div>
          </div>
        </div>
      )}

      {tab === 'schedule' && (
        <OrganicCommentsPanel showControls showSchedule showLog={false} />
      )}

      {tab === 'log' && (
        <OrganicCommentsPanel showControls={false} showSchedule={false} showLog />
      )}

      {tab === 'users' && (
        <>
          <div className="card p-4 sm:p-5">
            <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-3 mb-4">
              <div className="text-sm text-gray-600">
                Nightly Reddit audit at{' '}
                <span className="font-medium text-gray-900">
                  {auditSettings?.run_hour_local ?? 3}:00 {auditSettings?.timezone || 'America/New_York'}
                </span>
                {auditSettings?.last_run_at && (
                  <span className="text-gray-400">
                    {' '}· last run {new Date(auditSettings.last_run_at).toLocaleString()}
                    {auditSettings.last_run_summary?.ok != null && (
                      <> ({auditSettings.last_run_summary.ok}/{auditSettings.last_run_summary.total} ok)</>
                    )}
                  </span>
                )}
              </div>
              <div className="flex flex-wrap gap-2">
                <button type="button" className="btn-secondary" disabled={auditing} onClick={() => runAuditNow(3)}>
                  {auditing ? 'Auditing…' : 'Test audit (3)'}
                </button>
                <button type="button" className="btn-secondary" disabled={auditing} onClick={() => runAuditNow()}>
                  {auditing ? 'Auditing…' : 'Run full audit now'}
                </button>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
              <div>
                <label className="label">Search</label>
                <input
                  type="text"
                  className="input-field"
                  placeholder="Search username or platform..."
                  value={filters.search}
                  onChange={(e) => setFilters({ ...filters, search: e.target.value })}
                />
              </div>
              <div>
                <label className="label">Platform</label>
                <select className="input-field" value={filters.platform} onChange={(e) => setFilters({ ...filters, platform: e.target.value })}>
                  <option value="">All Platforms</option>
                  {filterOptions.platforms.map((p) => <option key={p} value={p}>{p}</option>)}
                </select>
              </div>
              <div>
                <label className="label">Status</label>
                <select className="input-field" value={filters.status} onChange={(e) => setFilters({ ...filters, status: e.target.value })}>
                  <option value="">All Statuses</option>
                  {filterOptions.statuses.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              </div>
              <div className="flex items-end">
                <button onClick={() => setFilters({ search: '', platform: '', status: '' })} className="btn-secondary w-full">
                  Clear Filters
                </button>
              </div>
            </div>
          </div>

          {error && (
            <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-xl text-sm">{error}</div>
          )}

          <div className="card overflow-hidden">
            <div className="px-6 py-4 border-b border-gray-100">
              <h2 className="text-sm font-semibold text-gray-900">
                {loading ? 'Loading…' : `${accounts.length} account${accounts.length !== 1 ? 's' : ''}`}
              </h2>
            </div>
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-gray-100">
                <thead>
                  <tr className="bg-gray-50/50">
                    <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Platform</th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Username</th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Status</th>
                    <th className="px-4 py-3 text-right text-xs font-semibold text-gray-500 uppercase tracking-wider">Karma</th>
                    <th className="px-4 py-3 text-right text-xs font-semibold text-gray-500 uppercase tracking-wider">Posts</th>
                    <th className="px-4 py-3 text-right text-xs font-semibold text-gray-500 uppercase tracking-wider">Comments</th>
                    <th className="px-4 py-3 text-right text-xs font-semibold text-gray-500 uppercase tracking-wider">Likes</th>
                    <th className="px-4 py-3 text-right text-xs font-semibold text-gray-500 uppercase tracking-wider">Dislikes</th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Last audit</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {!loading && accounts.length === 0 && (
                    <tr>
                      <td colSpan={9} className="px-4 py-10 text-center text-sm text-gray-500">No accounts found</td>
                    </tr>
                  )}
                  {accounts.map((account) => (
                    <tr key={account.id} className="hover:bg-gray-50/50 transition-colors">
                      <td className="px-4 py-3 whitespace-nowrap text-sm font-medium text-gray-900">{account.platform}</td>
                      <td className="px-4 py-3 whitespace-nowrap text-sm text-gray-700">
                        {account.platform === 'reddit' ? (
                          <a
                            href={`https://www.reddit.com/user/${account.username}/`}
                            target="_blank"
                            rel="noreferrer"
                            className="text-whisper-700 hover:underline"
                          >
                            {account.username}
                          </a>
                        ) : (
                          account.username
                        )}
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap">
                        <span className={`badge ${account.status === 'active' ? 'badge-success' : 'badge-neutral'}`}>
                          {account.status}
                        </span>
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap text-sm text-right text-gray-900 font-medium">{fmt(account.total_karma)}</td>
                      <td className="px-4 py-3 whitespace-nowrap text-sm text-right text-gray-700">{fmt(account.post_count)}</td>
                      <td className="px-4 py-3 whitespace-nowrap text-sm text-right text-gray-700">{fmt(account.comment_count)}</td>
                      <td className="px-4 py-3 whitespace-nowrap text-sm text-right text-emerald-700">{fmt(account.likes_count)}</td>
                      <td className="px-4 py-3 whitespace-nowrap text-sm text-right text-rose-700">{fmt(account.dislikes_count)}</td>
                      <td className="px-4 py-3 whitespace-nowrap text-xs text-gray-500">
                        {account.stats_audited_at
                          ? new Date(account.stats_audited_at).toLocaleString()
                          : '—'}
                        {account.stats_audit_error && (
                          <div className="text-red-600 truncate max-w-[180px]" title={account.stats_audit_error}>
                            {account.stats_audit_error}
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
};

export default SocialAccounts;
