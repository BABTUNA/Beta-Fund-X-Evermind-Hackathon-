export default function Home() {
  return (
    <main className="wrap">
      <header>
        <h1>
          <span className="dot" /> EverNav
        </h1>
        <p className="tag">Click-trail skills, learned once, replayed forever.</p>
      </header>

      <section className="grid">
        <div className="card">
          <span className="num">—</span>
          <span className="label">Skills learned</span>
        </div>
        <div className="card">
          <span className="num">—</span>
          <span className="label">Users helped</span>
        </div>
        <div className="card">
          <span className="num">—</span>
          <span className="label">Sessions logged</span>
        </div>
      </section>

      <footer>
        <span>Live data wires in next commit.</span>
      </footer>
    </main>
  );
}
