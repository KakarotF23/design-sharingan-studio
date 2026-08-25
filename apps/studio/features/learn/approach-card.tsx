import type { DesignApproach } from "@design-sharingan/core";

export function ApproachCard({
  approach,
  busy,
  onApprove,
}: {
  approach: DesignApproach;
  busy: boolean;
  onApprove(approachId: string): void;
}) {
  return (
    <article className={`approach-card${approach.recommended ? " approach-card--recommended" : ""}`}>
      <div className="approach-card__topline">
        <span>{approach.estimatedComplexity} COMPLEXITY</span>
        {approach.recommended ? <strong>RECOMMENDED</strong> : <span>ALTERNATIVE</span>}
      </div>
      <h3>{approach.title}</h3>
      <p className="approach-card__summary">{approach.summary}</p>
      <div className="approach-card__tradeoffs">
        <section>
          <h4>Advantages</h4>
          <ul>{approach.pros.map((item) => <li key={item}>{item}</li>)}</ul>
        </section>
        <section>
          <h4>Trade-offs</h4>
          <ul>{approach.cons.map((item) => <li key={item}>{item}</li>)}</ul>
        </section>
      </div>
      <dl className="approach-card__evidence">
        <div>
          <dt>Genome fit</dt>
          <dd>{approach.genomeFit}</dd>
        </div>
        <div>
          <dt>Likely files</dt>
          <dd>{approach.likelyFiles.join(", ")}</dd>
        </div>
        <div>
          <dt>UX impact</dt>
          <dd>{approach.uxImpact.map((impact) => impact.area).join(", ")}</dd>
        </div>
      </dl>
      <button
        type="button"
        className={approach.recommended ? "primary-action" : "secondary-action"}
        disabled={busy}
        onClick={() => onApprove(approach.id)}
        aria-label={`Approve ${approach.title}`}
      >
        <span>{busy ? "Persisting approval…" : "Approve approach"}</span>
        <span aria-hidden="true">→</span>
      </button>
    </article>
  );
}
