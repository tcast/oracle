const pool = require('./db');

function slugify(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 100);
}

async function userHasBrandAccess(userId, brandId, minRole = 'viewer') {
  const { rows } = await pool.query(
    `SELECT role FROM brand_members WHERE brand_id = $1 AND user_id = $2`,
    [brandId, userId]
  );
  if (!rows.length) return false;
  const rank = { viewer: 1, editor: 2, owner: 3 };
  return (rank[rows[0].role] || 0) >= (rank[minRole] || 1);
}

async function listBrandsForUser(userId) {
  const { rows } = await pool.query(
    `SELECT b.*, bm.role AS member_role,
            (SELECT COUNT(*)::int FROM brand_channels bc WHERE bc.brand_id = b.id AND bc.status = 'active') AS channel_count,
            (SELECT COUNT(*)::int FROM ad_accounts aa WHERE aa.brand_id = b.id AND aa.status = 'active') AS ad_account_count,
            (SELECT COUNT(*)::int FROM brand_assets ba WHERE ba.brand_id = b.id) AS asset_count,
            (SELECT COUNT(*)::int FROM ad_creatives ac WHERE ac.brand_id = b.id) AS creative_count
     FROM brands b
     INNER JOIN brand_members bm ON bm.brand_id = b.id
     WHERE bm.user_id = $1
     ORDER BY b.name ASC`,
    [userId]
  );
  return rows;
}

async function getBrand(brandId, userId) {
  const { rows } = await pool.query(
    `SELECT b.*, bm.role AS member_role
     FROM brands b
     INNER JOIN brand_members bm ON bm.brand_id = b.id
     WHERE b.id = $1 AND bm.user_id = $2`,
    [brandId, userId]
  );
  return rows[0] || null;
}

async function createBrand(userId, { name, slug, website, brand_voice, logo_url }) {
  const finalSlug = slug || slugify(name);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `INSERT INTO brands (name, slug, website, brand_voice, logo_url)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [name, finalSlug, website || null, brand_voice || null, logo_url || null]
    );
    await client.query(
      `INSERT INTO brand_members (brand_id, user_id, role) VALUES ($1, $2, 'owner')`,
      [rows[0].id, userId]
    );
    await client.query('COMMIT');
    return rows[0];
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function updateBrand(brandId, userId, fields) {
  const ok = await userHasBrandAccess(userId, brandId, 'editor');
  if (!ok) throw new Error('Forbidden');

  const { name, website, brand_voice, logo_url } = fields;
  const { rows } = await pool.query(
    `UPDATE brands SET
       name = COALESCE($1, name),
       website = COALESCE($2, website),
       brand_voice = COALESCE($3, brand_voice),
       logo_url = COALESCE($4, logo_url),
       updated_at = NOW()
     WHERE id = $5 RETURNING *`,
    [name ?? null, website ?? null, brand_voice ?? null, logo_url ?? null, brandId]
  );
  return rows[0];
}

async function ensureUserBrandMemberships(userId) {
  await pool.query(
    `INSERT INTO brand_members (brand_id, user_id, role)
     SELECT b.id, $1, 'owner' FROM brands b
     ON CONFLICT (brand_id, user_id) DO NOTHING`,
    [userId]
  );
}

async function getBrandIdsForUser(userId) {
  const { rows } = await pool.query(
    `SELECT brand_id FROM brand_members WHERE user_id = $1`,
    [userId]
  );
  return rows.map((r) => r.brand_id);
}

module.exports = {
  slugify,
  userHasBrandAccess,
  listBrandsForUser,
  getBrand,
  createBrand,
  updateBrand,
  ensureUserBrandMemberships,
  getBrandIdsForUser,
};
