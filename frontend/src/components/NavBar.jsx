import React from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';

const NavBar = () => {
  const navigate = useNavigate();
  const { logout } = useAuth();

  const handleLogout = async () => {
    try {
      await logout();
      navigate('/login');
    } catch (error) {
      console.error('Error during logout:', error);
      // Still navigate to login page even if there's an error
      navigate('/login');
    }
  };

  return (
    <nav className="bg-white shadow-lg">
      <div className="max-w-7xl mx-auto px-4">
        <div className="flex justify-between h-16">
          <div className="flex items-center">
            <Link to="/" className="text-xl font-bold hover:text-indigo-600 transition duration-150 ease-in-out">
              Oracle
            </Link>
            <div className="hidden md:flex items-center ml-10 space-x-8">
              <Link
                to="/"
                className="text-gray-700 hover:text-indigo-600 px-3 py-2 text-sm font-medium transition duration-150 ease-in-out"
              >
                Campaigns
              </Link>
              <Link
                to="/social-accounts"
                className="text-gray-700 hover:text-indigo-600 px-3 py-2 text-sm font-medium transition duration-150 ease-in-out"
              >
                Social Accounts
              </Link>
            </div>
          </div>
          <div className="flex items-center">
            <button
              onClick={handleLogout}
              className="ml-4 px-4 py-2 text-sm font-medium text-gray-700 hover:text-gray-900 hover:bg-gray-100 rounded-md transition duration-150 ease-in-out"
            >
              Logout
            </button>
          </div>
        </div>
      </div>
    </nav>
  );
};

export default NavBar;