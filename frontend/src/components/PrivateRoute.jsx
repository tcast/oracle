import React from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';

const PrivateRoute = ({ children, fallback }) => {
  const { user, loading } = useAuth();
  
  if (loading) {
    return fallback || <div className="flex items-center justify-center h-32"><div className="animate-spin rounded-full h-8 w-8 border-2 border-oracle-400 border-t-transparent"></div></div>;
  }
  
  return user ? children : <Navigate to="/login" />;
};

export default PrivateRoute;
