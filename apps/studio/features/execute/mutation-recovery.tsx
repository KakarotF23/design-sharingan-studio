"use client";
import { useState } from "react";
type Recovery = { claimId: string; proposalId: string; phase: "PREPARING" | "APPLYING"; ownerState: "ACTIVE" | "ABANDONED"; sourceFingerprint: string; affectedPaths: string[] };
export function MutationRecovery({ projectId }: { projectId: string }) {
  const [recovery, setRecovery] = useState<Recovery>();
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  async function inspect() {
    setBusy(true); setConfirmed(false); setRecovery(undefined);
    try {
      const response = await fetch(`/projects/${encodeURIComponent(projectId)}/execute/recovery`, { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      setRecovery(data.recovery ?? undefined);
      setMessage(data.recovery ? "Review the listed files locally, then explicitly confirm keeping their current contents." : "No pending claim remains. The previous approval stays blocked; start a new EVOLVE direction for further work.");
    } catch (error) { setMessage(error instanceof Error ? error.message : "Recovery evidence unavailable."); }
    finally { setBusy(false); }
  }
  async function reconcile() {
    if (!recovery || !confirmed) return;
    setBusy(true);
    try {
      const response = await fetch(`/projects/${encodeURIComponent(projectId)}/execute/recovery`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ claimId: recovery.claimId, proposalId: recovery.proposalId, expectedSourceFingerprint: recovery.sourceFingerprint, confirmation: "KEEP_CURRENT_FILES" }) });
      const data = await response.json(); if (!response.ok) throw new Error(data.error);
      setRecovery(undefined); setConfirmed(false);
      setMessage("Recovery recorded. Product files were preserved. The old approval cannot be replayed; further changes require a new direction and approval.");
    } catch (error) { setMessage(error instanceof Error ? error.message : "Recovery failed closed."); }
    finally { setBusy(false); }
  }
  return <div aria-busy={busy}><button className="secondary-action" onClick={() => void inspect()} disabled={busy}>Inspect recovery evidence</button><p role="status" aria-live="polite">{message}</p>{recovery ? <><p>Owner: {recovery.ownerState}. Files: {recovery.affectedPaths.join(", ")}. Snapshot: {recovery.sourceFingerprint.slice(0, 12)}.</p><label><input type="checkbox" checked={confirmed} disabled={busy || recovery.ownerState !== "ABANDONED" || recovery.phase !== "APPLYING"} onChange={(event) => setConfirmed(event.target.checked)} />I reviewed the affected files and explicitly choose to keep their current contents.</label><button className="primary-action" disabled={busy || !confirmed} onClick={() => void reconcile()}>Preserve files and record recovery</button></> : null}</div>;
}
