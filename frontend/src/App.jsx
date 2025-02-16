// frontend/src/App.jsx
import React from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import Login from './components/Login';
import CampaignDashboard from './components/CampaignDashboard';

// Protected Route component
const PrivateRoute = ({ children }) => {
  const { user, loading } = useAuth();
  
  if (loading) {
    return <div>Loading...</div>;
  }
  
  return user ? children : <Navigate to="/login" />;
};

function App() {
  return (
    <Router>
      <AuthProvider>
        <div className="min-h-screen bg-gray-100">
          <Routes>
            <Route path="/login" element={<Login />} />
            <Route
              path="/*"
              element={
                <PrivateRoute>
                  <nav className="bg-white shadow-lg">
                    <div className="max-w-7xl mx-auto px-4">
                      <div className="flex justify-between h-16">
                        <div className="flex">
                          <div className="flex-shrink-0 flex items-center">
                            <h1 className="text-xl font-bold">Oracle</h1>
                          </div>
                        </div>
                      </div>
                    </div>
                  </nav>
                  <main className="max-w-7xl mx-auto py-6 sm:px-6 lg:px-8">
                    <CampaignDashboard />
                  </main>
                </PrivateRoute>
              }
            />
          </Routes>
        </div>
      </AuthProvider>
    </Router>
  );
}

export default App;