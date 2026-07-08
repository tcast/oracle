import React, { useState } from 'react';
import api from '../utils/api';

const CreateAccountsForm = ({ onClose, onSuccess }) => {
  const [formData, setFormData] = useState({
    platform: 'reddit',
    count: 1,
    emailDomain: '',
    usernamePrefix: ''
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const response = await api.post('/api/social-accounts/create', formData);
      onSuccess(response.data);
      onClose();
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'Failed to create accounts');
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

      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="label">Platform</label>
          <select
            value={formData.platform}
            onChange={(e) => setFormData({ ...formData, platform: e.target.value })}
            className="input-field"
          >
            <option value="reddit">Reddit</option>
          </select>
        </div>

        <div>
          <label className="label">Number of Accounts</label>
          <input
            type="number"
            min="1"
            max="10"
            value={formData.count}
            onChange={(e) => setFormData({ ...formData, count: parseInt(e.target.value) || 1 })}
            className="input-field"
          />
        </div>

        <div>
          <label className="label">Email Domain</label>
          <div className="flex rounded-lg shadow-sm">
            <span className="inline-flex items-center px-3 rounded-l-lg border border-r-0 border-gray-200 bg-gray-50 text-gray-500 text-sm">@</span>
            <input
              type="text"
              value={formData.emailDomain}
              onChange={(e) => setFormData({ ...formData, emailDomain: e.target.value })}
              placeholder="example.com"
              className="flex-1 min-w-0 block w-full px-3 py-2 rounded-none rounded-r-lg border-gray-200 focus:border-oracle-500 focus:ring-oracle-500 sm:text-sm"
            />
          </div>
          <p className="mt-1 text-xs text-gray-500">Accounts will be created with emails like username@{formData.emailDomain || 'example.com'}</p>
        </div>

        <div>
          <label className="label">Username Prefix</label>
          <input
            type="text"
            value={formData.usernamePrefix}
            onChange={(e) => setFormData({ ...formData, usernamePrefix: e.target.value })}
            placeholder="user"
            className="input-field"
          />
          <p className="mt-1 text-xs text-gray-500">Usernames will be created like: {formData.usernamePrefix || 'user'}123</p>
        </div>

        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-xl text-sm animate-fade-in">
            {error}
          </div>
        )}

        <div className="flex justify-end space-x-3 pt-4 border-t border-gray-100">
          <button type="button" onClick={onClose} className="btn-secondary">Cancel</button>
          <button type="submit" disabled={loading} className="btn-primary">
            {loading ? 'Creating...' : 'Create Accounts'}
          </button>
        </div>
      </form>
    </div>
  );
};

export default CreateAccountsForm;
