import React, { useState, useEffect } from 'react';
import api from '../utils/api';

const INITIAL_COMMENTS_TO_SHOW = 3;

const Comment = ({ comment, depth = 0 }) => {
  const [showReplies, setShowReplies] = useState(depth < 2);
  return (
    <div className={`ml-${Math.min(depth, 5) * 4} my-2`}>
      <div className="bg-gray-50 p-3 rounded-xl border border-gray-100">
        <p className="text-sm text-gray-900">{comment.content}</p>
        <div className="mt-1.5 text-xs text-gray-400 flex items-center flex-wrap gap-x-2">
          <span className="font-medium text-gray-500">by {comment.commented_by}</span>
          <span>•</span>
          <span>{new Date(comment.posted_at).toLocaleString()}</span>
          <span>•</span>
          <span>{comment.engagement_metrics?.upvotes || 0} upvotes</span>
        </div>
      </div>
      {comment.replies && comment.replies.length > 0 && (
        <div className="ml-4 mt-1">
          <button
            onClick={() => setShowReplies(!showReplies)}
            className="text-sm text-oracle-600 hover:text-oracle-700 font-medium"
          >
            {showReplies ? 'Hide' : 'Show'} {comment.replies.length} {comment.replies.length === 1 ? 'reply' : 'replies'}
          </button>
          {showReplies && (
            <div className="mt-2 space-y-1">
              {comment.replies.map(reply => (
                <Comment key={reply.id} comment={reply} depth={depth + 1} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

const Post = ({ post, campaignId, onDelete }) => {
  const [showAllComments, setShowAllComments] = useState(false);
  const visibleComments = showAllComments ? post.comments : post.comments?.slice(0, INITIAL_COMMENTS_TO_SHOW);
  const hasMoreComments = post.comments?.length > INITIAL_COMMENTS_TO_SHOW;

  const renderContent = () => {
    if (post.platform === 'tiktok') {
      const videoUrl = post.video_url?.startsWith('http') ? post.video_url : `${window.location.origin}${post.video_url}`;
      return (
        <div className="space-y-2">
          <div className="max-w-[300px] mx-auto aspect-[9/16] bg-black rounded-xl overflow-hidden">
            <video src={videoUrl} controls preload="metadata" playsInline className="w-full h-full object-contain" poster="/tiktok-placeholder.jpg">
              Your browser does not support the video tag.
            </video>
          </div>
          <p className="text-gray-900">{post.caption}</p>
        </div>
      );
    }
    return <p className="text-gray-900">{post.content}</p>;
  };

  return (
    <div className="border border-gray-100 rounded-xl p-5 mb-4 bg-white shadow-sm hover:shadow-md transition-shadow">
      <div className="flex justify-between items-start gap-4">
        <div className="flex-1 min-w-0">{renderContent()}</div>
        <button
          onClick={() => onDelete(post.id)}
          className="flex-shrink-0 px-3 py-1.5 text-xs font-medium text-red-600 hover:text-white hover:bg-red-600 rounded-lg border border-red-200 hover:border-red-600 transition-all"
        >
          Delete
        </button>
      </div>
      <div className="mt-3 text-xs text-gray-400 flex items-center flex-wrap gap-x-2">
        <span className="font-medium text-gray-500">by {post.posted_by}</span>
        <span>•</span>
        <span>{new Date(post.posted_at).toLocaleString()}</span>
        <span>•</span>
        {post.platform === 'tiktok' ? (
          <>
            <span>{post.engagement_metrics?.likes || 0} likes</span>
            <span>•</span>
            <span>{post.engagement_metrics?.shares || 0} shares</span>
          </>
        ) : (
          <span>{post.engagement_metrics?.upvotes || 0} upvotes</span>
        )}
        <span>•</span>
        <span>{post.comments?.length || 0} comments</span>
      </div>
      {post.comments && post.comments.length > 0 && (
        <div className="mt-4 pt-4 border-t border-gray-100 space-y-2">
          {visibleComments.map(comment => (
            <Comment key={comment.id} comment={comment} />
          ))}
          {!showAllComments && hasMoreComments && (
            <button
              onClick={() => setShowAllComments(true)}
              className="text-sm text-oracle-600 hover:text-oracle-700 font-medium"
            >
              View {post.comments.length - INITIAL_COMMENTS_TO_SHOW} more comments
            </button>
          )}
        </div>
      )}
    </div>
  );
};

const CampaignPosts = ({ campaignId }) => {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [posts, setPosts] = useState({});
  const [deleteError, setDeleteError] = useState(null);
  const [expandedPlatform, setExpandedPlatform] = useState(null);
  const [selectedPlatforms, setSelectedPlatforms] = useState([]);

  useEffect(() => {
    fetchPosts();
    const interval = setInterval(fetchPosts, 5000);
    return () => clearInterval(interval);
  }, [campaignId]);

  const fetchPosts = async () => {
    try {
      const { data: campaignData } = await api.get(`/api/campaigns/${campaignId}`);
      setSelectedPlatforms(campaignData.platform || []);
      const { data } = await api.get(`/api/campaigns/${campaignId}/posts`);
      setPosts(data);
      setLoading(false);
    } catch (err) {
      console.error('Error fetching posts:', err);
      setError(err.response?.data?.error || err.message);
      setLoading(false);
    }
  };

  const handleDeletePost = async (postId) => {
    try {
      setDeleteError(null);
      await api.delete(`/api/campaigns/${campaignId}/posts/${postId}`);
      await fetchPosts();
    } catch (err) {
      console.error('Error deleting post:', err);
      setDeleteError(err.response?.data?.error || err.message);
    }
  };

  if (loading) {
    return <div className="flex justify-center items-center py-8"><div className="animate-spin rounded-full h-8 w-8 border-2 border-oracle-400 border-t-transparent"></div></div>;
  }

  if (error || deleteError) {
    return <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-xl text-sm">{error || deleteError}</div>;
  }

  return (
    <div className="space-y-4">
      <h3 className="section-header">Campaign Posts</h3>
      {selectedPlatforms.map((platform) => {
        const platformData = posts[platform] || (platform === 'reddit' ? {} : []);
        const postCount = platform === 'reddit' ? Object.values(platformData).flat().length : platformData.length;
        const isExpanded = expandedPlatform === platform;

        return (
          <div key={platform} className="rounded-xl border border-gray-100 overflow-hidden">
            <button
              onClick={() => setExpandedPlatform(isExpanded ? null : platform)}
              className="w-full px-5 py-3.5 flex justify-between items-center bg-gray-50/80 hover:bg-gray-100 transition-colors"
            >
              <h4 className="text-sm font-semibold text-gray-900 capitalize">{platform} Posts</h4>
              <div className="flex items-center space-x-2">
                <span className="text-xs text-gray-500">{postCount} posts</span>
                <svg className={`w-4 h-4 text-gray-400 transition-transform ${isExpanded ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                </svg>
              </div>
            </button>
            {isExpanded && postCount > 0 && (
              <div className="p-5 bg-white">
                {platform === 'reddit' ? (
                  Object.entries(platformData).map(([subreddit, subredditPosts]) => (
                    <div key={subreddit} className="mb-6 last:mb-0">
                      <h5 className="text-sm font-semibold text-gray-700 mb-3">r/{subreddit || (subredditPosts[0]?.metadata?.subreddit || 'unknown')}</h5>
                      {subredditPosts.map(post => (
                        <Post key={post.id} post={post} campaignId={campaignId} onDelete={handleDeletePost} />
                      ))}
                    </div>
                  ))
                ) : (
                  platformData.map(post => (
                    <Post key={post.id} post={post} campaignId={campaignId} onDelete={handleDeletePost} />
                  ))
                )}
              </div>
            )}
            {isExpanded && postCount === 0 && (
              <div className="p-5 text-center text-sm text-gray-400">No posts yet</div>
            )}
          </div>
        );
      })}
    </div>
  );
};

export default CampaignPosts;
