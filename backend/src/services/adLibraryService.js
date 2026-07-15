const pool = require('./db');

async function listCreatives(brandId) {
  const { rows } = await pool.query(
    `SELECT ac.*,
            COALESCE(
              (
                SELECT json_agg(jsonb_build_object(
                  'id', ba.id,
                  'kind', ba.kind,
                  'label', ba.label,
                  'url', ba.url
                ) ORDER BY ba.id)
                FROM ad_creative_assets aca
                JOIN brand_assets ba ON ba.id = aca.brand_asset_id
                WHERE aca.ad_creative_id = ac.id
              ),
              '[]'::json
            ) AS source_assets,
            COALESCE(
              (
                SELECT json_agg(jsonb_build_object(
                  'id', c.id,
                  'name', c.name,
                  'campaign_type', c.campaign_type,
                  'linked_at', cac.created_at
                ) ORDER BY cac.created_at DESC)
                FROM campaign_ad_creatives cac
                JOIN campaigns c ON c.id = cac.campaign_id
                WHERE cac.ad_creative_id = ac.id
              ),
              '[]'::json
            ) AS campaigns,
            (
              SELECT COUNT(*)::int
              FROM campaign_ad_creatives cac
              WHERE cac.ad_creative_id = ac.id
            ) AS campaign_count
     FROM ad_creatives ac
     WHERE ac.brand_id = $1
     ORDER BY ac.created_at DESC`,
    [brandId]
  );
  return rows;
}

async function getCreative(id) {
  const { rows } = await pool.query('SELECT * FROM ad_creatives WHERE id = $1', [id]);
  return rows[0] || null;
}

async function createCreative(brandId, userId, {
  name,
  format = 'social',
  status = 'draft',
  brief = '',
  content = {},
  image_url = null,
  generation_meta = {},
  asset_ids = [],
}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `INSERT INTO ad_creatives
         (brand_id, name, format, status, brief, content, image_url, generation_meta, created_by)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8::jsonb,$9)
       RETURNING *`,
      [
        brandId,
        name,
        format,
        status,
        brief || null,
        JSON.stringify(content || {}),
        image_url || null,
        JSON.stringify(generation_meta || {}),
        userId,
      ]
    );

    for (let i = 0; i < asset_ids.length; i++) {
      await client.query(
        `INSERT INTO ad_creative_assets (ad_creative_id, brand_asset_id, role, sort_order)
         SELECT $1, id, 'reference', $3 FROM brand_assets
         WHERE id = $2 AND brand_id = $4
         ON CONFLICT DO NOTHING`,
        [rows[0].id, asset_ids[i], i, brandId]
      );
    }
    await client.query('COMMIT');
    return rows[0];
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function updateCreative(brandId, id, fields) {
  const { rows } = await pool.query(
    `UPDATE ad_creatives SET
       name = COALESCE($1, name),
       format = COALESCE($2, format),
       status = COALESCE($3, status),
       brief = COALESCE($4, brief),
       content = COALESCE($5::jsonb, content),
       image_url = COALESCE($6, image_url),
       updated_at = NOW()
     WHERE id = $7 AND brand_id = $8
     RETURNING *`,
    [
      fields.name ?? null,
      fields.format ?? null,
      fields.status ?? null,
      fields.brief ?? null,
      fields.content ? JSON.stringify(fields.content) : null,
      fields.image_url ?? null,
      id,
      brandId,
    ]
  );
  return rows[0] || null;
}

async function deleteCreative(brandId, id) {
  const { rows } = await pool.query(
    'DELETE FROM ad_creatives WHERE id = $1 AND brand_id = $2 RETURNING *',
    [id, brandId]
  );
  return rows[0] || null;
}

async function listCampaignCreatives(campaignId) {
  const { rows } = await pool.query(
    `SELECT ac.*, cac.created_at AS linked_at
     FROM campaign_ad_creatives cac
     JOIN ad_creatives ac ON ac.id = cac.ad_creative_id
     WHERE cac.campaign_id = $1
     ORDER BY cac.created_at DESC`,
    [campaignId]
  );
  return rows;
}

async function linkCreative(campaignId, creativeId) {
  const { rows } = await pool.query(
    `INSERT INTO campaign_ad_creatives (campaign_id, ad_creative_id)
     SELECT c.id, ac.id
     FROM campaigns c
     JOIN ad_creatives ac ON ac.id = $2 AND ac.brand_id = c.brand_id
     WHERE c.id = $1
     ON CONFLICT (campaign_id, ad_creative_id) DO UPDATE SET created_at = campaign_ad_creatives.created_at
     RETURNING *`,
    [campaignId, creativeId]
  );
  if (!rows[0]) throw new Error('Ad and campaign must belong to the same brand');
  return rows[0];
}

async function unlinkCreative(campaignId, creativeId) {
  const { rows } = await pool.query(
    `DELETE FROM campaign_ad_creatives
     WHERE campaign_id = $1 AND ad_creative_id = $2 RETURNING *`,
    [campaignId, creativeId]
  );
  return rows[0] || null;
}

module.exports = {
  listCreatives,
  getCreative,
  createCreative,
  updateCreative,
  deleteCreative,
  listCampaignCreatives,
  linkCreative,
  unlinkCreative,
};
