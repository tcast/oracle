#!/usr/bin/env node
require('dotenv').config();
const ps = require('../services/playwrightService');
const ocs = require('../services/organicCommentService');
const pool = require('../services/db');

(async () => {
  const accountId = Number(process.argv[2] || 278);
  console.log('createLinkedInPost', accountId);
  const content =
    'Been thinking about how noisy hiring pipelines get when every resume is AI-polished. Curious what signals others still trust.';
  const id = await ps.createLinkedInPost(accountId, content);
  console.log('POST_RESULT=' + JSON.stringify({ id }));
  if (id) {
    await ocs.setAccountEnabled(accountId, true);
    await pool.query(
      `INSERT INTO organic_comments
         (social_account_id, subreddit, post_url, post_title, content, status, platform_comment_id)
       VALUES ($1,$2,$3,$4,$5,'posted',$6)`,
      [
        accountId,
        'linkedin:post',
        `https://www.linkedin.com/feed/?proof=${Date.now()}`,
        'self post',
        content,
        String(id === true ? `li-post-${Date.now()}` : id),
      ]
    );
  }
  await pool.end().catch(() => {});
  process.exit(id ? 0 : 2);
})().catch(async (e) => {
  console.error('ERR', e.stack || e.message);
  await pool.end().catch(() => {});
  process.exit(1);
});
