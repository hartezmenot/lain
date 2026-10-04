import Header from '../components/Header.jsx';

export default function Settings() {
  return (
    <main className="screen">
      <Header title="Settings" />
      <a className="pill" href="/">Back</a>
      <p className="note">Notifications</p>
    </main>
  );
}
