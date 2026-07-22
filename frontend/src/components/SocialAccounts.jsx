import React, { useState, useEffect } from 'react';
import CreateAccountsForm from './CreateAccountsForm';
import ImportAccountsForm from './ImportAccountsForm';
import OrganicCommentsPanel from './OrganicCommentsPanel';
import CapacityAlerts from './CapacityAlerts';
import api from '../utils/api';

const TABS = [
  { id: 'users', label: 'Users' },
  { id: 'schedule', label: 'Schedule' },
  { id: 'log', label: 'Log' },
];

const PLATFORM_ORDER = ['reddit', 'linkedin', 'x', 'instagram', 'tiktok'];

const PLATFORM_LABELS = {
  reddit: 'Reddit',
  linkedin: 'LinkedIn',
  x: 'X',
  twitter: 'X',
  instagram: 'Instagram',
  tiktok: 'TikTok',
};

const WARM_BADGE = {
  warmed: 'badge-success',
  pending: 'badge-warning',
  failed: 'badge-danger',
  new: 'badge-neutral',
};

const BUILT_OUT_BADGE = {
  full: 'badge-success',
  partial: 'badge-warning',
  none: 'badge-neutral',
};

const fmt = (n) => (n == null ? '—' : Number(n).toLocaleString());

const fmtDate = (v) => (v ? new Date(v).toLocaleString() : '—');

const platformLabel = (p) => PLATFORM_LABELS[p] || (p ? p.charAt(0).toUpperCase() + p.slice(1) : p);

/** Columns shown per platform tab. "all" uses a minimal shared set. */
const COLUMNS_BY_PLATFORM = {
  all: ['platform', 'username', 'status'],
  reddit: ['username', 'status', 'karma', 'posts', 'comments', 'likes', 'dislikes', 'last_audit'],
  linkedin: ['username', 'status', 'build_out', 'job_category', 'warmup', 'last_used'],
  x: ['username', 'status', 'warmup', 'last_used'],
  twitter: ['username', 'status', 'warmup', 'last_used'],
  instagram: ['username', 'status', 'build_out', 'warmup', 'last_used'],
  tiktok: ['username', 'status', 'build_out', 'warmup', 'last_used'],
};

const COLUMN_HEADERS = {
  platform: { label: 'Platform', align: 'left' },
  username: { label: 'Username', align: 'left' },
  status: { label: 'Status', align: 'left' },
  build_out: { label: 'Build-out', align: 'left' },
  job_category: { label: 'Job category', align: 'left' },
  karma: { label: 'Karma', align: 'right' },
  posts: { label: 'Posts', align: 'right' },
  comments: { label: 'Comments', align: 'right' },
  likes: { label: 'Likes', align: 'right' },
  dislikes: { label: 'Dislikes', align: 'right' },
  last_audit: { label: 'Last audit', align: 'left' },
  warmup: { label: 'Warm / login', align: 'left' },
  last_used: { label: 'Last activity', align: 'left' },
};

const SocialAccounts = () => {
  const [tab, setTab] = useState(() => {
    const q = new URLSearchParams(window.location.search).get('tab');
    return TABS.some((t) => t.id === q) ? q : 'users';
  });
  const [platformTab, setPlatformTab] = useState(() => {
    const q = new URLSearchParams(window.location.search).get('platform');
    return q || 'all';
  });
  const [accounts, setAccounts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [filters, setFilters] = useState({
    search: '',
    status: '',
    built_out: '',
    category: '',
  });
  const [filterOptions, setFilterOptions] = useState({
    platforms: [],
    platform_counts: {},
    total_count: 0,
    statuses: [],
    built_out_options: ['full', 'partial', 'none'],
    categories: [],
  });
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [showImportForm, setShowImportForm] = useState(false);
  const [auditSettings, setAuditSettings] = useState(null);
  const [auditing, setAuditing] = useState(false);
  /** Default OFF = hide banned / inactive / session_dead rows */
  const [showBanned, setShowBanned] = useState(false);

  const showLinkedInFilters = platformTab === 'linkedin';
  const showRedditAudit = platformTab === 'reddit';
  const columns = COLUMNS_BY_PLATFORM[platformTab] || COLUMNS_BY_PLATFORM.all;

  const HIDDEN_STATUSES = new Set(['banned', 'inactive', 'session_dead']);
  const visibleAccounts = showBanned
    ? accounts
    : accounts.filter((a) => !HIDDEN_STATUSES.has(String(a.status || '').toLowerCase()));

  const knownPlatforms = PLATFORM_ORDER.filter((p) => filterOptions.platforms.includes(p));
  const extraPlatforms = filterOptions.platforms.filter((p) => !PLATFORM_ORDER.includes(p));
  const platformTabs = ['all', ...knownPlatforms, ...extraPlatforms];

  useEffect(() => { fetchFilterOptions(); fetchAuditSettings(); }, []);
  useEffect(() => {
    if (tab === 'users') fetchAccounts();
  }, [filters, tab, platformTab]);

  useEffect(() => {
    const url = new URL(window.location.href);
    url.searchParams.set('tab', tab);
    if (tab === 'users' && platformTab && platformTab !== 'all') {
      url.searchParams.set('platform', platformTab);
    } else {
      url.searchParams.delete('platform');
    }
    window.history.replaceState({}, '', url);
  }, [tab, platformTab]);

  const fetchFilterOptions = async () => {
    try {
      const response = await api.get('/api/social-accounts/filters');
      if (response.status !== 200) throw new Error('Failed to fetch filter options');
      setFilterOptions({
        platforms: response.data.platforms || [],
        platform_counts: response.data.platform_counts || {},
        total_count: response.data.total_count || 0,
        statuses: response.data.statuses || [],
        built_out_options: response.data.built_out_options || ['full', 'partial', 'none'],
        categories: response.data.categories || [],
      });
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
      if (platformTab && platformTab !== 'all') queryParams.append('platform', platformTab);
      if (filters.status) queryParams.append('status', filters.status);
      if (showLinkedInFilters && filters.built_out) queryParams.append('built_out', filters.built_out);
      if (showLinkedInFilters && filters.category) queryParams.append('category', filters.category);
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

  const clearFilters = () =>
    setFilters({ search: '', status: '', built_out: '', category: '' });

  const selectPlatformTab = (next) => {
    setPlatformTab(next);
    if (next !== 'linkedin') {
      setFilters((f) => ({ ...f, built_out: '', category: '' }));
    }
  };

  const builtOutLabel = (account) =>
    account.profile_enrichment?.built_out_label ||
    (account.built_out === 'full'
      ? 'Built out'
      : account.built_out === 'partial'
        ? 'Partial'
        : 'None');

  const categoryDisplay = (account) =>
    account.job_category_label ||
    account.profile_enrichment?.category_label ||
    '—';

  const usernameLink = (account) => {
    if (account.platform === 'reddit') {
      return (
        <a
          href={`https://www.reddit.com/user/${account.username}/`}
          target="_blank"
          rel="noreferrer"
          className="text-whisper-700 hover:underline"
        >
          {account.username}
        </a>
      );
    }
    if (account.platform === 'linkedin') {
      return (
        <a
          href={`https://www.linkedin.com/in/${account.username}/`}
          target="_blank"
          rel="noreferrer"
          className="text-whisper-700 hover:underline"
        >
          {account.username}
        </a>
      );
    }
    if (account.platform === 'x' || account.platform === 'twitter') {
      return (
        <a
          href={`https://x.com/${account.username}`}
          target="_blank"
          rel="noreferrer"
          className="text-whisper-700 hover:underline"
        >
          {account.username}
        </a>
      );
    }
    if (account.platform === 'instagram') {
      return (
        <a
          href={`https://www.instagram.com/${account.username}/`}
          target="_blank"
          rel="noreferrer"
          className="text-whisper-700 hover:underline"
        >
          {account.username}
        </a>
      );
    }
    if (account.platform === 'tiktok') {
      return (
        <a
          href={`https://www.tiktok.com/@${account.username}`}
          target="_blank"
          rel="noreferrer"
          className="text-whisper-700 hover:underline"
        >
          {account.username}
        </a>
      );
    }
    return account.username;
  };

  const renderCell = (col, account) => {
    const built = account.built_out || account.profile_enrichment?.built_out || 'none';
    const enrich = account.profile_enrichment || {};
    const detail = [
      enrich.photo ? 'photo' : null,
      enrich.banner ? 'banner' : null,
      enrich.headline ? 'headline' : null,
      enrich.about ? 'about' : null,
    ]
      .filter(Boolean)
      .join(', ');

    switch (col) {
      case 'platform':
        return (
          <td key={col} className="px-4 py-3 whitespace-nowrap text-sm font-medium text-gray-900">
            {platformLabel(account.platform)}
          </td>
        );
      case 'username':
        return (
          <td key={col} className="px-4 py-3 whitespace-nowrap text-sm text-gray-700">
            {usernameLink(account)}
          </td>
        );
      case 'status':
        return (
          <td key={col} className="px-4 py-3 whitespace-nowrap">
            <span className={`badge ${account.status === 'active' ? 'badge-success' : account.status === 'banned' ? 'badge-danger' : 'badge-neutral'}`}>
              {account.status}
            </span>
          </td>
        );
      case 'build_out':
        return (
          <td key={col} className="px-4 py-3 whitespace-nowrap">
            <span
              className={`badge ${BUILT_OUT_BADGE[built] || 'badge-neutral'}`}
              title={detail || 'No enrichment'}
            >
              {builtOutLabel(account)}
            </span>
          </td>
        );
      case 'job_category':
        return (
          <td key={col} className="px-4 py-3 whitespace-nowrap text-sm text-gray-700">
            {categoryDisplay(account)}
          </td>
        );
      case 'karma':
        return (
          <td key={col} className="px-4 py-3 whitespace-nowrap text-sm text-right text-gray-900 font-medium">
            {fmt(account.total_karma)}
          </td>
        );
      case 'posts':
        return (
          <td key={col} className="px-4 py-3 whitespace-nowrap text-sm text-right text-gray-700">
            {fmt(account.post_count)}
          </td>
        );
      case 'comments':
        return (
          <td key={col} className="px-4 py-3 whitespace-nowrap text-sm text-right text-gray-700">
            {fmt(account.comment_count)}
          </td>
        );
      case 'likes':
        return (
          <td key={col} className="px-4 py-3 whitespace-nowrap text-sm text-right text-emerald-700">
            {fmt(account.likes_count)}
          </td>
        );
      case 'dislikes':
        return (
          <td key={col} className="px-4 py-3 whitespace-nowrap text-sm text-right text-rose-700">
            {fmt(account.dislikes_count)}
          </td>
        );
      case 'last_audit':
        return (
          <td key={col} className="px-4 py-3 whitespace-nowrap text-xs text-gray-500">
            {fmtDate(account.stats_audited_at)}
            {account.stats_audit_error && (
              <div className="text-red-600 truncate max-w-[180px]" title={account.stats_audit_error}>
                {account.stats_audit_error}
              </div>
            )}
          </td>
        );
      case 'warmup': {
        const warm = account.warmup_status || 'new';
        return (
          <td key={col} className="px-4 py-3 whitespace-nowrap">
            <span className={`badge ${WARM_BADGE[warm] || 'badge-neutral'}`}>{warm}</span>
          </td>
        );
      }
      case 'last_used':
        return (
          <td key={col} className="px-4 py-3 whitespace-nowrap text-xs text-gray-500">
            {fmtDate(account.last_used_at || account.warmed_up_at)}
          </td>
        );
      default:
        return null;
    }
  };

  const tabCount = (id) => {
    if (id === 'all') return filterOptions.total_count || 0;
    return filterOptions.platform_counts?.[id] || 0;
  };

  const filterGridCols = showLinkedInFilters
    ? 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-4'
    : 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3';

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-3">
        <div className="min-w-0">
          <h1 className="page-title">Social Accounts</h1>
          <p className="page-subtitle">Users, organic schedule, and comment log</p>
        </div>
        {tab === 'users' && (
          <div className="flex items-center gap-2 sm:self-start">
            <button
              onClick={() => setShowImportForm(true)}
              className="btn-secondary flex items-center justify-center space-x-2"
            >
              <span>Import</span>
            </button>
            <button onClick={() => setShowCreateForm(true)} className="btn-primary flex items-center justify-center space-x-2">
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
              </svg>
              <span>Create Accounts</span>
            </button>
          </div>
        )}
      </div>

      <CapacityAlerts variant="light" pollMs={60000} />

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

      {showImportForm && (
        <div className="fixed z-50 inset-0 overflow-y-auto">
          <div className="flex items-center justify-center min-h-screen px-4">
            <div
              className="fixed inset-0 bg-gray-900/60 backdrop-blur-sm transition-opacity"
              onClick={() => setShowImportForm(false)}
            />
            <div className="relative w-full max-w-2xl transform transition-all animate-slide-up">
              <ImportAccountsForm
                initialPlatform={
                  ['x', 'instagram', 'tiktok', 'linkedin'].includes(platformTab)
                    ? platformTab
                    : 'x'
                }
                onClose={() => setShowImportForm(false)}
                onSuccess={() => {
                  setShowImportForm(false);
                  fetchAccounts();
                }}
              />
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
          <div className="flex flex-wrap gap-1 border-b border-gray-200">
            {platformTabs.map((id) => {
              const active = platformTab === id;
              const count = tabCount(id);
              return (
                <button
                  key={id}
                  type="button"
                  onClick={() => selectPlatformTab(id)}
                  className={`px-3 py-2 text-sm font-medium border-b-2 -mb-px transition-colors inline-flex items-center gap-2 ${
                    active
                      ? 'border-whisper-600 text-whisper-800'
                      : 'border-transparent text-gray-500 hover:text-gray-800'
                  }`}
                >
                  <span>{id === 'all' ? 'All' : platformLabel(id)}</span>
                  <span
                    className={`text-[11px] tabular-nums px-1.5 py-0.5 rounded-md ${
                      active ? 'bg-whisper-100 text-whisper-800' : 'bg-gray-100 text-gray-500'
                    }`}
                  >
                    {count}
                  </span>
                </button>
              );
            })}
          </div>

          {showRedditAudit && (
            <div className="card p-4 sm:p-5">
              <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-3">
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
            </div>
          )}

          <div className="card p-4 sm:p-5">
            <div className={`grid ${filterGridCols} gap-3 sm:gap-4`}>
              <div>
                <label className="label">Search</label>
                <input
                  type="text"
                  className="input-field"
                  placeholder="Search username..."
                  value={filters.search}
                  onChange={(e) => setFilters({ ...filters, search: e.target.value })}
                />
              </div>
              <div>
                <label className="label">Status</label>
                <select className="input-field" value={filters.status} onChange={(e) => setFilters({ ...filters, status: e.target.value })}>
                  <option value="">All Statuses</option>
                  {filterOptions.statuses.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              </div>
              {showLinkedInFilters && (
                <>
                  <div>
                    <label className="label">Build-out</label>
                    <select
                      className="input-field"
                      value={filters.built_out}
                      onChange={(e) => setFilters({ ...filters, built_out: e.target.value })}
                    >
                      <option value="">All</option>
                      {(filterOptions.built_out_options || []).map((b) => (
                        <option key={b} value={b}>
                          {b === 'full' ? 'Built out' : b === 'partial' ? 'Partial' : 'None'}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="label">Job category</label>
                    <select
                      className="input-field"
                      value={filters.category}
                      onChange={(e) => setFilters({ ...filters, category: e.target.value })}
                    >
                      <option value="">All</option>
                      {(filterOptions.categories || []).map((c) => (
                        <option key={c} value={c}>{c}</option>
                      ))}
                    </select>
                  </div>
                </>
              )}
              <div className="flex items-end">
                <button onClick={clearFilters} className="btn-secondary w-full">
                  Clear Filters
                </button>
              </div>
            </div>
          </div>

          {error && (
            <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-xl text-sm">{error}</div>
          )}

          <div className="card overflow-hidden">
            <div className="px-6 py-4 border-b border-gray-100 flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-sm font-semibold text-gray-900">
                {loading
                  ? 'Loading…'
                  : `${visibleAccounts.length} ${platformTab === 'all' ? 'account' : platformLabel(platformTab)} account${visibleAccounts.length !== 1 ? 's' : ''}${
                      !showBanned && accounts.length !== visibleAccounts.length
                        ? ` (${accounts.length - visibleAccounts.length} banned hidden)`
                        : ''
                    }`}
              </h2>
              <label className="inline-flex items-center gap-2 text-sm text-gray-600 cursor-pointer select-none">
                <input
                  type="checkbox"
                  className="rounded border-gray-300 text-whisper-700 focus:ring-whisper-500"
                  checked={showBanned}
                  onChange={(e) => setShowBanned(e.target.checked)}
                />
                Show banned
              </label>
            </div>
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-gray-100">
                <thead>
                  <tr className="bg-gray-50/50">
                    {columns.map((col) => {
                      const meta = COLUMN_HEADERS[col];
                      return (
                        <th
                          key={col}
                          className={`px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider ${
                            meta.align === 'right' ? 'text-right' : 'text-left'
                          }`}
                        >
                          {meta.label}
                        </th>
                      );
                    })}
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {!loading && visibleAccounts.length === 0 && (
                    <tr>
                      <td colSpan={columns.length} className="px-4 py-10 text-center text-sm text-gray-500">
                        No accounts found
                      </td>
                    </tr>
                  )}
                  {visibleAccounts.map((account) => (
                    <tr key={account.id} className="hover:bg-gray-50/50 transition-colors">
                      {columns.map((col) => renderCell(col, account))}
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
