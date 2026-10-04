import Link from 'next/link';
import styles from './page.module.css';

function FriendRow({ name }) {
  return <li className="friend">{name}</li>;
}

export default function Home() {
  return (
    <main>
      <header className={styles.topbar}>
        <h1 className={styles.title}>Chats</h1>
        <img id="me" className={styles.me} src="/me.svg" alt="Me" />
      </header>
      <ul className={styles.friends}>
        {['Ada', 'Grace', 'Linus'].map((n) => <FriendRow key={n} name={n} />)}
      </ul>
      <Link href="/settings">Settings</Link>
    </main>
  );
}
