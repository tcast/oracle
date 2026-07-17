import React, { useState } from 'react';
import OrganicCommentsPanel from './OrganicCommentsPanel';
import XFollowPanel from './XFollowPanel';

const OrganicActivity = () => {
  const [tab, setTab] = useState('reddit');

  return (
    <div className="space-y-4">
      <div className="flex gap-2 border-b border-gray-200">
        <button
          type="button"
          onClick={() => setTab('reddit')}
          className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px ${
            tab === 'reddit'
              ? 'border-whisper-600 text-whisper-800'
              : 'border-transparent text-gray-500 hover:text-gray-800'
          }`}
        >
          Reddit comments
        </button>
        <button
          type="button"
          onClick={() => setTab('x')}
          className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px ${
            tab === 'x'
              ? 'border-whisper-600 text-whisper-800'
              : 'border-transparent text-gray-500 hover:text-gray-800'
          }`}
        >
          X following
        </button>
      </div>
      {tab === 'reddit' ? <OrganicCommentsPanel standalone /> : <XFollowPanel />}
    </div>
  );
};

export default OrganicActivity;
