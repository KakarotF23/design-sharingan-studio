import type {
  CodexAgentResult,
  CodexAgentRunInput,
} from "@design-sharingan/agent-runtime";
import type { FeatureBrief, UXImpact } from "@design-sharingan/core";
import { describe, expect, it } from "vitest";
import {
  evolveFeature,
  type EvolveWireOutput,
} from "../evolve";

const featureBrief: FeatureBrief = {
  name: "Evidence inbox",
  goal: "Help teams triage new design evidence without losing context.",
  description: "Add a bounded inbox for unreviewed visual evidence.",
  constraints: ["Use the existing project rail"],
  mustKeep: ["Reports remain the durable history"],
  mustNotChange: ["Do not add navigation destinations"],
  successCriteria: ["A reviewer can triage an item in under one minute"],
};

const impact: UXImpact = {
  area: "Reference review",
  severity: "IMPORTANT",
  reason: "The new state changes how unresolved evidence is prioritized.",
  affectedRoutes: ["/projects/:projectId/references"],
  affectedComponents: ["ReferenceCard"],
  decisionRequired: true,
};

function approach(
  id: string,
  recommended: boolean,
  overrides: Partial<EvolveWireOutput["approaches"][number]> = {},
): EvolveWireOutput["approaches"][number] {
  return {
    id,
    title: recommended ? "Guided evidence queue" : "Inline review markers",
    summary: "Make unresolved evidence explicit without changing navigation.",
    recommended,
    pros: ["Preserves the current information architecture"],
    cons: ["Adds one more state to each reference row"],
    uxImpact: [impact],
    estimatedComplexity: "MEDIUM",
    genomeFit: "Fits the calm, evidence-first interaction model.",
    likelyFiles: ["features/references/reference-card.tsx"],
    status: "PROPOSED",
    ...overrides,
  };
}

const wireOutput: EvolveWireOutput = {
  uxImpact: [impact],
  approaches: [
    approach("approach-guided-queue", true),
    approach("approach-inline-markers", false),
  ],
};

function agentReturning(structured: unknown) {
  let runInput: CodexAgentRunInput | undefined;
  return {
    agent: {
      async run<TStructured>(input: CodexAgentRunInput) {
        runInput = input;
        return {
          threadId: "thread-evolve-1",
          finalResponse: JSON.stringify(structured),
          structured: structured as TStructured,
          items: [],
        } satisfies CodexAgentResult<TStructured>;
      },
    },
    input: () => runInput,
  };
}

const evolveInput = {
  featureBrief,
  referenceAnalyses: [],
  analysisWorkingDirectory: "/app-state/evolve-1",
  projectContext: {
    name: "Fixture product",
    framework: "nextjs",
    routes: ["/", "/projects/:projectId/references"],
    componentDirectories: ["features", "components"],
    designDocuments: ["DESIGN.md"],
  },
} as const;

describe("evolveFeature", () => {
  // Production break caught: a prose or incomplete result could otherwise
  // bypass the human comparison gate, while target-root execution would let V1
  // implement before an approach is approved.
  it("returns exactly validated UX approaches from an isolated read-only analysis turn", async () => {
    const fake = agentReturning(wireOutput);

    const result = await evolveFeature(evolveInput, { agent: fake.agent });

    const runInput = fake.input();
    expect(runInput?.workingDirectory).toBe("/app-state/evolve-1");
    expect(runInput?.outputSchema).toMatchObject({
      type: "object",
      required: ["uxImpact", "approaches"],
      additionalProperties: false,
    });
    expect(runInput?.prompt).toContain("inspect only the staged project context");
    expect(runInput?.prompt).toContain("affected routes");
    expect(runInput?.prompt).toContain("affected components");
    expect(runInput?.prompt).toContain("navigation impact");
    expect(runInput?.prompt).toContain("UX risk");
    expect(runInput?.prompt).toContain("required states");
    expect(runInput?.prompt).toContain("design-system implications");
    expect(runInput?.prompt).toContain("Do not write code");
    expect(runInput?.prompt).toContain("explicit human approval");
    expect(runInput?.prompt).toContain(featureBrief.name);
    expect(result).toEqual({
      uxImpact: wireOutput.uxImpact,
      approaches: wireOutput.approaches,
      threadId: "thread-evolve-1",
    });
  });

  // Production break caught: accepting the wrong count or recommendation
  // cardinality removes the explicit comparison decision the product requires.
  it.each([
    ["one approach", { ...wireOutput, approaches: wireOutput.approaches.slice(0, 1) }],
    [
      "four approaches",
      {
        ...wireOutput,
        approaches: [
          ...wireOutput.approaches,
          approach("approach-third", false),
          approach("approach-fourth", false),
        ],
      },
    ],
    [
      "no recommendation",
      {
        ...wireOutput,
        approaches: wireOutput.approaches.map((entry) => ({
          ...entry,
          recommended: false,
        })),
      },
    ],
    [
      "two recommendations",
      {
        ...wireOutput,
        approaches: wireOutput.approaches.map((entry) => ({
          ...entry,
          recommended: true,
        })),
      },
    ],
  ] as const)("rejects %s", async (_label, malformed) => {
    const fake = agentReturning(malformed);
    await expect(
      evolveFeature(evolveInput, { agent: fake.agent }),
    ).rejects.toThrow(/approach|recommended/i);
  });

  // Production break caught: a visually plausible approach with missing
  // trade-offs, UX evidence, file likelihood, or undeclared agent keys is not a
  // reviewable structured decision.
  it.each([
    [
      "empty pros",
      {
        ...wireOutput,
        approaches: [approach("approach-guided-queue", true, { pros: [] }), wireOutput.approaches[1]],
      },
    ],
    [
      "empty cons",
      {
        ...wireOutput,
        approaches: [approach("approach-guided-queue", true, { cons: [] }), wireOutput.approaches[1]],
      },
    ],
    [
      "empty UX impact",
      {
        ...wireOutput,
        approaches: [approach("approach-guided-queue", true, { uxImpact: [] }), wireOutput.approaches[1]],
      },
    ],
    [
      "empty likely files",
      {
        ...wireOutput,
        approaches: [approach("approach-guided-queue", true, { likelyFiles: [] }), wireOutput.approaches[1]],
      },
    ],
    [
      "duplicate ids",
      {
        ...wireOutput,
        approaches: [wireOutput.approaches[0], { ...wireOutput.approaches[1], id: wireOutput.approaches[0].id }],
      },
    ],
    [
      "an undeclared key",
      {
        ...wireOutput,
        approaches: [{ ...wireOutput.approaches[0], implementationPatch: "hidden" }, wireOutput.approaches[1]],
      },
    ],
  ] as const)("rejects %s", async (_label, malformed) => {
    const fake = agentReturning(malformed);
    await expect(
      evolveFeature(evolveInput, { agent: fake.agent }),
    ).rejects.toThrow(/structured|approach/i);
  });
});
