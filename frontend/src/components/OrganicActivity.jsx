import React, { useState } from 'react';
import OrganicCommentsPanel from './OrganicCommentsPanel';
import XFollowPanel from './XFollowPanel';
import SocialWarmPanel from './SocialWarmPanel';

const OrganicActivity = () => {
  const [tab, setTab] = useState('reddit');

  const tabs = [
    { id: 'reddit', label: 'Reddit comments' },
    { id: 'x', label: 'X following' },
    { id: 'warm', label: 'IG / TikTok warm' },
  ];

  return (
    <div className="space-y-4">
      <div className="flex gap-2 border-b border-gray-200">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px ${
              tab === t.id
                ? 'border-whisper-600 text-whisper-800'
                : 'border-transparent text-gray-500 hover:text-gray-800'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>
      {tab === 'reddit' && <OrganicCommentsPanel standalone />}
      {tab === 'x' && <XFollowPanel />}
      {tab === 'warm' && <SocialWarmPanel />}
    </div>
  );
};

export default OrganicActivity;
