import { Link } from 'react-router-dom';

export default function Settings() {
  return (
    <section className="settings">
      <p className="setting">Notifications</p>
      <Link to="/">Back</Link>
    </section>
  );
}
