import React, { useState, useEffect } from 'react';

const networks = [
  { id: 'reddit', label: 'Reddit', color: 'bg-orange-100 text-orange-700 border-orange-200', icon: 'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z' },
  { id: 'linkedin', label: 'LinkedIn', color: 'bg-sky-100 text-sky-700 border-sky-200', icon: 'M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 01-2.063-2.065 2.064 2.064 0 112.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z' },
  { id: 'x', label: 'X (Twitter)', color: 'bg-gray-100 text-gray-700 border-gray-200', icon: 'M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z' },
  { id: 'tiktok', label: 'TikTok', color: 'bg-pink-100 text-pink-700 border-pink-200', icon: 'M12.525.02c1.31-.02 2.61-.01 3.91-.02.08 1.53.63 3.09 1.75 4.17 1.12 1.11 2.7 1.62 4.24 1.79v4.03c-1.44-.05-2.89-.35-4.2-.97-.57-.26-1.1-.59-1.62-.93-.01 2.92.01 5.84-.02 8.75-.08 1.4-.54 2.79-1.35 3.94-1.31 1.92-3.58 3.17-5.91 3.21-1.43.08-2.86-.31-4.08-1.03-2.02-1.19-3.44-3.37-3.65-5.71-.02-.5-.03-1-.01-1.49.18-1.9 1.12-3.72 2.58-4.96 1.66-1.44 3.98-2.13 6.15-1.72.02 1.48-.04 2.96-.04 4.44-.99-.32-2.15-.23-3.02.37-.63.41-1.11 1.04-1.36 1.75-.21.51-.15 1.07-.14 1.61.24 1.64 1.82 3.02 3.5 2.87 1.12-.01 2.19-.66 2.77-1.61.19-.33.4-.67.41-1.06.1-1.79.06-3.57.07-5.36.01-4.03-.01-8.05.02-12.07z' },
];

const NetworkSelector = ({ onNetworksChange, campaign }) => {
  const [selectedNetworks, setSelectedNetworks] = useState(campaign?.platform || []);

  useEffect(() => {
    if (campaign?.platform) {
      setSelectedNetworks(campaign.platform);
      onNetworksChange(campaign.platform);
    }
  }, [campaign?.platform]);

  const handleNetworkToggle = (networkType) => {
    const newSelection = selectedNetworks.includes(networkType)
      ? selectedNetworks.filter(n => n !== networkType)
      : [...selectedNetworks, networkType];
    setSelectedNetworks(newSelection);
    onNetworksChange(newSelection);
  };

  return (
    <div className="flex flex-wrap gap-3">
      {networks.map(network => {
        const isSelected = selectedNetworks.includes(network.id);
        return (
          <button
            key={network.id}
            type="button"
            onClick={() => handleNetworkToggle(network.id)}
            className={`flex items-center space-x-2 px-4 py-2.5 rounded-xl border-2 text-sm font-medium transition-all duration-150 ${
              isSelected
                ? `${network.color} border-current shadow-sm`
                : 'bg-white text-gray-500 border-gray-200 hover:border-gray-300 hover:text-gray-700'
            }`}
          >
            <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
              <path d={network.icon} />
            </svg>
            <span>{network.label}</span>
            {isSelected && (
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
              </svg>
            )}
          </button>
        );
      })}
    </div>
  );
};

export default NetworkSelector;
