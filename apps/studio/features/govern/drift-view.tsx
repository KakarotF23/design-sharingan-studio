import type { DriftFinding, DriftReport } from "@design-sharingan/core";

function ScopeList({
  title,
  values,
  empty,
}: {
  title: string;
  values: string[];
  empty: string;
}) {
  return (
    <section>
      <h3>{title}</h3>
      {values.length === 0 ? <p>{empty}</p> : (
        <ul>
          {values.map((value) => <li key={value}>{value}</li>)}
        </ul>
      )}
    </section>
  );
}

function DriftCard({
  finding,
  executeHref,
  busy,
  onApproveDebt,
}: {
  finding: DriftFinding;
  executeHref: string;
  busy: boolean;
  onApproveDebt?(key: string, rationale: string): Promise<void>;
}) {
  return (
    <article className="drift-card">
      <header>
        <div>
          <p className="utility-label">{finding.category.replaceAll("_", " / ")}</p>
          <h3>{finding.scope}</h3>
        </div>
        <span className={`govern-status govern-status--${finding.severity.toLowerCase()}`}>
          {finding.severity}
        </span>
      </header>
      <dl>
        <div><dt>Expected rule</dt><dd>{finding.expectedRule}</dd></div>
        <div>
          <dt>Observed evidence</dt>
          <dd>{finding.observedEvidence.length === 0 ? "No concrete observation supplied." : (
            <ul>{finding.observedEvidence.map((evidence) => <li key={evidence}>{evidence}</li>)}</ul>
          )}</dd>
        </div>
        <div><dt>Why it matters</dt><dd>{finding.whyItMatters}</dd></div>
        <div><dt>Smallest coherent fix</dt><dd>{finding.recommendedFix}</dd></div>
      </dl>
      {finding.requiresDesignDecision ? (
        <p className="drift-card__decision">Human design decision required before this becomes a product rule.</p>
      ) : null}
      {finding.handoffKey && !["RESOLVED", "INTENTIONAL"].includes(finding.status) ? <a className="secondary-action" href={`${executeHref}?finding=${finding.handoffKey}`}>
        <span>Send to Execute</span>
        <span aria-hidden="true">→</span>
      </a> : <p>{finding.status === "RESOLVED" ? "Resolved by fresh evidence." : "No executable current finding."}</p>}
      {finding.handoffKey && finding.severity === "POLISH" && !finding.requiresDesignDecision && !["RESOLVED", "INTENTIONAL"].includes(finding.status) && onApproveDebt ? <form onSubmit={(event) => { event.preventDefault(); const rationale = new FormData(event.currentTarget).get("rationale"); if (typeof rationale === "string") void onApproveDebt(finding.handoffKey!, rationale); }}><label>Why is this safe to defer?<textarea name="rationale" required maxLength={2000} disabled={busy} /></label><p>This explicitly records a human decision, not a Genome rewrite. Recapture this scope afterward; accepting debt does not make stale evidence pass.</p><button className="secondary-action" disabled={busy}>Approve documented polish debt</button></form> : null}
    </article>
  );
}

export function DriftView({
  report,
  busy,
  onAudit,
  executeHref,
  onApproveDebt,
}: {
  report?: DriftReport;
  busy: boolean;
  onAudit(): void;
  executeHref: string;
  onApproveDebt?(key: string, rationale: string): Promise<void>;
}) {
  return (
    <section className="drift-view" aria-labelledby="drift-audit-title">
      <header className="govern-section-heading">
        <div>
          <p className="utility-label">ETERNAL / EXPLICIT EVIDENCE ONLY</p>
          <h2 id="drift-audit-title">Drift audit</h2>
        </div>
        <button className="secondary-action" type="button" disabled={busy} onClick={onAudit}>
          <span>{busy ? "Auditing evidence…" : "Run drift audit"}</span>
          <span aria-hidden="true">→</span>
        </button>
      </header>
      {report === undefined ? (
        <p className="govern-empty">No drift report has been recorded. The release gate remains not verified.</p>
      ) : (
        <>
          <div className="drift-view__summary">
            <div>
              <span>Audit status</span>
              <strong className={`govern-status govern-status--${report.overallStatus.toLowerCase()}`}>
                {report.overallStatus}
              </strong>
            </div>
            <div><span>Requested scope</span><strong>{report.requestedScope.replaceAll("_", " ")}</strong></div>
            <div><span>Findings</span><strong>{report.findings.length}</strong></div>
            <div><span>Evidence</span><strong>{report.evidenceIds.length}</strong></div>
          </div>
          <div className="drift-view__scope">
            <ScopeList title="Inspected scope" values={report.inspectedScope} empty="No scope was inspected." />
            <ScopeList title="Unavailable scope" values={report.unavailableScope} empty="No unavailable scope recorded." />
            <ScopeList title="Unverified scope" values={report.unverifiedScope} empty="All explicitly expected scope is verified." />
          </div>
          {report.findings.length === 0 ? (
            <p className="govern-empty">No governed drift findings were observed in the inspected evidence.</p>
          ) : (
            <div className="drift-view__findings">
              {report.findings.map((finding) => (
                <DriftCard
                  key={`${finding.category}:${finding.scope}:${finding.expectedRule}`}
                  finding={finding}
                  executeHref={executeHref}
                  busy={busy}
                  onApproveDebt={onApproveDebt}
                />
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}
