import type {
  ActivityEvidenceReference,
  ActivityEvent,
  Approval,
  DesignSession,
  DesignSessionType,
} from "@design-sharingan/core";
import { listActivityEvents } from "./workspace-store";
import {
  isFeatureEvolveApprovedSession,
  isFeatureEvolvePendingSession,
  isFeatureEvolveResultSession,
  loadReference,
  loadReferenceDesignDNA,
  loadReferenceImage,
  isReferenceScanPendingSession,
  isReferenceScanResultSession,
  listSessions,
} from "./workspace-store";
import { isMangekyoLoopSession, loadMangekyoLoopSession } from "./mangekyo-loop-store";
import { isSafeExecutionSession, loadSafeExecutionState } from "./safe-execution-store";

const MAX_PAGE_SIZE = 50;
const MAX_EVIDENCE = 32;
const MAX_FILES = 32;
const MAX_APPROVALS = 16;
const MAX_ACTIVITY = 100;
const SECRET_PATTERN = /(?:sk-[a-zA-Z0-9_-]{8,}|gh[pousr]_[a-zA-Z0-9]{8,}|AKIA[A-Z0-9]{12,}|Bearer\s+[a-zA-Z0-9._-]{8,}|(?:api[_-]?key|token|secret|password)\s*[:=]\s*[^\s,;]+)/gi;
const PATH_PATTERN = /(?:\/(?:[a-zA-Z0-9._-]+\/)+[a-zA-Z0-9._-]+|[A-Za-z]:\\[^\s,;]+)/g;
const GOVERNANCE_SESSION_TYPES = ["GENOME_INIT", "DRIFT_AUDIT", "RELEASE_GATE"] as const;
const CANONICAL_IDENTIFIER = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;

export type ReportSessionResult =
  | "PENDING"
  | "IN_PROGRESS"
  | "AWAITING_APPROVAL"
  | "APPROVED"
  | "COMPLETE"
  | "REJECTED"
  | "BLOCKED"
  | "FAILED"
  | "NOT_VERIFIED";

export interface ReportApproval {
  id: string;
  decision: Approval["decision"] | "APPROVE_ONCE" | "EXPAND_SCOPE" | "REJECT";
  occurredAt: string;
}

export interface ReportSession {
  id: string;
  type: DesignSessionType;
  status: string;
  result: ReportSessionResult;
  createdAt: string;
  updatedAt: string;
  durationMs: number;
  evidence: ActivityEvidenceReference[];
  filesChanged: string[];
  approvals: ReportApproval[];
  visualRounds: number;
  git?: ReportGitEvidence;
}

export interface ReportGitEvidence {
  available: boolean;
  branch?: string;
  statusBefore: string;
  statusAfter: string;
  diffAfter: string;
  note?: string;
}

export interface ProjectReport {
  total: number;
  offset: number;
  limit: number;
  sessions: ReportSession[];
  activity: readonly ActivityEvent[];
}

export interface ReportPage {
  offset: number;
  limit: number;
}

function boundedUnique(values: readonly string[], maximum: number): string[] {
  return [...new Set(values.filter((value) => typeof value === "string" && value.length > 0))]
    .sort((left, right) => left.localeCompare(right))
    .slice(0, maximum);
}

export function redactReportEvidence(value: string): string {
  return value
    .replace(SECRET_PATTERN, "[REDACTED]")
    .replace(PATH_PATTERN, "[REDACTED]")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 4_000);
}

function boundedEvidence(
  evidence: readonly ActivityEvidenceReference[],
): ActivityEvidenceReference[] {
  const seen = new Set<string>();
  return evidence.filter((entry) => {
    const identity = `${entry.kind}:${entry.id}`;
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  }).slice(0, MAX_EVIDENCE).map((entry) => ({ ...entry }));
}

function stableJson(value: unknown): string {
  function sort(entry: unknown): unknown {
    if (Array.isArray(entry)) return entry.map(sort);
    if (entry !== null && typeof entry === "object") {
      return Object.fromEntries(
        Object.entries(entry)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, nested]) => [key, sort(nested)]),
      );
    }
    return entry;
  }
  return JSON.stringify(sort(value));
}

function resultFor(status: string): ReportSessionResult {
  if (["DRAFT", "IDLE", "PREPARING", "PROPOSING", "POLICY_CHECK", "FIXING"].includes(status)) return "PENDING";
  if (["ANALYZING", "EDITING", "RUNNING", "CAPTURING", "COMPARING", "DECIDING", "REVISING"].includes(status)) return "IN_PROGRESS";
  if (["WAITING_APPROVAL", "AWAITING_DECISION", "HUMAN_GATE"].includes(status)) return "AWAITING_APPROVAL";
  if (status === "APPROVED") return "APPROVED";
  if (status === "COMPLETE" || status === "RESULT_READY") return "COMPLETE";
  if (status === "REJECTED") return "REJECTED";
  if (status === "BLOCKED") return "BLOCKED";
  if (status === "FAILED") return "FAILED";
  return "NOT_VERIFIED";
}

function isGovernanceReportSession(session: DesignSession): boolean {
  const value = session as unknown as Record<string, unknown>;
  const required = ["id", "projectId", "type", "status", "createdAt", "updatedAt"];
  return (
    Object.keys(value).length === required.length &&
    required.every((key) => Object.hasOwn(value, key)) &&
    GOVERNANCE_SESSION_TYPES.includes(session.type as (typeof GOVERNANCE_SESSION_TYPES)[number]) &&
    CANONICAL_IDENTIFIER.test(session.id) &&
    CANONICAL_IDENTIFIER.test(session.projectId) &&
    typeof session.status === "string" && session.status.length > 0 && session.status.length <= 64 &&
    new Date(session.createdAt).toISOString() === session.createdAt &&
    new Date(session.updatedAt).toISOString() === session.updatedAt &&
    Date.parse(session.updatedAt) >= Date.parse(session.createdAt)
  );
}

function baseReport(session: DesignSession): ReportSession {
  const durationMs = Date.parse(session.updatedAt) - Date.parse(session.createdAt);
  if (!Number.isSafeInteger(durationMs) || durationMs < 0) {
    throw new Error("Report session timestamps are invalid");
  }
  return {
    id: session.id,
    type: session.type,
    status: session.status,
    result: resultFor(session.status),
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    durationMs,
    evidence: [{ kind: "SESSION", id: session.id, label: "Session record" }],
    filesChanged: [],
    approvals: [],
    visualRounds: 0,
  };
}

function reportForSession(session: DesignSession): ReportSession {
  const report = baseReport(session);
  if (isReferenceScanPendingSession(session) || isReferenceScanResultSession(session)) {
    report.evidence = boundedEvidence([
      ...report.evidence,
      { kind: "REFERENCE", id: session.referenceId, label: session.referenceTitle.slice(0, 160) },
    ]);
    return report;
  }
  if (
    isFeatureEvolvePendingSession(session) ||
    isFeatureEvolveResultSession(session) ||
    isFeatureEvolveApprovedSession(session)
  ) {
    report.evidence = boundedEvidence([
      ...report.evidence,
      ...session.referenceIds.map((id) => ({ kind: "REFERENCE" as const, id, label: "Reference evidence" })),
    ]);
    if (isFeatureEvolveApprovedSession(session)) {
      report.approvals = [{ id: session.approval.id, decision: session.approval.decision, occurredAt: session.approval.createdAt }];
      report.evidence = boundedEvidence([
        ...report.evidence,
        { kind: "APPROVAL", id: session.approval.id, label: "Design approach approval" },
      ]);
    }
    return report;
  }
  if (isSafeExecutionSession(session)) {
    const proposal = "proposal" in session ? session.proposal : undefined;
    const mutation = "mutationEvidence" in session ? session.mutationEvidence : undefined;
    const approvals = [
      ...("mutationApproval" in session ? [session.mutationApproval] : []),
      ...("decisionApproval" in session ? [session.decisionApproval] : []),
    ];
    report.filesChanged = boundedUnique(mutation?.filesChanged ?? [], MAX_FILES);
    report.approvals = approvals.slice(0, MAX_APPROVALS).map((approval) => ({
      id: approval.id,
      decision: approval.decision,
      occurredAt: approval.createdAt,
    }));
    report.evidence = boundedEvidence([
      ...report.evidence,
      ...(proposal === undefined ? [] : [{ kind: "APPROVAL" as const, id: proposal.id, label: "Change proposal" }]),
      ...report.approvals.map((approval) => ({ kind: "APPROVAL" as const, id: approval.id, label: "Human decision" })),
      ...(mutation === undefined ? [] : [{ kind: "GIT" as const, id: mutation.proposalId, label: "Mutation evidence" }]),
    ]);
    if (mutation !== undefined) {
      report.git = {
        available: mutation.git.available,
        ...(mutation.git.branch === undefined ? {} : { branch: redactReportEvidence(mutation.git.branch) }),
        statusBefore: redactReportEvidence(mutation.git.statusBefore),
        statusAfter: redactReportEvidence(mutation.git.statusAfter),
        diffAfter: redactReportEvidence(mutation.git.diffAfter),
        ...(mutation.git.note === undefined ? {} : { note: redactReportEvidence(mutation.git.note) }),
      };
    }
    return report;
  }
  if (isMangekyoLoopSession(session)) {
    const approvals = session.gateDecisions.slice(-MAX_APPROVALS).map((decision) => ({
      id: decision.id,
      decision: decision.decision,
      occurredAt: decision.createdAt,
    }));
    const renders = [
      session.initialRender,
      session.finalRender,
      ...session.rounds.flatMap(({ round }) => [round.beforeRender, round.afterRender]),
    ].filter((render): render is NonNullable<typeof render> => render !== undefined);
    report.filesChanged = boundedUnique(
      session.rounds.flatMap(({ round }) => round.filesChanged),
      MAX_FILES,
    );
    report.approvals = approvals;
    report.visualRounds = session.rounds.length;
    report.evidence = boundedEvidence([
      ...report.evidence,
      ...session.referenceIds.map((id) => ({ kind: "REFERENCE" as const, id, label: "Reference evidence" })),
      ...renders.map((render) => ({ kind: "RENDER" as const, id: render.id, label: `${render.viewport} ${render.route}`.slice(0, 160) })),
      ...approvals.map((approval) => ({ kind: "APPROVAL" as const, id: approval.id, label: "Human Gate decision" })),
    ]);
    return report;
  }
  if (isGovernanceReportSession(session)) return report;
  throw new Error("Report session type or durable artifact is not recognized");
}

async function assertReferenceEvidence(
  rootPath: string,
  projectId: string,
  session: DesignSession,
): Promise<void> {
  if (isReferenceScanPendingSession(session) || isReferenceScanResultSession(session)) {
    const reference = await loadReference(rootPath, projectId, session.referenceId);
    if (reference.title !== session.referenceTitle) {
      throw new Error("Reference scan report evidence does not match its reference");
    }
    await loadReferenceImage(rootPath, projectId, session.referenceId);
    if (isReferenceScanResultSession(session)) {
      if (reference.analysisStatus !== "ANALYZED") {
        throw new Error("Reference scan report is missing analyzed reference evidence");
      }
      const persistedDesignDNA = await loadReferenceDesignDNA(
        rootPath,
        projectId,
        session.referenceId,
      );
      if (
        session.designDNA.referenceIds.length !== 1 ||
        session.designDNA.referenceIds[0] !== session.referenceId ||
        stableJson(persistedDesignDNA) !== stableJson(session.designDNA)
      ) {
        throw new Error("Reference scan report DesignDNA evidence does not match");
      }
    }
    return;
  }

  if (
    isFeatureEvolvePendingSession(session) ||
    isFeatureEvolveResultSession(session) ||
    isFeatureEvolveApprovedSession(session)
  ) {
    await Promise.all(session.referenceIds.map(async (referenceId) => {
      const reference = await loadReference(rootPath, projectId, referenceId);
      await loadReferenceImage(rootPath, projectId, referenceId);
      if (reference.analysisStatus !== "ANALYZED") {
        throw new Error("Feature EVOLVE report is missing analyzed reference evidence");
      }
      const designDNA = await loadReferenceDesignDNA(rootPath, projectId, referenceId);
      if (designDNA.referenceIds.length !== 1 || designDNA.referenceIds[0] !== referenceId) {
        throw new Error("Feature EVOLVE report reference provenance is invalid");
      }
    }));
  }
}

function assertPage(page: ReportPage): void {
  if (
    !Number.isSafeInteger(page.offset) || page.offset < 0 || page.offset > 100_000 ||
    !Number.isSafeInteger(page.limit) || page.limit < 1 || page.limit > MAX_PAGE_SIZE
  ) throw new Error("Report pagination is invalid");
}

async function assertAuthenticatedSessions(
  rootPath: string,
  projectId: string,
  sessions: readonly DesignSession[],
): Promise<void> {
  const safeSessions = sessions.filter(({ type }) => type === "SAFE_EXECUTION");
  if (safeSessions.length > 0) {
    const safe = await loadSafeExecutionState(rootPath, projectId);
    if (safeSessions.length !== 1 || safeSessions[0]?.id !== safe.id) {
      throw new Error("Safe execution report evidence is ambiguous");
    }
  }
  await Promise.all(sessions.filter(({ type }) => type === "MANGEKYO_LOOP").map(async (session) => {
    const authenticated = await loadMangekyoLoopSession(rootPath, projectId, session.id);
    if (authenticated.id !== session.id) throw new Error("Mangekyō report evidence is invalid");
  }));
  await Promise.all(sessions.map((session) => assertReferenceEvidence(rootPath, projectId, session)));
  for (const session of sessions) reportForSession(session);
}

/**
 * Read-only, project-scoped report projection. Session and artifact records
 * are revalidated before data crosses the server boundary; malformed or
 * cross-project records fail the complete request closed.
 */
export async function loadProjectReport(
  rootPath: string,
  projectId: string,
  page: ReportPage,
): Promise<ProjectReport> {
  assertPage(page);
  const sessions = await listSessions(rootPath, projectId);
  await assertAuthenticatedSessions(rootPath, projectId, sessions);
  const selected = sessions.slice(page.offset, page.offset + page.limit);
  const visibleSessionIds = new Set(selected.map(({ id }) => id));
  const [activity, reportSessions] = await Promise.all([
    listActivityEvents(rootPath, projectId),
    Promise.resolve(selected.map(reportForSession)),
  ]);
  return {
    total: sessions.length,
    offset: page.offset,
    limit: page.limit,
    sessions: reportSessions,
    activity: activity.filter((event) => visibleSessionIds.has(event.sessionId)).slice(0, MAX_ACTIVITY),
  };
}
