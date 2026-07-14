import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../utils/api';

const PLATFORMS = ['linkedin', 'x', 'facebook', 'instagram'];

const BrandCampaignCreator = () => {
  const navigate = useNavigate();
  const [brands, setBrands] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [form, setForm] = useState({
    brand_id: '',
    name: '',
    campaign_overview: '',
    campaign_goal: '',
    target_url: '',
    overt_platforms: ['linkedin', 'x', 'facebook', 'instagram'],
  });

  useEffect(() => {
    (async () => {
      try {
        const { data } = await api.get('/api/brands');
        setBrands(data);
        if (data[0]) setForm((f) => ({ ...f, brand_id: String(data[0].id) }));
      } catch (err) {
        setError(err.response?.data?.error || err.message);
      }
    })();
  }, []);

  const togglePlatform = (p) => {
    setForm((f) => ({
      ...f,
      overt_platforms: f.overt_platforms.includes(p)
        ? f.overt_platforms.filter((x) => x !== p)
        : [...f.overt_platforms, p],
    }));
  };

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { data } = await api.post('/api/campaigns', {
        ...form,
        brand_id: parseInt(form.brand_id),
        campaign_type: 'brand',
        platform: form.overt_platforms,
        post_goal: 10,
        comment_goal: 0,
        target_sentiment: 0.5,
        is_live: false,
      });
      navigate(`/campaigns/${data.id}`);
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="max-w-2xl mx-auto py-8 px-4">
      <h1 className="page-title">New brand campaign</h1>
      <p className="page-subtitle mb-6">
        Traditional marketing — post as the brand and run Google / Meta ads. Separate from Whisper army campaigns.
      </p>

      <form onSubmit={submit} className="card p-5 space-y-4">
        <div>
          <label className="label">Brand</label>
          <select
            className="input-field"
            required
            value={form.brand_id}
            onChange={(e) => setForm({ ...form, brand_id: e.target.value })}
          >
            <option value="">Select…</option>
            {brands.map((b) => (
              <option key={b.id} value={b.id}>{b.name}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="label">Campaign name</label>
          <input className="input-field" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </div>
        <div>
          <label className="label">Overview</label>
          <textarea className="input-field" rows={3} required value={form.campaign_overview} onChange={(e) => setForm({ ...form, campaign_overview: e.target.value })} />
        </div>
        <div>
          <label className="label">Goal</label>
          <textarea className="input-field" rows={2} value={form.campaign_goal} onChange={(e) => setForm({ ...form, campaign_goal: e.target.value })} />
        </div>
        <div>
          <label className="label">Landing URL</label>
          <input className="input-field" value={form.target_url} onChange={(e) => setForm({ ...form, target_url: e.target.value })} placeholder="https://" />
        </div>
        <div>
          <label className="label">Brand channels to use</label>
          <div className="flex flex-wrap gap-3 text-sm mt-1">
            {PLATFORMS.map((p) => (
              <label key={p} className="flex items-center gap-1.5 capitalize">
                <input type="checkbox" checked={form.overt_platforms.includes(p)} onChange={() => togglePlatform(p)} />
                {p}
              </label>
            ))}
          </div>
        </div>
        {error && <p className="text-sm text-red-600">{error}</p>}
        <button type="submit" className="btn-primary" disabled={busy}>
          {busy ? 'Creating…' : 'Create brand campaign'}
        </button>
      </form>
    </div>
  );
};

export default BrandCampaignCreator;
