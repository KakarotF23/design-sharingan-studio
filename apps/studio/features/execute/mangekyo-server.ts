import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  executeApproveOnceMutation,
  executePolicyAuthorizedMutation,
  generateChangeProposal,
} from "@design-sharingan/approval-engine";
import type {
  MangekyoLoopSession,
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
  consumeMangekyoApproveOnceAuthorization,
  detectProject,
  listReferences,
  listSessions,
  loadMangekyoAuthorization,
  loadMangekyoActiveLoopClaim,
  loadMangekyoLoopSession,
  loadMangekyoStopRequest,
  loadSafeExecutionState,
  releaseMangekyoActiveLoop,
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
}> {
  const [references, session] = await Promise.all([
    listReferences(project.rootPath, project.id),
    currentLoop(project),
  ]);
  return { references, ...(session === undefined ? {} : { session }) };
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
          JSON.stringify(persistedDecision) !== JSON.stringify(authorization.decision) ||
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
        });
        const completedAt = new Date().toISOString();
        const sourceRevision = await captureWorkspaceSourceRevision(input.workspace);
        return {
          proposalId: mutation.proposalId,
          threadId: mutation.threadId,
          filesChanged: [...mutation.filesChanged],
          completedAt,
          sourceRevision,
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
      const sourceRevision = await captureWorkspaceSourceRevision(input.workspace);
      return {
        proposalId: result.mutation.proposalId,
        threadId: result.mutation.threadId,
        filesChanged: [...result.mutation.filesChanged],
        completedAt,
        sourceRevision,
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
    async capture({ session, roundNumber }) {
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
  await claimMangekyoActiveLoop(project.rootPath, project.id, {
    loopSessionId: sessionId,
    sourceExecutionSessionId: safe.id,
    claimedAt: createdAt,
  });
  const initialRender = await captureBaseline(workspace, sessionId);
  const session: MangekyoLoopSession = {
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
  const analysisPath = await createAnalysisStagingDirectory(project.rootPath);
  try {
    await writeFile(
      join(analysisPath, "loop-context.json"),
      `${JSON.stringify({
        project: { name: project.name, routes: workspace.routes, components: workspace.componentDirectories },
        approvedDirection: session.approvedDirection,
        renderTarget: session.renderTarget,
        referenceIds: session.referenceIds,
      }, null, 2)}\n`,
      { mode: 0o600 },
    );
    const dependencies = await loopDependencies({ project, workspace, safe, references, analysisPath });
    const completed = await runMangekyoLoop(session, dependencies);
    await releaseTerminalClaim(project, completed);
    return { references: allReferences, session: completed };
  } finally {
    await rm(analysisPath, { force: true, recursive: true });
  }
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
  const analysisPath = await createAnalysisStagingDirectory(project.rootPath);
  try {
    const dependencies = await loopDependencies({ project, workspace, safe, references, analysisPath });
    const resolution: HumanGateResolution = decision === "EXPAND_SCOPE"
      ? {
          decision,
          decidedBy: "local-user",
          expandKind: session.currentGate.requestedChange.kind,
        }
      : { decision, decidedBy: "local-user" };
    const completed = await resolveHumanGate(session, resolution, dependencies);
    await releaseTerminalClaim(project, completed);
    return { references: allReferences, session: completed };
  } finally {
    await rm(analysisPath, { force: true, recursive: true });
  }
}

export async function stopMangekyoLoop(
  project: Project,
  sessionId: string,
): Promise<{ references: Reference[]; session: MangekyoLoopSession }> {
  const session = await loadMangekyoLoopSession(project.rootPath, project.id, sessionId);
  if (isTerminalStatus(session.status)) {
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
  await requestMangekyoStop(project.rootPath, project.id, {
    id: randomUUID(),
    loopSessionId: session.id,
    sessionVersion: session.updatedAt,
    requestedAt: new Date().toISOString(),
    requestedBy: "local-user",
  });
  if (session.status !== "HUMAN_GATE") {
    return { references: allReferences, session };
  }
  const workspace = await workspaceFor(project);
  const analysisPath = await createAnalysisStagingDirectory(project.rootPath);
  try {
    const dependencies = await loopDependencies({ project, workspace, safe, references, analysisPath });
    const stopped = await runMangekyoLoop(session, dependencies);
    await releaseTerminalClaim(project, stopped);
    return { references: allReferences, session: stopped };
  } finally {
    await rm(analysisPath, { force: true, recursive: true });
  }
}
