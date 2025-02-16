import React, { useState, useEffect } from 'react';

const Comment = ({ comment, depth = 0 }) => (
  <div className={`ml-${depth * 8} my-2`}>
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
      <div className="mt-2">
        {comment.replies.map(reply => (
          <Comment key={reply.id} comment={reply} depth={depth + 1} />
        ))}
      </div>
    )}
  </div>
);

const Post = ({ post, campaignId, onDelete }) => (
  <div className="border rounded-lg p-4 mb-4">
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
    <div className="mt-4 space-y-2">
      {post.comments && post.comments.map(comment => (
        <Comment key={comment.id} comment={comment} />
      ))}
    </div>
  </div>
);

const CampaignPosts = ({ campaignId }) => {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [posts, setPosts] = useState({});
  const [deleteError, setDeleteError] = useState(null);

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
      
      // Refresh the posts list
      await fetchPosts();
    } catch (err) {
      console.error('Error deleting post:', err);
      setDeleteError(err.message);
    }
  };

  if (loading) {
    return <div className="text-center py-4">Loading posts...</div>;
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
        <div key={platform} className="bg-white shadow rounded-lg p-6">
          <h3 className="text-lg font-medium mb-4 capitalize">{platform} Posts</h3>
          
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
      ))}
    </div>
  );
};

export default CampaignPosts;