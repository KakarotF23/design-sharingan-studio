import type { ReleaseGateCheck } from "@design-sharingan/core";
import type { GovernReleaseProjection } from "./govern-server";

function checkLabel(name: ReleaseGateCheck["name"]): string {
  return name.replace(/([A-Z])/g, " $1").replace(/^./, (value) => value.toUpperCase());
}

export function ReleaseGateView({
  release,
  busy,
  onEvaluate,
}: {
  release?: GovernReleaseProjection;
  busy: boolean;
  onEvaluate(): void;
}) {
  return (
    <section className="release-gate-view" aria-labelledby="release-gate-title">
      <header className="govern-section-heading">
        <div>
          <p className="utility-label">RELEASE / CODE-OWNED STATUS</p>
          <h2 id="release-gate-title">Release gate</h2>
        </div>
        <button className="secondary-action" type="button" disabled={busy || release === undefined} onClick={onEvaluate}>
          <span>{busy ? "Checking release…" : "Evaluate release gate"}</span>
          <span aria-hidden="true">→</span>
        </button>
      </header>
      {release === undefined ? (
        <p className="govern-empty">Run a drift audit before evaluating this release. Missing evidence cannot pass.</p>
      ) : (
        <>
          <div className="release-gate-view__summary">
            <span>Release status</span>
            <span className="utility-label">Release {release.status}</span>
            <strong className={`govern-status govern-status--${release.status.toLowerCase()}`}>{release.status}</strong>
            <p>{release.scope.replaceAll("_", " ")}</p>
          </div>
          <ol className="release-checklist">
            {release.checks.map((check) => (
              <li key={check.name}>
                <div>
                  <h3>{checkLabel(check.name)}</h3>
                  <span className={`govern-status govern-status--${check.status.toLowerCase()}`}>{check.status}</span>
                </div>
                <dl>
                  <div><dt>Evidence</dt><dd>{check.evidence.length === 0 ? "No current evidence" : check.evidence.join(", ")}</dd></div>
                  <div><dt>Last verified</dt><dd>{check.lastVerified ?? "NOT VERIFIED"}</dd></div>
                  {check.blockingReason === undefined ? null : <div><dt>Blocking reason</dt><dd>{check.blockingReason}</dd></div>}
                </dl>
              </li>
            ))}
          </ol>
          {release.nonBlockingDebt.length > 0 ? (
            <section className="release-debt" aria-labelledby="release-debt-title">
              <h3 id="release-debt-title">Documented non-blocking polish debt</h3>
              <ul>
                {release.nonBlockingDebt.map((debt) => (
                  <li key={`${debt.documentedBy}:${debt.finding}`}>
                    <strong>{debt.finding}</strong><span>{debt.rationale} — {debt.documentedBy}</span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </>
      )}
    </section>
  );
}
