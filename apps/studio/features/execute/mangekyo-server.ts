import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  executeApproveOnceMutation,
  executePolicyAuthorizedMutation,
  generateChangeProposal,
} from "@design-sharingan/approval-engine";
import type {
  MangekyoLoopSession,
  MangekyoStopRequest,
  Project,
  Reference,
} from "@design-sharingan/core";
import { DEFAULT_AUTONOMY_POLICY } from "@design-sharingan/core";
import {
  classifyProposalChange,
  resolveHumanGate,
  runMangekyoLoop,
  type HumanGateResolution,
  type MangekyoLoopDependencies,
  type ProposedVisualChange,
} from "@design-sharingan/mangekyo-engine";
import {
  claimMangekyoActiveLoop,
  claimMangekyoGateDecision,
  claimMangekyoWorkerLease,
  commitMangekyoTerminalTransition,
  consumeMangekyoApproveOnceAuthorization,
  detectProject,
  listReferences,
  listSessions,
  loadMangekyoAuthorization,
  loadMangekyoActiveLoopClaim,
  loadMangekyoLoopSession,
  loadMangekyoStopRequest,
  loadMangekyoWorkerLease,
  loadSafeExecutionState,
  releaseMangekyoActiveLoop,
  releaseMangekyoGateDecisionClaim,
  releaseMangekyoWorkerLease,
  requestMangekyoStop,
  saveMangekyoAuthorization,
  saveMangekyoLoopSession,
  type ProjectWorkspace,
  type SafeExecutionEditingSession,
} from "@design-sharingan/project-adapters";
import {
  captureRender,
  captureWorkspaceSourceRevision,
  startDevServer,
  type DevServerHandle,
} from "@design-sharingan/render-engine";
import { analyzeRender } from "@design-sharingan/visual-engine";
import { createAnalysisStagingDirectory } from "../projects/project-locator";
import {
  createMangekyoMutationAgent,
  createMangekyoProposalAgent,
  createMangekyoVisualAgent,
} from "./mangekyo-agent";

const RENDER_TARGET = {
  route: "/",
  viewport: { name: "desktop", width: 1280, height: 720 },
} as const;
const START_STOP_WINDOW_MS = 1_000;
const WORKER_LEASE_MS = 60_000;

const mangekyoWorkers = new Map<string, Promise<void>>();

function truncateUtf8(value: string, maximumBytes: number): string {
  let result = "";
  let bytes = 0;
  for (const codePoint of value) {
    const size = Buffer.byteLength(codePoint, "utf8");
    if (bytes + size > maximumBytes) break;
    result += codePoint;
    bytes += size;
  }
  return result;
}

async function reservePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("Could not reserve a loopback render port"));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });
}

async function workspaceFor(project: Project): Promise<ProjectWorkspace> {
  const detected = await detectProject(project.rootPath);
  return {
    ...project,
    framework: detected.framework,
    packageManager: detected.packageManager,
    devCommand: detected.devCommand,
    renderTarget: detected.renderTarget,
    scripts: detected.scripts,
    routes: [...detected.routes],
    componentDirectories: [...detected.componentDirectories],
    designDocuments: [...detected.designDocuments],
    hasGit: detected.hasGit,
    capabilities: detected.capabilities,
  };
}

async function currentLoop(project: Project): Promise<MangekyoLoopSession | undefined> {
  const records = (await listSessions(project.rootPath, project.id)).filter(
    ({ type }) => type === "MANGEKYO_LOOP",
  );
  const sessions = await Promise.all(records.map(({ id }) =>
    loadMangekyoLoopSession(project.rootPath, project.id, id),
  ));
  const active = sessions.filter(({ status }) => !isTerminalStatus(status));
  if (active.length > 1) throw new Error("Mangekyo active-loop evidence is ambiguous");
  const claim = await loadMangekyoActiveLoopClaim(project.rootPath, project.id);
  if (
    (active.length === 0 && claim !== undefined) ||
    (active[0] !== undefined && (
      claim === undefined ||
      claim.loopSessionId !== active[0].id ||
      claim.sourceExecutionSessionId !== active[0].sourceExecutionSessionId ||
      claim.claimedAt !== active[0].createdAt
    ))
  ) {
    throw new Error("Mangekyo active-loop claim is missing, stale, or ambiguous");
  }
  return active[0] ?? sessions.sort(
    (left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt),
  )[0];
}

async function requireActiveClaim(
  project: Project,
  session: MangekyoLoopSession,
): Promise<void> {
  const claim = await loadMangekyoActiveLoopClaim(project.rootPath, project.id);
  if (
    claim === undefined ||
    claim.loopSessionId !== session.id ||
    claim.sourceExecutionSessionId !== session.sourceExecutionSessionId ||
    claim.claimedAt !== session.createdAt
  ) {
    throw new Error("The exact active Mangekyo loop claim is missing or stale");
  }
}

function isTerminalStatus(
  status: MangekyoLoopSession["status"],
): status is "COMPLETE" | "BLOCKED" | "FAILED" {
  return status === "COMPLETE" || status === "BLOCKED" || status === "FAILED";
}

async function releaseTerminalClaim(
  project: Project,
  session: MangekyoLoopSession,
): Promise<void> {
  if (!isTerminalStatus(session.status)) return;
  await releaseMangekyoActiveLoop(project.rootPath, project.id, {
    loopSessionId: session.id,
    sourceExecutionSessionId: session.sourceExecutionSessionId,
    claimedAt: session.createdAt,
    terminalStatus: session.status,
  });
}

export async function loadMangekyoContext(project: Project): Promise<{
  references: Reference[];
  session?: MangekyoLoopSession;
  stopRequest?: MangekyoStopRequest;
}> {
  const [references, session] = await Promise.all([
    listReferences(project.rootPath, project.id),
    currentLoop(project),
  ]);
  const stopRequest = session === undefined || isTerminalStatus(session.status)
    ? session?.stopRequest
    : await loadMangekyoStopRequest(project.rootPath, project.id, session.id);
  if (
    session !== undefined &&
    !isTerminalStatus(session.status) &&
    session.status !== "HUMAN_GATE"
  ) {
    await recoverMangekyoLoop(project, references, session);
  }
  return {
    references,
    ...(session === undefined ? {} : { session }),
    ...(stopRequest === undefined ? {} : { stopRequest }),
  };
}

async function captureBaseline(
  workspace: ProjectWorkspace,
  sessionId: string,
): Promise<Awaited<ReturnType<typeof captureRender>>["artifact"]> {
  const port = await reservePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  let server: DevServerHandle | undefined;
  try {
    server = await startDevServer({
      workspace,
      baseUrl,
      env: { RENDER_FIXTURE_PORT: String(port), PORT: String(port) },
      timeoutMs: 30_000,
    });
    return (await captureRender({
      workspace,
      baseUrl,
      route: RENDER_TARGET.route,
      viewport: RENDER_TARGET.viewport,
      sessionId,
      roundId: "initial",
    })).artifact;
  } finally {
    await server?.stop().catch(() => undefined);
  }
}

function approvedDirection(safe: SafeExecutionEditingSession): string {
  return truncateUtf8([
    safe.designApproach.title,
    safe.designApproach.summary,
    safe.featureBrief.goal,
    ...safe.featureBrief.mustKeep.map((entry) => `Keep: ${entry}`),
    ...safe.featureBrief.mustNotChange.map((entry) => `Do not change: ${entry}`),
  ].join("\n"), 4_000);
}

async function loopDependencies(input: {
  project: Project;
  workspace: ProjectWorkspace;
  safe: SafeExecutionEditingSession;
  references: Reference[];
  analysisPath: string;
}): Promise<MangekyoLoopDependencies> {
  let devServer: DevServerHandle | undefined;
  let baseUrl: string | undefined;
  return {
    createId: randomUUID,
    now: () => new Date(),
    claimGateDecision: (claim) => claimMangekyoGateDecision(
      input.project.rootPath,
      input.project.id,
      claim,
    ),
    releaseGateDecisionClaim: (claim) => releaseMangekyoGateDecisionClaim(
      input.project.rootPath,
      input.project.id,
      claim,
    ),
    loadStopRequest: (session) => loadMangekyoStopRequest(
      input.project.rootPath,
      input.project.id,
      session.id,
    ),
    async proposeChange(session, roundNumber): Promise<ProposedVisualChange> {
      const latestFindings = session.rounds.at(-1)?.round.findingsAfter ?? [];
      const findingEvidence = latestFindings.slice(0, 8).map((finding) => ({
        severity: finding.severity,
        category: finding.category,
        screen: finding.screen,
        description: finding.description,
        recommendedAction: finding.recommendedAction,
      }));
      const requestedObjective = truncateUtf8([
        "Propose exactly one smallest coherent visual objective for the latest authenticated render findings.",
        "Preserve navigation, UX, accessibility, and product rules unless escalation is explicitly required.",
        findingEvidence.length === 0
          ? "This is the first round; use the approved direction and baseline render evidence."
          : `Latest rendered findings: ${JSON.stringify(findingEvidence)}`,
      ].join(" "), 2_000);
      const proposal = await generateChangeProposal(
        {
          sessionId: session.id,
          designApproach: input.safe.designApproach,
          featureBrief: input.safe.featureBrief,
          analysisWorkingDirectory: input.analysisPath,
          projectContext: {
            name: input.project.name,
            framework: input.workspace.framework,
            routes: input.workspace.routes,
            componentDirectories: input.workspace.componentDirectories,
          },
          revisionRequest: requestedObjective,
        },
        { agent: createMangekyoProposalAgent(roundNumber), createId: randomUUID },
      );
      return {
        proposal: proposal.proposal,
        proposalThreadId: proposal.threadId,
        change: classifyProposalChange(proposal.proposal),
        objective: proposal.proposal.summary,
        affectedScope: [
          ...proposal.proposal.screensAffected,
          ...proposal.proposal.componentsAffected,
        ].slice(0, 64),
        impact: proposal.proposal.visualImpact,
      };
    },
    persist: (session) => saveMangekyoLoopSession(input.project.rootPath, session),
    load: (sessionId) => loadMangekyoLoopSession(
      input.project.rootPath,
      input.project.id,
      sessionId,
    ).catch(() => undefined),
    commitTerminalTransition: ({ expectedVersion, session }) =>
      commitMangekyoTerminalTransition(input.project.rootPath, input.project.id, {
        expectedVersion,
        session,
      }),
    async executeChange({ session, proposal, proposalThreadId, change, authorization }) {
      if (authorization.kind === "APPROVE_ONCE") {
        const persistedDecision = session.gateDecisions.find(
          ({ id }) => id === authorization.decision.id,
        );
        const gate = session.gates.find(({ id }) => id === authorization.decision.gateId);
        const policyEvaluation = session.policyEvaluations.find(
          ({ id }) => id === gate?.policyEvaluationId,
        );
        if (
          persistedDecision === undefined ||
          !isDeepStrictEqual(persistedDecision, authorization.decision) ||
          gate === undefined ||
          policyEvaluation === undefined
        ) {
          throw new Error("Persisted Approve Once evidence is missing, stale, or ambiguous");
        }
        const mutation = await executeApproveOnceMutation({
          workspaceRoot: input.project.rootPath,
          loopSessionId: session.id,
          sessionVersion: session.updatedAt,
          proposal,
          proposalThreadId,
          change,
          gate,
          policyEvaluation,
          decision: authorization.decision,
          now: new Date(),
          consumeAuthorization: (claim) => consumeMangekyoApproveOnceAuthorization(
            input.project.rootPath,
            input.project.id,
            claim,
          ),
          agent: createMangekyoMutationAgent(),
          captureSourceRevision: ({ requiredPaths }) =>
            captureWorkspaceSourceRevision(input.workspace, requiredPaths),
        });
        const completedAt = new Date().toISOString();
        if (mutation.sourceRevision === undefined) {
          throw new Error("The mutation transaction did not establish exact source evidence");
        }
        return {
          proposalId: mutation.proposalId,
          threadId: mutation.threadId,
          filesChanged: [...mutation.filesChanged],
          completedAt,
          sourceRevision: mutation.sourceRevision,
        };
      }
      const result = await executePolicyAuthorizedMutation(
        {
          workspaceRoot: input.project.rootPath,
          loopSessionId: session.id,
          proposal,
          proposalThreadId,
          policy: session.policy,
          change,
          agent: createMangekyoMutationAgent(),
          captureSourceRevision: ({ requiredPaths }) =>
            captureWorkspaceSourceRevision(input.workspace, requiredPaths),
        },
        {
          createId: randomUUID,
          now: () => new Date(),
          persistAuthorization: (evidence) => saveMangekyoAuthorization(
            input.project.rootPath,
            input.project.id,
            evidence,
          ),
          loadAuthorization: (id) => loadMangekyoAuthorization(
            input.project.rootPath,
            input.project.id,
            id,
          ),
        },
      );
      if (result.decision !== "APPLIED") {
        throw new Error("Persisted loop policy no longer authorizes the pending mutation");
      }
      const completedAt = new Date().toISOString();
      if (result.mutation.sourceRevision === undefined) {
        throw new Error("The mutation transaction did not establish exact source evidence");
      }
      return {
        proposalId: result.mutation.proposalId,
        threadId: result.mutation.threadId,
        filesChanged: [...result.mutation.filesChanged],
        completedAt,
        sourceRevision: result.mutation.sourceRevision,
      };
    },
    async runProject() {
      if (devServer !== undefined) throw new Error("A loop-owned render process is already active");
      const port = await reservePort();
      baseUrl = `http://127.0.0.1:${port}`;
      devServer = await startDevServer({
        workspace: input.workspace,
        baseUrl,
        env: { RENDER_FIXTURE_PORT: String(port), PORT: String(port) },
        timeoutMs: 30_000,
      });
    },
    async capture({ session, roundNumber, mutation }) {
      if (devServer === undefined || baseUrl === undefined) {
        throw new Error("The loop-owned project process is not ready for capture");
      }
      return (await captureRender({
        workspace: input.workspace,
        baseUrl,
        route: session.renderTarget.route,
        viewport: session.renderTarget.viewport,
        sessionId: session.id,
        roundId: `round-${roundNumber}`,
        requiredSourcePaths: mutation.filesChanged,
      })).artifact;
    },
    async analyze({ session, render }) {
      const visual = await analyzeRender(
        {
          projectId: input.project.id,
          projectRoot: input.project.rootPath,
          analysisWorkingDirectory: input.analysisPath,
          screen: session.renderTarget.route,
          referenceImages: input.references.map((reference) => ({
            referenceId: reference.id,
            imagePath: reference.imagePath as string,
          })),
          currentRender: render,
          productContext: {
            name: input.project.name,
            approvedDirection: session.approvedDirection,
            uxInvariants: [
              ...input.safe.featureBrief.mustKeep,
              ...input.safe.featureBrief.mustNotChange,
            ],
            designSystem: [
              "Preserve the established product hierarchy and component language.",
              "Accessibility and UX integrity outrank cosmetic reference similarity.",
            ],
          },
        },
        { agent: createMangekyoVisualAgent(), createId: randomUUID },
      );
      return {
        threadId: visual.threadId,
        findings: visual.findings,
        verification: visual.verification,
        ...(visual.genomeEvidenceVersion === undefined
          ? {}
          : { genomeEvidenceVersion: visual.genomeEvidenceVersion }),
      };
    },
    async stopProject() {
      const active = devServer;
      devServer = undefined;
      baseUrl = undefined;
      await active?.stop();
    },
  };
}

async function runPersistedMangekyoLoop(input: {
  project: Project;
  workspace: ProjectWorkspace;
  safe: SafeExecutionEditingSession;
  references: Reference[];
  session: MangekyoLoopSession;
}): Promise<boolean> {
  let analysisPath: string | undefined;
  try {
    const durableSession = await loadMangekyoLoopSession(
      input.project.rootPath,
      input.project.id,
      input.session.id,
    );
    analysisPath = await createAnalysisStagingDirectory(input.project.rootPath);
    await writeFile(
      join(analysisPath, "loop-context.json"),
      `${JSON.stringify({
        project: {
          name: input.project.name,
          routes: input.workspace.routes,
          components: input.workspace.componentDirectories,
        },
        approvedDirection: durableSession.approvedDirection,
        renderTarget: durableSession.renderTarget,
        referenceIds: durableSession.referenceIds,
      }, null, 2)}\n`,
      { mode: 0o600 },
    );
    const dependencies = await loopDependencies({
      project: input.project,
      workspace: input.workspace,
      safe: input.safe,
      references: input.references,
      analysisPath,
    });
    const completed = await runMangekyoLoop(durableSession, dependencies);
    await releaseTerminalClaim(input.project, completed);
    return completed.status === "HUMAN_GATE" || isTerminalStatus(completed.status);
  } catch (error) {
    try {
      const persisted = await loadMangekyoLoopSession(
        input.project.rootPath,
        input.project.id,
        input.session.id,
      );
      if (!isTerminalStatus(persisted.status)) {
        const failed: MangekyoLoopSession = {
          ...persisted,
          status: "FAILED",
          updatedAt: new Date().toISOString(),
          stopReason: truncateUtf8(
            `Loop orchestration failed: ${error instanceof Error ? error.message : "unknown failure"}`,
            1_000,
          ),
        };
        await saveMangekyoLoopSession(input.project.rootPath, failed);
        await releaseTerminalClaim(input.project, failed);
        return true;
      }
      return true;
    } catch {
      // Retain the durable claim when persistence or reconciliation is ambiguous.
      return false;
    }
  } finally {
    if (analysisPath !== undefined) {
      await rm(analysisPath, { force: true, recursive: true }).catch(() => undefined);
    }
  }
}

async function scheduleMangekyoLoop(
  input: Parameters<typeof runPersistedMangekyoLoop>[0],
): Promise<void> {
  const key = `${input.project.id}:${input.session.id}`;
  if (mangekyoWorkers.has(key)) return;
  const acquiredAt = new Date().toISOString();
  const lease = {
    loopSessionId: input.session.id,
    sessionVersion: input.session.updatedAt,
    workerId: randomUUID(),
    acquiredAt,
    expiresAt: new Date(Date.parse(acquiredAt) + WORKER_LEASE_MS).toISOString(),
  };
  const leaseReady = claimMangekyoWorkerLease(
    input.project.rootPath,
    input.project.id,
    lease,
    acquiredAt,
  );
  let worker: Promise<void>;
  worker = leaseReady.then(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, START_STOP_WINDOW_MS));
    const safelyStopped = await runPersistedMangekyoLoop(input);
    if (safelyStopped) {
      await releaseMangekyoWorkerLease(input.project.rootPath, input.project.id, lease);
    }
  }).catch(() => undefined).finally(() => {
    if (mangekyoWorkers.get(key) === worker) mangekyoWorkers.delete(key);
  });
  mangekyoWorkers.set(key, worker);
  await leaseReady;
}

async function recoverMangekyoLoop(
  project: Project,
  allReferences: Reference[],
  session: MangekyoLoopSession,
): Promise<void> {
  const key = `${project.id}:${session.id}`;
  if (mangekyoWorkers.has(key)) return;
  await requireActiveClaim(project, session);
  const safe = await loadSafeExecutionState(project.rootPath, project.id);
  if (safe.id !== session.sourceExecutionSessionId || safe.status !== "EDITING") {
    throw new Error("Mangekyo recovery source execution evidence is stale");
  }
  const references = allReferences.filter(({ id }) => session.referenceIds.includes(id));
  if (
    references.length !== session.referenceIds.length ||
    references.some(({ imagePath }) => typeof imagePath !== "string")
  ) {
    throw new Error("Mangekyo recovery reference evidence is missing or stale");
  }
  const workspace = await workspaceFor(project);
  const liveLease = await loadMangekyoWorkerLease(project.rootPath, project.id);
  if (liveLease !== undefined && Date.parse(liveLease.expiresAt) > Date.now()) {
    throw new Error("A live durable Mangekyo worker lease is not owned by this server process");
  }
  await scheduleMangekyoLoop({ project, workspace, safe, references, session });
}

export async function startMangekyoLoop(
  project: Project,
  safeSessionId: string,
): Promise<{ references: Reference[]; session: MangekyoLoopSession }> {
  const existing = await currentLoop(project);
  if (existing !== undefined && !isTerminalStatus(existing.status)) {
    throw new Error("Another durable Mangekyo loop already owns this project");
  }
  const safe = await loadSafeExecutionState(project.rootPath, project.id);
  if (safe.id !== safeSessionId || safe.status !== "EDITING") {
    throw new Error("Mangekyo requires the exact approved Safe Execution source");
  }
  const allReferences = await listReferences(project.rootPath, project.id);
  const references = allReferences.slice(0, 8);
  if (
    references.length === 0 ||
    references.some(({ imagePath }) => typeof imagePath !== "string")
  ) {
    throw new Error("Mangekyo requires authenticated project reference images");
  }
  const workspace = await workspaceFor(project);
  if (!workspace.capabilities.canRun || !workspace.capabilities.canRender) {
    throw new Error("Mangekyo requires a runnable, renderable web project");
  }
  const sessionId = randomUUID();
  const createdAt = new Date().toISOString();
  const reservation = {
    loopSessionId: sessionId,
    sourceExecutionSessionId: safe.id,
    claimedAt: createdAt,
  };
  await claimMangekyoActiveLoop(project.rootPath, project.id, reservation);
  let session: MangekyoLoopSession;
  try {
    const initialRender = await captureBaseline(workspace, sessionId);
    session = {
      id: sessionId,
      projectId: project.id,
      type: "MANGEKYO_LOOP",
      status: "IDLE",
      createdAt,
      updatedAt: initialRender.capturedAt,
      sourceExecutionSessionId: safe.id,
      sourceDesignSessionId: safe.sourceSessionId,
      approvedApproachId: safe.approvedApproachId,
      directionApprovalId: safe.approvalId,
      approvedDirection: approvedDirection(safe),
      initialPolicy: { ...DEFAULT_AUTONOMY_POLICY, protectedPaths: [...DEFAULT_AUTONOMY_POLICY.protectedPaths] },
      policy: { ...DEFAULT_AUTONOMY_POLICY, protectedPaths: [...DEFAULT_AUTONOMY_POLICY.protectedPaths] },
      renderTarget: RENDER_TARGET,
      referenceIds: references.map(({ id }) => id),
      maxRounds: 5,
      importantThreshold: 2,
      claimedScreens: [RENDER_TARGET.route],
      inspectedScreens: [],
      rounds: [],
      policyEvaluations: [],
      gates: [],
      gateDecisions: [],
      initialRender,
    };
    await saveMangekyoLoopSession(project.rootPath, session);
  } catch (error) {
    try {
      await releaseMangekyoActiveLoop(project.rootPath, project.id, {
        ...reservation,
        reservationStatus: "UNPERSISTED",
      });
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Mangekyo start reservation could not be safely reconciled",
      );
    }
    throw error;
  }
  await scheduleMangekyoLoop({ project, workspace, safe, references, session });
  return { references: allReferences, session };
}

export async function decideMangekyoGate(
  project: Project,
  sessionId: string,
  decision: HumanGateResolution["decision"],
): Promise<{ references: Reference[]; session: MangekyoLoopSession }> {
  const session = await loadMangekyoLoopSession(project.rootPath, project.id, sessionId);
  if (session.status !== "HUMAN_GATE" || session.currentGate === undefined) {
    throw new Error("Mangekyo is not waiting at a Human Gate");
  }
  await requireActiveClaim(project, session);
  const safe = await loadSafeExecutionState(project.rootPath, project.id);
  if (safe.id !== session.sourceExecutionSessionId || safe.status !== "EDITING") {
    throw new Error("Mangekyo source execution evidence is stale");
  }
  const allReferences = await listReferences(project.rootPath, project.id);
  const references = allReferences.filter(({ id }) => session.referenceIds.includes(id));
  if (references.length !== session.referenceIds.length || references.some(({ imagePath }) => typeof imagePath !== "string")) {
    throw new Error("Mangekyo reference evidence is missing or stale");
  }
  const workspace = await workspaceFor(project);
  const key = `${project.id}:${session.id}`;
  if (mangekyoWorkers.has(key)) {
    throw new Error("Mangekyo loop work is already active for this session");
  }
  const acquiredAt = new Date().toISOString();
  const lease = {
    loopSessionId: session.id,
    sessionVersion: session.updatedAt,
    workerId: randomUUID(),
    acquiredAt,
    expiresAt: new Date(Date.parse(acquiredAt) + WORKER_LEASE_MS).toISOString(),
  };
  const analysisPath = await createAnalysisStagingDirectory(project.rootPath);
  let finishOwner: () => void = () => undefined;
  const owner = new Promise<void>((resolve) => {
    finishOwner = resolve;
  });
  mangekyoWorkers.set(key, owner);
  let leaseClaimed = false;
  let completed: MangekyoLoopSession | undefined;
  try {
    await claimMangekyoWorkerLease(
      project.rootPath,
      project.id,
      lease,
      acquiredAt,
    );
    leaseClaimed = true;
    const dependencies = await loopDependencies({ project, workspace, safe, references, analysisPath });
    const resolution: HumanGateResolution = decision === "EXPAND_SCOPE"
      ? {
          decision,
          decidedBy: "local-user",
          expandKind: session.currentGate.requestedChange.kind,
        }
      : { decision, decidedBy: "local-user" };
    completed = await resolveHumanGate(session, resolution, dependencies);
    await releaseTerminalClaim(project, completed);
  } finally {
    const cleanupErrors: unknown[] = [];
    await rm(analysisPath, { force: true, recursive: true }).catch((error: unknown) => {
      cleanupErrors.push(error);
    });
    if (leaseClaimed && completed !== undefined) {
      await releaseMangekyoWorkerLease(project.rootPath, project.id, lease).catch(
        (error: unknown) => cleanupErrors.push(error),
      );
    }
    finishOwner();
    if (mangekyoWorkers.get(key) === owner) mangekyoWorkers.delete(key);
    if (cleanupErrors.length === 1) throw cleanupErrors[0];
    if (cleanupErrors.length > 1) {
      throw new AggregateError(cleanupErrors, "Mangekyo worker cleanup is ambiguous");
    }
  }
  if (completed === undefined) throw new Error("Mangekyo gate resolution did not persist a result");
  if (!isTerminalStatus(completed.status) && completed.status !== "HUMAN_GATE") {
    await scheduleMangekyoLoop({ project, workspace, safe, references, session: completed });
  }
  return { references: allReferences, session: completed };
}

export async function stopMangekyoLoop(
  project: Project,
  sessionId: string,
): Promise<{
  references: Reference[];
  session: MangekyoLoopSession;
  stopRequest: MangekyoStopRequest;
}> {
  const session = await loadMangekyoLoopSession(project.rootPath, project.id, sessionId);
  if (isTerminalStatus(session.status)) {
    if (session.status === "BLOCKED" && session.stopRequest !== undefined) {
      return {
        references: await listReferences(project.rootPath, project.id),
        session,
        stopRequest: session.stopRequest,
      };
    }
    throw new Error("Mangekyo loop is already terminal");
  }
  await requireActiveClaim(project, session);
  const safe = await loadSafeExecutionState(project.rootPath, project.id);
  if (safe.id !== session.sourceExecutionSessionId || safe.status !== "EDITING") {
    throw new Error("Mangekyo source execution evidence is stale");
  }
  const allReferences = await listReferences(project.rootPath, project.id);
  const references = allReferences.filter(({ id }) => session.referenceIds.includes(id));
  if (
    references.length !== session.referenceIds.length ||
    references.some(({ imagePath }) => typeof imagePath !== "string")
  ) {
    throw new Error("Mangekyo reference evidence is missing or stale");
  }
  const stopRequest = await requestMangekyoStop(project.rootPath, project.id, {
    id: randomUUID(),
    loopSessionId: session.id,
    sessionVersion: session.updatedAt,
    requestedAt: new Date().toISOString(),
    requestedBy: "local-user",
  });
  const workspace = await workspaceFor(project);
  await scheduleMangekyoLoop({ project, workspace, safe, references, session });
  return { references: allReferences, session, stopRequest };
}
