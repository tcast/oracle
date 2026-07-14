import React, { useState, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../utils/api';

const EXAMPLE_PROMPTS = [
  'Reddit waitlist campaign for jockbroker.com — fantasy sports with owned player cards',
  'Launch campaign for a B2B SaaS product targeting startup founders on LinkedIn',
  'TikTok awareness campaign for a new fitness app, Gen Z audience',
];

const INITIAL_MESSAGE = {
  id: 1,
  role: 'assistant',
  content: `Tell me what you want to promote — paste a URL, describe the goal, or both. I'll research the site, pull assets, and draft a full campaign for you.`,
};

const ResearchCard = ({ item }) => (
  <div className="bg-gray-50 border border-gray-200 rounded-lg p-3 text-sm">
    <div className="flex items-start gap-3">
      {item.assets?.[0]?.url && (
        <img
          src={item.assets[0].url}
          alt=""
          className="w-10 h-10 rounded object-cover flex-shrink-0 bg-gray-100"
          onError={(e) => { e.target.style.display = 'none'; }}
        />
      )}
      <div className="min-w-0 flex-1">
        <p className="font-medium text-gray-900 truncate">{item.title || item.url}</p>
        <a href={item.url} target="_blank" rel="noopener noreferrer" className="text-xs text-whisper-600 hover:underline truncate block">
          {item.url}
        </a>
        {item.description && <p className="text-xs text-gray-500 mt-1 line-clamp-2">{item.description}</p>}
        {item.error && <p className="text-xs text-amber-600 mt-1">Partial fetch: {item.error}</p>}
      </div>
    </div>
  </div>
);

const DraftPreview = ({ draft, onChange, brands }) => {
  if (!draft) return null;
  const update = (field, value) => onChange({ ...draft, [field]: value });

  return (
    <div className="space-y-3">
      <div>
        <label className="label">Brand</label>
        <select
          className="input-field"
          value={draft.brand_id || ''}
          onChange={(e) => update('brand_id', e.target.value ? parseInt(e.target.value) : null)}
        >
          <option value="">Select brand…</option>
          {(brands || []).map((b) => (
            <option key={b.id} value={b.id}>{b.name}</option>
          ))}
        </select>
        <p className="text-xs text-gray-500 mt-1">Creates a Whisper (army) campaign. Use Brand Campaigns for overt + ads.</p>
      </div>
      <div>
        <label className="label">Campaign Name</label>
        <input className="input-field" value={draft.name || ''} onChange={(e) => update('name', e.target.value)} />
      </div>
      <div>
        <label className="label">Overview</label>
        <textarea className="input-field" rows={4} value={draft.campaign_overview || ''} onChange={(e) => update('campaign_overview', e.target.value)} />
      </div>
      <div>
        <label className="label">Goal</label>
        <textarea className="input-field" rows={2} value={draft.campaign_goal || ''} onChange={(e) => update('campaign_goal', e.target.value)} />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="label">Posts</label>
          <input type="number" className="input-field" value={draft.post_goal || 10} onChange={(e) => update('post_goal', parseInt(e.target.value) || 10)} />
        </div>
        <div>
          <label className="label">Comments</label>
          <input type="number" className="input-field" value={draft.comment_goal || 5} onChange={(e) => update('comment_goal', parseInt(e.target.value) || 5)} />
        </div>
      </div>
      <div>
        <label className="label">Target URL</label>
        <input className="input-field" value={draft.target_url || ''} onChange={(e) => update('target_url', e.target.value)} />
      </div>
      {draft.suggested_subreddits?.length > 0 && (
        <div>
          <label className="label">Subreddits</label>
          <div className="flex flex-wrap gap-1.5">
            {draft.suggested_subreddits.map(s => (
              <span key={s} className="badge-info">r/{s.replace(/^r\//, '')}</span>
            ))}
          </div>
        </div>
      )}
      {draft.sample_posts?.length > 0 && (
        <div>
          <label className="label">Sample Posts</label>
          <div className="space-y-2">
            {draft.sample_posts.map((post, i) => (
              <div key={i} className="text-xs bg-gray-50 rounded-lg p-2.5 text-gray-700 border border-gray-100 leading-relaxed">{post}</div>
            ))}
          </div>
        </div>
      )}
      {draft.media_assets?.length > 0 && (
        <div>
          <label className="label">Assets</label>
          <div className="flex flex-wrap gap-2">
            {draft.media_assets.map((asset, i) => (
              <a key={i} href={asset.url} target="_blank" rel="noopener noreferrer">
                <img src={asset.url} alt={asset.label || 'asset'} className="h-14 w-14 object-cover rounded-lg border border-gray-200" onError={(e) => { e.target.parentElement.style.display = 'none'; }} />
              </a>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

const ChatCampaignCreator = () => {
  const navigate = useNavigate();
  const [messages, setMessages] = useState([INITIAL_MESSAGE]);
  const [inputValue, setInputValue] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [research, setResearch] = useState([]);
  const [campaignDraft, setCampaignDraft] = useState(null);
  const [brands, setBrands] = useState([]);
  const [status, setStatus] = useState('gathering');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState(null);
  const chatEndRef = useRef(null);
  const textareaRef = useRef(null);

  const showExamples = messages.length === 1 && !isLoading;

  useEffect(() => {
    (async () => {
      try {
        const { data } = await api.get('/api/brands');
        setBrands(data);
      } catch (_) { /* ignore */ }
    })();
  }, []);

  useEffect(() => {
    if (!brands.length) return;
    setCampaignDraft((d) => {
      if (!d || d.brand_id) return d;
      return {
        ...d,
        brand_id: brands[0].id,
        whisper_enabled: d.whisper_enabled !== false,
        overt_enabled: !!d.overt_enabled,
        ads_enabled: !!d.ads_enabled,
        overt_platforms: d.overt_platforms || [],
      };
    });
  }, [brands]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isLoading]);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [inputValue]);

  const sendMessage = async (text) => {
    if (!text.trim() || isLoading) return;

    const userMessage = { id: Date.now(), role: 'user', content: text.trim() };
    const nextMessages = [...messages, userMessage];
    setMessages(nextMessages);
    setInputValue('');
    setIsLoading(true);
    setError(null);

    try {
      const { data } = await api.post('/api/campaign-builder/chat', {
        messages: nextMessages.map(({ role, content }) => ({ role, content })),
      });

      setMessages(prev => [...prev, { id: Date.now() + 1, role: 'assistant', content: data.reply }]);
      if (data.research?.length) setResearch(data.research);
      if (data.campaignDraft) {
        setCampaignDraft((prev) => ({
          whisper_enabled: true,
          overt_enabled: false,
          ads_enabled: false,
          overt_platforms: [],
          brand_id: prev?.brand_id || brands[0]?.id || null,
          ...data.campaignDraft,
          brand_id: data.campaignDraft.brand_id || prev?.brand_id || brands[0]?.id || null,
        }));
      }
      setStatus(data.status || 'gathering');
    } catch (err) {
      const msg = err.response?.data?.error || err.message || 'Something went wrong';
      setError(msg);
      setMessages(prev => [...prev, { id: Date.now() + 1, role: 'assistant', content: `Error: ${msg}` }]);
    } finally {
      setIsLoading(false);
    }
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    sendMessage(inputValue);
  };

  const handleCreate = async () => {
    if (!campaignDraft) return;
    if (!campaignDraft.brand_id) {
      setError('Select a brand before creating the campaign');
      return;
    }
    setCreating(true);
    setError(null);
    try {
      const { data } = await api.post('/api/campaign-builder/create', campaignDraft);
      navigate(`/campaigns/${data.id}`);
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="flex flex-col h-full min-h-0 bg-white">
      {/* Header */}
      <header className="flex-shrink-0 flex items-center justify-between gap-4 px-5 py-3 border-b border-gray-200 bg-white">
        <div className="flex items-center gap-3 min-w-0">
          <button onClick={() => navigate('/')} className="text-gray-400 hover:text-gray-700 p-1.5 rounded-lg hover:bg-gray-100 flex-shrink-0">
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
            </svg>
          </button>
          <div className="min-w-0">
            <h1 className="text-base font-semibold text-gray-900 truncate">AI Campaign Builder</h1>
            <p className="text-xs text-gray-500 truncate">Research sites, draft campaigns, launch</p>
          </div>
        </div>
        {status === 'ready' && campaignDraft && (
          <button onClick={handleCreate} disabled={creating} className="btn-primary text-sm px-4 py-2 flex-shrink-0">
            {creating ? 'Creating…' : 'Create Campaign'}
          </button>
        )}
      </header>

      {/* Body */}
      <div className="flex flex-1 min-h-0">
        {/* Chat */}
        <div className="flex-1 flex flex-col min-w-0 min-h-0">
          <div className="flex-1 min-h-0 overflow-y-auto">
            <div className="max-w-3xl mx-auto px-4 sm:px-6 py-6 space-y-4">
              {messages.map((message) => (
                <div key={message.id} className={`flex ${message.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                  <div className={`max-w-[90%] rounded-2xl px-4 py-3 text-sm leading-relaxed ${
                    message.role === 'user'
                      ? 'bg-whisper-600 text-white rounded-br-sm'
                      : 'bg-gray-100 text-gray-800 rounded-bl-sm'
                  }`}>
                    <p className="whitespace-pre-wrap">{message.content}</p>
                  </div>
                </div>
              ))}

              {showExamples && (
                <div className="pt-2 space-y-2">
                  <p className="text-xs font-medium text-gray-400 uppercase tracking-wide">Try an example</p>
                  <div className="flex flex-col gap-2">
                    {EXAMPLE_PROMPTS.map((prompt) => (
                      <button
                        key={prompt}
                        type="button"
                        onClick={() => sendMessage(prompt)}
                        className="text-left text-sm px-4 py-3 rounded-xl border border-gray-200 bg-white hover:border-whisper-300 hover:bg-whisper-50/50 text-gray-700 transition-colors"
                      >
                        {prompt}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {isLoading && (
                <div className="flex justify-start">
                  <div className="bg-gray-100 rounded-2xl rounded-bl-sm px-4 py-3">
                    <div className="flex items-center gap-2.5 text-sm text-gray-500">
                      <div className="flex gap-1">
                        <span className="w-1.5 h-1.5 bg-whisper-400 rounded-full animate-bounce" />
                        <span className="w-1.5 h-1.5 bg-whisper-400 rounded-full animate-bounce [animation-delay:0.15s]" />
                        <span className="w-1.5 h-1.5 bg-whisper-400 rounded-full animate-bounce [animation-delay:0.3s]" />
                      </div>
                      Researching and drafting…
                    </div>
                  </div>
                </div>
              )}
              <div ref={chatEndRef} />
            </div>
          </div>

          {/* Input — pinned to bottom */}
          <div className="flex-shrink-0 border-t border-gray-200 bg-white px-4 sm:px-6 py-3">
            {error && (
              <div className="max-w-3xl mx-auto mb-2">
                <div className="bg-red-50 border border-red-200 text-red-700 text-sm px-3 py-2 rounded-lg">{error}</div>
              </div>
            )}

            {campaignDraft && (
              <div className="lg:hidden max-w-3xl mx-auto mb-2 p-3 rounded-lg bg-whisper-50 border border-whisper-100">
                <p className="text-xs font-semibold text-whisper-700">
                  Draft: {campaignDraft.name} {status === 'ready' && '· ready to create'}
                </p>
              </div>
            )}

            <form onSubmit={handleSubmit} className="max-w-3xl mx-auto">
              <div className="flex gap-2 items-end rounded-xl border border-gray-300 bg-white focus-within:ring-2 focus-within:ring-whisper-500 focus-within:border-whisper-500 px-3 py-2">
                <textarea
                  ref={textareaRef}
                  value={inputValue}
                  onChange={(e) => setInputValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      handleSubmit(e);
                    }
                  }}
                  placeholder="Describe your campaign or paste a URL…"
                  rows={1}
                  className="flex-1 resize-none border-0 focus:ring-0 focus:outline-none text-sm leading-relaxed py-1.5 max-h-40 bg-transparent"
                  disabled={isLoading}
                />
                <button
                  type="submit"
                  disabled={!inputValue.trim() || isLoading}
                  className="flex-shrink-0 p-2 rounded-lg bg-whisper-600 text-white hover:bg-whisper-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                  title="Send"
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 12h14M12 5l7 7-7 7" />
                  </svg>
                </button>
              </div>
            </form>
          </div>
        </div>

        {/* Side panel */}
        <aside className="hidden lg:flex lg:w-80 xl:w-96 flex-col min-h-0 border-l border-gray-200 bg-gray-50/50">
          <div className="flex-shrink-0 px-4 py-3 border-b border-gray-200 bg-white">
            <h2 className="text-sm font-semibold text-gray-900">Research & Draft</h2>
          </div>
          <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4">
            <section>
              <h3 className="text-xs font-medium text-gray-400 uppercase tracking-wide mb-2">Sites researched</h3>
              {research.length === 0 ? (
                <p className="text-sm text-gray-400">URLs you mention will appear here.</p>
              ) : (
                <div className="space-y-2">
                  {research.map(r => <ResearchCard key={r.url} item={r} />)}
                </div>
              )}
            </section>

            {campaignDraft && (
              <section>
                <h3 className="text-xs font-medium text-gray-400 uppercase tracking-wide mb-2">
                  Campaign draft {status === 'ready' && <span className="text-emerald-600 normal-case">· ready</span>}
                </h3>
                <DraftPreview draft={campaignDraft} onChange={setCampaignDraft} brands={brands} />
              </section>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
};

export default ChatCampaignCreator;
