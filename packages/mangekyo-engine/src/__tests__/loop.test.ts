import type {
  AutonomyChange,
  ChangeProposal,
  MangekyoLoopSession,
  RenderArtifact,
  VisualFinding,
} from "@design-sharingan/core";
import { DEFAULT_AUTONOMY_POLICY } from "@design-sharingan/core";
import { describe, expect, it } from "vitest";

import {
  isFreshFinalRender,
  resolveHumanGate,
  runMangekyoLoop,
  type MangekyoLoopDependencies,
  type ProposedVisualChange,
} from "../loop";

function artifact(
  overrides: Partial<RenderArtifact> = {},
): RenderArtifact {
  return {
    id: "render-initial",
    sessionId: "mangekyo-1",
    roundId: "initial",
    route: "/",
    viewport: "desktop",
    viewportWidth: 1280,
    viewportHeight: 720,
    imagePath: "/project/.design-sharingan/renders/initial.png",
    capturedAt: "2026-08-27T01:00:00.000Z",
    sourceRevision: {
      kind: "GIT",
      available: true,
      head: "a".repeat(40),
      branch: "fixture",
      status: "CLEAN",
      entries: [],
      truncated: false,
      worktreeFingerprint: "a".repeat(64),
      fileCount: 2,
    },
    ...overrides,
  };
}

function sessionFixture(): MangekyoLoopSession {
  return {
    id: "mangekyo-1",
    projectId: "project-1",
    type: "MANGEKYO_LOOP",
    status: "IDLE",
    createdAt: "2026-08-27T01:00:00.000Z",
    updatedAt: "2026-08-27T01:00:00.000Z",
    sourceExecutionSessionId: "safe-session-1",
    sourceDesignSessionId: "evolve-session-1",
    approvedApproachId: "approach-1",
    directionApprovalId: "approval-1",
    approvedDirection: "Strengthen hierarchy while preserving navigation.",
    initialPolicy: DEFAULT_AUTONOMY_POLICY,
    policy: DEFAULT_AUTONOMY_POLICY,
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
    policyEvaluations: [],
    gates: [],
    gateDecisions: [],
    initialRender: artifact(),
  };
}

function proposal(
  id: string,
  files: string[],
  summary: string,
): ChangeProposal {
  return {
    id,
    sessionId: "mangekyo-1",
    summary,
    reason: summary,
    filesToCreate: [],
    filesToModify: files,
    filesToDelete: [],
    componentsAffected: ["Fixture"],
    screensAffected: ["/"],
    uxImpact: [
      {
        area: "Fixture",
        severity: "IMPORTANT",
        reason: summary,
        affectedRoutes: ["/"],
        affectedComponents: ["Fixture"],
        decisionRequired: false,
      },
    ],
    visualImpact: summary,
    riskLevel: "LOW",
    requiresHumanApproval: true,
    policyViolations: [],
    status: "PROPOSED",
  };
}

function proposedChange(
  round: number,
  change: AutonomyChange,
): ProposedVisualChange {
  const navigation = change.kind === "NAVIGATION_CHANGE";
  return {
    proposal: proposal(
      navigation ? "proposal-navigation" : `proposal-style-${round}`,
      [...change.files],
      navigation ? "Replace the primary navigation" : "Strengthen hero hierarchy",
    ),
    proposalThreadId: navigation ? "thread-navigation" : `thread-style-${round}`,
    change,
    objective: navigation ? "Replace primary navigation" : "Restore hero hierarchy",
    affectedScope: ["/", navigation ? "Navigation" : "Hero"],
    impact: navigation
      ? "Changes how users move through the product."
      : "Strengthens the existing hierarchy without behavior changes.",
  };
}

const importantFindings: VisualFinding[] = Array.from({ length: 3 }, (_, index) => ({
  id: `finding-${index}`,
  severity: "IMPORTANT",
  category: "HIERARCHY",
  screen: "/",
  description: `Hierarchy finding ${index}`,
  evidence: ["Rendered heading lacks dominance."],
  reason: "The approved direction requires one dominant heading.",
  recommendedAction: "Increase heading emphasis.",
  status: "OPEN",
}));

function harness(
  changes: ProposedVisualChange[],
  analyses: VisualFinding[][],
): {
  dependencies: MangekyoLoopDependencies;
  trace: string[];
  executeCalls: Array<{ authorization: string; proposalId: string }>;
  saved: () => MangekyoLoopSession | undefined;
} {
  let savedSession: MangekyoLoopSession | undefined;
  let id = 0;
  let nowTick = 0;
  const trace: string[] = [];
  const executeCalls: Array<{ authorization: string; proposalId: string }> = [];
  const dependencies: MangekyoLoopDependencies = {
    createId: () => `loop-id-${++id}`,
    now: () => new Date(Date.parse("2026-08-27T01:00:01.000Z") + nowTick++ * 1_000),
    proposeChange: async (_session, round) => {
      trace.push(`propose:${round}`);
      const next = changes.shift();
      if (next === undefined) throw new Error("No proposed change fixture");
      return next;
    },
    persist: async (session) => {
      trace.push(`persist:${session.status}`);
      savedSession = structuredClone(session);
    },
    load: async () => structuredClone(savedSession),
    executeChange: async ({ proposal: pending, authorization }) => {
      trace.push(`execute:${pending.id}`);
      executeCalls.push({ authorization: authorization.kind, proposalId: pending.id });
      return {
        proposalId: pending.id,
        threadId:
          pending.id === "proposal-navigation" ? "thread-navigation" : "thread-style-1",
        filesChanged: [...pending.filesToModify],
        completedAt: "2026-08-27T01:00:04.000Z",
      };
    },
    runProject: async ({ roundNumber }) => {
      trace.push(`run:${roundNumber}`);
    },
    capture: async ({ session, roundNumber, mutation }) => {
      trace.push(`capture:${roundNumber}`);
      return artifact({
        id: `render-${roundNumber}`,
        roundId: `round-${roundNumber}`,
        imagePath: `/project/.design-sharingan/renders/round-${roundNumber}.png`,
        capturedAt: "2026-08-27T01:00:05.000Z",
        sourceRevision: {
          kind: "GIT",
          available: true,
          head: "a".repeat(40),
          branch: "fixture",
          status: "DIRTY",
          entries: mutation.filesChanged.map((path) => ({
            index: " ",
            workingTree: "M",
            path,
          })),
          truncated: false,
          worktreeFingerprint: String(roundNumber).repeat(64),
          fileCount: 2,
        },
        route: session.renderTarget.route,
        viewport: session.renderTarget.viewport.name,
      });
    },
    analyze: async ({ roundNumber }) => {
      trace.push(`analyze:${roundNumber}`);
      return {
        threadId: `visual-thread-${roundNumber}`,
        findings: analyses.shift() ?? [],
      };
    },
  };
  return { dependencies, trace, executeCalls, saved: () => savedSession };
}

describe("Mangekyo loop", () => {
  // Production break caught: skipping a policy check or applying a gate-bound change would alter navigation before human authorization.
  it("applies an allowed style round, then persists HUMAN_GATE before a navigation mutation", async () => {
    const { dependencies, trace, executeCalls } = harness(
      [
        proposedChange(1, { kind: "STYLE_CHANGE", files: ["server.mjs"] }),
        proposedChange(2, { kind: "NAVIGATION_CHANGE", files: ["server.mjs"] }),
      ],
      [importantFindings],
    );

    const result = await runMangekyoLoop(sessionFixture(), dependencies);

    expect(result.status).toBe("HUMAN_GATE");
    expect(result.rounds).toHaveLength(1);
    expect(result.currentGate).toMatchObject({
      requestedChange: { kind: "NAVIGATION_CHANGE", files: ["server.mjs"] },
      proposal: { id: "proposal-navigation" },
      reasons: expect.arrayContaining([expect.stringMatching(/navigation_change/i)]),
      affectedScope: ["/", "Navigation"],
      impact: "Changes how users move through the product.",
    });
    expect(executeCalls).toEqual([
      { authorization: "POLICY_ALLOW", proposalId: "proposal-style-1" },
    ]);
    expect(trace.indexOf("persist:POLICY_CHECK")).toBeLessThan(
      trace.indexOf("execute:proposal-style-1"),
    );
    expect(trace).not.toContain("execute:proposal-navigation");
    expect(trace).not.toContain("capture:2");
  });

  it("completes only from a route, viewport, source, and timestamp-matching final capture", async () => {
    const { dependencies } = harness(
      [proposedChange(1, { kind: "STYLE_CHANGE", files: ["server.mjs"] })],
      [[]],
    );

    const result = await runMangekyoLoop(sessionFixture(), dependencies);

    expect(result).toMatchObject({ status: "COMPLETE", inspectedScreens: ["/"] });
    expect(result.finalRender?.id).toBe("render-1");
    expect(result.rounds[0]?.round.afterRender?.sourceRevision).toMatchObject({
      kind: "GIT",
      worktreeFingerprint: "1".repeat(64),
    });
  });

  it("rejects a render that is not newer than the final mutation or omits a changed path", () => {
    const session = sessionFixture();
    const baseInput = {
      artifact: artifact({
        id: "render-final",
        roundId: "round-1",
        capturedAt: "2026-08-27T01:00:04.000Z",
        sourceRevision: {
          kind: "GIT" as const,
          available: true as const,
          head: "a".repeat(40),
          branch: "fixture",
          status: "DIRTY" as const,
          entries: [{ index: " ", workingTree: "M", path: "server.mjs" }],
          truncated: false,
          worktreeFingerprint: "b".repeat(64),
          fileCount: 2,
        },
      }),
      mutationCompletedAt: "2026-08-27T01:00:04.000Z",
      changedPaths: ["server.mjs"],
      target: session.renderTarget,
    };
    expect(isFreshFinalRender(baseInput)).toBe(false);
    expect(
      isFreshFinalRender({
        ...baseInput,
        artifact: artifact({
          ...baseInput.artifact,
          capturedAt: "2026-08-27T01:00:05.000Z",
          sourceRevision: {
            ...baseInput.artifact.sourceRevision,
            entries: [],
          } as RenderArtifact["sourceRevision"],
        }),
      }),
    ).toBe(false);
  });

  it("fails closed when the reloaded policy checkpoint is missing or tampered", async () => {
    const { dependencies, executeCalls } = harness(
      [proposedChange(1, { kind: "STYLE_CHANGE", files: ["server.mjs"] })],
      [[]],
    );
    const realLoad = dependencies.load;
    dependencies.load = async (sessionId) => {
      const persisted = await realLoad(sessionId);
      if (persisted === undefined) return undefined;
      return {
        ...persisted,
        policyEvaluations: persisted.policyEvaluations.map((entry) => ({
          ...entry,
          proposalId: "tampered-proposal",
        })),
      };
    };

    await expect(runMangekyoLoop(sessionFixture(), dependencies)).rejects.toThrow(
      /persisted policy checkpoint/i,
    );
    expect(executeCalls).toHaveLength(0);
  });

  it("persists FAILED instead of leaving a stale activity state when fresh capture evidence fails", async () => {
    const { dependencies, saved } = harness(
      [proposedChange(1, { kind: "STYLE_CHANGE", files: ["server.mjs"] })],
      [[]],
    );
    dependencies.capture = async () => {
      throw new Error("Browser capture did not return authenticated PNG evidence");
    };

    const result = await runMangekyoLoop(sessionFixture(), dependencies);

    expect(result).toMatchObject({
      status: "FAILED",
      stopReason: expect.stringMatching(/capture.*evidence/i),
    });
    expect(saved()).toMatchObject({ status: "FAILED" });
  });

  it("Reject blocks the pending gate without executing it", async () => {
    const { dependencies, executeCalls } = harness([], []);
    const gated = sessionFixture();
    gated.status = "HUMAN_GATE";
    gated.currentGate = {
      id: "gate-1",
      roundNumber: 1,
      requestedChange: { kind: "NAVIGATION_CHANGE", files: ["server.mjs"] },
      proposal: proposedChange(1, {
        kind: "NAVIGATION_CHANGE",
        files: ["server.mjs"],
      }).proposal,
      proposalThreadId: "thread-navigation",
      policyEvaluationId: "policy-navigation",
      requestedAt: "2026-08-27T01:00:01.000Z",
      reasons: ["Navigation changes are disabled."],
      affectedScope: ["/", "Navigation"],
      impact: "Changes navigation.",
    };
    gated.policyEvaluations = [
      {
        id: "policy-navigation",
        roundNumber: 1,
        proposalId: "proposal-navigation",
        change: gated.currentGate.requestedChange,
        policy: gated.policy,
        evaluation: { decision: "HUMAN_GATE", reasons: ["Navigation changes are disabled."] },
        evaluatedAt: "2026-08-27T01:00:01.000Z",
      },
    ];

    const result = await resolveHumanGate(
      gated,
      { decision: "REJECT", decidedBy: "local-user", comment: "Keep navigation." },
      dependencies,
    );

    expect(result).toMatchObject({ status: "BLOCKED", currentGate: undefined });
    expect(result.gateDecisions).toMatchObject([{ decision: "REJECT", gateId: "gate-1" }]);
    expect(executeCalls).toHaveLength(0);
  });

  it("Approve Once authorizes only the exact pending change and records that one-use decision", async () => {
    const { dependencies, executeCalls } = harness([], [[]]);
    const gated = sessionFixture();
    gated.status = "HUMAN_GATE";
    const pending = proposedChange(1, {
      kind: "NAVIGATION_CHANGE",
      files: ["server.mjs"],
    });
    gated.currentGate = {
      id: "gate-1",
      roundNumber: 1,
      requestedChange: pending.change,
      proposal: pending.proposal,
      proposalThreadId: pending.proposalThreadId,
      policyEvaluationId: "policy-navigation",
      requestedAt: "2026-08-27T01:00:01.000Z",
      reasons: ["Navigation changes are disabled."],
      affectedScope: pending.affectedScope,
      impact: pending.impact,
    };
    gated.policyEvaluations = [
      {
        id: "policy-navigation",
        roundNumber: 1,
        proposalId: pending.proposal.id,
        change: pending.change,
        policy: gated.policy,
        evaluation: { decision: "HUMAN_GATE", reasons: ["Navigation changes are disabled."] },
        evaluatedAt: "2026-08-27T01:00:01.000Z",
      },
    ];

    const result = await resolveHumanGate(
      gated,
      { decision: "APPROVE_ONCE", decidedBy: "local-user" },
      dependencies,
    );

    expect(executeCalls).toEqual([
      { authorization: "APPROVE_ONCE", proposalId: "proposal-navigation" },
    ]);
    expect(result.policy.allowNavigationChanges).toBe(false);
    expect(result.gateDecisions).toMatchObject([
      { decision: "APPROVE_ONCE", gateId: "gate-1" },
    ]);
    expect((result as unknown as { gates?: unknown[] }).gates).toMatchObject([
      { id: "gate-1", proposal: { id: "proposal-navigation" } },
    ]);
    expect(
      (result.rounds[0] as unknown as { gateDecisionId?: string }).gateDecisionId,
    ).toBe(result.gateDecisions[0]?.id);
  });

  it("Expand Scope changes only the explicit loop-session policy before reevaluating the pending change", async () => {
    const { dependencies, executeCalls } = harness([], [[]]);
    const gated = sessionFixture();
    gated.status = "HUMAN_GATE";
    const pending = proposedChange(1, {
      kind: "NAVIGATION_CHANGE",
      files: ["server.mjs"],
    });
    gated.currentGate = {
      id: "gate-1",
      roundNumber: 1,
      requestedChange: pending.change,
      proposal: pending.proposal,
      proposalThreadId: pending.proposalThreadId,
      policyEvaluationId: "policy-navigation",
      requestedAt: "2026-08-27T01:00:01.000Z",
      reasons: ["Navigation changes are disabled."],
      affectedScope: pending.affectedScope,
      impact: pending.impact,
    };
    gated.policyEvaluations = [
      {
        id: "policy-navigation",
        roundNumber: 1,
        proposalId: pending.proposal.id,
        change: pending.change,
        policy: gated.policy,
        evaluation: { decision: "HUMAN_GATE", reasons: ["Navigation changes are disabled."] },
        evaluatedAt: "2026-08-27T01:00:01.000Z",
      },
    ];

    const result = await resolveHumanGate(
      gated,
      {
        decision: "EXPAND_SCOPE",
        decidedBy: "local-user",
        expandKind: "NAVIGATION_CHANGE",
      },
      dependencies,
    );

    expect(result.initialPolicy.allowNavigationChanges).toBe(false);
    expect(result.policy.allowNavigationChanges).toBe(true);
    expect(executeCalls).toEqual([
      { authorization: "POLICY_ALLOW", proposalId: "proposal-navigation" },
    ]);
    expect(result.gateDecisions[0]).toMatchObject({
      decision: "EXPAND_SCOPE",
      policyAfter: { allowNavigationChanges: true },
    });
  });
});
