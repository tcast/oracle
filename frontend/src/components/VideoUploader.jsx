import React, { useState, useRef } from 'react';

const VideoUploader = ({ onMediaUpload, onMediaRemove, mediaList = [], platform = 'tiktok' }) => {
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState(null);
  const fileInputRef = useRef(null);
  const videoRef = useRef(null);

  const platformConfig = {
    tiktok: {
      maxDuration: 180,
      maxSize: 100 * 1024 * 1024, // 100MB
      acceptedFormats: ['video/mp4', 'video/quicktime'],
      label: 'TikTok Video'
    },
    youtube: {
      maxDuration: 60,
      maxSize: 128 * 1024 * 1024, // 128MB
      acceptedFormats: ['video/mp4', 'video/quicktime'],
      label: 'YouTube Short'
    }
  };

  const config = platformConfig[platform];

  const getVideoDuration = (file) => {
    return new Promise((resolve, reject) => {
      const video = document.createElement('video');
      video.preload = 'metadata';

      video.onloadedmetadata = () => {
        window.URL.revokeObjectURL(video.src);
        resolve(video.duration);
      };

      video.onerror = () => {
        reject('Error loading video file');
      };

      video.src = URL.createObjectURL(file);
    });
  };

  const handleFileSelect = async (event) => {
    const file = event.target.files[0];
    if (!file) return;

    try {
      setUploading(true);
      setError(null);

      // Validate file type
      if (!config.acceptedFormats.includes(file.type)) {
        throw new Error(`Please upload a valid video file (${config.acceptedFormats.join(', ')})`);
      }

      // Validate file size
      if (file.size > config.maxSize) {
        throw new Error(`Video must be smaller than ${config.maxSize / (1024 * 1024)}MB`);
      }

      // Validate video duration
      const duration = await getVideoDuration(file);
      if (duration > config.maxDuration) {
        throw new Error(`Video must be ${config.maxDuration} seconds or shorter`);
      }

      const formData = new FormData();
      formData.append('media', file);

      const response = await fetch('/api/upload', {
        method: 'POST',
        body: formData,
      });

      if (!response.ok) {
        throw new Error('Failed to upload video');
      }

      const data = await response.json();
      onMediaUpload(data.url, file.type, duration);
      
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
          id="video-upload"
        />
        <label
          htmlFor="video-upload"
          className={`px-4 py-2 border border-gray-300 rounded-md shadow-sm text-sm font-medium text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500 cursor-pointer ${
            uploading ? 'opacity-50 cursor-not-allowed' : ''
          }`}
        >
          {uploading ? 'Uploading...' : `Upload ${config.label}`}
        </label>
        <span className="text-sm text-gray-500">
          Max duration: {config.maxDuration} seconds
        </span>
      </div>

      {error && (
        <div className="text-sm text-red-600">
          {error}
        </div>
      )}

      {mediaList.length > 0 && (
        <div className="grid grid-cols-2 gap-4">
          {mediaList.map((media, index) => (
            <div key={index} className="relative">
              <video
                ref={videoRef}
                src={media.url}
                className="w-full aspect-[9/16] object-cover rounded-lg"
                controls
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

export default VideoUploader;