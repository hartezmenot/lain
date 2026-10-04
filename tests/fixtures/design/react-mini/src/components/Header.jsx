export default function Header({ title }) {
  return (
    <header className="bar">
      <h1 className="bar-title">{title}</h1>
      <img id="me" className="me" src="/me.svg" alt="Me" />
    </header>
  );
}
