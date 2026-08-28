import type { MangekyoRoundView } from "./mangekyo-types";

export function VisualRoundTimeline({ rounds }: { rounds: readonly MangekyoRoundView[] }) {
  return (
    <section className="visual-rounds" aria-labelledby="visual-rounds-title">
      <header>
        <p className="utility-label">ROUND HISTORY</p>
        <h2 id="visual-rounds-title">Visual decisions</h2>
      </header>
      {rounds.length === 0 ? (
        <p className="visual-rounds__empty">No autonomous round has completed.</p>
      ) : (
        <ol>
          {rounds.map((round) => (
            <li key={round.roundNumber}>
              <div className="visual-rounds__index">
                <strong>{`Round ${String(round.roundNumber).padStart(2, "0")}`}</strong>
                <span>{round.status}</span>
              </div>
              <div>
                <h3>{round.objective}</h3>
                <p>{round.filesChanged.join(", ")}</p>
              </div>
              <dl>
                <div><dt>Critical</dt><dd>{round.criticalCount}</dd></div>
                <div><dt>Important</dt><dd>{round.importantCount}</dd></div>
                <div><dt>Polish</dt><dd>{round.polishCount}</dd></div>
                <div><dt>UX integrity</dt><dd>{round.uxIntegrity}</dd></div>
                <div><dt>Product consistency</dt><dd>{round.productConsistency}</dd></div>
                <div><dt>Accessibility</dt><dd>{round.accessibility}</dd></div>
                <div><dt>Genome integrity</dt><dd>{round.genomeIntegrity}</dd></div>
              </dl>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
