import { constants } from "node:fs";
import { open, rm } from "node:fs/promises";
import { join } from "node:path";
import type {
  Approval,
  ChangeProposal,
  DesignApproach,
  DesignSession,
  FeatureBrief,
  SafeExecutionStatus,
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

export interface SafeExecutionPreparingSession extends SafeExecutionBase {
  status: "PREPARING";
}

export interface SafeExecutionProposingSession extends SafeExecutionBase {
  status: "PROPOSING";
  revisionRequest?: string;
  previousProposal?: ChangeProposal;
  previousProposalThreadId?: string;
}

export interface SafeExecutionWaitingSession extends SafeExecutionBase {
  status: "WAITING_APPROVAL";
  proposal: ChangeProposal;
  proposalThreadId: string;
}

export interface SafeExecutionDecisionSession extends SafeExecutionBase {
  status: "REVISING" | "REJECTED";
  proposal: ChangeProposal;
  proposalThreadId: string;
  decisionApproval: Approval;
}

export interface SafeExecutionApprovedSession extends SafeExecutionBase {
  status: "APPROVED";
  proposal: ChangeProposal;
  proposalThreadId: string;
  mutationApproval: Approval;
}

export interface SafeGitEvidence {
  available: boolean;
  branch?: string;
  statusBefore: string;
  statusAfter: string;
  diffAfter: string;
  note?: string;
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
}

export type SafeExecutionSession =
  | SafeExecutionDraftSession
  | SafeExecutionPreparingSession
  | SafeExecutionProposingSession
  | SafeExecutionWaitingSession
  | SafeExecutionDecisionSession
  | SafeExecutionApprovedSession
  | SafeExecutionEditingSession;

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
    value.length <= maximum
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
    nonEmpty(value.id, 128) &&
    nonEmpty(value.proposalId, 128) &&
    ["APPROVED", "REJECTED", "REVISION_REQUESTED"].includes(
      value.decision as string,
    ) &&
    nonEmpty(value.scope, 128) &&
    nonEmpty(value.approvedBy, 256) &&
    (value.comment === undefined ||
      (typeof value.comment === "string" && value.comment.length <= 2_000)) &&
    nonEmpty(value.createdAt, 64)
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
    nonEmpty(value.id, 128) &&
    nonEmpty(value.sessionId, 128) &&
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
    [
      ...value.filesToCreate,
      ...value.filesToModify,
      ...value.filesToDelete,
    ].length > 0 &&
    new Set([
      ...value.filesToCreate,
      ...value.filesToModify,
      ...value.filesToDelete,
    ]).size ===
      [
        ...value.filesToCreate,
        ...value.filesToModify,
        ...value.filesToDelete,
      ].length
  );
}

function isSafeBase(value: unknown): value is SafeExecutionBase {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const session = value as Partial<SafeExecutionBase>;
  return (
    nonEmpty(session.id, 128) &&
    nonEmpty(session.projectId, 128) &&
    session.type === "SAFE_EXECUTION" &&
    nonEmpty(session.status, 64) &&
    nonEmpty(session.createdAt, 64) &&
    nonEmpty(session.updatedAt, 64) &&
    nonEmpty(session.sourceSessionId, 128) &&
    nonEmpty(session.approvedApproachId, 128) &&
    nonEmpty(session.approvalId, 128) &&
    isFeatureBrief(session.featureBrief) &&
    isDesignApproach(session.designApproach)
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
          ...(Object.hasOwn(value, "note") ? ["note"] : []),
        ]
      : [];
  return (
    exactKeys(value, keys) &&
    typeof value.available === "boolean" &&
    (value.branch === undefined || nonEmpty(value.branch, 512)) &&
    typeof value.statusBefore === "string" &&
    value.statusBefore.length <= 128 * 1024 &&
    typeof value.statusAfter === "string" &&
    value.statusAfter.length <= 128 * 1024 &&
    typeof value.diffAfter === "string" &&
    value.diffAfter.length <= 128 * 1024 &&
    (value.note === undefined || nonEmpty(value.note, 2_000))
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
    nonEmpty(value.completedAt, 64)
  );
}

function isSafeExecutionSession(value: unknown): value is SafeExecutionSession {
  if (!isSafeBase(value)) return false;
  const session = value as Partial<SafeExecutionSession> & Record<string, unknown>;
  switch (session.status) {
    case "IDLE":
      return isSafeExecutionDraftSession(value);
    case "PREPARING":
      return exactKeys(value, baseKeys);
    case "PROPOSING": {
      const keys = [
        ...baseKeys,
        ...(Object.hasOwn(value, "revisionRequest") ? ["revisionRequest"] : []),
        ...(Object.hasOwn(value, "previousProposal") ? ["previousProposal"] : []),
        ...(Object.hasOwn(value, "previousProposalThreadId")
          ? ["previousProposalThreadId"]
          : []),
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
          session.previousProposalThreadId === undefined) ||
          (session.revisionRequest !== undefined &&
            session.previousProposal !== undefined &&
            session.previousProposalThreadId !== undefined))
      );
    }
    case "WAITING_APPROVAL":
      return (
        exactKeys(value, [...baseKeys, "proposal", "proposalThreadId"]) &&
        isChangeProposal(session.proposal) &&
        session.proposal.sessionId === session.id &&
        nonEmpty(session.proposalThreadId, 256)
      );
    case "REVISING":
    case "REJECTED":
      return (
        exactKeys(value, [
          ...baseKeys,
          "proposal",
          "proposalThreadId",
          "decisionApproval",
        ]) &&
        isChangeProposal(session.proposal) &&
        session.proposal.sessionId === session.id &&
        nonEmpty(session.proposalThreadId, 256) &&
        isApproval(session.decisionApproval) &&
        session.decisionApproval.proposalId === session.proposal.id &&
        session.decisionApproval.scope === "CHANGE_PROPOSAL" &&
        (session.status === "REVISING"
          ? session.decisionApproval.decision === "REVISION_REQUESTED"
          : session.decisionApproval.decision === "REJECTED")
      );
    case "APPROVED":
      return (
        exactKeys(value, [
          ...baseKeys,
          "proposal",
          "proposalThreadId",
          "mutationApproval",
        ]) &&
        isChangeProposal(session.proposal) &&
        session.proposal.sessionId === session.id &&
        nonEmpty(session.proposalThreadId, 256) &&
        isApproval(session.mutationApproval) &&
        session.mutationApproval.decision === "APPROVED" &&
        session.mutationApproval.scope === "CHANGE_PROPOSAL" &&
        session.mutationApproval.proposalId === session.proposal.id
      );
    case "EDITING":
      return (
        exactKeys(value, [
          ...baseKeys,
          "proposal",
          "proposalThreadId",
          "mutationApproval",
          "mutationEvidence",
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
        session.mutationEvidence.threadId === session.proposalThreadId
      );
    default:
      return false;
  }
}

function assertSourceRelation(
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
  const sessions = await listSessions(rootPath, projectId);
  const safeRecords = sessions.filter((session) => session.type === "SAFE_EXECUTION");
  if (safeRecords.length !== 1 || !isSafeExecutionSession(safeRecords[0])) {
    throw new Error("Safe execution state is missing, ambiguous, or invalid");
  }
  const safeSession = safeRecords[0];
  const source = await loadSession(rootPath, projectId, safeSession.sourceSessionId);
  if (!isFeatureEvolveApprovedSession(source)) {
    throw new Error("Approved Feature EVOLVE source evidence is invalid");
  }
  assertSourceRelation(projectId, safeSession, source);
  return safeSession;
}

async function acquireSessionClaim(
  rootPath: string,
  projectId: string,
  sessionId: string,
): Promise<{ handle: Awaited<ReturnType<typeof open>>; path: string }> {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(sessionId)) {
    throw new Error("Safe execution session id is invalid");
  }
  // Validate the project/session locator before touching its runtime claim.
  await loadSession(rootPath, projectId, sessionId);
  const workspace = await ensureDesignWorkspace(rootPath);
  const claimPath = assertPathInsideWorkspace(
    workspace.sessionsPath,
    join(workspace.sessionsPath, `.${sessionId}.safe-execution.claim`),
  );
  try {
    const handle = await open(
      claimPath,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    await handle.writeFile(`${sessionId}\n`, "utf8");
    await handle.sync();
    return { handle, path: claimPath };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      throw new Error("Safe execution claim is already in progress");
    }
    throw error;
  }
}

async function withSessionClaim<T>(
  rootPath: string,
  projectId: string,
  sessionId: string,
  action: () => Promise<T>,
): Promise<T> {
  const claim = await acquireSessionClaim(rootPath, projectId, sessionId);
  try {
    return await action();
  } finally {
    await claim.handle.close().catch(() => undefined);
    await rm(claim.path, { force: true }).catch(() => undefined);
  }
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
      (starting.status !== "IDLE" && starting.status !== "REVISING")
    ) {
      throw new Error("Safe execution is not ready to prepare a proposal");
    }
    try {
      let proposing: SafeExecutionProposingSession;
      if (starting.status === "IDLE") {
        const preparing = transitionedBase(starting, "PREPARING");
        await saveSession(rootPath, preparing);
        proposing = transitionedBase(preparing, "PROPOSING");
      } else {
        proposing = {
          ...transitionedBase(starting, "PROPOSING"),
          revisionRequest:
            starting.decisionApproval.comment?.trim() || "Revision requested.",
          previousProposal: starting.proposal,
          previousProposalThreadId: starting.proposalThreadId,
        };
      }
      await saveSession(rootPath, proposing);
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
      const waiting: SafeExecutionWaitingSession = {
        ...transitionedBase(proposing, "WAITING_APPROVAL"),
        proposal: generated.proposal,
        proposalThreadId: generated.threadId,
      };
      if (!isSafeExecutionSession(waiting)) {
        throw new Error("Safe Mode proposal checkpoint is invalid");
      }
      await saveSession(rootPath, waiting);
      return waiting;
    } catch (error) {
      await saveSession(rootPath, starting).catch((rollbackError) => {
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
    const decided: SafeExecutionDecisionSession = {
      ...transitionedBase(state, status),
      updatedAt: approval.createdAt,
      proposal: state.proposal,
      proposalThreadId: state.proposalThreadId,
      decisionApproval: approval,
    };
    if (!isSafeExecutionSession(decided)) {
      throw new Error("Safe Mode decision checkpoint is invalid");
    }
    await saveSession(rootPath, decided);
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
    };
    if (!isSafeExecutionSession(approved)) {
      throw new Error("Safe Mode approval checkpoint is invalid");
    }
    await saveSession(rootPath, approved);
    let result: SafeMutationResult;
    try {
      result = await execute(approved);
    } catch (error) {
      await saveSession(rootPath, waiting).catch((rollbackError) => {
        throw new Error("Safe Mode execution and rollback both failed", {
          cause: { executionError: error, rollbackError },
        });
      });
      throw error;
    }
    // A resolved executor may already have changed the active target. From
    // this point onward, preserve the durable approval on any evidence or
    // persistence failure so a retry cannot replay that mutation.
    assertMutationResult(approved, result);
    const completedAt = new Date().toISOString();
    const editing: SafeExecutionEditingSession = {
      ...transitionedBase(approved, "EDITING"),
      updatedAt: completedAt,
      proposal: approved.proposal,
      proposalThreadId: approved.proposalThreadId,
      mutationApproval: approved.mutationApproval,
      mutationEvidence: { ...result, completedAt },
    };
    if (!isSafeExecutionSession(editing)) {
      throw new Error("Safe Mode editing checkpoint is invalid");
    }
    await saveSession(rootPath, editing);
    return editing;
  });
}
