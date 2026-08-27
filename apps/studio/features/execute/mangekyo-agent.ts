import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CodexAgent } from "@design-sharingan/agent-runtime";
import type { CodexAgentRunInput } from "@design-sharingan/agent-runtime";
import type { MutationAgent, ProposalAgent } from "@design-sharingan/approval-engine";
import type { VisualAnalysisAgent } from "@design-sharingan/visual-engine";

const styleProposal = {
  summary: "Strengthen the primary evidence hierarchy.",
  reason: "The current render needs a clearer primary signal without changing behavior or navigation.",
  filesToCreate: [] as string[],
  filesToModify: ["styles.css"],
  filesToDelete: [] as string[],
  componentsAffected: ["Evidence surface"],
  screensAffected: ["/"],
  uxImpact: [{
    area: "Visual hierarchy",
    severity: "IMPORTANT" as const,
    reason: "Improves scan order while preserving the existing interaction model.",
    affectedRoutes: ["/"],
    affectedComponents: ["Evidence surface"],
    decisionRequired: false,
  }],
  visualImpact: "Raises heading contrast and clarifies the rendered evidence hierarchy.",
  riskLevel: "LOW" as const,
  requiresHumanApproval: true as const,
  policyViolations: [] as string[],
  status: "PROPOSED" as const,
};

const navigationProposal = {
  summary: "Introduce a reference-led navigation treatment.",
  reason: "The remaining comparison suggests changing how users move through the surface.",
  filesToCreate: [] as string[],
  filesToModify: ["server.mjs"],
  filesToDelete: [] as string[],
  componentsAffected: ["Primary navigation"],
  screensAffected: ["/"],
  uxImpact: [{
    area: "Navigation",
    severity: "CRITICAL" as const,
    reason: "This would change the product navigation model and requires a human decision.",
    affectedRoutes: ["/"],
    affectedComponents: ["Primary navigation"],
    decisionRequired: true,
  }],
  visualImpact: "Changes the visible navigation structure.",
  riskLevel: "HIGH" as const,
  requiresHumanApproval: true as const,
  policyViolations: ["NAVIGATION_CHANGE"],
  status: "PROPOSED" as const,
};

export function createMangekyoProposalAgent(roundNumber: number): ProposalAgent {
  if (process.env.DESIGN_SHARINGAN_FAKE_AGENT === "1") {
    return {
      async run<TStructured>(input: CodexAgentRunInput) {
        await new Promise<void>((resolve) => setTimeout(resolve, 150));
        return {
          threadId: input.threadId ?? `fake-mangekyo-proposal-round-${roundNumber}`,
          structured: (roundNumber === 1 ? styleProposal : navigationProposal) as TStructured,
        };
      },
    };
  }
  return new CodexAgent();
}

export function createMangekyoMutationAgent(): MutationAgent {
  if (process.env.DESIGN_SHARINGAN_FAKE_AGENT === "1") {
    return {
      async run<TStructured>(input: CodexAgentRunInput) {
        await new Promise<void>((resolve) => setTimeout(resolve, 150));
        if (input.prompt.includes('"styles.css"')) {
          const path = join(input.workingDirectory, "styles.css");
          const source = await readFile(path, "utf8");
          await writeFile(
            path,
            `${source.trimEnd()}\n\n/* Mangekyō round 1: bounded hierarchy refinement */\nh1 { letter-spacing: -0.045em; text-wrap: balance; }\n`,
            "utf8",
          );
        } else if (input.prompt.includes('"server.mjs"')) {
          const path = join(input.workingDirectory, "server.mjs");
          const source = await readFile(path, "utf8");
          await writeFile(
            path,
            source.replace("<main>", '<main data-mangekyo-navigation="approved">'),
            "utf8",
          );
        }
        return {
          threadId: input.threadId ?? "fake-mangekyo-mutation-thread",
          structured: null as TStructured,
        };
      },
    };
  }
  return new CodexAgent();
}

export function createMangekyoVisualAgent(): VisualAnalysisAgent {
  if (process.env.DESIGN_SHARINGAN_FAKE_AGENT === "1") {
    return {
      async run<TStructured>(input: CodexAgentRunInput) {
        await new Promise<void>((resolve) => setTimeout(resolve, 150));
        return {
          threadId: input.threadId ?? "fake-mangekyo-visual-thread",
          finalResponse: "",
          items: [],
          structured: {
            findings: [
              {
                severity: "IMPORTANT",
                category: "HIERARCHY",
                screen: "/",
                description: "Primary evidence hierarchy remains under-emphasized.",
                evidence: ["The rendered heading and support copy retain similar visual weight."],
                reason: "The first scan does not establish a decisive entry point.",
                recommendedAction: "Refine one hierarchy objective while preserving navigation.",
              },
              {
                severity: "IMPORTANT",
                category: "SPACING",
                screen: "/",
                description: "Evidence groups need clearer separation.",
                evidence: ["The captured sections read as one continuous block."],
                reason: "Weak grouping makes comparison slower.",
                recommendedAction: "Increase separation between evidence groups.",
              },
              {
                severity: "IMPORTANT",
                category: "LAYOUT",
                screen: "/",
                description: "The comparison path is not yet explicit.",
                evidence: ["The current render does not visually sequence the primary evidence."],
                reason: "Users must infer the intended reading order.",
                recommendedAction: "Clarify the visual sequence without changing behavior.",
              },
            ],
          } as TStructured,
        };
      },
    };
  }
  return new CodexAgent();
}
