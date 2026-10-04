import Header from '../components/Header.jsx';

export default function Home() {
  const go = (to) => { history.pushState({}, '', to); window.dispatchEvent(new PopStateEvent('popstate')); };
  return (
    <main className="screen">
      <Header title="Chats" />
      <ul className="friends">
        <li className="friend">Ana</li>
        <li className="friend">Bo</li>
      </ul>
      <button className="pill" style={{ marginTop: 8 }} onClick={() => go('/settings')}>Settings</button>
    </main>
  );
}
