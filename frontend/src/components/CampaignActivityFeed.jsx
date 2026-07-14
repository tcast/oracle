import React, { useState, useEffect } from 'react';
import api from '../utils/api';

const CommentNode = ({ comment, depth = 0 }) => (
  <div className={depth ? 'ml-3 mt-1.5 border-l border-gray-100 pl-2' : 'mt-1.5'}>
    <p className="text-xs text-gray-700 whitespace-pre-wrap">{comment.content}</p>
    <p className="text-[10px] text-gray-400 mt-0.5">
      {comment.commented_by || 'anon'} · {comment.status}
      {comment.posted_at ? ` · ${new Date(comment.posted_at).toLocaleString()}` : ''}
    </p>
    {(comment.replies || []).map(r => (
      <CommentNode key={r.id} comment={r} depth={depth + 1} />
    ))}
  </div>
);

const flattenPlatformPosts = (organized) => {
  const out = [];
  if (!organized || typeof organized !== 'object') return out;
  for (const [platform, value] of Object.entries(organized)) {
    if (Array.isArray(value)) {
      value.forEach(p => out.push({ ...p, platform }));
    } else if (value && typeof value === 'object') {
      for (const [sub, posts] of Object.entries(value)) {
        (posts || []).forEach(p => out.push({ ...p, platform, subreddit: p.subreddit || sub }));
      }
    }
  }
  return out
    .filter(p => ['simulated', 'posted', 'publishing'].includes(p.status))
    .sort((a, b) => new Date(b.posted_at || 0) - new Date(a.posted_at || 0));
};

const CampaignActivityFeed = ({ campaignId }) => {
  const [posts, setPosts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [expandedId, setExpandedId] = useState(null);

  const fetchFeed = async () => {
    try {
      const { data } = await api.get(`/api/campaigns/${campaignId}/posts`);
      setPosts(flattenPlatformPosts(data));
      setError(null);
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchFeed();
    const interval = setInterval(fetchFeed, 8000);
    return () => clearInterval(interval);
  }, [campaignId]);

  if (loading) {
    return <div className="card p-5 text-sm text-gray-500">Loading activity…</div>;
  }

  return (
    <div className="card p-5 space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-gray-900">Activity feed</h3>
          <p className="text-xs text-gray-500">Simulated &amp; live posts with comment threads</p>
        </div>
        <button onClick={fetchFeed} className="text-xs text-whisper-700 hover:underline">Refresh</button>
      </div>

      {error && <p className="text-xs text-red-600 bg-red-50 px-2 py-1.5 rounded-lg">{error}</p>}

      {posts.length === 0 ? (
        <p className="text-xs text-gray-400 py-6 text-center">No simulated/posted activity yet — start a run on Launch</p>
      ) : (
        <div className="space-y-2 max-h-96 overflow-y-auto">
          {posts.slice(0, 40).map(post => {
            const expanded = expandedId === post.id;
            return (
              <div key={post.id} className="rounded-lg border border-gray-100 p-2.5 text-sm">
                <button type="button" onClick={() => setExpandedId(expanded ? null : post.id)} className="w-full text-left">
                  <div className="flex items-center gap-1.5 mb-1">
                    {post.subreddit && (
                      <span className="text-[10px] font-semibold text-whisper-700 bg-whisper-100 px-1.5 py-0.5 rounded">
                        r/{post.subreddit}
                      </span>
                    )}
                    <span className="text-[10px] text-gray-500">{post.status}</span>
                    <span className="text-[10px] text-gray-400">{post.posted_by}</span>
                    <span className="text-[10px] text-gray-400 ml-auto">
                      {(post.comments || []).length} comments
                    </span>
                  </div>
                  <p className={`text-xs text-gray-700 ${expanded ? 'whitespace-pre-wrap' : 'line-clamp-2'}`}>
                    {post.content || post.caption}
                  </p>
                </button>
                {expanded && (post.comments || []).length > 0 && (
                  <div className="mt-2 pt-2 border-t border-gray-50">
                    {post.comments.map(c => <CommentNode key={c.id} comment={c} />)}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

export default CampaignActivityFeed;
