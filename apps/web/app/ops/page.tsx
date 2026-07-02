export default function OpsPage() {
  return (
    <>
      <h1>Agent Observability</h1>
      <section className="grid">
        <div className="card"><div className="metric">75%</div><p>Target clean-invoice STP</p></div>
        <div className="card"><div className="metric">0</div><p>Live model calls during tests</p></div>
        <div className="card"><div className="metric">RLS</div><p>Database isolation gate</p></div>
      </section>
    </>
  );
}

