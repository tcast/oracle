import React, { useState, useEffect, useCallback } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import api from '../utils/api';

const BrandsList = () => {
  const [brands, setBrands] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [showCreate, setShowCreate] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newCompany, setNewCompany] = useState({ name: '', website: '' });
  const [searchParams] = useSearchParams();
  const oauthError = searchParams.get('oauth_error');

  const load = useCallback(async () => {
    try {
      const { data } = await api.get('/api/brands');
      setBrands(data);
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const createCompany = async (event) => {
    event.preventDefault();
    setCreating(true);
    setError(null);
    try {
      await api.post('/api/brands', newCompany);
      setNewCompany({ name: '', website: '' });
      setShowCreate(false);
      await load();
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setCreating(false);
    }
  };

  if (loading) {
    return (
      <div className="flex justify-center py-20">
        <div className="animate-spin rounded-full h-10 w-10 border-2 border-whisper-400 border-t-transparent" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="page-title">Companies</h1>
          <p className="page-subtitle">
            Company data rooms, reusable ads, official channels, and ad accounts.
          </p>
        </div>
        <button type="button" className="btn-primary" onClick={() => setShowCreate(!showCreate)}>
          {showCreate ? 'Cancel' : 'Add company'}
        </button>
      </div>

      {oauthError && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          OAuth error: {oauthError}
        </div>
      )}
      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
      )}

      {showCreate && (
        <form onSubmit={createCompany} className="card p-5 grid gap-3 md:grid-cols-[1fr_1fr_auto] items-end">
          <label>
            <span className="block text-xs font-medium text-gray-500 mb-1">Company name</span>
            <input className="input-field" required value={newCompany.name} onChange={(event) => setNewCompany({ ...newCompany, name: event.target.value })} />
          </label>
          <label>
            <span className="block text-xs font-medium text-gray-500 mb-1">Website</span>
            <input className="input-field" value={newCompany.website} onChange={(event) => setNewCompany({ ...newCompany, website: event.target.value })} placeholder="https://" />
          </label>
          <button className="btn-primary" disabled={creating}>{creating ? 'Creating…' : 'Create'}</button>
        </form>
      )}

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {brands.map((brand) => (
          <div
            key={brand.id}
            className="card p-5 hover:border-whisper-200 hover:shadow-lg transition-all"
          >
            <Link to={`/brands/${brand.id}`}>
              <h2 className="text-lg font-semibold text-gray-900 hover:text-whisper-600">{brand.name}</h2>
              {brand.website && <p className="mt-1 text-sm text-gray-500 truncate">{brand.website}</p>}
            </Link>
            <div className="mt-4 flex gap-3 text-xs text-gray-500">
              <span>{brand.asset_count || 0} assets</span>
              <span>{brand.creative_count || 0} ads</span>
              <span>{brand.channel_count || 0} channels</span>
            </div>
            <div className="mt-4 pt-3 border-t border-gray-100 flex gap-3">
              <Link to={`/brands/${brand.id}/data-room`} className="text-sm text-whisper-600 hover:underline">Data room</Link>
              <Link to={`/ads?brand_id=${brand.id}`} className="text-sm text-whisper-600 hover:underline">Build ads</Link>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

export default BrandsList;
