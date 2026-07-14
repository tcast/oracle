import React, { useState, useEffect, useCallback } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import api from '../utils/api';

const SOCIAL = [
  { id: 'linkedin', label: 'LinkedIn' },
  { id: 'x', label: 'X' },
  { id: 'facebook', label: 'Facebook' },
  { id: 'instagram', label: 'Instagram' },
];

const ADS = [
  { id: 'google_ads', label: 'Google Ads' },
  { id: 'meta_ads', label: 'Meta Ads' },
];

const OAUTH_PROVIDERS = [
  {
    id: 'linkedin',
    label: 'LinkedIn',
    fields: [
      { key: 'client_id', label: 'Client ID' },
      { key: 'client_secret', label: 'Client Secret', secret: true },
    ],
  },
  {
    id: 'x',
    label: 'X (Twitter)',
    fields: [
      { key: 'client_id', label: 'Client ID' },
      { key: 'client_secret', label: 'Client Secret', secret: true },
    ],
  },
  {
    id: 'meta',
    label: 'Meta (Facebook / Instagram / Meta Ads)',
    hint: 'One Meta app powers Facebook Page, Instagram, and Meta Ads connects.',
    fields: [
      { key: 'client_id', label: 'App ID' },
      { key: 'client_secret', label: 'App Secret', secret: true },
    ],
  },
  {
    id: 'google_ads',
    label: 'Google Ads',
    fields: [
      { key: 'client_id', label: 'OAuth Client ID' },
      { key: 'client_secret', label: 'OAuth Client Secret', secret: true },
      { key: 'developer_token', label: 'Developer Token', extra: true },
      { key: 'login_customer_id', label: 'Login Customer ID (MCC, optional)', extra: true },
    ],
  },
];

const emptyForm = () => ({
  client_id: '',
  client_secret: '',
  developer_token: '',
  login_customer_id: '',
});

const ASSET_KINDS = [
  { id: 'logo', label: 'Logo' },
  { id: 'screenshot', label: 'Screenshot' },
  { id: 'product', label: 'Product' },
  { id: 'lifestyle', label: 'Lifestyle' },
  { id: 'pitch_deck', label: 'Pitch deck' },
  { id: 'brand_guide', label: 'Brand guide' },
  { id: 'document', label: 'Document' },
  { id: 'other', label: 'Other' },
];

const BrandDetail = () => {
  const { id } = useParams();
  const [searchParams] = useSearchParams();
  const [brand, setBrand] = useState(null);
  const [saving, setSaving] = useState(false);
  const [savingProvider, setSavingProvider] = useState(null);
  const [error, setError] = useState(null);
  const [voice, setVoice] = useState('');
  const [website, setWebsite] = useState('');
  const [oauthForms, setOauthForms] = useState({});
  const [assetKind, setAssetKind] = useState('logo');
  const [assetLabel, setAssetLabel] = useState('');
  const [uploadingAsset, setUploadingAsset] = useState(false);
  const connected = searchParams.get('connected');

  const load = useCallback(async () => {
    try {
      const { data } = await api.get(`/api/brands/${id}`);
      setBrand(data);
      setVoice(data.brand_voice || '');
      setWebsite(data.website || '');
      const forms = {};
      for (const p of OAUTH_PROVIDERS) {
        const app = data.oauth_apps?.[p.id] || {};
        forms[p.id] = {
          client_id: app.client_id || '',
          client_secret: '',
          developer_token: app.extra?.developer_token || '',
          login_customer_id: app.extra?.login_customer_id || '',
          has_secret: !!app.has_secret,
          configured: !!app.configured,
        };
      }
      setOauthForms(forms);
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    }
  }, [id]);

  useEffect(() => { load(); }, [load]);

  const save = async () => {
    setSaving(true);
    try {
      await api.patch(`/api/brands/${id}`, { brand_voice: voice, website });
      await load();
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setSaving(false);
    }
  };

  const saveOAuth = async (provider) => {
    setSavingProvider(provider);
    setError(null);
    try {
      const form = oauthForms[provider] || emptyForm();
      const body = {
        client_id: form.client_id,
        extra: {},
      };
      if (form.client_secret) body.client_secret = form.client_secret;
      if (provider === 'google_ads') {
        body.extra = {
          developer_token: form.developer_token || undefined,
          login_customer_id: form.login_customer_id || undefined,
        };
      }
      await api.put(`/api/brands/${id}/oauth-apps/${provider}`, body);
      await load();
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setSavingProvider(null);
    }
  };

  const connectChannel = async (platform) => {
    try {
      const { data } = await api.get(`/api/brands/${id}/channels/connect/${platform}`);
      window.location.href = data.url;
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    }
  };

  const connectAds = async (platform) => {
    try {
      const { data } = await api.get(`/api/brands/${id}/ad-accounts/connect/${platform}`);
      window.location.href = data.url;
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    }
  };

  const disconnectChannel = async (channelId) => {
    await api.delete(`/api/brands/${id}/channels/${channelId}`);
    await load();
  };

  const disconnectAd = async (accountId) => {
    await api.delete(`/api/brands/${id}/ad-accounts/${accountId}`);
    await load();
  };

  const updateOauthField = (provider, key, value) => {
    setOauthForms((prev) => ({
      ...prev,
      [provider]: { ...(prev[provider] || emptyForm()), [key]: value },
    }));
  };

  const uploadAsset = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setUploadingAsset(true);
    setError(null);
    try {
      const body = new FormData();
      body.append('media', file);
      body.append('kind', assetKind);
      if (assetLabel.trim()) body.append('label', assetLabel.trim());
      await api.post(`/api/brands/${id}/assets`, body, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      setAssetLabel('');
      await load();
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setUploadingAsset(false);
    }
  };

  const updateAssetKind = async (assetId, kind) => {
    try {
      await api.patch(`/api/brands/${id}/assets/${assetId}`, { kind });
      await load();
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    }
  };

  const deleteAsset = async (assetId) => {
    try {
      await api.delete(`/api/brands/${id}/assets/${assetId}`);
      await load();
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    }
  };

  if (!brand && !error) {
    return (
      <div className="flex justify-center py-20">
        <div className="animate-spin rounded-full h-10 w-10 border-2 border-whisper-400 border-t-transparent" />
      </div>
    );
  }

  if (error && !brand) {
    return <div className="text-red-600">{error}</div>;
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <Link to="/brands" className="text-sm text-whisper-600 hover:underline">← Companies</Link>
          <h1 className="page-title mt-1">{brand.name}</h1>
          <p className="page-subtitle">Assets, OAuth apps, channels, and ad accounts</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link to={`/brands/${id}/data-room`} className="btn-secondary">Data room</Link>
          <Link to={`/ads?brand_id=${id}`} className="btn-primary">Build ads</Link>
        </div>
      </div>

      {connected && (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
          Connected: {connected.replace('_', ' ')}
        </div>
      )}
      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
      )}

      <div className="card p-5 space-y-4">
        <h2 className="text-sm font-semibold text-gray-900 uppercase tracking-wide">Brand profile</h2>
        <div>
          <label className="block text-xs font-medium text-gray-500 mb-1">Website</label>
          <input className="input-field" value={website} onChange={(e) => setWebsite(e.target.value)} />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-500 mb-1">Brand voice</label>
          <textarea className="input-field" rows={4} value={voice} onChange={(e) => setVoice(e.target.value)} />
        </div>
        <button type="button" className="btn-primary" onClick={save} disabled={saving}>
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>

      <div className="card p-5 space-y-4">
        <div>
          <h2 className="text-sm font-semibold text-gray-900 uppercase tracking-wide">Brand assets</h2>
          <p className="text-sm text-gray-500 mt-1">
            Quick-upload a visual here, or use the data room for multiple files, decks, and documents.
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">Type</label>
            <select className="input-field" value={assetKind} onChange={(e) => setAssetKind(e.target.value)}>
              {ASSET_KINDS.map((k) => (
                <option key={k.id} value={k.id}>{k.label}</option>
              ))}
            </select>
          </div>
          <div className="flex-1 min-w-[10rem]">
            <label className="block text-xs font-medium text-gray-500 mb-1">Label (optional)</label>
            <input
              className="input-field"
              value={assetLabel}
              onChange={(e) => setAssetLabel(e.target.value)}
              placeholder="e.g. primary logo, dashboard dark"
            />
          </div>
          <label className="btn-secondary text-sm cursor-pointer">
            {uploadingAsset ? 'Uploading…' : 'Upload'}
            <input
              type="file"
              accept=".png,.jpg,.jpeg,.webp,.gif,.pdf,.pptx,.docx,.txt,.md,.rtf,.csv,.mp4,.mov"
              className="hidden"
              disabled={uploadingAsset}
              onChange={uploadAsset}
            />
          </label>
        </div>
        <div className="grid sm:grid-cols-3 gap-3">
          {(brand.assets || []).map((asset) => (
            <div key={asset.id} className="border border-gray-200 rounded-lg overflow-hidden bg-gray-50">
              {(asset.mime_type || '').startsWith('image/') || /\.(png|jpe?g|webp|gif)$/i.test(asset.url) ? (
                <img src={asset.url} alt={asset.label || asset.kind} className="w-full h-32 object-contain bg-white" />
              ) : (
                <div className="h-32 flex items-center justify-center text-xs text-gray-400">Media</div>
              )}
              <div className="p-2 space-y-2">
                <p className="text-xs text-gray-700 truncate">{asset.label || asset.url}</p>
                <select
                  className="input-field text-xs py-1"
                  value={asset.kind}
                  onChange={(e) => updateAssetKind(asset.id, e.target.value)}
                >
                  {ASSET_KINDS.map((k) => (
                    <option key={k.id} value={k.id}>{k.label}</option>
                  ))}
                </select>
                <button type="button" className="text-xs text-red-600 hover:underline" onClick={() => deleteAsset(asset.id)}>
                  Remove
                </button>
              </div>
            </div>
          ))}
          {!brand.assets?.length && (
            <p className="sm:col-span-3 text-sm text-gray-500">No assets yet — upload a logo to start.</p>
          )}
        </div>
      </div>

      <div className="card p-5 space-y-5">
        <div>
          <h2 className="text-sm font-semibold text-gray-900 uppercase tracking-wide">OAuth apps</h2>
          <p className="text-sm text-gray-500 mt-1">
            Store each brand&apos;s API credentials here (not in env). Required before connecting channels or ads.
          </p>
        </div>
        {OAUTH_PROVIDERS.map((p) => {
          const form = oauthForms[p.id] || emptyForm();
          return (
            <div key={p.id} className="border border-gray-200 rounded-lg p-4 space-y-3">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <p className="text-sm font-medium text-gray-900">{p.label}</p>
                  {p.hint && <p className="text-xs text-gray-500 mt-0.5">{p.hint}</p>}
                </div>
                <span className={`text-xs px-2 py-0.5 rounded ${form.configured ? 'bg-emerald-50 text-emerald-700' : 'bg-gray-100 text-gray-500'}`}>
                  {form.configured ? 'Configured' : 'Not set'}
                </span>
              </div>
              <div className="grid sm:grid-cols-2 gap-3">
                {p.fields.map((f) => (
                  <div key={f.key} className={f.extra ? 'sm:col-span-2' : ''}>
                    <label className="block text-xs font-medium text-gray-500 mb-1">{f.label}</label>
                    <input
                      className="input-field"
                      type={f.secret ? 'password' : 'text'}
                      autoComplete="off"
                      placeholder={f.secret && form.has_secret ? '•••• saved — leave blank to keep' : ''}
                      value={form[f.key] || ''}
                      onChange={(e) => updateOauthField(p.id, f.key, e.target.value)}
                    />
                  </div>
                ))}
              </div>
              <button
                type="button"
                className="btn-secondary text-sm"
                disabled={savingProvider === p.id}
                onClick={() => saveOAuth(p.id)}
              >
                {savingProvider === p.id ? 'Saving…' : 'Save credentials'}
              </button>
            </div>
          );
        })}
      </div>

      <div className="card p-5 space-y-4">
        <h2 className="text-sm font-semibold text-gray-900 uppercase tracking-wide">Official channels</h2>
        <div className="flex flex-wrap gap-2">
          {SOCIAL.map((p) => (
            <button key={p.id} type="button" className="btn-secondary text-sm" onClick={() => connectChannel(p.id)}>
              Connect {p.label}
            </button>
          ))}
        </div>
        <ul className="divide-y divide-gray-100">
          {(brand.channels || []).map((ch) => (
            <li key={ch.id} className="py-3 flex items-center justify-between gap-3">
              <div>
                <p className="text-sm font-medium text-gray-900">{ch.display_name || ch.external_id}</p>
                <p className="text-xs text-gray-500 capitalize">{ch.platform} · {ch.channel_type}</p>
              </div>
              <button type="button" className="text-xs text-red-600 hover:underline" onClick={() => disconnectChannel(ch.id)}>
                Disconnect
              </button>
            </li>
          ))}
          {!brand.channels?.length && (
            <li className="py-3 text-sm text-gray-500">No channels connected yet.</li>
          )}
        </ul>
      </div>

      <div className="card p-5 space-y-4">
        <h2 className="text-sm font-semibold text-gray-900 uppercase tracking-wide">Ad accounts</h2>
        <div className="flex flex-wrap gap-2">
          {ADS.map((p) => (
            <button key={p.id} type="button" className="btn-secondary text-sm" onClick={() => connectAds(p.id)}>
              Connect {p.label}
            </button>
          ))}
        </div>
        <ul className="divide-y divide-gray-100">
          {(brand.ad_accounts || []).map((acct) => (
            <li key={acct.id} className="py-3 flex items-center justify-between gap-3">
              <div>
                <p className="text-sm font-medium text-gray-900">{acct.name || acct.external_account_id}</p>
                <p className="text-xs text-gray-500">{acct.platform} · {acct.currency}</p>
              </div>
              <button type="button" className="text-xs text-red-600 hover:underline" onClick={() => disconnectAd(acct.id)}>
                Disconnect
              </button>
            </li>
          ))}
          {!brand.ad_accounts?.length && (
            <li className="py-3 text-sm text-gray-500">No ad accounts linked yet.</li>
          )}
        </ul>
      </div>
    </div>
  );
};

export default BrandDetail;
