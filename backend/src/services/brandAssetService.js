const fs = require('fs').promises;
const path = require('path');
const pool = require('./db');

const KINDS = [
  'logo',
  'screenshot',
  'product',
  'lifestyle',
  'pitch_deck',
  'brand_guide',
  'document',
  'other',
];

async function listAssets(brandId) {
  const { rows } = await pool.query(
    `SELECT * FROM brand_assets WHERE brand_id = $1 ORDER BY
       CASE kind WHEN 'logo' THEN 0 WHEN 'product' THEN 1 WHEN 'screenshot' THEN 2 ELSE 3 END,
       created_at DESC`,
    [brandId]
  );
  return rows;
}

async function addAsset(brandId, {
  kind,
  label,
  url,
  mime_type,
  meta,
  original_filename,
  byte_size,
}) {
  const k = KINDS.includes(kind) ? kind : 'other';
  const { rows } = await pool.query(
    `INSERT INTO brand_assets
       (brand_id, kind, label, url, mime_type, meta, original_filename, byte_size, parse_status)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, 'pending') RETURNING *`,
    [
      brandId,
      k,
      label || null,
      url,
      mime_type || null,
      JSON.stringify(meta || {}),
      original_filename || null,
      byte_size || null,
    ]
  );

  // Keep brands.logo_url in sync when uploading a logo
  if (k === 'logo') {
    await pool.query(
      `UPDATE brands SET logo_url = $1, updated_at = NOW() WHERE id = $2 AND (logo_url IS NULL OR logo_url = '')`,
      [url, brandId]
    );
  }

  return rows[0];
}

async function getAsset(brandId, assetId) {
  const { rows } = await pool.query(
    'SELECT * FROM brand_assets WHERE brand_id = $1 AND id = $2',
    [brandId, assetId]
  );
  return rows[0] || null;
}

async function getParsedContext(brandId, maxChars = 24000) {
  const assets = await listAssets(brandId);
  let used = 0;
  const blocks = [];

  for (const asset of assets) {
    if (asset.parse_status !== 'complete') continue;
    const data = JSON.stringify(asset.ai_data || {});
    const text = [
      `ASSET: ${asset.label || asset.original_filename || asset.url}`,
      `KIND: ${asset.kind}`,
      asset.ai_summary ? `SUMMARY: ${asset.ai_summary}` : '',
      data !== '{}' ? `STRUCTURED: ${data}` : '',
      asset.extracted_text ? `EXCERPT: ${asset.extracted_text.slice(0, 6000)}` : '',
    ].filter(Boolean).join('\n');
    if (used + text.length > maxChars) continue;
    blocks.push(text);
    used += text.length;
  }

  return blocks.join('\n\n');
}

async function updateAsset(brandId, assetId, fields) {
  const { kind, label } = fields;
  const { rows } = await pool.query(
    `UPDATE brand_assets SET
       kind = COALESCE($1, kind),
       label = COALESCE($2, label)
     WHERE id = $3 AND brand_id = $4 RETURNING *`,
    [kind && KINDS.includes(kind) ? kind : null, label ?? null, assetId, brandId]
  );
  return rows[0] || null;
}

async function deleteAsset(brandId, assetId) {
  const { rows } = await pool.query(
    `DELETE FROM brand_assets WHERE id = $1 AND brand_id = $2 RETURNING *`,
    [assetId, brandId]
  );
  const deleted = rows[0];
  if (!deleted) return null;

  // Best-effort: remove file under uploads/
  try {
    if (deleted.url?.startsWith('/uploads/')) {
      const filepath = path.join(process.cwd(), deleted.url.replace(/^\//, ''));
      await fs.unlink(filepath);
    }
  } catch (_) { /* ignore missing file */ }

  return deleted;
}

function resolveLocalPath(url) {
  if (!url) return null;
  if (url.startsWith('/uploads/')) {
    return path.join(process.cwd(), url.replace(/^\//, ''));
  }
  if (url.startsWith('uploads/')) {
    return path.join(process.cwd(), url);
  }
  return null;
}

/**
 * Pick reference images for ad gen: prefer logo + up to 2 other visuals.
 */
async function pickReferencesForAds(brandId, { preferKinds } = {}) {
  const all = await listAssets(brandId);
  const images = all.filter((a) => {
    const mt = a.mime_type || '';
    return mt.startsWith('image/') || /\.(png|jpe?g|webp|gif)$/i.test(a.url || '');
  });

  const logos = images.filter((a) => a.kind === 'logo');
  const screens = images.filter((a) => a.kind === 'screenshot');
  const products = images.filter((a) => a.kind === 'product' || a.kind === 'lifestyle');
  const others = images.filter((a) => !['logo', 'screenshot', 'product', 'lifestyle'].includes(a.kind));

  const picked = [];
  if (logos[0]) picked.push(logos[0]);
  for (const pool of [products, screens, others]) {
    for (const a of pool) {
      if (picked.length >= 3) break;
      if (!picked.find((p) => p.id === a.id)) picked.push(a);
    }
    if (picked.length >= 3) break;
  }

  if (preferKinds?.length) {
    // Re-order: requested kinds first while keeping max 3
    const preferred = [];
    for (const kind of preferKinds) {
      const hit = images.find((a) => a.kind === kind && !preferred.find((p) => p.id === a.id));
      if (hit) preferred.push(hit);
    }
    for (const a of picked) {
      if (preferred.length >= 3) break;
      if (!preferred.find((p) => p.id === a.id)) preferred.push(a);
    }
    return preferred;
  }

  return picked;
}

module.exports = {
  KINDS,
  listAssets,
  getAsset,
  getParsedContext,
  addAsset,
  updateAsset,
  deleteAsset,
  resolveLocalPath,
  pickReferencesForAds,
};
