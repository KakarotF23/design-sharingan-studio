import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, rm } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
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
    texts(value.protectedPaths, 128, 512, true)
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

function sourceRevision(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  if ((value as { kind?: unknown }).kind === "UNVERSIONED") {
    return (
      exact(value, ["kind", "available", "reason"]) &&
      value.available === false &&
      (value.reason === "NOT_A_GIT_WORKSPACE" || value.reason === "GIT_EVIDENCE_UNAVAILABLE")
    );
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
    ]) &&
    value.kind === "GIT" &&
    value.available === true &&
    text(value.head, 128) &&
    text(value.branch, 512) &&
    (value.status === "CLEAN" || value.status === "DIRTY") &&
    Array.isArray(value.entries) &&
    value.entries.length <= 1_024 &&
    value.entries.every(
      (entry) =>
        entry !== null &&
        typeof entry === "object" &&
        !Array.isArray(entry) &&
        Object.keys(entry).every((key) => ["index", "workingTree", "path", "originalPath"].includes(key)) &&
        typeof (entry as { index?: unknown }).index === "string" &&
        ((entry as { index: string }).index.length === 1) &&
        typeof (entry as { workingTree?: unknown }).workingTree === "string" &&
        ((entry as { workingTree: string }).workingTree.length === 1) &&
        text((entry as { path?: unknown }).path, 512),
    ) &&
    typeof value.truncated === "boolean" &&
    typeof value.worktreeFingerprint === "string" &&
    /^[0-9a-f]{64}$/.test(value.worktreeFingerprint) &&
    Number.isSafeInteger(value.fileCount) &&
    (value.fileCount as number) >= 0
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
    "genomeIntegrity",
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
    text(value.uxIntegrity, 1_000) &&
    text(value.genomeIntegrity, 1_000) &&
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
      "visualAnalysisThreadId",
      ...optional,
    ]) &&
    visualRound(value.round, session) &&
    proposal(value.proposal, session.id) &&
    text(value.proposalThreadId, 256) &&
    identifier(value.policyEvaluationId) &&
    iso(value.mutationCompletedAt) &&
    text(value.visualAnalysisThreadId, 256) &&
    (value.gateDecisionId === undefined || identifier(value.gateDecisionId))
  );
}

export function isMangekyoLoopSession(value: unknown): value is MangekyoLoopSession {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const optional = [
    ...(Object.hasOwn(value, "currentGate") ? ["currentGate"] : []),
    ...(Object.hasOwn(value, "initialRender") ? ["initialRender"] : []),
    ...(Object.hasOwn(value, "finalRender") ? ["finalRender"] : []),
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
    (session.stopReason === undefined || text(session.stopReason, 2_000))
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
