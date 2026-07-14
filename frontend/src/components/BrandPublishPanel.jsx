import React, { useState, useEffect, useCallback } from 'react';
import api from '../utils/api';

const PLATFORMS = [
  { id: 'linkedin', label: 'LinkedIn' },
  { id: 'x', label: 'X' },
  { id: 'facebook', label: 'Facebook' },
  { id: 'instagram', label: 'Instagram' },
];

const BrandPublishPanel = ({ campaignId, campaign, onUpdated }) => {
  const [posts, setPosts] = useState([]);
  const [channels, setChannels] = useState([]);
  const [platform, setPlatform] = useState('linkedin');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    try {
      const [{ data: postData }, channelsRes] = await Promise.all([
        api.get(`/api/campaigns/${campaignId}/overt/posts`),
        campaign?.brand_id
          ? api.get(`/api/brands/${campaign.brand_id}/channels`)
          : Promise.resolve({ data: [] }),
      ]);
      setPosts(postData);
      setChannels(channelsRes.data || []);
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    }
  }, [campaignId, campaign?.brand_id]);

  useEffect(() => { load(); }, [load]);

  const generate = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/api/campaigns/${campaignId}/overt/posts/generate`, { platform });
      await load();
      onUpdated?.();
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setBusy(false);
    }
  };

  const publish = async (postId, live = true) => {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/api/campaigns/${campaignId}/overt/posts/${postId}/publish`, { live });
      await load();
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setBusy(false);
    }
  };

  if (campaign?.campaign_type !== 'brand' && !campaign?.overt_enabled) {
    return (
      <div className="rounded-lg border border-dashed border-gray-200 p-4 text-sm text-gray-500">
        Brand publish is available on brand campaigns.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <label className="block text-xs font-medium text-gray-500 mb-1">Platform</label>
          <select className="input-field" value={platform} onChange={(e) => setPlatform(e.target.value)}>
            {PLATFORMS.map((p) => (
              <option key={p.id} value={p.id}>{p.label}</option>
            ))}
          </select>
        </div>
        <button type="button" className="btn-primary" onClick={generate} disabled={busy}>
          Generate brand draft
        </button>
      </div>

      {channels.length === 0 && (
        <p className="text-sm text-amber-700 bg-amber-50 border border-amber-100 rounded-lg px-3 py-2">
          No brand channels connected.{' '}
          {campaign.brand_id && (
            <a className="underline" href={`/brands/${campaign.brand_id}`}>Connect channels</a>
          )}
        </p>
      )}

      {error && <p className="text-sm text-red-600">{error}</p>}

      <ul className="space-y-3">
        {posts.map((post) => (
          <li key={post.id} className="border border-gray-200 rounded-lg p-3 bg-white">
            <div className="flex justify-between gap-2 text-xs text-gray-500 mb-2">
              <span className="capitalize">{post.platform} · {post.status} · overt</span>
              <span>{post.channel_name}</span>
            </div>
            <p className="text-sm text-gray-800 whitespace-pre-wrap">{post.content || post.caption}</p>
            {['draft', 'approved'].includes(post.status) && (
              <div className="mt-3 flex gap-2">
                <button type="button" className="btn-secondary text-xs" disabled={busy} onClick={() => publish(post.id, false)}>
                  Simulate publish
                </button>
                <button type="button" className="btn-primary text-xs" disabled={busy} onClick={() => publish(post.id, true)}>
                  Publish live
                </button>
              </div>
            )}
          </li>
        ))}
        {!posts.length && <li className="text-sm text-gray-500">No overt posts yet.</li>}
      </ul>
    </div>
  );
};

export default BrandPublishPanel;
