import { CodexAgent } from "@design-sharingan/agent-runtime";
import type {
  EvolveAgent,
  EvolveWireOutput,
} from "@design-sharingan/sharingan-engine";

const fakeOutput: EvolveWireOutput = {
  uxImpact: [
    {
      area: "Reference review",
      severity: "IMPORTANT",
      reason: "The new state changes how unresolved evidence is prioritized.",
      affectedRoutes: ["/projects/:projectId/references"],
      affectedComponents: ["ReferenceCard"],
      decisionRequired: true,
    },
    {
      area: "Reports evidence",
      severity: "POLISH",
      reason: "Review decisions need a durable session trail.",
      affectedRoutes: ["/projects/:projectId/reports"],
      affectedComponents: ["SessionLedger"],
      decisionRequired: false,
    },
  ],
  approaches: [
    {
      id: "approach-guided-queue",
      title: "Guided evidence queue",
      summary: "Create an explicit review queue inside the existing References workspace.",
      recommended: true,
      pros: [
        "Preserves the current navigation architecture",
        "Makes unresolved evidence and the next action explicit",
      ],
      cons: ["Adds one durable review state to each reference"],
      uxImpact: [
        {
          area: "Reference review",
          severity: "IMPORTANT",
          reason: "The queue becomes the primary triage surface.",
          affectedRoutes: ["/projects/:projectId/references"],
          affectedComponents: ["ReferenceCard", "ReferenceLibrary"],
          decisionRequired: true,
        },
      ],
      estimatedComplexity: "MEDIUM",
      genomeFit: "Strong fit with the calm, evidence-first product direction.",
      likelyFiles: [
        "features/references/reference-card.tsx",
        "features/references/reference-library.tsx",
      ],
      status: "PROPOSED",
    },
    {
      id: "approach-inline-markers",
      title: "Inline review markers",
      summary: "Add quiet unresolved markers and actions to the existing reference grid.",
      recommended: false,
      pros: ["Small visual footprint", "Keeps the existing grid dominant"],
      cons: ["Review priority is less explicit", "Dense libraries may become harder to scan"],
      uxImpact: [
        {
          area: "Reference cards",
          severity: "POLISH",
          reason: "Each card gains state and action affordances.",
          affectedRoutes: ["/projects/:projectId/references"],
          affectedComponents: ["ReferenceCard"],
          decisionRequired: true,
        },
      ],
      estimatedComplexity: "LOW",
      genomeFit: "Compatible, but less aligned with explicit evidence hierarchy.",
      likelyFiles: ["features/references/reference-card.tsx"],
      status: "PROPOSED",
    },
  ],
};

export function createEvolveAgent(): EvolveAgent {
  if (process.env.DESIGN_SHARINGAN_FAKE_AGENT === "1") {
    return {
      async run<TStructured>() {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 250);
        });
        return {
          threadId: "fake-feature-evolve-thread",
          finalResponse: JSON.stringify(fakeOutput),
          structured: fakeOutput as TStructured,
          items: [],
        };
      },
    };
  }
  return new CodexAgent();
}
