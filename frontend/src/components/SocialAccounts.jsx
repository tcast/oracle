import React, { useState, useEffect } from 'react';
import CreateAccountsForm from './CreateAccountsForm';
import api from '../utils/api';

const SocialAccounts = () => {
  const [accounts, setAccounts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [filters, setFilters] = useState({ search: '', platform: '', status: '' });
  const [filterOptions, setFilterOptions] = useState({ platforms: [], statuses: [] });
  const [showCreateForm, setShowCreateForm] = useState(false);

  useEffect(() => { fetchFilterOptions(); }, []);
  useEffect(() => { fetchAccounts(); }, [filters]);

  const fetchFilterOptions = async () => {
    try {
      const response = await api.get('/api/social-accounts/filters');
      if (response.status !== 200) throw new Error('Failed to fetch filter options');
      setFilterOptions(response.data);
    } catch (err) {
      console.error('Error fetching filter options:', err);
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
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const formatPersonaTraits = (traits) => {
    if (!traits) return { writingStyle: 'N/A', responseLength: 'N/A', tone: 'N/A', quirks: 'N/A', expertise: 'N/A', engagementStyle: 'N/A' };
    const parsedTraits = typeof traits === 'string' ? JSON.parse(traits) : traits;
    return {
      writingStyle: parsedTraits.writingStyle || 'N/A',
      responseLength: parsedTraits.responseLength || 'N/A',
      tone: parsedTraits.tone || 'N/A',
      quirks: Array.isArray(parsedTraits.quirks) ? parsedTraits.quirks.join(', ') : 'N/A',
      expertise: Array.isArray(parsedTraits.expertise) ? parsedTraits.expertise.join(', ') : 'N/A',
      engagementStyle: parsedTraits.engagementStyle || 'N/A'
    };
  };

  const handleCreateSuccess = () => {
    fetchAccounts();
    setShowCreateForm(false);
  };

  if (loading && accounts.length === 0) return <div className="text-center py-10 text-gray-500">Loading accounts...</div>;
  if (error) return <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-xl text-sm">{error}</div>;

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-3">
        <div className="min-w-0">
          <h1 className="page-title">Social Accounts</h1>
          <p className="page-subtitle">Manage your social media personas and accounts</p>
        </div>
        <button onClick={() => setShowCreateForm(true)} className="btn-primary flex items-center justify-center space-x-2 sm:self-start">
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
          </svg>
          <span>Create Accounts</span>
        </button>
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

      <div className="card p-4 sm:p-5">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
          <div>
            <label className="label">Search</label>
            <input
              type="text"
              className="input-field"
              placeholder="Search username or platform..."
              value={filters.search}
              onChange={(e) => setFilters({...filters, search: e.target.value})}
            />
          </div>
          <div>
            <label className="label">Platform</label>
            <select className="input-field" value={filters.platform} onChange={(e) => setFilters({...filters, platform: e.target.value})}>
              <option value="">All Platforms</option>
              {filterOptions.platforms.map(p => <option key={p} value={p}>{p}</option>)}
            </select>
          </div>
          <div>
            <label className="label">Status</label>
            <select className="input-field" value={filters.status} onChange={(e) => setFilters({...filters, status: e.target.value})}>
              <option value="">All Statuses</option>
              {filterOptions.statuses.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
          <div className="flex items-end">
            <button onClick={() => setFilters({ search: '', platform: '', status: '' })} className="btn-secondary w-full">
              Clear Filters
            </button>
          </div>
        </div>
      </div>

      <div className="card overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-100">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-gray-900">
              {accounts.length} account{accounts.length !== 1 ? 's' : ''} found
            </h2>
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-100">
            <thead>
              <tr className="bg-gray-50/50">
                <th className="px-6 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Platform</th>
                <th className="px-6 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Username</th>
                <th className="px-6 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Email</th>
                <th className="px-6 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Status</th>
                <th className="px-6 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Writing Style</th>
                <th className="px-6 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Tone</th>
                <th className="px-6 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Simulated</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {accounts.map((account) => {
                const traits = formatPersonaTraits(account.persona_traits);
                return (
                  <tr key={account.id} className="hover:bg-gray-50/50 transition-colors">
                    <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900">{account.platform}</td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-700">{account.username}</td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">{account.email || 'N/A'}</td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <span className={`badge ${account.status === 'active' ? 'badge-success' : 'badge-neutral'}`}>
                        {account.status}
                      </span>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">{traits.writingStyle}</td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">{traits.tone}</td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <span className={`badge ${account.is_simulated ? 'badge-warning' : 'badge-info'}`}>
                        {account.is_simulated ? 'Yes' : 'No'}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};

export default SocialAccounts;
