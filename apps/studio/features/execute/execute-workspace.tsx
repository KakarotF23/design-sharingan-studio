"use client";

import type {
  Approval,
  ChangeProposal,
  DesignApproach,
  FeatureBrief,
} from "@design-sharingan/core";
import { ModeSwitcher, WorkspaceHeader } from "@design-sharingan/ui";
import { useCallback, useEffect, useState } from "react";
import {
  useStudioExecutionMode,
  useStudioProject,
} from "../projects/project-shell";
import { ApprovalActions } from "./approval-actions";
import { ChangeProposalView } from "./change-proposal-view";
import { MangekyoWorkspace } from "./mangekyo-workspace";

interface GitEvidence {
  available: boolean;
  branch?: string;
  statusBefore: string;
  statusAfter: string;
  diffAfter: string;
  truncation: Record<
    "branch" | "statusBefore" | "statusAfter" | "diffAfter",
    {
      truncated: boolean;
      limitBytes: number;
      originalBytes: number;
      retainedBytes: number;
    }
  >;
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
  executionFailure?: {
    kind: "SAFE_MUTATION_FAILURE";
    targetDisposition: "RECONCILIATION_REQUIRED";
    reason: string;
    affectedPaths: string[];
    occurredAt: string;
  };
  mutationEvidence?: {
    proposalId: string;
    threadId: string;
    filesChanged: string[];
    completedAt: string;
    git: GitEvidence;
  };
}

type SafeAction =
  | "PREPARE_PROPOSAL"
  | "PREPARE_REVISION"
  | "REQUEST_REVISION"
  | "REJECT_PROPOSAL"
  | "APPROVE_PROPOSAL";

function activityFor(
  session: ExecuteSession | undefined,
  busy: boolean,
  action: SafeAction | undefined,
): string {
  if (session?.status === "APPROVED" && session.executionFailure) {
    return "Approved execution requires reconciliation; replay is blocked";
  }
  if (session?.status === "APPROVED") {
    return "Approval persisted; controlled mutation is running";
  }
  if (busy) {
    switch (action) {
      case "PREPARE_PROPOSAL":
        return "Preparing a read-only change proposal; no mutation is authorized";
      case "PREPARE_REVISION":
        return "Preparing the requested read-only proposal revision; no mutation is authorized";
      case "REQUEST_REVISION":
        return "Recording your revision instruction; no mutation is authorized";
      case "REJECT_PROPOSAL":
        return "Recording proposal rejection; no mutation is authorized";
      case "APPROVE_PROPOSAL":
        return "Persisting exact proposal approval before any mutation begins";
    }
  }
  switch (session?.status) {
    case "IDLE":
      return "Approved direction ready for proposal preparation";
    case "PREPARING":
      return "Preparing change proposal evidence";
    case "PROPOSING":
      return "Codex is preparing a bounded read-only change proposal";
    case "WAITING_APPROVAL":
      return "Waiting for explicit Change Proposal approval";
    case "REVISING":
      return "Revision requested; target source remains unchanged";
    case "REJECTED":
      return "Proposal rejected; no mutation was authorized";
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
  const [activeAction, setActiveAction] = useState<SafeAction>();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const { mode, setMode } = useStudioExecutionMode();

  const fetchDurableSession = useCallback(async (): Promise<ExecuteSession | undefined> => {
    const response = await fetch(`/projects/${encodeURIComponent(project.id)}/execute/data`, {
      cache: "no-store",
    });
    const payload = (await response.json()) as {
      executeSession?: ExecuteSession;
      error?: string;
    };
    if (!response.ok) {
      throw new Error(payload.error ?? "Approved direction is unavailable.");
    }
    return payload.executeSession;
  }, [project.id]);

  useEffect(() => {
    fetchDurableSession()
      .then(setSession)
      .catch((caught: unknown) => {
        setError(
          caught instanceof Error
            ? caught.message
            : "Approved direction is unavailable.",
        );
      })
      .finally(() => setLoaded(true));
  }, [fetchDurableSession]);

  useEffect(() => {
    const durableWorkInProgress =
      session?.status === "PREPARING" ||
      session?.status === "PROPOSING" ||
      (session?.status === "APPROVED" &&
        session.executionFailure === undefined);
    if (!busy && !durableWorkInProgress) return;
    let cancelled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const current = await fetchDurableSession();
        if (!cancelled) setSession(current);
      } catch {
        // The action request remains authoritative. A later poll or its final
        // response can still recover the durable checkpoint.
      } finally {
        if (!cancelled) timeout = setTimeout(poll, 80);
      }
    };
    timeout = setTimeout(poll, 40);
    return () => {
      cancelled = true;
      if (timeout !== undefined) clearTimeout(timeout);
    };
  }, [busy, fetchDurableSession, session?.executionFailure, session?.status]);

  async function runAction(
    action: SafeAction,
    endpoint: string,
    body: Record<string, unknown>,
    successNotice: string,
  ): Promise<void> {
    if (session === undefined || busy) return;
    setBusy(true);
    setActiveAction(action);
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
      try {
        setSession(await fetchDurableSession());
      } catch {
        // Keep the action error authoritative when the durable checkpoint is
        // temporarily unavailable. The existing poll/reload recovery remains.
      }
      setError(
        caught instanceof Error
          ? caught.message
          : "The Safe Mode action could not be completed.",
      );
    } finally {
      setBusy(false);
      setActiveAction(undefined);
    }
  }

  const preparing = session?.status === "PREPARING" || session?.status === "PROPOSING";
  const approvedExecutionActive =
    session?.status === "APPROVED" && session.executionFailure === undefined;
  const git = session?.mutationEvidence?.git;

  if (mode === "MANGEKYO" && session?.status === "EDITING") {
    return <MangekyoWorkspace safeSessionId={session.id} onModeChange={setMode} />;
  }

  return (
    <div
      className="execute-workspace"
      aria-busy={busy || preparing || approvedExecutionActive}
    >
      <WorkspaceHeader
        eyebrow={`BOUNDED CHANGE / ${project.name.toUpperCase()}`}
        title="Execute"
        description="Safe Mode separates an approved design direction from a new, proposal-specific mutation approval. No source changes occur before that second human gate."
        actions={
          <ModeSwitcher
            mode="SAFE"
            onChange={setMode}
            mangekyoDisabled={session?.status !== "EDITING"}
          />
        }
      />
      <p className="safe-activity" role="status" aria-live="polite">
        <span aria-hidden="true" />
        {activityFor(session, busy, activeAction)}
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
                session.status === "REVISING"
                  ? "PREPARE_REVISION"
                  : "PREPARE_PROPOSAL",
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

      {preparing || approvedExecutionActive ? (
        <p className="analysis-status" role="status">
          {session.status === "APPROVED"
            ? "Approval persisted. Applying only the exact approved delta…"
            : "Preparing a structured Change Proposal in read-only analysis space…"}
        </p>
      ) : null}

      {session?.status === "APPROVED" && session.executionFailure ? (
        <section
          className="decision-outcome"
          aria-labelledby="reconciliation-required-title"
        >
          <p className="utility-label">APPROVAL RETAINED / REPLAY BLOCKED</p>
          <h2 id="reconciliation-required-title">
            Mutation reconciliation required
          </h2>
          <p>{session.executionFailure.reason}</p>
          <p>
            The target outcome is indeterminate. Inspect these exact paths before
            any further execution: {session.executionFailure.affectedPaths.join(", ")}.
          </p>
        </section>
      ) : null}

      {session?.status === "WAITING_APPROVAL" && session.proposal ? (
        <>
          <ChangeProposalView proposal={session.proposal} />
          <ApprovalActions
            busy={busy}
            onApprove={() =>
              void runAction(
                "APPROVE_PROPOSAL",
                "/approve",
                {},
                "Approved mutation applied",
              )
            }
            onRevision={(instruction) =>
              void runAction(
                "REQUEST_REVISION",
                "/decision",
                {
                  decision: "REVISION_REQUESTED",
                  comment: instruction,
                },
                "Revision requested",
              )
            }
            onReject={() =>
              void runAction(
                "REJECT_PROPOSAL",
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
          {git?.note ? <p>{git.note}</p> : null}
          <div className="mutation-evidence__diff">
            <h3>Authoritative approved delta</h3>
            <pre>{git?.diffAfter || git?.note || "Git diff evidence is unavailable."}</pre>
            {git?.truncation.diffAfter.truncated ? (
              <p>
                Git diff evidence truncated: retained {git.truncation.diffAfter.retainedBytes}
                {" "}of {git.truncation.diffAfter.originalBytes} UTF-8 bytes.
              </p>
            ) : null}
          </div>
          <p>No auto-commit was created.</p>
          <p>Fresh render and verification continue in Task 10; this session remains truthfully at EDITING.</p>
        </section>
      ) : null}
    </div>
  );
}
