import type {
  AutonomyChange,
  AutonomyChangeKind,
  AutonomyPolicy,
  ChangeProposal,
  MangekyoHumanGateDecision,
  MangekyoLoopSession,
  MangekyoPolicyEvaluationEvidence,
  MangekyoRenderTarget,
  RenderArtifact,
  VisualFinding,
  VisualRound,
} from "@design-sharingan/core";
import { evaluateAutonomyPolicy } from "@design-sharingan/core";
import { evaluateStopCriteria } from "./stop-criteria";

export interface ProposedVisualChange {
  proposal: ChangeProposal;
  proposalThreadId: string;
  change: AutonomyChange;
  objective: string;
  affectedScope: string[];
  impact: string;
}

export type MangekyoMutationAuthorization =
  | {
      kind: "POLICY_ALLOW";
      policyEvaluation: MangekyoPolicyEvaluationEvidence;
    }
  | {
      kind: "APPROVE_ONCE";
      decision: MangekyoHumanGateDecision & { decision: "APPROVE_ONCE" };
    };

export interface MangekyoMutationResult {
  proposalId: string;
  threadId: string;
  filesChanged: string[];
  completedAt: string;
}

export interface MangekyoLoopDependencies {
  createId(): string;
  now(): Date;
  proposeChange(
    session: MangekyoLoopSession,
    roundNumber: number,
  ): Promise<ProposedVisualChange>;
  persist(session: MangekyoLoopSession): Promise<void>;
  load(sessionId: string): Promise<MangekyoLoopSession | undefined>;
  executeChange(input: {
    session: MangekyoLoopSession;
    proposal: ChangeProposal;
    proposalThreadId: string;
    change: AutonomyChange;
    authorization: MangekyoMutationAuthorization;
  }): Promise<MangekyoMutationResult>;
  runProject(input: {
    session: MangekyoLoopSession;
    roundNumber: number;
    mutation: MangekyoMutationResult;
  }): Promise<void>;
  capture(input: {
    session: MangekyoLoopSession;
    roundNumber: number;
    mutation: MangekyoMutationResult;
  }): Promise<RenderArtifact>;
  analyze(input: {
    session: MangekyoLoopSession;
    roundNumber: number;
    render: RenderArtifact;
  }): Promise<{ threadId: string; findings: VisualFinding[] }>;
  stopProject?(): Promise<void>;
  userStopped?(): boolean;
}

export interface FreshFinalRenderInput {
  artifact: RenderArtifact;
  mutationCompletedAt: string;
  changedPaths: readonly string[];
  target: MangekyoRenderTarget;
}

export type HumanGateResolution =
  | {
      decision: "REJECT" | "APPROVE_ONCE";
      decidedBy: string;
      comment?: string;
    }
  | {
      decision: "EXPAND_SCOPE";
      decidedBy: string;
      expandKind: AutonomyChangeKind;
      comment?: string;
    };

function safeIdentifier(value: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value);
}

function iso(value: string): boolean {
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
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

function cloneSession(session: MangekyoLoopSession): MangekyoLoopSession {
  return structuredClone(session);
}

function timestamp(dependencies: MangekyoLoopDependencies): string {
  const value = dependencies.now();
  if (!Number.isFinite(value.getTime())) throw new Error("Mangekyo clock is invalid");
  return value.toISOString();
}

function failureReason(prefix: string, error: unknown): string {
  const detail = error instanceof Error ? error.message : "Unknown failure";
  const combined = `${prefix}: ${detail}`;
  let result = "";
  let bytes = 0;
  for (const codePoint of combined) {
    const size = new TextEncoder().encode(codePoint).byteLength;
    if (bytes + size > 2_000) break;
    result += codePoint;
    bytes += size;
  }
  return result || prefix;
}

function assertPendingChange(
  session: MangekyoLoopSession,
  roundNumber: number,
  pending: ProposedVisualChange,
): void {
  const proposalFiles = [
    ...pending.proposal.filesToCreate,
    ...pending.proposal.filesToModify,
    ...pending.proposal.filesToDelete,
  ];
  if (
    roundNumber < 1 ||
    roundNumber > session.maxRounds ||
    pending.proposal.sessionId !== session.id ||
    !safeIdentifier(pending.proposal.id) ||
    pending.proposal.status !== "PROPOSED" ||
    pending.proposal.requiresHumanApproval !== true ||
    !pending.proposalThreadId ||
    new TextEncoder().encode(pending.proposalThreadId).byteLength > 256 ||
    stableJson(proposalFiles) !== stableJson(pending.change.files) ||
    !pending.objective.trim() ||
    !pending.impact.trim() ||
    pending.affectedScope.length === 0
  ) {
    throw new Error("Proposed visual change is missing, ambiguous, or outside loop scope");
  }
}

async function persistAndReload(
  session: MangekyoLoopSession,
  dependencies: MangekyoLoopDependencies,
  evidenceLabel: string,
): Promise<MangekyoLoopSession> {
  await dependencies.persist(session);
  const persisted = await dependencies.load(session.id);
  if (persisted === undefined || stableJson(persisted) !== stableJson(session)) {
    throw new Error(`Persisted ${evidenceLabel} is missing, stale, or tampered`);
  }
  return cloneSession(persisted);
}

function withStatus(
  session: MangekyoLoopSession,
  status: MangekyoLoopSession["status"],
  dependencies: MangekyoLoopDependencies,
): MangekyoLoopSession {
  return { ...cloneSession(session), status, updatedAt: timestamp(dependencies) };
}

export function isFreshFinalRender(input: FreshFinalRenderInput): boolean {
  const revision = input.artifact.sourceRevision;
  if (
    !iso(input.mutationCompletedAt) ||
    !iso(input.artifact.capturedAt) ||
    Date.parse(input.artifact.capturedAt) <= Date.parse(input.mutationCompletedAt) ||
    input.artifact.route !== input.target.route ||
    input.artifact.viewport !== input.target.viewport.name ||
    input.artifact.viewportWidth !== input.target.viewport.width ||
    input.artifact.viewportHeight !== input.target.viewport.height ||
    revision.kind !== "GIT" ||
    revision.available !== true ||
    revision.truncated ||
    !/^[0-9a-f]{64}$/.test(revision.worktreeFingerprint)
  ) {
    return false;
  }
  const evidencedPaths = new Set(
    revision.entries.flatMap(({ path, originalPath }) =>
      originalPath === undefined ? [path] : [path, originalPath],
    ),
  );
  return input.changedPaths.length > 0 && input.changedPaths.every((path) => evidencedPaths.has(path));
}

function findingsCounts(findings: readonly VisualFinding[]) {
  return {
    criticalCount: findings.filter(({ severity }) => severity === "CRITICAL").length,
    importantCount: findings.filter(({ severity }) => severity === "IMPORTANT").length,
    polishCount: findings.filter(({ severity }) => severity === "POLISH").length,
    uxRegressions: findings.filter(
      ({ category, severity }) =>
        category === "ACCESSIBILITY" &&
        (severity === "CRITICAL" || severity === "IMPORTANT"),
    ).length,
    genomeConflicts: findings.filter(
      ({ category, severity }) =>
        category === "GENOME" &&
        (severity === "CRITICAL" || severity === "IMPORTANT"),
    ).length,
  };
}

async function executeRound(
  session: MangekyoLoopSession,
  roundNumber: number,
  pending: ProposedVisualChange,
  policyEvaluation: MangekyoPolicyEvaluationEvidence,
  authorization: MangekyoMutationAuthorization,
  dependencies: MangekyoLoopDependencies,
): Promise<MangekyoLoopSession> {
  let working = cloneSession(session);
  let mutation: MangekyoMutationResult;
  try {
    mutation = await dependencies.executeChange({
      session: cloneSession(working),
      proposal: pending.proposal,
      proposalThreadId: pending.proposalThreadId,
      change: pending.change,
      authorization,
    });
  } catch (error) {
    const failed: MangekyoLoopSession = {
      ...withStatus(working, "FAILED", dependencies),
      stopReason: failureReason("Authorized mutation failed", error),
    };
    return persistAndReload(failed, dependencies, "mutation failure checkpoint");
  }
  const expectedFiles = [
    ...pending.proposal.filesToCreate,
    ...pending.proposal.filesToModify,
    ...pending.proposal.filesToDelete,
  ];
  if (
    mutation.proposalId !== pending.proposal.id ||
    mutation.threadId !== pending.proposalThreadId ||
    stableJson(mutation.filesChanged) !== stableJson(expectedFiles) ||
    !iso(mutation.completedAt)
  ) {
    throw new Error("Autonomous mutation evidence is missing, stale, or ambiguous");
  }

  working = withStatus(working, "RUNNING", dependencies);
  working.currentGate = undefined;
  working = await persistAndReload(working, dependencies, "running checkpoint");
  try {
    await dependencies.runProject({ session: cloneSession(working), roundNumber, mutation });
  } catch (error) {
    await dependencies.stopProject?.().catch(() => undefined);
    const failed = {
      ...withStatus(working, "FAILED", dependencies),
      stopReason: failureReason("Critical build failure", error),
    };
    return persistAndReload(failed, dependencies, "build failure checkpoint");
  }

  working = withStatus(working, "CAPTURING", dependencies);
  working = await persistAndReload(working, dependencies, "capture checkpoint");
  let afterRender: RenderArtifact | undefined;
  let captureFailure: unknown;
  try {
    afterRender = await dependencies.capture({
      session: cloneSession(working),
      roundNumber,
      mutation,
    });
  } catch (error) {
    captureFailure = error;
  }
  try {
    await dependencies.stopProject?.();
  } catch (error) {
    captureFailure ??= error;
  }
  if (captureFailure !== undefined || afterRender === undefined) {
    const failed: MangekyoLoopSession = {
      ...withStatus(working, "FAILED", dependencies),
      stopReason: failureReason("Fresh render capture evidence failed", captureFailure),
    };
    return persistAndReload(failed, dependencies, "capture failure checkpoint");
  }

  working = withStatus(working, "COMPARING", dependencies);
  working = await persistAndReload(working, dependencies, "comparison checkpoint");
  let analysis: Awaited<ReturnType<MangekyoLoopDependencies["analyze"]>>;
  try {
    analysis = await dependencies.analyze({
      session: cloneSession(working),
      roundNumber,
      render: afterRender,
    });
  } catch (error) {
    const failed: MangekyoLoopSession = {
      ...withStatus(working, "FAILED", dependencies),
      stopReason: failureReason("Rendered visual analysis evidence failed", error),
    };
    return persistAndReload(failed, dependencies, "analysis failure checkpoint");
  }
  if (!analysis.threadId || new TextEncoder().encode(analysis.threadId).byteLength > 256) {
    throw new Error("Visual analysis thread evidence is invalid");
  }
  const counts = findingsCounts(analysis.findings);
  const beforeRender = working.rounds.at(-1)?.round.afterRender ?? working.initialRender;
  const completedAt = timestamp(dependencies);
  const fresh = isFreshFinalRender({
    artifact: afterRender,
    mutationCompletedAt: mutation.completedAt,
    changedPaths: mutation.filesChanged,
    target: working.renderTarget,
  });
  const inspectedScreens = fresh
    ? [...new Set([...working.inspectedScreens, afterRender.route])]
    : [...working.inspectedScreens];
  const stop = evaluateStopCriteria({
    round: roundNumber,
    maxRounds: working.maxRounds,
    criticalCount: counts.criticalCount,
    importantCount: counts.importantCount,
    importantThreshold: working.importantThreshold,
    uxRegressions: counts.uxRegressions,
    genomeConflicts: counts.genomeConflicts,
    hasFreshFinalRender: fresh,
    userStopped: dependencies.userStopped?.() ?? false,
    claimedScreens: working.claimedScreens,
    inspectedScreens,
  });
  const nextStatus = stop.pass
    ? "COMPLETE"
    : stop.stop
      ? stop.outcome === "BUILD_FAILED"
        ? "FAILED"
        : "BLOCKED"
      : "FIXING";
  const visualRound: VisualRound = {
    roundNumber,
    startedAt: policyEvaluation.evaluatedAt,
    completedAt,
    ...(beforeRender === undefined ? {} : { beforeRender }),
    afterRender,
    filesChanged: [...mutation.filesChanged],
    findingsBefore: working.rounds.at(-1)?.round.findingsAfter ?? [],
    actions: [pending.objective],
    findingsAfter: analysis.findings.map((finding) => structuredClone(finding)),
    criticalCount: counts.criticalCount,
    importantCount: counts.importantCount,
    polishCount: counts.polishCount,
    uxIntegrity: counts.uxRegressions === 0 ? "PASS" : "REGRESSION",
    genomeIntegrity: counts.genomeConflicts === 0 ? "PASS" : "CONFLICT",
    status: nextStatus,
  };
  const completed: MangekyoLoopSession = {
    ...working,
    status: nextStatus,
    updatedAt: completedAt,
    inspectedScreens,
    rounds: [
      ...working.rounds,
      {
        round: visualRound,
        proposal: structuredClone(pending.proposal),
        proposalThreadId: pending.proposalThreadId,
        policyEvaluationId: policyEvaluation.id,
        mutationCompletedAt: mutation.completedAt,
        visualAnalysisThreadId: analysis.threadId,
        ...(authorization.kind === "APPROVE_ONCE"
          ? { gateDecisionId: authorization.decision.id }
          : {}),
      },
    ],
    currentGate: undefined,
    ...(stop.pass ? { finalRender: afterRender } : {}),
    ...(stop.stop || stop.pass ? { stopReason: stop.reason } : {}),
  };
  return persistAndReload(completed, dependencies, "visual round checkpoint");
}

async function processPendingChange(
  session: MangekyoLoopSession,
  roundNumber: number,
  pending: ProposedVisualChange,
  dependencies: MangekyoLoopDependencies,
): Promise<MangekyoLoopSession> {
  assertPendingChange(session, roundNumber, pending);
  const evaluatedAt = timestamp(dependencies);
  const rawEvaluation = evaluateAutonomyPolicy(session.policy, pending.change);
  const policyEvaluation: MangekyoPolicyEvaluationEvidence = {
    id: dependencies.createId(),
    roundNumber,
    proposalId: pending.proposal.id,
    change: { kind: pending.change.kind, files: [...pending.change.files] },
    policy: { ...session.policy, protectedPaths: [...session.policy.protectedPaths] },
    evaluation: {
      decision: rawEvaluation.decision,
      reasons: [...rawEvaluation.reasons],
    },
    evaluatedAt,
  };
  if (!safeIdentifier(policyEvaluation.id)) {
    throw new Error("Policy evaluation identity is invalid");
  }
  let checked: MangekyoLoopSession = {
    ...withStatus(session, "POLICY_CHECK", dependencies),
    policyEvaluations: [...session.policyEvaluations, policyEvaluation],
    currentGate: undefined,
  };
  checked = await persistAndReload(checked, dependencies, "policy checkpoint");
  if (rawEvaluation.decision === "HUMAN_GATE") {
    const gate = {
      id: dependencies.createId(),
      roundNumber,
      requestedChange: { kind: pending.change.kind, files: [...pending.change.files] },
      proposal: structuredClone(pending.proposal),
      proposalThreadId: pending.proposalThreadId,
      policyEvaluationId: policyEvaluation.id,
      requestedAt: timestamp(dependencies),
      reasons: rawEvaluation.reasons.length > 0
        ? [...rawEvaluation.reasons]
        : ["The requested change exceeds the explicit loop policy."],
      affectedScope: [...pending.affectedScope],
      impact: pending.impact,
    };
    if (!safeIdentifier(gate.id)) throw new Error("Human gate identity is invalid");
    const gated: MangekyoLoopSession = {
      ...withStatus(checked, "HUMAN_GATE", dependencies),
      gates: [...checked.gates, gate],
      currentGate: gate,
      stopReason: "A policy boundary requires a human decision.",
    };
    return persistAndReload(gated, dependencies, "human gate checkpoint");
  }
  return executeRound(
    checked,
    roundNumber,
    pending,
    policyEvaluation,
    { kind: "POLICY_ALLOW", policyEvaluation },
    dependencies,
  );
}

export async function runMangekyoLoop(
  session: MangekyoLoopSession,
  dependencies: MangekyoLoopDependencies,
): Promise<MangekyoLoopSession> {
  if (
    session.type !== "MANGEKYO_LOOP" ||
    session.maxRounds !== 5 ||
    session.referenceIds.length === 0 ||
    session.initialRender === undefined ||
    session.initialRender.route !== session.renderTarget.route
  ) {
    throw new Error("Mangekyo entry evidence is missing or ambiguous");
  }
  let working = cloneSession(session);
  if (working.status === "IDLE") {
    working = await persistAndReload(
      withStatus(working, "PREPARING", dependencies),
      dependencies,
      "preparation checkpoint",
    );
  }
  while (working.status === "PREPARING" || working.status === "FIXING") {
    const roundNumber = working.rounds.length + 1;
    if (roundNumber > working.maxRounds) {
      const blocked: MangekyoLoopSession = {
        ...withStatus(working, "BLOCKED", dependencies),
        stopReason: "Maximum visual round budget reached before quality criteria passed.",
      };
      return persistAndReload(blocked, dependencies, "maximum-round checkpoint");
    }
    let pending: ProposedVisualChange;
    try {
      pending = await dependencies.proposeChange(cloneSession(working), roundNumber);
    } catch (error) {
      const failed: MangekyoLoopSession = {
        ...withStatus(working, "FAILED", dependencies),
        stopReason: failureReason("Visual change proposal evidence failed", error),
      };
      return persistAndReload(failed, dependencies, "proposal failure checkpoint");
    }
    working = await processPendingChange(working, roundNumber, pending, dependencies);
  }
  return working;
}

function expandedPolicy(policy: AutonomyPolicy, kind: AutonomyChangeKind): AutonomyPolicy {
  switch (kind) {
    case "STYLE_CHANGE":
      return { ...policy, allowStyleChanges: true, protectedPaths: [...policy.protectedPaths] };
    case "COMPONENT_REFACTOR":
      return { ...policy, allowSmallComponentRefactors: true, protectedPaths: [...policy.protectedPaths] };
    case "PRESENTATIONAL_COMPONENT":
      return { ...policy, allowNewPresentationalComponents: true, protectedPaths: [...policy.protectedPaths] };
    case "DEPENDENCY_INSTALL":
      return { ...policy, allowDependencyInstall: true, protectedPaths: [...policy.protectedPaths] };
    case "NAVIGATION_CHANGE":
      return { ...policy, allowNavigationChanges: true, protectedPaths: [...policy.protectedPaths] };
    case "DATA_MODEL_CHANGE":
      return { ...policy, allowDataModelChanges: true, protectedPaths: [...policy.protectedPaths] };
    case "FILE_DELETION":
      return { ...policy, allowFileDeletion: true, protectedPaths: [...policy.protectedPaths] };
  }
}

export async function resolveHumanGate(
  session: MangekyoLoopSession,
  resolution: HumanGateResolution,
  dependencies: MangekyoLoopDependencies,
): Promise<MangekyoLoopSession> {
  if (session.status !== "HUMAN_GATE" || session.currentGate === undefined) {
    throw new Error("Mangekyo loop is not waiting at a human gate");
  }
  if (
    !resolution.decidedBy.trim() ||
    new TextEncoder().encode(resolution.decidedBy).byteLength > 256 ||
    (resolution.comment !== undefined && new TextEncoder().encode(resolution.comment).byteLength > 2_000)
  ) {
    throw new Error("Human gate decision evidence is invalid");
  }
  const gate = structuredClone(session.currentGate);
  if (
    resolution.decision === "EXPAND_SCOPE" &&
    resolution.expandKind !== gate.requestedChange.kind
  ) {
    throw new Error("Scope expansion must match the exact pending change kind");
  }
  const policyAfter = resolution.decision === "EXPAND_SCOPE"
    ? expandedPolicy(session.policy, resolution.expandKind)
    : undefined;
  const baseDecision: MangekyoHumanGateDecision = {
    id: dependencies.createId(),
    gateId: gate.id,
    decision: resolution.decision,
    decidedBy: resolution.decidedBy.trim(),
    createdAt: timestamp(dependencies),
    ...(resolution.comment?.trim() ? { comment: resolution.comment.trim() } : {}),
    ...(policyAfter === undefined ? {} : { policyAfter }),
  };
  if (!safeIdentifier(baseDecision.id)) throw new Error("Human gate decision id is invalid");
  let decided: MangekyoLoopSession = {
    ...cloneSession(session),
    updatedAt: baseDecision.createdAt,
    policy: policyAfter ?? session.policy,
    gates: session.gates.some(({ id }) => id === gate.id)
      ? [...session.gates]
      : [...session.gates, gate],
    gateDecisions: [...session.gateDecisions, baseDecision],
  };
  decided = await persistAndReload(decided, dependencies, "human gate decision checkpoint");

  if (resolution.decision === "REJECT") {
    const blocked: MangekyoLoopSession = {
      ...withStatus(decided, "BLOCKED", dependencies),
      currentGate: undefined,
      stopReason: "The pending policy-boundary change was rejected.",
    };
    return persistAndReload(blocked, dependencies, "rejected gate checkpoint");
  }

  const pending: ProposedVisualChange = {
    proposal: gate.proposal,
    proposalThreadId: gate.proposalThreadId,
    change: gate.requestedChange,
    objective: gate.proposal.summary,
    affectedScope: gate.affectedScope,
    impact: gate.impact,
  };
  if (resolution.decision === "EXPAND_SCOPE") {
    const resumed = { ...decided, currentGate: undefined };
    return processPendingChange(resumed, gate.roundNumber, pending, dependencies);
  }

  const policyEvaluation = decided.policyEvaluations.find(
    ({ id }) => id === gate.policyEvaluationId,
  );
  if (policyEvaluation === undefined || policyEvaluation.evaluation.decision !== "HUMAN_GATE") {
    throw new Error("Approve Once is missing its exact persisted gate evaluation");
  }
  const approveOnceDecision = baseDecision as MangekyoHumanGateDecision & {
    decision: "APPROVE_ONCE";
  };
  const resumed = { ...decided, currentGate: undefined };
  return executeRound(
    resumed,
    gate.roundNumber,
    pending,
    policyEvaluation,
    { kind: "APPROVE_ONCE", decision: approveOnceDecision },
    dependencies,
  );
}
