/**
 * X (Twitter) persona generation — offline pipeline.
 *
 * Profile fields: display_name, bio, location, website, desired_username (handle), avatar, banner.
 * Stored as credentials.x_persona (+ persona_traits / profile_enrichment flags).
 * Live Playwright edits are separate and gated by X_PERSONA_LIVE=1.
 *
 * Handle style (human vibe — name, nickname, or topic):
 *   John_smith32, __johnnyboy4033_, sport_dude
 * Not garbage: tinajoh5oxxq, edwardp_3pa
 *
 * Note: X only allows [A-Za-z0-9_]; hyphens from the style brief map to underscores.
 */

const FIRST_NAMES = [
  'Alex', 'Jordan', 'Casey', 'Morgan', 'Riley', 'Avery', 'Quinn', 'Cameron',
  'Taylor', 'Jamie', 'Drew', 'Reese', 'Skyler', 'Parker', 'Hayden', 'Blake',
  'Sam', 'Chris', 'Pat', 'Dana', 'Elena', 'Marcus', 'Nina', 'Omar',
  'Priya', 'Leo', 'Sofia', 'Noah', 'Maya', 'Ethan', 'Lila', 'Owen',
  'John', 'Nick', 'Johnny', 'Ash', 'Kai', 'Max', 'Zoe', 'Ryan',
];

const LAST_NAMES = [
  'Brooks', 'Nguyen', 'Patel', 'Reed', 'Hayes', 'Coleman', 'Foster', 'Bennett',
  'Griffin', 'Sullivan', 'Keller', 'Ramirez', 'Walsh', 'Chen', 'Murphy', 'Diaz',
  'Porter', 'Singh', 'Bailey', 'Hughes', 'Warren', 'Kim', 'Price', 'Shaw',
  'Smith', 'Jones', 'Miller', 'Davis', 'Wilson', 'Moore',
];

const NICKNAMES = [
  'johnnyboy', 'sporty', 'chillguy', 'techkid', 'sunny', 'nightowl', 'bookish',
  'coder', 'runner', 'midwest', 'coastal', 'quietone', 'loudmouth', 'daydream',
  'skyline', 'pixel', 'neon', 'ember', 'harbor', 'cedar', 'maple', 'river',
];

const TOPIC_WORDS = [
  'sport', 'music', 'coffee', 'travel', 'photo', 'design', 'fitness', 'gaming',
  'film', 'books', 'trail', 'surf', 'bike', 'art', 'food', 'tech', 'data',
  'code', 'build', 'craft', 'garden', 'hike', 'wave', 'cloud',
];

const LOCATIONS = [
  'Austin, TX',
  'Denver, CO',
  'Seattle, WA',
  'Chicago, IL',
  'Atlanta, GA',
  'Portland, OR',
  'Boston, MA',
  'Nashville, TN',
  'Phoenix, AZ',
  'Minneapolis, MN',
  'Raleigh, NC',
  'San Diego, CA',
  'Philadelphia, PA',
  'Tampa, FL',
  'Salt Lake City, UT',
];

const BIO_TEMPLATES = [
  ({ role, interest }) =>
    `${role}. Into ${interest}. Opinions mine. Usually building something or reading about it.`,
  ({ role, interest }) =>
    `${role} · ${interest} nerd. Trying to ship more than I scroll.`,
  ({ role }) =>
    `${role}. Coffee, long walks, short takes. DMs open for interesting problems.`,
  ({ role, interest }) =>
    `Working on better ${interest} workflows. Day job: ${role}.`,
  ({ role }) =>
    `${role} by trade. Skeptical of hype, curious about what actually works.`,
  ({ interest }) =>
    `Mostly ${interest}. Occasional hot takes, mostly notes to self.`,
  ({ role, interest }) =>
    `${role}. Learning in public about ${interest}. Still figuring it out.`,
  ({ role }) =>
    `${role}. Low-drama timeline. High-signal if I can manage it.`,
];

const ROLES = [
  'Product manager',
  'Software engineer',
  'Designer',
  'Founder',
  'Operator',
  'Marketer',
  'Analyst',
  'Consultant',
  'Researcher',
  'Writer',
];

const INTERESTS = [
  'AI tools',
  'hiring',
  'startups',
  'devtools',
  'productivity',
  'systems design',
  'growth',
  'data',
  'UX',
  'automation',
];

/** Mulberry32 — deterministic PRNG from a numeric seed. */
function mulberry32(seed) {
  let t = seed >>> 0;
  return function next() {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function hashString(str) {
  let h = 2166136261;
  const s = String(str);
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function pick(rng, arr) {
  return arr[Math.floor(rng() * arr.length)];
}

function sanitizeHandle(raw) {
  // X forbids hyphens — map style-brief hyphens to underscores
  return String(raw || '')
    .replace(/-/g, '_')
    .replace(/[^A-Za-z0-9_]/g, '')
    .slice(0, 15);
}

/**
 * Marketplace / bot garbage: tinajoh5oxxq, edwardp_3pa, nelsonbai3zd, etc.
 * Does NOT flag readable handles like John_smith32 / sport_dude / haydensullivan5.
 */
function looksFakeUsername(username) {
  const u = String(username || '')
    .replace(/^@/, '')
    .trim()
    .toLowerCase();
  if (!u || u.length < 3) return true;
  // Junk clusters: _3pa, _4xakw, _2zwp
  if (/_[0-9][a-z]{2,5}$/.test(u)) return true;
  // Brief regex (requires a digit mid/end cluster → letter tail): tinajoh5oxxq
  if (/^[a-z]+[0-9]?[a-z0-9]{0,3}[0-9]+[a-z]{2,5}$/.test(u)) return true;
  // letter + single digit + short consonant junk: nelsonbai3zd, sophiera8pdl
  if (/^[a-z]{5,}[0-9][a-z]{2,4}$/.test(u) && !u.includes('_')) return true;
  // digit+consonant cluster without vowels near end: 2cqq / 5oxxq style tails
  if (/[0-9][bcdfghjklmnpqrstvwxyz]{3,5}$/.test(u) && !/[aeiou].*[aeiou]/.test(u.slice(-6))) {
    return true;
  }
  return false;
}

/**
 * Reject botty garbage like tinajoh5oxxq (letters + 1–2 digits + 4+ random letters).
 * Prefer First_last## / nickname_## / topic_word style handles.
 */
function isJunkUsername(username) {
  const u = String(username || '')
    .replace(/^@/, '')
    .trim()
    .toLowerCase();
  if (!u || u.length < 3) return true;
  if (looksFakeUsername(u)) return true;
  if (/^[a-z]+[0-9]{1,2}[a-z]{4,}$/.test(u)) return true;
  if (/^[a-z]{1,3}[0-9]{2,}[a-z]{3,}$/.test(u)) return true;
  if (/^(user|acct|tmp|test)\d+$/i.test(u)) return true;
  return false;
}

/** True when live @handle still looks marketplace-fake (needs rename). */
function needsHumanHandle(liveUsername, persona = null) {
  const live = String(liveUsername || '').replace(/^@/, '').trim();
  const desired =
    (persona && (persona.desired_username || persona.username)) || null;
  const applied = !!(persona && persona.username_applied);
  if (desired && !applied) {
    if (!live || live.toLowerCase() !== String(desired).toLowerCase()) return true;
  }
  if (looksFakeUsername(live) || isJunkUsername(live)) return true;
  return false;
}

/**
 * Varied human-like templates (max 15, [A-Za-z0-9_]):
 *   First_last##, nickname_##, topic_word, optional leading/trailing _
 */
function generateUsernameCandidates(first, last, rng, seed) {
  const f = String(first || 'user').replace(/[^A-Za-z]/g, '');
  const l = String(last || 'person').replace(/[^A-Za-z]/g, '');
  const fl = f.toLowerCase();
  const ll = l.toLowerCase();
  const nick = pick(rng, NICKNAMES);
  const topic = pick(rng, TOPIC_WORDS);
  const word = pick(rng, TOPIC_WORDS);
  const dig2 = String(10 + Math.floor(rng() * 90));
  const dig1 = String(Math.floor(rng() * 9) + 1);
  const dig3 = String(100 + Math.floor(rng() * 900));
  const dig4 = String(1000 + Math.floor(rng() * 9000));
  const year = String(1985 + Math.floor(rng() * 25));

  const raw = [
    // First_last##
    `${fl}_${ll}${dig2}`,
    `${fl}_${ll.slice(0, 6)}${dig1}`,
    `${fl}_${ll}`,
    // Nickname_##
    `${nick}_${dig2}`,
    `${nick}${dig2}`,
    `_${nick}${dig2}_`,
    `__${nick}${dig3.slice(0, 2)}_`,
    // Topic-word (hyphen vibe → underscore)
    `${topic}_${word}`,
    `${topic}_${fl.slice(0, 4)}`,
    `${topic}-dude`.replace(/-/g, '_'),
    `${fl}${dig2}_${ll.slice(0, 3)}`,
    // Leading / trailing underscores
    `_${fl}_${ll.slice(0, 4)}`,
    `${fl}_${ll}_`,
    `__${fl}${dig2}_`,
    // Compact but still readable
    `${fl}${ll.slice(0, 4)}_${dig2}`,
    `${fl[0] || 'x'}_${ll}${dig2}`,
    `${nick}_${year.slice(2)}`,
    `${topic}_${dig3}`,
  ];

  const out = [];
  const seen = new Set();
  for (const c of raw) {
    const cleaned = sanitizeHandle(c);
    if (cleaned.length < 4 || cleaned.length > 15) continue;
    if (isJunkUsername(cleaned) || looksFakeUsername(cleaned)) continue;
    // Prefer handles that look intentional (underscore, or clear nickname)
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(cleaned);
  }
  // Guaranteed fallback with underscore
  const fallback = sanitizeHandle(`${fl.slice(0, 6)}_${(seed % 10000).toString().padStart(4, '0')}`);
  if (fallback.length >= 4 && !seen.has(fallback.toLowerCase())) out.push(fallback);
  return out.length ? out : [sanitizeHandle(`user_${seed % 100000}`)];
}

/**
 * Human-like X handle from templates; optional takenSet for uniqueness.
 * Rotates preferred template by seed so we get First_last / nickname / topic mix.
 */
function generateUsername(first, last, rng, seed, takenSet = null) {
  const candidates = generateUsernameCandidates(first, last, rng, seed);
  const start = candidates.length ? seed % candidates.length : 0;
  const ordered = [
    ...candidates.slice(start),
    ...candidates.slice(0, start),
  ];
  // Prefer underscore-styled handles first in the rotated window
  const ranked = [
    ...ordered.filter((c) => c.includes('_')),
    ...ordered.filter((c) => !c.includes('_')),
  ];
  for (const c of ranked) {
    if (takenSet && takenSet.has(c.toLowerCase())) continue;
    return c;
  }
  // Exhausted — mutate with seed digits until free
  const base = candidates[0] || `user_${seed % 10000}`;
  for (let i = 0; i < 40; i += 1) {
    const n = (seed + i * 97) % 10000;
    const alt = sanitizeHandle(`${base.replace(/_?\d+$/, '').slice(0, 10)}_${n}`);
    if (alt.length >= 4 && !(takenSet && takenSet.has(alt.toLowerCase()))) return alt;
  }
  return sanitizeHandle(`u_${seed % 1000000}`);
}

/**
 * Load lowercase handles already claimed (live username + desired/persona username).
 */
async function loadTakenUsernames(pool, { excludeAccountId = null } = {}) {
  const { rows } = await pool.query(
    `SELECT id, username,
            credentials->'x_persona'->>'username' AS persona_user,
            credentials->'x_persona'->>'desired_username' AS desired_user
     FROM social_accounts
     WHERE platform IN ('x', 'twitter')`
  );
  const taken = new Set();
  for (const r of rows) {
    if (excludeAccountId != null && Number(r.id) === Number(excludeAccountId)) continue;
    for (const v of [r.username, r.persona_user, r.desired_user]) {
      const s = String(v || '')
        .replace(/^@/, '')
        .trim()
        .toLowerCase();
      if (s) taken.add(s);
    }
  }
  return taken;
}

/**
 * Allocate a unique desired handle for an account (DB-aware).
 */
async function allocateDesiredUsername(pool, accountIdOrSeed, { first, last } = {}) {
  const seed =
    typeof accountIdOrSeed === 'number'
      ? accountIdOrSeed >>> 0
      : hashString(accountIdOrSeed);
  const rng = mulberry32(seed ^ 0x484e444c); // 'HNDL'
  const f = first || pick(rng, FIRST_NAMES);
  const l = last || pick(rng, LAST_NAMES);
  const excludeId = typeof accountIdOrSeed === 'number' ? accountIdOrSeed : null;
  const taken = await loadTakenUsernames(pool, { excludeAccountId: excludeId });
  return generateUsername(f, l, rng, seed, taken);
}

/**
 * Generate a realistic X persona from an account id or arbitrary seed string.
 * Same seed ⇒ same persona (stable re-runs) unless takenSet forces a different handle.
 */
function generateXPersona(accountIdOrSeed, overrides = {}) {
  const seed =
    typeof accountIdOrSeed === 'number'
      ? accountIdOrSeed >>> 0
      : hashString(accountIdOrSeed);
  const rng = mulberry32(seed ^ 0x58505800); // 'XPX\0'

  const first = pick(rng, FIRST_NAMES);
  const last = pick(rng, LAST_NAMES);
  const display_name = overrides.display_name || `${first} ${last}`;
  const username =
    overrides.desired_username ||
    overrides.username ||
    overrides.handle ||
    generateUsername(first, last, rng, seed, overrides.takenUsernames || null);

  const role = pick(rng, ROLES);
  const interest = pick(rng, INTERESTS);
  const bioTpl = pick(rng, BIO_TEMPLATES);
  const bio = overrides.bio || bioTpl({ role, interest });

  const includeLocation =
    overrides.location !== undefined ? !!overrides.location : rng() < 0.72;
  const location =
    overrides.location !== undefined
      ? overrides.location || null
      : includeLocation
        ? pick(rng, LOCATIONS)
        : null;

  const includeWebsite =
    overrides.website !== undefined ? !!overrides.website : rng() < 0.35;
  const website =
    overrides.website !== undefined
      ? overrides.website || null
      : includeWebsite
        ? `https://${first.toLowerCase()}${last.toLowerCase().slice(0, 4)}.com`
        : null;

  return {
    display_name,
    username,
    desired_username: username,
    bio,
    location,
    website,
    rename_handle: true,
    seed,
  };
}

/**
 * Shape stored under social_accounts.credentials.x_persona
 */
function toCredentialsXPersona(persona, { applied_live = false } = {}) {
  const handle = persona.desired_username || persona.username || null;
  return {
    display_name: persona.display_name,
    username: handle,
    desired_username: handle,
    bio: persona.bio,
    location: persona.location || null,
    website: persona.website || null,
    rename_handle: persona.rename_handle !== false,
    applied_live: !!applied_live,
    updated_at: new Date().toISOString(),
  };
}

/**
 * Light persona_traits merge so organic reply prompts pick up display vibe.
 */
function mergePersonaTraits(existing, persona) {
  const base =
    existing && typeof existing === 'object' && !Array.isArray(existing)
      ? { ...existing }
      : {};
  const handle = persona.desired_username || persona.username || null;
  return {
    ...base,
    display_name: persona.display_name,
    username: handle || base.username || null,
    bio: persona.bio,
    tone: base.tone || 'engaging',
    writingStyle: base.writingStyle || 'casual',
    expertise: Array.isArray(base.expertise) && base.expertise.length
      ? base.expertise
      : ['technology', 'business'],
  };
}

/**
 * profile_enrichment patch for offline assignment (content flags only).
 * Maps: display_name → headline, bio → about. Photo/banner stay false until upload.
 */
function enrichmentPatchFromPersona(persona, { source = 'x_persona_offline' } = {}) {
  return {
    headline: !!persona.display_name,
    about: !!persona.bio,
    experience: false,
    category: 'general',
    source,
  };
}

module.exports = {
  generateXPersona,
  generateUsername,
  generateUsernameCandidates,
  allocateDesiredUsername,
  loadTakenUsernames,
  isJunkUsername,
  looksFakeUsername,
  needsHumanHandle,
  toCredentialsXPersona,
  mergePersonaTraits,
  enrichmentPatchFromPersona,
};
