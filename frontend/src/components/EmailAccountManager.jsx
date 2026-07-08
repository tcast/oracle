import React, { useState, useEffect } from 'react';
import CreateEmailAccountsForm from './CreateEmailAccountsForm';
import api from '../utils/api';

const EmailAccountManager = () => {
  const [accounts, setAccounts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [stats, setStats] = useState(null);
  const [filters, setFilters] = useState({
    search: '',
    provider: '',
    status: '',
    assigned: ''
  });
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [serviceHealth, setServiceHealth] = useState(null);

  useEffect(() => {
    fetchStats();
    fetchServiceHealth();
  }, []);

  useEffect(() => {
    fetchAccounts();
  }, [filters]);

  const fetchAccounts = async () => {
    try {
      setLoading(true);
      const queryParams = new URLSearchParams();
      if (filters.search) queryParams.append('search', filters.search);
      if (filters.provider) queryParams.append('provider', filters.provider);
      if (filters.status) queryParams.append('status', filters.status);
      if (filters.assigned) queryParams.append('assigned', filters.assigned);

      const response = await api.get(`/api/email-accounts?${queryParams}`);
      setAccounts(response.data);
      setError(null);
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setLoading(false);
    }
  };

  const fetchStats = async () => {
    try {
      const response = await api.get('/api/email-accounts/stats');
      setStats(response.data.overview);
    } catch (err) {
      console.error('Error fetching stats:', err);
    }
  };

  const fetchServiceHealth = async () => {
    try {
      const response = await api.get('/api/email-accounts/health');
      setServiceHealth(response.data);
    } catch (err) {
      console.error('Error fetching service health:', err);
    }
  };

  const handleFilterChange = (name, value) => {
    setFilters(prev => ({
      ...prev,
      [name]: value
    }));
  };

  const handleCreateSuccess = () => {
    fetchAccounts();
    fetchStats();
    setShowCreateForm(false);
  };

  const handleTestLogin = async (accountId) => {
    try {
      const response = await api.post(`/api/email-accounts/${accountId}/test`);
      if (response.data.success) {
        alert('Login test passed!');
      } else {
        alert('Login test failed');
      }
      fetchAccounts();
    } catch (err) {
      alert('Error testing login: ' + err.message);
    }
  };

  const handleUpdateStatus = async (accountId, newStatus) => {
    try {
      await api.patch(`/api/email-accounts/${accountId}/status`, { status: newStatus });
      fetchAccounts();
      fetchStats();
    } catch (err) {
      alert('Error updating status: ' + err.message);
    }
  };

  const handleDelete = async (accountId) => {
    if (!window.confirm('Are you sure you want to delete this email account?')) {
      return;
    }

    try {
      await api.delete(`/api/email-accounts/${accountId}`);
      fetchAccounts();
      fetchStats();
    } catch (err) {
      alert(err.response?.data?.error || 'Error deleting account');
    }
  };

  const getProviderBadgeColor = (provider) => {
    const colors = {
      yahoo: 'bg-purple-100 text-purple-800',
      gmx: 'bg-blue-100 text-blue-800',
      'mail.com': 'bg-green-100 text-green-800'
    };
    return colors[provider] || 'bg-gray-100 text-gray-800';
  };

  const getStatusBadgeColor = (status) => {
    const colors = {
      active: 'bg-green-100 text-green-800',
      inactive: 'bg-gray-100 text-gray-800',
      banned: 'bg-red-100 text-red-800',
      locked: 'bg-yellow-100 text-yellow-800'
    };
    return colors[status] || 'bg-gray-100 text-gray-800';
  };

  return (
    <div className="space-y-6 p-6">
      {/* Header */}
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Email Account Manager</h1>
          <p className="text-gray-600 mt-1">Manage your email account pool for social media automation</p>
        </div>
        <button
          onClick={() => setShowCreateForm(true)}
          className="bg-blue-600 hover:bg-blue-700 text-white px-6 py-2 rounded-lg font-medium"
        >
          + Create Email Accounts
        </button>
      </div>

      {/* Stats Dashboard */}
      {stats && (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
          <div className="bg-white shadow rounded-lg p-4">
            <div className="text-gray-500 text-sm">Total Accounts</div>
            <div className="text-2xl font-bold text-gray-900">{stats.total || 0}</div>
          </div>
          <div className="bg-white shadow rounded-lg p-4">
            <div className="text-gray-500 text-sm">Active</div>
            <div className="text-2xl font-bold text-green-600">{stats.active || 0}</div>
          </div>
          <div className="bg-white shadow rounded-lg p-4">
            <div className="text-gray-500 text-sm">Verified</div>
            <div className="text-2xl font-bold text-blue-600">{stats.verified || 0}</div>
          </div>
          <div className="bg-white shadow rounded-lg p-4">
            <div className="text-gray-500 text-sm">Yahoo</div>
            <div className="text-2xl font-bold text-purple-600">{stats.yahoo || 0}</div>
          </div>
          <div className="bg-white shadow rounded-lg p-4">
            <div className="text-gray-500 text-sm">GMX</div>
            <div className="text-2xl font-bold text-blue-600">{stats.gmx || 0}</div>
          </div>
          <div className="bg-white shadow rounded-lg p-4">
            <div className="text-gray-500 text-sm">Assigned</div>
            <div className="text-2xl font-bold text-purple-600">{stats.assigned || 0}</div>
          </div>
        </div>
      )}

      {/* Service Health */}
      {serviceHealth && (
        <div className="bg-white shadow rounded-lg p-4">
          <h3 className="font-semibold mb-3">Service Health</h3>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-sm">
            <div>
              <span className="font-medium">5SIM:</span>{' '}
              <span className={serviceHealth.fiveSim.status === 'online' ? 'text-green-600' : 'text-red-600'}>
                {serviceHealth.fiveSim.status}
              </span>
              {serviceHealth.fiveSim.balance !== null && (
                <span className="ml-2 text-gray-600">(${serviceHealth.fiveSim.balance?.toFixed(2)})</span>
              )}
            </div>
            <div>
              <span className="font-medium">2Captcha:</span>{' '}
              <span className={serviceHealth.captcha.twoCaptcha.status === 'online' ? 'text-green-600' : 'text-gray-400'}>
                {serviceHealth.captcha.twoCaptcha.status}
              </span>
              {serviceHealth.captcha.twoCaptcha.balance !== null && (
                <span className="ml-2 text-gray-600">(${serviceHealth.captcha.twoCaptcha.balance?.toFixed(2)})</span>
              )}
            </div>
            <div>
              <span className="font-medium">CapSolver:</span>{' '}
              <span className={serviceHealth.captcha.capSolver.status === 'online' ? 'text-green-600' : 'text-gray-400'}>
                {serviceHealth.captcha.capSolver.status}
              </span>
              {serviceHealth.captcha.capSolver.balance !== null && (
                <span className="ml-2 text-gray-600">(${serviceHealth.captcha.capSolver.balance?.toFixed(2)})</span>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Filters */}
      <div className="bg-white shadow rounded-lg p-4">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Search</label>
            <input
              type="text"
              value={filters.search}
              onChange={(e) => handleFilterChange('search', e.target.value)}
              placeholder="Search email or username..."
              className="w-full px-3 py-2 border border-gray-300 rounded-md"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Provider</label>
            <select
              value={filters.provider}
              onChange={(e) => handleFilterChange('provider', e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-md"
            >
              <option value="">All Providers</option>
              <option value="yahoo">Yahoo</option>
              <option value="gmx">GMX</option>
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Status</label>
            <select
              value={filters.status}
              onChange={(e) => handleFilterChange('status', e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-md"
            >
              <option value="">All Statuses</option>
              <option value="active">Active</option>
              <option value="inactive">Inactive</option>
              <option value="banned">Banned</option>
              <option value="locked">Locked</option>
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Assignment</label>
            <select
              value={filters.assigned}
              onChange={(e) => handleFilterChange('assigned', e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-md"
            >
              <option value="">All</option>
              <option value="false">Available</option>
              <option value="true">Assigned</option>
            </select>
          </div>
        </div>
      </div>

      {/* Accounts Table */}
      <div className="bg-white shadow rounded-lg overflow-hidden">
        {loading ? (
          <div className="text-center py-8 text-gray-600">Loading email accounts...</div>
        ) : accounts.length === 0 ? (
          <div className="text-center py-8 text-gray-600">
            No email accounts found. Create your first batch!
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Provider
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Email
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Username
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Phone
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Status
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Verified
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Created
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-gray-200">
                {accounts.map((account) => (
                  <tr key={account.id} className="hover:bg-gray-50">
                    <td className="px-6 py-4 whitespace-nowrap">
                      <span className={`px-2 py-1 text-xs font-semibold rounded-full ${getProviderBadgeColor(account.provider)}`}>
                        {account.provider}
                      </span>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                      {account.email}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-600">
                      {account.username}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-600">
                      {account.phone_number ? (
                        <span title={`via ${account.phone_provider}`}>
                          {account.phone_number.substring(0, 10)}...
                        </span>
                      ) : (
                        <span className="text-gray-400">-</span>
                      )}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <select
                        value={account.status}
                        onChange={(e) => handleUpdateStatus(account.id, e.target.value)}
                        className={`text-xs px-2 py-1 rounded-full border-0 ${getStatusBadgeColor(account.status)}`}
                      >
                        <option value="active">Active</option>
                        <option value="inactive">Inactive</option>
                        <option value="banned">Banned</option>
                        <option value="locked">Locked</option>
                      </select>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm">
                      {account.is_verified ? (
                        <span className="text-green-600">✓ Verified</span>
                      ) : (
                        <span className="text-gray-400">Not verified</span>
                      )}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-600">
                      {new Date(account.created_at).toLocaleDateString()}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm space-x-2">
                      <button
                        onClick={() => handleTestLogin(account.id)}
                        className="text-blue-600 hover:text-blue-800"
                        title="Test login"
                      >
                        Test
                      </button>
                      <button
                        onClick={() => handleDelete(account.id)}
                        className="text-red-600 hover:text-red-800"
                        title="Delete account"
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Create Form Modal */}
      {showCreateForm && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg shadow-xl max-w-2xl w-full mx-4">
            <CreateEmailAccountsForm
              onClose={() => setShowCreateForm(false)}
              onSuccess={handleCreateSuccess}
            />
          </div>
        </div>
      )}
    </div>
  );
};

export default EmailAccountManager;
