import { isAbsolute, join, posix } from "node:path";
import type {
  Approval,
  ChangeProposal,
  DesignApproach,
  DesignSession,
  FeatureBrief,
  SafeMutationFailureEvidence,
  SafeExecutionStatus,
  RenderArtifact,
  VisualFinding,
  VisualIntegrityVerification,
  UXImpact,
} from "@design-sharingan/core";
import { canTransitionSafeExecution } from "@design-sharingan/core";
import { assertPathInsideWorkspace } from "./path-policy";
import {
  ensureDesignWorkspace,
  isFeatureEvolveApprovedSession,
  isSafeExecutionDraftSession,
  listSessions,
  loadSession,
  saveSession,
  assertRenderArtifactIntegrity,
  withLearnTransitionClaim,
} from "./workspace-store";
import type {
  FeatureEvolveApprovedSession,
  SafeExecutionDraftSession,
} from "./workspace-store";

interface SafeExecutionBase extends DesignSession {
  type: "SAFE_EXECUTION";
  sourceSessionId: string;
  approvedApproachId: string;
  approvalId: string;
  featureBrief: FeatureBrief;
  designApproach: DesignApproach;
}

export interface SafeProposalHistoryEntry {
  proposal: ChangeProposal;
  proposalThreadId: string;
  proposedAt: string;
  decisionApproval?: Approval;
  renderVerification?: { render: RenderArtifact; analysis: SafeRenderVerification };
}

export interface SafeExecutionPreparingSession extends SafeExecutionBase {
  status: "PREPARING";
}

export interface SafeExecutionProposingSession extends SafeExecutionBase {
  status: "PROPOSING";
  revisionRequest?: string;
  previousProposal?: ChangeProposal;
  previousProposalThreadId?: string;
  proposalHistory?: SafeProposalHistoryEntry[];
  verifiedMutation?: SafeExecutionVerificationSession;
}

export interface SafeExecutionWaitingSession extends SafeExecutionBase {
  status: "WAITING_APPROVAL";
  proposal: ChangeProposal;
  proposalThreadId: string;
  proposalHistory: SafeProposalHistoryEntry[];
}

export interface SafeExecutionDecisionSession extends SafeExecutionBase {
  status: "REVISING" | "REJECTED";
  proposal: ChangeProposal;
  proposalThreadId: string;
  decisionApproval: Approval;
  proposalHistory: SafeProposalHistoryEntry[];
}

export interface SafeExecutionApprovedSession extends SafeExecutionBase {
  status: "APPROVED";
  proposal: ChangeProposal;
  proposalThreadId: string;
  mutationApproval: Approval;
  proposalHistory: SafeProposalHistoryEntry[];
  executionFailure?: SafeMutationFailureEvidence;
}

export interface SafeGitEvidence {
  available: boolean;
  branch?: string;
  statusBefore: string;
  statusAfter: string;
  diffAfter: string;
  truncation: {
    branch: SafeGitEvidenceTruncation;
    statusBefore: SafeGitEvidenceTruncation;
    statusAfter: SafeGitEvidenceTruncation;
    diffAfter: SafeGitEvidenceTruncation;
  };
  note?: string;
}

export interface SafeGitEvidenceTruncation {
  truncated: boolean;
  limitBytes: number;
  originalBytes: number;
  retainedBytes: number;
}

export interface SafeMutationResult {
  proposalId: string;
  threadId: string;
  filesChanged: string[];
  git: SafeGitEvidence;
}

export interface SafeMutationEvidence extends SafeMutationResult {
  completedAt: string;
}

export interface SafeExecutionEditingSession extends SafeExecutionBase {
  status: "EDITING";
  proposal: ChangeProposal;
  proposalThreadId: string;
  mutationApproval: Approval;
  mutationEvidence: SafeMutationEvidence;
  proposalHistory: SafeProposalHistoryEntry[];
}

export interface SafeRenderVerification {
  threadId: string;
  findings: VisualFinding[];
  verification: Record<"uxIntegrity" | "productConsistency" | "accessibility" | "genomeIntegrity", VisualIntegrityVerification>;
}
export interface SafeExecutionVerificationSession extends Omit<SafeExecutionEditingSession, "status"> {
  status: "RUNNING" | "CAPTURING" | "VERIFYING" | "COMPLETE" | "FAILED";
  render?: RenderArtifact;
  analysis?: SafeRenderVerification;
  error?: string;
}

export type SafeExecutionSession =
  | SafeExecutionDraftSession
  | SafeExecutionPreparingSession
  | SafeExecutionProposingSession
  | SafeExecutionWaitingSession
  | SafeExecutionDecisionSession
  | SafeExecutionApprovedSession
  | SafeExecutionEditingSession
  | SafeExecutionVerificationSession;
// A completed mutation continues through the same durable Safe session.
export type SafeExecutionLifecycleSession = SafeExecutionSession | SafeExecutionVerificationSession;
export type SafeExecutionAppliedSession = SafeExecutionEditingSession | SafeExecutionVerificationSession;

type PrepareSource = SafeExecutionProposingSession;

const baseKeys = [
  "id",
  "projectId",
  "type",
  "status",
  "createdAt",
  "updatedAt",
  "sourceSessionId",
  "approvedApproachId",
  "approvalId",
  "featureBrief",
  "designApproach",
] as const;

function exactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function nonEmpty(value: unknown, maximum = 4_000): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    Buffer.byteLength(value, "utf8") <= maximum
  );
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || value.length !== 24) return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

function safeIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value)
  );
}

function safeRelativePath(path: string): boolean {
  return (
    path.length > 0 &&
    Buffer.byteLength(path, "utf8") <= 512 &&
    !/[\u0000-\u001f\u007f]/.test(path) &&
    !path.includes("\\") &&
    !path.startsWith("/") &&
    !isAbsolute(path) &&
    path !== "." &&
    path !== ".." &&
    !path
      .split("/")
      .some((segment) => segment === "" || segment === "." || segment === "..") &&
    posix.normalize(path) === path
  );
}

function protectedPath(path: string): boolean {
  const segments = path.toLowerCase().split("/");
  const first = segments[0];
  const fileName = segments.at(-1) ?? "";
  return (
    first === ".git" ||
    first === ".design-sharingan" ||
    first === "design-governance" ||
    segments.includes(".direnv") ||
    fileName === ".env" ||
    fileName.startsWith(".env.") ||
    fileName.startsWith(".envrc") ||
    fileName.endsWith(".env")
  );
}

function validProposalPaths(value: ChangeProposal): boolean {
  const paths = [
    ...value.filesToCreate,
    ...value.filesToModify,
    ...value.filesToDelete,
  ];
  return (
    paths.length > 0 &&
    paths.length <= 128 &&
    new Set(paths).size === paths.length &&
    paths.every((path) => safeRelativePath(path) && !protectedPath(path))
  );
}

function stringArray(
  value: unknown,
  maximumItems: number,
  maximumItemLength: number,
): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= maximumItems &&
    value.every((entry) => nonEmpty(entry, maximumItemLength))
  );
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

function isFeatureBrief(value: unknown): value is FeatureBrief {
  return (
    exactKeys(value, [
      "name",
      "goal",
      "description",
      "constraints",
      "mustKeep",
      "mustNotChange",
      "successCriteria",
    ]) &&
    nonEmpty(value.name) &&
    nonEmpty(value.goal) &&
    nonEmpty(value.description) &&
    stringArray(value.constraints, 32, 1_000) &&
    stringArray(value.mustKeep, 32, 1_000) &&
    stringArray(value.mustNotChange, 32, 1_000) &&
    stringArray(value.successCriteria, 32, 1_000)
  );
}

function isUxImpact(value: unknown): value is UXImpact {
  return (
    exactKeys(value, [
      "area",
      "severity",
      "reason",
      "affectedRoutes",
      "affectedComponents",
      "decisionRequired",
    ]) &&
    nonEmpty(value.area, 256) &&
    ["CRITICAL", "IMPORTANT", "POLISH", "IGNORE"].includes(
      value.severity as string,
    ) &&
    nonEmpty(value.reason, 2_000) &&
    stringArray(value.affectedRoutes, 16, 512) &&
    stringArray(value.affectedComponents, 16, 512) &&
    typeof value.decisionRequired === "boolean"
  );
}

function isDesignApproach(value: unknown): value is DesignApproach {
  return (
    exactKeys(value, [
      "id",
      "title",
      "summary",
      "recommended",
      "pros",
      "cons",
      "uxImpact",
      "estimatedComplexity",
      "genomeFit",
      "likelyFiles",
      "status",
    ]) &&
    nonEmpty(value.id, 128) &&
    nonEmpty(value.title, 256) &&
    nonEmpty(value.summary, 2_000) &&
    typeof value.recommended === "boolean" &&
    stringArray(value.pros, 12, 1_000) &&
    value.pros.length > 0 &&
    stringArray(value.cons, 12, 1_000) &&
    value.cons.length > 0 &&
    Array.isArray(value.uxImpact) &&
    value.uxImpact.length > 0 &&
    value.uxImpact.length <= 8 &&
    value.uxImpact.every(isUxImpact) &&
    nonEmpty(value.estimatedComplexity, 256) &&
    nonEmpty(value.genomeFit, 2_000) &&
    stringArray(value.likelyFiles, 32, 512) &&
    value.likelyFiles.length > 0 &&
    value.status === "PROPOSED"
  );
}

function isApproval(value: unknown): value is Approval {
  const required = [
    "id",
    "proposalId",
    "decision",
    "scope",
    "approvedBy",
    "createdAt",
  ];
  const keys =
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.hasOwn(value, "comment")
      ? [...required.slice(0, 5), "comment", "createdAt"]
      : required;
  return (
    exactKeys(value, keys) &&
    safeIdentifier(value.id) &&
    safeIdentifier(value.proposalId) &&
    ["APPROVED", "REJECTED", "REVISION_REQUESTED"].includes(
      value.decision as string,
    ) &&
    nonEmpty(value.scope, 128) &&
    nonEmpty(value.approvedBy, 256) &&
    (value.comment === undefined ||
      (typeof value.comment === "string" &&
        Buffer.byteLength(value.comment, "utf8") <= 2_000)) &&
    isIsoTimestamp(value.createdAt)
  );
}

function isChangeProposal(value: unknown): value is ChangeProposal {
  return (
    exactKeys(value, [
      "id",
      "sessionId",
      "summary",
      "reason",
      "filesToCreate",
      "filesToModify",
      "filesToDelete",
      "componentsAffected",
      "screensAffected",
      "uxImpact",
      "visualImpact",
      "riskLevel",
      "requiresHumanApproval",
      "policyViolations",
      "status",
    ]) &&
    safeIdentifier(value.id) &&
    safeIdentifier(value.sessionId) &&
    nonEmpty(value.summary) &&
    nonEmpty(value.reason) &&
    stringArray(value.filesToCreate, 64, 512) &&
    stringArray(value.filesToModify, 64, 512) &&
    stringArray(value.filesToDelete, 64, 512) &&
    stringArray(value.componentsAffected, 32, 1_000) &&
    stringArray(value.screensAffected, 64, 512) &&
    Array.isArray(value.uxImpact) &&
    value.uxImpact.length > 0 &&
    value.uxImpact.length <= 16 &&
    value.uxImpact.every(isUxImpact) &&
    nonEmpty(value.visualImpact) &&
    ["LOW", "MEDIUM", "HIGH", "CRITICAL"].includes(value.riskLevel as string) &&
    value.requiresHumanApproval === true &&
    stringArray(value.policyViolations, 32, 1_000) &&
    value.status === "PROPOSED" &&
    validProposalPaths(value as unknown as ChangeProposal)
  );
}

function isProposalHistory(
  value: unknown,
  sessionId: string,
  sessionCreatedAt: string,
): value is SafeProposalHistoryEntry[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 16) {
    return false;
  }
  const ids = new Set<string>();
  const approvalIds = new Set<string>();
  let threadId: string | undefined;
  let priorDecisionAt: string | undefined;
  for (let index = 0; index < value.length; index += 1) {
    const entry = value[index];
    const keys =
      entry !== null &&
      typeof entry === "object" &&
      !Array.isArray(entry) &&
      Object.hasOwn(entry, "decisionApproval")
        ? ["proposal", "proposalThreadId", "proposedAt", "decisionApproval"]
        : ["proposal", "proposalThreadId", "proposedAt"];
    if (entry && typeof entry === "object" && Object.hasOwn(entry, "renderVerification")) keys.push("renderVerification");
    if (
      !exactKeys(entry, keys) ||
      !isChangeProposal(entry.proposal) ||
      entry.proposal.sessionId !== sessionId ||
      ids.has(entry.proposal.id) ||
      !nonEmpty(entry.proposalThreadId, 256) ||
      !isIsoTimestamp(entry.proposedAt) ||
      Date.parse(entry.proposedAt) < Date.parse(sessionCreatedAt) ||
      (threadId !== undefined && entry.proposalThreadId !== threadId) ||
      (priorDecisionAt !== undefined &&
        Date.parse(entry.proposedAt) < Date.parse(priorDecisionAt))
    ) {
      return false;
    }
    ids.add(entry.proposal.id);
    threadId ??= entry.proposalThreadId;
    if (entry.decisionApproval === undefined) {
      if (index !== value.length - 1) return false;
      priorDecisionAt = undefined;
      continue;
    }
    if (
      !isApproval(entry.decisionApproval) ||
      approvalIds.has(entry.decisionApproval.id) ||
      entry.decisionApproval.scope !== "CHANGE_PROPOSAL" ||
      entry.decisionApproval.proposalId !== entry.proposal.id ||
      (entry.decisionApproval.decision === "REVISION_REQUESTED" &&
        !nonEmpty(entry.decisionApproval.comment, 2_000)) ||
      Date.parse(entry.decisionApproval.createdAt) < Date.parse(entry.proposedAt) ||
      (index < value.length - 1 &&
        entry.decisionApproval.decision !== "REVISION_REQUESTED" &&
        !(entry.decisionApproval.decision === "APPROVED" && entry.renderVerification !== undefined))
    ) {
      return false;
    }
    if (entry.renderVerification !== undefined) {
      const proof = entry.renderVerification;
      if (!exactKeys(proof, ["render", "analysis"]) || !proof.render || typeof proof.render !== "object") return false;
      const render = proof.render as RenderArtifact;
      if (render.sessionId !== sessionId || !isIsoTimestamp(render.capturedAt) || Date.parse(render.capturedAt) < Date.parse(entry.decisionApproval.createdAt) || !render.sourceRevision?.available || !isSafeRenderVerification(proof.analysis, render.route) || safeVerificationComplete(proof.analysis) || entry.decisionApproval.decision !== "APPROVED") return false;
    }
    approvalIds.add(entry.decisionApproval.id);
    priorDecisionAt = entry.decisionApproval.createdAt;
  }
  return true;
}

function historyMatchesCurrent(
  history: SafeProposalHistoryEntry[],
  proposal: ChangeProposal,
  proposalThreadId: string,
  decision?: Approval,
): boolean {
  const current = history.at(-1);
  return (
    current !== undefined &&
    stableJson(current.proposal) === stableJson(proposal) &&
    current.proposalThreadId === proposalThreadId &&
    (decision === undefined
      ? current.decisionApproval === undefined
      : stableJson(current.decisionApproval) === stableJson(decision))
  );
}

function isSafeBase(value: unknown): value is SafeExecutionBase {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const session = value as Partial<SafeExecutionBase>;
  return (
    safeIdentifier(session.id) &&
    safeIdentifier(session.projectId) &&
    session.type === "SAFE_EXECUTION" &&
    nonEmpty(session.status, 64) &&
    isIsoTimestamp(session.createdAt) &&
    isIsoTimestamp(session.updatedAt) &&
    Date.parse(session.updatedAt) >= Date.parse(session.createdAt) &&
    safeIdentifier(session.sourceSessionId) &&
    safeIdentifier(session.approvedApproachId) &&
    safeIdentifier(session.approvalId) &&
    isFeatureBrief(session.featureBrief) &&
    isDesignApproach(session.designApproach)
  );
}

function isGitEvidenceTruncation(
  value: unknown,
  evidence: string,
): value is SafeGitEvidenceTruncation {
  if (
    !exactKeys(value, [
      "truncated",
      "limitBytes",
      "originalBytes",
      "retainedBytes",
    ]) ||
    typeof value.truncated !== "boolean" ||
    value.limitBytes !== 128 * 1024 ||
    typeof value.originalBytes !== "number" ||
    !Number.isSafeInteger(value.originalBytes) ||
    value.originalBytes < 0 ||
    typeof value.retainedBytes !== "number" ||
    !Number.isSafeInteger(value.retainedBytes) ||
    value.retainedBytes < 0 ||
    value.retainedBytes !== Buffer.byteLength(evidence, "utf8") ||
    value.retainedBytes > value.limitBytes
  ) {
    return false;
  }
  return value.truncated
    ? value.originalBytes > value.limitBytes
    : value.originalBytes === value.retainedBytes;
}

function isGitEvidenceTruncationSet(
  value: unknown,
  evidence: {
    branch?: string;
    statusBefore: string;
    statusAfter: string;
    diffAfter: string;
  },
): value is SafeGitEvidence["truncation"] {
  return (
    exactKeys(value, ["branch", "statusBefore", "statusAfter", "diffAfter"]) &&
    isGitEvidenceTruncation(value.branch, evidence.branch ?? "") &&
    isGitEvidenceTruncation(value.statusBefore, evidence.statusBefore) &&
    isGitEvidenceTruncation(value.statusAfter, evidence.statusAfter) &&
    isGitEvidenceTruncation(value.diffAfter, evidence.diffAfter)
  );
}

function isSafeGitEvidence(value: unknown): value is SafeGitEvidence {
  const keys =
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value)
      ? [
          "available",
          ...(Object.hasOwn(value, "branch") ? ["branch"] : []),
          "statusBefore",
          "statusAfter",
          "diffAfter",
          "truncation",
          ...(Object.hasOwn(value, "note") ? ["note"] : []),
        ]
      : [];
  return (
    exactKeys(value, keys) &&
    typeof value.available === "boolean" &&
    (value.branch === undefined || nonEmpty(value.branch, 512)) &&
    typeof value.statusBefore === "string" &&
    Buffer.byteLength(value.statusBefore, "utf8") <= 128 * 1024 &&
    typeof value.statusAfter === "string" &&
    Buffer.byteLength(value.statusAfter, "utf8") <= 128 * 1024 &&
    typeof value.diffAfter === "string" &&
    Buffer.byteLength(value.diffAfter, "utf8") <= 128 * 1024 &&
    isGitEvidenceTruncationSet(value.truncation, {
      ...(typeof value.branch === "string" ? { branch: value.branch } : {}),
      statusBefore: value.statusBefore,
      statusAfter: value.statusAfter,
      diffAfter: value.diffAfter,
    }) &&
    (value.note === undefined || nonEmpty(value.note, 2_000))
  );
}

function isSafeMutationFailureEvidence(
  value: unknown,
): value is SafeMutationFailureEvidence {
  return (
    exactKeys(value, [
      "kind",
      "targetDisposition",
      "reason",
      "affectedPaths",
      "occurredAt",
    ]) &&
    value.kind === "SAFE_MUTATION_FAILURE" &&
    [
      "NO_TARGET_CHANGE",
      "FULLY_ROLLED_BACK",
      "RECONCILIATION_REQUIRED",
    ].includes(value.targetDisposition as string) &&
    nonEmpty(value.reason, 2_000) &&
    stringArray(value.affectedPaths, 128, 512) &&
    value.affectedPaths.length > 0 &&
    isIsoTimestamp(value.occurredAt)
  );
}

function isMutationEvidence(value: unknown): value is SafeMutationEvidence {
  return (
    exactKeys(value, [
      "proposalId",
      "threadId",
      "filesChanged",
      "git",
      "completedAt",
    ]) &&
    nonEmpty(value.proposalId, 128) &&
    nonEmpty(value.threadId, 256) &&
    stringArray(value.filesChanged, 128, 512) &&
    value.filesChanged.length > 0 &&
    isSafeGitEvidence(value.git) &&
    isIsoTimestamp(value.completedAt)
  );
}

export function isSafeRenderVerification(value: unknown, route?: string): value is SafeRenderVerification {
  if (!exactKeys(value, ["threadId", "findings", "verification"]) || !nonEmpty(value.threadId, 256) || !Array.isArray(value.findings) || value.findings.length > 64 || !exactKeys(value.verification, ["uxIntegrity", "productConsistency", "accessibility", "genomeIntegrity"])) return false;
  return Object.values(value.verification).every((check) => exactKeys(check, ["status", "evidence"]) && ["PASS", "REGRESSION", "CONFLICT", "NOT_VERIFIED"].includes(check.status as string) && stringArray(check.evidence, 16, 2000) && check.evidence.length > 0) && value.findings.every((finding) => exactKeys(finding, ["id", "severity", "category", "screen", "description", "evidence", "reason", "recommendedAction", "status"]) && safeIdentifier(finding.id) && ["CRITICAL", "IMPORTANT", "POLISH", "IGNORE"].includes(finding.severity as string) && finding.screen === route && nonEmpty(finding.category, 40) && nonEmpty(finding.description) && nonEmpty(finding.reason) && nonEmpty(finding.recommendedAction) && finding.status === "OPEN" && stringArray(finding.evidence, 16, 2000) && finding.evidence.length > 0);
}
function safeVerificationComplete(analysis: SafeRenderVerification): boolean {
  return !analysis.findings.some((finding) => ["CRITICAL", "IMPORTANT"].includes(finding.severity)) && [analysis.verification.uxIntegrity, analysis.verification.productConsistency, analysis.verification.accessibility].every((check) => check.status === "PASS") && ["PASS", "NOT_VERIFIED"].includes(analysis.verification.genomeIntegrity.status);
}

export function isSafeExecutionSession(value: unknown): value is SafeExecutionSession {
  if (!isSafeBase(value)) return false;
  const session = value as Partial<SafeExecutionSession> & Record<string, unknown>;
  if (["RUNNING", "CAPTURING", "VERIFYING", "COMPLETE", "FAILED"].includes(session.status as string)) {
    const record = value as SafeExecutionVerificationSession;
    const { render, analysis, error, ...editing } = record;
    if (!isSafeExecutionSession({ ...editing, status: "EDITING", updatedAt: record.mutationEvidence?.completedAt }) || !exactKeys(value, [...baseKeys, "proposal", "proposalThreadId", "mutationApproval", "mutationEvidence", "proposalHistory", ...(render === undefined ? [] : ["render"]), ...(analysis === undefined ? [] : ["analysis"]), ...(error === undefined ? [] : ["error"])])) return false;
    if (Date.parse(record.updatedAt) < Date.parse(record.mutationEvidence.completedAt)) return false;
    if (render !== undefined && (render.sessionId !== record.id || !safeIdentifier(render.id) || !isIsoTimestamp(render.capturedAt) || Date.parse(render.capturedAt) < Date.parse(record.mutationEvidence.completedAt) || !render.sourceRevision.available || render.sourceRevision.truncated)) return false;
    if (analysis !== undefined && !isSafeRenderVerification(analysis, render?.route)) return false;
    if (record.status === "RUNNING" || record.status === "CAPTURING") return render === undefined && analysis === undefined && error === undefined;
    if (record.status === "FAILED") return nonEmpty(error);
    return render !== undefined && error === undefined && (record.status === "VERIFYING" || (analysis !== undefined && safeVerificationComplete(analysis)));
  }
  switch (session.status) {
    case "IDLE":
      return isSafeExecutionDraftSession(value);
    case "PREPARING":
      return exactKeys(value, baseKeys);
    case "PROPOSING": {
      if (Object.hasOwn(value, "verifiedMutation")) {
        const prior = session.verifiedMutation as SafeExecutionVerificationSession;
        return exactKeys(value, [...baseKeys, "revisionRequest", "previousProposal", "previousProposalThreadId", "proposalHistory", "verifiedMutation"]) && isSafeExecutionSession(prior) && prior.status === "VERIFYING" && prior.analysis !== undefined && !safeVerificationComplete(prior.analysis) && prior.id === session.id && prior.projectId === session.projectId && stableJson(prior.proposal) === stableJson(session.previousProposal) && prior.proposalThreadId === session.previousProposalThreadId && stableJson(prior.proposalHistory) === stableJson(session.proposalHistory) && nonEmpty(session.revisionRequest, 2000);
      }
      const keys = [
        ...baseKeys,
        ...(Object.hasOwn(value, "revisionRequest") ? ["revisionRequest"] : []),
        ...(Object.hasOwn(value, "previousProposal") ? ["previousProposal"] : []),
        ...(Object.hasOwn(value, "previousProposalThreadId")
          ? ["previousProposalThreadId"]
          : []),
        ...(Object.hasOwn(value, "proposalHistory") ? ["proposalHistory"] : []),
      ];
      return (
        exactKeys(value, keys) &&
        (session.revisionRequest === undefined ||
          nonEmpty(session.revisionRequest, 2_000)) &&
        (session.previousProposal === undefined ||
          isChangeProposal(session.previousProposal)) &&
        (session.previousProposalThreadId === undefined ||
          nonEmpty(session.previousProposalThreadId, 256)) &&
        ((session.revisionRequest === undefined &&
          session.previousProposal === undefined &&
          session.previousProposalThreadId === undefined &&
          session.proposalHistory === undefined) ||
          (session.revisionRequest !== undefined &&
            session.previousProposal !== undefined &&
            session.previousProposalThreadId !== undefined &&
            isProposalHistory(
              session.proposalHistory,
              session.id as string,
              session.createdAt as string,
            ) &&
            historyMatchesCurrent(
              session.proposalHistory,
              session.previousProposal,
              session.previousProposalThreadId,
              session.proposalHistory.at(-1)?.decisionApproval,
            ) &&
            session.proposalHistory.at(-1)?.decisionApproval?.decision ===
              "REVISION_REQUESTED" &&
            session.proposalHistory.at(-1)?.decisionApproval?.comment ===
              session.revisionRequest &&
            Date.parse(session.updatedAt as string) >=
              Date.parse(
                session.proposalHistory.at(-1)?.decisionApproval?.createdAt as string,
              )))
      );
    }
    case "WAITING_APPROVAL":
      return (
        exactKeys(value, [
          ...baseKeys,
          "proposal",
          "proposalThreadId",
          "proposalHistory",
        ]) &&
        isChangeProposal(session.proposal) &&
        session.proposal.sessionId === session.id &&
        nonEmpty(session.proposalThreadId, 256) &&
        isProposalHistory(
          session.proposalHistory,
          session.id,
          session.createdAt as string,
        ) &&
        historyMatchesCurrent(
          session.proposalHistory,
          session.proposal,
          session.proposalThreadId,
        ) &&
        session.proposalHistory.at(-1)?.proposedAt === session.updatedAt
      );
    case "REVISING":
    case "REJECTED":
      return (
        exactKeys(value, [
          ...baseKeys,
          "proposal",
          "proposalThreadId",
          "decisionApproval",
          "proposalHistory",
        ]) &&
        isChangeProposal(session.proposal) &&
        session.proposal.sessionId === session.id &&
        nonEmpty(session.proposalThreadId, 256) &&
        isApproval(session.decisionApproval) &&
        session.decisionApproval.proposalId === session.proposal.id &&
        session.decisionApproval.scope === "CHANGE_PROPOSAL" &&
        (session.status === "REVISING"
          ? session.decisionApproval.decision === "REVISION_REQUESTED"
          : session.decisionApproval.decision === "REJECTED") &&
        (session.status !== "REVISING" ||
          nonEmpty(session.decisionApproval.comment, 2_000)) &&
        isProposalHistory(
          session.proposalHistory,
          session.id,
          session.createdAt as string,
        ) &&
        historyMatchesCurrent(
          session.proposalHistory,
          session.proposal,
          session.proposalThreadId,
          session.decisionApproval,
        ) &&
        session.updatedAt === session.decisionApproval.createdAt
      );
    case "APPROVED":
      {
        const hasExecutionFailure = Object.hasOwn(value, "executionFailure");
      return (
        exactKeys(value, [
          ...baseKeys,
          "proposal",
          "proposalThreadId",
          "mutationApproval",
          "proposalHistory",
          ...(hasExecutionFailure ? ["executionFailure"] : []),
        ]) &&
        isChangeProposal(session.proposal) &&
        session.proposal.sessionId === session.id &&
        nonEmpty(session.proposalThreadId, 256) &&
        isApproval(session.mutationApproval) &&
        session.mutationApproval.decision === "APPROVED" &&
        session.mutationApproval.scope === "CHANGE_PROPOSAL" &&
        session.mutationApproval.proposalId === session.proposal.id &&
        isProposalHistory(
          session.proposalHistory,
          session.id,
          session.createdAt as string,
        ) &&
        historyMatchesCurrent(
          session.proposalHistory,
          session.proposal,
          session.proposalThreadId,
          session.mutationApproval,
        ) &&
        (hasExecutionFailure
          ? isSafeMutationFailureEvidence(session.executionFailure) &&
            session.executionFailure.targetDisposition ===
              "RECONCILIATION_REQUIRED" &&
            stableJson(session.executionFailure.affectedPaths) ===
              stableJson([
                ...session.proposal.filesToCreate,
                ...session.proposal.filesToModify,
                ...session.proposal.filesToDelete,
              ]) &&
            session.updatedAt === session.executionFailure.occurredAt &&
            Date.parse(session.executionFailure.occurredAt) >=
              Date.parse(session.mutationApproval.createdAt)
          : session.updatedAt === session.mutationApproval.createdAt)
      );
      }
    case "EDITING":
      return (
        exactKeys(value, [
          ...baseKeys,
          "proposal",
          "proposalThreadId",
          "mutationApproval",
          "mutationEvidence",
          "proposalHistory",
        ]) &&
        isChangeProposal(session.proposal) &&
        session.proposal.sessionId === session.id &&
        nonEmpty(session.proposalThreadId, 256) &&
        isApproval(session.mutationApproval) &&
        session.mutationApproval.decision === "APPROVED" &&
        session.mutationApproval.scope === "CHANGE_PROPOSAL" &&
        session.mutationApproval.proposalId === session.proposal.id &&
        isMutationEvidence(session.mutationEvidence) &&
        session.mutationEvidence.proposalId === session.proposal.id &&
        session.mutationEvidence.threadId === session.proposalThreadId &&
        stableJson(session.mutationEvidence.filesChanged) ===
          stableJson([
            ...session.proposal.filesToCreate,
            ...session.proposal.filesToModify,
            ...session.proposal.filesToDelete,
          ]) &&
        session.mutationEvidence.completedAt === session.updatedAt &&
        Date.parse(session.mutationApproval.createdAt) <=
          Date.parse(session.mutationEvidence.completedAt) &&
        isProposalHistory(
          session.proposalHistory,
          session.id,
          session.createdAt as string,
        ) &&
        historyMatchesCurrent(
          session.proposalHistory,
          session.proposal,
          session.proposalThreadId,
          session.mutationApproval,
        )
      );
    default:
      return false;
  }
}

async function saveSafeExecutionSession(
  rootPath: string,
  session: SafeExecutionSession,
): Promise<void> {
  if (!isSafeExecutionSession(session)) {
    throw new Error("Safe execution writer rejected invalid session evidence");
  }
  await saveSession(rootPath, session);
}

export function assertSafeExecutionSourceRelation(
  projectId: string,
  session: SafeExecutionSession,
  source: FeatureEvolveApprovedSession,
): void {
  const approval = source.approval;
  const selected = source.approaches.find(
    (entry) => entry.id === source.approvedApproachId,
  );
  if (
    selected === undefined ||
    session.projectId !== projectId ||
    source.projectId !== projectId ||
    session.sourceSessionId !== source.id ||
    source.executeSessionId !== session.id ||
    session.approvedApproachId !== source.approvedApproachId ||
    session.approvalId !== approval.id ||
    approval.decision !== "APPROVED" ||
    approval.scope !== "DESIGN_APPROACH" ||
    approval.proposalId !== selected.id ||
    !isIsoTimestamp(source.createdAt) ||
    !isIsoTimestamp(source.updatedAt) ||
    !isIsoTimestamp(approval.createdAt) ||
    source.updatedAt !== approval.createdAt ||
    Date.parse(source.updatedAt) < Date.parse(source.createdAt) ||
    session.createdAt !== approval.createdAt ||
    stableJson(session.featureBrief) !== stableJson(source.featureBrief) ||
    stableJson(session.designApproach) !== stableJson(selected)
  ) {
    throw new Error("Safe execution approval and source evidence do not match");
  }
}

export async function loadSafeExecutionState(
  rootPath: string,
  projectId: string,
): Promise<SafeExecutionSession> {
  try {
    const history = await loadSafeExecutionHistory(rootPath, projectId);
    const active = history.filter((session) => !["COMPLETE", "FAILED", "REJECTED"].includes(session.status) && !(session.status === "APPROVED" && session.executionFailure !== undefined));
    if (active.length > 1 || history.length === 0) {
      throw new Error("Safe execution state is missing, ambiguous, or invalid");
    }
    return active[0] ?? [...history].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || right.id.localeCompare(left.id))[0]!;
  } catch (error) {
    // A process can be interrupted after replacing the session record but
    // before its activity journal reaches disk. Recover only that explicit
    // checkpoint gap; malformed or ambiguous Safe history still fails closed.
    const message = error instanceof Error ? error.message : "";
    if (!/checkpoint|latest immutable/i.test(message)) throw error;
    const sessions = await listSessions(rootPath, projectId, false);
    const safeRecords = sessions.filter((session) => session.type === "SAFE_EXECUTION");
    if (safeRecords.length !== 1) {
      throw new Error("Safe execution state is missing, ambiguous, or invalid");
    }
    const session = safeRecords[0]!;
    if (!isSafeExecutionSession(session)) {
      throw new Error("Safe execution state is invalid");
    }
    const source = await loadSession(rootPath, projectId, session.sourceSessionId);
    if (!isFeatureEvolveApprovedSession(source)) {
      throw new Error("Approved Feature EVOLVE source evidence is invalid");
    }
    assertSafeExecutionSourceRelation(projectId, session, source);
    await saveSession(rootPath, session);
    return session;
  }
}

/** Retain the final capture and failed verification evidence across new proposals. */
export function safeExecutionRenders(session: SafeExecutionSession): RenderArtifact[] {
  return [
    ...("render" in session && session.render !== undefined ? [session.render] : []),
    ...("verifiedMutation" in session && session.verifiedMutation?.render !== undefined ? [session.verifiedMutation.render] : []),
    ...("proposalHistory" in session ? (session.proposalHistory ?? []).flatMap((entry) => entry.renderVerification === undefined ? [] : [entry.renderVerification.render]) : []),
  ];
}

async function authenticateRetainedSafeRenders(rootPath: string, session: SafeExecutionSession): Promise<void> {
  for (const render of safeExecutionRenders(session)) {
    if (render.sessionId !== session.id) throw new Error("Safe render belongs to another session");
    await assertRenderArtifactIntegrity(rootPath, render);
  }
}

/** Authenticate all retained Safe sessions; active selection separately rejects multiple unfinished directions. */
export async function loadSafeExecutionHistory(
  rootPath: string,
  projectId: string,
): Promise<SafeExecutionSession[]> {
  const sessions = await listSessions(rootPath, projectId);
  const safeRecords = sessions.filter((session) => session.type === "SAFE_EXECUTION");
  const authenticated: SafeExecutionSession[] = [];
  for (const record of safeRecords) {
    if (!isSafeExecutionSession(record)) {
      throw new Error("Safe execution history contains invalid evidence");
    }
    const source = await loadSession(rootPath, projectId, record.sourceSessionId);
    if (!isFeatureEvolveApprovedSession(source)) {
      throw new Error("Approved Feature EVOLVE source evidence is invalid");
    }
    assertSafeExecutionSourceRelation(projectId, record, source);
    await authenticateRetainedSafeRenders(rootPath, record);
    authenticated.push(record);
  }
  return authenticated;
}

/** Authenticate only Safe records already selected by the committed page index. */
export async function loadSafeExecutionHistoryForSessions(
  rootPath: string,
  projectId: string,
  sessions: readonly DesignSession[],
): Promise<SafeExecutionSession[]> {
  const authenticated: SafeExecutionSession[] = [];
  const ids = new Set<string>();
  for (const record of sessions) {
    if (
      record.projectId !== projectId || record.type !== "SAFE_EXECUTION" ||
      ids.has(record.id) || !isSafeExecutionSession(record)
    ) throw new Error("Visible Safe execution evidence is invalid or ambiguous");
    ids.add(record.id);
    // The directly linked approval is required authentication evidence. No
    // unrelated retained Safe/session body is opened for a page projection.
    const source = await loadSession(rootPath, projectId, record.sourceSessionId);
    if (!isFeatureEvolveApprovedSession(source)) {
      throw new Error("Approved Feature EVOLVE source evidence is invalid");
    }
    assertSafeExecutionSourceRelation(projectId, record, source);
    await authenticateRetainedSafeRenders(rootPath, record);
    authenticated.push(record);
  }
  return authenticated;
}

/** Authenticate the one Safe execution named by an approved Feature source. */
export async function loadSafeExecutionForSource(
  rootPath: string,
  projectId: string,
  source: FeatureEvolveApprovedSession,
): Promise<SafeExecutionSession> {
  if (source.projectId !== projectId || !isFeatureEvolveApprovedSession(source)) {
    throw new Error("Approved Feature EVOLVE source evidence is invalid");
  }
  const record = await loadSession(rootPath, projectId, source.executeSessionId);
  if (!isSafeExecutionSession(record)) {
    throw new Error("Linked Safe execution evidence is invalid");
  }
  assertSafeExecutionSourceRelation(projectId, record, source);
  await authenticateRetainedSafeRenders(rootPath, record);
  return record;
}

async function withSessionClaim<T>(
  rootPath: string,
  projectId: string,
  sessionId: string,
  action: () => Promise<T>,
): Promise<T> {
  const source = await loadSession(rootPath, projectId, sessionId);
  return withLearnTransitionClaim(rootPath, projectId, sessionId, source.status, action, "safe-execution");
}

function transitionedBase<TStatus extends SafeExecutionStatus>(
  source: SafeExecutionBase,
  status: TStatus,
): SafeExecutionBase & { status: TStatus } {
  if (!canTransitionSafeExecution(source.status as SafeExecutionStatus, status)) {
    throw new Error(`Safe execution transition from ${source.status} to ${status} is invalid`);
  }
  return {
    id: source.id,
    projectId: source.projectId,
    type: "SAFE_EXECUTION",
    status,
    createdAt: source.createdAt,
    updatedAt: new Date().toISOString(),
    sourceSessionId: source.sourceSessionId,
    approvedApproachId: source.approvedApproachId,
    approvalId: source.approvalId,
    featureBrief: source.featureBrief,
    designApproach: source.designApproach,
  };
}

export async function prepareSafeExecutionProposal(
  rootPath: string,
  projectId: string,
  sessionId: string,
  runProposal: (
    source: PrepareSource,
  ) => Promise<{ proposal: ChangeProposal; threadId: string }>,
): Promise<SafeExecutionWaitingSession> {
  return withSessionClaim(rootPath, projectId, sessionId, async () => {
    const starting = await loadSafeExecutionState(rootPath, projectId);
    if (
      starting.id !== sessionId ||
      (starting.status !== "IDLE" && starting.status !== "REVISING" && !(starting.status === "PROPOSING" && starting.verifiedMutation !== undefined))
    ) {
      throw new Error("Safe execution is not ready to prepare a proposal");
    }
    try {
      let proposing: SafeExecutionProposingSession;
      if (starting.status === "IDLE") {
        const preparing = transitionedBase(starting, "PREPARING");
        await saveSafeExecutionSession(rootPath, preparing);
        proposing = transitionedBase(preparing, "PROPOSING");
      } else if (starting.status === "PROPOSING") {
        proposing = starting;
      } else {
        if (starting.proposalHistory.length >= 16) {
          throw new Error("Safe Mode proposal history is at its bounded limit");
        }
        proposing = {
          ...transitionedBase(starting, "PROPOSING"),
          revisionRequest: starting.decisionApproval.comment as string,
          previousProposal: starting.proposal,
          previousProposalThreadId: starting.proposalThreadId,
          proposalHistory: starting.proposalHistory,
        };
      }
      await saveSafeExecutionSession(rootPath, proposing);
      const generated = await runProposal(proposing);
      if (
        !isChangeProposal(generated.proposal) ||
        generated.proposal.sessionId !== starting.id ||
        !nonEmpty(generated.threadId, 256) ||
        (starting.status === "REVISING" &&
          generated.threadId !== starting.proposalThreadId)
      ) {
        throw new Error("Generated Safe Mode proposal evidence is invalid");
      }
      const waitingBase = transitionedBase(proposing, "WAITING_APPROVAL");
      const waiting: SafeExecutionWaitingSession = {
        ...waitingBase,
        proposal: generated.proposal,
        proposalThreadId: generated.threadId,
        proposalHistory: [
          ...(proposing.proposalHistory ?? []),
          {
            proposal: generated.proposal,
            proposalThreadId: generated.threadId,
            proposedAt: waitingBase.updatedAt,
          },
        ],
      };
      if (!isSafeExecutionSession(waiting)) {
        throw new Error("Safe Mode proposal checkpoint is invalid");
      }
      await saveSafeExecutionSession(rootPath, waiting);
      return waiting;
    } catch (error) {
      await saveSafeExecutionSession(rootPath, starting).catch((rollbackError) => {
        throw new Error("Safe Mode proposal and rollback both failed", {
          cause: { proposalError: error, rollbackError },
        });
      });
      throw error;
    }
  });
}

function assertProposalDecision(
  waiting: SafeExecutionWaitingSession,
  approval: Approval,
): void {
  if (
    !isApproval(approval) ||
    approval.scope !== "CHANGE_PROPOSAL" ||
    approval.proposalId !== waiting.proposal.id
  ) {
    throw new Error("Safe Mode approval scope or proposal evidence is invalid");
  }
}

export async function decideSafeExecutionProposal(
  rootPath: string,
  projectId: string,
  sessionId: string,
  approval: Approval,
): Promise<SafeExecutionDecisionSession> {
  return withSessionClaim(rootPath, projectId, sessionId, async () => {
    const state = await loadSafeExecutionState(rootPath, projectId);
    if (state.id !== sessionId || state.status !== "WAITING_APPROVAL") {
      throw new Error("Safe execution is not waiting for a proposal decision");
    }
    assertProposalDecision(state, approval);
    const status =
      approval.decision === "REVISION_REQUESTED"
        ? "REVISING"
        : approval.decision === "REJECTED"
          ? "REJECTED"
          : undefined;
    if (status === undefined || !canTransitionSafeExecution(state.status, status)) {
      throw new Error("Safe Mode non-execution decision is invalid");
    }
    if (
      status === "REVISING" &&
      !nonEmpty(approval.comment?.trim(), 2_000)
    ) {
      throw new Error("Safe Mode revision requires a bounded instruction");
    }
    const proposalHistory = state.proposalHistory.map((entry, index) =>
      index === state.proposalHistory.length - 1
        ? { ...entry, decisionApproval: approval }
        : entry,
    );
    const decided: SafeExecutionDecisionSession = {
      ...transitionedBase(state, status),
      updatedAt: approval.createdAt,
      proposal: state.proposal,
      proposalThreadId: state.proposalThreadId,
      decisionApproval: approval,
      proposalHistory,
    };
    if (!isSafeExecutionSession(decided)) {
      throw new Error("Safe Mode decision checkpoint is invalid");
    }
    await saveSafeExecutionSession(rootPath, decided);
    return decided;
  });
}

function assertMutationResult(
  approved: SafeExecutionApprovedSession,
  result: SafeMutationResult,
): void {
  const expectedFiles = [
    ...approved.proposal.filesToCreate,
    ...approved.proposal.filesToModify,
    ...approved.proposal.filesToDelete,
  ];
  if (
    result === null ||
    typeof result !== "object" ||
    result.proposalId !== approved.proposal.id ||
    result.threadId !== approved.proposalThreadId ||
    !stringArray(result.filesChanged, 128, 512) ||
    stableJson(result.filesChanged) !== stableJson(expectedFiles) ||
    !isSafeGitEvidence(result.git)
  ) {
    throw new Error("Safe Mode mutation evidence is invalid");
  }
}

function classifiedExecutionFailure(
  error: unknown,
  approved: SafeExecutionApprovedSession,
): SafeMutationFailureEvidence | undefined {
  const failure =
    error !== null && typeof error === "object" && "failure" in error
      ? error.failure
      : undefined;
  const expectedPaths = [
    ...approved.proposal.filesToCreate,
    ...approved.proposal.filesToModify,
    ...approved.proposal.filesToDelete,
  ];
  return isSafeMutationFailureEvidence(failure) &&
    stableJson(failure.affectedPaths) === stableJson(expectedPaths) &&
    Date.parse(failure.occurredAt) >= Date.parse(approved.mutationApproval.createdAt)
    ? failure
    : undefined;
}

function reconciliationFailure(
  error: unknown,
  approved: SafeExecutionApprovedSession,
): SafeMutationFailureEvidence {
  const classified = classifiedExecutionFailure(error, approved);
  if (classified?.targetDisposition === "RECONCILIATION_REQUIRED") {
    return classified;
  }
  return {
    kind: "SAFE_MUTATION_FAILURE",
    targetDisposition: "RECONCILIATION_REQUIRED",
    reason:
      "Execution ended without proof that the approved target delta was absent or fully rolled back.",
    affectedPaths: [
      ...approved.proposal.filesToCreate,
      ...approved.proposal.filesToModify,
      ...approved.proposal.filesToDelete,
    ],
    occurredAt: new Date().toISOString(),
  };
}

async function persistReconciliationCheckpoint(
  rootPath: string,
  approved: SafeExecutionApprovedSession,
  error: unknown,
): Promise<void> {
  const executionFailure = reconciliationFailure(error, approved);
  const reconciliation: SafeExecutionApprovedSession = {
    ...approved,
    updatedAt: executionFailure.occurredAt,
    executionFailure,
  };
  await saveSafeExecutionSession(rootPath, reconciliation).catch(
    (checkpointError) => {
      throw new Error(
        "Safe Mode execution and reconciliation checkpoint both failed",
        { cause: { executionError: error, checkpointError } },
      );
    },
  );
}

/** A hard crash cannot run the executor's catch handler. Authenticate its abandoned APPLYING claim before publishing recovery-only state. */
export async function recoverInterruptedSafeExecution(
  rootPath: string,
  projectId: string,
  inspectClaim: () => Promise<{ claimId: string; proposalId: string; phase: "PREPARING" | "APPLYING"; ownerState: "ACTIVE" | "ABANDONED" } | undefined>,
): Promise<SafeExecutionSession> {
  const source = await loadSafeExecutionState(rootPath, projectId);
  if (source.status !== "APPROVED" || source.executionFailure !== undefined) return source;
  const claim = await inspectClaim();
  if (claim === undefined || !/^[a-f0-9]{64}$/.test(claim.claimId) || claim.proposalId !== source.proposal.id || claim.phase !== "APPLYING" || claim.ownerState !== "ABANDONED") return source;
  return withSessionClaim(rootPath, projectId, source.id, async () => {
    const current = await loadSafeExecutionState(rootPath, projectId);
    const currentClaim = await inspectClaim();
    if (current.id !== source.id || current.status !== "APPROVED" || current.executionFailure !== undefined || stableJson(current) !== stableJson(source) || stableJson(currentClaim ?? null) !== stableJson(claim)) throw new Error("Interrupted mutation claim or approved checkpoint changed");
    await persistReconciliationCheckpoint(rootPath, current, new Error("Authenticated abandoned target mutation requires explicit recovery"));
    return loadSafeExecutionState(rootPath, projectId);
  });
}

export async function approveAndExecuteSafeProposal(
  rootPath: string,
  projectId: string,
  sessionId: string,
  approval: Approval,
  execute: (
    approved: SafeExecutionApprovedSession,
  ) => Promise<SafeMutationResult>,
): Promise<SafeExecutionEditingSession> {
  return withSessionClaim(rootPath, projectId, sessionId, async () => {
    const waiting = await loadSafeExecutionState(rootPath, projectId);
    if (waiting.id !== sessionId || waiting.status !== "WAITING_APPROVAL") {
      throw new Error("Safe execution is not waiting for mutation approval");
    }
    assertProposalDecision(waiting, approval);
    if (
      approval.decision !== "APPROVED" ||
      !canTransitionSafeExecution(waiting.status, "APPROVED")
    ) {
      throw new Error("Safe Mode execution requires an approved decision");
    }
    const approved: SafeExecutionApprovedSession = {
      ...transitionedBase(waiting, "APPROVED"),
      updatedAt: approval.createdAt,
      proposal: waiting.proposal,
      proposalThreadId: waiting.proposalThreadId,
      mutationApproval: approval,
      proposalHistory: waiting.proposalHistory.map((entry, index) =>
        index === waiting.proposalHistory.length - 1
          ? { ...entry, decisionApproval: approval }
          : entry,
      ),
    };
    if (!isSafeExecutionSession(approved)) {
      throw new Error("Safe Mode approval checkpoint is invalid");
    }
    await saveSafeExecutionSession(rootPath, approved);
    let result: SafeMutationResult;
    try {
      result = await execute(approved);
    } catch (error) {
      const classified = classifiedExecutionFailure(error, approved);
      if (
        classified?.targetDisposition === "NO_TARGET_CHANGE" ||
        classified?.targetDisposition === "FULLY_ROLLED_BACK"
      ) {
        await saveSafeExecutionSession(rootPath, waiting).catch((rollbackError) => {
          throw new Error("Safe Mode execution and checkpoint rollback both failed", {
            cause: { executionError: error, rollbackError },
          });
        });
        throw error;
      }
      await persistReconciliationCheckpoint(rootPath, approved, error);
      throw error;
    }
    // A resolved executor may already have changed the active target. From
    // this point onward, preserve the durable approval on any evidence or
    // persistence failure so a retry cannot replay that mutation.
    try {
      assertMutationResult(approved, result);
      const completedAt = new Date().toISOString();
      const editing: SafeExecutionEditingSession = {
        ...transitionedBase(approved, "EDITING"),
        updatedAt: completedAt,
        proposal: approved.proposal,
        proposalThreadId: approved.proposalThreadId,
        mutationApproval: approved.mutationApproval,
        mutationEvidence: { ...result, completedAt },
        proposalHistory: approved.proposalHistory,
      };
      if (!isSafeExecutionSession(editing)) {
        throw new Error("Safe Mode editing checkpoint is invalid");
      }
      await saveSafeExecutionSession(rootPath, editing);
      return editing;
    } catch (error) {
      await persistReconciliationCheckpoint(rootPath, approved, error);
      throw error;
    }
  });
}

/** Render/process callbacks live in their packages; this owns durable Safe transitions and evidence authority. */
export async function verifySafeExecution(rootPath: string, projectId: string, sessionId: string, dependencies: {
  run(): Promise<void>;
  capture(session: SafeExecutionEditingSession): Promise<RenderArtifact>;
  verify(render: RenderArtifact): Promise<SafeRenderVerification>;
  currentSourceFingerprint(): Promise<string>;
  stop(): Promise<void>;
}): Promise<SafeExecutionVerificationSession | SafeExecutionProposingSession> {
  return withSessionClaim(rootPath, projectId, sessionId, async () => {
    const source = await loadSafeExecutionState(rootPath, projectId);
    if (source.id !== sessionId || source.status !== "EDITING") throw new Error("Safe execution is not ready for fresh verification");
    let session: SafeExecutionVerificationSession = { ...source, status: "RUNNING", updatedAt: new Date().toISOString() };
    try {
      await saveSafeExecutionSession(rootPath, session);
      await dependencies.run();
      session = { ...session, status: "CAPTURING", updatedAt: new Date().toISOString() };
      await saveSafeExecutionSession(rootPath, session);
      const render = await dependencies.capture(source);
      await assertRenderArtifactIntegrity(rootPath, render);
      if (render.sessionId !== session.id || Date.parse(render.capturedAt) < Date.parse(source.mutationEvidence.completedAt) || !render.sourceRevision.available || render.sourceRevision.truncated || render.sourceRevision.worktreeFingerprint !== await dependencies.currentSourceFingerprint()) throw new Error("Fresh render does not match the final approved mutation");
      session = { ...session, status: "VERIFYING", render, updatedAt: new Date().toISOString() };
      await saveSafeExecutionSession(rootPath, session);
      const analysis = await dependencies.verify(render);
      if (!isSafeRenderVerification(analysis, render.route) || render.sourceRevision.worktreeFingerprint !== await dependencies.currentSourceFingerprint()) throw new Error("Verification evidence is invalid or source changed after capture");
      session = { ...session, analysis, updatedAt: new Date().toISOString() };
      await saveSafeExecutionSession(rootPath, session);
      if (safeVerificationComplete(analysis)) {
        session = { ...session, status: "COMPLETE", updatedAt: new Date().toISOString() };
        await saveSafeExecutionSession(rootPath, session);
        return session;
      }
      session = { ...session, proposalHistory: session.proposalHistory.map((entry, index) => index === session.proposalHistory.length - 1 ? { ...entry, renderVerification: { render, analysis } } : entry) };
      await saveSafeExecutionSession(rootPath, session);
      const proposing: SafeExecutionProposingSession = { ...transitionedBase(session, "PROPOSING"), revisionRequest: "Fresh render verification requires another bounded proposal. Preserve all UX and product invariants and request a new human approval before any mutation.", previousProposal: session.proposal, previousProposalThreadId: session.proposalThreadId, proposalHistory: session.proposalHistory, verifiedMutation: session };
      await saveSafeExecutionSession(rootPath, proposing);
      return proposing;
    } catch {
      const failed: SafeExecutionVerificationSession = { ...session, status: "FAILED", error: "Fresh render verification did not complete. Applied mutation is preserved; automatic replay is blocked.", updatedAt: new Date().toISOString() };
      await saveSafeExecutionSession(rootPath, failed);
      return failed;
    } finally { await dependencies.stop(); }
  });
}
