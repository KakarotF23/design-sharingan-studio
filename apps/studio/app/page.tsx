export default function HomePage() {
  return (
    <main className="intake-landing">
      <div className="intake-landing__grid" aria-hidden="true" />
      <section className="intake-landing__thesis">
        <div className="intake-lens" aria-hidden="true">
          <span className="intake-lens__core" />
          <span className="intake-lens__scan" />
        </div>
        <p className="utility-label">LOCAL DESIGN INTELLIGENCE / STUDIO 0.1</p>
        <h1>Design Sharingan</h1>
        <p className="intake-landing__lede">
          See the design. Understand the logic. Evolve the product.
        </p>
      </section>

      <section className="intake-landing__actions" aria-labelledby="intake-title">
        <div>
          <p className="utility-label">PROJECT INTAKE</p>
          <h2 id="intake-title">Choose a source</h2>
          <p>
            Scan a web project into one local workspace. You review what was
            detected before Studio opens.
          </p>
        </div>
        <form action="/projects" method="get">
          <button className="primary-action" name="source" value="local">
            <span>Open Local Project</span>
            <span aria-hidden="true">↗</span>
          </button>
        </form>
        <form action="/projects" method="get">
          <button className="secondary-action" name="source" value="github">
            <span>Import GitHub Repo</span>
            <span aria-hidden="true">↗</span>
          </button>
        </form>
        <p className="intake-landing__boundary">
          Local-first · web projects · explicit review before mutation
        </p>
      </section>
    </main>
  );
}
