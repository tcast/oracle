import axios from 'axios';

// Create axios instance
const api = axios.create();

// Safely access localStorage
const getLocalStorage = (key) => {
  try {
    return localStorage.getItem(key);
  } catch (error) {
    console.warn('Unable to access localStorage:', error);
    return null;
  }
};

// Safely set localStorage
const setLocalStorage = (key, value) => {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch (error) {
    console.warn('Unable to write to localStorage:', error);
    return false;
  }
};

// Safely remove from localStorage
const removeLocalStorage = (key) => {
  try {
    localStorage.removeItem(key);
    return true;
  } catch (error) {
    console.warn('Unable to remove from localStorage:', error);
    return false;
  }
};

// Add a request interceptor to add the auth token to every request
api.interceptors.request.use(
  (config) => {
    const token = getLocalStorage('accessToken');
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }
    return config;
  },
  (error) => {
    return Promise.reject(error);
  }
);

// Add a response interceptor to handle token refresh
api.interceptors.response.use(
  (response) => {
    return response;
  },
  async (error) => {
    const originalRequest = error.config;
    
    // If the error is due to an expired token (401) and we haven't tried to refresh yet
    if (error.response?.status === 401 && !originalRequest._retry) {
      originalRequest._retry = true;
      
      try {
        // Try to refresh the token
        const refreshToken = getLocalStorage('refreshToken');
        if (!refreshToken) {
          // No refresh token available, redirect to login
          window.location.href = '/login';
          return Promise.reject(error);
        }
        
        const response = await axios.post('/api/auth/refresh', { refreshToken });
        
        // If token refresh was successful
        if (response.status === 200) {
          // Update tokens in localStorage
          setLocalStorage('accessToken', response.data.accessToken);
          setLocalStorage('refreshToken', response.data.refreshToken);
          
          // Update the authorization header
          originalRequest.headers.Authorization = `Bearer ${response.data.accessToken}`;
          
          // Retry the original request
          return axios(originalRequest);
        }
      } catch (refreshError) {
        // If refresh token is invalid, redirect to login
        removeLocalStorage('accessToken');
        removeLocalStorage('refreshToken');
        removeLocalStorage('user');
        window.location.href = '/login';
        return Promise.reject(refreshError);
      }
    }
    
    return Promise.reject(error);
  }
);

export default api; 