import Header from '../components/Header.jsx';

export default function Settings() {
  return (
    <main className="screen">
      <Header title="Settings" />
      <a className="pill" href="/">Back</a>
      <p className="note">Notifications</p>
      <span id="badge" className="bg-brand text-white px-4 py-2 rounded-card">New</span>
    </main>
  );
}
