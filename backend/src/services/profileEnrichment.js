/**
 * Profile enrichment / build-out tracking for social_accounts.
 *
 * Assumptions:
 * - LinkedIn "built out" ≈ profile photo + hiring persona (headline/about/experience).
 * - LinkedIn banner/background upload sets profile_enrichment.banner when verified.
 * - X: credentials.x_persona ⇒ headline (display_name) + about (bio); photo/banner when uploaded.
 * - Reddit/IG: no photo/banner tracking yet; category from persona_traits.expertise when present.
 */

const pool = require('./db');

const CATEGORY_LABELS = {
  hr_talent: 'HR / Talent',
};

function emptyEnrichment() {
  return {
    photo: false,
    banner: false,
    headline: false,
    about: false,
    experience: false,
    category: null,
    built_out: 'none',
    source: null,
    updated_at: null,
  };
}

function computeBuiltOut(e) {
  const visual = !!(e.photo || e.banner);
  const content = !!(e.headline || e.about || e.experience);
  if (visual && content) return 'full';
  if (visual || content) return 'partial';
  return 'none';
}

function normalizeEnrichment(raw) {
  const base = emptyEnrichment();
  if (!raw || typeof raw !== 'object') return { ...base, built_out: 'none' };
  const e = {
    ...base,
    ...raw,
    photo: !!raw.photo,
    banner: !!raw.banner,
    headline: !!raw.headline,
    about: !!raw.about,
    experience: !!raw.experience,
    category: raw.category || null,
  };
  e.built_out = computeBuiltOut(e);
  return e;
}

function categoryLabel(category) {
  if (!category) return null;
  if (CATEGORY_LABELS[category]) return CATEGORY_LABELS[category];
  return String(category)
    .split(/[_\s/]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function categoryFromExpertise(traits) {
  const expertise = Array.isArray(traits?.expertise) ? traits.expertise.filter(Boolean) : [];
  if (!expertise.length) return null;
  return expertise
    .slice(0, 2)
    .map((x) => String(x).toLowerCase().replace(/\s+/g, '_'))
    .join('_');
}

/**
 * Merge patch into existing enrichment and persist.
 */
async function updateEnrichment(accountId, patch = {}, { source } = {}) {
  const { rows } = await pool.query(
    'SELECT profile_enrichment FROM social_accounts WHERE id = $1',
    [accountId]
  );
  if (!rows.length) throw new Error(`Account ${accountId} not found`);

  const current = normalizeEnrichment(rows[0].profile_enrichment);
  const next = normalizeEnrichment({
    ...current,
    ...patch,
    source: source || patch.source || current.source || 'manual',
    updated_at: new Date().toISOString(),
  });

  await pool.query(
    `UPDATE social_accounts
     SET profile_enrichment = $2::jsonb, updated_at = NOW()
     WHERE id = $1`,
    [accountId, JSON.stringify(next)]
  );
  return next;
}

/**
 * Derive enrichment from credentials + persona_traits + optional photo file presence.
 * Does not write — used by backfill and API fallback.
 */
function deriveEnrichment({
  platform,
  credentials,
  persona_traits,
  hasPhotoFile = false,
  existing = null,
} = {}) {
  const creds =
    typeof credentials === 'string'
      ? (() => {
          try {
            return JSON.parse(credentials);
          } catch {
            return {};
          }
        })()
      : credentials || {};
  const traits =
    typeof persona_traits === 'string'
      ? (() => {
          try {
            return JSON.parse(persona_traits);
          } catch {
            return {};
          }
        })()
      : persona_traits || {};

  const base = normalizeEnrichment(existing);
  const patch = { ...base };

  if (platform === 'linkedin') {
    const hp = creds.hiring_persona;
    if (hp && typeof hp === 'object') {
      patch.headline = true;
      patch.about = !!(hp.about || hp.headline);
      patch.experience = !!(hp.title || hp.company);
      patch.category = patch.category || 'hr_talent';
    }
    if (creds.profile_enrichment?.photo || hasPhotoFile) {
      patch.photo = true;
    }
    patch.banner = !!(creds.profile_enrichment?.banner || base.banner);
  } else if (platform === 'x') {
    const xp = creds.x_persona && typeof creds.x_persona === 'object' ? creds.x_persona : null;
    if (xp) {
      patch.headline = !!(xp.display_name || xp.name);
      patch.about = !!xp.bio;
      patch.experience = false;
      patch.category = patch.category || 'general';
    }
    if (creds.profile_enrichment?.photo || hasPhotoFile) {
      patch.photo = true;
    }
    patch.banner = !!(creds.profile_enrichment?.banner || xp?.banner);
    const cat = categoryFromExpertise(traits);
    if (cat && !patch.category) patch.category = cat;
  } else {
    const cat = categoryFromExpertise(traits);
    if (cat) patch.category = cat;
  }

  return normalizeEnrichment({
    ...patch,
    source: patch.source || 'derived',
    updated_at: patch.updated_at || new Date().toISOString(),
  });
}

function formatForApi(enrichment) {
  const e = normalizeEnrichment(enrichment);
  return {
    ...e,
    category_label: categoryLabel(e.category),
    built_out_label:
      e.built_out === 'full' ? 'Built out' : e.built_out === 'partial' ? 'Partial' : 'None',
  };
}

module.exports = {
  CATEGORY_LABELS,
  emptyEnrichment,
  computeBuiltOut,
  normalizeEnrichment,
  categoryLabel,
  categoryFromExpertise,
  updateEnrichment,
  deriveEnrichment,
  formatForApi,
};
