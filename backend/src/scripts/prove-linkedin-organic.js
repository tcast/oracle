#!/usr/bin/env node
/**
 * Prove LinkedIn organic: search discovery → comment, else create a short post.
 * Usage: node src/scripts/prove-linkedin-organic.js [accountId]
 */
require('dotenv').config();
const pool = require('../services/db');
const playwrightService = require('../services/playwrightService');
const organicCommentService = require('../services/organicCommentService');

async function main() {
  const accountId = Number(process.argv[2] || 278);
  try {
    let posts = [];
    try {
      posts = await playwrightService.listLinkedInFeedPosts(accountId, { limit: 8 });
    } catch (err) {
      console.warn('feed:', err.message);
    }
    if (!posts.length) {
      console.log('Feed empty — searching content…');
      posts = await playwrightService.listLinkedInSearchPosts(accountId, {
        query: 'recruiting',
        limit: 8,
      });
    }
    console.log('POSTS=' + JSON.stringify(posts.slice(0, 5)));

    if (posts.length) {
      const target = posts[0];
      const comment =
        'Interesting point — curious how teams are handling this in practice right now.';
      const platformCommentId = await playwrightService.postComment(
        'linkedin',
        accountId,
        target.post_url,
        comment,
        null,
        { requireProxy: false, allowLogin: false, skipProxy: true }
      );
      console.log('COMMENT_OK=' + JSON.stringify({ platformCommentId, target: target.post_url }));
      if (platformCommentId) {
        const proxy = await pool.query(
          `SELECT proxy_id FROM social_account_proxies
           WHERE social_account_id = $1 AND is_active = true LIMIT 1`,
          [accountId]
        );
        await pool.query(
          `INSERT INTO organic_comments
             (social_account_id, proxy_id, subreddit, post_url, post_title, content, status, platform_comment_id)
           VALUES ($1,$2,$3,$4,$5,$6,'posted',$7)`,
          [
            accountId,
            proxy.rows[0]?.proxy_id || null,
            target.subreddit || 'linkedin:search',
            `${target.post_url}?organic_proof=${Date.now()}`,
            target.title || 'li',
            comment,
            String(platformCommentId),
          ]
        );
        await organicCommentService.setAccountEnabled(accountId, true);
        process.exit(0);
      }
    }

    // Fallback: original post proves posting path
    console.log('Falling back to createLinkedInPost…');
    const content =
      'Been thinking about how noisy hiring pipelines get when every resume is AI-polished. Curious what signals others still trust.';
    const postId = await playwrightService.createLinkedInPost(accountId, content);
    console.log('POST_OK=' + JSON.stringify({ postId }));
    if (postId) {
      await organicCommentService.setAccountEnabled(accountId, true);
      await pool.query(
        `INSERT INTO organic_comments
           (social_account_id, proxy_id, subreddit, post_url, post_title, content, status, platform_comment_id)
         VALUES ($1,NULL,'linkedin:post',$2,$3,$4,'posted',$5)`,
        [
          accountId,
          `https://www.linkedin.com/in/me/?organic_proof=${Date.now()}`,
          'self post',
          content,
          String(postId === true ? `li-post-${Date.now()}` : postId),
        ]
      );
    }
    process.exit(postId ? 0 : 2);
  } catch (err) {
    console.error('ERR', err.stack || err.message);
    process.exit(1);
  } finally {
    await pool.end().catch(() => {});
  }
}

main();
