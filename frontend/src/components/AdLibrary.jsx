import React, { useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import api from '../utils/api';

const AdLibrary = () => {
  const [searchParams, setSearchParams] = useSearchParams();
  const [brands, setBrands] = useState([]);
  const [brandId, setBrandId] = useState(searchParams.get('brand_id') || '');
  const [ads, setAds] = useState([]);
  const [campaigns, setCampaigns] = useState([]);
  const [links, setLinks] = useState({});
  const [attachingId, setAttachingId] = useState(null);
  const [notice, setNotice] = useState(null);
  const [form, setForm] = useState({
    name: '',
    brief: '',
    target_url: '',
    visual_format: 'square',
    style: 'clean product marketing',
    include_visual: true,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    api.get('/api/brands').then(({ data }) => {
      setBrands(data || []);
      if (!brandId && data?.[0]) setBrandId(String(data[0].id));
    }).catch((err) => setError(err.response?.data?.error || err.message));
  }, []);

  const load = useCallback(async () => {
    if (!brandId) return;
    try {
      const [{ data: savedAds }, { data: brandCampaigns }] = await Promise.all([
        api.get(`/api/brands/${brandId}/ads`),
        api.get(`/api/campaigns?brand_id=${brandId}`),
      ]);
      setAds(savedAds || []);
      setCampaigns(brandCampaigns || []);
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    }
  }, [brandId]);

  useEffect(() => {
    if (!brandId) return;
    setSearchParams({ brand_id: brandId }, { replace: true });
    load();
  }, [brandId, load, setSearchParams]);

  const generate = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post(`/api/brands/${brandId}/ads/generate`, form);
      setForm((current) => ({ ...current, name: '', brief: '' }));
      await load();
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setBusy(false);
    }
  };

  const attach = async (adId) => {
    const campaignId = links[adId];
    if (!campaignId) return;
    const campaign = campaigns.find((c) => String(c.id) === String(campaignId));
    setAttachingId(adId);
    setError(null);
    try {
      await api.post(`/api/campaigns/${campaignId}/ads`, { ad_creative_id: adId });
      setLinks((current) => ({ ...current, [adId]: '' }));
      setNotice(`Attached to ${campaign?.name || 'campaign'}`);
      await load();
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setAttachingId(null);
    }
  };

  const detach = async (adId, campaignId, campaignName) => {
    setError(null);
    try {
      await api.delete(`/api/campaigns/${campaignId}/ads/${adId}`);
      setNotice(`Removed from ${campaignName}`);
      await load();
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    }
  };

  const remove = async (adId) => {
    try {
      await api.delete(`/api/brands/${brandId}/ads/${adId}`);
      await load();
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    }
  };

  const selectedBrand = brands.find((brand) => String(brand.id) === String(brandId));

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="page-title">Ad Builder &amp; Library</h1>
          <p className="page-subtitle">Generate reusable ads from a company data room, then attach them to campaigns.</p>
        </div>
        {brandId && <Link to={`/brands/${brandId}/data-room`} className="btn-secondary">Open data room</Link>}
      </div>

      {error && <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}
      {notice && (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800 flex items-center justify-between gap-3">
          <span>{notice}</span>
          <button type="button" className="text-xs text-emerald-700 hover:underline" onClick={() => setNotice(null)}>Dismiss</button>
        </div>
      )}

      <div className="card p-4">
        <label className="block max-w-sm">
          <span className="block text-xs font-medium text-gray-500 mb-1">Company</span>
          <select className="input-field" value={brandId} onChange={(event) => setBrandId(event.target.value)}>
            <option value="">Select a company</option>
            {brands.map((brand) => <option key={brand.id} value={brand.id}>{brand.name}</option>)}
          </select>
        </label>
      </div>

      {brandId && (
        <form onSubmit={generate} className="card p-5 space-y-4">
          <div>
            <h2 className="text-base font-semibold text-gray-900">Build a reusable ad</h2>
            <p className="text-sm text-gray-500 mt-1">
              The builder uses parsed documents plus the strongest matching logos, screenshots, and product images.
            </p>
          </div>
          <div className="grid md:grid-cols-2 gap-3">
            <label>
              <span className="block text-xs font-medium text-gray-500 mb-1">Ad name</span>
              <input className="input-field" required value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder={`${selectedBrand?.name || 'Company'} launch ad`} />
            </label>
            <label>
              <span className="block text-xs font-medium text-gray-500 mb-1">Landing URL</span>
              <input className="input-field" value={form.target_url} onChange={(event) => setForm({ ...form, target_url: event.target.value })} placeholder={selectedBrand?.website || 'https://'} />
            </label>
          </div>
          <label className="block">
            <span className="block text-xs font-medium text-gray-500 mb-1">Goal / creative brief</span>
            <textarea className="input-field" required rows={4} value={form.brief} onChange={(event) => setForm({ ...form, brief: event.target.value })} placeholder="What should this ad achieve? Include the audience, offer, and any must-have message." />
          </label>
          <div className="grid md:grid-cols-2 gap-3">
            <label>
              <span className="block text-xs font-medium text-gray-500 mb-1">Visual format</span>
              <select className="input-field" value={form.visual_format} onChange={(event) => setForm({ ...form, visual_format: event.target.value })}>
                <option value="square">Square 1:1</option>
                <option value="landscape">Landscape</option>
                <option value="portrait">Portrait</option>
              </select>
            </label>
            <label>
              <span className="block text-xs font-medium text-gray-500 mb-1">Visual direction</span>
              <input className="input-field" value={form.style} onChange={(event) => setForm({ ...form, style: event.target.value })} />
            </label>
          </div>
          <label className="flex items-center gap-2 text-sm text-gray-700">
            <input type="checkbox" checked={form.include_visual} onChange={(event) => setForm({ ...form, include_visual: event.target.checked })} />
            Generate a visual using company assets
          </label>
          <button className="btn-primary" disabled={busy}>
            {busy ? 'Building ad…' : 'Generate and save'}
          </button>
        </form>
      )}

      <div>
        <h2 className="text-base font-semibold text-gray-900 mb-3">Saved ads</h2>
        <div className="grid gap-4 lg:grid-cols-2">
          {ads.map((ad) => {
            const linkedCampaigns = Array.isArray(ad.campaigns) ? ad.campaigns : [];
            const linkedIds = new Set(linkedCampaigns.map((c) => String(c.id)));
            const availableCampaigns = campaigns.filter((c) => !linkedIds.has(String(c.id)));

            return (
              <article key={ad.id} className="card overflow-hidden">
                <div className="grid sm:grid-cols-[10rem_1fr]">
                  {ad.image_url ? (
                    <img src={ad.image_url} alt="" className="w-full h-48 sm:h-full object-cover bg-gray-50" />
                  ) : (
                    <div className="h-32 sm:h-full bg-gray-50 flex items-center justify-center text-xs text-gray-400">Text ad</div>
                  )}
                  <div className="p-4 space-y-3 min-w-0">
                    <div>
                      <div className="flex justify-between gap-3">
                        <h3 className="font-semibold text-gray-900">{ad.name}</h3>
                        <button type="button" className="text-xs text-red-600 hover:underline" onClick={() => remove(ad.id)}>Delete</button>
                      </div>
                      <p className="text-xs text-gray-500 capitalize">
                        {ad.format} · {linkedCampaigns.length} campaign{linkedCampaigns.length === 1 ? '' : 's'}
                      </p>
                    </div>
                    {ad.content?.headline && <p className="text-sm font-medium text-gray-900">{ad.content.headline}</p>}
                    {ad.content?.message && <p className="text-xs text-gray-600 line-clamp-4">{ad.content.message}</p>}

                    <div className="space-y-2">
                      <p className="text-[11px] font-medium uppercase tracking-wide text-gray-500">Attached to</p>
                      {linkedCampaigns.length ? (
                        <ul className="space-y-1.5">
                          {linkedCampaigns.map((campaign) => (
                            <li key={campaign.id} className="flex items-center justify-between gap-2 rounded-md bg-gray-50 px-2.5 py-1.5">
                              <Link
                                to={`/campaigns/${campaign.id}`}
                                className="text-xs font-medium text-whisper-700 hover:underline truncate"
                              >
                                {campaign.name}
                              </Link>
                              <button
                                type="button"
                                className="text-[11px] text-gray-500 hover:text-red-600 shrink-0"
                                onClick={() => detach(ad.id, campaign.id, campaign.name)}
                              >
                                Remove
                              </button>
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <p className="text-xs text-gray-400">Not attached to any campaign yet.</p>
                      )}
                    </div>

                    <div className="flex gap-2">
                      <select
                        className="input-field text-xs"
                        value={links[ad.id] || ''}
                        onChange={(event) => setLinks({ ...links, [ad.id]: event.target.value })}
                        disabled={!availableCampaigns.length}
                      >
                        <option value="">
                          {availableCampaigns.length ? 'Attach to campaign…' : 'All campaigns already linked'}
                        </option>
                        {availableCampaigns.map((campaign) => (
                          <option key={campaign.id} value={campaign.id}>{campaign.name}</option>
                        ))}
                      </select>
                      <button
                        type="button"
                        className="btn-secondary text-xs"
                        disabled={!links[ad.id] || attachingId === ad.id}
                        onClick={() => attach(ad.id)}
                      >
                        {attachingId === ad.id ? 'Attaching…' : 'Attach'}
                      </button>
                    </div>
                  </div>
                </div>
              </article>
            );
          })}
          {brandId && !ads.length && (
            <div className="lg:col-span-2 rounded-lg border border-dashed border-gray-300 p-10 text-center text-sm text-gray-500">
              No saved ads for this company yet.
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default AdLibrary;
