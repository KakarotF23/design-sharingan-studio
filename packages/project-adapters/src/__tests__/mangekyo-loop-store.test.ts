import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { MangekyoLoopSession, Project, RenderArtifact } from "@design-sharingan/core";
import { DEFAULT_AUTONOMY_POLICY } from "@design-sharingan/core";
import { afterEach, describe, expect, it } from "vitest";

import {
  claimMangekyoGateDecision,
  claimMangekyoActiveLoop,
  claimMangekyoWorkerLease,
  commitMangekyoTerminalTransition,
  consumeMangekyoApproveOnceAuthorization,
  isMangekyoLoopSession,
  loadMangekyoActiveLoopClaim,
  loadMangekyoStopRequest,
  loadMangekyoWorkerLease,
  loadMangekyoAuthorization,
  loadMangekyoLoopSession,
  loadMangekyoRenderImage,
  saveMangekyoAuthorization,
  saveMangekyoLoopSession as persistMangekyoLoopSession,
  requestMangekyoStop,
  releaseMangekyoActiveLoop,
  releaseMangekyoGateDecisionClaim,
  releaseMangekyoWorkerLease,
} from "../mangekyo-loop-store";
import { createMangekyoWorkerLeaseOwner } from "../mangekyo-worker-owner";
import {
  ensureDesignWorkspace,
  saveProjectMetadata,
  saveRenderArtifact,
} from "../workspace-store";

const roots: string[] = [];

function pngBytes(width = 1280, height = 720): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10], 0);
  bytes.set([0, 0, 0, 13, 73, 72, 68, 82], 8);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

async function projectFixture(): Promise<Project> {
  const rootPath = await realpath(await mkdtemp(join(tmpdir(), "mangekyo-store-test-")));
  roots.push(rootPath);
  const project: Project = {
    id: "project-1",
    name: "Fixture",
    sourceType: "LOCAL",
    rootPath,
    framework: "nextjs",
    packageManager: "npm",
    devCommand: "npm start",
    status: "READY",
    createdAt: "2026-08-27T00:00:00.000Z",
    updatedAt: "2026-08-27T00:00:00.000Z",
  };
  await ensureDesignWorkspace(rootPath);
  await saveProjectMetadata(project);
  return project;
}

function renderArtifact(imagePath: string): RenderArtifact {
  return {
    id: "render-1",
    sessionId: "mangekyo-1",
    roundId: "round-1",
    route: "/",
    viewport: "desktop",
    viewportWidth: 1280,
    viewportHeight: 720,
    imagePath,
    capturedAt: "2026-08-27T01:00:01.000Z",
    sourceRevision: {
      kind: "GIT",
      available: true,
      head: "a".repeat(40),
      branch: "fixture",
      status: "DIRTY",
      entries: [{ index: " ", workingTree: "M", path: "server.mjs" }],
      truncated: false,
      worktreeFingerprint: "b".repeat(64),
      fileCount: 2,
      requiredPathEvidence: [],
    },
  };
}

function renderMetadataPath(imagePath: string): string {
  return join(dirname(imagePath), `${imagePath.split("/").at(-1)?.replace(/\.png$/, "")}.json`);
}

function renderIntegrityPath(imagePath: string): string {
  return join(dirname(imagePath), `${imagePath.split("/").at(-1)?.replace(/\.png$/, "")}.integrity.json`);
}

function hasFixturePng(bytes: Uint8Array, artifact: RenderArtifact): boolean {
  return bytes.byteLength >= 24 &&
    [137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value) &&
    bytes[12] === 73 && bytes[13] === 72 && bytes[14] === 68 && bytes[15] === 82 &&
    new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(16) === artifact.viewportWidth &&
    new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(20) === artifact.viewportHeight;
}

/** Set up producer-owned render sidecars for a fixture before the strict
 * adapter boundary authenticates the loop session. */
async function prepareFixtureRenders(
  rootPath: string,
  session: MangekyoLoopSession,
): Promise<void> {
  const artifacts = [
    session.initialRender,
    session.finalRender,
    ...session.rounds.flatMap(({ round }) => [round.beforeRender, round.afterRender]),
  ].filter((artifact): artifact is RenderArtifact => artifact !== undefined);
  const seen = new Set<string>();
  for (const artifact of artifacts) {
    const sourcePath = artifact.imagePath;
    const imagePath = join(
      rootPath,
      ".design-sharingan",
      "renders",
      artifact.sessionId,
      artifact.roundId,
      `${artifact.viewport}.png`,
    );
    artifact.imagePath = imagePath;
    if (seen.has(imagePath)) continue;
    seen.add(imagePath);
    await mkdir(dirname(imagePath), { recursive: true });
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await readFile(sourcePath));
    } catch {
      bytes = pngBytes(artifact.viewportWidth, artifact.viewportHeight);
    }
    if (!hasFixturePng(bytes, artifact)) {
      bytes = pngBytes(artifact.viewportWidth, artifact.viewportHeight);
    }
    await writeFile(imagePath, bytes);
    const metadata = { ...artifact, imagePath };
    const integrity = {
      artifactId: artifact.id,
      sessionId: artifact.sessionId,
      roundId: artifact.roundId,
      route: artifact.route,
      state: "default",
      viewport: artifact.viewport,
      viewportWidth: artifact.viewportWidth,
      viewportHeight: artifact.viewportHeight,
      imagePath,
      capturedAt: artifact.capturedAt,
      sourceRevisionFingerprint: artifact.sourceRevision.available === true
        ? artifact.sourceRevision.worktreeFingerprint
        : null,
      contentHash: createHash("sha256").update(bytes).digest("hex"),
      byteLength: bytes.byteLength,
    };
    await writeFile(renderMetadataPath(imagePath), `${JSON.stringify(metadata, null, 2)}\n`);
    await writeFile(renderIntegrityPath(imagePath), `${JSON.stringify(integrity, null, 2)}\n`);
  }
}

async function saveMangekyoLoopSession(
  rootPath: string,
  session: MangekyoLoopSession,
): Promise<void> {
  await prepareFixtureRenders(rootPath, session);
  await persistMangekyoLoopSession(rootPath, session);
}

function sessionFixture(rootPath: string): MangekyoLoopSession {
  const session: MangekyoLoopSession = {
    id: "mangekyo-1",
    projectId: "project-1",
    type: "MANGEKYO_LOOP",
    status: "HUMAN_GATE",
    createdAt: "2026-08-27T01:00:00.000Z",
    updatedAt: "2026-08-27T01:00:02.000Z",
    sourceExecutionSessionId: "safe-session-1",
    sourceDesignSessionId: "evolve-session-1",
    approvedApproachId: "approach-1",
    directionApprovalId: "approval-1",
    approvedDirection: "Preserve navigation and strengthen evidence hierarchy.",
    policy: DEFAULT_AUTONOMY_POLICY,
    initialPolicy: DEFAULT_AUTONOMY_POLICY,
    renderTarget: {
      route: "/",
      viewport: { name: "desktop", width: 1280, height: 720 },
    },
    referenceIds: ["reference-1"],
    maxRounds: 5,
    importantThreshold: 2,
    claimedScreens: ["/"],
    inspectedScreens: [],
    rounds: [],
    policyEvaluations: [
      {
        id: "policy-evaluation-1",
        roundNumber: 1,
        proposalId: "proposal-navigation",
        change: { kind: "NAVIGATION_CHANGE", files: ["server.mjs"] },
        policy: DEFAULT_AUTONOMY_POLICY,
        evaluation: {
          decision: "HUMAN_GATE",
          reasons: ["NAVIGATION_CHANGE exceeds the approved autonomy policy."],
        },
        evaluatedAt: "2026-08-27T01:00:02.000Z",
      },
    ],
    gates: [],
    gateDecisions: [],
    currentGate: {
      id: "gate-1",
      roundNumber: 1,
      requestedChange: { kind: "NAVIGATION_CHANGE", files: ["server.mjs"] },
      proposal: {
        id: "proposal-navigation",
        sessionId: "mangekyo-1",
        summary: "Change the primary navigation.",
        reason: "The reference uses another navigation structure.",
        filesToCreate: [],
        filesToModify: ["server.mjs"],
        filesToDelete: [],
        componentsAffected: ["Navigation"],
        screensAffected: ["/"],
        uxImpact: [
          {
            area: "Navigation",
            severity: "CRITICAL",
            reason: "Navigation behavior would change.",
            affectedRoutes: ["/"],
            affectedComponents: ["Navigation"],
            decisionRequired: true,
          },
        ],
        visualImpact: "Replaces the current navigation pattern.",
        riskLevel: "HIGH",
        requiresHumanApproval: true,
        policyViolations: ["NAVIGATION_CHANGE"],
        status: "PROPOSED",
      },
      proposalThreadId: "thread-navigation",
      policyEvaluationId: "policy-evaluation-1",
      requestedAt: "2026-08-27T01:00:02.000Z",
      reasons: ["Navigation changes are disabled by the current loop policy."],
      affectedScope: ["/", "Navigation"],
      impact: "Changes how users move through the product.",
    },
    initialRender: renderArtifact(
      join(rootPath, ".design-sharingan", "renders", "mangekyo-1", "initial.png"),
    ),
  };
  session.gates = [structuredClone(session.currentGate as NonNullable<typeof session.currentGate>)];
  return session;
}

function interruptedSessionFixture(
  rootPath: string,
  status: "EDITING" | "RUNNING" | "CAPTURING" | "COMPARING",
): MangekyoLoopSession {
  const session = sessionFixture(rootPath);
  session.status = status;
  session.updatedAt = "2026-08-27T01:00:03.000Z";
  session.currentGate = undefined;
  session.gates = [];
  session.gateDecisions = [];
  session.policyEvaluations = [{
    id: "policy-interrupted-1",
    roundNumber: 1,
    proposalId: "proposal-interrupted-1",
    proposalThreadId: "thread-interrupted-1",
    proposalDelta: {
      filesToCreate: [],
      filesToModify: ["server.mjs"],
      filesToDelete: [],
    },
    change: { kind: "STYLE_CHANGE", files: ["server.mjs"] },
    policy: DEFAULT_AUTONOMY_POLICY,
    evaluation: { decision: "ALLOW", reasons: [] },
    evaluatedAt: "2026-08-27T01:00:02.000Z",
  }];
  const pendingProposal = structuredClone(
    sessionFixture(rootPath).currentGate?.proposal as NonNullable<
      MangekyoLoopSession["currentGate"]
    >["proposal"],
  );
  pendingProposal.id = "proposal-interrupted-1";
  pendingProposal.summary = "Recover the exact pending style proposal.";
  pendingProposal.reason = "The interrupted worker may have changed the approved style path.";
  pendingProposal.filesToCreate = [];
  pendingProposal.filesToModify = ["server.mjs"];
  pendingProposal.filesToDelete = [];
  pendingProposal.policyViolations = [];
  pendingProposal.riskLevel = "LOW";
  session.pendingChange = {
    roundNumber: 1,
    proposal: pendingProposal,
    proposalThreadId: "thread-interrupted-1",
    policyEvaluationId: "policy-interrupted-1",
    recordedAt: "2026-08-27T01:00:02.000Z",
  };
  delete session.stopReason;
  return session;
}

// Fix-round probe: a retained render must be authenticated by its exact PNG
// bytes, not merely by a project-scoped path.
it("rejects a render whose PNG bytes were replaced after persistence", async () => {
  const project = await projectFixture();
  const session = sessionFixture(project.rootPath);
  const artifact = {
    ...(session.initialRender as RenderArtifact),
    imagePath: join(
      project.rootPath,
      ".design-sharingan",
      "renders",
      "mangekyo-1",
      "round-1",
      "desktop.png",
    ),
  };
  session.initialRender = artifact;
  await saveRenderArtifact(project.rootPath, artifact, pngBytes());
  await saveMangekyoLoopSession(project.rootPath, session);

  const replacement = pngBytes();
  replacement[23] = 99;
  await writeFile(artifact.imagePath, replacement);

  await expect(loadMangekyoLoopSession(project.rootPath, project.id, session.id))
    .rejects.toThrow(/PNG|digest|integrity|render/i);
});

const invalidInterruptedSessionEvidence = [
  {
    name: "missing",
    mutate: (session: MangekyoLoopSession) => {
      session.policyEvaluations = [];
    },
  },
  {
    name: "empty paths",
    mutate: (session: MangekyoLoopSession) => {
      const latest = session.policyEvaluations.at(-1);
      if (latest !== undefined) latest.change.files = [];
    },
  },
  {
    name: "orphan round",
    mutate: (session: MangekyoLoopSession) => {
      const latest = session.policyEvaluations.at(-1);
      if (latest !== undefined) latest.roundNumber = 2;
    },
  },
  {
    name: "duplicate paths",
    mutate: (session: MangekyoLoopSession) => {
      const latest = session.policyEvaluations.at(-1);
      if (latest !== undefined) latest.change.files = ["server.mjs", "server.mjs"];
    },
  },
  {
    name: "duplicate current evaluation",
    mutate: (session: MangekyoLoopSession) => {
      const latest = session.policyEvaluations.at(-1);
      if (latest !== undefined) {
        session.policyEvaluations.push({ ...structuredClone(latest), id: "policy-interrupted-2" });
      }
    },
  },
  {
    name: "tampered policy result",
    mutate: (session: MangekyoLoopSession) => {
      const latest = session.policyEvaluations.at(-1);
      if (latest !== undefined) {
        latest.policy = { ...latest.policy, allowStyleChanges: false };
      }
    },
  },
  {
    name: "substituted policy-allowed path",
    mutate: (session: MangekyoLoopSession) => {
      const latest = session.policyEvaluations.at(-1);
      if (latest !== undefined) latest.change.files = ["substituted.mjs"];
    },
  },
  {
    name: "missing pending proposal",
    mutate: (session: MangekyoLoopSession) => {
      delete session.pendingChange;
    },
  },
  {
    name: "substituted pending proposal",
    mutate: (session: MangekyoLoopSession) => {
      if (session.pendingChange !== undefined) {
        session.pendingChange.proposal.id = "proposal-substituted";
      }
    },
  },
  {
    name: "substituted pending thread",
    mutate: (session: MangekyoLoopSession) => {
      if (session.pendingChange !== undefined) {
        session.pendingChange.proposalThreadId = "thread-substituted";
      }
    },
  },
  {
    name: "substituted pending delta category",
    mutate: (session: MangekyoLoopSession) => {
      if (session.pendingChange !== undefined) {
        session.pendingChange.proposal.filesToCreate = ["server.mjs"];
        session.pendingChange.proposal.filesToModify = [];
      }
    },
  },
  {
    name: "orphan pending policy link",
    mutate: (session: MangekyoLoopSession) => {
      if (session.pendingChange !== undefined) {
        session.pendingChange.policyEvaluationId = "policy-orphan";
      }
    },
  },
  {
    name: "duplicate pending delta path",
    mutate: (session: MangekyoLoopSession) => {
      if (session.pendingChange !== undefined) {
        session.pendingChange.proposal.filesToCreate = ["server.mjs"];
      }
    },
  },
] as const;

const claimRetainedPendingEvidence = invalidInterruptedSessionEvidence.filter(({ name }) => [
  "substituted policy-allowed path",
  "missing pending proposal",
  "substituted pending proposal",
  "substituted pending thread",
  "substituted pending delta category",
  "orphan pending policy link",
  "duplicate pending delta path",
].includes(name));

function completeSessionFixture(rootPath: string): MangekyoLoopSession {
  const session = sessionFixture(rootPath);
  const proposal = structuredClone(session.currentGate?.proposal as NonNullable<typeof session.currentGate>["proposal"]);
  proposal.id = "proposal-style";
  proposal.summary = "Strengthen the evidence hierarchy.";
  proposal.reason = "Preserve behavior while improving hierarchy.";
  proposal.policyViolations = [];
  const change = { kind: "STYLE_CHANGE" as const, files: ["server.mjs"] };
  const mutationSourceRevision = {
    kind: "GIT" as const,
    available: true as const,
    head: "a".repeat(40),
    branch: "fixture",
    status: "DIRTY" as const,
    entries: [{ index: " ", workingTree: "M", path: "server.mjs" }],
    truncated: false,
    worktreeFingerprint: "c".repeat(64),
    fileCount: 2,
    requiredPathEvidence: [{
      path: "server.mjs",
      state: "FILE" as const,
      mode: 0o644,
      size: 9,
      contentHash: "d".repeat(64),
    }],
  };
  const afterRender: RenderArtifact = {
    ...renderArtifact(join(rootPath, ".design-sharingan", "renders", "mangekyo-1", "round-1.png")),
    roundId: "round-1-after",
    id: "render-after-1",
    capturedAt: "2026-08-27T01:00:04.000Z",
    sourceRevision: mutationSourceRevision,
  };
  session.status = "COMPLETE";
  session.updatedAt = "2026-08-27T01:00:06.000Z";
  session.currentGate = undefined;
  session.gates = [];
  session.gateDecisions = [];
  session.policyEvaluations = [{
    id: "policy-style",
    roundNumber: 1,
    proposalId: proposal.id,
    change,
    policy: DEFAULT_AUTONOMY_POLICY,
    evaluation: { decision: "ALLOW", reasons: [] },
    evaluatedAt: "2026-08-27T01:00:02.000Z",
  }];
  session.rounds = [{
    round: {
      roundNumber: 1,
      startedAt: "2026-08-27T01:00:02.000Z",
      completedAt: "2026-08-27T01:00:05.000Z",
      beforeRender: structuredClone(session.initialRender),
      afterRender,
      filesChanged: ["server.mjs"],
      findingsBefore: [],
      actions: ["Strengthen the evidence hierarchy."],
      findingsAfter: [],
      criticalCount: 0,
      importantCount: 0,
      polishCount: 0,
      uxIntegrity: { status: "PASS", evidence: ["UX remains intact."] },
      productConsistency: { status: "PASS", evidence: ["Product patterns remain intact."] },
      accessibility: { status: "PASS", evidence: ["No accessibility regression is visible."] },
      genomeIntegrity: { status: "PASS", evidence: ["Approved Genome v1 remains intact."] },
      genomeEvidenceVersion: "1",
      status: "COMPLETE",
    },
    proposal,
    proposalThreadId: "thread-style",
    policyEvaluationId: "policy-style",
    mutationCompletedAt: "2026-08-27T01:00:03.000Z",
    mutationSourceRevision,
    visualAnalysisThreadId: "visual-style",
  }];
  session.inspectedScreens = ["/"];
  session.finalRender = afterRender;
  session.stopReason = "Quality criteria satisfied with fresh final evidence.";
  return session;
}

function decidingSessionFixture(rootPath: string): MangekyoLoopSession {
  const session = completeSessionFixture(rootPath);
  session.status = "DECIDING";
  session.updatedAt = "2026-08-27T01:00:05.000Z";
  session.rounds[0]!.round.status = "DECIDING";
  delete session.finalRender;
  delete session.stopReason;
  return session;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("Mangekyo loop persistence", () => {
  it("rejects policies that remove any mandatory protected path", async () => {
    const project = await projectFixture();
    const session = sessionFixture(project.rootPath);
    session.policy = {
      ...session.policy,
      protectedPaths: session.policy.protectedPaths.filter((path) => path !== ".git/**"),
    };

    expect(isMangekyoLoopSession(session)).toBe(false);
    await expect(saveMangekyoLoopSession(project.rootPath, session)).rejects.toThrow(
      /invalid Mangekyo loop/i,
    );
  });

  it("rejects fabricated COMPLETE evidence that reuses the initial render without a completed final round", () => {
    const session = sessionFixture("/project");
    session.status = "COMPLETE";
    session.currentGate = undefined;
    session.finalRender = structuredClone(session.initialRender);
    session.stopReason = "Quality criteria satisfied with fresh final evidence.";

    expect(isMangekyoLoopSession(session)).toBe(false);
  });

  it("rejects a current Human Gate that already has a conflicting durable decision", () => {
    const session = sessionFixture("/project");
    session.gateDecisions = [{
      id: "decision-reject",
      gateId: "gate-1",
      decision: "REJECT",
      decidedBy: "local-user",
      createdAt: "2026-08-27T01:00:03.000Z",
    }];

    expect(isMangekyoLoopSession(session)).toBe(false);
  });

  it("accepts the exact crash-truthful POLICY_CHECK checkpoint before mutation", () => {
    const session = sessionFixture("/project");
    session.status = "POLICY_CHECK";
    session.currentGate = undefined;
    session.gates = [];

    expect(isMangekyoLoopSession(session)).toBe(true);
  });

  it.each([
    ["finding counts", (session: MangekyoLoopSession) => {
      (session.rounds[0] as NonNullable<typeof session.rounds[0]>).round.importantCount = 1;
    }],
    ["exact post-mutation source", (session: MangekyoLoopSession) => {
      const evidence = session.rounds[0] as NonNullable<typeof session.rounds[0]>;
      evidence.mutationSourceRevision = {
        ...(evidence.mutationSourceRevision as Extract<RenderArtifact["sourceRevision"], { kind: "GIT" }>),
        worktreeFingerprint: "d".repeat(64),
      };
    }],
    ["claimed screen coverage", (session: MangekyoLoopSession) => {
      session.claimedScreens = ["/", "/settings"];
    }],
    ["sequential round identity", (session: MangekyoLoopSession) => {
      (session.rounds[0] as NonNullable<typeof session.rounds[0]>).round.roundNumber = 2;
    }],
    ["recomputed policy outcome", (session: MangekyoLoopSession) => {
      const evidence = session.policyEvaluations[0] as NonNullable<typeof session.policyEvaluations[0]>;
      evidence.policy = { ...evidence.policy, allowStyleChanges: false };
    }],
    ["final render link", (session: MangekyoLoopSession) => {
      session.finalRender = {
        ...(session.finalRender as RenderArtifact),
        id: "unrelated-final-render",
      };
    }],
    ["orphan policy evaluation", (session: MangekyoLoopSession) => {
      session.policyEvaluations.push({
        ...(session.policyEvaluations[0] as NonNullable<typeof session.policyEvaluations[0]>),
        id: "orphan-policy-evaluation",
        proposalId: "orphan-proposal",
      });
    }],
    ["unbounded source fingerprint", (session: MangekyoLoopSession) => {
      const evidence = session.rounds[0] as NonNullable<typeof session.rounds[0]>;
      evidence.mutationSourceRevision = {
        ...(evidence.mutationSourceRevision as Extract<RenderArtifact["sourceRevision"], { kind: "GIT" }>),
        fileCount: 513,
      };
      (evidence.round.afterRender as RenderArtifact).sourceRevision = structuredClone(
        evidence.mutationSourceRevision,
      );
      session.finalRender = structuredClone(evidence.round.afterRender);
    }],
    ["non-permission source mode", (session: MangekyoLoopSession) => {
      const evidence = session.rounds[0] as NonNullable<typeof session.rounds[0]>;
      const revision = evidence.mutationSourceRevision;
      if (revision.available && revision.requiredPathEvidence[0]?.state === "FILE") {
        revision.requiredPathEvidence[0].mode = 0o100644;
      }
      (evidence.round.afterRender as RenderArtifact).sourceRevision = structuredClone(revision);
      session.finalRender = structuredClone(evidence.round.afterRender);
    }],
    ["missing changed-path source coverage", (session: MangekyoLoopSession) => {
      const evidence = session.rounds[0] as NonNullable<typeof session.rounds[0]>;
      if (evidence.mutationSourceRevision.available) {
        evidence.mutationSourceRevision.requiredPathEvidence = [];
      }
      if (evidence.round.afterRender?.sourceRevision.available) {
        evidence.round.afterRender.sourceRevision.requiredPathEvidence = [];
      }
      if (session.finalRender?.sourceRevision.available) {
        session.finalRender.sourceRevision.requiredPathEvidence = [];
      }
    }],
  ] as const)("rejects persisted COMPLETE evidence with tampered %s", (_label, tamper) => {
    const session = completeSessionFixture("/project");
    tamper(session);
    expect(isMangekyoLoopSession(session)).toBe(false);
  });

  it("rejects a resolved gate decision that predates its requested gate", () => {
    const session = sessionFixture("/project");
    session.status = "BLOCKED";
    session.currentGate = undefined;
    session.stopReason = "The pending policy-boundary change was rejected.";
    session.gateDecisions = [{
      id: "decision-reject",
      gateId: "gate-1",
      decision: "REJECT",
      decidedBy: "local-user",
      createdAt: "2026-08-27T01:00:01.000Z",
    }];

    expect(isMangekyoLoopSession(session)).toBe(false);
  });

  it("rejects a gate whose proposal files are unrelated to its requested change", () => {
    const session = sessionFixture("/project");
    const gate = session.currentGate as NonNullable<typeof session.currentGate>;
    gate.proposal.filesToModify = ["unrelated.ts"];
    session.gates = [structuredClone(gate)];

    expect(isMangekyoLoopSession(session)).toBe(false);
  });

  it("rejects an Approve Once decision that has no linked completed execution or failed mutation", () => {
    const session = sessionFixture("/project");
    session.status = "BLOCKED";
    session.updatedAt = "2026-08-27T01:00:03.000Z";
    session.currentGate = undefined;
    session.gateDecisions = [{
      id: "decision-approve",
      gateId: "gate-1",
      decision: "APPROVE_ONCE",
      decidedBy: "local-user",
      createdAt: "2026-08-27T01:00:03.000Z",
    }];
    session.stopReason = "Fabricated unresolved authorization.";

    expect(isMangekyoLoopSession(session)).toBe(false);
  });

  it.each(["APPROVE_ONCE", "EXPAND_SCOPE"] as const)(
    "round-trips the exact pending %s checkpoint before its authorized round exists",
    async (decisionKind) => {
      const project = await projectFixture();
      const session = sessionFixture(project.rootPath);
      const gate = structuredClone(session.currentGate as NonNullable<typeof session.currentGate>);
      session.policyEvaluations[0]!.evaluatedAt = "2026-08-27T01:00:02.000Z";
      gate.requestedAt = "2026-08-27T01:00:02.100Z";
      session.gates = [structuredClone(gate)];
      const decision = {
        id: `decision-${decisionKind.toLowerCase()}`,
        gateId: gate.id,
        decision: decisionKind,
        decidedBy: "local-user",
        createdAt: "2026-08-27T01:00:03.000Z",
        ...(decisionKind === "EXPAND_SCOPE"
          ? {
              policyAfter: {
                ...DEFAULT_AUTONOMY_POLICY,
                allowNavigationChanges: true,
                protectedPaths: [...DEFAULT_AUTONOMY_POLICY.protectedPaths],
              },
            }
          : {}),
      } as const;
      session.status = "EDITING";
      session.updatedAt = decision.createdAt;
      session.currentGate = undefined;
      session.gateDecisions = [decision];
      session.policy = decisionKind === "EXPAND_SCOPE"
        ? structuredClone(decision.policyAfter as NonNullable<typeof decision.policyAfter>)
        : DEFAULT_AUTONOMY_POLICY;
      delete session.stopReason;
      await mkdir(join(project.rootPath, ".design-sharingan", "renders", session.id), {
        recursive: true,
      });
      await writeFile(
        session.initialRender?.imagePath as string,
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      );

      await saveMangekyoLoopSession(project.rootPath, session);

      await expect(
        loadMangekyoLoopSession(project.rootPath, project.id, session.id),
      ).resolves.toEqual(session);
    },
  );

  it("round-trips Stop from an exact pre-mutation EDITING policy checkpoint", async () => {
    const project = await projectFixture();
    const session = sessionFixture(project.rootPath);
    session.status = "BLOCKED";
    session.updatedAt = "2026-08-27T01:00:04.000Z";
    session.currentGate = undefined;
    session.gates = [];
    session.policyEvaluations = [{
      id: "policy-style",
      roundNumber: 1,
      proposalId: "proposal-style",
      change: { kind: "STYLE_CHANGE", files: ["styles.css"] },
      policy: DEFAULT_AUTONOMY_POLICY,
      evaluation: { decision: "ALLOW", reasons: [] },
      evaluatedAt: "2026-08-27T01:00:02.000Z",
    }];
    session.stopRequest = {
      id: "stop-request-editing",
      loopSessionId: session.id,
      sessionVersion: "2026-08-27T01:00:03.000Z",
      requestedAt: "2026-08-27T01:00:04.000Z",
      requestedBy: "local-user",
    };
    session.stopReason = "The user stopped the visual loop before completion.";
    await mkdir(join(project.rootPath, ".design-sharingan", "renders", session.id), {
      recursive: true,
    });
    await writeFile(
      session.initialRender?.imagePath as string,
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    );

    await saveMangekyoLoopSession(project.rootPath, session);

    await expect(
      loadMangekyoLoopSession(project.rootPath, project.id, session.id),
    ).resolves.toEqual(session);
    expect(session.finalRender).toBeUndefined();
  });

  it("accepts a durable user Stop as the sole truthful resolution of a pending Human Gate", () => {
    const session = sessionFixture("/project");
    session.status = "BLOCKED";
    session.updatedAt = "2026-08-27T01:00:03.000Z";
    session.currentGate = undefined;
    session.stopRequest = {
      id: "stop-request-1",
      loopSessionId: session.id,
      sessionVersion: "2026-08-27T01:00:02.000Z",
      requestedAt: "2026-08-27T01:00:03.000Z",
      requestedBy: "local-user",
    };
    session.stopReason = "The user stopped the visual loop before completion.";

    expect(isMangekyoLoopSession(session)).toBe(true);
    expect(session.finalRender).toBeUndefined();
  });

  it("atomically claims one mixed Human Gate decision for the exact session version", async () => {
    const project = await projectFixture();
    const base = {
      loopSessionId: "mangekyo-1",
      sessionVersion: "2026-08-27T01:00:02.000Z",
      gateId: "gate-1",
      decidedAt: "2026-08-27T01:00:03.000Z",
    };

    const outcomes = await Promise.allSettled([
      claimMangekyoGateDecision(project.rootPath, project.id, {
        ...base,
        decisionId: "decision-approve",
        decision: "APPROVE_ONCE",
      }),
      claimMangekyoGateDecision(project.rootPath, project.id, {
        ...base,
        decisionId: "decision-reject",
        decision: "REJECT",
      }),
    ]);

    expect(outcomes.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter(({ status }) => status === "rejected")).toHaveLength(1);
    expect(
      (outcomes.find(({ status }) => status === "rejected") as PromiseRejectedResult).reason,
    ).toEqual(expect.objectContaining({ message: expect.stringMatching(/already decided/i) }));
  });

  it("releases an action claim only while the exact Human Gate session version is unchanged", async () => {
    const project = await projectFixture();
    const session = sessionFixture(project.rootPath);
    await mkdir(join(project.rootPath, ".design-sharingan", "renders", session.id), {
      recursive: true,
    });
    await writeFile(
      session.initialRender?.imagePath as string,
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    );
    await saveMangekyoLoopSession(project.rootPath, session);
    const claim = {
      loopSessionId: session.id,
      sessionVersion: session.updatedAt,
      gateId: session.currentGate?.id as string,
      decisionId: "decision-approve",
      decision: "APPROVE_ONCE" as const,
      decidedAt: "2026-08-27T01:00:03.000Z",
    };
    await claimMangekyoGateDecision(project.rootPath, project.id, claim);

    await releaseMangekyoGateDecisionClaim(project.rootPath, project.id, claim);

    await expect(claimMangekyoGateDecision(project.rootPath, project.id, {
      ...claim,
      decisionId: "decision-retry",
    })).resolves.toBeUndefined();
  });

  it("retains an action claim when the gate decision may already be persisted", async () => {
    const project = await projectFixture();
    const session = sessionFixture(project.rootPath);
    await mkdir(join(project.rootPath, ".design-sharingan", "renders", session.id), {
      recursive: true,
    });
    await writeFile(
      session.initialRender?.imagePath as string,
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    );
    await saveMangekyoLoopSession(project.rootPath, session);
    const claim = {
      loopSessionId: session.id,
      sessionVersion: session.updatedAt,
      gateId: session.currentGate?.id as string,
      decisionId: "decision-approve",
      decision: "APPROVE_ONCE" as const,
      decidedAt: "2026-08-27T01:00:03.000Z",
    };
    await claimMangekyoGateDecision(project.rootPath, project.id, claim);
    session.status = "EDITING";
    session.updatedAt = claim.decidedAt;
    session.currentGate = undefined;
    session.gateDecisions = [{
      id: claim.decisionId,
      gateId: claim.gateId,
      decision: claim.decision,
      decidedBy: "local-user",
      createdAt: claim.decidedAt,
    }];
    delete session.stopReason;
    await saveMangekyoLoopSession(project.rootPath, session);

    await expect(
      releaseMangekyoGateDecisionClaim(project.rootPath, project.id, claim),
    ).rejects.toThrow(/transitioned|ambiguous/i);
    await expect(claimMangekyoGateDecision(project.rootPath, project.id, {
      ...claim,
      decisionId: "decision-retry",
    })).rejects.toThrow(/already decided/i);
  });

  it("atomically claims one active project loop and releases it only for the exact proven terminal session", async () => {
    const project = await projectFixture();
    const first = {
      loopSessionId: "mangekyo-1",
      sourceExecutionSessionId: "safe-session-1",
      claimedAt: "2026-08-27T01:00:00.000Z",
    };
    const outcomes = await Promise.allSettled([
      claimMangekyoActiveLoop(project.rootPath, project.id, first),
      claimMangekyoActiveLoop(project.rootPath, project.id, {
        ...first,
        loopSessionId: "mangekyo-2",
      }),
    ]);
    expect(outcomes.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter(({ status }) => status === "rejected")).toHaveLength(1);

    const winner = outcomes[0]?.status === "fulfilled"
      ? first
      : { ...first, loopSessionId: "mangekyo-2" };
    await expect(
      loadMangekyoActiveLoopClaim(project.rootPath, project.id),
    ).resolves.toEqual(winner);
    await expect(
      releaseMangekyoActiveLoop(project.rootPath, project.id, {
        ...winner,
        loopSessionId: "different-session",
        terminalStatus: "BLOCKED",
      }),
    ).rejects.toThrow(/exact active loop|ambiguous/i);
    await releaseMangekyoActiveLoop(project.rootPath, project.id, {
      ...winner,
      reservationStatus: "UNPERSISTED",
    });
    const terminalClaim = first;
    await claimMangekyoActiveLoop(project.rootPath, project.id, terminalClaim);
    const terminal = completeSessionFixture(project.rootPath);
    await mkdir(join(project.rootPath, ".design-sharingan", "renders", "mangekyo-1"), {
      recursive: true,
    });
    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    await writeFile(terminal.initialRender?.imagePath as string, png);
    await writeFile(terminal.finalRender?.imagePath as string, png);
    await saveMangekyoLoopSession(project.rootPath, terminal);
    await releaseMangekyoActiveLoop(project.rootPath, project.id, {
      ...terminalClaim,
      terminalStatus: "COMPLETE",
    });
    await expect(
      loadMangekyoActiveLoopClaim(project.rootPath, project.id),
    ).resolves.toBeUndefined();
    await expect(
      claimMangekyoActiveLoop(project.rootPath, project.id, {
        loopSessionId: "mangekyo-3",
        sourceExecutionSessionId: "safe-session-2",
        claimedAt: "2026-08-27T01:00:04.000Z",
      }),
    ).resolves.toBeUndefined();
  });

  it("releases an exact unpersisted start reservation but retains any ambiguous partial session", async () => {
    const project = await projectFixture();
    const claim = {
      loopSessionId: "mangekyo-1",
      sourceExecutionSessionId: "safe-session-1",
      claimedAt: "2026-08-27T01:00:00.000Z",
    };
    await claimMangekyoActiveLoop(project.rootPath, project.id, claim);
    await expect(releaseMangekyoActiveLoop(project.rootPath, project.id, {
      ...claim,
      reservationStatus: "UNPERSISTED",
    } as Parameters<typeof releaseMangekyoActiveLoop>[2])).resolves.toBeUndefined();

    await claimMangekyoActiveLoop(project.rootPath, project.id, claim);
    const partial = sessionFixture(project.rootPath);
    partial.id = claim.loopSessionId;
    partial.sourceExecutionSessionId = claim.sourceExecutionSessionId;
    partial.createdAt = claim.claimedAt;
    await mkdir(join(project.rootPath, ".design-sharingan", "renders", "mangekyo-1"), {
      recursive: true,
    });
    await writeFile(
      partial.initialRender?.imagePath as string,
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    );
    await saveMangekyoLoopSession(project.rootPath, partial);
    await expect(releaseMangekyoActiveLoop(project.rootPath, project.id, {
      ...claim,
      reservationStatus: "UNPERSISTED",
    } as Parameters<typeof releaseMangekyoActiveLoop>[2])).rejects.toThrow(/persisted|ambiguous/i);
    await expect(loadMangekyoActiveLoopClaim(project.rootPath, project.id)).resolves.toEqual(claim);
  });

  it("refuses terminal active-loop release without the exact durable terminal session", async () => {
    const project = await projectFixture();
    const claim = {
      loopSessionId: "mangekyo-1",
      sourceExecutionSessionId: "safe-session-1",
      claimedAt: "2026-08-27T01:00:00.000Z",
    };
    await claimMangekyoActiveLoop(project.rootPath, project.id, claim);
    await expect(releaseMangekyoActiveLoop(project.rootPath, project.id, {
      ...claim,
      terminalStatus: "BLOCKED",
    })).rejects.toThrow(/terminal session|ambiguous/i);
    await expect(loadMangekyoActiveLoopClaim(project.rootPath, project.id)).resolves.toEqual(claim);
  });

  it("persists and reloads one durable Stop request for an exact active session version", async () => {
    const project = await projectFixture();
    const request = {
      id: "stop-request-1",
      loopSessionId: "mangekyo-1",
      sessionVersion: "2026-08-27T01:00:02.000Z",
      requestedAt: "2026-08-27T01:00:03.000Z",
      requestedBy: "local-user",
    };

    await expect(
      requestMangekyoStop(project.rootPath, project.id, request),
    ).resolves.toEqual(request);

    await expect(
      loadMangekyoStopRequest(project.rootPath, project.id, request.loopSessionId),
    ).resolves.toEqual(request);
    await expect(
      requestMangekyoStop(project.rootPath, project.id, { ...request, id: "stop-request-replay" }),
    ).resolves.toEqual(request);
  });

  it("rejects a late Stop after the exact terminal session commit without leaving Stop evidence", async () => {
    const project = await projectFixture();
    const deciding = decidingSessionFixture(project.rootPath);
    const terminal = completeSessionFixture(project.rootPath);
    await mkdir(join(project.rootPath, ".design-sharingan", "renders", terminal.id), {
      recursive: true,
    });
    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    await writeFile(terminal.initialRender?.imagePath as string, png);
    await writeFile(terminal.finalRender?.imagePath as string, png);
    await saveMangekyoLoopSession(project.rootPath, deciding);
    await prepareFixtureRenders(project.rootPath, terminal);
    await expect(commitMangekyoTerminalTransition(project.rootPath, project.id, {
      expectedVersion: deciding.updatedAt,
      session: terminal,
    })).resolves.toEqual({ outcome: "COMMITTED", session: terminal });

    await expect(requestMangekyoStop(project.rootPath, project.id, {
      id: "late-stop",
      loopSessionId: terminal.id,
      sessionVersion: deciding.updatedAt,
      requestedAt: "2026-08-27T01:00:07.000Z",
      requestedBy: "local-user",
    })).rejects.toThrow(/already terminal/i);
    await expect(loadMangekyoStopRequest(
      project.rootPath,
      project.id,
      terminal.id,
    )).resolves.toBeUndefined();
  });

  it("lets an exact Stop claim win the durable post-read terminal CAS", async () => {
    const project = await projectFixture();
    const deciding = decidingSessionFixture(project.rootPath);
    const terminal = completeSessionFixture(project.rootPath);
    await mkdir(join(project.rootPath, ".design-sharingan", "renders", deciding.id), {
      recursive: true,
    });
    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    await writeFile(deciding.initialRender?.imagePath as string, png);
    await writeFile(deciding.rounds[0]?.round.afterRender?.imagePath as string, png);
    await saveMangekyoLoopSession(project.rootPath, deciding);
    const stopRequest = {
      id: "stop-wins-terminal-cas",
      loopSessionId: deciding.id,
      sessionVersion: deciding.updatedAt,
      requestedAt: "2026-08-27T01:00:05.500Z",
      requestedBy: "local-user",
    };
    await requestMangekyoStop(project.rootPath, project.id, stopRequest);

    await expect(commitMangekyoTerminalTransition(project.rootPath, project.id, {
      expectedVersion: deciding.updatedAt,
      session: terminal,
    })).resolves.toEqual({ outcome: "STOP_WON", stopRequest });
    await expect(loadMangekyoLoopSession(
      project.rootPath,
      project.id,
      deciding.id,
    )).resolves.toEqual(deciding);
  });

  it("serializes a Stop request against a Human Gate decision for the same session version", async () => {
    const project = await projectFixture();
    const outcomes = await Promise.allSettled([
      requestMangekyoStop(project.rootPath, project.id, {
        id: "stop-request-1",
        loopSessionId: "mangekyo-1",
        sessionVersion: "2026-08-27T01:00:02.000Z",
        requestedAt: "2026-08-27T01:00:03.000Z",
        requestedBy: "local-user",
      }),
      claimMangekyoGateDecision(project.rootPath, project.id, {
        loopSessionId: "mangekyo-1",
        sessionVersion: "2026-08-27T01:00:02.000Z",
        gateId: "gate-1",
        decisionId: "decision-reject",
        decision: "REJECT",
        decidedAt: "2026-08-27T01:00:03.000Z",
      }),
    ]);

    expect(outcomes.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter(({ status }) => status === "rejected")).toHaveLength(1);
  });

  it("recovers one exact expired durable worker lease without duplicating a live owner or blocking Stop", async () => {
    const project = await projectFixture();
    const session = sessionFixture(project.rootPath);
    await mkdir(join(project.rootPath, ".design-sharingan", "renders", session.id), {
      recursive: true,
    });
    await writeFile(
      session.initialRender?.imagePath as string,
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    );
    await saveMangekyoLoopSession(project.rootPath, session);
    await claimMangekyoActiveLoop(project.rootPath, project.id, {
      loopSessionId: session.id,
      sourceExecutionSessionId: session.sourceExecutionSessionId,
      claimedAt: session.createdAt,
    });
    const first = {
      loopSessionId: session.id,
      sessionVersion: session.updatedAt,
      workerId: "worker-before-restart",
      acquiredAt: "2026-08-27T01:00:03.000Z",
      expiresAt: "2026-08-27T01:00:04.000Z",
    };
    await claimMangekyoWorkerLease(project.rootPath, project.id, first, first.acquiredAt);
    await expect(
      claimMangekyoWorkerLease(project.rootPath, project.id, first, first.acquiredAt),
    ).resolves.toBeUndefined();
    await expect(claimMangekyoWorkerLease(project.rootPath, project.id, {
      ...first,
      workerId: "duplicate-live-worker",
      acquiredAt: "2026-08-27T01:00:03.500Z",
      expiresAt: "2026-08-27T01:00:04.500Z",
    }, "2026-08-27T01:00:03.500Z")).rejects.toThrow(/live.*worker lease/i);

    const stop = {
      id: "stop-during-lost-worker",
      loopSessionId: session.id,
      sessionVersion: session.updatedAt,
      requestedAt: "2026-08-27T01:00:03.600Z",
      requestedBy: "local-user",
    };
    await expect(requestMangekyoStop(project.rootPath, project.id, stop)).resolves.toEqual(stop);

    const recovered = {
      ...first,
      workerId: "worker-after-restart",
      acquiredAt: "2026-08-27T01:00:05.000Z",
      expiresAt: "2026-08-27T01:00:06.000Z",
    };
    await claimMangekyoWorkerLease(
      project.rootPath,
      project.id,
      recovered,
      recovered.acquiredAt,
    );
    await expect(loadMangekyoWorkerLease(project.rootPath, project.id)).resolves.toEqual(recovered);
    await releaseMangekyoWorkerLease(project.rootPath, project.id, recovered);
    await expect(loadMangekyoWorkerLease(project.rootPath, project.id)).resolves.toBeUndefined();

    await writeFile(
      join(
        project.rootPath,
        ".design-sharingan",
        "cache",
        "mangekyo-claims",
        "worker-lease.lock",
      ),
      `${JSON.stringify(first)}\n`,
    );
    const afterOrphanedRecoveryLock = {
      ...first,
      workerId: "worker-after-orphaned-recovery-lock",
      acquiredAt: "2026-08-27T01:00:07.000Z",
      expiresAt: "2026-08-27T01:00:08.000Z",
    };
    await expect(claimMangekyoWorkerLease(
      project.rootPath,
      project.id,
      afterOrphanedRecoveryLock,
      afterOrphanedRecoveryLock.acquiredAt,
    )).resolves.toBeUndefined();
    await releaseMangekyoWorkerLease(
      project.rootPath,
      project.id,
      afterOrphanedRecoveryLock,
    );
  });

  it("atomically renews a still-live exact worker so the old expiry cannot trigger takeover", async () => {
    const project = await projectFixture();
    const session = sessionFixture(project.rootPath);
    await mkdir(join(project.rootPath, ".design-sharingan", "renders", session.id), {
      recursive: true,
    });
    await writeFile(
      session.initialRender?.imagePath as string,
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    );
    await saveMangekyoLoopSession(project.rootPath, session);
    await claimMangekyoActiveLoop(project.rootPath, project.id, {
      loopSessionId: session.id,
      sourceExecutionSessionId: session.sourceExecutionSessionId,
      claimedAt: session.createdAt,
    });
    const initial = {
      loopSessionId: session.id,
      sessionVersion: session.updatedAt,
      workerId: "worker-long-running",
      acquiredAt: "2026-08-27T01:00:03.000Z",
      expiresAt: "2026-08-27T01:01:03.000Z",
    };
    await claimMangekyoWorkerLease(project.rootPath, project.id, initial, initial.acquiredAt);

    const renewed = {
      ...initial,
      acquiredAt: "2026-08-27T01:00:43.000Z",
      expiresAt: "2026-08-27T01:01:43.000Z",
    };
    await expect(
      claimMangekyoWorkerLease(project.rootPath, project.id, renewed, renewed.acquiredAt),
    ).resolves.toBeUndefined();

    const recoveryAtOldExpiry = {
      ...initial,
      workerId: "worker-recovery-at-old-expiry",
      acquiredAt: "2026-08-27T01:01:04.000Z",
      expiresAt: "2026-08-27T01:02:04.000Z",
    };
    await expect(
      claimMangekyoWorkerLease(
        project.rootPath,
        project.id,
        recoveryAtOldExpiry,
        recoveryAtOldExpiry.acquiredAt,
      ),
    ).rejects.toThrow(/live.*worker lease/i);
    await expect(loadMangekyoWorkerLease(project.rootPath, project.id)).resolves.toEqual(renewed);
    await releaseMangekyoWorkerLease(project.rootPath, project.id, renewed);
  });

  it("advances only the exact live owner's lease to the newly persisted session version", async () => {
    const project = await projectFixture();
    const session = sessionFixture(project.rootPath);
    await mkdir(join(project.rootPath, ".design-sharingan", "renders", session.id), {
      recursive: true,
    });
    await writeFile(
      session.initialRender?.imagePath as string,
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    );
    await saveMangekyoLoopSession(project.rootPath, session);
    await claimMangekyoActiveLoop(project.rootPath, project.id, {
      loopSessionId: session.id,
      sourceExecutionSessionId: session.sourceExecutionSessionId,
      claimedAt: session.createdAt,
    });
    const initial = {
      loopSessionId: session.id,
      sessionVersion: session.updatedAt,
      workerId: "worker-version-owner",
      acquiredAt: "2026-08-27T01:00:03.000Z",
      expiresAt: "2026-08-27T01:01:03.000Z",
    };
    await claimMangekyoWorkerLease(project.rootPath, project.id, initial, initial.acquiredAt);
    const nextSession = {
      ...session,
      updatedAt: "2026-08-27T01:00:04.000Z",
    };
    await saveMangekyoLoopSession(project.rootPath, nextSession);
    const advanced = {
      ...initial,
      sessionVersion: nextSession.updatedAt,
      acquiredAt: "2026-08-27T01:00:05.000Z",
      expiresAt: "2026-08-27T01:01:05.000Z",
    };

    await expect(
      claimMangekyoWorkerLease(project.rootPath, project.id, advanced, advanced.acquiredAt),
    ).resolves.toBeUndefined();
    await expect(loadMangekyoWorkerLease(project.rootPath, project.id)).resolves.toEqual(advanced);
    await releaseMangekyoWorkerLease(project.rootPath, project.id, advanced);
  });

  it("rejects a replaced owner's late renewal without changing the takeover lease", async () => {
    const project = await projectFixture();
    const session = sessionFixture(project.rootPath);
    await mkdir(join(project.rootPath, ".design-sharingan", "renders", session.id), {
      recursive: true,
    });
    await writeFile(
      session.initialRender?.imagePath as string,
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    );
    await saveMangekyoLoopSession(project.rootPath, session);
    await claimMangekyoActiveLoop(project.rootPath, project.id, {
      loopSessionId: session.id,
      sourceExecutionSessionId: session.sourceExecutionSessionId,
      claimedAt: session.createdAt,
    });
    const expired = {
      loopSessionId: session.id,
      sessionVersion: session.updatedAt,
      workerId: "worker-expired",
      acquiredAt: "2026-08-27T01:00:03.000Z",
      expiresAt: "2026-08-27T01:00:04.000Z",
    };
    await claimMangekyoWorkerLease(project.rootPath, project.id, expired, expired.acquiredAt);
    const replacement = {
      ...expired,
      workerId: "worker-takeover",
      acquiredAt: "2026-08-27T01:00:05.000Z",
      expiresAt: "2026-08-27T01:01:05.000Z",
    };
    await claimMangekyoWorkerLease(
      project.rootPath,
      project.id,
      replacement,
      replacement.acquiredAt,
    );
    const lateRenewal = {
      ...expired,
      acquiredAt: "2026-08-27T01:00:06.000Z",
      expiresAt: "2026-08-27T01:01:06.000Z",
    };

    await expect(
      claimMangekyoWorkerLease(project.rootPath, project.id, lateRenewal, lateRenewal.acquiredAt),
    ).rejects.toThrow(/live.*worker lease/i);
    await expect(loadMangekyoWorkerLease(project.rootPath, project.id)).resolves.toEqual(replacement);
    await releaseMangekyoWorkerLease(project.rootPath, project.id, replacement);
  });

  it("heartbeats through long agent, render, and mutation intervals then clears its timer", async () => {
    const project = await projectFixture();
    const session = sessionFixture(project.rootPath);
    await mkdir(join(project.rootPath, ".design-sharingan", "renders", session.id), {
      recursive: true,
    });
    await writeFile(
      session.initialRender?.imagePath as string,
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    );
    await saveMangekyoLoopSession(project.rootPath, session);
    await claimMangekyoActiveLoop(project.rootPath, project.id, {
      loopSessionId: session.id,
      sourceExecutionSessionId: session.sourceExecutionSessionId,
      claimedAt: session.createdAt,
    });
    const initialAcquiredAt = Date.now();
    const initial = {
      loopSessionId: session.id,
      sessionVersion: session.updatedAt,
      workerId: "worker-heartbeat",
      acquiredAt: new Date(initialAcquiredAt).toISOString(),
      expiresAt: new Date(initialAcquiredAt + 1_000).toISOString(),
    };
    await claimMangekyoWorkerLease(project.rootPath, project.id, initial, initial.acquiredAt);
    const owner = createMangekyoWorkerLeaseOwner({
      rootPath: project.rootPath,
      projectId: project.id,
      lease: initial,
      leaseDurationMs: 1_000,
      heartbeatIntervalMs: 250,
    });

    let durable = await loadMangekyoWorkerLease(project.rootPath, project.id);
    const heartbeatDeadline = Date.now() + 3_000;
    while (
      durable !== undefined &&
      Date.parse(durable.acquiredAt) < initialAcquiredAt + 1_250 &&
      Date.now() < heartbeatDeadline
    ) {
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
      durable = await loadMangekyoWorkerLease(project.rootPath, project.id);
    }
    expect(Date.parse(durable?.acquiredAt ?? "")).toBeGreaterThanOrEqual(
      initialAcquiredAt + 1_250,
    );
    const attemptedTakeoverAt = initialAcquiredAt + 1_300;
    const recoveryDuringLongWork = {
      ...initial,
      workerId: "worker-improper-takeover",
      acquiredAt: new Date(attemptedTakeoverAt).toISOString(),
      expiresAt: new Date(attemptedTakeoverAt + 1_000).toISOString(),
    };
    await expect(
      claimMangekyoWorkerLease(
        project.rootPath,
        project.id,
        recoveryDuringLongWork,
        recoveryDuringLongWork.acquiredAt,
      ),
    ).rejects.toThrow(/worker lease/i);
    await expect(loadMangekyoWorkerLease(project.rootPath, project.id)).resolves.toMatchObject({
      loopSessionId: session.id,
      workerId: initial.workerId,
    });

    await owner.close({ release: true });
    await expect(loadMangekyoWorkerLease(project.rootPath, project.id)).resolves.toBeUndefined();
    await new Promise<void>((resolve) => setTimeout(resolve, 1_100));
    await expect(loadMangekyoWorkerLease(project.rootPath, project.id)).resolves.toBeUndefined();
  });

  it("binds every owned persistence checkpoint to the exact durable session version", async () => {
    const project = await projectFixture();
    const session = sessionFixture(project.rootPath);
    await mkdir(join(project.rootPath, ".design-sharingan", "renders", session.id), {
      recursive: true,
    });
    await writeFile(
      session.initialRender?.imagePath as string,
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    );
    await saveMangekyoLoopSession(project.rootPath, session);
    await claimMangekyoActiveLoop(project.rootPath, project.id, {
      loopSessionId: session.id,
      sourceExecutionSessionId: session.sourceExecutionSessionId,
      claimedAt: session.createdAt,
    });
    const lease = {
      loopSessionId: session.id,
      sessionVersion: session.updatedAt,
      workerId: "worker-persistence-owner",
      acquiredAt: "2026-08-27T01:00:03.000Z",
      expiresAt: "2026-08-27T01:00:04.000Z",
    };
    await claimMangekyoWorkerLease(project.rootPath, project.id, lease, lease.acquiredAt);
    const owner = createMangekyoWorkerLeaseOwner({
      rootPath: project.rootPath,
      projectId: project.id,
      lease,
      leaseDurationMs: 1_000,
      heartbeatIntervalMs: 400,
      now: () => new Date("2026-08-27T01:00:03.500Z"),
    });
    const checkpoint = {
      ...session,
      updatedAt: "2026-08-27T01:00:03.250Z",
    };

    await owner.persist(checkpoint);
    await expect(
      loadMangekyoLoopSession(project.rootPath, project.id, session.id),
    ).resolves.toEqual(checkpoint);
    await expect(loadMangekyoWorkerLease(project.rootPath, project.id)).resolves.toMatchObject({
      loopSessionId: session.id,
      sessionVersion: checkpoint.updatedAt,
      workerId: lease.workerId,
    });
    await owner.close({ release: true });
  });

  it("aborts a replaced owner before persistence and clears its failing heartbeat", async () => {
    const project = await projectFixture();
    const session = sessionFixture(project.rootPath);
    await mkdir(join(project.rootPath, ".design-sharingan", "renders", session.id), {
      recursive: true,
    });
    await writeFile(
      session.initialRender?.imagePath as string,
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    );
    await saveMangekyoLoopSession(project.rootPath, session);
    await claimMangekyoActiveLoop(project.rootPath, project.id, {
      loopSessionId: session.id,
      sourceExecutionSessionId: session.sourceExecutionSessionId,
      claimedAt: session.createdAt,
    });
    const expired = {
      loopSessionId: session.id,
      sessionVersion: session.updatedAt,
      workerId: "worker-replaced-owner",
      acquiredAt: "2026-08-27T01:00:03.000Z",
      expiresAt: "2026-08-27T01:00:04.000Z",
    };
    await claimMangekyoWorkerLease(project.rootPath, project.id, expired, expired.acquiredAt);
    const owner = createMangekyoWorkerLeaseOwner({
      rootPath: project.rootPath,
      projectId: project.id,
      lease: expired,
      leaseDurationMs: 1_000,
      heartbeatIntervalMs: 500,
      now: () => new Date("2026-08-27T01:00:05.500Z"),
    });
    const replacement = {
      ...expired,
      workerId: "worker-new-owner",
      acquiredAt: "2026-08-27T01:00:05.000Z",
      expiresAt: "2026-08-27T01:00:06.000Z",
    };
    await claimMangekyoWorkerLease(
      project.rootPath,
      project.id,
      replacement,
      replacement.acquiredAt,
    );

    await expect(owner.assertOwnership(session.updatedAt)).rejects.toThrow(/live.*worker lease/i);
    await expect(owner.persist({
      ...session,
      updatedAt: "2026-08-27T01:00:05.750Z",
    })).rejects.toThrow(/live.*worker lease/i);
    await expect(
      loadMangekyoLoopSession(project.rootPath, project.id, session.id),
    ).resolves.toEqual(session);

    await releaseMangekyoWorkerLease(project.rootPath, project.id, replacement);
    await new Promise<void>((resolve) => setTimeout(resolve, 550));
    await expect(loadMangekyoWorkerLease(project.rootPath, project.id)).resolves.toBeUndefined();
    await expect(owner.close({ release: false })).rejects.toThrow(/live.*worker lease/i);
  });

  it.each(
    (["EDITING", "RUNNING", "CAPTURING", "COMPARING"] as const).flatMap((status) =>
      invalidInterruptedSessionEvidence.map((invalid) => ({ status, ...invalid }))
    ),
  )(
    "rejects $status interrupted checkpoints with $name policy evidence before persistence",
    async ({ status, mutate }) => {
      const project = await projectFixture();
      const interrupted = interruptedSessionFixture(project.rootPath, status);
      mutate(interrupted);

      expect(isMangekyoLoopSession(interrupted)).toBe(false);
      await expect(saveMangekyoLoopSession(project.rootPath, interrupted)).rejects.toThrow(
        /invalid Mangekyo loop/i,
      );
    },
  );

  it.each(
    (["EDITING", "RUNNING", "CAPTURING", "COMPARING"] as const).flatMap((status) =>
      claimRetainedPendingEvidence.map((invalid) => ({ status, ...invalid }))
    ),
  )(
    "retains exact worker and active-loop ownership when $status has $name recovery evidence",
    async ({ status, mutate }) => {
      const project = await projectFixture();
      const interrupted = interruptedSessionFixture(project.rootPath, status);
      await mkdir(join(project.rootPath, ".design-sharingan", "renders", interrupted.id), {
        recursive: true,
      });
      await writeFile(
        interrupted.initialRender?.imagePath as string,
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      );
      await saveMangekyoLoopSession(project.rootPath, interrupted);
      const activeClaim = {
        loopSessionId: interrupted.id,
        sourceExecutionSessionId: interrupted.sourceExecutionSessionId,
        claimedAt: interrupted.createdAt,
      };
      await claimMangekyoActiveLoop(project.rootPath, project.id, activeClaim);
      const lease = {
        loopSessionId: interrupted.id,
        sessionVersion: interrupted.updatedAt,
        workerId: `worker-ambiguous-${status.toLowerCase()}`,
        acquiredAt: "2026-08-27T01:00:04.000Z",
        expiresAt: "2026-08-27T01:00:05.000Z",
      };
      await claimMangekyoWorkerLease(project.rootPath, project.id, lease, lease.acquiredAt);
      const owner = createMangekyoWorkerLeaseOwner({
        rootPath: project.rootPath,
        projectId: project.id,
        lease,
        leaseDurationMs: 1_000,
        heartbeatIntervalMs: 400,
        now: () => new Date("2026-08-27T01:00:04.500Z"),
      });
      const ambiguous = structuredClone(interrupted);
      mutate(ambiguous);

      await expect(owner.persist(ambiguous)).rejects.toThrow(/invalid Mangekyo loop/i);
      await expect(owner.close({ release: true })).rejects.toThrow(/invalid Mangekyo loop/i);
      await expect(loadMangekyoWorkerLease(project.rootPath, project.id)).resolves.toMatchObject({
        loopSessionId: interrupted.id,
        sessionVersion: interrupted.updatedAt,
        workerId: lease.workerId,
      });
      await expect(loadMangekyoActiveLoopClaim(project.rootPath, project.id)).resolves.toEqual(
        activeClaim,
      );
      await expect(
        loadMangekyoLoopSession(project.rootPath, project.id, interrupted.id),
      ).resolves.toEqual(interrupted);
    },
  );

  it.each([
    "EDITING",
    "RUNNING",
    "CAPTURING",
    "COMPARING",
  ] as const)(
    "lets one exact replacement owner persist and reload truthful %s reconciliation before lease cleanup",
    async (status) => {
      const project = await projectFixture();
      const interrupted = interruptedSessionFixture(project.rootPath, status);
      await mkdir(join(project.rootPath, ".design-sharingan", "renders", interrupted.id), {
        recursive: true,
      });
      await writeFile(
        interrupted.initialRender?.imagePath as string,
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      );
      await saveMangekyoLoopSession(project.rootPath, interrupted);
      await claimMangekyoActiveLoop(project.rootPath, project.id, {
        loopSessionId: interrupted.id,
        sourceExecutionSessionId: interrupted.sourceExecutionSessionId,
        claimedAt: interrupted.createdAt,
      });
      const expired = {
        loopSessionId: interrupted.id,
        sessionVersion: interrupted.updatedAt,
        workerId: `worker-dead-${status.toLowerCase()}`,
        acquiredAt: "2026-08-27T01:00:04.000Z",
        expiresAt: "2026-08-27T01:00:05.000Z",
      };
      await claimMangekyoWorkerLease(project.rootPath, project.id, expired, expired.acquiredAt);
      const replacement = {
        ...expired,
        workerId: `worker-replacement-${status.toLowerCase()}`,
        acquiredAt: "2026-08-27T01:00:06.000Z",
        expiresAt: "2026-08-27T01:00:07.000Z",
      };
      await claimMangekyoWorkerLease(
        project.rootPath,
        project.id,
        replacement,
        replacement.acquiredAt,
      );
      await expect(claimMangekyoWorkerLease(
        project.rootPath,
        project.id,
        replacement,
        replacement.acquiredAt,
      )).resolves.toBeUndefined();
      const duplicateTakeover = {
        ...replacement,
        workerId: `worker-duplicate-${status.toLowerCase()}`,
        acquiredAt: "2026-08-27T01:00:06.250Z",
        expiresAt: "2026-08-27T01:00:07.250Z",
      };
      await expect(claimMangekyoWorkerLease(
        project.rootPath,
        project.id,
        duplicateTakeover,
        duplicateTakeover.acquiredAt,
      )).rejects.toThrow(/live.*worker lease/i);

      const owner = createMangekyoWorkerLeaseOwner({
        rootPath: project.rootPath,
        projectId: project.id,
        lease: replacement,
        leaseDurationMs: 1_000,
        heartbeatIntervalMs: 400,
        now: () => new Date("2026-08-27T01:00:06.500Z"),
      });
      const failed: MangekyoLoopSession = {
        ...interrupted,
        status: "FAILED",
        updatedAt: "2026-08-27T01:00:06.750Z",
        stopReason: `${status} recovery cannot safely resume: the mutation may have changed target bytes, but exact post-mutation source evidence was not durably linked. Reconcile the recorded affected paths before another change.`,
        mutationFailure: {
          targetDisposition: "RECONCILIATION_REQUIRED",
          affectedPaths: ["server.mjs"],
        },
      };

      await owner.persist(failed);
      await expect(
        loadMangekyoLoopSession(project.rootPath, project.id, interrupted.id),
      ).resolves.toEqual(failed);
      await owner.close({ release: true });
      await expect(loadMangekyoWorkerLease(
        project.rootPath,
        project.id,
      )).resolves.toBeUndefined();
      await releaseMangekyoActiveLoop(project.rootPath, project.id, {
        loopSessionId: failed.id,
        sourceExecutionSessionId: failed.sourceExecutionSessionId,
        claimedAt: failed.createdAt,
        terminalStatus: "FAILED",
      });
      await expect(loadMangekyoActiveLoopClaim(
        project.rootPath,
        project.id,
      )).resolves.toBeUndefined();
    },
  );

  it("retains replacement ownership when the interrupted recovery checkpoint cannot be durably validated", async () => {
    const project = await projectFixture();
    const interrupted = interruptedSessionFixture(project.rootPath, "EDITING");
    await mkdir(join(project.rootPath, ".design-sharingan", "renders", interrupted.id), {
      recursive: true,
    });
    await writeFile(
      interrupted.initialRender?.imagePath as string,
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    );
    await saveMangekyoLoopSession(project.rootPath, interrupted);
    await claimMangekyoActiveLoop(project.rootPath, project.id, {
      loopSessionId: interrupted.id,
      sourceExecutionSessionId: interrupted.sourceExecutionSessionId,
      claimedAt: interrupted.createdAt,
    });
    const expired = {
      loopSessionId: interrupted.id,
      sessionVersion: interrupted.updatedAt,
      workerId: "worker-dead-ambiguous",
      acquiredAt: "2026-08-27T01:00:04.000Z",
      expiresAt: "2026-08-27T01:00:05.000Z",
    };
    await claimMangekyoWorkerLease(project.rootPath, project.id, expired, expired.acquiredAt);
    const replacement = {
      ...expired,
      workerId: "worker-replacement-ambiguous",
      acquiredAt: "2026-08-27T01:00:06.000Z",
      expiresAt: "2026-08-27T01:00:07.000Z",
    };
    await claimMangekyoWorkerLease(
      project.rootPath,
      project.id,
      replacement,
      replacement.acquiredAt,
    );
    const owner = createMangekyoWorkerLeaseOwner({
      rootPath: project.rootPath,
      projectId: project.id,
      lease: replacement,
      leaseDurationMs: 1_000,
      heartbeatIntervalMs: 400,
      now: () => new Date("2026-08-27T01:00:06.500Z"),
    });
    const invalidFailure: MangekyoLoopSession = {
      ...interrupted,
      status: "FAILED",
      updatedAt: "2026-08-27T01:00:06.750Z",
      mutationFailure: {
        targetDisposition: "RECONCILIATION_REQUIRED",
        affectedPaths: ["server.mjs"],
      },
    };

    await expect(owner.persist(invalidFailure)).rejects.toThrow(/invalid Mangekyo loop/i);
    await expect(owner.close({ release: true })).rejects.toThrow(/invalid Mangekyo loop/i);
    await expect(
      loadMangekyoLoopSession(project.rootPath, project.id, interrupted.id),
    ).resolves.toEqual(interrupted);
    await expect(loadMangekyoWorkerLease(
      project.rootPath,
      project.id,
    )).resolves.toMatchObject({ workerId: replacement.workerId });
  });

  it("rejects interrupted recovery evidence that names paths outside the exact pending policy change", async () => {
    const project = await projectFixture();
    const interrupted = interruptedSessionFixture(project.rootPath, "RUNNING");
    await mkdir(join(project.rootPath, ".design-sharingan", "renders", interrupted.id), {
      recursive: true,
    });
    await writeFile(
      interrupted.initialRender?.imagePath as string,
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    );
    const tampered: MangekyoLoopSession = {
      ...interrupted,
      status: "FAILED",
      updatedAt: "2026-08-27T01:00:04.000Z",
      stopReason: "Interrupted mutation requires reconciliation.",
      mutationFailure: {
        targetDisposition: "RECONCILIATION_REQUIRED",
        affectedPaths: ["unrelated.css"],
      },
    };

    expect(isMangekyoLoopSession(tampered)).toBe(false);
    await expect(saveMangekyoLoopSession(project.rootPath, tampered)).rejects.toThrow(
      /invalid Mangekyo loop/i,
    );
  });

  it.each([
    "EDITING",
    "RUNNING",
    "CAPTURING",
    "COMPARING",
  ] as const)(
    "persists exact Stop-owned BLOCKED truth instead of %s recovery reconciliation",
    async (status) => {
      const project = await projectFixture();
      const interrupted = interruptedSessionFixture(project.rootPath, status);
      await mkdir(join(project.rootPath, ".design-sharingan", "renders", interrupted.id), {
        recursive: true,
      });
      await writeFile(
        interrupted.initialRender?.imagePath as string,
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      );
      await saveMangekyoLoopSession(project.rootPath, interrupted);
      await claimMangekyoActiveLoop(project.rootPath, project.id, {
        loopSessionId: interrupted.id,
        sourceExecutionSessionId: interrupted.sourceExecutionSessionId,
        claimedAt: interrupted.createdAt,
      });
      const expired = {
        loopSessionId: interrupted.id,
        sessionVersion: interrupted.updatedAt,
        workerId: `worker-stopped-dead-${status.toLowerCase()}`,
        acquiredAt: "2026-08-27T01:00:04.000Z",
        expiresAt: "2026-08-27T01:00:05.000Z",
      };
      await claimMangekyoWorkerLease(project.rootPath, project.id, expired, expired.acquiredAt);
      const stopRequest = await requestMangekyoStop(project.rootPath, project.id, {
        id: `stop-interrupted-${status.toLowerCase()}`,
        loopSessionId: interrupted.id,
        sessionVersion: interrupted.updatedAt,
        requestedAt: "2026-08-27T01:00:05.500Z",
        requestedBy: "local-user",
      });
      const replacement = {
        ...expired,
        workerId: `worker-stopped-replacement-${status.toLowerCase()}`,
        acquiredAt: "2026-08-27T01:00:06.000Z",
        expiresAt: "2026-08-27T01:00:07.000Z",
      };
      await claimMangekyoWorkerLease(
        project.rootPath,
        project.id,
        replacement,
        replacement.acquiredAt,
      );
      const owner = createMangekyoWorkerLeaseOwner({
        rootPath: project.rootPath,
        projectId: project.id,
        lease: replacement,
        leaseDurationMs: 1_000,
        heartbeatIntervalMs: 400,
        now: () => new Date("2026-08-27T01:00:06.500Z"),
      });
      const blocked: MangekyoLoopSession = {
        ...interrupted,
        status: "BLOCKED",
        updatedAt: "2026-08-27T01:00:06.750Z",
        stopRequest,
        stopReason: "The user stopped the visual loop before interrupted recovery.",
      };

      await owner.persist(blocked);
      await expect(
        loadMangekyoLoopSession(project.rootPath, project.id, interrupted.id),
      ).resolves.toEqual(blocked);
      expect(blocked.mutationFailure).toBeUndefined();
      expect(blocked.finalRender).toBeUndefined();
      await owner.close({ release: true });
      await expect(loadMangekyoWorkerLease(
        project.rootPath,
        project.id,
      )).resolves.toBeUndefined();
    },
  );

  it("durably and immutably consumes one exact Approve Once authorization", async () => {
    const project = await projectFixture();
    const claim = {
      loopSessionId: "mangekyo-1",
      sessionVersion: "2026-08-27T01:00:03.000Z",
      gateId: "gate-1",
      decisionId: "decision-approve",
      proposalId: "proposal-navigation",
    };

    await expect(
      consumeMangekyoApproveOnceAuthorization(project.rootPath, project.id, claim),
    ).resolves.toBeUndefined();
    await expect(
      consumeMangekyoApproveOnceAuthorization(project.rootPath, project.id, claim),
    ).rejects.toThrow(/already consumed/i);
  });

  it("round-trips only an exact project-scoped autonomous policy authorization", async () => {
    const project = await projectFixture();
    const authorization = {
      kind: "AUTONOMOUS_POLICY_ALLOW",
      id: "authorization-1",
      loopSessionId: "mangekyo-1",
      proposalId: "proposal-style",
      proposalThreadId: "thread-style",
      change: { kind: "STYLE_CHANGE", files: ["styles.css"] },
      policy: DEFAULT_AUTONOMY_POLICY,
      evaluation: { decision: "ALLOW", reasons: [] },
      evaluatedAt: "2026-08-27T01:00:00.000Z",
      expiresAt: "2026-08-27T01:05:00.000Z",
    };

    await saveMangekyoAuthorization(project.rootPath, project.id, authorization);

    await expect(
      loadMangekyoAuthorization(project.rootPath, project.id, authorization.id),
    ).resolves.toEqual(authorization);
    await expect(
      saveMangekyoAuthorization(project.rootPath, project.id, {
        ...authorization,
        undeclaredPrivilege: true,
      }),
    ).rejects.toThrow(/authorization/i);
  });

  it("round-trips a bounded project-scoped loop with policy and HUMAN_GATE evidence", async () => {
    const project = await projectFixture();
    const session = sessionFixture(project.rootPath);
    await mkdir(join(project.rootPath, ".design-sharingan", "renders", "mangekyo-1"), {
      recursive: true,
    });
    await writeFile(session.initialRender?.imagePath as string, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));

    await saveMangekyoLoopSession(project.rootPath, session);

    await expect(loadMangekyoLoopSession(project.rootPath, project.id, session.id)).resolves.toEqual(session);
  });

  it("serves one authenticated binary when the same render is linked by loop checkpoints", async () => {
    const project = await projectFixture();
    const session = completeSessionFixture(project.rootPath);
    await mkdir(join(project.rootPath, ".design-sharingan", "renders", "mangekyo-1"), {
      recursive: true,
    });
    const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    await writeFile(session.initialRender?.imagePath as string, bytes);
    await writeFile(session.finalRender?.imagePath as string, bytes);
    await saveMangekyoLoopSession(project.rootPath, session);

    await expect(
      loadMangekyoRenderImage(project.rootPath, project.id, "render-1"),
    ).resolves.toEqual({ bytes: Buffer.from(pngBytes()), type: "image/png" });
  });

  it("rejects a tampered loop record with undeclared payload before it can authorize another round", async () => {
    const project = await projectFixture();
    const session = sessionFixture(project.rootPath);
    await mkdir(join(project.rootPath, ".design-sharingan", "renders", "mangekyo-1"), {
      recursive: true,
    });
    await writeFile(session.initialRender?.imagePath as string, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    await saveMangekyoLoopSession(project.rootPath, session);
    const recordPath = join(
      project.rootPath,
      ".design-sharingan",
      "sessions",
      `${session.id}.json`,
    );
    const record = JSON.parse(await readFile(recordPath, "utf8")) as Record<string, unknown>;
    await writeFile(recordPath, `${JSON.stringify({ ...record, allowEverything: true })}\n`, "utf8");

    await expect(
      loadMangekyoLoopSession(project.rootPath, project.id, session.id),
    ).rejects.toThrow(/invalid mangekyo loop|committed journal pair/i);
  });
});
