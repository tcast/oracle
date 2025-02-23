import React, { useState, useEffect } from 'react';

const INITIAL_COMMENTS_TO_SHOW = 3;

const Comment = ({ comment, depth = 0 }) => {
  const [showReplies, setShowReplies] = useState(depth < 2);
  
  return (
    <div className={`ml-${depth * 4} my-2`}>
      <div className="bg-gray-50 p-3 rounded-lg">
        <div className="text-sm text-gray-900">{comment.content}</div>
        <div className="mt-1 text-xs text-gray-500 flex items-center space-x-2">
          <span>by {comment.commented_by}</span>
          <span>•</span>
          <span>{new Date(comment.posted_at).toLocaleString()}</span>
          <span>•</span>
          <span>{comment.engagement_metrics?.upvotes || 0} upvotes</span>
        </div>
      </div>
      {comment.replies && comment.replies.length > 0 && (
        <>
          <button
            onClick={() => setShowReplies(!showReplies)}
            className="mt-1 text-sm text-indigo-600 hover:text-indigo-800"
          >
            {showReplies ? 'Hide' : 'Show'} {comment.replies.length} {comment.replies.length === 1 ? 'reply' : 'replies'}
          </button>
          {showReplies && (
            <div className="mt-2">
              {comment.replies.map(reply => (
                <Comment key={reply.id} comment={reply} depth={depth + 1} />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
};

const Post = ({ post, campaignId, onDelete }) => {
  const [showAllComments, setShowAllComments] = useState(false);
  
  const visibleComments = showAllComments ? post.comments : post.comments?.slice(0, INITIAL_COMMENTS_TO_SHOW);
  const hasMoreComments = post.comments?.length > INITIAL_COMMENTS_TO_SHOW;

  return (
    <div className="border rounded-lg p-4 mb-4 bg-white shadow-sm hover:shadow-md transition-shadow duration-200">
      <div className="flex justify-between items-start">
        <div className="text-gray-900">{post.content}</div>
        <button
          onClick={() => onDelete(post.id)}
          className="ml-4 px-3 py-1 text-sm text-red-600 hover:text-white hover:bg-red-600 rounded border border-red-600 transition-colors duration-200"
        >
          Delete
        </button>
      </div>
      <div className="mt-2 text-sm text-gray-500 flex items-center space-x-2">
        <span>Posted by {post.posted_by}</span>
        <span>•</span>
        <span>{new Date(post.posted_at).toLocaleString()}</span>
        <span>•</span>
        <span>{post.engagement_metrics?.upvotes || 0} upvotes</span>
        <span>•</span>
        <span>{post.comments?.length || 0} comments</span>
      </div>
      {post.comments && post.comments.length > 0 && (
        <div className="mt-4 space-y-2">
          {visibleComments.map(comment => (
            <Comment key={comment.id} comment={comment} />
          ))}
          {!showAllComments && hasMoreComments && (
            <button
              onClick={() => setShowAllComments(true)}
              className="mt-2 text-sm text-indigo-600 hover:text-indigo-800"
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

  useEffect(() => {
    fetchPosts();
    const interval = setInterval(fetchPosts, 5000); // Update every 5 seconds
    return () => clearInterval(interval);
  }, [campaignId]);

  const fetchPosts = async () => {
    try {
      const response = await fetch(`/api/campaigns/${campaignId}/posts`);
      if (!response.ok) throw new Error('Failed to fetch posts');
      const data = await response.json();
      setPosts(data);
      setLoading(false);
    } catch (err) {
      console.error('Error fetching posts:', err);
      setError(err.message);
      setLoading(false);
    }
  };

  const handleDeletePost = async (postId) => {
    try {
      setDeleteError(null);
      const response = await fetch(`/api/campaigns/${campaignId}/posts/${postId}`, {
        method: 'DELETE',
      });
      
      if (!response.ok) {
        throw new Error('Failed to delete post');
      }
      
      await fetchPosts();
    } catch (err) {
      console.error('Error deleting post:', err);
      setDeleteError(err.message);
    }
  };

  if (loading) {
    return (
      <div className="flex justify-center items-center py-8">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-600"></div>
      </div>
    );
  }

  if (error || deleteError) {
    return (
      <div className="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded">
        {error || deleteError}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {Object.entries(posts).map(([platform, platformData]) => (
        <div key={platform} className="bg-white shadow rounded-lg overflow-hidden">
          <button
            onClick={() => setExpandedPlatform(expandedPlatform === platform ? null : platform)}
            className="w-full px-6 py-4 flex justify-between items-center bg-gray-50 hover:bg-gray-100"
          >
            <h3 className="text-lg font-medium capitalize">{platform} Posts</h3>
            <span className="text-gray-500">
              {platform === 'reddit' 
                ? Object.values(platformData).flat().length 
                : platformData.length} posts
            </span>
          </button>
          
          {expandedPlatform === platform && (
            <div className="p-6">
              {platform === 'reddit' ? (
                Object.entries(platformData).map(([subreddit, subredditPosts]) => (
                  <div key={subreddit} className="mb-6">
                    <h4 className="text-md font-medium mb-3">
                      r/{subreddit || (subredditPosts[0]?.metadata?.subreddit || 'unknown')}
                    </h4>
                    {subredditPosts.map(post => (
                      <Post 
                        key={post.id} 
                        post={post} 
                        campaignId={campaignId}
                        onDelete={handleDeletePost}
                      />
                    ))}
                  </div>
                ))
              ) : (
                platformData.map(post => (
                  <Post 
                    key={post.id} 
                    post={post} 
                    campaignId={campaignId}
                    onDelete={handleDeletePost}
                  />
                ))
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
};

export default CampaignPosts;