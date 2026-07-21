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

  async findXThread(account, used) {
    const posts = await playwrightService.listXHomePosts(account.id, { limit: 12 });
    const candidates = this.filterUnused(posts, used).map((p) => ({
      subreddit: p.subreddit || 'x:home',
      title: p.title || 'X post',
      selftext: (p.selftext || p.title || '').slice(0, 1200),
      post_url: p.post_url,
      score: 0,
      num_comments: 0,
      fit: 1,
      platform: 'x',
    }));
    if (!candidates.length) throw new Error('No commentable X home posts');
    return pickRandom(candidates.slice(0, 5));
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
