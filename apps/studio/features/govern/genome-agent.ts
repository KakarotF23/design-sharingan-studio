import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CodexAgent } from "@design-sharingan/agent-runtime";
import type { CodexAgentRunInput } from "@design-sharingan/agent-runtime";
import type {
  GenomeInitAgent,
  GenomeInitWireOutput,
} from "@design-sharingan/eternal-engine";

export function createGenomeInitAgent(routes: readonly string[]): GenomeInitAgent {
  if (process.env.DESIGN_SHARINGAN_FAKE_AGENT === "1") {
    const fakeOutput: GenomeInitWireOutput = {
      productIdentity: {
        statement: "A calm, local-first product with deliberate human design decisions.",
        confidence: "CONFIRMED",
        evidence: ["Authenticated project manifest and representative route evidence"],
      },
      rules: [
        {
          category: "UX_INVARIANT",
          statement: "Keep primary decisions explicit and reversible.",
          confidence: "CONFIRMED",
          evidence: ["Representative project workflow"],
        },
        {
          category: "VISUAL_INVARIANT",
          statement: "Use restrained contrast to separate primary action from evidence.",
          confidence: "UNCONFIRMED",
          evidence: ["Representative route evidence only"],
        },
        {
          category: "ACCESSIBILITY_RULE",
          statement: "Preserve visible focus and readable contrast.",
          confidence: "CONFIRMED",
          evidence: ["Shared interaction surface"],
        },
        {
          category: "SCREEN_FAMILY",
          statement: "Project workspaces",
          confidence: "CONFIRMED",
          evidence: ["Authenticated route structure"],
        },
        {
          category: "CONTENT_VOICE",
          statement: "Use calm, technical, and direct language.",
          confidence: "CONFIRMED",
          evidence: ["Representative project copy"],
        },
      ],
      screens: routes.map((route) => ({
        route,
        name: route === "/" ? "Home" : route.split("/").filter(Boolean).at(-1) ?? "Screen",
        family: "Project workspaces",
        inheritedRules: [
          "Keep primary decisions explicit and reversible.",
          "Preserve visible focus and readable contrast.",
        ],
        exceptions: [],
        requiredStates: ["default", "loading", "error"],
      })),
    };
    return {
      async run<TStructured>(input: CodexAgentRunInput) {
        await writeFile(
          join(input.workingDirectory, "genome-agent-probe.tmp"),
          "Genome initialization analysis scratch.\n",
          { mode: 0o600 },
        );
        await new Promise<void>((resolve) => setTimeout(resolve, 120));
        return {
          threadId: "fake-genome-init-thread",
          finalResponse: JSON.stringify(fakeOutput),
          structured: fakeOutput as TStructured,
          items: [],
        };
      },
    };
  }
  return new CodexAgent();
}
