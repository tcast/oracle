import React, { useState } from 'react';
import api from '../utils/api';

const CreateEmailAccountsForm = ({ onClose, onSuccess }) => {
  const [formData, setFormData] = useState({
    provider: 'yahoo',
    count: 10,
    nameStyle: 'random',
    useProxies: false
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [progress, setProgress] = useState(null);

  const handleChange = (e) => {
    const { name, value, type, checked } = e.target;
    setFormData(prev => ({
      ...prev,
      [name]: type === 'checkbox' ? checked : value
    }));
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setProgress(null);

    try {
      // Submit batch creation request
      const response = await api.post('/api/email-accounts/create', formData);

      // Show results
      setProgress(response.data);

      // If successful, close after showing results briefly
      setTimeout(() => {
        onSuccess(response.data);
      }, 3000);

    } catch (err) {
      setError(err.response?.data?.error || err.message || 'Failed to create email accounts');
    } finally {
      setLoading(false);
    }
  };

  const estimatedTime = () => {
    const count = parseInt(formData.count) || 0;
    const minMinutes = Math.ceil((count * 30) / 60);
    const maxMinutes = Math.ceil((count * 60) / 60);
    return `${minMinutes}-${maxMinutes} minutes`;
  };

  const estimatedCost = () => {
    const count = parseInt(formData.count) || 0;
    const smsAvg = formData.provider === 'yandex' ? 0.15 : 0.20;
    const captchaAvg = 0.003; // ~$3 per 1000
    const total = (smsAvg + captchaAvg) * count;
    return `$${total.toFixed(2)}`;
  };

  return (
    <div className="p-6">
      <div className="flex justify-between items-center mb-6">
        <h2 className="text-2xl font-bold text-gray-900">Create Email Accounts</h2>
        <button
          onClick={onClose}
          className="text-gray-400 hover:text-gray-600 text-2xl"
          disabled={loading}
        >
          ×
        </button>
      </div>

      {!progress ? (
        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Provider Selection */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Email Provider *
            </label>
            <select
              name="provider"
              value={formData.provider}
              onChange={handleChange}
              required
              disabled={loading}
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-blue-500 focus:border-blue-500"
            >
              <option value="yahoo">Yahoo (@yahoo.com) - ~$0.06/account</option>
              <option value="gmx">GMX (@gmx.com) - ~$0.20/account</option>
            </select>
            <p className="mt-1 text-xs text-gray-500">
              {formData.provider === 'yahoo' && 'Major US provider - most legitimate, cheapest option'}
              {formData.provider === 'gmx' && 'German provider - good European alternative'}
            </p>
          </div>

          {/* Count */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Number of Accounts * (1-50)
            </label>
            <input
              type="number"
              name="count"
              value={formData.count}
              onChange={handleChange}
              min="1"
              max="50"
              required
              disabled={loading}
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-blue-500 focus:border-blue-500"
            />
            <p className="mt-1 text-xs text-gray-500">
              Estimated time: {estimatedTime()} | Estimated cost: {estimatedCost()}
            </p>
          </div>

          {/* Name Style */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Username Style *
            </label>
            <select
              name="nameStyle"
              value={formData.nameStyle}
              onChange={handleChange}
              required
              disabled={loading}
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-blue-500 focus:border-blue-500"
            >
              <option value="random">Random Mix (Recommended)</option>
              <option value="professional">Professional (firstname.lastname)</option>
              <option value="casual">Casual (firstname + numbers)</option>
              <option value="tech">Tech Style (firstname.lastname.dev)</option>
            </select>
            <p className="mt-1 text-xs text-gray-500">
              {formData.nameStyle === 'professional' && 'Examples: sarah.chen@yandex.com, mike.johnson@gmx.com'}
              {formData.nameStyle === 'casual' && 'Examples: alex92@yandex.com, sarah_tech@gmx.com'}
              {formData.nameStyle === 'tech' && 'Examples: john.smith.dev@yandex.com, emily.jones.pro@gmx.com'}
              {formData.nameStyle === 'random' && 'Examples: sarah.chen@yandex.com, mike92@gmx.com, alex.williams.tech@yandex.com'}
            </p>
          </div>

          {/* Use Proxies */}
          <div className="flex items-center">
            <input
              type="checkbox"
              name="useProxies"
              checked={formData.useProxies}
              onChange={handleChange}
              disabled={loading}
              className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded"
            />
            <label className="ml-2 block text-sm text-gray-700">
              Use proxy rotation (recommended)
            </label>
          </div>

          {/* Error Display */}
          {error && (
            <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded">
              <strong>Error:</strong> {error}
            </div>
          )}

          {/* Warning */}
          <div className="bg-yellow-50 border border-yellow-200 text-yellow-800 px-4 py-3 rounded text-sm">
            <strong>Note:</strong> This will use SMS-Man credits for phone verification and
            2Captcha/CapSolver for CAPTCHA solving. Make sure you have sufficient balance.
          </div>

          {/* Action Buttons */}
          <div className="flex justify-end space-x-3 pt-4">
            <button
              type="button"
              onClick={onClose}
              disabled={loading}
              className="px-4 py-2 border border-gray-300 rounded-md text-gray-700 hover:bg-gray-50 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading}
              className="px-6 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {loading ? (
                <span className="flex items-center">
                  <svg className="animate-spin -ml-1 mr-2 h-4 w-4 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                  </svg>
                  Creating Accounts...
                </span>
              ) : (
                `Create ${formData.count} Account${formData.count > 1 ? 's' : ''}`
              )}
            </button>
          </div>
        </form>
      ) : (
        /* Results Display */
        <div className="space-y-4">
          <div className="text-center">
            <h3 className="text-xl font-bold text-gray-900 mb-2">Batch Creation Complete!</h3>
            <div className="text-lg text-gray-600">
              ✅ {progress.successCount} successful | ❌ {progress.failureCount} failed
            </div>
            <div className="text-sm text-gray-500 mt-1">
              Success rate: {progress.successRate}%
            </div>
          </div>

          {progress.success && progress.success.length > 0 && (
            <div className="max-h-60 overflow-y-auto">
              <h4 className="font-semibold text-green-700 mb-2">Successful Accounts:</h4>
              <ul className="space-y-1 text-sm">
                {progress.success.map((account, idx) => (
                  <li key={idx} className="text-gray-700">
                    ✓ {account.email}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {progress.failed && progress.failed.length > 0 && (
            <div className="max-h-40 overflow-y-auto">
              <h4 className="font-semibold text-red-700 mb-2">Failed Attempts:</h4>
              <ul className="space-y-1 text-sm">
                {progress.failed.map((failure, idx) => (
                  <li key={idx} className="text-gray-600">
                    ✗ {failure.username}: {failure.error}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="flex justify-end">
            <button
              onClick={onClose}
              className="px-6 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700"
            >
              Close
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export default CreateEmailAccountsForm;
