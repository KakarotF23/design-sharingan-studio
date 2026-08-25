import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  Approval,
  ChangeProposal,
  DesignApproach,
  FeatureBrief,
  Project,
} from "@design-sharingan/core";
import {
  approveAndExecuteSafeProposal,
  decideSafeExecutionProposal,
  loadSafeExecutionState,
  prepareSafeExecutionProposal,
} from "../safe-execution-store";
import type {
  SafeExecutionEditingSession,
  SafeExecutionWaitingSession,
} from "../safe-execution-store";
import {
  loadSession,
  saveProjectMetadata,
  saveSession,
} from "../workspace-store";
import type {
  FeatureEvolveApprovedSession,
  SafeExecutionDraftSession,
} from "../workspace-store";

const cleanupRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanupRoots.splice(0).map((path) =>
      rm(path, { force: true, recursive: true }),
    ),
  );
});

const featureBrief: FeatureBrief = {
  name: "Evidence inbox",
  goal: "Triage unresolved design evidence.",
  description: "Add a bounded evidence inbox.",
  constraints: ["Keep navigation"],
  mustKeep: ["Reports history"],
  mustNotChange: ["No new route"],
  successCriteria: ["Triage one item quickly"],
};

const approach: DesignApproach = {
  id: "approach-guided-queue",
  title: "Guided evidence queue",
  summary: "Add a bounded queue in the current screen.",
  recommended: true,
  pros: ["Preserves navigation"],
  cons: ["Adds one state"],
  uxImpact: [
    {
      area: "Reference review",
      severity: "IMPORTANT",
      reason: "Review state becomes explicit.",
      affectedRoutes: ["/references"],
      affectedComponents: ["ReferenceCard"],
      decisionRequired: true,
    },
  ],
  estimatedComplexity: "MEDIUM",
  genomeFit: "Fits the evidence-first direction.",
  likelyFiles: ["src/reference-card.tsx"],
  status: "PROPOSED",
};

function proposal(overrides: Partial<ChangeProposal> = {}): ChangeProposal {
  return {
    id: "proposal-safe-1",
    sessionId: "safe-session-1",
    summary: "Add a review marker.",
    reason: "Make unresolved evidence visible.",
    filesToCreate: [],
    filesToModify: ["src/reference-card.tsx"],
    filesToDelete: [],
    componentsAffected: ["ReferenceCard"],
    screensAffected: ["/references"],
    uxImpact: approach.uxImpact,
    visualImpact: "Adds one quiet marker.",
    riskLevel: "LOW",
    requiresHumanApproval: true,
    policyViolations: [],
    status: "PROPOSED",
    ...overrides,
  };
}

function mutationApproval(overrides: Partial<Approval> = {}): Approval {
  return {
    id: "approval-mutation-1",
    proposalId: "proposal-safe-1",
    decision: "APPROVED",
    scope: "CHANGE_PROPOSAL",
    approvedBy: "local-user",
    createdAt: "2026-08-25T02:00:00.000Z",
    ...overrides,
  };
}

async function initializedExecution(): Promise<{
  rootPath: string;
  project: Project;
  execute: SafeExecutionDraftSession;
}> {
  const createdRoot = await mkdtemp(join(tmpdir(), "design-sharingan-safe-store-"));
  cleanupRoots.push(createdRoot);
  const rootPath = await realpath(createdRoot);
  const project: Project = {
    id: "project-safe-store",
    name: "Safe Store",
    sourceType: "LOCAL",
    rootPath,
    framework: "nextjs",
    packageManager: "pnpm",
    devCommand: "pnpm dev",
    status: "READY",
    createdAt: "2026-08-25T00:00:00.000Z",
    updatedAt: "2026-08-25T00:00:00.000Z",
  };
  await saveProjectMetadata(project);
  const designApproval: Approval = {
    id: "approval-design-1",
    proposalId: approach.id,
    decision: "APPROVED",
    scope: "DESIGN_APPROACH",
    approvedBy: "local-user",
    createdAt: "2026-08-25T01:00:00.000Z",
  };
  const source: FeatureEvolveApprovedSession = {
    id: "feature-session-1",
    projectId: project.id,
    type: "FEATURE_EVOLVE",
    status: "APPROVED",
    createdAt: "2026-08-25T00:30:00.000Z",
    updatedAt: designApproval.createdAt,
    featureBrief,
    referenceIds: [],
    uxImpact: approach.uxImpact,
    approaches: [
      approach,
      {
        ...approach,
        id: "approach-inline",
        title: "Inline markers",
        recommended: false,
      },
    ],
    agentThreadId: "thread-evolve-1",
    approvedApproachId: approach.id,
    approval: designApproval,
    executeSessionId: "safe-session-1",
  };
  const execute: SafeExecutionDraftSession = {
    id: "safe-session-1",
    projectId: project.id,
    type: "SAFE_EXECUTION",
    status: "IDLE",
    createdAt: designApproval.createdAt,
    updatedAt: designApproval.createdAt,
    sourceSessionId: source.id,
    approvedApproachId: approach.id,
    approvalId: designApproval.id,
    featureBrief,
    designApproach: approach,
  };
  await saveSession(rootPath, source);
  await saveSession(rootPath, execute);
  return { rootPath, project, execute };
}

async function awaitingProposal(): Promise<{
  rootPath: string;
  project: Project;
  waiting: SafeExecutionWaitingSession;
}> {
  const fixture = await initializedExecution();
  const waiting = await prepareSafeExecutionProposal(
    fixture.rootPath,
    fixture.project.id,
    fixture.execute.id,
    async (source) => {
      const proposing = await loadSession(
        fixture.rootPath,
        fixture.project.id,
        source.id,
      );
      expect(proposing.status).toBe("PROPOSING");
      return { proposal: proposal(), threadId: "thread-proposal-1" };
    },
  );
  return { ...fixture, waiting };
}

describe("Safe execution proposal lifecycle", () => {
  it("persists IDLE → PREPARING → PROPOSING → WAITING_APPROVAL with one exact proposal thread", async () => {
    const { rootPath, project, execute } = await initializedExecution();
    const waiting = await prepareSafeExecutionProposal(
      rootPath,
      project.id,
      execute.id,
      async (source) => {
        expect(source.status).toBe("PROPOSING");
        expect(
          (await loadSession(rootPath, project.id, execute.id)).status,
        ).toBe("PROPOSING");
        return { proposal: proposal(), threadId: "thread-proposal-1" };
      },
    );

    expect(waiting).toMatchObject({
      id: execute.id,
      status: "WAITING_APPROVAL",
      proposal: { id: "proposal-safe-1", sessionId: execute.id },
      proposalThreadId: "thread-proposal-1",
    });
    expect(await loadSafeExecutionState(rootPath, project.id)).toEqual(waiting);
  });

  it("rolls a failed proposal turn back to the exact IDLE source while holding its claim", async () => {
    const { rootPath, project, execute } = await initializedExecution();
    await expect(
      prepareSafeExecutionProposal(
        rootPath,
        project.id,
        execute.id,
        async () => {
          throw new Error("proposal turn failed");
        },
      ),
    ).rejects.toThrow(/proposal turn failed/i);
    expect(await loadSafeExecutionState(rootPath, project.id)).toEqual(execute);
  });

  it("serializes competing proposal preparation so only one proposal can win", async () => {
    const { rootPath, project, execute } = await initializedExecution();
    let release: (() => void) | undefined;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    let runs = 0;
    const first = prepareSafeExecutionProposal(
      rootPath,
      project.id,
      execute.id,
      async () => {
        runs += 1;
        await hold;
        return { proposal: proposal(), threadId: "thread-proposal-1" };
      },
    );
    await expect
      .poll(async () => (await loadSession(rootPath, project.id, execute.id)).status)
      .toBe("PROPOSING");
    const second = prepareSafeExecutionProposal(
      rootPath,
      project.id,
      execute.id,
      async () => {
        runs += 1;
        return {
          proposal: proposal({ id: "proposal-safe-2" }),
          threadId: "thread-proposal-2",
        };
      },
    );
    await expect(second).rejects.toThrow(/already in progress|claim/i);
    release?.();
    await expect(first).resolves.toMatchObject({
      proposal: { id: "proposal-safe-1" },
    });
    expect(runs).toBe(1);
  });
});

describe("Safe execution human decisions", () => {
  it.each([
    ["REVISION_REQUESTED", "REVISING"],
    ["REJECTED", "REJECTED"],
  ] as const)("persists %s through the valid %s state", async (decision, expectedStatus) => {
    const { rootPath, project, waiting } = await awaitingProposal();
    const approval = mutationApproval({
      decision,
      comment: decision === "REVISION_REQUESTED" ? "Keep the marker quieter." : "Not now.",
    });
    const decided = await decideSafeExecutionProposal(
      rootPath,
      project.id,
      waiting.id,
      approval,
    );
    expect(decided).toMatchObject({
      status: expectedStatus,
      decisionApproval: approval,
      proposal: waiting.proposal,
    });
  });

  it("persists APPROVED before execution and finishes truthfully at EDITING with exact mutation/Git evidence", async () => {
    const { rootPath, project, waiting } = await awaitingProposal();
    const approval = mutationApproval();
    const editing = await approveAndExecuteSafeProposal(
      rootPath,
      project.id,
      waiting.id,
      approval,
      async (approved) => {
        expect(approved.status).toBe("APPROVED");
        expect(approved.mutationApproval).toEqual(approval);
        expect(
          (await loadSession(rootPath, project.id, waiting.id)).status,
        ).toBe("APPROVED");
        return {
          proposalId: waiting.proposal.id,
          threadId: waiting.proposalThreadId,
          filesChanged: ["src/reference-card.tsx"],
          git: {
            available: true,
            branch: "fixture",
            statusBefore: "",
            statusAfter: " M src/reference-card.tsx",
            diffAfter: "diff --git a/src/reference-card.tsx b/src/reference-card.tsx",
          },
        };
      },
    );
    expect(editing).toMatchObject({
      status: "EDITING",
      mutationApproval: approval,
      mutationEvidence: {
        proposalId: waiting.proposal.id,
        threadId: waiting.proposalThreadId,
        filesChanged: ["src/reference-card.tsx"],
        git: { available: true, branch: "fixture" },
      },
    });
    expect((await loadSafeExecutionState(rootPath, project.id)).status).toBe(
      "EDITING",
    );
  });

  it.each([
    ["wrong scope", { scope: "DESIGN_APPROACH" }],
    ["stale proposal", { proposalId: "proposal-old" }],
    ["rejected decision", { decision: "REJECTED" }],
  ])("rejects %s before execution and preserves WAITING_APPROVAL", async (_label, overrides) => {
    const { rootPath, project, waiting } = await awaitingProposal();
    let executions = 0;
    await expect(
      approveAndExecuteSafeProposal(
        rootPath,
        project.id,
        waiting.id,
        mutationApproval(overrides as Partial<Approval>),
        async () => {
          executions += 1;
          throw new Error("must not execute");
        },
      ),
    ).rejects.toThrow(/approval|scope|proposal|approved/i);
    expect(executions).toBe(0);
    expect((await loadSafeExecutionState(rootPath, project.id)).status).toBe(
      "WAITING_APPROVAL",
    );
  });

  it("rolls an ordinary execution failure back to WAITING_APPROVAL without losing the proposal", async () => {
    const { rootPath, project, waiting } = await awaitingProposal();
    await expect(
      approveAndExecuteSafeProposal(
        rootPath,
        project.id,
        waiting.id,
        mutationApproval(),
        async () => {
          throw new Error("executor rejected mirror delta");
        },
      ),
    ).rejects.toThrow(/executor rejected/i);
    expect(await loadSafeExecutionState(rootPath, project.id)).toEqual(waiting);
  });

  it("keeps APPROVED when a completed executor returns invalid evidence so mutation cannot be replayed", async () => {
    const { rootPath, project, waiting } = await awaitingProposal();
    const approval = mutationApproval();
    await expect(
      approveAndExecuteSafeProposal(
        rootPath,
        project.id,
        waiting.id,
        approval,
        async () => ({
          proposalId: "proposal-stale",
          threadId: waiting.proposalThreadId,
          filesChanged: ["src/reference-card.tsx"],
          git: {
            available: false,
            statusBefore: "",
            statusAfter: "",
            diffAfter: "",
            note: "Git unavailable",
          },
        }),
      ),
    ).rejects.toThrow(/mutation evidence/i);

    expect(await loadSafeExecutionState(rootPath, project.id)).toMatchObject({
      status: "APPROVED",
      mutationApproval: approval,
      proposal: { id: waiting.proposal.id },
    });
  });

  it("serializes double approval so one callback mutates and a loser cannot clobber its EDITING winner", async () => {
    const { rootPath, project, waiting } = await awaitingProposal();
    let release: (() => void) | undefined;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    let executions = 0;
    const execute = async () => {
      executions += 1;
      await hold;
      return {
        proposalId: waiting.proposal.id,
        threadId: waiting.proposalThreadId,
        filesChanged: ["src/reference-card.tsx"],
        git: {
          available: false,
          statusBefore: "",
          statusAfter: "",
          diffAfter: "",
          note: "Git unavailable",
        },
      };
    };
    const first = approveAndExecuteSafeProposal(
      rootPath,
      project.id,
      waiting.id,
      mutationApproval({ id: "approval-winner" }),
      execute,
    );
    await expect
      .poll(async () => (await loadSession(rootPath, project.id, waiting.id)).status)
      .toBe("APPROVED");
    const second = approveAndExecuteSafeProposal(
      rootPath,
      project.id,
      waiting.id,
      mutationApproval({ id: "approval-loser" }),
      execute,
    );
    await expect(second).rejects.toThrow(/already in progress|claim/i);
    release?.();
    const winner = (await first) as SafeExecutionEditingSession;
    expect(winner.status).toBe("EDITING");
    expect(winner.mutationApproval.id).toBe("approval-winner");
    expect(executions).toBe(1);
    expect(await loadSafeExecutionState(rootPath, project.id)).toEqual(winner);

    const sessionFile = join(
      rootPath,
      ".design-sharingan",
      "sessions",
      `${waiting.id}.json`,
    );
    expect(await readFile(sessionFile, "utf8")).toContain("approval-winner");
    expect(await readFile(sessionFile, "utf8")).not.toContain("approval-loser");
  });
});
