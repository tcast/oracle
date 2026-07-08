import React, { useState } from 'react';
import { useNavigate, useLocation, Link } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';

const navItems = [
  { path: '/', label: 'Campaigns', icon: 'M11 3.055A9.001 9.001 0 1020.945 13H11V3.055z M20.488 9H15V3.512A9.025 9.025 0 0120.488 9z' },
  { path: '/social-accounts', label: 'Social Accounts', icon: 'M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z' },
  { path: '/proxy-management', label: 'Proxies', icon: 'M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z' },
  { path: '/email-accounts', label: 'Email Accounts', icon: 'M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z' },
  { path: '/proxy-assignments', label: 'Assignments', icon: 'M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1' },
  { path: '/api-status', label: 'API Status', icon: 'M13 10V3L4 14h7v7l9-11h-7z' },
];



const NavIcon = ({ path }) => (
  <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
    <path strokeLinecap="round" strokeLinejoin="round" d={path} />
  </svg>
);

const Sidebar = ({ mobileOpen, onMobileClose }) => {
  const navigate = useNavigate();
  const location = useLocation();
  const { logout, user } = useAuth();
  const [collapsed, setCollapsed] = useState(false);

  const handleLogout = async () => {
    try { await logout(); } catch {}
    navigate('/login');
  };

  const isActive = (path) => {
    if (path === '/') return location.pathname === '/';
    return location.pathname.startsWith(path);
  };

  const sidebarContent = (
    <aside className={`${collapsed ? 'w-16' : 'w-60'} h-full bg-gray-900 flex flex-col transition-all duration-200 ease-in-out flex-shrink-0`}>
      <div className="flex items-center h-14 lg:h-16 px-4 border-b border-gray-800">
        <Link to="/" onClick={onMobileClose} className="flex items-center space-x-3 min-w-0">
          <div className="w-8 h-8 bg-gradient-to-br from-oracle-400 to-purple-600 rounded-lg flex items-center justify-center flex-shrink-0">
            <svg className="w-4 h-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
            </svg>
          </div>
          {!collapsed && <span className="text-lg font-bold text-white tracking-tight">Oracle</span>}
        </Link>
        <div className="flex items-center ml-auto space-x-1">
          <button onClick={() => setCollapsed(!collapsed)} className="hidden lg:block text-gray-400 hover:text-white p-1 rounded">
            <svg className={`w-4 h-4 transition-transform ${collapsed ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M11 19l-7-7 7-7m8 14l-7-7 7-7" />
            </svg>
          </button>
          <button onClick={onMobileClose} className="lg:hidden text-gray-400 hover:text-white p-1 rounded">
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      </div>

      <nav className="flex-1 overflow-y-auto py-4 px-2 space-y-1">
        {navItems.map(item => (
          <Link
            key={item.path}
            to={item.path}
            onClick={onMobileClose}
            className={`flex items-center ${collapsed ? 'justify-center' : 'px-3'} py-2.5 rounded-lg text-sm font-medium transition-all duration-150 ${
              isActive(item.path)
                ? 'bg-oracle-600/20 text-oracle-400 shadow-sm'
                : 'text-gray-400 hover:text-gray-200 hover:bg-gray-800/50'
            }`}
            title={collapsed ? item.label : undefined}
          >
            <NavIcon path={item.icon} />
            {!collapsed && <span className="ml-3">{item.label}</span>}
          </Link>
        ))}

      </nav>

      <div className="border-t border-gray-800 p-3">
        {collapsed ? (
          <button onClick={handleLogout} className="w-full p-2 rounded-lg text-gray-400 hover:text-red-400 hover:bg-gray-800/50 transition-all" title="Logout">
            <svg className="w-5 h-5 mx-auto" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
            </svg>
          </button>
        ) : (
          <div className="flex items-center space-x-3">
            <div className="w-8 h-8 bg-gradient-to-br from-oracle-500 to-purple-600 rounded-full flex items-center justify-center text-white text-xs font-bold flex-shrink-0">
              {user?.email?.charAt(0).toUpperCase() || 'U'}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-gray-200 truncate">{user?.email || 'User'}</p>
            </div>
            <button onClick={handleLogout} className="text-gray-400 hover:text-red-400 p-1 rounded transition-colors" title="Logout">
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
              </svg>
            </button>
          </div>
        )}
      </div>
    </aside>
  );

  return (
    <>
      <div className="hidden lg:flex h-screen flex-shrink-0">
        {sidebarContent}
      </div>
      {mobileOpen && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div className="fixed inset-0 bg-gray-900/60 backdrop-blur-sm" onClick={onMobileClose} />
          <div className="fixed inset-y-0 left-0 w-72 animate-slide-in-right shadow-2xl">
            {sidebarContent}
          </div>
        </div>
      )}
    </>
  );
};

export default Sidebar;
