import type { MangekyoGateView } from "./mangekyo-types";

export function AutonomyBoundaryCard({
  gate,
  busy,
  onDecision,
}: {
  gate: MangekyoGateView;
  busy: boolean;
  onDecision(decision: "REJECT" | "APPROVE_ONCE" | "EXPAND_SCOPE"): void;
}) {
  return (
    <section className="autonomy-boundary" aria-labelledby="autonomy-boundary-title">
      <div className="autonomy-boundary__signal" aria-hidden="true">!</div>
      <div>
        <p className="utility-label">HUMAN_GATE / MUTATION PAUSED</p>
        <h2 id="autonomy-boundary-title">Human decision required</h2>
        <p>{gate.requestedChangeSummary}</p>
        <dl>
          <div><dt>Requested change</dt><dd>{gate.requestedChange.kind}</dd></div>
          <div><dt>Reason</dt><dd>{gate.reasons.join(" ")}</dd></div>
          <div><dt>Affected scope</dt><dd>{gate.affectedScope.join(", ")}</dd></div>
          <div><dt>Impact</dt><dd>{gate.impact}</dd></div>
        </dl>
        <div className="autonomy-boundary__actions">
          <button type="button" disabled={busy} onClick={() => onDecision("REJECT")}>Reject</button>
          <button type="button" disabled={busy} onClick={() => onDecision("APPROVE_ONCE")}>Approve Once</button>
          <button type="button" disabled={busy} onClick={() => onDecision("EXPAND_SCOPE")}>Expand Scope</button>
        </div>
      </div>
    </section>
  );
}
