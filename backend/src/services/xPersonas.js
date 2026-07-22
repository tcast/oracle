/**
 * X (Twitter) persona generation — offline pipeline.
 *
 * Profile fields: display_name, bio, location, website, username (handle), avatar, banner.
 * Stored as credentials.x_persona (+ persona_traits / profile_enrichment flags).
 * Live Playwright edits are separate and gated by X_PERSONA_LIVE=1.
 */

const FIRST_NAMES = [
  'Alex', 'Jordan', 'Casey', 'Morgan', 'Riley', 'Avery', 'Quinn', 'Cameron',
  'Taylor', 'Jamie', 'Drew', 'Reese', 'Skyler', 'Parker', 'Hayden', 'Blake',
  'Sam', 'Chris', 'Pat', 'Dana', 'Elena', 'Marcus', 'Nina', 'Omar',
  'Priya', 'Leo', 'Sofia', 'Noah', 'Maya', 'Ethan', 'Lila', 'Owen',
];

const LAST_NAMES = [
  'Brooks', 'Nguyen', 'Patel', 'Reed', 'Hayes', 'Coleman', 'Foster', 'Bennett',
  'Griffin', 'Sullivan', 'Keller', 'Ramirez', 'Walsh', 'Chen', 'Murphy', 'Diaz',
  'Porter', 'Singh', 'Bailey', 'Hughes', 'Warren', 'Kim', 'Price', 'Shaw',
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

/**
 * Human-like X handle: first+last + light digits, max 15 chars, [A-Za-z0-9_].
 */
function generateUsername(first, last, rng, seed) {
  const f = String(first || 'user').replace(/[^A-Za-z]/g, '');
  const l = String(last || 'person').replace(/[^A-Za-z]/g, '');
  const fl = f.toLowerCase();
  const ll = l.toLowerCase();
  const dig2 = String(10 + Math.floor(rng() * 90));
  const dig1 = String(Math.floor(rng() * 9) + 1);
  const dig3 = String(100 + Math.floor(rng() * 900));
  const year = String(1985 + Math.floor(rng() * 25));
  const candidates = [
    `${fl}${ll}${dig2}`,
    `${fl}_${ll.slice(0, 4)}${dig1}`,
    `${fl}${ll.slice(0, 3)}${dig3}`,
    `${fl[0] || 'x'}${ll}${dig2}`,
    `${fl}${ll.slice(0, 5)}${dig1}`,
    `${fl}${ll}${year.slice(2)}`,
    `${fl}_${ll}${dig2}`,
    `${fl}${ll.slice(0, 6)}`,
  ];
  // Prefer first that fits; fall back to truncated + seed digits
  for (const c of candidates) {
    const cleaned = c.replace(/[^A-Za-z0-9_]/g, '').slice(0, 15);
    if (cleaned.length >= 4) return cleaned;
  }
  const fallback = `${fl.slice(0, 6)}${(seed % 10000).toString().padStart(4, '0')}`.slice(0, 15);
  return fallback || `user${(seed % 100000).toString()}`;
}

/**
 * Generate a realistic X persona from an account id or arbitrary seed string.
 * Same seed ⇒ same persona (stable re-runs).
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
    overrides.username ||
    overrides.handle ||
    generateUsername(first, last, rng, seed);

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
  return {
    display_name: persona.display_name,
    username: persona.username || null,
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
  return {
    ...base,
    display_name: persona.display_name,
    username: persona.username || base.username || null,
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
  toCredentialsXPersona,
  mergePersonaTraits,
  enrichmentPatchFromPersona,
};
