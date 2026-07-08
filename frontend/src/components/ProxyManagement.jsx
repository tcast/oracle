import React, { useState, useEffect } from 'react';
import api from '../utils/api';

const ProxyManagement = () => {
  const [proxies, setProxies] = useState([]);
  const [socialAccounts, setSocialAccounts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showAddProxy, setShowAddProxy] = useState(false);
  const [selectedProxy, setSelectedProxy] = useState(null);
  const [proxyStats, setProxyStats] = useState(null);
  const [filter, setFilter] = useState({ country: '', type: '', provider: '' });
  const [testResults, setTestResults] = useState({});

  const [newProxy, setNewProxy] = useState({
    name: '',
    type: 'http',
    server: '',
    username: '',
    password: '',
    country: '',
    city: '',
    provider: '',
    is_residential: false
  });

  useEffect(() => {
    fetchProxies();
    fetchSocialAccounts();
    fetchProxyStats();
  }, []);

  const fetchProxies = async () => {
    try {
      const params = new URLSearchParams();
      if (filter.country) params.append('country', filter.country);
      if (filter.type) params.append('type', filter.type);
      if (filter.is_residential !== '') params.append('is_residential', filter.is_residential);

      const response = await api.get(`/api/proxies?${params}`);
      setProxies(response.data);
    } catch (error) {
      console.error('Error fetching proxies:', error);
    } finally {
      setLoading(false);
    }
  };

  const fetchSocialAccounts = async () => {
    try {
      const response = await api.get('/api/social-accounts');
      setSocialAccounts(response.data);
    } catch (error) {
      console.error('Error fetching social accounts:', error);
    }
  };

  const fetchProxyStats = async () => {
    try {
      const response = await api.get('/api/proxies/stats');
      setProxyStats(response.data);
    } catch (error) {
      console.error('Error fetching proxy stats:', error);
    }
  };

  const handleAddProxy = async (e) => {
    e.preventDefault();
    try {
      await api.post('/api/proxies', newProxy);
      setShowAddProxy(false);
      setNewProxy({
        name: '',
        type: 'http',
        server: '',
        username: '',
        password: '',
        country: '',
        city: '',
        provider: '',
        is_residential: false
      });
      fetchProxies();
      fetchProxyStats();
    } catch (error) {
      console.error('Error adding proxy:', error);
      alert('Failed to add proxy: ' + error.message);
    }
  };

  const handleTestProxy = async (proxyId) => {
    setTestResults({ ...testResults, [proxyId]: { testing: true } });
    try {
      const response = await api.post(`/api/proxies/${proxyId}/test`);
      setTestResults({
        ...testResults,
        [proxyId]: response.data
      });
    } catch (error) {
      setTestResults({
        ...testResults,
        [proxyId]: { success: false, error: error.message }
      });
    }
  };

  const handleToggleProxy = async (proxyId, currentStatus) => {
    try {
      await api.patch(`/api/proxies/${proxyId}/status`, {
        is_active: !currentStatus
      });
      fetchProxies();
    } catch (error) {
      console.error('Error toggling proxy status:', error);
    }
  };

  const handleBulkImport = async () => {
    const sampleFormat = `[
  {
    "name": "US Proxy 1",
    "type": "socks5",
    "server": "proxy.example.com:1080",
    "username": "user",
    "password": "pass",
    "country": "US",
    "city": "New York",
    "provider": "ProxyProvider",
    "is_residential": true
  }
]`;

    const jsonStr = prompt(`Paste proxy list in JSON format:\n\nExample:\n${sampleFormat}`);
    if (!jsonStr) return;

    try {
      const proxies = JSON.parse(jsonStr);
      const response = await api.post('/api/proxies/bulk', { proxies });
      alert(`Imported ${response.data.successful} proxies successfully, ${response.data.failed} failed.`);
      fetchProxies();
      fetchProxyStats();
    } catch (error) {
      alert('Invalid JSON or import failed: ' + error.message);
    }
  };

  const getProxyStatusBadge = (proxy) => {
    const testResult = testResults[proxy.id];
    if (testResult?.testing) {
      return <span className="px-2.5 py-0.5 rounded-full text-xs font-medium bg-yellow-100 text-yellow-800">Testing...</span>;
    }
    if (testResult?.success) {
      return <span className="px-2.5 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-800">Verified ✓</span>;
    }
    if (testResult?.success === false) {
      return <span className="px-2.5 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-800">Failed</span>;
    }
    if (!proxy.is_active) {
      return <span className="px-2.5 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-800">Disabled</span>;
    }
    if (proxy.failure_count > 5) {
      return <span className="px-2.5 py-0.5 rounded-full text-xs font-medium bg-yellow-100 text-yellow-800">Issues</span>;
    }
    return <span className="px-2.5 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-800">Active</span>;
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
      <div className="animate-spin rounded-full h-8 w-8 border-2 border-oracle-400 border-t-transparent"></div>
    </div>;
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-3">
        <div className="min-w-0">
          <h1 className="page-title">Proxy Management</h1>
          <p className="page-subtitle">Manage your proxy pool for social media automation</p>
        </div>
        <div className="flex gap-2">
          <button onClick={() => setShowAddProxy(true)} className="btn-primary flex items-center space-x-2">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
            </svg>
            <span>Add Proxy</span>
          </button>
          <button onClick={handleBulkImport} className="btn-secondary flex items-center space-x-2">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
            </svg>
            <span>Bulk Import</span>
          </button>
        </div>
      </div>

      {proxyStats && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <div className="card p-4">
            <div className="text-gray-500 text-xs font-medium uppercase tracking-wider">Total Proxies</div>
            <div className="text-2xl font-bold text-gray-900 mt-1">{proxyStats.overview.total_proxies}</div>
            <div className="text-sm text-gray-500">{proxyStats.overview.active_proxies} active</div>
          </div>
          <div className="card p-4">
            <div className="text-gray-500 text-xs font-medium uppercase tracking-wider">Residential</div>
            <div className="text-2xl font-bold text-green-600 mt-1">{proxyStats.overview.residential_proxies}</div>
            <div className="text-sm text-gray-500">Premium proxies</div>
          </div>
          <div className="card p-4">
            <div className="text-gray-500 text-xs font-medium uppercase tracking-wider">Success Rate</div>
            <div className="text-2xl font-bold text-blue-600 mt-1">
              {proxyStats.overview.avg_success_count > 0
                ? Math.round((proxyStats.overview.avg_success_count /
                    (proxyStats.overview.avg_success_count + proxyStats.overview.avg_failure_count)) * 100)
                : 0}%
            </div>
            <div className="text-sm text-gray-500">Avg success rate</div>
          </div>
          <div className="card p-4">
            <div className="text-gray-500 text-xs font-medium uppercase tracking-wider">Countries</div>
            <div className="text-2xl font-bold text-purple-600 mt-1">{proxyStats.byCountry.length}</div>
            <div className="text-sm text-gray-500">Geographic diversity</div>
          </div>
        </div>
      )}

      <div className="card p-4">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div>
            <label className="label">Country</label>
            <select
              className="input-field"
              value={filter.country}
              onChange={(e) => setFilter({ ...filter, country: e.target.value })}
            >
              <option value="">All Countries</option>
              <option value="US">United States</option>
              <option value="GB">United Kingdom</option>
              <option value="CA">Canada</option>
              <option value="AU">Australia</option>
              <option value="DE">Germany</option>
            </select>
          </div>
          <div>
            <label className="label">Type</label>
            <select
              className="input-field"
              value={filter.type}
              onChange={(e) => setFilter({ ...filter, type: e.target.value })}
            >
              <option value="">All Types</option>
              <option value="http">HTTP</option>
              <option value="https">HTTPS</option>
              <option value="socks5">SOCKS5</option>
            </select>
          </div>
          <div className="flex items-end">
            <button
              className="btn-secondary w-full"
              onClick={() => {
                setFilter({ country: '', type: '', provider: '' });
                fetchProxies();
              }}
            >
              Clear Filters
            </button>
          </div>
        </div>
      </div>

      <div className="card overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-100">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-gray-900">
              {proxies.length} proxy{proxies.length !== 1 ? 'ies' : ''} found
            </h2>
            <button onClick={() => fetchProxies()} className="text-gray-400 hover:text-gray-600 transition-colors">
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
            </button>
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-100">
            <thead>
              <tr className="bg-gray-50/50">
                <th className="px-6 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Status</th>
                <th className="px-6 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Name</th>
                <th className="px-6 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Location</th>
                <th className="px-6 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Type</th>
                <th className="px-6 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Provider</th>
                <th className="px-6 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Server</th>
                <th className="px-6 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Stats</th>
                <th className="px-6 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {proxies.map(proxy => (
                <tr key={proxy.id} className="hover:bg-gray-50/50 transition-colors">
                  <td className="px-6 py-4 whitespace-nowrap">{getProxyStatusBadge(proxy)}</td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-gray-900">{proxy.name}</span>
                      {proxy.is_residential && (
                        <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-800">Residential</span>
                      )}
                    </div>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-700">
                    {getCountryFlag(proxy.country)} {proxy.city || proxy.country || 'Unknown'}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-700">{proxy.type.toUpperCase()}</span>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-600">{proxy.provider || '-'}</td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    <code className="text-xs text-gray-600 bg-gray-100 px-1.5 py-0.5 rounded">{proxy.server}</code>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-xs text-gray-500">
                    <div>Success: {proxy.success_count || 0}</div>
                    <div>Failures: {proxy.failure_count || 0}</div>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    <div className="flex items-center gap-1.5">
                      <button
                        className="px-2.5 py-1 text-xs font-medium rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50 transition-colors"
                        onClick={() => handleTestProxy(proxy.id)}
                        disabled={testResults[proxy.id]?.testing}
                      >
                        Test
                      </button>
                      <button
                        className={`px-2.5 py-1 text-xs font-medium rounded-lg border transition-colors ${
                          proxy.is_active
                            ? 'border-yellow-300 text-yellow-700 hover:bg-yellow-50'
                            : 'border-green-300 text-green-700 hover:bg-green-50'
                        }`}
                        onClick={() => handleToggleProxy(proxy.id, proxy.is_active)}
                      >
                        {proxy.is_active ? 'Disable' : 'Enable'}
                      </button>
                      <button
                        className="px-2.5 py-1 text-xs font-medium rounded-lg border border-indigo-300 text-indigo-700 hover:bg-indigo-50 transition-colors"
                        onClick={() => setSelectedProxy(proxy)}
                      >
                        Assign
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
              {proxies.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-6 py-12 text-center text-gray-500">
                    No proxies found. Add one to get started.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {showAddProxy && (
        <div className="fixed z-50 inset-0 overflow-y-auto">
          <div className="flex items-center justify-center min-h-screen px-4">
            <div className="fixed inset-0 bg-gray-900/60 backdrop-blur-sm transition-opacity" onClick={() => setShowAddProxy(false)}></div>
            <div className="relative bg-white rounded-2xl shadow-2xl w-full max-w-lg transform transition-all animate-slide-up">
              <div className="px-6 py-5 border-b border-gray-100">
                <div className="flex items-center justify-between">
                  <h3 className="text-lg font-semibold text-gray-900">Add New Proxy</h3>
                  <button onClick={() => setShowAddProxy(false)} className="text-gray-400 hover:text-gray-600">
                    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                </div>
              </div>
              <form onSubmit={handleAddProxy}>
                <div className="px-6 py-4 space-y-4">
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="label">Name</label>
                      <input
                        type="text"
                        className="input-field"
                        value={newProxy.name}
                        onChange={(e) => setNewProxy({ ...newProxy, name: e.target.value })}
                        required
                      />
                    </div>
                    <div>
                      <label className="label">Type</label>
                      <select
                        className="input-field"
                        value={newProxy.type}
                        onChange={(e) => setNewProxy({ ...newProxy, type: e.target.value })}
                      >
                        <option value="http">HTTP</option>
                        <option value="https">HTTPS</option>
                        <option value="socks5">SOCKS5</option>
                      </select>
                    </div>
                  </div>

                  <div>
                    <label className="label">Server (with port)</label>
                    <input
                      type="text"
                      className="input-field"
                      placeholder="proxy.example.com:8080"
                      value={newProxy.server}
                      onChange={(e) => setNewProxy({ ...newProxy, server: e.target.value })}
                      required
                    />
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="label">Username</label>
                      <input
                        type="text"
                        className="input-field"
                        value={newProxy.username}
                        onChange={(e) => setNewProxy({ ...newProxy, username: e.target.value })}
                      />
                    </div>
                    <div>
                      <label className="label">Password</label>
                      <input
                        type="password"
                        className="input-field"
                        value={newProxy.password}
                        onChange={(e) => setNewProxy({ ...newProxy, password: e.target.value })}
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-3 gap-4">
                    <div>
                      <label className="label">Country Code</label>
                      <input
                        type="text"
                        className="input-field"
                        placeholder="US"
                        maxLength="2"
                        value={newProxy.country}
                        onChange={(e) => setNewProxy({ ...newProxy, country: e.target.value.toUpperCase() })}
                      />
                    </div>
                    <div>
                      <label className="label">City</label>
                      <input
                        type="text"
                        className="input-field"
                        value={newProxy.city}
                        onChange={(e) => setNewProxy({ ...newProxy, city: e.target.value })}
                      />
                    </div>
                    <div>
                      <label className="label">Provider</label>
                      <input
                        type="text"
                        className="input-field"
                        placeholder="Oxylabs"
                        value={newProxy.provider}
                        onChange={(e) => setNewProxy({ ...newProxy, provider: e.target.value })}
                      />
                    </div>
                  </div>

                  <label className="flex items-center gap-2.5 cursor-pointer">
                    <input
                      type="checkbox"
                      className="w-4 h-4 rounded border-gray-300 text-oracle-600 focus:ring-oracle-500"
                      checked={newProxy.is_residential}
                      onChange={(e) => setNewProxy({ ...newProxy, is_residential: e.target.checked })}
                    />
                    <span className="text-sm text-gray-700">Residential Proxy (Better for social media)</span>
                  </label>
                </div>
                <div className="px-6 py-4 border-t border-gray-100 flex justify-end gap-2">
                  <button type="button" className="btn-secondary" onClick={() => setShowAddProxy(false)}>
                    Cancel
                  </button>
                  <button type="submit" className="btn-primary">
                    Add Proxy
                  </button>
                </div>
              </form>
            </div>
          </div>
        </div>
      )}

      {selectedProxy && (
        <ProxyAssignment
          proxy={selectedProxy}
          socialAccounts={socialAccounts}
          onClose={() => setSelectedProxy(null)}
          onAssigned={() => {
            setSelectedProxy(null);
            fetchProxies();
          }}
        />
      )}
    </div>
  );
};

const ProxyAssignment = ({ proxy, socialAccounts, onClose, onAssigned }) => {
  const [assignedAccounts, setAssignedAccounts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedAccounts, setSelectedAccounts] = useState([]);

  useEffect(() => {
    fetchAssignments();
  }, [proxy]);

  const fetchAssignments = async () => {
    try {
      const accountsWithProxy = [];
      for (const account of socialAccounts) {
        const response = await api.get(`/api/proxies/account/${account.id}`);
        const hasProxy = response.data.some(p => p.id === proxy.id);
        if (hasProxy) {
          accountsWithProxy.push(account.id);
        }
      }
      setAssignedAccounts(accountsWithProxy);
      setSelectedAccounts(accountsWithProxy);
    } catch (error) {
      console.error('Error fetching assignments:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleAssign = async () => {
    try {
      for (const accountId of selectedAccounts) {
        if (!assignedAccounts.includes(accountId)) {
          const response = await api.get(`/api/proxies/account/${accountId}`);
          const existingProxyIds = response.data.map(p => p.id);

          await api.post(`/api/proxies/account/${accountId}/assign`, {
            proxy_ids: [...existingProxyIds, proxy.id]
          });
        }
      }

      for (const accountId of assignedAccounts) {
        if (!selectedAccounts.includes(accountId)) {
          await api.delete(`/api/proxies/account/${accountId}/proxy/${proxy.id}`);
        }
      }

      onAssigned();
    } catch (error) {
      console.error('Error assigning proxy:', error);
      alert('Failed to assign proxy: ' + error.message);
    }
  };

  const toggleAccount = (accountId) => {
    if (selectedAccounts.includes(accountId)) {
      setSelectedAccounts(selectedAccounts.filter(id => id !== accountId));
    } else {
      setSelectedAccounts([...selectedAccounts, accountId]);
    }
  };

  return (
    <div className="fixed z-50 inset-0 overflow-y-auto">
      <div className="flex items-center justify-center min-h-screen px-4">
        <div className="fixed inset-0 bg-gray-900/60 backdrop-blur-sm transition-opacity" onClick={onClose}></div>
        <div className="relative bg-white rounded-2xl shadow-2xl w-full max-w-lg transform transition-all animate-slide-up">
          <div className="px-6 py-5 border-b border-gray-100">
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-semibold text-gray-900">Assign Proxy: {proxy.name}</h3>
              <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          </div>
          <div className="px-6 py-4">
            {loading ? (
              <div className="flex items-center justify-center py-8">
                <div className="animate-spin rounded-full h-6 w-6 border-2 border-oracle-400 border-t-transparent"></div>
              </div>
            ) : (
              <>
                <p className="text-sm text-gray-500 mb-4">
                  Select social accounts that should use this proxy. Each account can have multiple proxies for rotation.
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {socialAccounts.map(account => (
                    <label
                      key={account.id}
                      className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${
                        selectedAccounts.includes(account.id)
                          ? 'border-oracle-300 bg-oracle-50/50'
                          : 'border-gray-200 hover:border-gray-300'
                      }`}
                    >
                      <input
                        type="checkbox"
                        className="mt-0.5 w-4 h-4 rounded border-gray-300 text-oracle-600 focus:ring-oracle-500"
                        checked={selectedAccounts.includes(account.id)}
                        onChange={() => toggleAccount(account.id)}
                      />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium text-gray-900">{account.username}</span>
                          <span className="px-1.5 py-0.5 rounded text-xs font-medium bg-gray-100 text-gray-600">{account.platform}</span>
                        </div>
                        {assignedAccounts.includes(account.id) && (
                          <span className="text-xs text-blue-600">Currently Assigned</span>
                        )}
                      </div>
                    </label>
                  ))}
                </div>
              </>
            )}
          </div>
          <div className="px-6 py-4 border-t border-gray-100 flex justify-end gap-2">
            <button type="button" className="btn-secondary" onClick={onClose}>
              Cancel
            </button>
            <button
              type="button"
              className="btn-primary"
              onClick={handleAssign}
              disabled={loading}
            >
              Save Assignments
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default ProxyManagement;
