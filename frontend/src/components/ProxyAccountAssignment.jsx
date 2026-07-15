import React, { useState, useEffect } from 'react';
import api from '../utils/api';

const ProxyAccountAssignment = () => {
  const [socialAccounts, setSocialAccounts] = useState([]);
  const [allProxies, setAllProxies] = useState([]);
  const [accountProxies, setAccountProxies] = useState({});
  const [loading, setLoading] = useState(true);
  const [selectedAccount, setSelectedAccount] = useState(null);
  const [assigningProxies, setAssigningProxies] = useState([]);

  useEffect(() => {
    fetchData();
  }, []);

  const fetchData = async () => {
    try {
      const accountsResponse = await api.get('/api/social-accounts');
      setSocialAccounts(accountsResponse.data);

      const proxiesResponse = await api.get('/api/proxies');
      setAllProxies(proxiesResponse.data);

      const accountProxyMap = {};
      for (const account of accountsResponse.data) {
        try {
          const response = await api.get(`/api/proxies/account/${account.id}`);
          accountProxyMap[account.id] = response.data;
        } catch (error) {
          accountProxyMap[account.id] = [];
        }
      }
      setAccountProxies(accountProxyMap);
    } catch (error) {
      console.error('Error fetching data:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleAssignProxies = async (accountId) => {
    try {
      await api.post(`/api/proxies/account/${accountId}/assign`, {
        proxy_ids: assigningProxies
      });

      const response = await api.get(`/api/proxies/account/${accountId}`);
      setAccountProxies({
        ...accountProxies,
        [accountId]: response.data
      });

      setSelectedAccount(null);
      setAssigningProxies([]);
    } catch (error) {
      console.error('Error assigning proxies:', error);
      alert('Failed to assign proxies: ' + error.message);
    }
  };

  const handleRemoveProxy = async (accountId, proxyId) => {
    if (!confirm('Remove this proxy from the account?')) return;

    try {
      await api.delete(`/api/proxies/account/${accountId}/proxy/${proxyId}`);

      setAccountProxies({
        ...accountProxies,
        [accountId]: accountProxies[accountId].filter(p => p.id !== proxyId)
      });
    } catch (error) {
      console.error('Error removing proxy:', error);
      alert('Failed to remove proxy: ' + error.message);
    }
  };

  const getProxyBadge = (proxy) => {
    const badges = [];

    if (proxy.is_residential) {
      badges.push(<span key="res" className="px-2 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-800">Residential</span>);
    }

    if (!proxy.is_active) {
      badges.push(<span key="inactive" className="px-2 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-800">Inactive</span>);
    }

    if (proxy.failure_count > 5) {
      badges.push(<span key="issues" className="px-2 py-0.5 rounded-full text-xs font-medium bg-yellow-100 text-yellow-800">Issues</span>);
    }

    return <div className="flex gap-1">{badges}</div>;
  };

  const getAccountStats = (account) => {
    const proxies = accountProxies[account.id] || [];
    const activeProxies = proxies.filter(p => p.is_active);
    const residentialProxies = proxies.filter(p => p.is_residential);

    return {
      total: proxies.length,
      active: activeProxies.length,
      residential: residentialProxies.length
    };
  };

  const getCountryFlag = (country) => {
    const flags = {
      US: '\uD83C\uDDFA\uD83C\uDDF8',
      GB: '\uD83C\uDDEC\uD83C\uDDE7',
      CA: '\uD83C\uDDE8\uD83C\uDDE6',
      AU: '\uD83C\uDDE6\uD83C\uDDFA',
      DE: '\uD83C\uDDE9\uD83C\uDDEA',
      FR: '\uD83C\uDDEB\uD83C\uDDF7',
      JP: '\uD83C\uDDEF\uD83C\uDDF5',
      BR: '\uD83C\uDDE7\uD83C\uDDF7'
    };
    return flags[country] || '\uD83C\uDF10';
  };

  if (loading) {
    return <div className="flex items-center justify-center py-12">
      <div className="animate-spin rounded-full h-8 w-8 border-2 border-whisper-400 border-t-transparent"></div>
    </div>;
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-3">
        <div className="min-w-0">
          <h1 className="page-title">Proxy Account Assignment</h1>
          <p className="page-subtitle">Each posting account should have one dedicated sticky ProxyBase connection</p>
        </div>
      </div>

      <div className="bg-blue-50 border border-blue-200 rounded-xl p-4 text-sm text-blue-800 flex items-start gap-3">
        <svg className="w-5 h-5 mt-0.5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
        <span>Prefer one sticky ProxyBase proxy per account (posts and comments share that IP). Keep a few spares unassigned for new accounts.</span>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {socialAccounts.length === 0 && (
          <div className="col-span-full text-center py-12 text-gray-500 bg-white rounded-xl border border-gray-200">
            No social accounts found. Create accounts first to assign proxies.
          </div>
        )}
        {socialAccounts.map(account => {
          const stats = getAccountStats(account);
          const proxies = accountProxies[account.id] || [];

          return (
            <div key={account.id} className="card">
              <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <h3 className="font-semibold text-gray-900">{account.username}</h3>
                    <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-600">{account.platform}</span>
                  </div>
                  <p className="text-xs text-gray-500 mt-0.5">
                    {stats.total} proxies ({stats.active} active, {stats.residential} residential)
                  </p>
                </div>
                <button
                  className="px-3 py-1.5 text-xs font-medium rounded-lg border border-indigo-300 text-indigo-700 hover:bg-indigo-50 transition-colors"
                  onClick={() => {
                    setSelectedAccount(account);
                    setAssigningProxies(proxies.map(p => p.id));
                  }}
                >
                  Manage
                </button>
              </div>
              <div className="px-5 py-4">
                {proxies.length === 0 ? (
                  <p className="text-center py-6 text-sm text-gray-400">
                    No proxies assigned. Click "Manage" to assign proxies.
                  </p>
                ) : (
                  <div className="space-y-2">
                    {proxies.map(proxy => (
                      <div key={proxy.id} className="flex items-center justify-between p-3 rounded-lg border border-gray-200 hover:border-gray-300 transition-colors">
                        <div className="min-w-0">
                          <div className="text-sm font-medium text-gray-900">{proxy.name}</div>
                          <div className="text-xs text-gray-500 mt-0.5">
                            {getCountryFlag(proxy.country)} {proxy.city || proxy.country} &bull; {proxy.type.toUpperCase()} &bull; Priority: {proxy.priority}
                          </div>
                          <div className="mt-1">{getProxyBadge(proxy)}</div>
                        </div>
                        <button
                          className="px-2 py-1 text-xs font-medium rounded-lg border border-red-300 text-red-600 hover:bg-red-50 transition-colors flex-shrink-0"
                          onClick={() => handleRemoveProxy(account.id, proxy.id)}
                        >
                          Remove
                        </button>
                      </div>
                    ))}
                  </div>
                )}

                {proxies.length > 0 && (
                  <div className="mt-3 p-3 rounded-lg bg-gray-50 text-xs text-gray-500 flex items-start gap-2">
                    <svg className="w-4 h-4 mt-0.5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                    Proxies rotate automatically based on priority and last usage.
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {selectedAccount && (
        <div className="fixed z-50 inset-0 overflow-y-auto">
          <div className="flex items-center justify-center min-h-screen px-4">
            <div className="fixed inset-0 bg-gray-900/60 backdrop-blur-sm transition-opacity" onClick={() => {
              setSelectedAccount(null);
              setAssigningProxies([]);
            }}></div>
            <div className="relative bg-white rounded-2xl shadow-2xl w-full max-w-lg transform transition-all animate-slide-up">
              <div className="px-6 py-5 border-b border-gray-100">
                <div className="flex items-center justify-between">
                  <h3 className="text-lg font-semibold text-gray-900">
                    Manage Proxies for {selectedAccount.username}
                  </h3>
                  <button
                    onClick={() => {
                      setSelectedAccount(null);
                      setAssigningProxies([]);
                    }}
                    className="text-gray-400 hover:text-gray-600"
                  >
                    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                </div>
              </div>
              <div className="px-6 py-4">
                <p className="text-sm text-gray-500 mb-4">
                  Select proxies to assign to this account. The system will automatically rotate between them.
                </p>

                <div className="flex gap-2 mb-4">
                  <button
                    className="px-3 py-1.5 text-xs font-medium rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50 transition-colors"
                    onClick={() => setAssigningProxies(allProxies.filter(p => p.is_active).map(p => p.id))}
                  >
                    Select All Active
                  </button>
                  <button
                    className="px-3 py-1.5 text-xs font-medium rounded-lg border border-green-300 text-green-700 hover:bg-green-50 transition-colors"
                    onClick={() => setAssigningProxies(allProxies.filter(p => p.is_residential && p.is_active).map(p => p.id))}
                  >
                    Select Residential Only
                  </button>
                  <button
                    className="px-3 py-1.5 text-xs font-medium rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50 transition-colors"
                    onClick={() => setAssigningProxies([])}
                  >
                    Clear Selection
                  </button>
                </div>

                <div className="max-h-80 overflow-y-auto space-y-2">
                  {allProxies.map(proxy => (
                    <label
                      key={proxy.id}
                      className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${
                        assigningProxies.includes(proxy.id)
                          ? 'border-whisper-300 bg-whisper-50/50'
                          : 'border-gray-200 hover:border-gray-300'
                      }`}
                    >
                      <input
                        type="checkbox"
                        className="mt-0.5 w-4 h-4 rounded border-gray-300 text-whisper-600 focus:ring-whisper-500"
                        checked={assigningProxies.includes(proxy.id)}
                        onChange={(e) => {
                          if (e.target.checked) {
                            setAssigningProxies([...assigningProxies, proxy.id]);
                          } else {
                            setAssigningProxies(assigningProxies.filter(id => id !== proxy.id));
                          }
                        }}
                      />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between">
                          <div className="min-w-0">
                            <div className="text-sm font-medium text-gray-900">{proxy.name}</div>
                            <div className="text-xs text-gray-500">
                              {getCountryFlag(proxy.country)} {proxy.city || proxy.country} &bull; {proxy.type.toUpperCase()} &bull; {proxy.provider}
                            </div>
                          </div>
                          <div className="flex-shrink-0 ml-2">{getProxyBadge(proxy)}</div>
                        </div>
                      </div>
                    </label>
                  ))}
                </div>

                <div className="mt-3 text-xs text-gray-500">
                  <strong>Selected:</strong> {assigningProxies.length} proxies
                </div>
              </div>
              <div className="px-6 py-4 border-t border-gray-100 flex justify-end gap-2">
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => {
                    setSelectedAccount(null);
                    setAssigningProxies([]);
                  }}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn-primary"
                  onClick={() => handleAssignProxies(selectedAccount.id)}
                >
                  Save Assignment
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default ProxyAccountAssignment;
