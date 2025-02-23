// frontend/src/App.jsx
import React from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import Login from './components/Login';
import CampaignDashboard from './components/CampaignDashboard';
import CampaignView from './components/CampaignView';
import UserManagement from './components/UserManagement';
import SocialAccounts from './components/SocialAccounts';
import NavBar from './components/NavBar';
import PrivateRoute from './components/PrivateRoute';

// Public Route component - redirects to dashboard if already logged in
const PublicRoute = ({ children }) => {
  const { user, loading } = useAuth();
  
  if (loading) {
    return <div>Loading...</div>;
  }
  
  return user ? <Navigate to="/" /> : children;
};

function App() {
  return (
    <Router>
      <AuthProvider>
        <div className="min-h-screen bg-gray-100">
          <Routes>
            <Route 
              path="/login" 
              element={
                <PublicRoute>
                  <Login />
                </PublicRoute>
              } 
            />
            <Route
              path="/users/new"
              element={
                <PrivateRoute>
                  <NavBar />
                  <main className="max-w-7xl mx-auto py-6 sm:px-6 lg:px-8">
                    <UserManagement />
                  </main>
                </PrivateRoute>
              }
            />
            <Route
              path="/social-accounts"
              element={
                <PrivateRoute>
                  <NavBar />
                  <main className="max-w-12xl mx-auto py-6 sm:px-6 lg:px-8">
                    <SocialAccounts />
                  </main>
                </PrivateRoute>
              }
            />
            <Route
              path="/campaigns/:id"
              element={
                <PrivateRoute>
                  <NavBar />
                  <main className="max-w-7xl mx-auto py-6 sm:px-6 lg:px-8">
                    <CampaignView />
                  </main>
                </PrivateRoute>
              }
            />
            <Route
              path="/"
              element={
                <PrivateRoute>
                  <NavBar />
                  <main className="max-w-7xl mx-auto py-6 sm:px-6 lg:px-8">
                    <CampaignDashboard />
                  </main>
                </PrivateRoute>
              }
            />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </div>
      </AuthProvider>
    </Router>
  );
}

export default App;