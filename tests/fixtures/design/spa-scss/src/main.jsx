import React from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import Home from './pages/Home.jsx';
import Settings from './pages/Settings.jsx';
import Profile from './pages/Profile.jsx';
import './styles/app.scss';

const router = createBrowserRouter([
  { path: '/', element: <Home /> },
  { path: '/settings', element: <Settings /> },
  { path: '/profile', element: <Profile /> },
]);

createRoot(document.getElementById('root')).render(<RouterProvider router={router} />);
