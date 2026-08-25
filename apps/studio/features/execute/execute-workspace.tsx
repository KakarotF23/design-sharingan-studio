"use client";

import type {
  Approval,
  ChangeProposal,
  DesignApproach,
  FeatureBrief,
} from "@design-sharingan/core";
import { ModeSwitcher, WorkspaceHeader } from "@design-sharingan/ui";
import { useEffect, useState } from "react";
import { useStudioProject } from "../projects/project-shell";
import { ApprovalActions } from "./approval-actions";
import { ChangeProposalView } from "./change-proposal-view";

interface GitEvidence {
  available: boolean;
  branch?: string;
  statusBefore: string;
  statusAfter: string;
  diffAfter: string;
  note?: string;
}

interface ExecuteSession {
  id: string;
  status:
    | "IDLE"
    | "PREPARING"
    | "PROPOSING"
    | "WAITING_APPROVAL"
    | "REVISING"
    | "REJECTED"
    | "APPROVED"
    | "EDITING";
  sourceSessionId: string;
  approvedApproachId: string;
  approvalId: string;
  featureBrief: FeatureBrief;
  designApproach: DesignApproach;
  proposal?: ChangeProposal;
  proposalThreadId?: string;
  decisionApproval?: Approval;
  mutationApproval?: Approval;
  mutationEvidence?: {
    proposalId: string;
    threadId: string;
    filesChanged: string[];
    completedAt: string;
    git: GitEvidence;
  };
}

function activityFor(session: ExecuteSession | undefined, busy: boolean): string {
  if (busy) return "Applying the selected Safe Mode action…";
  switch (session?.status) {
    case "IDLE":
      return "Approved direction ready for proposal preparation";
    case "PREPARING":
      return "Preparing change proposal evidence";
    case "PROPOSING":
      return "Codex is preparing a bounded change proposal";
    case "WAITING_APPROVAL":
      return "Waiting for explicit Change Proposal approval";
    case "REVISING":
      return "Revision requested; target source remains unchanged";
    case "REJECTED":
      return "Proposal rejected; no mutation was authorized";
    case "APPROVED":
      return "Approval persisted; controlled mutation is running";
    case "EDITING":
      return "Approved mutation applied; render verification is next";
    default:
      return "Loading approved execution evidence";
  }
}

export function ExecuteWorkspace() {
  const project = useStudioProject();
  const [session, setSession] = useState<ExecuteSession>();
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();

  useEffect(() => {
    fetch(`/projects/${encodeURIComponent(project.id)}/execute/data`, {
      cache: "no-store",
    })
      .then(async (response) => {
        const payload = (await response.json()) as {
          executeSession?: ExecuteSession;
          error?: string;
        };
        if (!response.ok) {
          throw new Error(payload.error ?? "Approved direction is unavailable.");
        }
        setSession(payload.executeSession);
      })
      .catch((caught: unknown) => {
        setError(
          caught instanceof Error
            ? caught.message
            : "Approved direction is unavailable.",
        );
      })
      .finally(() => setLoaded(true));
  }, [project.id]);

  async function runAction(
    endpoint: string,
    body: Record<string, unknown>,
    successNotice: string,
  ): Promise<void> {
    if (session === undefined || busy) return;
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const response = await fetch(
        `/projects/${encodeURIComponent(project.id)}/execute/proposal${endpoint}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sessionId: session.id, ...body }),
        },
      );
      const payload = (await response.json()) as {
        session?: ExecuteSession;
        error?: string;
      };
      if (!response.ok || payload.session === undefined) {
        throw new Error(payload.error ?? "The Safe Mode action could not be completed.");
      }
      setSession(payload.session);
      setNotice(successNotice);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "The Safe Mode action could not be completed.",
      );
    } finally {
      setBusy(false);
    }
  }

  const preparing = session?.status === "PREPARING" || session?.status === "PROPOSING";
  const git = session?.mutationEvidence?.git;

  return (
    <div
      className="execute-workspace"
      aria-busy={busy || preparing}
    >
      <WorkspaceHeader
        eyebrow={`BOUNDED CHANGE / ${project.name.toUpperCase()}`}
        title="Execute"
        description="Safe Mode separates an approved design direction from a new, proposal-specific mutation approval. No source changes occur before that second human gate."
        actions={<ModeSwitcher mode="SAFE" />}
      />
      <p className="safe-activity" role="status" aria-live="polite">
        <span aria-hidden="true" />
        {activityFor(session, busy)}
      </p>
      {error ? <p className="form-error" role="alert">{error}</p> : null}
      {notice ? <p className="form-success" role="status">{notice}</p> : null}
      {!loaded ? (
        <p className="analysis-status" role="status">Loading approved direction…</p>
      ) : null}
      {loaded && session === undefined && error === undefined ? (
        <p className="reference-library__empty">No approved Feature EVOLVE direction yet.</p>
      ) : null}
      {session ? (
        <section className="approved-direction" aria-labelledby="approved-direction-title">
          <div className="approved-direction__header">
            <div>
              <p className="utility-label">APPROVED DIRECTION</p>
              <h2 id="approved-direction-title">Approved direction</h2>
            </div>
            <strong>{session.status === "IDLE" ? "Ready for change proposal" : session.status}</strong>
          </div>
          <div className="approved-direction__body">
            <div>
              <span>Feature Brief</span>
              <h3>{session.featureBrief.name}</h3>
              <p>{session.featureBrief.goal}</p>
            </div>
            <div>
              <span>Selected approach</span>
              <h3>{session.designApproach.title}</h3>
              <p>{session.designApproach.summary}</p>
            </div>
          </div>
          <dl className="approved-direction__evidence">
            <div><dt>Direction approval</dt><dd>{session.approvalId}</dd></div>
            <div><dt>Source session</dt><dd>{session.sourceSessionId}</dd></div>
            <div><dt>Genome fit</dt><dd>{session.designApproach.genomeFit}</dd></div>
            <div><dt>Likely files</dt><dd>{session.designApproach.likelyFiles.join(", ")}</dd></div>
          </dl>
        </section>
      ) : null}

      {session?.status === "IDLE" || session?.status === "REVISING" ? (
        <section className="proposal-start" aria-labelledby="proposal-start-title">
          <div>
            <p className="utility-label">READ-ONLY PREPARATION</p>
            <h2 id="proposal-start-title">
              {session.status === "REVISING" ? "Revision requested" : "Prepare the mutation gate"}
            </h2>
            <p>
              Codex first returns a structured file, screen, component, UX, visual,
              risk, and policy plan. The active target remains untouched.
            </p>
          </div>
          <button
            className="primary-button"
            type="button"
            disabled={busy}
            onClick={() =>
              void runAction(
                "",
                {},
                session.status === "REVISING"
                  ? "Revised proposal prepared"
                  : "Change proposal prepared",
              )
            }
          >
            {session.status === "REVISING"
              ? "Prepare revised proposal"
              : "Prepare change proposal"}
          </button>
        </section>
      ) : null}

      {preparing || session?.status === "APPROVED" ? (
        <p className="analysis-status" role="status">
          {session.status === "APPROVED"
            ? "Approval persisted. Applying only the exact approved delta…"
            : "Preparing a structured Change Proposal in read-only analysis space…"}
        </p>
      ) : null}

      {session?.status === "WAITING_APPROVAL" && session.proposal ? (
        <>
          <ChangeProposalView proposal={session.proposal} />
          <ApprovalActions
            busy={busy}
            onApprove={() => void runAction("/approve", {}, "Approved mutation applied")}
            onRevision={() =>
              void runAction(
                "/decision",
                {
                  decision: "REVISION_REQUESTED",
                  comment: "Revise the proposal while preserving the approved direction.",
                },
                "Revision requested",
              )
            }
            onReject={() =>
              void runAction(
                "/decision",
                { decision: "REJECTED", comment: "Proposal rejected by local user." },
                "Proposal rejected",
              )
            }
          />
        </>
      ) : null}

      {session?.status === "REJECTED" ? (
        <section className="decision-outcome" aria-labelledby="decision-outcome-title">
          <p className="utility-label">NO MUTATION AUTHORIZED</p>
          <h2 id="decision-outcome-title">Proposal rejected</h2>
          <p>The target project remains unchanged. A future mutation requires a new proposal and approval.</p>
        </section>
      ) : null}

      {session?.status === "EDITING" && session.mutationEvidence ? (
        <section className="mutation-evidence" aria-labelledby="mutation-evidence-title">
          <header>
            <div>
              <p className="utility-label">ACTIVITY / GIT EVIDENCE</p>
              <h2 id="mutation-evidence-title">Approved mutation applied</h2>
            </div>
            <strong>EDITING</strong>
          </header>
          <dl>
            <div><dt>Proposal</dt><dd>{session.mutationEvidence.proposalId}</dd></div>
            <div><dt>Approval</dt><dd>{session.mutationApproval?.id}</dd></div>
            <div><dt>Agent thread</dt><dd>{session.mutationEvidence.threadId}</dd></div>
            <div><dt>Files changed</dt><dd>{session.mutationEvidence.filesChanged.join(", ")}</dd></div>
            <div><dt>Git branch</dt><dd>{git?.branch ?? "Not available"}</dd></div>
            <div><dt>Status before</dt><dd>{git?.statusBefore || "Clean"}</dd></div>
            <div><dt>Status after</dt><dd>{git?.statusAfter || "No Git status evidence"}</dd></div>
          </dl>
          <div className="mutation-evidence__diff">
            <h3>Diff after</h3>
            <pre>{git?.diffAfter || git?.note || "Git diff evidence is unavailable."}</pre>
          </div>
          <p>No auto-commit was created.</p>
          <p>Fresh render and verification continue in Task 10; this session remains truthfully at EDITING.</p>
        </section>
      ) : null}
    </div>
  );
}
