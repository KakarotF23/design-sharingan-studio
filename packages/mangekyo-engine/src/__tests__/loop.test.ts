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
      requiredPathEvidence: [],
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

type InterruptedStatus = "EDITING" | "RUNNING" | "CAPTURING" | "COMPARING";

function interruptedCheckpoint(status: InterruptedStatus): MangekyoLoopSession {
  const checkpoint = sessionFixture();
  checkpoint.status = status;
  checkpoint.updatedAt = "2026-08-27T01:00:01.000Z";
  checkpoint.policyEvaluations = [{
    id: "policy-recovery-1",
    roundNumber: 1,
    proposalId: "proposal-recovery-1",
    change: { kind: "STYLE_CHANGE", files: ["styles.css"] },
    policy: checkpoint.policy,
    evaluation: { decision: "ALLOW", reasons: [] },
    evaluatedAt: checkpoint.updatedAt,
  }];
  return checkpoint;
}

const invalidInterruptedEvidence = [
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
      if (latest !== undefined) latest.change.files = ["styles.css", "styles.css"];
    },
  },
  {
    name: "duplicate current evaluation",
    mutate: (session: MangekyoLoopSession) => {
      const latest = session.policyEvaluations.at(-1);
      if (latest !== undefined) {
        session.policyEvaluations.push({ ...structuredClone(latest), id: "policy-recovery-2" });
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
] as const;

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
    claimGateDecision: async () => undefined,
    loadStopRequest: async () => undefined,
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
    commitTerminalTransition: async ({ session }) => {
      trace.push(`persist:${session.status}`);
      savedSession = structuredClone(session);
      return { outcome: "COMMITTED", session: structuredClone(session) };
    },
    executeChange: async ({ session, proposal: pending, authorization }) => {
      trace.push(`execute:${pending.id}`);
      executeCalls.push({ authorization: authorization.kind, proposalId: pending.id });
      return {
        proposalId: pending.id,
        threadId:
          pending.id === "proposal-navigation" ? "thread-navigation" : "thread-style-1",
        filesChanged: [...pending.filesToModify],
        completedAt: "2026-08-27T01:00:04.000Z",
        sourceRevision: {
          kind: "GIT",
          available: true,
          head: "a".repeat(40),
          branch: "fixture",
          status: "DIRTY",
          entries: pending.filesToModify.map((path) => ({
            index: " ",
            workingTree: "M",
            path,
          })),
          truncated: false,
          worktreeFingerprint: String(session.rounds.length + 1).repeat(64),
          fileCount: 2,
          requiredPathEvidence: pending.filesToModify.map((path) => ({
            path,
            state: "FILE" as const,
            mode: 0o644,
            size: 9,
            contentHash: "e".repeat(64),
          })),
        },
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
          requiredPathEvidence: mutation.filesChanged.map((path) => ({
            path,
            state: "FILE" as const,
            mode: 0o644,
            size: 9,
            contentHash: "e".repeat(64),
          })),
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
        verification: {
          uxIntegrity: { status: "PASS", evidence: ["UX behavior remains intact."] },
          productConsistency: { status: "PASS", evidence: ["Product patterns remain consistent."] },
          accessibility: { status: "PASS", evidence: ["No accessibility regression is visible."] },
          genomeIntegrity: { status: "PASS", evidence: ["Authenticated Genome fixture remains intact."] },
        },
        genomeEvidenceVersion: "1",
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

  it("lets an exact same-version durable Stop win after the final Stop read but before terminal commit", async () => {
    const { dependencies } = harness(
      [proposedChange(1, { kind: "STYLE_CHANGE", files: ["server.mjs"] })],
      [[]],
    );
    let terminalAttempts = 0;
    Object.assign(dependencies, {
      commitTerminalTransition: async (input: {
        expectedVersion: string;
        session: MangekyoLoopSession;
      }) => {
        terminalAttempts += 1;
        return {
          outcome: "STOP_WON" as const,
          stopRequest: {
            id: "stop-final-race",
            loopSessionId: input.session.id,
            sessionVersion: input.expectedVersion,
            requestedAt: "2026-08-27T01:00:20.000Z",
            requestedBy: "local-user",
          },
        };
      },
    });

    const result = await runMangekyoLoop(sessionFixture(), dependencies);

    expect(terminalAttempts).toBe(1);
    expect(result).toMatchObject({
      status: "BLOCKED",
      stopRequest: { id: "stop-final-race" },
    });
    expect(result.finalRender).toBeUndefined();
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
          requiredPathEvidence: [{
            path: "server.mjs",
            state: "FILE" as const,
            mode: 0o644,
            size: 9,
            contentHash: "e".repeat(64),
          }],
        },
      }),
      mutationCompletedAt: "2026-08-27T01:00:04.000Z",
      changedPaths: ["server.mjs"],
      mutationSourceRevision: {
        kind: "GIT" as const,
        available: true as const,
        head: "a".repeat(40),
        branch: "fixture",
        status: "DIRTY" as const,
        entries: [{ index: " ", workingTree: "M", path: "server.mjs" }],
        truncated: false,
        worktreeFingerprint: "b".repeat(64),
        fileCount: 2,
        requiredPathEvidence: [{
          path: "server.mjs",
          state: "FILE" as const,
          mode: 0o644,
          size: 9,
          contentHash: "e".repeat(64),
        }],
      },
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

  it("rejects a same-path render whose exact workspace fingerprint differs from the post-mutation snapshot", () => {
    const session = sessionFixture();
    const mutationSourceRevision = {
      kind: "GIT" as const,
      available: true as const,
      head: "a".repeat(40),
      branch: "fixture",
      status: "DIRTY" as const,
      entries: [{ index: " ", workingTree: "M", path: "server.mjs" }],
      truncated: false,
      worktreeFingerprint: "b".repeat(64),
      fileCount: 2,
      requiredPathEvidence: [{
        path: "server.mjs",
        state: "FILE" as const,
        mode: 0o644,
        size: 9,
        contentHash: "e".repeat(64),
      }],
    };

    expect(isFreshFinalRender({
      artifact: artifact({
        id: "render-reverted",
        capturedAt: "2026-08-27T01:00:05.000Z",
        sourceRevision: {
          ...mutationSourceRevision,
          worktreeFingerprint: "c".repeat(64),
        },
      }),
      mutationCompletedAt: "2026-08-27T01:00:04.000Z",
      mutationSourceRevision,
      changedPaths: ["server.mjs"],
      target: session.renderTarget,
    })).toBe(false);
  });

  it("accepts an exact authenticated unversioned Local Folder snapshot", () => {
    const session = sessionFixture();
    const mutationSourceRevision = {
      kind: "UNVERSIONED" as const,
      available: true as const,
      truncated: false as const,
      worktreeFingerprint: "d".repeat(64),
      fileCount: 2,
      requiredPathEvidence: [{
        path: "server.mjs",
        state: "FILE" as const,
        mode: 0o644,
        size: 9,
        contentHash: "e".repeat(64),
      }],
    };

    expect(isFreshFinalRender({
      artifact: artifact({
        id: "render-local",
        capturedAt: "2026-08-27T01:00:05.000Z",
        sourceRevision: mutationSourceRevision,
      }),
      mutationCompletedAt: "2026-08-27T01:00:04.000Z",
      mutationSourceRevision,
      changedPaths: ["server.mjs"],
      target: session.renderTarget,
    })).toBe(true);
  });

  it("rejects an unversioned final render that does not authenticate every changed path", () => {
    const session = sessionFixture();
    const uncoveredRevision = {
      kind: "UNVERSIONED" as const,
      available: true as const,
      truncated: false as const,
      worktreeFingerprint: "d".repeat(64),
      fileCount: 0,
      requiredPathEvidence: [],
    };

    expect(isFreshFinalRender({
      artifact: artifact({
        id: "render-uncovered-local",
        capturedAt: "2026-08-27T01:00:05.000Z",
        sourceRevision: uncoveredRevision,
      }),
      mutationCompletedAt: "2026-08-27T01:00:04.000Z",
      mutationSourceRevision: uncoveredRevision,
      changedPaths: ["dist/styles.css"],
      target: session.renderTarget,
    })).toBe(false);
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

  it("persists and reloads EDITING before the mutation phase begins", async () => {
    const { dependencies, saved } = harness(
      [proposedChange(1, { kind: "STYLE_CHANGE", files: ["server.mjs"] })],
      [[]],
    );
    const execute = dependencies.executeChange;
    let statusAtMutation: MangekyoLoopSession["status"] | undefined;
    dependencies.executeChange = async (input) => {
      statusAtMutation = saved()?.status;
      return execute(input);
    };

    const result = await runMangekyoLoop(sessionFixture(), dependencies);
    expect(result.status).toBe("COMPLETE");
    expect(statusAtMutation).toBe("EDITING");
  });

  it("persists the completed round in DECIDING before transition and resumes it after a crash", async () => {
    const { dependencies, saved } = harness(
      [proposedChange(1, { kind: "STYLE_CHANGE", files: ["server.mjs"] })],
      [[]],
    );
    const persist = dependencies.persist;
    let injected = false;
    dependencies.persist = async (session) => {
      await persist(session);
      if (!injected && session.status === "DECIDING") {
        injected = true;
        throw new Error("simulated crash after durable analysis evidence");
      }
    };

    await expect(runMangekyoLoop(sessionFixture(), dependencies)).rejects.toThrow(
      /simulated crash/i,
    );
    const checkpoint = saved();
    expect(checkpoint).toMatchObject({
      status: "DECIDING",
      rounds: [{ round: { status: "DECIDING", findingsAfter: [] } }],
    });

    dependencies.persist = persist;
    const resumed = await runMangekyoLoop(
      structuredClone(checkpoint as MangekyoLoopSession),
      dependencies,
    );
    expect(resumed).toMatchObject({ status: "COMPLETE", rounds: [{ round: { status: "COMPLETE" } }] });
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

  it("persists reconciliation-required truth when an authorized mutation outcome is indeterminate", async () => {
    const { dependencies, saved } = harness(
      [proposedChange(1, { kind: "STYLE_CHANGE", files: ["server.mjs"] })],
      [[]],
    );
    dependencies.executeChange = async () => {
      const error = new Error("Target bytes require reconciliation") as Error & {
        failure: { targetDisposition: string; affectedPaths: string[] };
      };
      error.failure = {
        targetDisposition: "RECONCILIATION_REQUIRED",
        affectedPaths: ["server.mjs"],
      };
      throw error;
    };

    const result = await runMangekyoLoop(sessionFixture(), dependencies);

    expect(result).toMatchObject({
      status: "FAILED",
      mutationFailure: {
        targetDisposition: "RECONCILIATION_REQUIRED",
        affectedPaths: ["server.mjs"],
      },
    });
    expect(saved()).toMatchObject({ mutationFailure: result.mutationFailure });
  });

  it("honors a durable Stop request across reload without proposing, mutating, or counterfeiting PASS", async () => {
    const { dependencies, trace, executeCalls, saved } = harness([], []);
    Object.assign(dependencies, {
      loadStopRequest: async () => ({
        id: "stop-request-1",
        loopSessionId: "mangekyo-1",
        sessionVersion: "2026-08-27T01:00:00.000Z",
        requestedAt: "2026-08-27T01:00:01.000Z",
        requestedBy: "local-user",
      }),
    });

    const stopped = await runMangekyoLoop(sessionFixture(), dependencies);
    expect(stopped).toMatchObject({
      status: "BLOCKED",
      stopRequest: { id: "stop-request-1", requestedBy: "local-user" },
      stopReason: expect.stringMatching(/user stopped/i),
    });
    expect(stopped.finalRender).toBeUndefined();
    expect(trace.some((entry) => entry.startsWith("propose:") || entry.startsWith("execute:"))).toBe(false);
    expect(executeCalls).toHaveLength(0);

    const reloaded = await runMangekyoLoop(
      structuredClone(saved() as MangekyoLoopSession),
      dependencies,
    );
    expect(reloaded).toEqual(stopped);
  });

  it.each([
    "IDLE",
    "PREPARING",
    "POLICY_CHECK",
    "EDITING",
    "RUNNING",
    "CAPTURING",
    "COMPARING",
    "DECIDING",
    "FIXING",
    "HUMAN_GATE",
  ] as const)("honors the same durable Stop at the %s phase boundary", async (status) => {
    const { dependencies, trace, executeCalls, saved } = harness([], []);
    dependencies.loadStopRequest = async () => ({
      id: `stop-${status.toLowerCase()}`,
      loopSessionId: "mangekyo-1",
      sessionVersion: "2026-08-27T01:00:00.000Z",
      requestedAt: "2026-08-27T01:00:01.000Z",
      requestedBy: "local-user",
    });
    const checkpoint = sessionFixture();
    checkpoint.status = status;

    const stopped = await runMangekyoLoop(checkpoint, dependencies);

    expect(stopped.status).toBe("BLOCKED");
    expect(stopped.finalRender).toBeUndefined();
    expect(stopped.rounds).toEqual(checkpoint.rounds);
    expect(saved()).toEqual(stopped);
    expect(trace.some((entry) => entry.startsWith("propose:") || entry.startsWith("execute:"))).toBe(false);
    expect(executeCalls).toHaveLength(0);
  });

  it.each([
    "EDITING",
    "RUNNING",
    "CAPTURING",
    "COMPARING",
  ] as const)(
    "fails closed when a replacement worker recovers the durable %s checkpoint without resumable mutation evidence",
    async (status) => {
      const { dependencies, trace, executeCalls, saved } = harness([], []);
      const checkpoint = interruptedCheckpoint(status);

      const recovered = await runMangekyoLoop(checkpoint, dependencies);

      expect(recovered).toMatchObject({
        status: "FAILED",
        mutationFailure: {
          targetDisposition: "RECONCILIATION_REQUIRED",
          affectedPaths: ["styles.css"],
        },
        stopReason: expect.stringMatching(
          new RegExp(`${status}.*mutation may have changed.*source evidence.*not durably`, "i"),
        ),
      });
      expect(recovered.finalRender).toBeUndefined();
      expect(saved()).toEqual(recovered);
      expect(trace).toEqual(["persist:FAILED"]);
      expect(executeCalls).toHaveLength(0);

      const reloaded = await runMangekyoLoop(
        structuredClone(saved() as MangekyoLoopSession),
        dependencies,
      );
      expect(reloaded).toEqual(recovered);
      expect(trace).toEqual(["persist:FAILED"]);
      expect(executeCalls).toHaveLength(0);
    },
  );

  it.each(
    (["EDITING", "RUNNING", "CAPTURING", "COMPARING"] as const).flatMap((status) =>
      invalidInterruptedEvidence.map((invalid) => ({ status, ...invalid }))
    ),
  )(
    "retains fail-closed ownership for $status recovery with $name policy evidence",
    async ({ status, mutate }) => {
      const { dependencies, trace, executeCalls, saved } = harness([], []);
      const checkpoint = interruptedCheckpoint(status);
      mutate(checkpoint);

      await expect(runMangekyoLoop(checkpoint, dependencies)).rejects.toThrow(
        /interrupted.*recovery evidence.*missing|empty|ambiguous|tampered/i,
      );

      expect(saved()).toBeUndefined();
      expect(trace).toEqual([]);
      expect(executeCalls).toHaveLength(0);
    },
  );

  it.each([
    "EDITING",
    "RUNNING",
    "CAPTURING",
    "COMPARING",
  ] as const)(
    "lets an exact durable Stop outrank interrupted %s reconciliation without duplicate work",
    async (status) => {
      const { dependencies, trace, executeCalls, saved } = harness([], []);
      const checkpoint = sessionFixture();
      checkpoint.status = status;
      checkpoint.updatedAt = "2026-08-27T01:00:01.000Z";
      checkpoint.policyEvaluations = [{
        id: "policy-stopped-recovery-1",
        roundNumber: 1,
        proposalId: "proposal-stopped-recovery-1",
        change: { kind: "STYLE_CHANGE", files: ["styles.css"] },
        policy: checkpoint.policy,
        evaluation: { decision: "ALLOW", reasons: [] },
        evaluatedAt: checkpoint.updatedAt,
      }];
      dependencies.loadStopRequest = async () => ({
        id: `stop-${status.toLowerCase()}-recovery`,
        loopSessionId: checkpoint.id,
        sessionVersion: checkpoint.updatedAt,
        requestedAt: "2026-08-27T01:00:02.000Z",
        requestedBy: "local-user",
      });

      const stopped = await runMangekyoLoop(checkpoint, dependencies);

      expect(stopped).toMatchObject({
        status: "BLOCKED",
        stopRequest: { id: `stop-${status.toLowerCase()}-recovery` },
        stopReason: expect.stringMatching(/user stopped/i),
      });
      expect(stopped.mutationFailure).toBeUndefined();
      expect(stopped.finalRender).toBeUndefined();
      expect(saved()).toEqual(stopped);
      expect(trace).toEqual(["persist:BLOCKED"]);
      expect(executeCalls).toHaveLength(0);
    },
  );

  it("Reject blocks the pending gate without executing it", async () => {
    const { dependencies, executeCalls } = harness([], []);
    const persist = dependencies.persist;
    const inconsistentCheckpoints: MangekyoLoopSession[] = [];
    dependencies.persist = async (checkpoint) => {
      if (
        checkpoint.currentGate !== undefined &&
        checkpoint.gateDecisions.some(({ gateId }) => gateId === checkpoint.currentGate?.id)
      ) {
        inconsistentCheckpoints.push(structuredClone(checkpoint));
      }
      await persist(checkpoint);
    };
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
    expect(inconsistentCheckpoints).toHaveLength(0);
  });

  it("atomically claims the exact gate and session version before mixed concurrent decisions", async () => {
    const { dependencies, executeCalls, saved } = harness([], [[]]);
    const gated = sessionFixture();
    gated.status = "HUMAN_GATE";
    gated.updatedAt = "2026-08-27T01:00:01.100Z";
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
      requestedAt: gated.updatedAt,
      reasons: ["Navigation changes are disabled."],
      affectedScope: pending.affectedScope,
      impact: pending.impact,
    };
    gated.gates = [structuredClone(gated.currentGate)];
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
    let claimed = false;
    const observed: unknown[] = [];
    Object.assign(dependencies, {
      now: () => new Date("2026-08-27T01:00:02.000Z"),
      claimGateDecision: async (claim: unknown) => {
        observed.push(structuredClone(claim));
        if (claimed) throw new Error("Mangekyo Human Gate was already decided");
        claimed = true;
      },
    });

    const outcomes = await Promise.allSettled([
      resolveHumanGate(
        structuredClone(gated),
        { decision: "REJECT", decidedBy: "local-user" },
        dependencies,
      ),
      resolveHumanGate(
        structuredClone(gated),
        { decision: "APPROVE_ONCE", decidedBy: "local-user" },
        dependencies,
      ),
    ]);

    expect(outcomes.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter(({ status }) => status === "rejected")).toHaveLength(1);
    expect(observed).toHaveLength(2);
    expect(observed[0]).toMatchObject({
      loopSessionId: "mangekyo-1",
      sessionVersion: "2026-08-27T01:00:01.100Z",
      gateId: "gate-1",
    });
    expect(
      (outcomes.find(({ status }) => status === "rejected") as PromiseRejectedResult).reason,
    ).toEqual(expect.objectContaining({ message: expect.stringMatching(/already decided/i) }));
    expect(saved()?.gateDecisions).toHaveLength(1);
    expect(executeCalls.length).toBeLessThanOrEqual(1);
  });

  it("releases a claimed gate action only when its decision checkpoint fails before mutation", async () => {
    const { dependencies, executeCalls } = harness([], [[]]);
    const gated = sessionFixture();
    gated.status = "HUMAN_GATE";
    gated.updatedAt = "2026-08-27T01:00:01.100Z";
    gated.updatedAt = "2026-08-27T01:00:01.000Z";
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
      requestedAt: gated.updatedAt,
      reasons: ["Navigation changes are disabled."],
      affectedScope: pending.affectedScope,
      impact: pending.impact,
    };
    gated.gates = [structuredClone(gated.currentGate)];
    gated.policyEvaluations = [{
      id: "policy-navigation",
      roundNumber: 1,
      proposalId: pending.proposal.id,
      change: pending.change,
      policy: gated.policy,
      evaluation: { decision: "HUMAN_GATE", reasons: ["Navigation changes are disabled."] },
      evaluatedAt: gated.updatedAt,
    }];
    const releaseClaims: unknown[] = [];
    Object.assign(dependencies, {
      releaseGateDecisionClaim: async (claim: unknown) => {
        releaseClaims.push(structuredClone(claim));
      },
    });
    dependencies.persist = async (checkpoint) => {
      if (checkpoint.gateDecisions.length > 0) {
        throw new Error("persisted decision checkpoint failed validation");
      }
    };

    await expect(resolveHumanGate(
      gated,
      { decision: "APPROVE_ONCE", decidedBy: "local-user" },
      dependencies,
    )).rejects.toThrow(/failed validation/i);

    expect(executeCalls).toHaveLength(0);
    expect(releaseClaims).toEqual([expect.objectContaining({
      loopSessionId: gated.id,
      sessionVersion: gated.updatedAt,
      gateId: "gate-1",
      decision: "APPROVE_ONCE",
    })]);
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
      requestedAt: gated.updatedAt,
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
    dependencies.now = () => new Date("2026-08-27T01:00:02.000Z");

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
    gated.updatedAt = "2026-08-27T01:00:01.100Z";
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
      requestedAt: gated.updatedAt,
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
    dependencies.now = () => new Date("2026-08-27T01:00:02.000Z");

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
