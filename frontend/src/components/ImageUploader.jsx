import React, { useState, useRef } from 'react';

const ImageUploader = ({ onMediaUpload, onMediaRemove, mediaList = [], platform = 'linkedin' }) => {
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState(null);
  const fileInputRef = useRef(null);

  const platformConfig = {
    linkedin: {
      maxSize: 5 * 1024 * 1024, // 5MB
      acceptedFormats: ['image/jpeg', 'image/png'],
      label: 'LinkedIn Image'
    },
    x: {
      maxSize: 5 * 1024 * 1024, // 5MB
      acceptedFormats: ['image/jpeg', 'image/png', 'image/gif'],
      label: 'X Image'
    }
  };

  const config = platformConfig[platform];

  const handleFileSelect = async (event) => {
    const file = event.target.files[0];
    if (!file) return;

    try {
      setUploading(true);
      setError(null);

      // Validate file type
      if (!config.acceptedFormats.includes(file.type)) {
        throw new Error(`Please upload a valid image file (${config.acceptedFormats.join(', ')})`);
      }

      // Validate file size
      if (file.size > config.maxSize) {
        throw new Error(`Image must be smaller than ${config.maxSize / (1024 * 1024)}MB`);
      }

      const formData = new FormData();
      formData.append('media', file);

      const response = await fetch('/api/upload', {
        method: 'POST',
        body: formData,
      });

      if (!response.ok) {
        throw new Error('Failed to upload image');
      }

      const data = await response.json();
      onMediaUpload(data.url, file.type);
      
      // Reset file input
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center space-x-4">
        <input
          ref={fileInputRef}
          type="file"
          accept={config.acceptedFormats.join(',')}
          onChange={handleFileSelect}
          disabled={uploading}
          className="hidden"
          id="image-upload"
        />
        <label
          htmlFor="image-upload"
          className={`px-4 py-2 border border-gray-300 rounded-md shadow-sm text-sm font-medium text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500 cursor-pointer ${
            uploading ? 'opacity-50 cursor-not-allowed' : ''
          }`}
        >
          {uploading ? 'Uploading...' : `Upload ${config.label}`}
        </label>
      </div>

      {error && (
        <div className="text-sm text-red-600">
          {error}
        </div>
      )}

      {mediaList.length > 0 && (
        <div className="grid grid-cols-4 gap-4">
          {mediaList.map((media, index) => (
            <div key={index} className="relative">
              <img
                src={media.url}
                alt={`Upload ${index + 1}`}
                className="h-24 w-24 object-cover rounded-lg"
              />
              <button
                onClick={() => onMediaRemove(index)}
                className="absolute -top-2 -right-2 bg-red-500 text-white rounded-full w-6 h-6 flex items-center justify-center hover:bg-red-600"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default ImageUploader;