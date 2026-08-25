"use client";

export function ApprovalActions({
  busy,
  onApprove,
  onRevision,
  onReject,
}: {
  busy: boolean;
  onApprove(): void;
  onRevision(): void;
  onReject(): void;
}) {
  return (
    <div className="approval-actions" aria-label="Change proposal decision">
      <button
        className="primary-button"
        type="button"
        disabled={busy}
        onClick={onApprove}
      >
        {busy ? "Applying approved scope…" : "Approve & Execute"}
      </button>
      <button type="button" disabled={busy} onClick={onRevision}>
        Request Revision
      </button>
      <button
        className="approval-actions__reject"
        type="button"
        disabled={busy}
        onClick={onReject}
      >
        Reject
      </button>
    </div>
  );
}
