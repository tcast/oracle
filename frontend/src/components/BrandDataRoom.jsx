import React, { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import api from '../utils/api';

const KINDS = [
  ['logo', 'Logo'],
  ['screenshot', 'Screenshot'],
  ['product', 'Product'],
  ['lifestyle', 'Lifestyle'],
  ['pitch_deck', 'Pitch deck'],
  ['brand_guide', 'Brand guide'],
  ['document', 'Document'],
  ['other', 'Other'],
];

const BrandDataRoom = () => {
  const { id } = useParams();
  const [brand, setBrand] = useState(null);
  const [files, setFiles] = useState([]);
  const [kind, setKind] = useState('');
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    try {
      const { data } = await api.get(`/api/brands/${id}`);
      setBrand(data);
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    }
  }, [id]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!brand?.assets?.some((asset) => ['pending', 'processing'].includes(asset.parse_status))) return undefined;
    const timer = setInterval(load, 2500);
    return () => clearInterval(timer);
  }, [brand?.assets, load]);

  const upload = async () => {
    if (!files.length) return;
    setUploading(true);
    setError(null);
    try {
      const body = new FormData();
      files.forEach((file) => body.append('files', file));
      if (kind) body.append('kind', kind);
      await api.post(`/api/brands/${id}/assets`, body, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      setFiles([]);
      await load();
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setUploading(false);
    }
  };

  const updateKind = async (assetId, nextKind) => {
    await api.patch(`/api/brands/${id}/assets/${assetId}`, { kind: nextKind });
    await load();
  };

  const reparse = async (assetId) => {
    await api.post(`/api/brands/${id}/assets/${assetId}/parse`);
    await load();
  };

  const remove = async (assetId) => {
    await api.delete(`/api/brands/${id}/assets/${assetId}`);
    await load();
  };

  if (!brand && !error) {
    return <div className="flex justify-center py-20"><div className="animate-spin rounded-full h-10 w-10 border-2 border-whisper-400 border-t-transparent" /></div>;
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Link to={`/brands/${id}`} className="text-sm text-whisper-600 hover:underline">← {brand?.name || 'Company'}</Link>
          <h1 className="page-title mt-1">Data Room</h1>
          <p className="page-subtitle">Upload the source material used to understand and market this company.</p>
        </div>
        <Link to={`/ads?brand_id=${id}`} className="btn-primary">Build ads from this data</Link>
      </div>

      {error && <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}

      <div className="card p-5 space-y-4">
        <div className="grid md:grid-cols-[1fr_12rem_auto] gap-3 items-end">
          <label className="block">
            <span className="block text-xs font-medium text-gray-500 mb-1">Files</span>
            <input
              type="file"
              multiple
              accept=".png,.jpg,.jpeg,.webp,.gif,.pdf,.pptx,.docx,.txt,.md,.rtf,.csv,.mp4,.mov"
              className="input-field"
              onChange={(event) => setFiles(Array.from(event.target.files || []))}
            />
          </label>
          <label className="block">
            <span className="block text-xs font-medium text-gray-500 mb-1">Type (optional)</span>
            <select className="input-field" value={kind} onChange={(event) => setKind(event.target.value)}>
              <option value="">Detect automatically</option>
              {KINDS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </label>
          <button type="button" className="btn-primary" disabled={!files.length || uploading} onClick={upload}>
            {uploading ? `Uploading ${files.length}…` : `Upload ${files.length || ''} file${files.length === 1 ? '' : 's'}`}
          </button>
        </div>
        {files.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {files.map((file) => (
              <span key={`${file.name}-${file.size}`} className="text-xs bg-gray-100 text-gray-600 rounded px-2 py-1">
                {file.name}
              </span>
            ))}
          </div>
        )}
        <p className="text-xs text-gray-500">
          Images, PDF/PPTX decks, DOCX, text, markdown, CSV, and video. Documents are parsed into reusable company context automatically.
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {(brand?.assets || []).map((asset) => {
          const isImage = (asset.mime_type || '').startsWith('image/');
          return (
            <article key={asset.id} className="card overflow-hidden">
              {isImage ? (
                <img src={asset.url} alt={asset.label || asset.original_filename} className="h-44 w-full object-contain bg-white border-b border-gray-100" />
              ) : (
                <div className="h-32 flex items-center justify-center bg-gray-50 border-b border-gray-100">
                  <span className="text-sm font-medium text-gray-500 uppercase">{(asset.original_filename || '').split('.').pop() || 'FILE'}</span>
                </div>
              )}
              <div className="p-4 space-y-3">
                <div>
                  <p className="text-sm font-medium text-gray-900 truncate">{asset.label || asset.original_filename || asset.url}</p>
                  <p className="text-xs text-gray-500">
                    {asset.byte_size ? `${Math.round(asset.byte_size / 1024)} KB · ` : ''}
                    <span className={
                      asset.parse_status === 'complete' ? 'text-emerald-600' :
                        asset.parse_status === 'failed' ? 'text-red-600' : 'text-amber-600'
                    }>
                      {asset.parse_status || 'pending'}
                    </span>
                  </p>
                </div>
                <select className="input-field text-xs" value={asset.kind} onChange={(event) => updateKind(asset.id, event.target.value)}>
                  {KINDS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                </select>
                {asset.ai_summary && <p className="text-xs text-gray-600 line-clamp-4">{asset.ai_summary}</p>}
                {asset.parse_error && <p className="text-xs text-red-600 line-clamp-3">{asset.parse_error}</p>}
                <div className="flex gap-3">
                  <a href={asset.url} target="_blank" rel="noreferrer" className="text-xs text-whisper-600 hover:underline">Open</a>
                  <button type="button" className="text-xs text-gray-600 hover:underline" onClick={() => reparse(asset.id)}>Parse again</button>
                  <button type="button" className="text-xs text-red-600 hover:underline ml-auto" onClick={() => remove(asset.id)}>Remove</button>
                </div>
              </div>
            </article>
          );
        })}
        {!brand?.assets?.length && (
          <div className="md:col-span-2 xl:col-span-3 rounded-lg border border-dashed border-gray-300 p-10 text-center text-sm text-gray-500">
            This data room is empty. Upload logos, screenshots, decks, and company docs above.
          </div>
        )}
      </div>
    </div>
  );
};

export default BrandDataRoom;
