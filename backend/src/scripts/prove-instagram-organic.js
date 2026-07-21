#!/usr/bin/env node
/**
 * Prove one Instagram organic comment.
 * Usage: node src/scripts/prove-instagram-organic.js [accountId]
 */
require('dotenv').config();
const pool = require('../services/db');
const playwrightService = require('../services/playwrightService');
const organicCommentService = require('../services/organicCommentService');

async function main() {
  const accountId = Number(process.argv[2] || 73);
  try {
    const posts = await playwrightService.listInstagramExplorePosts(accountId, { limit: 8 });
    console.log('POSTS=' + JSON.stringify(posts.slice(0, 5)));
    if (!posts.length) throw new Error('no instagram posts');

    const target = posts[0];
    const comment = 'Love this — what inspired the shot?';
    const platformCommentId = await playwrightService.postComment(
      'instagram',
      accountId,
      target.post_url,
      comment,
      null,
      { requireProxy: true, allowLogin: false }
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
          'instagram:feed',
          `${target.post_url}?organic_proof=${Date.now()}`,
          target.title || 'ig',
          comment,
          String(platformCommentId),
        ]
      );
      await organicCommentService.setAccountEnabled(accountId, true);
    }
    process.exit(platformCommentId ? 0 : 2);
  } catch (err) {
    console.error('ERR', err.stack || err.message);
    process.exit(1);
  } finally {
    await pool.end().catch(() => {});
  }
}

main();
