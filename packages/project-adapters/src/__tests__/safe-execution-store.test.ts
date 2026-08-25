import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  Approval,
  ChangeProposal,
  DesignApproach,
  FeatureBrief,
  Project,
  SafeMutationFailureEvidence,
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
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function classifiedMutationFailure(
  targetDisposition: SafeMutationFailureEvidence["targetDisposition"],
  overrides: Partial<SafeMutationFailureEvidence> = {},
): Error & { failure: SafeMutationFailureEvidence } {
  return Object.assign(new Error("executor rejected mirror delta"), {
    failure: {
      kind: "SAFE_MUTATION_FAILURE" as const,
      targetDisposition,
      reason: "executor rejected mirror delta",
      affectedPaths: ["src/reference-card.tsx"],
      occurredAt: new Date().toISOString(),
      ...overrides,
    },
  });
}

function gitTruncation(
  overrides: Partial<{
    branch: { truncated: boolean; limitBytes: number; originalBytes: number; retainedBytes: number };
    statusBefore: { truncated: boolean; limitBytes: number; originalBytes: number; retainedBytes: number };
    statusAfter: { truncated: boolean; limitBytes: number; originalBytes: number; retainedBytes: number };
    diffAfter: { truncated: boolean; limitBytes: number; originalBytes: number; retainedBytes: number };
  }> = {},
) {
  const empty = {
    truncated: false,
    limitBytes: 128 * 1024,
    originalBytes: 0,
    retainedBytes: 0,
  };
  return {
    branch: { ...empty },
    statusBefore: { ...empty },
    statusAfter: { ...empty },
    diffAfter: { ...empty },
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

  it("retains an append-only revision decision and prior proposal through reproposal", async () => {
    const { rootPath, project, waiting } = await awaitingProposal();
    const instruction =
      "Keep the marker text visible, reduce its contrast, and do not change the route.";
    const revisionApproval = mutationApproval({
      id: "approval-revision-1",
      decision: "REVISION_REQUESTED",
      comment: instruction,
    });
    const revising = await decideSafeExecutionProposal(
      rootPath,
      project.id,
      waiting.id,
      revisionApproval,
    );
    const revised = await prepareSafeExecutionProposal(
      rootPath,
      project.id,
      waiting.id,
      async (source) => {
        expect(source.revisionRequest).toBe(instruction);
        return {
          proposal: proposal({
            id: "proposal-safe-2",
            summary: "Add a quieter review marker.",
          }),
          threadId: waiting.proposalThreadId,
        };
      },
    );

    expect(
      (revising as unknown as { proposalHistory: unknown[] }).proposalHistory,
    ).toEqual([
      {
        proposal: waiting.proposal,
        proposalThreadId: waiting.proposalThreadId,
        proposedAt: waiting.updatedAt,
        decisionApproval: revisionApproval,
      },
    ]);
    expect(
      (revised as unknown as { proposalHistory: unknown[] }).proposalHistory,
    ).toEqual([
      {
        proposal: waiting.proposal,
        proposalThreadId: waiting.proposalThreadId,
        proposedAt: waiting.updatedAt,
        decisionApproval: revisionApproval,
      },
      {
        proposal: revised.proposal,
        proposalThreadId: waiting.proposalThreadId,
        proposedAt: revised.updatedAt,
      },
    ]);
    expect(await loadSafeExecutionState(rootPath, project.id)).toEqual(revised);
  });

  it.each([
    ["unsafe escape", (record: any) => {
      record.proposal.filesToModify = ["../outside.ts"];
    }],
    ["protected environment path", (record: any) => {
      record.proposal.filesToModify = ["config/.env.local"];
    }],
    ["duplicate proposal paths", (record: any) => {
      record.proposal.filesToModify = [
        "src/reference-card.tsx",
        "src/reference-card.tsx",
      ];
    }],
    ["overlapping proposal operations", (record: any) => {
      record.proposal.filesToDelete = ["src/reference-card.tsx"];
    }],
    ["unapproved mutation evidence path", (record: any) => {
      record.mutationEvidence.filesChanged = ["src/unapproved.ts"];
    }],
    ["reordered mutation evidence paths", (record: any) => {
      record.mutationEvidence.filesChanged = [
        "src/reference-card.tsx",
        "src/created.ts",
      ];
    }],
    ["incoherent 1900 creation time", (record: any) => {
      record.createdAt = "1900-01-01T00:00:00.000Z";
    }],
    ["non-ISO update time", (record: any) => {
      record.updatedAt = "August 25, 2026";
    }],
    ["completion/update mismatch", (record: any) => {
      record.mutationEvidence.completedAt = "2026-08-25T23:59:59.999Z";
    }],
    ["approval after completion", (record: any) => {
      record.mutationApproval.createdAt = "2126-08-25T00:00:00.000Z";
    }],
    ["prior proposal thread mismatch", (record: any) => {
      record.proposalHistory[0].proposalThreadId = "thread-other";
    }],
    ["prior proposal before session creation", (record: any) => {
      record.proposalHistory[0].proposedAt = "1900-01-01T00:00:00.000Z";
    }],
    ["blank prior revision instruction", (record: any) => {
      record.proposalHistory[0].decisionApproval.comment = "   ";
    }],
    ["prior decision proposal mismatch", (record: any) => {
      record.proposalHistory[0].decisionApproval.proposalId = "proposal-other";
    }],
    ["reused decision approval id", (record: any) => {
      const reusedId = record.proposalHistory[0].decisionApproval.id;
      record.mutationApproval.id = reusedId;
      record.proposalHistory[1].decisionApproval.id = reusedId;
    }],
    ["oversized multibyte Git evidence", (record: any) => {
      record.mutationEvidence.git.diffAfter = "界".repeat(50_000);
      record.mutationEvidence.git.truncation.diffAfter = {
        truncated: false,
        limitBytes: 128 * 1024,
        originalBytes: 150_000,
        retainedBytes: 150_000,
      };
    }],
    ["incoherent retained Git byte count", (record: any) => {
      record.mutationEvidence.git.truncation.diffAfter.retainedBytes = 1;
    }],
    ["dishonest Git truncation claim", (record: any) => {
      record.mutationEvidence.git.diffAfter = "";
      record.mutationEvidence.git.truncation.diffAfter = {
        truncated: true,
        limitBytes: 128 * 1024,
        originalBytes: 1,
        retainedBytes: 0,
      };
    }],
  ] as const)("rejects tampered persisted SAFE_EXECUTION evidence: %s", async (_label, tamper) => {
    const { rootPath, project, waiting } = await awaitingProposal();
    const revision = mutationApproval({
      id: "approval-revision-1",
      decision: "REVISION_REQUESTED",
      comment: "Make the marker quieter without changing its route.",
    });
    await decideSafeExecutionProposal(
      rootPath,
      project.id,
      waiting.id,
      revision,
    );
    const revised = await prepareSafeExecutionProposal(
      rootPath,
      project.id,
      waiting.id,
      async () => ({
        proposal: proposal({
          id: "proposal-safe-2",
          filesToCreate: ["src/created.ts"],
        }),
        threadId: waiting.proposalThreadId,
      }),
    );
    const approval = mutationApproval({
      id: "approval-mutation-2",
      proposalId: revised.proposal.id,
    });
    const editing = await approveAndExecuteSafeProposal(
      rootPath,
      project.id,
      revised.id,
      approval,
      async () => ({
        proposalId: revised.proposal.id,
        threadId: revised.proposalThreadId,
        filesChanged: ["src/created.ts", "src/reference-card.tsx"],
        git: {
          available: false,
          statusBefore: "",
          statusAfter: "",
          diffAfter: "",
          truncation: gitTruncation(),
          note: "Git unavailable",
        },
      }),
    );
    const record = structuredClone(editing) as any;
    tamper(record);
    const sessionPath = join(
      rootPath,
      ".design-sharingan",
      "sessions",
      `${editing.id}.json`,
    );
    await writeFile(sessionPath, `${JSON.stringify(record)}\n`, "utf8");

    await expect(
      loadSafeExecutionState(rootPath, project.id),
    ).rejects.toThrow(/invalid|evidence|match|ambiguous/i);
  });

  it("rejects an unsafe generated proposal at the durable writer boundary", async () => {
    const { rootPath, project, execute } = await initializedExecution();

    await expect(
      prepareSafeExecutionProposal(
        rootPath,
        project.id,
        execute.id,
        async () => ({
          proposal: proposal({ filesToModify: ["../outside.ts"] }),
          threadId: "thread-proposal-1",
        }),
      ),
    ).rejects.toThrow(/proposal evidence|invalid/i);
    expect(await loadSafeExecutionState(rootPath, project.id)).toEqual(execute);
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
            truncation: gitTruncation({
              branch: { truncated: false, limitBytes: 128 * 1024, originalBytes: 7, retainedBytes: 7 },
              statusAfter: { truncated: false, limitBytes: 128 * 1024, originalBytes: 25, retainedBytes: 25 },
              diffAfter: { truncated: false, limitBytes: 128 * 1024, originalBytes: 60, retainedBytes: 60 },
            }),
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

  it("persists a literal truncation marker as content with truthful non-truncated byte metadata", async () => {
    const { rootPath, project, waiting } = await awaitingProposal();
    const literalDiff = "+[Git evidence truncated]";
    const literalBytes = Buffer.byteLength(literalDiff, "utf8");
    const editing = await approveAndExecuteSafeProposal(
      rootPath,
      project.id,
      waiting.id,
      mutationApproval(),
      async () => ({
        proposalId: waiting.proposal.id,
        threadId: waiting.proposalThreadId,
        filesChanged: ["src/reference-card.tsx"],
        git: {
          available: true,
          statusBefore: "",
          statusAfter: "",
          diffAfter: literalDiff,
          truncation: gitTruncation({
            diffAfter: {
              truncated: false,
              limitBytes: 128 * 1024,
              originalBytes: literalBytes,
              retainedBytes: literalBytes,
            },
          }),
        },
      }),
    );

    expect(editing.mutationEvidence.git.diffAfter).toBe(literalDiff);
    expect(editing.mutationEvidence.git.truncation.diffAfter.truncated).toBe(
      false,
    );
    expect(await loadSafeExecutionState(rootPath, project.id)).toEqual(editing);
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

  it.each(["NO_TARGET_CHANGE", "FULLY_ROLLED_BACK"] as const)(
    "restores WAITING_APPROVAL only for a proven %s execution failure",
    async (targetDisposition) => {
    const { rootPath, project, waiting } = await awaitingProposal();
    await expect(
      approveAndExecuteSafeProposal(
        rootPath,
        project.id,
        waiting.id,
        mutationApproval(),
        async () => {
          throw classifiedMutationFailure(targetDisposition);
        },
      ),
    ).rejects.toThrow(/executor rejected/i);
    expect(await loadSafeExecutionState(rootPath, project.id)).toEqual(waiting);
    },
  );

  it("retains approval and blocks replay when an unclassified execution failure is indeterminate", async () => {
    const { rootPath, project, waiting } = await awaitingProposal();
    const approval = mutationApproval();
    await expect(
      approveAndExecuteSafeProposal(
        rootPath,
        project.id,
        waiting.id,
        approval,
        async () => {
          throw new Error("unclassified executor transport failure");
        },
      ),
    ).rejects.toThrow(/transport failure/i);

    const persisted = await loadSafeExecutionState(rootPath, project.id);
    expect(persisted).toMatchObject({
      status: "APPROVED",
      mutationApproval: approval,
      executionFailure: {
        kind: "SAFE_MUTATION_FAILURE",
        targetDisposition: "RECONCILIATION_REQUIRED",
        affectedPaths: ["src/reference-card.tsx"],
      },
    });
    let replayExecutions = 0;
    await expect(
      approveAndExecuteSafeProposal(
        rootPath,
        project.id,
        waiting.id,
        mutationApproval({ id: "approval-replay" }),
        async () => {
          replayExecutions += 1;
          throw new Error("must not replay");
        },
      ),
    ).rejects.toThrow(/not waiting/i);
    expect(replayExecutions).toBe(0);
  });

  it("persists bounded classified reconciliation evidence without discarding approval", async () => {
    const { rootPath, project, waiting } = await awaitingProposal();
    const approval = mutationApproval();
    const failure = classifiedMutationFailure("RECONCILIATION_REQUIRED", {
      reason: "Target bytes no longer match the approved delta.",
    });
    await expect(
      approveAndExecuteSafeProposal(
        rootPath,
        project.id,
        waiting.id,
        approval,
        async () => {
          throw failure;
        },
      ),
    ).rejects.toBe(failure);

    expect(await loadSafeExecutionState(rootPath, project.id)).toMatchObject({
      status: "APPROVED",
      updatedAt: failure.failure.occurredAt,
      mutationApproval: approval,
      executionFailure: failure.failure,
    });
  });

  it("marks a completed executor with invalid evidence for reconciliation so mutation cannot be replayed", async () => {
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
            truncation: gitTruncation(),
            note: "Git unavailable",
          },
        }),
      ),
    ).rejects.toThrow(/mutation evidence/i);

    expect(await loadSafeExecutionState(rootPath, project.id)).toMatchObject({
      status: "APPROVED",
      mutationApproval: approval,
      proposal: { id: waiting.proposal.id },
      executionFailure: {
        targetDisposition: "RECONCILIATION_REQUIRED",
        affectedPaths: ["src/reference-card.tsx"],
      },
    });
    await expect(
      approveAndExecuteSafeProposal(
        rootPath,
        project.id,
        waiting.id,
        mutationApproval({ id: "approval-invalid-evidence-replay" }),
        async () => {
          throw new Error("must not replay invalid evidence");
        },
      ),
    ).rejects.toThrow(/not waiting/i);
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
          truncation: gitTruncation(),
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
