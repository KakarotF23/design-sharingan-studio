import type {
  AutonomyChange,
  AutonomyChangeKind,
  AutonomyPolicy,
  ChangeProposal,
  MangekyoHumanGateDecision,
  MangekyoLoopSession,
  MangekyoPolicyEvaluationEvidence,
  MangekyoRenderTarget,
  MangekyoStopRequest,
  RenderArtifact,
  RenderSourceRevision,
  VisualFinding,
  VisualIntegrityVerification,
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
  sourceRevision: RenderSourceRevision;
}

export interface MangekyoLoopDependencies {
  createId(): string;
  now(): Date;
  claimGateDecision(claim: {
    loopSessionId: string;
    sessionVersion: string;
    gateId: string;
    decisionId: string;
    decision: "REJECT" | "APPROVE_ONCE" | "EXPAND_SCOPE";
    decidedAt: string;
  }): Promise<void>;
  releaseGateDecisionClaim?(claim: {
    loopSessionId: string;
    sessionVersion: string;
    gateId: string;
    decisionId: string;
    decision: "REJECT" | "APPROVE_ONCE" | "EXPAND_SCOPE";
    decidedAt: string;
  }): Promise<void>;
  loadStopRequest(session: MangekyoLoopSession): Promise<MangekyoStopRequest | undefined>;
  proposeChange(
    session: MangekyoLoopSession,
    roundNumber: number,
  ): Promise<ProposedVisualChange>;
  persist(session: MangekyoLoopSession): Promise<void>;
  load(sessionId: string): Promise<MangekyoLoopSession | undefined>;
  commitTerminalTransition(input: {
    expectedVersion: string;
    session: MangekyoLoopSession;
  }): Promise<
    | { outcome: "COMMITTED"; session: MangekyoLoopSession }
    | { outcome: "STOP_WON"; stopRequest: MangekyoStopRequest }
  >;
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
  }): Promise<{
    threadId: string;
    findings: VisualFinding[];
    verification: {
      uxIntegrity: VisualIntegrityVerification;
      productConsistency: VisualIntegrityVerification;
      accessibility: VisualIntegrityVerification;
      genomeIntegrity: VisualIntegrityVerification;
    };
    genomeEvidenceVersion?: string;
  }>;
  stopProject?(): Promise<void>;
  userStopped?(): boolean;
}

export interface FreshFinalRenderInput {
  artifact: RenderArtifact;
  mutationCompletedAt: string;
  changedPaths: readonly string[];
  mutationSourceRevision: RenderSourceRevision;
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

function mutationFailureEvidence(error: unknown): MangekyoLoopSession["mutationFailure"] {
  if (
    !(error instanceof Error) ||
    !("failure" in error) ||
    error.failure === null ||
    typeof error.failure !== "object" ||
    !("targetDisposition" in error.failure) ||
    !("affectedPaths" in error.failure) ||
    !["NO_TARGET_CHANGE", "ROLLED_BACK", "RECONCILIATION_REQUIRED"].includes(
      error.failure.targetDisposition as string,
    ) ||
    !Array.isArray(error.failure.affectedPaths) ||
    error.failure.affectedPaths.length === 0 ||
    error.failure.affectedPaths.length > 128 ||
    !error.failure.affectedPaths.every(
      (path) => typeof path === "string" && path.length > 0 && path.length <= 512,
    )
  ) {
    return undefined;
  }
  return {
    targetDisposition: error.failure.targetDisposition as NonNullable<
      MangekyoLoopSession["mutationFailure"]
    >["targetDisposition"],
    affectedPaths: [...error.failure.affectedPaths] as string[],
  };
}

function validStopRequest(
  request: MangekyoStopRequest,
  session: MangekyoLoopSession,
): boolean {
  return (
    safeIdentifier(request.id) &&
    request.loopSessionId === session.id &&
    iso(request.sessionVersion) &&
    iso(request.requestedAt) &&
    Date.parse(request.requestedAt) >= Date.parse(request.sessionVersion) &&
    Date.parse(request.sessionVersion) <= Date.parse(session.updatedAt) &&
    request.requestedBy.trim().length > 0 &&
    new TextEncoder().encode(request.requestedBy).byteLength <= 256
  );
}

async function stopCheckpoint(
  session: MangekyoLoopSession,
  dependencies: MangekyoLoopDependencies,
): Promise<MangekyoLoopSession | undefined> {
  const request = session.stopRequest ?? await dependencies.loadStopRequest(cloneSession(session));
  if (request === undefined) return undefined;
  if (!validStopRequest(request, session)) {
    throw new Error("Durable Mangekyo Stop request is stale, ambiguous, or invalid");
  }
  const { finalRender: _finalRender, ...withoutFinalPass } = cloneSession(session);
  return persistAndReload(
    {
      ...withoutFinalPass,
      status: "BLOCKED",
      updatedAt: timestamp(dependencies),
      currentGate: undefined,
      stopRequest: structuredClone(request),
      stopReason: "The user stopped the visual loop before completion.",
    },
    dependencies,
    "user Stop checkpoint",
  );
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
  const mutationRevision = input.mutationSourceRevision;
  if (
    !iso(input.mutationCompletedAt) ||
    !iso(input.artifact.capturedAt) ||
    Date.parse(input.artifact.capturedAt) <= Date.parse(input.mutationCompletedAt) ||
    input.artifact.route !== input.target.route ||
    input.artifact.viewport !== input.target.viewport.name ||
    input.artifact.viewportWidth !== input.target.viewport.width ||
    input.artifact.viewportHeight !== input.target.viewport.height ||
    revision.available !== true ||
    revision.truncated ||
    !/^[0-9a-f]{64}$/.test(revision.worktreeFingerprint) ||
    mutationRevision.available !== true ||
    mutationRevision.truncated ||
    !/^[0-9a-f]{64}$/.test(mutationRevision.worktreeFingerprint) ||
    stableJson(revision) !== stableJson(mutationRevision)
  ) {
    return false;
  }
  if (input.changedPaths.length === 0) return false;
  const evidencedPaths = new Set(revision.requiredPathEvidence.map(({ path }) => path));
  return input.changedPaths.every((path) => evidencedPaths.has(path));
}

function findingsCounts(findings: readonly VisualFinding[]) {
  return {
    criticalCount: findings.filter(({ severity }) => severity === "CRITICAL").length,
    importantCount: findings.filter(({ severity }) => severity === "IMPORTANT").length,
    polishCount: findings.filter(({ severity }) => severity === "POLISH").length,
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
  working = withStatus(working, "EDITING", dependencies);
  working.currentGate = undefined;
  working = await persistAndReload(working, dependencies, "editing checkpoint");
  const stoppedBeforeMutation = await stopCheckpoint(working, dependencies);
  if (stoppedBeforeMutation !== undefined) return stoppedBeforeMutation;
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
    const mutationFailure = mutationFailureEvidence(error);
    const failed: MangekyoLoopSession = {
      ...withStatus(working, "FAILED", dependencies),
      stopReason: failureReason("Authorized mutation failed", error),
      ...(mutationFailure === undefined ? {} : { mutationFailure }),
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
    !iso(mutation.completedAt) ||
    mutation.sourceRevision.available !== true ||
    mutation.sourceRevision.truncated ||
    !/^[0-9a-f]{64}$/.test(mutation.sourceRevision.worktreeFingerprint)
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
    mutationSourceRevision: mutation.sourceRevision,
    target: working.renderTarget,
  });
  const inspectedScreens = fresh
    ? [...new Set([...working.inspectedScreens, afterRender.route])]
    : [...working.inspectedScreens];
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
    uxIntegrity: structuredClone(analysis.verification.uxIntegrity),
    productConsistency: structuredClone(analysis.verification.productConsistency),
    accessibility: structuredClone(analysis.verification.accessibility),
    genomeIntegrity: structuredClone(analysis.verification.genomeIntegrity),
    ...(analysis.genomeEvidenceVersion === undefined
      ? {}
      : { genomeEvidenceVersion: analysis.genomeEvidenceVersion }),
    status: "DECIDING",
  };
  const deciding: MangekyoLoopSession = {
    ...working,
    status: "DECIDING",
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
        mutationSourceRevision: structuredClone(mutation.sourceRevision),
        visualAnalysisThreadId: analysis.threadId,
        ...(authorization.kind === "APPROVE_ONCE"
          ? { gateDecisionId: authorization.decision.id }
          : {}),
      },
    ],
    currentGate: undefined,
  };
  const checkpoint = await persistAndReload(deciding, dependencies, "deciding checkpoint");
  return finalizeDecidingRound(checkpoint, dependencies);
}

async function finalizeDecidingRound(
  session: MangekyoLoopSession,
  dependencies: MangekyoLoopDependencies,
): Promise<MangekyoLoopSession> {
  const latest = session.rounds.at(-1);
  const afterRender = latest?.round.afterRender;
  if (
    session.status !== "DECIDING" ||
    latest === undefined ||
    latest.round.status !== "DECIDING" ||
    afterRender === undefined
  ) {
    throw new Error("Durable deciding checkpoint is missing its completed visual evidence");
  }
  const counts = findingsCounts(latest.round.findingsAfter);
  const stopRequest = session.stopRequest ?? await dependencies.loadStopRequest(cloneSession(session));
  if (stopRequest !== undefined && !validStopRequest(stopRequest, session)) {
    throw new Error("Durable Mangekyo Stop request is stale, ambiguous, or invalid");
  }
  const fresh = isFreshFinalRender({
    artifact: afterRender,
    mutationCompletedAt: latest.mutationCompletedAt,
    changedPaths: latest.round.filesChanged,
    mutationSourceRevision: latest.mutationSourceRevision,
    target: session.renderTarget,
  });
  const stop = evaluateStopCriteria({
    round: latest.round.roundNumber,
    maxRounds: session.maxRounds,
    criticalCount: counts.criticalCount,
    importantCount: counts.importantCount,
    importantThreshold: session.importantThreshold,
    integrity: {
      uxIntegrity: latest.round.uxIntegrity.status === "PASS" ? "PASS" : latest.round.uxIntegrity.status === "NOT_VERIFIED" ? "NOT_VERIFIED" : "REGRESSION",
      productConsistency: latest.round.productConsistency.status === "PASS" ? "PASS" : latest.round.productConsistency.status === "NOT_VERIFIED" ? "NOT_VERIFIED" : "REGRESSION",
      accessibility: latest.round.accessibility.status === "PASS" ? "PASS" : latest.round.accessibility.status === "NOT_VERIFIED" ? "NOT_VERIFIED" : "REGRESSION",
      genomeIntegrity: latest.round.genomeIntegrity.status === "PASS" ? "PASS" : latest.round.genomeIntegrity.status === "NOT_VERIFIED" ? "NOT_VERIFIED" : "CONFLICT",
    },
    hasFreshFinalRender: fresh,
    userStopped: stopRequest !== undefined || (dependencies.userStopped?.() ?? false),
    claimedScreens: session.claimedScreens,
    inspectedScreens: session.inspectedScreens,
  });
  const nextStatus = stop.pass
    ? "COMPLETE"
    : stop.stop
      ? stop.outcome === "BUILD_FAILED"
        ? "FAILED"
        : "BLOCKED"
      : "FIXING";
  const finalized: MangekyoLoopSession = {
    ...cloneSession(session),
    status: nextStatus,
    updatedAt: timestamp(dependencies),
    rounds: session.rounds.map((entry, index) => index === session.rounds.length - 1
      ? { ...structuredClone(entry), round: { ...structuredClone(entry.round), status: nextStatus } }
      : structuredClone(entry)),
    currentGate: undefined,
    ...(stopRequest === undefined ? {} : { stopRequest: structuredClone(stopRequest) }),
    ...(stop.pass ? { finalRender: afterRender } : {}),
    ...(stop.stop || stop.pass ? { stopReason: stop.reason } : {}),
  };
  if (["COMPLETE", "BLOCKED", "FAILED"].includes(nextStatus) && stopRequest === undefined) {
    const transition = await dependencies.commitTerminalTransition({
      expectedVersion: session.updatedAt,
      session: cloneSession(finalized),
    });
    if (transition.outcome === "COMMITTED") return cloneSession(transition.session);
    if (
      transition.stopRequest.sessionVersion !== session.updatedAt ||
      !validStopRequest(transition.stopRequest, session)
    ) {
      throw new Error("The terminal transition lost to stale or ambiguous Stop evidence");
    }
    const { finalRender: _finalRender, ...withoutFinalPass } = finalized;
    return persistAndReload(
      {
        ...withoutFinalPass,
        status: "BLOCKED",
        updatedAt: timestamp(dependencies),
        rounds: finalized.rounds.map((entry, index) => index === finalized.rounds.length - 1
          ? { ...structuredClone(entry), round: { ...structuredClone(entry.round), status: "BLOCKED" } }
          : structuredClone(entry)),
        stopRequest: structuredClone(transition.stopRequest),
        stopReason: "The user stopped the visual loop before completion.",
      },
      dependencies,
      "terminal Stop checkpoint",
    );
  }
  return persistAndReload(finalized, dependencies, "visual round checkpoint");
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
  if (["COMPLETE", "BLOCKED", "FAILED"].includes(working.status)) return working;
  const stopped = await stopCheckpoint(working, dependencies);
  if (stopped !== undefined) return stopped;
  if (working.status === "IDLE") {
    working = await persistAndReload(
      withStatus(working, "PREPARING", dependencies),
      dependencies,
      "preparation checkpoint",
    );
  }
  if (working.status === "DECIDING") {
    working = await finalizeDecidingRound(working, dependencies);
  }
  while (working.status === "PREPARING" || working.status === "FIXING") {
    const stoppedBetweenRounds = await stopCheckpoint(working, dependencies);
    if (stoppedBetweenRounds !== undefined) return stoppedBetweenRounds;
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
  const decisionClaim = {
    loopSessionId: session.id,
    sessionVersion: session.updatedAt,
    gateId: gate.id,
    decisionId: baseDecision.id,
    decision: baseDecision.decision,
    decidedAt: baseDecision.createdAt,
  };
  await dependencies.claimGateDecision(decisionClaim);
  const { stopReason: _pendingGateReason, ...sessionWithoutGateReason } = cloneSession(session);
  const decided: MangekyoLoopSession = {
    ...sessionWithoutGateReason,
    status: resolution.decision === "REJECT" ? "BLOCKED" : "EDITING",
    updatedAt: baseDecision.createdAt,
    policy: policyAfter ?? session.policy,
    gates: session.gates.some(({ id }) => id === gate.id)
      ? [...session.gates]
      : [...session.gates, gate],
    gateDecisions: [...session.gateDecisions, baseDecision],
    currentGate: undefined,
    ...(resolution.decision === "REJECT"
      ? { stopReason: "The pending policy-boundary change was rejected." }
      : {}),
  };

  let persistedDecision: MangekyoLoopSession;
  try {
    persistedDecision = await persistAndReload(
      decided,
      dependencies,
      resolution.decision === "REJECT"
        ? "rejected gate checkpoint"
        : "human gate decision checkpoint",
    );
  } catch (checkpointError) {
    try {
      if (dependencies.releaseGateDecisionClaim === undefined) {
        throw new Error("No exact gate-action release boundary is configured");
      }
      await dependencies.releaseGateDecisionClaim(decisionClaim);
    } catch (releaseError) {
      throw new AggregateError(
        [checkpointError, releaseError],
        "Gate decision checkpoint failed and its action claim could not be safely released",
      );
    }
    throw checkpointError;
  }

  if (resolution.decision === "REJECT") return persistedDecision;

  const pending: ProposedVisualChange = {
    proposal: gate.proposal,
    proposalThreadId: gate.proposalThreadId,
    change: gate.requestedChange,
    objective: gate.proposal.summary,
    affectedScope: gate.affectedScope,
    impact: gate.impact,
  };
  if (resolution.decision === "EXPAND_SCOPE") {
    return processPendingChange(persistedDecision, gate.roundNumber, pending, dependencies);
  }

  const policyEvaluation = persistedDecision.policyEvaluations.find(
    ({ id }) => id === gate.policyEvaluationId,
  );
  if (policyEvaluation === undefined || policyEvaluation.evaluation.decision !== "HUMAN_GATE") {
    throw new Error("Approve Once is missing its exact persisted gate evaluation");
  }
  const approveOnceDecision = baseDecision as MangekyoHumanGateDecision & {
    decision: "APPROVE_ONCE";
  };
  return executeRound(
    persistedDecision,
    gate.roundNumber,
    pending,
    policyEvaluation,
    { kind: "APPROVE_ONCE", decision: approveOnceDecision },
    dependencies,
  );
}
