import React, { useState } from 'react';

const MediaUploader = ({ onMediaUpload, mediaList, onMediaRemove }) => {
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState(null);

  const handleFileSelect = async (e) => {
    const files = Array.from(e.target.files);
    setUploading(true);
    setError(null);

    try {
      for (const file of files) {
        if (!file.type.startsWith('image/')) {
          throw new Error('Only image files are allowed');
        }
        if (file.size > 5 * 1024 * 1024) { // 5MB limit
          throw new Error('File size must be less than 5MB');
        }

        const formData = new FormData();
        formData.append('media', file);

        const response = await fetch('/api/upload', {
          method: 'POST',
          body: formData,
        });

        if (!response.ok) throw new Error('Upload failed');

        const data = await response.json();
        onMediaUpload(data.url, file.type);
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setUploading(false);
      e.target.value = ''; // Reset input
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center space-x-4">
        <label className="flex items-center px-4 py-2 bg-white border border-gray-300 rounded-md shadow-sm cursor-pointer hover:bg-gray-50">
          <span className="text-sm font-medium text-gray-700">
            {uploading ? 'Uploading...' : 'Add Images'}
          </span>
          <input
            type="file"
            className="hidden"
            accept="image/*"
            multiple
            onChange={handleFileSelect}
            disabled={uploading}
          />
        </label>
        <span className="text-sm text-gray-500">Up to 5MB per image</span>
      </div>

      {error && (
        <div className="text-sm text-red-600">
          {error}
        </div>
      )}

      {mediaList && mediaList.length > 0 && (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4">
          {mediaList.map((media, index) => (
            <div key={index} className="relative group">
              <img
                src={media.url}
                alt={`Uploaded media ${index + 1}`}
                className="w-full h-32 object-cover rounded-lg"
              />
              <button
                onClick={() => onMediaRemove(index)}
                className="absolute top-2 right-2 p-1 bg-red-500 text-white rounded-full opacity-0 group-hover:opacity-100 transition-opacity"
              >
                <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
                  <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" />
                </svg>
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default MediaUploader;
