import { execFile as execFileCallback } from "node:child_process";
import { writeFileSync } from "node:fs";
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import type {
  Approval,
  ChangeProposal,
  DesignApproach,
  FeatureBrief,
} from "@design-sharingan/core";
import type { CodexAgentRunInput } from "@design-sharingan/agent-runtime";
import {
  CHANGE_PROPOSAL_OUTPUT_SCHEMA,
  generateChangeProposal,
} from "../change-proposal";
import { MutationExecutor } from "../mutation-executor";

const execFile = promisify(execFileCallback);

const temporaryDirectories: string[] = [];

async function temporaryWorkspace(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "design-sharingan-safe-mode-test-"));
  temporaryDirectories.push(path);
  return realpath(path);
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) =>
      rm(path, { force: true, recursive: true }),
    ),
  );
});

const designApproach: DesignApproach = {
  id: "approach-guided-queue",
  title: "Guided evidence queue",
  summary: "Create a bounded evidence queue inside the existing workspace.",
  recommended: true,
  pros: ["Preserves navigation"],
  cons: ["Adds one review state"],
  uxImpact: [
    {
      area: "Reference review",
      severity: "IMPORTANT",
      reason: "Review priority becomes explicit.",
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

const featureBrief: FeatureBrief = {
  name: "Evidence inbox",
  goal: "Help reviewers triage unresolved evidence.",
  description: "Add a bounded evidence inbox.",
  constraints: ["Use existing navigation"],
  mustKeep: ["Reports remain durable"],
  mustNotChange: ["Do not add routes"],
  successCriteria: ["One item can be triaged in under a minute"],
};

function proposalFixture(
  overrides: Partial<ChangeProposal> = {},
): ChangeProposal {
  return {
    id: "proposal-safe-1",
    sessionId: "safe-session-1",
    summary: "Add a bounded review marker.",
    reason: "Make unresolved evidence visible without changing navigation.",
    filesToCreate: [],
    filesToModify: ["src/reference-card.tsx"],
    filesToDelete: [],
    componentsAffected: ["ReferenceCard"],
    screensAffected: ["/references"],
    uxImpact: designApproach.uxImpact,
    visualImpact: "Adds one quiet status marker.",
    riskLevel: "LOW",
    requiresHumanApproval: true,
    policyViolations: [],
    status: "PROPOSED",
    ...overrides,
  };
}

function approvalFixture(
  overrides: Partial<Approval> = {},
): Approval {
  return {
    id: "approval-safe-1",
    proposalId: "proposal-safe-1",
    decision: "APPROVED",
    scope: "CHANGE_PROPOSAL",
    approvedBy: "local-user",
    createdAt: "2026-08-25T01:00:00.000Z",
    ...overrides,
  };
}

const wireOutput = {
  summary: "Add a bounded review marker.",
  reason: "Make unresolved evidence visible without changing navigation.",
  filesToCreate: [] as string[],
  filesToModify: ["src/reference-card.tsx"],
  filesToDelete: [] as string[],
  componentsAffected: ["ReferenceCard"],
  screensAffected: ["/references"],
  uxImpact: designApproach.uxImpact,
  visualImpact: "Adds one quiet status marker.",
  riskLevel: "LOW" as const,
  requiresHumanApproval: true as const,
  policyViolations: [] as string[],
  status: "PROPOSED" as const,
};

describe("structured Safe Mode proposals", () => {
  it("uses the exact bounded proposal schema and returns risk, UX, visual, and file evidence without mutation", async () => {
    const analysisRoot = await temporaryWorkspace();
    const sentinelPath = join(analysisRoot, "sentinel.txt");
    await writeFile(sentinelPath, "unchanged\n", "utf8");
    let runInput: CodexAgentRunInput | undefined;

    const result = await generateChangeProposal(
      {
        sessionId: "safe-session-1",
        designApproach,
        featureBrief,
        analysisWorkingDirectory: analysisRoot,
        projectContext: {
          name: "Fixture",
          framework: "nextjs",
          routes: ["/references"],
          componentDirectories: ["src"],
        },
      },
      {
        createId: () => "proposal-safe-1",
        agent: {
          async run<TStructured>(input: CodexAgentRunInput) {
            runInput = input;
            return {
              threadId: "thread-proposal-1",
              structured: wireOutput as TStructured,
            };
          },
        },
      },
    );

    expect(runInput).toEqual({
      workingDirectory: analysisRoot,
      prompt: expect.stringContaining("Do not write, edit, create, delete"),
      outputSchema: CHANGE_PROPOSAL_OUTPUT_SCHEMA,
    });
    expect(Object.keys(CHANGE_PROPOSAL_OUTPUT_SCHEMA.properties)).toEqual([
      "summary",
      "reason",
      "filesToCreate",
      "filesToModify",
      "filesToDelete",
      "componentsAffected",
      "screensAffected",
      "uxImpact",
      "visualImpact",
      "riskLevel",
      "requiresHumanApproval",
      "policyViolations",
      "status",
    ]);
    expect(CHANGE_PROPOSAL_OUTPUT_SCHEMA.additionalProperties).toBe(false);
    expect(result).toEqual({
      proposal: proposalFixture(),
      threadId: "thread-proposal-1",
    });
    expect(result.proposal).toMatchObject({
      filesToModify: ["src/reference-card.tsx"],
      riskLevel: "LOW",
      uxImpact: designApproach.uxImpact,
      visualImpact: "Adds one quiet status marker.",
    });
    expect(await readFile(sentinelPath, "utf8")).toBe("unchanged\n");
  });

  it("rejects undeclared proposal keys instead of trusting structured output", async () => {
    const analysisRoot = await temporaryWorkspace();
    await expect(
      generateChangeProposal(
        {
          sessionId: "safe-session-1",
          designApproach,
          featureBrief,
          analysisWorkingDirectory: analysisRoot,
          projectContext: {
            name: "Fixture",
            routes: [],
            componentDirectories: [],
          },
        },
        {
          createId: () => "proposal-safe-1",
          agent: {
            async run<TStructured>() {
              return {
                threadId: "thread-proposal-1",
                structured: { ...wireOutput, undeclared: true } as TStructured,
              };
            },
          },
        },
      ),
    ).rejects.toThrow(/invalid structured change proposal/i);
  });

  it("enforces structured proposal string bounds in UTF-8 bytes", async () => {
    const analysisRoot = await temporaryWorkspace();
    await expect(
      generateChangeProposal(
        {
          sessionId: "safe-session-1",
          designApproach,
          featureBrief,
          analysisWorkingDirectory: analysisRoot,
          projectContext: {
            name: "Fixture",
            routes: [],
            componentDirectories: [],
          },
        },
        {
          createId: () => "proposal-safe-1",
          agent: {
            async run<TStructured>() {
              return {
                threadId: "thread-proposal-1",
                structured: {
                  ...wireOutput,
                  summary: "界".repeat(2_000),
                } as TStructured,
              };
            },
          },
        },
      ),
    ).rejects.toThrow(/invalid structured change proposal/i);
  });
});

describe("Safe Mode mutation gate", () => {
  async function executorFixture() {
    const workspaceRoot = await temporaryWorkspace();
    let agentRuns = 0;
    const executor = new MutationExecutor({
      workspaceRoot,
      proposalThreadId: "thread-proposal-1",
      agent: {
        async run<TStructured>() {
          agentRuns += 1;
          return {
            threadId: "thread-proposal-1",
            structured: null as TStructured,
          };
        },
      },
    });
    return { executor, workspaceRoot, agentRuns: () => agentRuns };
  }

  it("refuses mutation without matching explicit approval", async () => {
    const { executor, agentRuns } = await executorFixture();
    await expect(
      executor.apply({ proposal: proposalFixture(), approval: undefined }),
    ).rejects.toThrow(/explicit approval/i);
    expect(agentRuns()).toBe(0);
  });

  it("refuses a rejected proposal decision", async () => {
    const { executor, agentRuns } = await executorFixture();
    await expect(
      executor.apply({
        proposal: proposalFixture(),
        approval: approvalFixture({ decision: "REJECTED" }),
      }),
    ).rejects.toThrow(/approved decision/i);
    expect(agentRuns()).toBe(0);
  });

  it("refuses a proposal whose own status is rejected", async () => {
    const { executor, agentRuns } = await executorFixture();
    await expect(
      executor.apply({
        proposal: proposalFixture({ status: "REJECTED" }),
        approval: approvalFixture(),
      }),
    ).rejects.toThrow(/proposal status/i);
    expect(agentRuns()).toBe(0);
  });

  it("refuses a stale approval for another proposal id", async () => {
    const { executor, agentRuns } = await executorFixture();
    await expect(
      executor.apply({
        proposal: proposalFixture(),
        approval: approvalFixture({ proposalId: "proposal-old" }),
      }),
    ).rejects.toThrow(/same proposal/i);
    expect(agentRuns()).toBe(0);
  });

  it("refuses an approval with the wrong scope", async () => {
    const { executor, agentRuns } = await executorFixture();
    await expect(
      executor.apply({
        proposal: proposalFixture(),
        approval: approvalFixture({ scope: "DESIGN_APPROACH" }),
      }),
    ).rejects.toThrow(/change_proposal scope/i);
    expect(agentRuns()).toBe(0);
  });

  it("rejects a mutation path that exceeds its UTF-8 byte bound before agent execution", async () => {
    const { executor, agentRuns } = await executorFixture();
    await expect(
      executor.apply({
        proposal: proposalFixture({
          filesToCreate: [`${"界".repeat(200)}.ts`],
          filesToModify: [],
        }),
        approval: approvalFixture(),
      }),
    ).rejects.toThrow(/outside the workspace/i);
    expect(agentRuns()).toBe(0);
  });

  it("rejects a proposal thread id that exceeds its UTF-8 byte bound before agent execution", async () => {
    const workspaceRoot = await temporaryWorkspace();
    let agentRuns = 0;
    const executor = new MutationExecutor({
      workspaceRoot,
      proposalThreadId: "界".repeat(100),
      agent: {
        async run<TStructured>() {
          agentRuns += 1;
          return {
            threadId: "界".repeat(100),
            structured: null as TStructured,
          };
        },
      },
    });
    await expect(
      executor.apply({
        proposal: proposalFixture({
          filesToCreate: ["src/created.ts"],
          filesToModify: [],
        }),
        approval: approvalFixture(),
      }),
    ).rejects.toThrow(/thread id is invalid/i);
    expect(agentRuns).toBe(0);
  });
});

describe("controlled mirror mutation", () => {
  async function writeWorkspaceFile(
    workspaceRoot: string,
    relativePath: string,
    contents: string,
  ): Promise<void> {
    const path = join(workspaceRoot, relativePath);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, contents, "utf8");
  }

  it("resumes the exact proposal thread on a disjoint mirror and applies an exact approved create, modify, and delete delta", async () => {
    const workspaceRoot = await temporaryWorkspace();
    await writeWorkspaceFile(workspaceRoot, "src/existing.ts", "export const state = 'before';\n");
    await writeWorkspaceFile(workspaceRoot, "src/obsolete.ts", "export const obsolete = true;\n");
    await writeWorkspaceFile(workspaceRoot, "src/user-note.ts", "export const userNote = 'preserve';\n");
    let observedWorkingDirectory: string | undefined;
    let observedThreadId: string | undefined;
    const proposal = proposalFixture({
      filesToCreate: ["src/created.ts"],
      filesToModify: ["src/existing.ts"],
      filesToDelete: ["src/obsolete.ts"],
    });
    const executor = new MutationExecutor({
      workspaceRoot,
      proposalThreadId: "thread-proposal-1",
      agent: {
        async run<TStructured>(input: CodexAgentRunInput) {
          observedWorkingDirectory = input.workingDirectory;
          observedThreadId = input.threadId;
          await writeWorkspaceFile(
            input.workingDirectory,
            "src/created.ts",
            "export const created = true;\n",
          );
          await writeWorkspaceFile(
            input.workingDirectory,
            "src/existing.ts",
            "export const state = 'after';\n",
          );
          await rm(join(input.workingDirectory, "src/obsolete.ts"));
          return {
            threadId: "thread-proposal-1",
            structured: null as TStructured,
          };
        },
      },
    });

    const result = await executor.apply({
      proposal,
      approval: approvalFixture(),
    });

    expect(observedWorkingDirectory).not.toBe(workspaceRoot);
    expect(observedWorkingDirectory?.startsWith(workspaceRoot)).toBe(false);
    expect(observedThreadId).toBe("thread-proposal-1");
    expect(await readFile(join(workspaceRoot, "src/created.ts"), "utf8")).toBe(
      "export const created = true;\n",
    );
    expect(await readFile(join(workspaceRoot, "src/existing.ts"), "utf8")).toBe(
      "export const state = 'after';\n",
    );
    await expect(readFile(join(workspaceRoot, "src/obsolete.ts"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await readFile(join(workspaceRoot, "src/user-note.ts"), "utf8")).toBe(
      "export const userNote = 'preserve';\n",
    );
    expect(result).toMatchObject({
      proposalId: proposal.id,
      threadId: "thread-proposal-1",
      filesChanged: ["src/created.ts", "src/existing.ts", "src/obsolete.ts"],
    });
  });

  it.each([
    ["workspace escape", { filesToModify: ["../outside.ts"] }],
    ["absolute path", { filesToModify: ["/tmp/outside.ts"] }],
    ["control character path", { filesToModify: ["src/file\nname.ts"] }],
    ["duplicate path", { filesToModify: ["src/file.ts", "src/file.ts"] }],
    [
      "overlapping operation sets",
      { filesToModify: ["src/file.ts"], filesToDelete: ["src/file.ts"] },
    ],
  ])("rejects %s before running the mutation agent", async (_label, overrides) => {
    const workspaceRoot = await temporaryWorkspace();
    await writeWorkspaceFile(workspaceRoot, "src/file.ts", "before\n");
    let runs = 0;
    const executor = new MutationExecutor({
      workspaceRoot,
      proposalThreadId: "thread-proposal-1",
      agent: {
        async run<TStructured>() {
          runs += 1;
          return { threadId: "thread-proposal-1", structured: null as TStructured };
        },
      },
    });
    await expect(
      executor.apply({
        proposal: proposalFixture(overrides),
        approval: approvalFixture(),
      }),
    ).rejects.toThrow(/path|duplicate|overlap|outside/i);
    expect(runs).toBe(0);
    expect(await readFile(join(workspaceRoot, "src/file.ts"), "utf8")).toBe(
      "before\n",
    );
  });

  it.each([
    ".git/config",
    ".design-sharingan/project.json",
    "design-governance/DESIGN-GENOME.md",
    ".env",
    "config/.env.local",
    ".envrc",
    ".direnv/environment",
  ])("always rejects protected mutation path %s", async (relativePath) => {
    const workspaceRoot = await temporaryWorkspace();
    let runs = 0;
    const executor = new MutationExecutor({
      workspaceRoot,
      proposalThreadId: "thread-proposal-1",
      agent: {
        async run<TStructured>() {
          runs += 1;
          return { threadId: "thread-proposal-1", structured: null as TStructured };
        },
      },
    });
    await expect(
      executor.apply({
        proposal: proposalFixture({
          filesToCreate: [relativePath],
          filesToModify: [],
        }),
        approval: approvalFixture(),
      }),
    ).rejects.toThrow(/protected/i);
    expect(runs).toBe(0);
  });

  it("rejects a symlink ancestor without reading or writing outside the workspace", async () => {
    const workspaceRoot = await temporaryWorkspace();
    const outsideRoot = await temporaryWorkspace();
    await symlink(outsideRoot, join(workspaceRoot, "linked"), "dir");
    let runs = 0;
    const executor = new MutationExecutor({
      workspaceRoot,
      proposalThreadId: "thread-proposal-1",
      agent: {
        async run<TStructured>() {
          runs += 1;
          return { threadId: "thread-proposal-1", structured: null as TStructured };
        },
      },
    });
    await expect(
      executor.apply({
        proposal: proposalFixture({
          filesToCreate: ["linked/escape.ts"],
          filesToModify: [],
        }),
        approval: approvalFixture(),
      }),
    ).rejects.toThrow(/symbolic link/i);
    expect(runs).toBe(0);
    await expect(readFile(join(outsideRoot, "escape.ts"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it.each(["modify", "delete"] as const)(
    "rejects an approved %s target hard-linked to an external inode before the agent can read it",
    async (operation) => {
      const workspaceRoot = await temporaryWorkspace();
      const outsideRoot = await temporaryWorkspace();
      const sensitivePath = join(outsideRoot, "sensitive.txt");
      await writeFile(sensitivePath, "external-sensitive-bytes\n", "utf8");
      await mkdir(join(workspaceRoot, "src"), { recursive: true });
      await link(sensitivePath, join(workspaceRoot, "src/linked.ts"));
      let agentRuns = 0;
      const executor = new MutationExecutor({
        workspaceRoot,
        proposalThreadId: "thread-proposal-1",
        agent: {
          async run<TStructured>() {
            agentRuns += 1;
            return { threadId: "thread-proposal-1", structured: null as TStructured };
          },
        },
      });

      await expect(
        executor.apply({
          proposal: proposalFixture({
            filesToModify: operation === "modify" ? ["src/linked.ts"] : [],
            filesToDelete: operation === "delete" ? ["src/linked.ts"] : [],
          }),
          approval: approvalFixture(),
        }),
      ).rejects.toThrow(/hard link|link count/i);
      expect(agentRuns).toBe(0);
      expect(await readFile(sensitivePath, "utf8")).toBe(
        "external-sensitive-bytes\n",
      );
    },
  );

  it("seeds an empty delete placeholder instead of disclosing the target contents to the mutation mirror", async () => {
    const workspaceRoot = await temporaryWorkspace();
    await writeWorkspaceFile(
      workspaceRoot,
      "src/obsolete.ts",
      "sensitive obsolete implementation\n",
    );
    let mirroredBeforeDelete: string | undefined;
    const executor = new MutationExecutor({
      workspaceRoot,
      proposalThreadId: "thread-proposal-1",
      agent: {
        async run<TStructured>(input: CodexAgentRunInput) {
          const mirrorPath = join(input.workingDirectory, "src/obsolete.ts");
          mirroredBeforeDelete = await readFile(mirrorPath, "utf8");
          await rm(mirrorPath);
          return { threadId: "thread-proposal-1", structured: null as TStructured };
        },
      },
    });

    await executor.apply({
      proposal: proposalFixture({
        filesToModify: [],
        filesToDelete: ["src/obsolete.ts"],
      }),
      approval: approvalFixture(),
    });

    expect(mirroredBeforeDelete).toBe("");
  });

  it.each([
    ["create target already exists", { filesToCreate: ["src/file.ts"], filesToModify: [] }],
    ["modify target is missing", { filesToModify: ["src/missing.ts"] }],
    ["delete target is missing", { filesToModify: [], filesToDelete: ["src/missing.ts"] }],
  ])("enforces the %s precondition", async (_label, overrides) => {
    const workspaceRoot = await temporaryWorkspace();
    await writeWorkspaceFile(workspaceRoot, "src/file.ts", "before\n");
    let runs = 0;
    const executor = new MutationExecutor({
      workspaceRoot,
      proposalThreadId: "thread-proposal-1",
      agent: {
        async run<TStructured>() {
          runs += 1;
          return { threadId: "thread-proposal-1", structured: null as TStructured };
        },
      },
    });
    await expect(
      executor.apply({
        proposal: proposalFixture(overrides),
        approval: approvalFixture(),
      }),
    ).rejects.toThrow(/must not exist|must be an existing regular file/i);
    expect(runs).toBe(0);
  });

  it("treats an externally changed target mode as stale before applying approved bytes", async () => {
    const workspaceRoot = await temporaryWorkspace();
    const targetPath = join(workspaceRoot, "src/file.ts");
    await writeWorkspaceFile(workspaceRoot, "src/file.ts", "before\n");
    const executor = new MutationExecutor({
      workspaceRoot,
      proposalThreadId: "thread-proposal-1",
      agent: {
        async run<TStructured>(input: CodexAgentRunInput) {
          await writeWorkspaceFile(input.workingDirectory, "src/file.ts", "after\n");
          await chmod(targetPath, 0o600);
          return { threadId: "thread-proposal-1", structured: null as TStructured };
        },
      },
    });

    await expect(
      executor.apply({
        proposal: proposalFixture({ filesToModify: ["src/file.ts"] }),
        approval: approvalFixture(),
      }),
    ).rejects.toMatchObject({
      failure: { targetDisposition: "NO_TARGET_CHANGE" },
    });
    expect(await readFile(targetPath, "utf8")).toBe("before\n");
    expect((await stat(targetPath)).mode & 0o777).toBe(0o600);
  });

  it("rejects an unapproved mirror change and leaves the target byte-for-byte unchanged", async () => {
    const workspaceRoot = await temporaryWorkspace();
    await writeWorkspaceFile(workspaceRoot, "src/file.ts", "before\n");
    const executor = new MutationExecutor({
      workspaceRoot,
      proposalThreadId: "thread-proposal-1",
      agent: {
        async run<TStructured>(input: CodexAgentRunInput) {
          await writeWorkspaceFile(input.workingDirectory, "src/file.ts", "after\n");
          await writeWorkspaceFile(input.workingDirectory, "src/unapproved.ts", "no\n");
          return { threadId: "thread-proposal-1", structured: null as TStructured };
        },
      },
    });
    await expect(
      executor.apply({
        proposal: proposalFixture({ filesToModify: ["src/file.ts"] }),
        approval: approvalFixture(),
      }),
    ).rejects.toThrow(/unapproved mirror change/i);
    expect(await readFile(join(workspaceRoot, "src/file.ts"), "utf8")).toBe(
      "before\n",
    );
    await expect(readFile(join(workspaceRoot, "src/unapproved.ts"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rolls back an earlier target write when a later approved operation fails", async () => {
    const workspaceRoot = await temporaryWorkspace();
    await writeWorkspaceFile(workspaceRoot, "src/existing.ts", "before\n");
    let writes = 0;
    let injected = false;
    const executor = new MutationExecutor({
      workspaceRoot,
      proposalThreadId: "thread-proposal-1",
      mutationDriver: {
        async write(path, contents) {
          writes += 1;
          if (!injected && writes === 2) {
            injected = true;
            throw new Error("injected target write failure");
          }
          await writeFile(path, contents);
        },
        async remove(path) {
          await rm(path);
        },
      },
      agent: {
        async run<TStructured>(input: CodexAgentRunInput) {
          await writeWorkspaceFile(input.workingDirectory, "src/created.ts", "created\n");
          await writeWorkspaceFile(input.workingDirectory, "src/existing.ts", "after\n");
          return { threadId: "thread-proposal-1", structured: null as TStructured };
        },
      },
    });
    await expect(
      executor.apply({
        proposal: proposalFixture({
          filesToCreate: ["src/created.ts"],
          filesToModify: ["src/existing.ts"],
        }),
        approval: approvalFixture(),
      }),
    ).rejects.toThrow(/injected target write failure/i);
    expect(await readFile(join(workspaceRoot, "src/existing.ts"), "utf8")).toBe(
      "before\n",
    );
    await expect(readFile(join(workspaceRoot, "src/created.ts"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("preserves indeterminate bytes when a driver reports success without applying the approved delta", async () => {
    const workspaceRoot = await temporaryWorkspace();
    await writeWorkspaceFile(workspaceRoot, "src/file.ts", "before\n");
    let writes = 0;
    const executor = new MutationExecutor({
      workspaceRoot,
      proposalThreadId: "thread-proposal-1",
      mutationDriver: {
        async write(path, contents) {
          writes += 1;
          await writeFile(path, writes === 1 ? "corrupted\n" : contents);
        },
        async remove(path) {
          await rm(path);
        },
      },
      agent: {
        async run<TStructured>(input: CodexAgentRunInput) {
          await writeWorkspaceFile(input.workingDirectory, "src/file.ts", "after\n");
          return { threadId: "thread-proposal-1", structured: null as TStructured };
        },
      },
    });
    await expect(
      executor.apply({
        proposal: proposalFixture({ filesToModify: ["src/file.ts"] }),
        approval: approvalFixture(),
      }),
    ).rejects.toMatchObject({
      failure: { targetDisposition: "RECONCILIATION_REQUIRED" },
    });
    expect(await readFile(join(workspaceRoot, "src/file.ts"), "utf8")).toBe(
      "corrupted\n",
    );
  });

  it("permits only one concurrent execution claim for one approved proposal", async () => {
    const workspaceRoot = await temporaryWorkspace();
    await writeWorkspaceFile(workspaceRoot, "src/file.ts", "before\n");
    let releaseAgent: (() => void) | undefined;
    const agentWaiting = new Promise<void>((resolve) => {
      releaseAgent = resolve;
    });
    let enteredAgent: (() => void) | undefined;
    const agentEntered = new Promise<void>((resolve) => {
      enteredAgent = resolve;
    });
    const executor = new MutationExecutor({
      workspaceRoot,
      proposalThreadId: "thread-proposal-1",
      agent: {
        async run<TStructured>(input: CodexAgentRunInput) {
          enteredAgent?.();
          await agentWaiting;
          await writeWorkspaceFile(input.workingDirectory, "src/file.ts", "after\n");
          return { threadId: "thread-proposal-1", structured: null as TStructured };
        },
      },
    });
    const input = {
      proposal: proposalFixture({ filesToModify: ["src/file.ts"] }),
      approval: approvalFixture(),
    };
    const winner = executor.apply(input);
    const reachedAgent = await Promise.race([
      agentEntered.then(() => true),
      winner.then(
        () => false,
        () => false,
      ),
    ]);
    expect(reachedAgent).toBe(true);
    const loser = executor.apply(input);
    await expect(loser).rejects.toThrow(/already being executed/i);
    releaseAgent?.();
    await expect(winner).resolves.toMatchObject({ proposalId: "proposal-safe-1" });
    expect(await readFile(join(workspaceRoot, "src/file.ts"), "utf8")).toBe(
      "after\n",
    );
  });

  it("serializes different proposals for the same target before either can capture or mutate", async () => {
    const workspaceRoot = await temporaryWorkspace();
    await writeWorkspaceFile(workspaceRoot, "src/shared.ts", "original\n");
    await writeWorkspaceFile(workspaceRoot, "src/later.ts", "original later\n");
    let firstApplied: (() => void) | undefined;
    const reachedFirstApply = new Promise<void>((resolve) => {
      firstApplied = resolve;
    });
    let releaseFailure: (() => void) | undefined;
    const mayFail = new Promise<void>((resolve) => {
      releaseFailure = resolve;
    });
    let writes = 0;
    const first = new MutationExecutor({
      workspaceRoot,
      proposalThreadId: "thread-proposal-a",
      mutationDriver: {
        async write(path, contents) {
          writes += 1;
          if (writes === 1) {
            await writeFile(path, contents);
            firstApplied?.();
            return;
          }
          if (writes === 2) {
            await mayFail;
            throw new Error("injected later write failure");
          }
          await writeFile(path, contents);
        },
        async remove(path) {
          await rm(path);
        },
      },
      agent: {
        async run<TStructured>(input: CodexAgentRunInput) {
          await writeWorkspaceFile(input.workingDirectory, "src/shared.ts", "proposal A\n");
          await writeWorkspaceFile(input.workingDirectory, "src/later.ts", "proposal A later\n");
          return { threadId: "thread-proposal-a", structured: null as TStructured };
        },
      },
    });
    const firstRun = first.apply({
      proposal: proposalFixture({
        id: "proposal-a",
        filesToModify: ["src/shared.ts", "src/later.ts"],
      }),
      approval: approvalFixture({ proposalId: "proposal-a" }),
    });
    await reachedFirstApply;

    const second = new MutationExecutor({
      workspaceRoot,
      proposalThreadId: "thread-proposal-b",
      agent: {
        async run<TStructured>(input: CodexAgentRunInput) {
          await writeWorkspaceFile(input.workingDirectory, "src/shared.ts", "proposal B winner\n");
          return { threadId: "thread-proposal-b", structured: null as TStructured };
        },
      },
    });
    const secondOutcome = await second
      .apply({
        proposal: proposalFixture({
          id: "proposal-b",
          filesToModify: ["src/shared.ts"],
        }),
        approval: approvalFixture({ proposalId: "proposal-b" }),
      })
      .then(
        () => "resolved" as const,
        (error: unknown) =>
          error instanceof Error && /already being executed/i.test(error.message)
            ? ("serialized" as const)
            : ("unexpected rejection" as const),
      );
    releaseFailure?.();
    await expect(firstRun).rejects.toThrow(/injected later write failure/i);

    expect(secondOutcome).toBe("serialized");
    expect(await readFile(join(workspaceRoot, "src/shared.ts"), "utf8")).toBe(
      "original\n",
    );
  });

  it("does not roll back over bytes changed by another writer after this transaction applied", async () => {
    const workspaceRoot = await temporaryWorkspace();
    await writeWorkspaceFile(workspaceRoot, "src/shared.ts", "original\n");
    await writeWorkspaceFile(workspaceRoot, "src/later.ts", "original later\n");
    let writes = 0;
    const executor = new MutationExecutor({
      workspaceRoot,
      proposalThreadId: "thread-proposal-1",
      mutationDriver: {
        async write(path, contents) {
          writes += 1;
          if (writes === 2) {
            await writeFile(join(workspaceRoot, "src/shared.ts"), "external winner\n");
            throw new Error("injected later write failure");
          }
          await writeFile(path, contents);
        },
        async remove(path) {
          await rm(path);
        },
      },
      agent: {
        async run<TStructured>(input: CodexAgentRunInput) {
          await writeWorkspaceFile(input.workingDirectory, "src/shared.ts", "proposal bytes\n");
          await writeWorkspaceFile(input.workingDirectory, "src/later.ts", "later bytes\n");
          return { threadId: "thread-proposal-1", structured: null as TStructured };
        },
      },
    });

    await expect(
      executor.apply({
        proposal: proposalFixture({
          filesToModify: ["src/shared.ts", "src/later.ts"],
        }),
        approval: approvalFixture(),
      }),
    ).rejects.toThrow(/rollback both failed/i);
    expect(await readFile(join(workspaceRoot, "src/shared.ts"), "utf8")).toBe(
      "external winner\n",
    );
  });

  it("does not claim external bytes written between the driver write and post-write verification", async () => {
    const workspaceRoot = await temporaryWorkspace();
    await writeWorkspaceFile(workspaceRoot, "src/shared.ts", "original\n");
    await writeWorkspaceFile(workspaceRoot, "src/later.ts", "original later\n");
    let writes = 0;
    const executor = new MutationExecutor({
      workspaceRoot,
      proposalThreadId: "thread-proposal-1",
      mutationDriver: {
        async write(path, contents) {
          writes += 1;
          if (writes === 1) {
            await new Promise<void>((resolve, reject) => {
              void writeFile(path, contents).then(
                () => {
                  resolve();
                  writeFileSync(path, "external interval winner\n");
                },
                reject,
              );
            });
            return;
          }
          if (writes === 2) {
            throw new Error("injected later write failure");
          }
          await writeFile(path, contents);
        },
        async remove(path) {
          await rm(path);
        },
      },
      agent: {
        async run<TStructured>(input: CodexAgentRunInput) {
          await writeWorkspaceFile(input.workingDirectory, "src/shared.ts", "proposal bytes\n");
          await writeWorkspaceFile(input.workingDirectory, "src/later.ts", "later bytes\n");
          return { threadId: "thread-proposal-1", structured: null as TStructured };
        },
      },
    });

    const failure = await executor
      .apply({
        proposal: proposalFixture({
          filesToModify: ["src/shared.ts", "src/later.ts"],
        }),
        approval: approvalFixture(),
      })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(await readFile(join(workspaceRoot, "src/shared.ts"), "utf8")).toBe(
      "external interval winner\n",
    );
    expect(failure).toMatchObject({
      failure: { targetDisposition: "RECONCILIATION_REQUIRED" },
    });
  });

  it("fails closed when the mutation turn does not continue the exact proposal thread", async () => {
    const workspaceRoot = await temporaryWorkspace();
    await writeWorkspaceFile(workspaceRoot, "src/file.ts", "before\n");
    const executor = new MutationExecutor({
      workspaceRoot,
      proposalThreadId: "thread-proposal-1",
      agent: {
        async run<TStructured>(input: CodexAgentRunInput) {
          await writeWorkspaceFile(input.workingDirectory, "src/file.ts", "after\n");
          return { threadId: "thread-other", structured: null as TStructured };
        },
      },
    });
    await expect(
      executor.apply({
        proposal: proposalFixture({ filesToModify: ["src/file.ts"] }),
        approval: approvalFixture(),
      }),
    ).rejects.toThrow(/same proposal thread/i);
    expect(await readFile(join(workspaceRoot, "src/file.ts"), "utf8")).toBe(
      "before\n",
    );
  });

  it("captures bounded Git before/after evidence and never auto-commits", async () => {
    const workspaceRoot = await temporaryWorkspace();
    await writeWorkspaceFile(workspaceRoot, "src/file.ts", "before\n");
    await execFile("git", ["init", "-b", "safe-fixture"], { cwd: workspaceRoot });
    await execFile("git", ["add", "src/file.ts"], { cwd: workspaceRoot });
    await execFile(
      "git",
      [
        "-c",
        "user.name=Design Sharingan Test",
        "-c",
        "user.email=test@example.invalid",
        "commit",
        "-m",
        "fixture",
      ],
      { cwd: workspaceRoot },
    );
    const headBefore = (await execFile("git", ["rev-parse", "HEAD"], { cwd: workspaceRoot })).stdout.trim();
    const executor = new MutationExecutor({
      workspaceRoot,
      proposalThreadId: "thread-proposal-1",
      agent: {
        async run<TStructured>(input: CodexAgentRunInput) {
          await writeWorkspaceFile(input.workingDirectory, "src/file.ts", "after\n");
          return { threadId: "thread-proposal-1", structured: null as TStructured };
        },
      },
    });
    const result = await executor.apply({
      proposal: proposalFixture({ filesToModify: ["src/file.ts"] }),
      approval: approvalFixture(),
    });
    const headAfter = (await execFile("git", ["rev-parse", "HEAD"], { cwd: workspaceRoot })).stdout.trim();

    expect(result.git).toMatchObject({
      available: true,
      branch: "safe-fixture",
      statusBefore: "",
    });
    expect(result.git.statusAfter).toContain("src/file.ts");
    expect(result.git.diffAfter).toContain("+after");
    expect(headAfter).toBe(headBefore);
  });

  it("synthesizes one authoritative patch for every approved path hidden by Git index flags", async () => {
    const workspaceRoot = await temporaryWorkspace();
    await writeWorkspaceFile(workspaceRoot, "src/skip.ts", "skip before\n");
    await writeWorkspaceFile(workspaceRoot, "src/assume.ts", "assume before\n");
    await chmod(join(workspaceRoot, "src/skip.ts"), 0o755);
    await execFile("git", ["init", "-b", "safe-fixture"], { cwd: workspaceRoot });
    await execFile("git", ["add", "."], { cwd: workspaceRoot });
    await execFile(
      "git",
      [
        "-c",
        "user.name=Design Sharingan Test",
        "-c",
        "user.email=test@example.invalid",
        "commit",
        "-m",
        "fixture",
      ],
      { cwd: workspaceRoot },
    );
    await execFile("git", ["update-index", "--skip-worktree", "src/skip.ts"], {
      cwd: workspaceRoot,
    });
    await execFile(
      "git",
      ["update-index", "--assume-unchanged", "src/assume.ts"],
      { cwd: workspaceRoot },
    );
    const executor = new MutationExecutor({
      workspaceRoot,
      proposalThreadId: "thread-proposal-1",
      agent: {
        async run<TStructured>(input: CodexAgentRunInput) {
          await writeWorkspaceFile(input.workingDirectory, "src/skip.ts", "skip after\n");
          await writeWorkspaceFile(
            input.workingDirectory,
            "src/assume.ts",
            "assume after\n",
          );
          return { threadId: "thread-proposal-1", structured: null as TStructured };
        },
      },
    });

    const result = await executor.apply({
      proposal: proposalFixture({
        filesToModify: ["src/skip.ts", "src/assume.ts"],
      }),
      approval: approvalFixture(),
    });

    expect(
      result.git.diffAfter.split("diff --git a/src/skip.ts b/src/skip.ts"),
    ).toHaveLength(2);
    expect(
      result.git.diffAfter.split("diff --git a/src/assume.ts b/src/assume.ts"),
    ).toHaveLength(2);
    expect(result.git.diffAfter).toContain("-skip before");
    expect(result.git.diffAfter).toContain("+skip after");
    expect(result.git.diffAfter).toContain("-assume before");
    expect(result.git.diffAfter).toContain("+assume after");
    expect(result.git.diffAfter).toContain("old mode 100755");
    expect(result.git.diffAfter).toContain("new mode 100755");
  });

  it("keeps the authoritative approved delta when Git metadata is unavailable", async () => {
    const workspaceRoot = await temporaryWorkspace();
    await writeWorkspaceFile(workspaceRoot, "src/file.ts", "before\n");
    const executor = new MutationExecutor({
      workspaceRoot,
      proposalThreadId: "thread-proposal-1",
      agent: {
        async run<TStructured>(input: CodexAgentRunInput) {
          await writeWorkspaceFile(input.workingDirectory, "src/file.ts", "after\n");
          return { threadId: "thread-proposal-1", structured: null as TStructured };
        },
      },
    });

    const result = await executor.apply({
      proposal: proposalFixture({ filesToModify: ["src/file.ts"] }),
      approval: approvalFixture(),
    });

    expect(result.git.available).toBe(false);
    expect(result.git.diffAfter).toContain("-before");
    expect(result.git.diffAfter).toContain("+after");
    expect(result.git.note).toContain("authoritative executor-captured approved delta");
  });

  it("reports truthful modes for executable deletes and binary create/delete evidence", async () => {
    const workspaceRoot = await temporaryWorkspace();
    await writeWorkspaceFile(workspaceRoot, "scripts/remove.sh", "#!/bin/sh\nexit 0\n");
    await chmod(join(workspaceRoot, "scripts/remove.sh"), 0o755);
    await writeFile(
      join(workspaceRoot, "assets-remove.bin"),
      Buffer.from([0, 1, 2, 3]),
    );
    await chmod(join(workspaceRoot, "assets-remove.bin"), 0o700);
    await execFile("git", ["init", "-b", "safe-fixture"], { cwd: workspaceRoot });
    const executor = new MutationExecutor({
      workspaceRoot,
      proposalThreadId: "thread-proposal-1",
      agent: {
        async run<TStructured>(input: CodexAgentRunInput) {
          await rm(join(input.workingDirectory, "scripts/remove.sh"));
          await rm(join(input.workingDirectory, "assets-remove.bin"));
          await writeFile(
            join(input.workingDirectory, "assets-create.bin"),
            Buffer.from([0, 4, 5, 6]),
          );
          return { threadId: "thread-proposal-1", structured: null as TStructured };
        },
      },
    });

    const result = await executor.apply({
      proposal: proposalFixture({
        filesToCreate: ["assets-create.bin"],
        filesToModify: [],
        filesToDelete: ["scripts/remove.sh", "assets-remove.bin"],
      }),
      approval: approvalFixture(),
    });

    expect(result.git.diffAfter).toContain("deleted file mode 100755");
    expect(result.git.diffAfter).toContain("new file mode 100644");
    expect(result.git.diffAfter).toContain(
      "Binary files /dev/null and b/assets-create.bin differ",
    );
    expect(result.git.diffAfter).toContain("deleted file mode 100700");
    expect(result.git.diffAfter).toContain(
      "Binary files a/assets-remove.bin and /dev/null differ",
    );
  });

  it("includes exact before/after patches for approved untracked modify and delete operations", async () => {
    const workspaceRoot = await temporaryWorkspace();
    await writeWorkspaceFile(
      workspaceRoot,
      "src/untracked-modify.ts",
      "export const reviewState = 'before';\n",
    );
    await writeWorkspaceFile(
      workspaceRoot,
      "src/untracked-delete.ts",
      "export const obsolete = true;\n",
    );
    await execFile("git", ["init", "-b", "safe-fixture"], { cwd: workspaceRoot });
    const executor = new MutationExecutor({
      workspaceRoot,
      proposalThreadId: "thread-proposal-1",
      agent: {
        async run<TStructured>(input: CodexAgentRunInput) {
          await writeWorkspaceFile(
            input.workingDirectory,
            "src/untracked-modify.ts",
            "export const reviewState = 'after';\n",
          );
          await rm(join(input.workingDirectory, "src/untracked-delete.ts"));
          return { threadId: "thread-proposal-1", structured: null as TStructured };
        },
      },
    });

    const result = await executor.apply({
      proposal: proposalFixture({
        filesToCreate: [],
        filesToModify: ["src/untracked-modify.ts"],
        filesToDelete: ["src/untracked-delete.ts"],
      }),
      approval: approvalFixture(),
    });

    expect(result.git.diffAfter).toContain("diff --git a/src/untracked-modify.ts b/src/untracked-modify.ts");
    expect(result.git.diffAfter).toContain("-export const reviewState = 'before';");
    expect(result.git.diffAfter).toContain("+export const reviewState = 'after';");
    expect(result.git.diffAfter).toContain("diff --git a/src/untracked-delete.ts b/src/untracked-delete.ts");
    expect(result.git.diffAfter).toContain("-export const obsolete = true;");
    expect(result.git.diffAfter).not.toContain("src/unapproved");
  });

  it("limits Git diff evidence to approved paths and includes approved created-file content", async () => {
    const workspaceRoot = await temporaryWorkspace();
    await writeWorkspaceFile(workspaceRoot, "src/file.ts", "before\n");
    await writeWorkspaceFile(workspaceRoot, "private/unrelated.txt", "clean\n");
    await execFile("git", ["init", "-b", "safe-fixture"], { cwd: workspaceRoot });
    await execFile("git", ["add", "."], { cwd: workspaceRoot });
    await execFile(
      "git",
      [
        "-c",
        "user.name=Design Sharingan Test",
        "-c",
        "user.email=test@example.invalid",
        "commit",
        "-m",
        "fixture",
      ],
      { cwd: workspaceRoot },
    );
    await writeWorkspaceFile(
      workspaceRoot,
      "private/unrelated.txt",
      "UNRELATED-TOP-SECRET\n",
    );
    const executor = new MutationExecutor({
      workspaceRoot,
      proposalThreadId: "thread-proposal-1",
      agent: {
        async run<TStructured>(input: CodexAgentRunInput) {
          await writeWorkspaceFile(
            input.workingDirectory,
            "src/created.ts",
            "export const approvedCreate = true;\n",
          );
          return { threadId: "thread-proposal-1", structured: null as TStructured };
        },
      },
    });

    const result = await executor.apply({
      proposal: proposalFixture({
        filesToCreate: ["src/created.ts"],
        filesToModify: [],
      }),
      approval: approvalFixture(),
    });

    expect(result.git.statusAfter).toContain("private/unrelated.txt");
    expect(result.git.diffAfter).toContain("src/created.ts");
    expect(result.git.diffAfter).toContain("+export const approvedCreate = true;");
    expect(result.git.diffAfter).not.toContain("private/unrelated.txt");
    expect(result.git.diffAfter).not.toContain("UNRELATED-TOP-SECRET");
  });

  it("bounds oversized multibyte Git evidence with collision-safe truncation metadata", async () => {
    const workspaceRoot = await temporaryWorkspace();
    await execFile("git", ["init", "-b", "safe-fixture"], { cwd: workspaceRoot });
    const executor = new MutationExecutor({
      workspaceRoot,
      proposalThreadId: "thread-proposal-1",
      agent: {
        async run<TStructured>(input: CodexAgentRunInput) {
          await writeWorkspaceFile(
            input.workingDirectory,
            "src/created.ts",
            `${"界 bounded evidence line\n".repeat(12_000)}`,
          );
          return { threadId: "thread-proposal-1", structured: null as TStructured };
        },
      },
    });

    const result = await executor.apply({
      proposal: proposalFixture({
        filesToCreate: ["src/created.ts"],
        filesToModify: [],
      }),
      approval: approvalFixture(),
    });

    expect(Buffer.byteLength(result.git.diffAfter, "utf8")).toBeLessThanOrEqual(
      128 * 1024,
    );
    expect(result.git.diffAfter).not.toContain("[Git evidence truncated]");
    expect(result.git.truncation.diffAfter).toMatchObject({
      truncated: true,
      retainedBytes: Buffer.byteLength(result.git.diffAfter, "utf8"),
    });
    expect(result.git.truncation.diffAfter.originalBytes).toBeGreaterThan(
      result.git.truncation.diffAfter.retainedBytes,
    );
  });

  it("preserves literal truncation-marker content without marking evidence truncated", async () => {
    const workspaceRoot = await temporaryWorkspace();
    await execFile("git", ["init", "-b", "safe-fixture"], { cwd: workspaceRoot });
    const executor = new MutationExecutor({
      workspaceRoot,
      proposalThreadId: "thread-proposal-1",
      agent: {
        async run<TStructured>(input: CodexAgentRunInput) {
          await writeWorkspaceFile(
            input.workingDirectory,
            "src/created.ts",
            "[Git evidence truncated]\n",
          );
          return { threadId: "thread-proposal-1", structured: null as TStructured };
        },
      },
    });

    const result = await executor.apply({
      proposal: proposalFixture({
        filesToCreate: ["src/created.ts"],
        filesToModify: [],
      }),
      approval: approvalFixture(),
    });

    expect(result.git.diffAfter).toContain("+[Git evidence truncated]");
    expect(result.git.truncation.diffAfter).toEqual({
      truncated: false,
      limitBytes: 128 * 1024,
      originalBytes: Buffer.byteLength(result.git.diffAfter, "utf8"),
      retainedBytes: Buffer.byteLength(result.git.diffAfter, "utf8"),
    });
  });

  it("does not execute repository-configured fsmonitor, textconv, or external diff helpers", async () => {
    const workspaceRoot = await temporaryWorkspace();
    const outsideRoot = await temporaryWorkspace();
    const sentinelPath = join(outsideRoot, "helper-invoked.txt");
    const helperPath = join(outsideRoot, "malicious-helper.mjs");
    await writeFile(
      helperPath,
      `#!/usr/bin/env node\nimport { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(sentinelPath)}, "invoked\\n");\n`,
      "utf8",
    );
    await chmod(helperPath, 0o700);
    await writeWorkspaceFile(workspaceRoot, "src/file.ts", "before\n");
    await writeWorkspaceFile(workspaceRoot, ".gitattributes", "src/file.ts diff=unsafe\n");
    await execFile("git", ["init", "-b", "safe-fixture"], { cwd: workspaceRoot });
    await execFile("git", ["add", "."], { cwd: workspaceRoot });
    await execFile(
      "git",
      [
        "-c",
        "core.fsmonitor=false",
        "-c",
        "diff.external=",
        "-c",
        "user.name=Design Sharingan Test",
        "-c",
        "user.email=test@example.invalid",
        "commit",
        "-m",
        "fixture",
      ],
      { cwd: workspaceRoot },
    );
    await execFile("git", ["config", "core.fsmonitor", helperPath], {
      cwd: workspaceRoot,
    });
    await execFile("git", ["config", "diff.unsafe.textconv", helperPath], {
      cwd: workspaceRoot,
    });
    await execFile("git", ["config", "diff.external", helperPath], {
      cwd: workspaceRoot,
    });
    const executor = new MutationExecutor({
      workspaceRoot,
      proposalThreadId: "thread-proposal-1",
      agent: {
        async run<TStructured>(input: CodexAgentRunInput) {
          await writeWorkspaceFile(input.workingDirectory, "src/file.ts", "after\n");
          return { threadId: "thread-proposal-1", structured: null as TStructured };
        },
      },
    });

    await executor.apply({
      proposal: proposalFixture({ filesToModify: ["src/file.ts"] }),
      approval: approvalFixture(),
    });

    await expect(readFile(sentinelPath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("redacts sensitive environment values from an approved Git diff", async () => {
    const workspaceRoot = await temporaryWorkspace();
    const secret = "task-nine-sensitive-token-value";
    const previous = process.env.DESIGN_SHARINGAN_TEST_SECRET;
    process.env.DESIGN_SHARINGAN_TEST_SECRET = secret;
    try {
      await writeWorkspaceFile(workspaceRoot, "src/file.ts", "before\n");
      await execFile("git", ["init", "-b", "safe-fixture"], { cwd: workspaceRoot });
      await execFile("git", ["add", "."], { cwd: workspaceRoot });
      await execFile(
        "git",
        [
          "-c",
          "user.name=Design Sharingan Test",
          "-c",
          "user.email=test@example.invalid",
          "commit",
          "-m",
          "fixture",
        ],
        { cwd: workspaceRoot },
      );
      const executor = new MutationExecutor({
        workspaceRoot,
        proposalThreadId: "thread-proposal-1",
        agent: {
          async run<TStructured>(input: CodexAgentRunInput) {
            await writeWorkspaceFile(
              input.workingDirectory,
              "src/file.ts",
              `export const token = ${JSON.stringify(secret)};\n`,
            );
            return { threadId: "thread-proposal-1", structured: null as TStructured };
          },
        },
      });

      const result = await executor.apply({
        proposal: proposalFixture({ filesToModify: ["src/file.ts"] }),
        approval: approvalFixture(),
      });

      expect(result.git.diffAfter).not.toContain(secret);
      expect(result.git.diffAfter).toContain("[REDACTED]");
    } finally {
      if (previous === undefined) {
        delete process.env.DESIGN_SHARINGAN_TEST_SECRET;
      } else {
        process.env.DESIGN_SHARINGAN_TEST_SECRET = previous;
      }
    }
  });
});
