import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CodexAgent } from "@design-sharingan/agent-runtime";
import type { CodexAgentRunInput } from "@design-sharingan/agent-runtime";
import type {
  MutationAgent,
  ProposalAgent,
} from "@design-sharingan/approval-engine";

const fakeProposal = {
  summary: "Add a bounded fixture description.",
  reason: "Exercise the Safe Mode approval boundary with one harmless manifest edit.",
  filesToCreate: [] as string[],
  filesToModify: ["package.json"],
  filesToDelete: [] as string[],
  componentsAffected: ["Project fixture metadata"],
  screensAffected: ["Development fixture"],
  uxImpact: [
    {
      area: "Fixture metadata",
      severity: "POLISH" as const,
      reason: "The change is visible only in project metadata and does not alter navigation or runtime behavior.",
      affectedRoutes: [] as string[],
      affectedComponents: ["Project fixture metadata"],
      decisionRequired: false,
    },
  ],
  visualImpact: "No rendered visual change; this is a controlled mutation proof.",
  riskLevel: "LOW" as const,
  requiresHumanApproval: true as const,
  policyViolations: [] as string[],
  status: "PROPOSED" as const,
};

export function createSafeProposalAgent(): ProposalAgent {
  if (process.env.DESIGN_SHARINGAN_FAKE_AGENT === "1") {
    return {
      async run<TStructured>(input: CodexAgentRunInput) {
        await new Promise<void>((resolve) => setTimeout(resolve, 250));
        return {
          threadId: input.threadId ?? "fake-safe-mode-proposal-thread",
          structured: fakeProposal as TStructured,
        };
      },
    };
  }
  return new CodexAgent();
}

export function createSafeMutationAgent(): MutationAgent {
  if (process.env.DESIGN_SHARINGAN_FAKE_AGENT === "1") {
    return {
      async run<TStructured>(input: CodexAgentRunInput) {
        await new Promise<void>((resolve) => setTimeout(resolve, 250));
        const packagePath = join(input.workingDirectory, "package.json");
        const project = JSON.parse(await readFile(packagePath, "utf8")) as Record<
          string,
          unknown
        >;
        await writeFile(
          packagePath,
          `${JSON.stringify(
            {
              ...project,
              description: "Design Sharingan Safe Mode fixture",
            },
            null,
            2,
          )}\n`,
          "utf8",
        );
        return {
          threadId: input.threadId ?? "fake-safe-mode-proposal-thread",
          structured: null as TStructured,
        };
      },
    };
  }
  return new CodexAgent();
}
