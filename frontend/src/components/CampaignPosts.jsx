import React, { useState, useEffect } from 'react';
import api from '../utils/api';

const PostRow = ({ post, onUpdateStatus, onDelete, expanded, onToggleExpand }) => {
  const isDraft = post.status === 'draft';
  const isApproved = post.status === 'approved';

  return (
    <div className={`rounded-lg border text-sm ${
      isApproved ? 'border-emerald-200 bg-emerald-50/50' :
      post.status === 'rejected' ? 'border-red-100 bg-red-50/30 opacity-60' :
      isDraft ? 'border-amber-200/80 bg-white' :
      'border-gray-100 bg-white'
    }`}>
      <div className="flex items-start gap-2 p-2.5">
        <button type="button" onClick={onToggleExpand} className="flex-1 min-w-0 text-left">
          <div className="flex items-center gap-1.5 mb-1">
            {post.subreddit && (
              <span className="text-[10px] font-semibold text-whisper-700 bg-whisper-100 px-1.5 py-0.5 rounded">r/{post.subreddit}</span>
            )}
            {isApproved && <span className="text-[10px] text-emerald-700 font-medium">✓ approved</span>}
            {isDraft && <span className="text-[10px] text-amber-700 font-medium">draft</span>}
          </div>
          <p className={`text-xs text-gray-700 leading-relaxed ${expanded ? 'whitespace-pre-wrap' : 'line-clamp-2'}`}>
            {post.content}
          </p>
        </button>
        <div className="flex flex-col gap-1 flex-shrink-0">
          {isDraft && (
            <>
              <button onClick={() => onUpdateStatus(post.id, 'approved')} className="p-1.5 rounded-md bg-emerald-500 text-white hover:bg-emerald-600" title="Approve">
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" /></svg>
              </button>
              <button onClick={() => onUpdateStatus(post.id, 'rejected')} className="p-1.5 rounded-md border border-red-200 text-red-500 hover:bg-red-50" title="Reject">
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
              </button>
              <button onClick={() => onDelete(post.id)} className="p-1.5 rounded-md text-gray-400 hover:text-red-600 hover:bg-red-50" title="Delete">
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
              </button>
            </>
          )}
          {isApproved && (
            <button onClick={() => onUpdateStatus(post.id, 'draft')} className="text-[10px] text-emerald-700 px-1">Undo</button>
          )}
        </div>
      </div>
    </div>
  );
};

const CampaignPosts = ({ campaignId, embedded = false, onCountsChange }) => {
  const [posts, setPosts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState(null);
  const [generateCount, setGenerateCount] = useState(3);
  const [expandedId, setExpandedId] = useState(null);
  const [showRejected, setShowRejected] = useState(false);

  const approved = posts.filter(p => p.status === 'approved');
  const drafts = posts.filter(p => p.status === 'draft');
  const rejected = posts.filter(p => p.status === 'rejected');

  useEffect(() => {
    fetchPosts();
    const interval = setInterval(fetchPosts, embedded ? 12000 : 10000);
    return () => clearInterval(interval);
  }, [campaignId, embedded]);

  const fetchPosts = async () => {
    try {
      const { data } = await api.get(`/api/campaigns/${campaignId}/posts/list`);
      setPosts(Array.isArray(data) ? data : []);
      setLoading(false);
      onCountsChange?.();
    } catch (err) {
      setError(err.response?.data?.error || err.message);
      setLoading(false);
    }
  };

  const generatePosts = async () => {
    try {
      setGenerating(true);
      setError(null);
      const { data } = await api.post(
        `/api/campaigns/${campaignId}/posts/generate`,
        { count: generateCount },
        { timeout: 300000 }
      );
      if (data.all) setPosts(data.all);
      else await fetchPosts();
      onCountsChange?.();
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setGenerating(false);
    }
  };

  const updatePostStatus = async (postId, status) => {
    try {
      setError(null);
      const { data } = await api.patch(`/api/campaigns/${campaignId}/posts/${postId}/status`, { status });
      setPosts(prev => prev.map(p => p.id === postId ? { ...p, ...data } : p));
      onCountsChange?.();
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    }
  };

  const handleDeletePost = async (postId) => {
    try {
      await api.delete(`/api/campaigns/${campaignId}/posts/${postId}`);
      setPosts(prev => prev.filter(p => p.id !== postId));
      onCountsChange?.();
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    }
  };

  if (loading) {
    return <div className="flex justify-center py-8"><div className="animate-spin rounded-full h-6 w-6 border-2 border-whisper-400 border-t-transparent" /></div>;
  }

  return (
    <div className={embedded ? 'space-y-3' : 'space-y-6'}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className={`font-semibold text-gray-900 ${embedded ? 'text-sm' : 'section-header mb-0'}`}>
          Posts {approved.length > 0 && <span className="text-emerald-600 font-normal">({approved.length} approved)</span>}
        </h3>
        <div className="flex items-center gap-1.5">
          <select value={generateCount} onChange={(e) => setGenerateCount(parseInt(e.target.value))} className="input-field text-xs w-14 py-1.5">
            {[1, 2, 3, 5].map(n => <option key={n} value={n}>{n}</option>)}
          </select>
          <button onClick={generatePosts} disabled={generating} className="btn-primary text-xs px-2.5 py-1.5 whitespace-nowrap">
            {generating ? '…' : 'Generate drafts'}
          </button>
        </div>
      </div>

      {error && <p className="text-xs text-red-600 bg-red-50 px-2 py-1.5 rounded-lg">{error}</p>}

      {approved.length > 0 && (
        <div className="space-y-1">
          <p className="text-[10px] font-semibold text-emerald-700 uppercase tracking-wide">Approved</p>
          {approved.map(post => (
            <PostRow
              key={post.id}
              post={post}
              onUpdateStatus={updatePostStatus}
              onDelete={handleDeletePost}
              expanded={expandedId === post.id}
              onToggleExpand={() => setExpandedId(expandedId === post.id ? null : post.id)}
            />
          ))}
        </div>
      )}

      <div className="space-y-1">
        <p className="text-[10px] font-semibold text-gray-500 uppercase tracking-wide">
          Drafts {drafts.length > 0 && `(${drafts.length})`}
        </p>
        {drafts.length === 0 ? (
          <p className="text-xs text-gray-400 py-4 text-center">
            {posts.length === 0 ? 'Generate drafts for your approved subreddits' : 'No pending drafts'}
          </p>
        ) : (
          drafts.map(post => (
            <PostRow
              key={post.id}
              post={post}
              onUpdateStatus={updatePostStatus}
              onDelete={handleDeletePost}
              expanded={expandedId === post.id}
              onToggleExpand={() => setExpandedId(expandedId === post.id ? null : post.id)}
            />
          ))
        )}
      </div>

      {rejected.length > 0 && (
        <>
          <button onClick={() => setShowRejected(v => !v)} className="text-xs text-gray-400 hover:text-gray-600">
            {showRejected ? '▼' : '▶'} Rejected ({rejected.length})
          </button>
          {showRejected && rejected.map(post => (
            <PostRow key={post.id} post={post} onUpdateStatus={updatePostStatus} onDelete={handleDeletePost} expanded={false} onToggleExpand={() => {}} />
          ))}
        </>
      )}
    </div>
  );
};

export default CampaignPosts;
