const pool = require('./db');
const playwrightService = require('./playwrightService');

const EXPERTISE_SUBS = {
  technology: ['technology', 'gadgets', 'programming', 'webdev', 'apple', 'android', 'buildapc', 'sysadmin'],
  business: ['Entrepreneur', 'smallbusiness', 'marketing', 'startups', 'Business'],
  science: ['science', 'askscience', 'chemistry', 'Physics', 'biology', 'space'],
  arts: ['Art', 'Design', 'photography', 'Music', 'books', 'movies'],
  gaming: ['gaming', 'pcgaming', 'Games', 'IndieGaming', 'patientgamers', 'ShouldIbuythisgame'],
  sports: ['sports', 'nfl', 'nba', 'soccer', 'running', 'fitness'],
  finance: ['personalfinance', 'FinancialPlanning', 'investing', 'Economics', 'CreditCards'],
  education: ['AskAcademia', 'college', 'Teachers', 'learnprogramming', 'GetStudying'],
};

const SAFE_GENERAL = ['AskReddit', 'CasualConversation', 'NoStupidQuestions', 'todayilearned', 'LifeProTips'];

/** Topic packs for X organic search (sports / DFS / tech). */
const X_TOPIC_PACKS = {
  sports: [
    'NBA',
    'NFL',
    'MLB highlights',
    'March Madness',
    'UFC',
    'fantasy football',
    'college basketball',
  ],
  dfs: [
    'DraftKings',
    'FanDuel',
    'PrizePicks',
    'DFS lineup',
    'fantasy sports',
    'Underdog Fantasy',
  ],
  tech: [
    'AI tools',
    'startups',
    'devtools',
    'software engineering',
    'product management',
    'OpenAI',
  ],
  general: ['interesting take', 'breaking news', 'weekend vibes'],
};

/** Platforms with organic comment discovery + posting wired. */
const ORGANIC_PLATFORMS = ['reddit', 'linkedin', 'x', 'instagram'];

function normalizeSub(name) {
  return String(name || '').replace(/^r\//i, '').trim();
}

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function shuffle(arr) {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

class OrganicDiscoveryService {
  getSupportedPlatforms() {
    return [...ORGANIC_PLATFORMS];
  }

  async getSubsForAccount(account) {
    let traits = account.persona_traits;
    if (typeof traits === 'string') {
      try { traits = JSON.parse(traits); } catch { traits = {}; }
    }
    traits = traits || {};

    const expertise = Array.isArray(traits.expertise) ? traits.expertise : [];
    const poolSubs = [];
    for (const exp of expertise) {
      const key = String(exp).toLowerCase();
      for (const sub of EXPERTISE_SUBS[key] || []) {
        poolSubs.push(normalizeSub(sub));
      }
    }

    if (poolSubs.length < 3) {
      poolSubs.push(...SAFE_GENERAL.map(normalizeSub));
    }

    return [...new Set(poolSubs.filter(Boolean))];
  }

  async pickSubreddit(account) {
    const subs = await this.getSubsForAccount(account);
    return pickRandom(subs);
  }

  async getUsedPostUrls() {
    const result = await pool.query(
      `SELECT post_url FROM organic_comments
       WHERE status IN ('posted', 'pending', 'simulated')`
    );
    const used = new Set(result.rows.map((r) => r.post_url));

    const campaignPosts = await pool.query(
      `SELECT platform_post_id, subreddit, metadata
       FROM posts
       WHERE platform = 'reddit'
         AND status IN ('posted', 'simulated')
         AND platform_post_id IS NOT NULL`
    );
    for (const row of campaignPosts.rows) {
      const metaUrl = row.metadata?.url || row.metadata?.permalink || row.metadata?.post_url;
      if (metaUrl) used.add(metaUrl);
      if (row.platform_post_id && row.subreddit) {
        used.add(`https://www.reddit.com/r/${row.subreddit}/comments/${row.platform_post_id}/`);
      }
    }
    return used;
  }

  scoreThread(post) {
    const comments = post.num_comments || 0;
    const score = post.score || 0;
    let fit = 1;
    if (comments > 400) fit -= 1.2;
    if (score > 8000) fit -= 1;
    if (comments >= 2 && comments <= 120) fit += 0.8;
    if (score >= 5 && score <= 2000) fit += 0.5;
    if (!post.title || post.title.length < 8) fit -= 1;
    return fit;
  }

  async fetchSubredditListing(accountId, subreddit, sort = 'hot') {
    return playwrightService.listRedditSubredditPosts(accountId, subreddit, {
      sort,
      limit: 25,
    });
  }

  filterUnused(posts, used) {
    return (posts || []).filter((p) => {
      const url = p?.post_url || p?.url;
      if (!url || used.has(url)) return false;
      const bare = url.replace(/\/$/, '');
      if (used.has(bare) || used.has(`${bare}/`)) return false;
      return true;
    });
  }

  async findRedditThread(account, used) {
    const subs = shuffle(await this.getSubsForAccount(account));
    const tried = [];

    for (const sub of subs.slice(0, 2)) {
      tried.push(sub);
      try {
        const sort = Math.random() > 0.45 ? 'hot' : 'new';
        const posts = await this.fetchSubredditListing(account.id, sub, sort);
        const candidates = this.filterUnused(posts, used)
          .filter((p) => this.scoreThread(p) > 0)
          .map((p) => ({
            subreddit: normalizeSub(p.subreddit || sub),
            title: p.title || '',
            selftext: (p.selftext || '').slice(0, 1200),
            post_url: p.post_url.endsWith('/') ? p.post_url : `${p.post_url}/`,
            score: p.score || 0,
            num_comments: p.num_comments || 0,
            created_utc: p.created_utc || Date.now() / 1000,
            fit: this.scoreThread(p),
            platform: 'reddit',
          }))
          .sort((a, b) => b.fit - a.fit);

        if (candidates.length) {
          const top = candidates.slice(0, Math.min(5, candidates.length));
          return pickRandom(top);
        }
      } catch (err) {
        console.warn(`organic discovery r/${sub}:`, err.message);
      }
    }

    throw new Error(`No commentable threads found (tried: ${tried.join(', ')})`);
  }

  async findLinkedInThread(account, used) {
    let posts = [];
    try {
      posts = await playwrightService.listLinkedInFeedPosts(account.id, { limit: 12 });
    } catch (err) {
      console.warn('LinkedIn feed discovery:', err.message);
    }
    if (!posts.length) {
      const persona = account.persona_traits || {};
      const expertise = Array.isArray(persona.expertise) ? persona.expertise[0] : null;
      const query = expertise || 'career growth';
      posts = await playwrightService.listLinkedInSearchPosts(account.id, {
        query,
        limit: 10,
      });
    }
    const candidates = this.filterUnused(posts, used).map((p) => ({
      subreddit: p.subreddit || 'linkedin:feed',
      title: p.title || 'LinkedIn post',
      selftext: (p.selftext || p.title || '').slice(0, 1200),
      post_url: p.post_url,
      score: 0,
      num_comments: 0,
      fit: (p.title || '').length > 20 ? 1.2 : 0.8,
      platform: 'linkedin',
    }));
    if (!candidates.length) throw new Error('No commentable LinkedIn posts (feed+search empty)');
    return pickRandom(candidates.slice(0, 5));
  }

  /**
   * Resolve X search keywords from persona / topic packs / follow-target categories /
   * optional organic_comment_settings.x_search_keywords.
   */
  async getXSearchKeywords(account) {
    const keywords = [];

    let traits = account.persona_traits;
    if (typeof traits === 'string') {
      try { traits = JSON.parse(traits); } catch { traits = {}; }
    }
    traits = traits || {};

    const creds = account.credentials && typeof account.credentials === 'object'
      ? account.credentials
      : {};
    const xp = creds.x_persona && typeof creds.x_persona === 'object' ? creds.x_persona : {};

    for (const exp of Array.isArray(traits.expertise) ? traits.expertise : []) {
      keywords.push(String(exp));
    }
    for (const interest of Array.isArray(traits.interests) ? traits.interests : []) {
      keywords.push(String(interest));
    }
    if (xp.interest) keywords.push(String(xp.interest));
    if (xp.bio) {
      const bioBits = String(xp.bio).match(/\b(NBA|NFL|DFS|AI|startup|fantasy|sports|tech)\b/gi);
      if (bioBits) keywords.push(...bioBits);
    }

    try {
      const settings = await pool.query(
        `SELECT x_search_keywords FROM organic_comment_settings WHERE id = 1`
      );
      const globalKw = settings.rows[0]?.x_search_keywords;
      if (Array.isArray(globalKw)) keywords.push(...globalKw.map(String));
      else if (typeof globalKw === 'string' && globalKw.trim()) {
        keywords.push(...globalKw.split(',').map((s) => s.trim()).filter(Boolean));
      }
    } catch {
      /* column may not exist yet — ignore */
    }

    // Topic packs inferred from persona + follow-target categories
    const packKeys = new Set();
    const blob = `${JSON.stringify(traits)} ${JSON.stringify(xp)} ${account.username || ''}`.toLowerCase();
    if (/sport|nba|nfl|mlb|ufc|ball|fantasy|dfs|draft/.test(blob)) {
      packKeys.add('sports');
      packKeys.add('dfs');
    }
    if (/tech|ai|code|dev|software|startup|product/.test(blob)) {
      packKeys.add('tech');
    }
    if (!packKeys.size) {
      packKeys.add('sports');
      packKeys.add('dfs');
      packKeys.add('tech');
    }
    for (const key of packKeys) {
      keywords.push(...(X_TOPIC_PACKS[key] || []));
    }

    try {
      const cats = await pool.query(
        `SELECT DISTINCT category FROM x_follow_targets WHERE enabled = true LIMIT 8`
      );
      for (const row of cats.rows) {
        const cat = String(row.category || '').toLowerCase();
        if (X_TOPIC_PACKS[cat]) keywords.push(...X_TOPIC_PACKS[cat].slice(0, 3));
        else if (cat) keywords.push(cat);
      }
    } catch {
      /* ignore */
    }

    const cleaned = [...new Set(
      keywords
        .map((k) => String(k || '').trim())
        .filter((k) => k.length >= 2 && k.length <= 60)
    )];
    return shuffle(cleaned.length ? cleaned : X_TOPIC_PACKS.sports);
  }

  async findXThread(account, used) {
    const keywords = await this.getXSearchKeywords(account);
    const tried = [];

    // Prefer search (organic discovery) over home-only
    for (const query of keywords.slice(0, 3)) {
      tried.push(`search:${query}`);
      try {
        const posts = await playwrightService.listXSearchPosts(account.id, {
          query,
          limit: 12,
        });
        const candidates = this.filterUnused(posts, used).map((p) => ({
          subreddit: p.subreddit || `x:search:${query}`,
          title: p.title || 'X post',
          selftext: (p.selftext || p.title || '').slice(0, 1200),
          post_url: p.post_url,
          score: 0,
          num_comments: 0,
          fit: 1.2,
          platform: 'x',
          discovery: 'search',
          query,
        }));
        if (candidates.length) {
          return pickRandom(candidates.slice(0, 5));
        }
      } catch (err) {
        console.warn(`X search discovery "${query}":`, err.message);
        if (/no_live_session|session_not_logged_in|cookie_session_dead/i.test(err.message || '')) {
          throw err;
        }
      }
    }

    // Home timeline fallback
    tried.push('home');
    try {
      const posts = await playwrightService.listXHomePosts(account.id, { limit: 12 });
      const candidates = this.filterUnused(posts, used).map((p) => ({
        subreddit: p.subreddit || 'x:home',
        title: p.title || 'X post',
        selftext: (p.selftext || p.title || '').slice(0, 1200),
        post_url: p.post_url,
        score: 0,
        num_comments: 0,
        fit: 0.9,
        platform: 'x',
        discovery: 'home',
      }));
      if (candidates.length) {
        return pickRandom(candidates.slice(0, 5));
      }
    } catch (err) {
      console.warn('X home discovery:', err.message);
      if (/no_live_session|session_not_logged_in|cookie_session_dead/i.test(err.message || '')) {
        throw err;
      }
    }

    throw new Error(`No commentable X posts (tried: ${tried.join(', ')})`);
  }

  async findInstagramThread(account, used) {
    const posts = await playwrightService.listInstagramExplorePosts(account.id, { limit: 10 });
    const candidates = this.filterUnused(posts, used).map((p) => ({
      subreddit: p.subreddit || 'instagram:feed',
      title: p.title || 'Instagram post',
      selftext: '',
      post_url: p.post_url,
      score: 0,
      num_comments: 0,
      fit: 1,
      platform: 'instagram',
    }));
    if (!candidates.length) throw new Error('No commentable Instagram posts');
    return pickRandom(candidates.slice(0, 5));
  }

  async findCommentableThread(account) {
    const used = await this.getUsedPostUrls();
    const platform = String(account.platform || '').toLowerCase();

    switch (platform) {
      case 'reddit':
        return this.findRedditThread(account, used);
      case 'linkedin':
        return this.findLinkedInThread(account, used);
      case 'x':
      case 'twitter':
        return this.findXThread(account, used);
      case 'instagram':
        return this.findInstagramThread(account, used);
      default:
        throw new Error(`Organic discovery not supported for platform: ${platform}`);
    }
  }
}

module.exports = new OrganicDiscoveryService();
module.exports.ORGANIC_PLATFORMS = ORGANIC_PLATFORMS;
module.exports.X_TOPIC_PACKS = X_TOPIC_PACKS;
