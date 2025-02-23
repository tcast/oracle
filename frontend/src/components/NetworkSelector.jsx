import React, { useState, useEffect } from 'react';

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

  const networks = [
    { id: 'reddit', label: 'Reddit' },
    { id: 'linkedin', label: 'LinkedIn' },
    { id: 'x', label: 'X (Twitter)' },
    { id: 'tiktok', label: 'TikTok' }
  ];

  return (
    <div className="space-y-4">
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-2">
          Select Social Networks
        </label>
        <div className="space-y-2">
          {networks.map(network => (
            <div key={network.id} className="flex items-center">
              <input
                type="checkbox"
                id={network.id}
                checked={selectedNetworks.includes(network.id)}
                onChange={() => handleNetworkToggle(network.id)}
                className="h-4 w-4 text-indigo-600 focus:ring-indigo-500 border-gray-300 rounded"
              />
              <label htmlFor={network.id} className="ml-2 block text-sm text-gray-900">
                {network.label}
              </label>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

export default NetworkSelector;
