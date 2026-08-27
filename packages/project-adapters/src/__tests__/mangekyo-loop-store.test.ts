import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MangekyoLoopSession, Project, RenderArtifact } from "@design-sharingan/core";
import { DEFAULT_AUTONOMY_POLICY } from "@design-sharingan/core";
import { afterEach, describe, expect, it } from "vitest";

import {
  loadMangekyoAuthorization,
  loadMangekyoLoopSession,
  loadMangekyoRenderImage,
  saveMangekyoAuthorization,
  saveMangekyoLoopSession,
} from "../mangekyo-loop-store";
import { ensureDesignWorkspace, saveProjectMetadata } from "../workspace-store";

const roots: string[] = [];

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
    },
  };
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
    inspectedScreens: ["/"],
    rounds: [],
    policyEvaluations: [
      {
        id: "policy-evaluation-1",
        roundNumber: 2,
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
      roundNumber: 2,
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

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("Mangekyo loop persistence", () => {
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
    const session = sessionFixture(project.rootPath);
    session.finalRender = structuredClone(session.initialRender);
    await mkdir(join(project.rootPath, ".design-sharingan", "renders", "mangekyo-1"), {
      recursive: true,
    });
    const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    await writeFile(session.initialRender?.imagePath as string, bytes);
    await saveMangekyoLoopSession(project.rootPath, session);

    await expect(
      loadMangekyoRenderImage(project.rootPath, project.id, "render-1"),
    ).resolves.toEqual({ bytes, type: "image/png" });
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
    ).rejects.toThrow(/invalid mangekyo loop/i);
  });
});
