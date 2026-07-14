import React, { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import api from '../utils/api';

const ASSET_KINDS = [
  { id: 'logo', label: 'Logo' },
  { id: 'screenshot', label: 'Screenshot' },
  { id: 'product', label: 'Product' },
  { id: 'lifestyle', label: 'Lifestyle' },
  { id: 'other', label: 'Other' },
];

const TextAdBuilder = ({ campaignId, onApply, busy, setBusy, setError }) => {
  const [angle, setAngle] = useState('');
  const [format, setFormat] = useState('both');
  const [result, setResult] = useState(null);

  const generate = async () => {
    setBusy(true);
    setError(null);
    try {
      const { data } = await api.post(`/api/campaigns/${campaignId}/ads/text/generate`, {
        format,
        angle,
        count: 3,
      });
      setResult(data);
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card p-4 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-gray-900">Text ad builder</h3>
          <p className="text-xs text-gray-500 mt-0.5">AI headlines, descriptions, and CTAs for search + social</p>
        </div>
        <button type="button" className="btn-primary text-xs" disabled={busy} onClick={generate}>
          {busy ? 'Generating…' : 'Generate copy'}
        </button>
      </div>
      <div className="grid sm:grid-cols-2 gap-3">
        <div>
          <label className="block text-xs text-gray-500 mb-1">Format</label>
          <select className="input-field" value={format} onChange={(e) => setFormat(e.target.value)}>
            <option value="both">Search + Social</option>
            <option value="search">Search (RSA) only</option>
            <option value="social">Social only</option>
          </select>
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">Angle / notes</label>
          <input
            className="input-field"
            value={angle}
            onChange={(e) => setAngle(e.target.value)}
            placeholder="e.g. waitlist urgency, founder-led, free trial"
          />
        </div>
      </div>

      {result && (
        <div className="space-y-3 border-t border-gray-100 pt-3">
          {result.angle_used && (
            <p className="text-xs text-gray-500">Angle: {result.angle_used}</p>
          )}
          {result.recommended && (
            <div className="rounded-lg bg-whisper-50 border border-whisper-100 p-3 space-y-1">
              <p className="text-[10px] uppercase tracking-wide text-whisper-600 font-semibold">Recommended</p>
              <p className="text-sm font-medium text-gray-900">{result.recommended.headline}</p>
              <p className="text-sm text-gray-700">{result.recommended.primary_text}</p>
              <p className="text-xs text-gray-500">{result.recommended.description} · CTA: {result.recommended.cta}</p>
              <button
                type="button"
                className="btn-secondary text-xs mt-2"
                onClick={() => onApply({
                  message: result.recommended.primary_text,
                  headline: result.recommended.headline,
                  description: result.recommended.description,
                  cta: result.recommended.cta,
                  search: result.search,
                  social: result.social,
                  angle_used: result.angle_used,
                })}
              >
                Use in ad campaign
              </button>
            </div>
          )}
          {result.search && (
            <details className="text-sm">
              <summary className="cursor-pointer font-medium text-gray-800">Search headlines ({result.search.headlines?.length || 0})</summary>
              <ul className="mt-2 space-y-1 text-xs text-gray-600 list-disc pl-4">
                {(result.search.headlines || []).map((h, i) => <li key={i}>{h}</li>)}
              </ul>
              <ul className="mt-2 space-y-1 text-xs text-gray-600 list-disc pl-4">
                {(result.search.descriptions || []).map((d, i) => <li key={`d${i}`}>{d}</li>)}
              </ul>
            </details>
          )}
          {result.social?.primary_texts && (
            <details className="text-sm">
              <summary className="cursor-pointer font-medium text-gray-800">Social variants</summary>
              <div className="mt-2 space-y-2">
                {result.social.primary_texts.map((t, i) => (
                  <button
                    key={i}
                    type="button"
                    className="block w-full text-left text-xs bg-gray-50 border border-gray-100 rounded-lg p-2 hover:border-whisper-200"
                    onClick={() => onApply({
                      message: t,
                      headline: result.social.headlines?.[i] || result.recommended?.headline,
                      description: result.social.descriptions?.[i] || result.recommended?.description,
                      cta: result.social.ctas?.[0] || result.recommended?.cta,
                      search: result.search,
                      social: result.social,
                    })}
                  >
                    {t}
                  </button>
                ))}
              </div>
            </details>
          )}
        </div>
      )}
    </div>
  );
};

const VisualAdBuilder = ({ campaignId, onApply, busy, setBusy, setError, copyHint, brandAssets, usedRefsHint }) => {
  const [style, setStyle] = useState('clean product marketing');
  const [format, setFormat] = useState('square');
  const [assets, setAssets] = useState([]);
  const [usedBrandAssets, setUsedBrandAssets] = useState(false);

  const generate = async () => {
    setBusy(true);
    setError(null);
    try {
      const { data } = await api.post(`/api/campaigns/${campaignId}/ads/visual/generate`, {
        style,
        format,
        count: 1,
        copy_hint: copyHint || '',
      });
      setAssets(data.assets || []);
      setUsedBrandAssets(!!data.used_brand_assets);
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setBusy(false);
    }
  };

  const hasRefs = (brandAssets || []).some(
    (a) => (a.mime_type || '').startsWith('image/') || /\.(png|jpe?g|webp|gif)$/i.test(a.url || '')
  );

  return (
    <div className="card p-4 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-gray-900">Visual ad builder</h3>
          <p className="text-xs text-gray-500 mt-0.5">
            {hasRefs
              ? 'Uses your brand assets (logo / shots) when generating'
              : 'AI image creatives — upload brand assets for logo-aware gens'}
          </p>
        </div>
        <button type="button" className="btn-primary text-xs" disabled={busy} onClick={generate}>
          {busy ? 'Generating…' : 'Generate visual'}
        </button>
      </div>
      <div className="grid sm:grid-cols-2 gap-3">
        <div>
          <label className="block text-xs text-gray-500 mb-1">Aspect</label>
          <select className="input-field" value={format} onChange={(e) => setFormat(e.target.value)}>
            <option value="square">Square 1:1</option>
            <option value="landscape">Landscape 1.91:1</option>
            <option value="portrait">Portrait 4:5</option>
          </select>
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">Style</label>
          <input
            className="input-field"
            value={style}
            onChange={(e) => setStyle(e.target.value)}
            placeholder="e.g. bold sports energy, minimal SaaS"
          />
        </div>
      </div>
      {usedRefsHint}
      {assets.length > 0 && (
        <div className="grid sm:grid-cols-2 gap-3 pt-2 border-t border-gray-100">
          {assets.map((asset, i) => (
            <div key={i} className="space-y-2">
              <img
                src={asset.url}
                alt={`Ad creative ${i + 1}`}
                className="w-full rounded-lg border border-gray-200 bg-gray-50 object-cover aspect-square"
              />
              {usedBrandAssets && (
                <p className="text-[10px] text-whisper-600">Built with brand assets</p>
              )}
              <button
                type="button"
                className="btn-secondary text-xs w-full"
                onClick={() => onApply({ image_url: asset.url, images: [asset] })}
              >
                Use this visual
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

const BrandAssetsStrip = ({ brandId, assets, onChange, setError }) => {
  const [kind, setKind] = useState('logo');
  const [uploading, setUploading] = useState(false);

  if (!brandId) return null;

  const upload = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setUploading(true);
    setError(null);
    try {
      const body = new FormData();
      body.append('media', file);
      body.append('kind', kind);
      await api.post(`/api/brands/${brandId}/assets`, body, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      await onChange();
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="card p-4 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-gray-900">Brand assets</h3>
          <p className="text-xs text-gray-500 mt-0.5">
            Logos &amp; screenshots feed into visual ad generation.{' '}
            <Link to={`/brands/${brandId}`} className="text-whisper-600 hover:underline">Manage on brand</Link>
          </p>
        </div>
        <div className="flex items-center gap-2">
          <select className="input-field text-xs py-1 w-auto" value={kind} onChange={(e) => setKind(e.target.value)}>
            {ASSET_KINDS.map((k) => (
              <option key={k.id} value={k.id}>{k.label}</option>
            ))}
          </select>
          <label className="btn-secondary text-xs cursor-pointer whitespace-nowrap">
            {uploading ? 'Uploading…' : 'Upload'}
            <input type="file" accept="image/*" className="hidden" disabled={uploading} onChange={upload} />
          </label>
        </div>
      </div>
      {assets?.length > 0 ? (
        <div className="flex gap-2 overflow-x-auto pb-1">
          {assets.map((a) => (
            <div key={a.id} className="shrink-0 w-20 text-center">
              <img
                src={a.url}
                alt={a.label || a.kind}
                className="w-20 h-20 object-contain rounded border border-gray-200 bg-white"
              />
              <p className="text-[10px] text-gray-500 mt-1 capitalize truncate">{a.kind}</p>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-xs text-gray-500">No assets yet — upload a logo so gens can place it.</p>
      )}
    </div>
  );
};

const CampaignAdsPanel = ({ campaignId, campaign }) => {
  const [adCampaigns, setAdCampaigns] = useState([]);
  const [adAccounts, setAdAccounts] = useState([]);
  const [brandAssets, setBrandAssets] = useState([]);
  const [libraryAds, setLibraryAds] = useState([]);
  const [linkedAds, setLinkedAds] = useState([]);
  const [form, setForm] = useState({
    name: '',
    ad_account_id: '',
    objective: 'OUTCOME_TRAFFIC',
    budget_daily_cents: 2000,
    creative_message: '',
    headline: '',
    description: '',
    cta: 'Learn More',
    image_url: '',
    ad_creative_id: '',
    search: null,
    social: null,
  });
  const [busy, setBusy] = useState(false);
  const [builderBusy, setBuilderBusy] = useState(false);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    try {
      const [{ data: camps }, accountsRes, assetsRes, libraryRes, linkedRes] = await Promise.all([
        api.get(`/api/campaigns/${campaignId}/ad-campaigns`),
        campaign?.brand_id
          ? api.get(`/api/brands/${campaign.brand_id}/ad-accounts`)
          : Promise.resolve({ data: [] }),
        campaign?.brand_id
          ? api.get(`/api/brands/${campaign.brand_id}/assets`)
          : Promise.resolve({ data: [] }),
        campaign?.brand_id
          ? api.get(`/api/brands/${campaign.brand_id}/ads`)
          : Promise.resolve({ data: [] }),
        api.get(`/api/campaigns/${campaignId}/ads`),
      ]);
      setAdCampaigns(camps);
      setAdAccounts(accountsRes.data || []);
      setBrandAssets(assetsRes.data || []);
      setLibraryAds(libraryRes.data || []);
      setLinkedAds(linkedRes.data || []);
      if (accountsRes.data?.[0] && !form.ad_account_id) {
        setForm((f) => ({ ...f, ad_account_id: String(accountsRes.data[0].id), name: `${campaign.name} Ads` }));
      }
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    }
  }, [campaignId, campaign?.brand_id, campaign?.name]);

  useEffect(() => { load(); }, [load]);

  const applyText = (creative) => {
    setForm((f) => ({
      ...f,
      creative_message: creative.message || f.creative_message,
      headline: creative.headline || f.headline,
      description: creative.description || f.description,
      cta: creative.cta || f.cta,
      search: creative.search || f.search,
      social: creative.social || f.social,
    }));
  };

  const applyVisual = (visual) => {
    setForm((f) => ({
      ...f,
      image_url: visual.image_url || f.image_url,
      images: visual.images || f.images,
    }));
  };

  const useSavedAd = async (ad) => {
    const content = ad.content || {};
    setForm((current) => ({
      ...current,
      ad_creative_id: String(ad.id),
      creative_message: content.message || current.creative_message,
      headline: content.headline || current.headline,
      description: content.description || current.description,
      cta: content.cta || current.cta,
      image_url: ad.image_url || content.image_url || current.image_url,
      images: content.images || current.images,
      search: content.search || current.search,
      social: content.social || current.social,
    }));
    if (!linkedAds.some((linked) => linked.id === ad.id)) {
      await api.post(`/api/campaigns/${campaignId}/ads`, { ad_creative_id: ad.id });
      await load();
    }
  };

  const create = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post(`/api/campaigns/${campaignId}/ad-campaigns`, {
        name: form.name,
        ad_account_id: parseInt(form.ad_account_id),
        ad_creative_id: form.ad_creative_id ? parseInt(form.ad_creative_id) : null,
        objective: form.objective,
        budget_daily_cents: parseInt(form.budget_daily_cents) || 2000,
        creative: {
          message: form.creative_message || campaign.campaign_goal,
          headline: form.headline,
          description: form.description,
          cta: form.cta,
          image_url: form.image_url || null,
          images: form.images || [],
          search: form.search,
          social: form.social,
          link: campaign.target_url,
        },
      });
      await load();
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setBusy(false);
    }
  };

  const setStatus = async (id, status) => {
    setBusy(true);
    try {
      await api.post(`/api/campaigns/${campaignId}/ad-campaigns/${id}/status`, { status });
      await load();
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setBusy(false);
    }
  };

  const sync = async (id) => {
    setBusy(true);
    try {
      await api.post(`/api/campaigns/${campaignId}/ad-campaigns/${id}/sync`);
      await load();
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setBusy(false);
    }
  };

  if (campaign?.campaign_type !== 'brand' && !campaign?.ads_enabled) {
    return (
      <div className="rounded-lg border border-dashed border-gray-200 p-4 text-sm text-gray-500">
        Ads builders are available on brand campaigns.
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <BrandAssetsStrip
        brandId={campaign?.brand_id}
        assets={brandAssets}
        onChange={load}
        setError={setError}
      />

      <div className="card p-4 space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-gray-900">Saved ad library</h3>
            <p className="text-xs text-gray-500 mt-0.5">Attach a reusable company ad to this campaign.</p>
          </div>
          <Link to={`/ads?brand_id=${campaign?.brand_id}`} className="btn-secondary text-xs">Open Ad Builder</Link>
        </div>
        {libraryAds.length ? (
          <div className="flex gap-3 overflow-x-auto pb-1">
            {libraryAds.map((ad) => {
              const linked = linkedAds.some((item) => item.id === ad.id);
              return (
                <button
                  key={ad.id}
                  type="button"
                  onClick={() => useSavedAd(ad)}
                  className={`shrink-0 w-56 text-left rounded-lg border p-2 hover:border-whisper-300 ${form.ad_creative_id === String(ad.id) ? 'border-whisper-400 bg-whisper-50' : 'border-gray-200'}`}
                >
                  {ad.image_url && <img src={ad.image_url} alt="" className="w-full h-24 object-cover rounded bg-gray-50 mb-2" />}
                  <p className="text-xs font-medium text-gray-900 truncate">{ad.name}</p>
                  <p className="text-[10px] text-gray-500">{linked ? 'Linked · click to use' : 'Click to link and use'}</p>
                </button>
              );
            })}
          </div>
        ) : (
          <p className="text-xs text-gray-500">No saved ads yet. Build one independently, then return here.</p>
        )}
      </div>

      <div className="grid lg:grid-cols-2 gap-4">
        <TextAdBuilder
          campaignId={campaignId}
          onApply={applyText}
          busy={builderBusy}
          setBusy={setBuilderBusy}
          setError={setError}
        />
        <VisualAdBuilder
          campaignId={campaignId}
          onApply={applyVisual}
          busy={builderBusy}
          setBusy={setBuilderBusy}
          setError={setError}
          copyHint={form.creative_message || form.headline}
          brandAssets={brandAssets}
        />
      </div>

      <form onSubmit={create} className="card p-4 space-y-3">
        <h3 className="text-sm font-semibold text-gray-900">Create ad campaign</h3>
        <div className="grid sm:grid-cols-2 gap-3">
          <div>
            <label className="block text-xs text-gray-500 mb-1">Name</label>
            <input className="input-field" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">Ad account</label>
            <select
              className="input-field"
              required
              value={form.ad_account_id}
              onChange={(e) => setForm({ ...form, ad_account_id: e.target.value })}
            >
              <option value="">Select…</option>
              {adAccounts.map((a) => (
                <option key={a.id} value={a.id}>{a.name || a.external_account_id} ({a.platform})</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">Objective</label>
            <select className="input-field" value={form.objective} onChange={(e) => setForm({ ...form, objective: e.target.value })}>
              <option value="OUTCOME_TRAFFIC">Traffic</option>
              <option value="OUTCOME_ENGAGEMENT">Engagement</option>
              <option value="OUTCOME_AWARENESS">Awareness</option>
              <option value="SEARCH">Search (Google)</option>
            </select>
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">Daily budget (cents)</label>
            <input
              type="number"
              className="input-field"
              value={form.budget_daily_cents}
              onChange={(e) => setForm({ ...form, budget_daily_cents: e.target.value })}
            />
          </div>
        </div>

        <div className="grid sm:grid-cols-2 gap-3">
          <div>
            <label className="block text-xs text-gray-500 mb-1">Headline</label>
            <input className="input-field" value={form.headline} onChange={(e) => setForm({ ...form, headline: e.target.value })} />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">CTA</label>
            <input className="input-field" value={form.cta} onChange={(e) => setForm({ ...form, cta: e.target.value })} />
          </div>
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">Primary text</label>
          <textarea
            className="input-field"
            rows={3}
            value={form.creative_message}
            onChange={(e) => setForm({ ...form, creative_message: e.target.value })}
            placeholder={campaign.campaign_goal || 'Primary ad message'}
          />
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">Description</label>
          <input className="input-field" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
        </div>

        {form.image_url && (
          <div className="flex items-start gap-3">
            <img src={form.image_url} alt="Selected creative" className="w-24 h-24 rounded-lg object-cover border border-gray-200" />
            <div className="text-xs text-gray-500">
              <p className="font-medium text-gray-700">Selected visual</p>
              <button type="button" className="text-red-600 hover:underline mt-1" onClick={() => setForm({ ...form, image_url: '', images: [] })}>
                Remove
              </button>
            </div>
          </div>
        )}

        {adAccounts.length === 0 && (
          <p className="text-sm text-amber-700">
            Link an ad account on the{' '}
            {campaign.brand_id ? <a className="underline" href={`/brands/${campaign.brand_id}`}>brand page</a> : 'brand page'} first.
          </p>
        )}
        <button type="submit" className="btn-primary" disabled={busy || !adAccounts.length}>
          Create ad campaign
        </button>
      </form>

      {error && <p className="text-sm text-red-600">{error}</p>}

      <div className="space-y-3">
        {adCampaigns.map((ac) => (
          <div key={ac.id} className="card p-4">
            <div className="flex flex-wrap justify-between gap-2">
              <div className="flex gap-3 min-w-0">
                {ac.creative?.image_url && (
                  <img src={ac.creative.image_url} alt="" className="w-14 h-14 rounded object-cover border border-gray-100 flex-shrink-0" />
                )}
                <div className="min-w-0">
                  <p className="font-medium text-gray-900">{ac.name}</p>
                  <p className="text-xs text-gray-500">{ac.platform} · {ac.status} · {ac.ad_account_name}</p>
                  {ac.creative?.headline && (
                    <p className="text-xs text-gray-600 mt-1 truncate">{ac.creative.headline}</p>
                  )}
                </div>
              </div>
              <div className="flex gap-2">
                {ac.status !== 'active' && (
                  <button type="button" className="btn-secondary text-xs" disabled={busy} onClick={() => setStatus(ac.id, 'active')}>Activate</button>
                )}
                {ac.status === 'active' && (
                  <button type="button" className="btn-secondary text-xs" disabled={busy} onClick={() => setStatus(ac.id, 'paused')}>Pause</button>
                )}
                <button type="button" className="btn-secondary text-xs" disabled={busy} onClick={() => sync(ac.id)}>Sync metrics</button>
              </div>
            </div>
            {ac.metrics && Object.keys(ac.metrics).length > 0 && (
              <div className="mt-3 flex flex-wrap gap-3 text-xs text-gray-600">
                {'impressions' in ac.metrics && <span>Impr: {ac.metrics.impressions}</span>}
                {'clicks' in ac.metrics && <span>Clicks: {ac.metrics.clicks}</span>}
                {'spend' in ac.metrics && <span>Spend: ${ac.metrics.spend}</span>}
                {ac.metrics.sync_error && <span className="text-red-600">{ac.metrics.sync_error}</span>}
              </div>
            )}
          </div>
        ))}
        {!adCampaigns.length && <p className="text-sm text-gray-500">No ad campaigns yet.</p>}
      </div>
    </div>
  );
};

export default CampaignAdsPanel;
