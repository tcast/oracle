import React, { useState, useRef } from 'react';

const MediaUploader = ({ 
  onMediaUpload, 
  onMediaRemove, 
  mediaList = [], 
  acceptedTypes = "image/*",
  maxDuration = undefined 
}) => {
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState(null);
  const fileInputRef = useRef(null);
  const videoRef = useRef(null);

  const handleFileSelect = async (event) => {
    const file = event.target.files[0];
    if (!file) return;

    try {
      setUploading(true);
      setError(null);

      // Validate file type
      if (!file.type.match(acceptedTypes.split(',').join('|'))) {
        throw new Error('Invalid file type. Please upload an image or video file.');
      }

      // Validate video duration if it's a video
      if (file.type.startsWith('video/') && maxDuration) {
        const duration = await getVideoDuration(file);
        if (duration > maxDuration) {
          throw new Error(`Video must be ${maxDuration} seconds or shorter.`);
        }
      }

      // Create FormData and append file
      const formData = new FormData();
      formData.append('media', file);

      // Upload the file
      const response = await fetch('/api/upload', {
        method: 'POST',
        body: formData,
      });

      if (!response.ok) {
        throw new Error('Failed to upload media');
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

  const renderMediaPreview = (media, index) => {
    const isVideo = media.type?.startsWith('video/');

    if (isVideo) {
      return (
        <div key={index} className="relative">
          <video
            ref={videoRef}
            src={media.url}
            className="h-24 w-24 object-cover rounded-lg"
            controls
          />
          <button
            onClick={() => onMediaRemove(index)}
            className="absolute -top-2 -right-2 bg-red-500 text-white rounded-full w-6 h-6 flex items-center justify-center hover:bg-red-600"
          >
            ×
          </button>
        </div>
      );
    }

    return (
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
    );
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center space-x-4">
        <input
          ref={fileInputRef}
          type="file"
          accept={acceptedTypes}
          onChange={handleFileSelect}
          disabled={uploading}
          className="hidden"
          id="media-upload"
        />
        <label
          htmlFor="media-upload"
          className={`px-4 py-2 border border-gray-300 rounded-md shadow-sm text-sm font-medium text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500 cursor-pointer ${
            uploading ? 'opacity-50 cursor-not-allowed' : ''
          }`}
        >
          {uploading ? 'Uploading...' : 'Upload Media'}
        </label>
        {maxDuration && (
          <span className="text-sm text-gray-500">
            Max video duration: {maxDuration} seconds
          </span>
        )}
      </div>

      {error && (
        <div className="text-sm text-red-600">
          {error}
        </div>
      )}

      {mediaList.length > 0 && (
        <div className="grid grid-cols-4 gap-4">
          {mediaList.map((media, index) => renderMediaPreview(media, index))}
        </div>
      )}
    </div>
  );
};

export default MediaUploader;
