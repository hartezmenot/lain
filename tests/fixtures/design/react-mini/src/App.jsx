import { useEffect, useState } from 'react';
import Home from './pages/Home.jsx';
import Settings from './pages/Settings.jsx';

export default function App() {
  const [path, setPath] = useState(location.pathname);
  useEffect(() => {
    const on = () => setPath(location.pathname);
    window.addEventListener('popstate', on);
    return () => window.removeEventListener('popstate', on);
  }, []);
  return path === '/settings' ? <Settings /> : <Home />;
}
