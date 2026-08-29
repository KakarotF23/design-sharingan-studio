import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rename, rm } from "node:fs/promises";
import { isAbsolute, join, posix, relative, sep } from "node:path";
import type {
  AutonomyChange,
  AutonomyPolicy,
  AutonomyPolicyEvaluation,
  ChangeProposal,
  MangekyoHumanGate,
  MangekyoHumanGateDecision,
  MangekyoLoopSession,
  MangekyoPolicyEvaluationEvidence,
  MangekyoRoundEvidence,
  RenderArtifact,
  VisualFinding,
  VisualRound,
} from "@design-sharingan/core";
import { DEFAULT_AUTONOMY_POLICY, evaluateAutonomyPolicy } from "@design-sharingan/core";
import { assertPathInsideWorkspace } from "./path-policy";
import {
  ensureDesignWorkspace,
  listSessions,
  loadProjectMetadata,
  loadSession,
  saveSession,
} from "./workspace-store";

const MAX_RENDER_BYTES = 25 * 1024 * 1024;
const MAX_AUTHORIZATION_BYTES = 64 * 1024;
const MAX_CLAIM_BYTES = 16 * 1024;

function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function identifier(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value);
}

function text(value: unknown, maximum = 2_000): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    Buffer.byteLength(value, "utf8") <= maximum
  );
}

function iso(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function texts(
  value: unknown,
  maximumItems: number,
  maximumLength = 2_000,
  requireItems = false,
): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= maximumItems &&
    (!requireItems || value.length > 0) &&
    value.every((entry) => text(entry, maximumLength))
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

function policy(value: unknown): value is AutonomyPolicy {
  return (
    exact(value, [
      "allowStyleChanges",
      "allowSmallComponentRefactors",
      "maxFilesForComponentRefactor",
      "allowNewPresentationalComponents",
      "allowDependencyInstall",
      "allowNavigationChanges",
      "allowDataModelChanges",
      "allowFileDeletion",
      "protectedPaths",
    ]) &&
    typeof value.allowStyleChanges === "boolean" &&
    typeof value.allowSmallComponentRefactors === "boolean" &&
    Number.isSafeInteger(value.maxFilesForComponentRefactor) &&
    (value.maxFilesForComponentRefactor as number) >= 0 &&
    (value.maxFilesForComponentRefactor as number) <= 128 &&
    typeof value.allowNewPresentationalComponents === "boolean" &&
    typeof value.allowDependencyInstall === "boolean" &&
    typeof value.allowNavigationChanges === "boolean" &&
    typeof value.allowDataModelChanges === "boolean" &&
    typeof value.allowFileDeletion === "boolean" &&
    texts(value.protectedPaths, 128, 512, true) &&
    new Set(value.protectedPaths as string[]).size === (value.protectedPaths as string[]).length &&
    DEFAULT_AUTONOMY_POLICY.protectedPaths.every(
      (mandatory) => (value.protectedPaths as string[]).includes(mandatory),
    )
  );
}

function change(value: unknown): value is AutonomyChange {
  return (
    exact(value, ["kind", "files"]) &&
    [
      "STYLE_CHANGE",
      "COMPONENT_REFACTOR",
      "PRESENTATIONAL_COMPONENT",
      "DEPENDENCY_INSTALL",
      "NAVIGATION_CHANGE",
      "DATA_MODEL_CHANGE",
      "FILE_DELETION",
    ].includes(value.kind as string) &&
    texts(value.files, 128, 512, true) &&
    new Set(value.files as string[]).size === (value.files as string[]).length
  );
}

function evaluation(value: unknown): value is AutonomyPolicyEvaluation {
  return (
    exact(value, ["decision", "reasons"]) &&
    (value.decision === "ALLOW" || value.decision === "HUMAN_GATE") &&
    texts(value.reasons, 32, 1_000) &&
    (value.decision === "ALLOW"
      ? (value.reasons as string[]).length === 0
      : (value.reasons as string[]).length > 0)
  );
}

function uxImpact(value: unknown): boolean {
  return (
    exact(value, [
      "area",
      "severity",
      "reason",
      "affectedRoutes",
      "affectedComponents",
      "decisionRequired",
    ]) &&
    text(value.area, 256) &&
    ["CRITICAL", "IMPORTANT", "POLISH", "IGNORE"].includes(value.severity as string) &&
    text(value.reason) &&
    texts(value.affectedRoutes, 16, 512) &&
    texts(value.affectedComponents, 16, 512) &&
    typeof value.decisionRequired === "boolean"
  );
}

function proposal(value: unknown, sessionId: string): value is ChangeProposal {
  return (
    exact(value, [
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
    identifier(value.id) &&
    value.sessionId === sessionId &&
    text(value.summary, 4_000) &&
    text(value.reason, 4_000) &&
    texts(value.filesToCreate, 64, 512) &&
    texts(value.filesToModify, 64, 512) &&
    texts(value.filesToDelete, 64, 512) &&
    [...(value.filesToCreate as string[]), ...(value.filesToModify as string[]), ...(value.filesToDelete as string[])].length > 0 &&
    new Set([...(value.filesToCreate as string[]), ...(value.filesToModify as string[]), ...(value.filesToDelete as string[])]).size ===
      [...(value.filesToCreate as string[]), ...(value.filesToModify as string[]), ...(value.filesToDelete as string[])].length &&
    texts(value.componentsAffected, 32, 1_000) &&
    texts(value.screensAffected, 64, 512) &&
    Array.isArray(value.uxImpact) &&
    value.uxImpact.length > 0 &&
    value.uxImpact.length <= 16 &&
    value.uxImpact.every(uxImpact) &&
    text(value.visualImpact, 4_000) &&
    ["LOW", "MEDIUM", "HIGH", "CRITICAL"].includes(value.riskLevel as string) &&
    value.requiresHumanApproval === true &&
    texts(value.policyViolations, 32, 1_000) &&
    value.status === "PROPOSED"
  );
}

function sourcePathEvidence(value: unknown): boolean {
  if (!Array.isArray(value) || value.length > 128) return false;
  const paths = value.map((entry) =>
    entry !== null && typeof entry === "object" && !Array.isArray(entry)
      ? (entry as { path?: unknown }).path
      : undefined,
  );
  return new Set(paths).size === paths.length && value.every((entry) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return false;
    const record = entry as Record<string, unknown>;
    const path = record.path;
    if (
      typeof path !== "string" ||
      Buffer.byteLength(path, "utf8") === 0 ||
      Buffer.byteLength(path, "utf8") > 1_024 ||
      isAbsolute(path) ||
      path === ".." ||
      path.startsWith("../") ||
      path.includes("\\") ||
      path.includes("\0") ||
      path.includes("\n") ||
      path.includes("\r") ||
      posix.normalize(path) !== path ||
      path === ".git" ||
      path.startsWith(".git/") ||
      path === ".design-sharingan" ||
      path.startsWith(".design-sharingan/")
    ) return false;
    if (record.state === "MISSING") return exact(record, ["path", "state"]);
    return (
      record.state === "FILE" &&
      exact(record, ["path", "state", "mode", "size", "contentHash"]) &&
      Number.isSafeInteger(record.mode) &&
      (record.mode as number) >= 0 &&
      (record.mode as number) <= 0o777 &&
      Number.isSafeInteger(record.size) &&
      (record.size as number) >= 0 &&
      (record.size as number) <= 16 * 1024 * 1024 &&
      typeof record.contentHash === "string" &&
      /^[0-9a-f]{64}$/.test(record.contentHash)
    );
  });
}

function sourceRevision(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (record.kind === "UNVERSIONED") {
    return record.available === false
      ? exact(record, ["kind", "available", "reason"]) &&
        (record.reason === "NOT_A_GIT_WORKSPACE" || record.reason === "GIT_EVIDENCE_UNAVAILABLE")
      : exact(record, ["kind", "available", "truncated", "worktreeFingerprint", "fileCount", "requiredPathEvidence"]) &&
        record.available === true &&
        record.truncated === false &&
        typeof record.worktreeFingerprint === "string" &&
        /^[0-9a-f]{64}$/.test(record.worktreeFingerprint) &&
        Number.isSafeInteger(record.fileCount) &&
        (record.fileCount as number) >= 0 &&
        (record.fileCount as number) <= 512 &&
        sourcePathEvidence(record.requiredPathEvidence);
  }
  return (
    exact(value, [
      "kind",
      "available",
      "head",
      "branch",
      "status",
      "entries",
      "truncated",
      "worktreeFingerprint",
      "fileCount",
      "requiredPathEvidence",
    ]) &&
    value.kind === "GIT" &&
    value.available === true &&
    text(value.head, 128) &&
    text(value.branch, 512) &&
    (value.status === "CLEAN" || value.status === "DIRTY") &&
    Array.isArray(value.entries) &&
    value.entries.length <= 1_024 &&
    new Set(value.entries.map((entry) =>
      entry !== null && typeof entry === "object" && !Array.isArray(entry)
        ? (entry as { path?: unknown }).path
        : undefined,
    )).size === value.entries.length &&
    value.entries.every(
      (entry) =>
        entry !== null &&
        typeof entry === "object" &&
        !Array.isArray(entry) &&
        exact(entry, [
          "index",
          "workingTree",
          "path",
          ...(Object.hasOwn(entry, "originalPath") ? ["originalPath"] : []),
        ]) &&
        typeof (entry as { index?: unknown }).index === "string" &&
        ((entry as { index: string }).index.length === 1) &&
        typeof (entry as { workingTree?: unknown }).workingTree === "string" &&
        ((entry as { workingTree: string }).workingTree.length === 1) &&
        text((entry as { path?: unknown }).path, 512) &&
        (!Object.hasOwn(entry, "originalPath") || text(
          (entry as { originalPath?: unknown }).originalPath,
          512,
        )),
    ) &&
    value.truncated === false &&
    typeof value.worktreeFingerprint === "string" &&
    /^[0-9a-f]{64}$/.test(value.worktreeFingerprint) &&
    Number.isSafeInteger(value.fileCount) &&
    (value.fileCount as number) >= value.entries.length &&
    (value.fileCount as number) <= 512 &&
    sourcePathEvidence(value.requiredPathEvidence) &&
    (value.status === "CLEAN" ? value.entries.length === 0 : value.entries.length > 0)
  );
}

function render(value: unknown, session: MangekyoLoopSession): value is RenderArtifact {
  return (
    exact(value, [
      "id",
      "sessionId",
      "roundId",
      "route",
      "viewport",
      "viewportWidth",
      "viewportHeight",
      "imagePath",
      "capturedAt",
      "sourceRevision",
    ]) &&
    identifier(value.id) &&
    value.sessionId === session.id &&
    identifier(value.roundId) &&
    value.route === session.renderTarget.route &&
    value.viewport === session.renderTarget.viewport.name &&
    value.viewportWidth === session.renderTarget.viewport.width &&
    value.viewportHeight === session.renderTarget.viewport.height &&
    typeof value.imagePath === "string" &&
    isAbsolute(value.imagePath) &&
    iso(value.capturedAt) &&
    sourceRevision(value.sourceRevision)
  );
}

function finding(value: unknown, screen: string): value is VisualFinding {
  return (
    exact(value, [
      "id",
      "severity",
      "category",
      "screen",
      "description",
      "evidence",
      "reason",
      "recommendedAction",
      "status",
    ]) &&
    identifier(value.id) &&
    ["CRITICAL", "IMPORTANT", "POLISH", "IGNORE"].includes(value.severity as string) &&
    ["HIERARCHY", "TYPOGRAPHY", "SPACING", "LAYOUT", "DENSITY", "COMPONENT", "COLOR", "MOTION", "ACCESSIBILITY", "RESPONSIVE", "GENOME"].includes(value.category as string) &&
    value.screen === screen &&
    text(value.description) &&
    texts(value.evidence, 16, 2_000, true) &&
    text(value.reason) &&
    text(value.recommendedAction) &&
    text(value.status, 64)
  );
}

function integrity(value: unknown): boolean {
  return (
    exact(value, ["status", "evidence"]) &&
    ["PASS", "REGRESSION", "CONFLICT", "NOT_VERIFIED"].includes(value.status as string) &&
    texts(value.evidence, 16, 2_000, true)
  );
}

function visualRound(value: unknown, session: MangekyoLoopSession): value is VisualRound {
  if (!exact(value, [
    "roundNumber",
    "startedAt",
    ...(Object.hasOwn(value as object, "completedAt") ? ["completedAt"] : []),
    ...(Object.hasOwn(value as object, "beforeRender") ? ["beforeRender"] : []),
    ...(Object.hasOwn(value as object, "afterRender") ? ["afterRender"] : []),
    "filesChanged",
    "findingsBefore",
    "actions",
    "findingsAfter",
    "criticalCount",
    "importantCount",
    "polishCount",
    "uxIntegrity",
    "productConsistency",
    "accessibility",
    "genomeIntegrity",
    ...(Object.hasOwn(value as object, "genomeEvidenceVersion") ? ["genomeEvidenceVersion"] : []),
    "status",
  ])) return false;
  return (
    Number.isSafeInteger(value.roundNumber) &&
    (value.roundNumber as number) >= 1 &&
    (value.roundNumber as number) <= session.maxRounds &&
    iso(value.startedAt) &&
    (value.completedAt === undefined || iso(value.completedAt)) &&
    (value.beforeRender === undefined || render(value.beforeRender, session)) &&
    (value.afterRender === undefined || render(value.afterRender, session)) &&
    texts(value.filesChanged, 128, 512) &&
    Array.isArray(value.findingsBefore) &&
    value.findingsBefore.length <= 64 &&
    value.findingsBefore.every((entry) => finding(entry, session.renderTarget.route)) &&
    texts(value.actions, 32, 2_000) &&
    Array.isArray(value.findingsAfter) &&
    value.findingsAfter.length <= 64 &&
    value.findingsAfter.every((entry) => finding(entry, session.renderTarget.route)) &&
    [value.criticalCount, value.importantCount, value.polishCount].every(
      (count) => Number.isSafeInteger(count) && (count as number) >= 0 && (count as number) <= 64,
    ) &&
    integrity(value.uxIntegrity) &&
    integrity(value.productConsistency) &&
    integrity(value.accessibility) &&
    integrity(value.genomeIntegrity) &&
    (value.genomeEvidenceVersion === undefined || text(value.genomeEvidenceVersion, 128)) &&
    ((value.genomeIntegrity as { status?: unknown }).status === "NOT_VERIFIED"
      ? value.genomeEvidenceVersion === undefined
      : value.genomeEvidenceVersion !== undefined) &&
    ["IDLE", "PREPARING", "POLICY_CHECK", "EDITING", "RUNNING", "CAPTURING", "COMPARING", "DECIDING", "FIXING", "HUMAN_GATE", "COMPLETE", "BLOCKED", "FAILED"].includes(value.status as string)
  );
}

function policyEvidence(value: unknown): value is MangekyoPolicyEvaluationEvidence {
  return (
    exact(value, [
      "id",
      "roundNumber",
      "proposalId",
      "change",
      "policy",
      "evaluation",
      "evaluatedAt",
    ]) &&
    identifier(value.id) &&
    Number.isSafeInteger(value.roundNumber) &&
    (value.roundNumber as number) >= 1 &&
    (value.roundNumber as number) <= 5 &&
    identifier(value.proposalId) &&
    change(value.change) &&
    policy(value.policy) &&
    evaluation(value.evaluation) &&
    iso(value.evaluatedAt)
  );
}

function gate(value: unknown, sessionId: string): value is MangekyoHumanGate {
  return (
    exact(value, [
      "id",
      "roundNumber",
      "requestedChange",
      "proposal",
      "proposalThreadId",
      "policyEvaluationId",
      "requestedAt",
      "reasons",
      "affectedScope",
      "impact",
    ]) &&
    identifier(value.id) &&
    Number.isSafeInteger(value.roundNumber) &&
    (value.roundNumber as number) >= 1 &&
    (value.roundNumber as number) <= 5 &&
    change(value.requestedChange) &&
    proposal(value.proposal, sessionId) &&
    text(value.proposalThreadId, 256) &&
    identifier(value.policyEvaluationId) &&
    iso(value.requestedAt) &&
    texts(value.reasons, 32, 1_000, true) &&
    texts(value.affectedScope, 64, 512, true) &&
    text(value.impact, 2_000)
  );
}

function gateDecision(value: unknown): value is MangekyoHumanGateDecision {
  const optional = value !== null && typeof value === "object" && !Array.isArray(value)
    ? [
        ...(Object.hasOwn(value, "comment") ? ["comment"] : []),
        ...(Object.hasOwn(value, "policyAfter") ? ["policyAfter"] : []),
      ]
    : [];
  return (
    exact(value, ["id", "gateId", "decision", "decidedBy", "createdAt", ...optional]) &&
    identifier(value.id) &&
    identifier(value.gateId) &&
    ["REJECT", "APPROVE_ONCE", "EXPAND_SCOPE"].includes(value.decision as string) &&
    text(value.decidedBy, 256) &&
    iso(value.createdAt) &&
    (value.comment === undefined || (typeof value.comment === "string" && Buffer.byteLength(value.comment, "utf8") <= 2_000)) &&
    (value.policyAfter === undefined || policy(value.policyAfter)) &&
    (value.decision === "EXPAND_SCOPE" ? value.policyAfter !== undefined : value.policyAfter === undefined)
  );
}

function roundEvidence(value: unknown, session: MangekyoLoopSession): value is MangekyoRoundEvidence {
  const optional = value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.hasOwn(value, "gateDecisionId")
    ? ["gateDecisionId"]
    : [];
  return (
    exact(value, [
      "round",
      "proposal",
      "proposalThreadId",
      "policyEvaluationId",
      "mutationCompletedAt",
      "mutationSourceRevision",
      "visualAnalysisThreadId",
      ...optional,
    ]) &&
    visualRound(value.round, session) &&
    proposal(value.proposal, session.id) &&
    text(value.proposalThreadId, 256) &&
    identifier(value.policyEvaluationId) &&
    iso(value.mutationCompletedAt) &&
    sourceRevision(value.mutationSourceRevision) &&
    text(value.visualAnalysisThreadId, 256) &&
    (value.gateDecisionId === undefined || identifier(value.gateDecisionId))
  );
}

function semanticSessionRelations(session: MangekyoLoopSession): boolean {
  const proposalFiles = (value: ChangeProposal): string[] => [
    ...value.filesToCreate,
    ...value.filesToModify,
    ...value.filesToDelete,
  ];
  if (
    session.initialRender !== undefined && (
      Date.parse(session.initialRender.capturedAt) < Date.parse(session.createdAt) ||
      Date.parse(session.initialRender.capturedAt) > Date.parse(session.updatedAt)
    )
  ) {
    return false;
  }
  for (const gateEvidence of session.gates) {
    const policyEntry = session.policyEvaluations.find(
      ({ id }) => id === gateEvidence.policyEvaluationId,
    );
    if (
      policyEntry === undefined ||
      gateEvidence.roundNumber > session.rounds.length + 1 ||
      policyEntry.evaluation.decision !== "HUMAN_GATE" ||
      policyEntry.roundNumber !== gateEvidence.roundNumber ||
      policyEntry.proposalId !== gateEvidence.proposal.id ||
      stableJson(policyEntry.change) !== stableJson(gateEvidence.requestedChange) ||
      stableJson(proposalFiles(gateEvidence.proposal)) !==
        stableJson(gateEvidence.requestedChange.files) ||
      Date.parse(gateEvidence.requestedAt) < Date.parse(policyEntry.evaluatedAt) ||
      Date.parse(gateEvidence.requestedAt) > Date.parse(session.updatedAt)
    ) {
      return false;
    }
  }
  const freshScreens = new Set<string>();
  for (const [index, evidence] of session.rounds.entries()) {
    const round = evidence.round;
    const policyEntry = session.policyEvaluations.find(({ id }) => id === evidence.policyEvaluationId);
    const expectedFiles = proposalFiles(evidence.proposal);
    const counts = {
      critical: round.findingsAfter.filter(({ severity }) => severity === "CRITICAL").length,
      important: round.findingsAfter.filter(({ severity }) => severity === "IMPORTANT").length,
      polish: round.findingsAfter.filter(({ severity }) => severity === "POLISH").length,
    };
    const previousRender = index === 0
      ? session.initialRender
      : session.rounds[index - 1]?.round.afterRender;
    const previousFindings = index === 0
      ? []
      : session.rounds[index - 1]?.round.findingsAfter ?? [];
    if (
      round.roundNumber !== index + 1 ||
      round.completedAt === undefined ||
      round.afterRender === undefined ||
      policyEntry === undefined ||
      policyEntry.roundNumber !== round.roundNumber ||
      policyEntry.proposalId !== evidence.proposal.id ||
      stableJson(policyEntry.change.files) !== stableJson(expectedFiles) ||
      stableJson(evidence.mutationSourceRevision) !== stableJson(round.afterRender.sourceRevision) ||
      evidence.mutationSourceRevision.available !== true ||
      evidence.mutationSourceRevision.truncated ||
      stableJson(evidence.mutationSourceRevision.requiredPathEvidence.map(({ path }) => path)) !==
        stableJson(expectedFiles) ||
      stableJson(round.filesChanged) !== stableJson(expectedFiles) ||
      stableJson(round.beforeRender) !== stableJson(previousRender) ||
      stableJson(round.findingsBefore) !== stableJson(previousFindings) ||
      round.startedAt !== policyEntry.evaluatedAt ||
      Date.parse(evidence.mutationCompletedAt) < Date.parse(round.startedAt) ||
      Date.parse(round.afterRender.capturedAt) <= Date.parse(evidence.mutationCompletedAt) ||
      Date.parse(round.completedAt) < Date.parse(round.afterRender.capturedAt) ||
      Date.parse(round.completedAt) > Date.parse(session.updatedAt) ||
      round.criticalCount !== counts.critical ||
      round.importantCount !== counts.important ||
      round.polishCount !== counts.polish ||
      stableJson(evaluateAutonomyPolicy(policyEntry.policy, policyEntry.change)) !==
        stableJson(policyEntry.evaluation) ||
      !["PASS", "REGRESSION", "NOT_VERIFIED"].includes(round.uxIntegrity.status) ||
      !["PASS", "REGRESSION", "NOT_VERIFIED"].includes(round.productConsistency.status) ||
      !["PASS", "REGRESSION", "NOT_VERIFIED"].includes(round.accessibility.status) ||
      !["PASS", "CONFLICT", "NOT_VERIFIED"].includes(round.genomeIntegrity.status)
    ) {
      return false;
    }
    if (
      new Set(round.findingsBefore.map(({ id }) => id)).size !== round.findingsBefore.length ||
      new Set(round.findingsAfter.map(({ id }) => id)).size !== round.findingsAfter.length ||
      !["FIXING", "DECIDING", "COMPLETE", "BLOCKED"].includes(round.status) ||
      (index < session.rounds.length - 1 && round.status !== "FIXING") ||
      (session.status === "DECIDING" && index === session.rounds.length - 1 && round.status !== "DECIDING")
    ) {
      return false;
    }
    if (round.afterRender.route === session.renderTarget.route) {
      freshScreens.add(round.afterRender.route);
    }
  }
  if (
    stableJson([...freshScreens]) !== stableJson(session.inspectedScreens) ||
    (session.status === "COMPLETE" && !session.claimedScreens.every((screen) => freshScreens.has(screen)))
  ) {
    return false;
  }
  for (const decision of session.gateDecisions) {
    const historicalGate = session.gates.find(({ id }) => id === decision.gateId);
    const linkedRounds = session.rounds.filter(
      ({ gateDecisionId }) => gateDecisionId === decision.id,
    );
    const isLatestDecision = session.gateDecisions.at(-1)?.id === decision.id;
    const exactPendingGate = historicalGate !== undefined &&
      historicalGate.roundNumber === session.rounds.length + 1 &&
      historicalGate.proposal.sessionId === session.id &&
      session.policyEvaluations.at(-1)?.id === historicalGate.policyEvaluationId &&
      historicalGate.requestedAt === session.policyEvaluations.at(-1)?.evaluatedAt &&
      Date.parse(decision.createdAt) >= Date.parse(historicalGate.requestedAt) &&
      session.currentGate === undefined &&
      isLatestDecision;
    const pendingApproveOnce =
      decision.decision === "APPROVE_ONCE" &&
      exactPendingGate &&
      linkedRounds.length === 0 &&
      ["EDITING", "RUNNING", "CAPTURING", "COMPARING"].includes(session.status);
    const pendingExpansion =
      decision.decision === "EXPAND_SCOPE" &&
      exactPendingGate &&
      linkedRounds.length === 0 &&
      session.status === "EDITING" &&
      session.updatedAt === decision.createdAt;
    const stoppedPendingDecision =
      exactPendingGate &&
      linkedRounds.length === 0 &&
      session.status === "BLOCKED" &&
      session.stopRequest !== undefined &&
      Date.parse(session.stopRequest.sessionVersion) >= Date.parse(decision.createdAt);
    const hasAuthorizedExpansion = decision.decision === "EXPAND_SCOPE" &&
      session.policyEvaluations.some(
        (entry) =>
          entry.roundNumber === historicalGate?.roundNumber &&
          entry.proposalId === historicalGate.proposal.id &&
          entry.evaluation.decision === "ALLOW" &&
          Date.parse(entry.evaluatedAt) >= Date.parse(decision.createdAt) &&
          stableJson(entry.change) === stableJson(historicalGate.requestedChange),
      );
    if (
      historicalGate === undefined ||
      Date.parse(decision.createdAt) < Date.parse(historicalGate.requestedAt) ||
      Date.parse(decision.createdAt) > Date.parse(session.updatedAt) ||
      (decision.decision === "EXPAND_SCOPE" && (
        decision.policyAfter === undefined ||
        evaluateAutonomyPolicy(decision.policyAfter, historicalGate.requestedChange).decision !== "ALLOW"
      ))
    ) {
      return false;
    }
    if (
      (decision.decision === "REJECT" && (
        session.status !== "BLOCKED" || linkedRounds.length !== 0
      )) ||
      (decision.decision === "APPROVE_ONCE" && !(
        linkedRounds.length === 1 ||
        (linkedRounds.length === 0 && session.status === "FAILED") ||
        pendingApproveOnce ||
        stoppedPendingDecision
      )) ||
      (decision.decision === "EXPAND_SCOPE" && !(
        hasAuthorizedExpansion || pendingExpansion || stoppedPendingDecision
      ))
    ) {
      return false;
    }
  }
  const everyPolicyEvaluationLinked = session.policyEvaluations.every((entry) =>
    entry.roundNumber <= session.rounds.length + 1 && (
      session.gates.some(({ policyEvaluationId }) => policyEvaluationId === entry.id) ||
      session.rounds.some(({ policyEvaluationId }) => policyEvaluationId === entry.id) ||
      (
        ["POLICY_CHECK", "EDITING", "RUNNING", "CAPTURING", "COMPARING", "FAILED"].includes(
          session.status,
        ) &&
        session.policyEvaluations.at(-1)?.id === entry.id &&
        entry.roundNumber === session.rounds.length + 1
      ) ||
      (
        session.status === "BLOCKED" &&
        session.stopRequest !== undefined &&
        session.policyEvaluations.at(-1)?.id === entry.id &&
        entry.roundNumber === session.rounds.length + 1 &&
        Date.parse(entry.evaluatedAt) <= Date.parse(session.stopRequest.sessionVersion)
      )
    ),
  );
  const lastExpansion = session.gateDecisions.filter(
    ({ decision }) => decision === "EXPAND_SCOPE",
  ).at(-1);
  const expectedPolicy = lastExpansion?.policyAfter ?? session.initialPolicy;
  if (
    !everyPolicyEvaluationLinked ||
    stableJson(session.policy) !== stableJson(expectedPolicy)
  ) {
    return false;
  }
  if (session.status === "COMPLETE") {
    const latest = session.rounds.at(-1);
    if (
      latest === undefined ||
      latest.round.uxIntegrity.status !== "PASS" ||
      latest.round.productConsistency.status !== "PASS" ||
      latest.round.accessibility.status !== "PASS" ||
      latest.round.genomeIntegrity.status !== "PASS" ||
      latest.round.criticalCount !== 0 ||
      latest.round.importantCount > session.importantThreshold
    ) {
      return false;
    }
  }
  return true;
}

export function isMangekyoLoopSession(value: unknown): value is MangekyoLoopSession {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const optional = [
    ...(Object.hasOwn(value, "currentGate") ? ["currentGate"] : []),
    ...(Object.hasOwn(value, "initialRender") ? ["initialRender"] : []),
    ...(Object.hasOwn(value, "finalRender") ? ["finalRender"] : []),
    ...(Object.hasOwn(value, "mutationFailure") ? ["mutationFailure"] : []),
    ...(Object.hasOwn(value, "stopRequest") ? ["stopRequest"] : []),
    ...(Object.hasOwn(value, "stopReason") ? ["stopReason"] : []),
  ];
  if (!exact(value, [
    "id",
    "projectId",
    "type",
    "status",
    "createdAt",
    "updatedAt",
    "sourceExecutionSessionId",
    "sourceDesignSessionId",
    "approvedApproachId",
    "directionApprovalId",
    "approvedDirection",
    "policy",
    "initialPolicy",
    "renderTarget",
    "referenceIds",
    "maxRounds",
    "importantThreshold",
    "claimedScreens",
    "inspectedScreens",
    "rounds",
    "policyEvaluations",
    "gates",
    "gateDecisions",
    ...optional,
  ])) return false;
  const session = value as unknown as MangekyoLoopSession;
  return (
    identifier(session.id) &&
    identifier(session.projectId) &&
    session.type === "MANGEKYO_LOOP" &&
    ["IDLE", "PREPARING", "POLICY_CHECK", "EDITING", "RUNNING", "CAPTURING", "COMPARING", "DECIDING", "FIXING", "HUMAN_GATE", "COMPLETE", "BLOCKED", "FAILED"].includes(session.status) &&
    iso(session.createdAt) &&
    iso(session.updatedAt) &&
    Date.parse(session.updatedAt) >= Date.parse(session.createdAt) &&
    identifier(session.sourceExecutionSessionId) &&
    identifier(session.sourceDesignSessionId) &&
    identifier(session.approvedApproachId) &&
    identifier(session.directionApprovalId) &&
    text(session.approvedDirection, 4_000) &&
    policy(session.policy) &&
    policy(session.initialPolicy) &&
    stableJson(session.initialPolicy) === stableJson(DEFAULT_AUTONOMY_POLICY) &&
    exact(session.renderTarget, ["route", "viewport"]) &&
    text(session.renderTarget.route, 512) &&
    exact(session.renderTarget.viewport, ["name", "width", "height"]) &&
    text(session.renderTarget.viewport.name, 128) &&
    Number.isSafeInteger(session.renderTarget.viewport.width) &&
    session.renderTarget.viewport.width >= 320 &&
    session.renderTarget.viewport.width <= 4_096 &&
    Number.isSafeInteger(session.renderTarget.viewport.height) &&
    session.renderTarget.viewport.height >= 320 &&
    session.renderTarget.viewport.height <= 4_096 &&
    texts(session.referenceIds, 32, 128, true) &&
    new Set(session.referenceIds).size === session.referenceIds.length &&
    session.maxRounds === 5 &&
    Number.isSafeInteger(session.importantThreshold) &&
    session.importantThreshold >= 0 &&
    session.importantThreshold <= 64 &&
    texts(session.claimedScreens, 64, 512, true) &&
    texts(session.inspectedScreens, 64, 512) &&
    session.inspectedScreens.every((screen) => session.claimedScreens.includes(screen)) &&
    Array.isArray(session.policyEvaluations) &&
    session.policyEvaluations.length <= 32 &&
    session.policyEvaluations.every(policyEvidence) &&
    new Set(session.policyEvaluations.map(({ id }) => id)).size === session.policyEvaluations.length &&
    Array.isArray(session.gates) &&
    session.gates.length <= 16 &&
    session.gates.every((entry) => gate(entry, session.id)) &&
    new Set(session.gates.map(({ id }) => id)).size === session.gates.length &&
    Array.isArray(session.gateDecisions) &&
    session.gateDecisions.length <= 16 &&
    session.gateDecisions.every(gateDecision) &&
    new Set(session.gateDecisions.map(({ id }) => id)).size === session.gateDecisions.length &&
    session.gateDecisions.every((decision) => session.gates.some(({ id }) => id === decision.gateId)) &&
    session.gates.every((historicalGate) => {
      const decisions = session.gateDecisions.filter(({ gateId }) => gateId === historicalGate.id);
      if (session.currentGate?.id === historicalGate.id) return decisions.length === 0;
      const stoppedAtThisGate =
        session.status === "BLOCKED" &&
        session.stopRequest !== undefined &&
        session.gates.at(-1)?.id === historicalGate.id &&
        Date.parse(session.stopRequest.requestedAt) >= Date.parse(historicalGate.requestedAt);
      return stoppedAtThisGate ? decisions.length === 0 : decisions.length === 1;
    }) &&
    (session.currentGate === undefined || gate(session.currentGate, session.id)) &&
    (session.currentGate === undefined || session.gates.some(
      (entry) => entry.id === session.currentGate?.id && stableJson(entry) === stableJson(session.currentGate),
    )) &&
    (session.status === "HUMAN_GATE" ? session.currentGate !== undefined : session.currentGate === undefined) &&
    (session.currentGate === undefined || session.policyEvaluations.some(
      (entry) =>
        entry.id === session.currentGate?.policyEvaluationId &&
        entry.proposalId === session.currentGate?.proposal.id &&
        entry.evaluation.decision === "HUMAN_GATE" &&
        stableJson(entry.change) === stableJson(session.currentGate?.requestedChange),
    )) &&
    Array.isArray(session.rounds) &&
    session.rounds.length <= session.maxRounds &&
    session.rounds.every((entry) => roundEvidence(entry, session)) &&
    session.rounds.every((entry) => {
      const policyEntry = session.policyEvaluations.find(
        (candidate) => candidate.id === entry.policyEvaluationId && candidate.proposalId === entry.proposal.id,
      );
      if (policyEntry?.evaluation.decision === "ALLOW") return entry.gateDecisionId === undefined;
      if (policyEntry?.evaluation.decision !== "HUMAN_GATE" || entry.gateDecisionId === undefined) return false;
      const decision = session.gateDecisions.find(
        (candidate) => candidate.id === entry.gateDecisionId && candidate.decision === "APPROVE_ONCE",
      );
      return decision !== undefined && session.gates.some(
        (historicalGate) =>
          historicalGate.id === decision.gateId &&
          historicalGate.policyEvaluationId === policyEntry.id &&
          historicalGate.proposal.id === entry.proposal.id &&
          stableJson(historicalGate.requestedChange) === stableJson(policyEntry.change),
      );
    }) &&
    (session.initialRender === undefined || render(session.initialRender, session)) &&
    (session.finalRender === undefined || render(session.finalRender, session)) &&
    (session.mutationFailure === undefined || (
      exact(session.mutationFailure, ["targetDisposition", "affectedPaths"]) &&
      ["NO_TARGET_CHANGE", "ROLLED_BACK", "RECONCILIATION_REQUIRED"].includes(
        session.mutationFailure.targetDisposition,
      ) &&
      texts(session.mutationFailure.affectedPaths, 128, 512, true) &&
      session.status === "FAILED"
    )) &&
    (session.stopRequest === undefined || (
      stopRequest(session.stopRequest) &&
      session.stopRequest.loopSessionId === session.id &&
      Date.parse(session.stopRequest.sessionVersion) <= Date.parse(session.updatedAt) &&
      Date.parse(session.stopRequest.requestedAt) <= Date.parse(session.updatedAt) &&
      session.status === "BLOCKED" &&
      session.finalRender === undefined
    )) &&
    (session.status !== "COMPLETE" || (
      session.rounds.length > 0 &&
      session.finalRender !== undefined &&
      session.rounds.at(-1)?.round.status === "COMPLETE" &&
      stableJson(session.rounds.at(-1)?.round.afterRender) === stableJson(session.finalRender)
    )) &&
    (session.status === "COMPLETE" || session.finalRender === undefined) &&
    (session.stopReason === undefined || text(session.stopReason, 2_000)) &&
    (!["COMPLETE", "BLOCKED", "FAILED"].includes(session.status) || session.stopReason !== undefined) &&
    semanticSessionRelations(session)
  );
}

async function assertRenderPath(rootPath: string, artifact: RenderArtifact): Promise<void> {
  const renderRoot = join(rootPath, ".design-sharingan", "renders");
  const authenticated = assertPathInsideWorkspace(renderRoot, artifact.imagePath);
  const [canonical, entry] = await Promise.all([realpath(authenticated), lstat(authenticated)]);
  const nested = relative(renderRoot, canonical);
  if (
    canonical !== authenticated ||
    nested === "" ||
    isAbsolute(nested) ||
    nested === ".." ||
    nested.startsWith(`..${sep}`) ||
    entry.isSymbolicLink() ||
    !entry.isFile() ||
    entry.nlink !== 1 ||
    entry.size < 8 ||
    entry.size > MAX_RENDER_BYTES
  ) {
    throw new Error("Mangekyo render evidence is not an authenticated project-scoped file");
  }
}

async function validateRenderFiles(rootPath: string, session: MangekyoLoopSession): Promise<void> {
  const artifacts = [
    session.initialRender,
    session.finalRender,
    ...session.rounds.flatMap(({ round }) => [round.beforeRender, round.afterRender]),
  ].filter((artifact): artifact is RenderArtifact => artifact !== undefined);
  const uniquePaths = new Map(artifacts.map((artifact) => [artifact.imagePath, artifact]));
  await Promise.all([...uniquePaths.values()].map((artifact) => assertRenderPath(rootPath, artifact)));
}

export async function saveMangekyoLoopSession(
  rootPath: string,
  session: MangekyoLoopSession,
): Promise<void> {
  if (!isMangekyoLoopSession(session)) {
    throw new Error("Invalid Mangekyo loop session evidence");
  }
  await validateRenderFiles(rootPath, session);
  await saveSession(rootPath, session);
}

export async function loadMangekyoLoopSession(
  rootPath: string,
  projectId: string,
  sessionId: string,
): Promise<MangekyoLoopSession> {
  const session = await loadSession(rootPath, projectId, sessionId);
  if (!isMangekyoLoopSession(session)) {
    throw new Error("Invalid Mangekyo loop session evidence");
  }
  await validateRenderFiles(rootPath, session);
  return session;
}

function authorization(value: unknown): value is Record<string, unknown> & { id: string } {
  return (
    exact(value, [
      "kind",
      "id",
      "loopSessionId",
      "proposalId",
      "proposalThreadId",
      "change",
      "policy",
      "evaluation",
      "evaluatedAt",
      "expiresAt",
    ]) &&
    value.kind === "AUTONOMOUS_POLICY_ALLOW" &&
    identifier(value.id) &&
    identifier(value.loopSessionId) &&
    identifier(value.proposalId) &&
    text(value.proposalThreadId, 256) &&
    change(value.change) &&
    policy(value.policy) &&
    evaluation(value.evaluation) &&
    (value.evaluation as AutonomyPolicyEvaluation).decision === "ALLOW" &&
    iso(value.evaluatedAt) &&
    iso(value.expiresAt) &&
    Date.parse(value.expiresAt as string) > Date.parse(value.evaluatedAt as string) &&
    Date.parse(value.expiresAt as string) - Date.parse(value.evaluatedAt as string) <= 5 * 60_000
  );
}

async function authorizationRoot(rootPath: string, projectId: string): Promise<string> {
  await loadProjectMetadata(rootPath, projectId);
  const workspace = await ensureDesignWorkspace(rootPath);
  const directory = assertPathInsideWorkspace(
    workspace.cachePath,
    join(workspace.cachePath, "mangekyo-authorizations"),
  );
  await mkdir(directory, { mode: 0o700 }).catch((error: unknown) => {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
  });
  const entry = await lstat(directory);
  if (
    entry.isSymbolicLink() ||
    !entry.isDirectory() ||
    (entry.mode & 0o077) !== 0 ||
    (await realpath(directory)) !== directory
  ) {
    throw new Error("Mangekyo authorization store is not a private project-scoped directory");
  }
  return directory;
}

async function mangekyoClaimRoot(rootPath: string, projectId: string): Promise<string> {
  await loadProjectMetadata(rootPath, projectId);
  const workspace = await ensureDesignWorkspace(rootPath);
  const directory = assertPathInsideWorkspace(
    workspace.cachePath,
    join(workspace.cachePath, "mangekyo-claims"),
  );
  await mkdir(directory, { mode: 0o700 }).catch((error: unknown) => {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
  });
  const entry = await lstat(directory);
  if (
    entry.isSymbolicLink() ||
    !entry.isDirectory() ||
    (entry.mode & 0o077) !== 0 ||
    (await realpath(directory)) !== directory
  ) {
    throw new Error("Mangekyo claim store is not a private project-scoped directory");
  }
  return directory;
}

async function writeExclusiveClaim(
  directory: string,
  name: string,
  value: unknown,
  replayMessage: string,
): Promise<void> {
  const path = assertPathInsideWorkspace(directory, join(directory, name));
  const serialized = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > MAX_CLAIM_BYTES) {
    throw new Error("Mangekyo claim exceeds its byte bound");
  }
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    await handle.writeFile(serialized, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    const directoryHandle = await open(directory, constants.O_RDONLY);
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } catch (error) {
    await handle?.close().catch(() => undefined);
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      throw new Error(replayMessage);
    }
    throw error;
  }
}

export interface MangekyoActiveLoopClaim {
  loopSessionId: string;
  sourceExecutionSessionId: string;
  claimedAt: string;
}

function activeLoopClaim(value: unknown): value is MangekyoActiveLoopClaim {
  return (
    exact(value, ["loopSessionId", "sourceExecutionSessionId", "claimedAt"]) &&
    identifier(value.loopSessionId) &&
    identifier(value.sourceExecutionSessionId) &&
    iso(value.claimedAt)
  );
}

export async function claimMangekyoActiveLoop(
  rootPath: string,
  projectId: string,
  claim: MangekyoActiveLoopClaim,
): Promise<void> {
  if (!activeLoopClaim(claim)) throw new Error("Mangekyo active-loop claim is invalid");
  const directory = await mangekyoClaimRoot(rootPath, projectId);
  await writeExclusiveClaim(
    directory,
    "active-loop.claim",
    claim,
    "Another Mangekyo loop already owns the active project claim",
  );
}

export async function loadMangekyoActiveLoopClaim(
  rootPath: string,
  projectId: string,
): Promise<MangekyoActiveLoopClaim | undefined> {
  const directory = await mangekyoClaimRoot(rootPath, projectId);
  const path = assertPathInsideWorkspace(directory, join(directory, "active-loop.claim"));
  const before = await lstat(path).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  });
  if (before === undefined) return undefined;
  if (
    before.isSymbolicLink() ||
    !before.isFile() ||
    before.nlink !== 1 ||
    before.size < 2 ||
    before.size > MAX_CLAIM_BYTES
  ) {
    throw new Error("The active Mangekyo loop claim is invalid or ambiguous");
  }
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    const parsed = JSON.parse(await handle.readFile("utf8")) as unknown;
    const after = await lstat(path);
    if (
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.size !== before.size ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      !activeLoopClaim(parsed)
    ) {
      throw new Error("The active Mangekyo loop claim changed while it was authenticated");
    }
    return parsed;
  } finally {
    await handle.close();
  }
}

export async function releaseMangekyoActiveLoop(
  rootPath: string,
  projectId: string,
  release: MangekyoActiveLoopClaim & (
    | { terminalStatus: "COMPLETE" | "BLOCKED" | "FAILED" }
    | { reservationStatus: "UNPERSISTED" }
  ),
): Promise<void> {
  const terminalStatus = "terminalStatus" in release ? release.terminalStatus : undefined;
  const reservationStatus = "reservationStatus" in release ? release.reservationStatus : undefined;
  if (
    !exact(release, [
      "loopSessionId",
      "sourceExecutionSessionId",
      "claimedAt",
      terminalStatus === undefined ? "reservationStatus" : "terminalStatus",
    ]) ||
    !activeLoopClaim({
      loopSessionId: release.loopSessionId,
      sourceExecutionSessionId: release.sourceExecutionSessionId,
      claimedAt: release.claimedAt,
    }) ||
    !(
      (terminalStatus !== undefined && ["COMPLETE", "BLOCKED", "FAILED"].includes(terminalStatus)) ||
      reservationStatus === "UNPERSISTED"
    )
  ) {
    throw new Error("Mangekyo active-loop release is invalid");
  }
  const directory = await mangekyoClaimRoot(rootPath, projectId);
  const path = assertPathInsideWorkspace(directory, join(directory, "active-loop.claim"));
  const before = await lstat(path).catch(() => undefined);
  if (
    before === undefined ||
    before.isSymbolicLink() ||
    !before.isFile() ||
    before.nlink !== 1 ||
    before.size < 2 ||
    before.size > MAX_CLAIM_BYTES
  ) {
    throw new Error("The exact active loop claim is missing or ambiguous");
  }
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    const parsed = JSON.parse(await handle.readFile("utf8")) as unknown;
    if (
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.size !== before.size ||
      !activeLoopClaim(parsed) ||
      stableJson(parsed) !== stableJson({
        loopSessionId: release.loopSessionId,
        sourceExecutionSessionId: release.sourceExecutionSessionId,
        claimedAt: release.claimedAt,
      })
    ) {
      throw new Error("The exact active loop claim is missing or ambiguous");
    }

    const records = (await listSessions(rootPath, projectId)).filter(
      ({ id }) => id === release.loopSessionId,
    );
    if (terminalStatus === undefined) {
      if (records.length !== 0) {
        throw new Error("The start reservation has persisted or ambiguous loop evidence");
      }
    } else {
      if (records.length !== 1 || records[0]?.type !== "MANGEKYO_LOOP") {
        throw new Error("The exact durable terminal session is missing or ambiguous");
      }
      const session = await loadMangekyoLoopSession(rootPath, projectId, release.loopSessionId);
      if (
        session.status !== terminalStatus ||
        session.sourceExecutionSessionId !== release.sourceExecutionSessionId ||
        session.createdAt !== release.claimedAt
      ) {
        throw new Error("The exact durable terminal session is missing or ambiguous");
      }
    }
  } finally {
    await handle.close();
  }
  const current = await lstat(path);
  if (current.dev !== before.dev || current.ino !== before.ino || current.size !== before.size) {
    throw new Error("The exact active loop claim changed before terminal release");
  }
  await rm(path);
  const directoryHandle = await open(directory, constants.O_RDONLY);
  try {
    await directoryHandle.sync();
  } finally {
    await directoryHandle.close();
  }
}

export interface MangekyoGateDecisionClaim {
  loopSessionId: string;
  sessionVersion: string;
  gateId: string;
  decisionId: string;
  decision: "REJECT" | "APPROVE_ONCE" | "EXPAND_SCOPE";
  decidedAt: string;
}

function gateDecisionClaim(value: unknown): value is MangekyoGateDecisionClaim {
  return (
    exact(value, [
      "loopSessionId",
      "sessionVersion",
      "gateId",
      "decisionId",
      "decision",
      "decidedAt",
    ]) &&
    identifier(value.loopSessionId) &&
    iso(value.sessionVersion) &&
    identifier(value.gateId) &&
    identifier(value.decisionId) &&
    ["REJECT", "APPROVE_ONCE", "EXPAND_SCOPE"].includes(value.decision as string) &&
    iso(value.decidedAt) &&
    Date.parse(value.decidedAt as string) >= Date.parse(value.sessionVersion as string)
  );
}

function gateActionClaimPath(directory: string, claim: MangekyoGateDecisionClaim): string {
  const digest = createHash("sha256")
    .update(`${claim.loopSessionId}\0${claim.sessionVersion}`)
    .digest("hex");
  return assertPathInsideWorkspace(directory, join(directory, `action-${digest}.claim`));
}

export async function claimMangekyoGateDecision(
  rootPath: string,
  projectId: string,
  claim: MangekyoGateDecisionClaim,
): Promise<void> {
  if (!gateDecisionClaim(claim)) {
    throw new Error("Mangekyo Human Gate claim is invalid");
  }
  const directory = await mangekyoClaimRoot(rootPath, projectId);
  const path = gateActionClaimPath(directory, claim);
  await writeExclusiveClaim(
    directory,
    path.slice(directory.length + 1),
    claim,
    "Mangekyo Human Gate was already decided or this session version already has an action",
  );
}

export async function releaseMangekyoGateDecisionClaim(
  rootPath: string,
  projectId: string,
  claim: MangekyoGateDecisionClaim,
): Promise<void> {
  if (!gateDecisionClaim(claim)) throw new Error("Mangekyo Human Gate claim is invalid");
  const directory = await mangekyoClaimRoot(rootPath, projectId);
  const path = gateActionClaimPath(directory, claim);
  const before = await lstat(path).catch(() => undefined);
  if (
    before === undefined ||
    before.isSymbolicLink() ||
    !before.isFile() ||
    before.nlink !== 1 ||
    before.size < 2 ||
    before.size > MAX_CLAIM_BYTES
  ) {
    throw new Error("The exact Human Gate action claim is missing or ambiguous");
  }
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    const parsed = JSON.parse(await handle.readFile("utf8")) as unknown;
    if (
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.size !== before.size ||
      !gateDecisionClaim(parsed) ||
      stableJson(parsed) !== stableJson(claim)
    ) {
      throw new Error("The exact Human Gate action claim is missing or ambiguous");
    }
  } finally {
    await handle.close();
  }
  const session = await loadMangekyoLoopSession(rootPath, projectId, claim.loopSessionId);
  const gateEvidence = session.currentGate;
  const policyEntry = session.policyEvaluations.find(
    ({ id }) => id === gateEvidence?.policyEvaluationId,
  );
  if (
    session.status !== "HUMAN_GATE" ||
    session.updatedAt !== claim.sessionVersion ||
    gateEvidence === undefined ||
    gateEvidence.id !== claim.gateId ||
    gateEvidence.proposal.sessionId !== session.id ||
    policyEntry === undefined ||
    policyEntry.proposalId !== gateEvidence.proposal.id ||
    stableJson(policyEntry.change) !== stableJson(gateEvidence.requestedChange) ||
    session.gateDecisions.some(({ gateId }) => gateId === claim.gateId)
  ) {
    throw new Error("The Human Gate session transitioned; retaining its action claim as ambiguous");
  }
  const current = await lstat(path);
  if (current.dev !== before.dev || current.ino !== before.ino || current.size !== before.size) {
    throw new Error("The Human Gate action claim changed before safe release");
  }
  await rm(path);
  const directoryHandle = await open(directory, constants.O_RDONLY);
  try {
    await directoryHandle.sync();
  } finally {
    await directoryHandle.close();
  }
}

export interface MangekyoStopRequest {
  id: string;
  loopSessionId: string;
  sessionVersion: string;
  requestedAt: string;
  requestedBy: string;
}

function stopRequest(value: unknown): value is MangekyoStopRequest {
  return (
    exact(value, ["id", "loopSessionId", "sessionVersion", "requestedAt", "requestedBy"]) &&
    identifier(value.id) &&
    identifier(value.loopSessionId) &&
    iso(value.sessionVersion) &&
    iso(value.requestedAt) &&
    Date.parse(value.requestedAt) >= Date.parse(value.sessionVersion) &&
    text(value.requestedBy, 256)
  );
}

async function stopRequests(
  directory: string,
  loopSessionId: string,
): Promise<MangekyoStopRequest[]> {
  const names = (await readdir(directory)).filter(
    (name) => /^action-[0-9a-f]{64}\.claim$/.test(name),
  );
  if (names.length > 64) throw new Error("Mangekyo action claim history exceeds its bound");
  const requests: MangekyoStopRequest[] = [];
  for (const name of names) {
    const path = assertPathInsideWorkspace(directory, join(directory, name));
    const before = await lstat(path);
    if (
      before.isSymbolicLink() ||
      !before.isFile() ||
      before.nlink !== 1 ||
      before.size < 2 ||
      before.size > MAX_CLAIM_BYTES
    ) {
      throw new Error("Mangekyo action claim is invalid or ambiguous");
    }
    const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const opened = await handle.stat();
      if (
        !opened.isFile() ||
        opened.dev !== before.dev ||
        opened.ino !== before.ino ||
        opened.size !== before.size
      ) {
        throw new Error("Mangekyo action claim changed while it was authenticated");
      }
      const parsed = JSON.parse(await handle.readFile("utf8")) as unknown;
      if (stopRequest(parsed) && parsed.loopSessionId === loopSessionId) requests.push(parsed);
    } finally {
      await handle.close();
    }
  }
  return requests;
}

export async function requestMangekyoStop(
  rootPath: string,
  projectId: string,
  request: MangekyoStopRequest,
): Promise<MangekyoStopRequest> {
  if (!stopRequest(request)) throw new Error("Mangekyo Stop request is invalid");
  const directory = await mangekyoClaimRoot(rootPath, projectId);
  const existing = await stopRequests(directory, request.loopSessionId);
  if (existing.length > 1) throw new Error("Mangekyo Stop request is ambiguous");
  if (existing[0] !== undefined) return structuredClone(existing[0]);
  const digest = createHash("sha256")
    .update(`${request.loopSessionId}\0${request.sessionVersion}`)
    .digest("hex");
  await writeExclusiveClaim(
    directory,
    `action-${digest}.claim`,
    request,
    "Mangekyo session version already has an action",
  );
  return structuredClone(request);
}

export async function loadMangekyoStopRequest(
  rootPath: string,
  projectId: string,
  loopSessionId: string,
): Promise<MangekyoStopRequest | undefined> {
  if (!identifier(loopSessionId)) throw new Error("Invalid Mangekyo loop session id");
  const directory = await mangekyoClaimRoot(rootPath, projectId);
  const requests = await stopRequests(directory, loopSessionId);
  if (requests.length > 1) throw new Error("Mangekyo Stop request is ambiguous");
  return requests[0];
}

export async function consumeMangekyoApproveOnceAuthorization(
  rootPath: string,
  projectId: string,
  claim: {
    loopSessionId: string;
    sessionVersion: string;
    gateId: string;
    decisionId: string;
    proposalId: string;
  },
): Promise<void> {
  if (
    !exact(claim, [
      "loopSessionId",
      "sessionVersion",
      "gateId",
      "decisionId",
      "proposalId",
    ]) ||
    !identifier(claim.loopSessionId) ||
    !iso(claim.sessionVersion) ||
    !identifier(claim.gateId) ||
    !identifier(claim.decisionId) ||
    !identifier(claim.proposalId)
  ) {
    throw new Error("Approve Once consumption claim is invalid");
  }
  const directory = await mangekyoClaimRoot(rootPath, projectId);
  const digest = createHash("sha256")
    .update(`${claim.loopSessionId}\0${claim.gateId}\0${claim.decisionId}`)
    .digest("hex");
  await writeExclusiveClaim(
    directory,
    `approve-once-${digest}.claim`,
    claim,
    "Approve Once authorization was already consumed",
  );
}

export async function saveMangekyoAuthorization(
  rootPath: string,
  projectId: string,
  value: unknown,
): Promise<void> {
  if (!authorization(value)) throw new Error("Invalid Mangekyo authorization evidence");
  const directory = await authorizationRoot(rootPath, projectId);
  const destination = assertPathInsideWorkspace(directory, join(directory, `${value.id}.json`));
  const serialized = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > MAX_AUTHORIZATION_BYTES) {
    throw new Error("Mangekyo authorization evidence exceeds its byte bound");
  }
  const temporary = assertPathInsideWorkspace(
    directory,
    join(directory, `.${value.id}.${randomUUID()}.tmp`),
  );
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    await handle.writeFile(serialized, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, destination);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function loadMangekyoAuthorization(
  rootPath: string,
  projectId: string,
  authorizationId: string,
): Promise<unknown> {
  if (!identifier(authorizationId)) throw new Error("Invalid Mangekyo authorization id");
  const directory = await authorizationRoot(rootPath, projectId);
  const path = assertPathInsideWorkspace(directory, join(directory, `${authorizationId}.json`));
  const before = await lstat(path);
  if (
    before.isSymbolicLink() ||
    !before.isFile() ||
    before.nlink !== 1 ||
    before.size < 2 ||
    before.size > MAX_AUTHORIZATION_BYTES
  ) {
    throw new Error("Invalid Mangekyo authorization record");
  }
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.size !== before.size
    ) {
      throw new Error("Mangekyo authorization changed while it was authenticated");
    }
    const parsed = JSON.parse(await handle.readFile("utf8")) as unknown;
    if (!authorization(parsed) || parsed.id !== authorizationId) {
      throw new Error("Invalid Mangekyo authorization evidence");
    }
    return parsed;
  } finally {
    await handle.close();
  }
}

export async function loadMangekyoRenderImage(
  rootPath: string,
  projectId: string,
  renderId: string,
): Promise<{ bytes: Uint8Array; type: "image/png" | "image/jpeg" | "image/webp" }> {
  if (!identifier(renderId)) throw new Error("Invalid Mangekyo render id");
  const records = (await listSessions(rootPath, projectId)).filter(
    ({ type }) => type === "MANGEKYO_LOOP",
  );
  const sessions = await Promise.all(
    records.map(({ id }) => loadMangekyoLoopSession(rootPath, projectId, id)),
  );
  const matches = sessions.flatMap((session) => [
    session.initialRender,
    session.finalRender,
    ...session.rounds.flatMap(({ round }) => [round.beforeRender, round.afterRender]),
  ]).filter(
    (artifact): artifact is RenderArtifact => artifact !== undefined && artifact.id === renderId,
  );
  const artifact = matches[0];
  if (
    artifact === undefined ||
    matches.some((candidate) => stableJson(candidate) !== stableJson(artifact))
  ) {
    throw new Error("Mangekyo render evidence is missing or ambiguous");
  }
  await assertRenderPath(rootPath, artifact);
  const before = await lstat(artifact.imagePath);
  const handle = await open(artifact.imagePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.size !== before.size
    ) {
      throw new Error("Mangekyo render changed while it was authenticated");
    }
    const bytes = await handle.readFile();
    const isPng = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const isJpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    const isWebp = bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
      bytes.subarray(8, 12).toString("ascii") === "WEBP";
    if (!isPng && !isJpeg && !isWebp) {
      throw new Error("Mangekyo render has an unsupported binary signature");
    }
    return {
      bytes,
      type: isPng ? "image/png" : isJpeg ? "image/jpeg" : "image/webp",
    };
  } finally {
    await handle.close();
  }
}
