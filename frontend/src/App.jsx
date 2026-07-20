import React, { useState } from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import Login from './components/Login';
import CampaignDashboard from './components/CampaignDashboard';
import CampaignView from './components/CampaignView';
import UserManagement from './components/UserManagement';
import SocialAccounts from './components/SocialAccounts';
import ApiStatusDashboard from './components/ApiStatusDashboard';
import Sidebar from './components/Sidebar';
import PrivateRoute from './components/PrivateRoute';
import ProxyManagement from './components/ProxyManagement';
import ProxyAccountAssignment from './components/ProxyAccountAssignment';
import EmailAccountManager from './components/EmailAccountManager';
import ChatCampaignCreator from './components/ChatCampaignCreator';
import BrandsList from './components/BrandsList';
import BrandDetail from './components/BrandDetail';
import BrandCampaignCreator from './components/BrandCampaignCreator';
import BrandDataRoom from './components/BrandDataRoom';
import AdLibrary from './components/AdLibrary';
import OrganicActivity from './components/OrganicActivity';
import NocDashboard from './components/NocDashboard';

const PublicRoute = ({ children }) => {
  const { user, loading } = useAuth();
  if (loading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-whisper-950 via-gray-900 to-gray-800 flex items-center justify-center">
        <div className="animate-spin rounded-full h-10 w-10 border-2 border-whisper-400 border-t-transparent"></div>
      </div>
    );
  }
  return user ? <Navigate to="/" /> : children;
};

const LoadingScreen = () => (
<div className="min-h-screen bg-gradient-to-br from-whisper-950 via-gray-900 to-gray-800 flex items-center justify-center">
        <div className="animate-spin rounded-full h-10 w-10 border-2 border-whisper-400 border-t-transparent"></div>
      </div>
);

const AppLayout = ({ children, fullBleed = false }) => {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  return (
    <div className="flex h-screen bg-surface overflow-hidden">
      <Sidebar mobileOpen={mobileMenuOpen} onMobileClose={() => setMobileMenuOpen(false)} />
      <div className="flex-1 flex flex-col overflow-hidden">
        <header className="lg:hidden flex items-center h-14 px-4 bg-white border-b border-gray-200 flex-shrink-0 z-30">
          <button onClick={() => setMobileMenuOpen(true)} className="text-gray-600 hover:text-gray-900 p-1 -ml-1 rounded-lg hover:bg-gray-100">
            <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </button>
          <div className="flex items-center space-x-2 ml-3">
            <div className="w-7 h-7 bg-gradient-to-br from-whisper-400 to-purple-600 rounded-lg flex items-center justify-center">
              <svg className="w-3.5 h-3.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
              </svg>
            </div>
            <span className="text-base font-bold text-gray-900">Whisper</span>
          </div>
        </header>
        <main className={`flex-1 min-h-0 flex flex-col ${fullBleed ? 'overflow-hidden' : 'overflow-y-auto bg-gradient-to-br from-gray-50 to-gray-100/50'}`}>
          {fullBleed ? children : (
            <div className="max-w-7xl mx-auto px-4 sm:px-6 py-4 sm:py-8 animate-fade-in w-full">
              {children}
            </div>
          )}
        </main>
      </div>
    </div>
  );
};

function App() {
  return (
    <Router>
      <AuthProvider>
        <div className="min-h-screen bg-surface">
          <Routes>
            <Route path="/login" element={<PublicRoute><Login /></PublicRoute>} />
            <Route path="/users/new" element={<PrivateRoute fallback={<LoadingScreen />}><AppLayout><UserManagement /></AppLayout></PrivateRoute>} />
            <Route path="/social-accounts" element={<PrivateRoute fallback={<LoadingScreen />}><AppLayout><SocialAccounts /></AppLayout></PrivateRoute>} />
            <Route path="/organic-activity" element={<PrivateRoute fallback={<LoadingScreen />}><AppLayout><OrganicActivity /></AppLayout></PrivateRoute>} />
            <Route path="/noc" element={<PrivateRoute fallback={<LoadingScreen />}><AppLayout><NocDashboard /></AppLayout></PrivateRoute>} />
            <Route path="/proxy-management" element={<PrivateRoute fallback={<LoadingScreen />}><AppLayout><ProxyManagement /></AppLayout></PrivateRoute>} />
            <Route path="/email-accounts" element={<PrivateRoute fallback={<LoadingScreen />}><AppLayout><EmailAccountManager /></AppLayout></PrivateRoute>} />
            <Route path="/proxy-assignments" element={<PrivateRoute fallback={<LoadingScreen />}><AppLayout><ProxyAccountAssignment /></AppLayout></PrivateRoute>} />
            <Route path="/brands" element={<PrivateRoute fallback={<LoadingScreen />}><AppLayout><BrandsList /></AppLayout></PrivateRoute>} />
            <Route path="/brands/:id" element={<PrivateRoute fallback={<LoadingScreen />}><AppLayout><BrandDetail /></AppLayout></PrivateRoute>} />
            <Route path="/brands/:id/data-room" element={<PrivateRoute fallback={<LoadingScreen />}><AppLayout><BrandDataRoom /></AppLayout></PrivateRoute>} />
            <Route path="/ads" element={<PrivateRoute fallback={<LoadingScreen />}><AppLayout><AdLibrary /></AppLayout></PrivateRoute>} />
            <Route path="/brand-campaigns" element={<PrivateRoute fallback={<LoadingScreen />}><AppLayout><CampaignDashboard campaignType="brand" /></AppLayout></PrivateRoute>} />
            <Route path="/brand-campaigns/new" element={<PrivateRoute fallback={<LoadingScreen />}><AppLayout><BrandCampaignCreator /></AppLayout></PrivateRoute>} />
            <Route path="/campaigns/new" element={<PrivateRoute fallback={<LoadingScreen />}><AppLayout fullBleed><ChatCampaignCreator /></AppLayout></PrivateRoute>} />
            <Route path="/campaigns/:id" element={<PrivateRoute fallback={<LoadingScreen />}><AppLayout fullBleed><CampaignView /></AppLayout></PrivateRoute>} />
            <Route path="/" element={<PrivateRoute fallback={<LoadingScreen />}><AppLayout><CampaignDashboard campaignType="whisper" /></AppLayout></PrivateRoute>} />
            <Route path="/api-status" element={<PrivateRoute fallback={<LoadingScreen />}><AppLayout><ApiStatusDashboard /></AppLayout></PrivateRoute>} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </div>
      </AuthProvider>
    </Router>
  );
}

export default App;
