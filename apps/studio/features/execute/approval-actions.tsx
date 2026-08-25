"use client";

import { useState } from "react";

export function ApprovalActions({
  busy,
  onApprove,
  onRevision,
  onReject,
}: {
  busy: boolean;
  onApprove(): void;
  onRevision(instruction: string): void;
  onReject(): void;
}) {
  const [revisionInstruction, setRevisionInstruction] = useState("");
  const boundedInstruction = revisionInstruction.trim();
  return (
    <div className="approval-actions" aria-label="Change proposal decision">
      <label className="revision-instruction">
        <span>Revision instruction</span>
        <textarea
          value={revisionInstruction}
          maxLength={2_000}
          rows={3}
          required
          disabled={busy}
          placeholder="Describe the exact proposal change you need before approval."
          onChange={(event) => setRevisionInstruction(event.target.value)}
        />
      </label>
      <button
        className="primary-button"
        type="button"
        disabled={busy}
        onClick={onApprove}
      >
        Approve &amp; Execute
      </button>
      <button
        type="button"
        disabled={busy || boundedInstruction.length === 0}
        onClick={() => onRevision(boundedInstruction)}
      >
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
