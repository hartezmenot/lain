import { Link } from 'react-router-dom';

export default function Home() {
  return (
    <main className="screen">
      <header className="topbar">
        <h1 className="title">Chats</h1>
        <img id="me" className="avatar" src="/me.svg" alt="Me" />
      </header>
      <div className="menu" hidden>
        <Link to="/profile">Profile</Link>
      </div>
      <button className="menu-toggle" onClick={(e) => { const m = document.querySelector('.menu'); m.hidden = !m.hidden; }}>Menu</button>
      <Link className="go" to="/settings">Settings</Link>
    </main>
  );
}
