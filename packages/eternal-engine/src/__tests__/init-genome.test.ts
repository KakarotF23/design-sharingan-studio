import type {
  CodexAgentResult,
  CodexAgentRunInput,
} from "@design-sharingan/agent-runtime";
import { describe, expect, it } from "vitest";
import {
  initializeGenome,
  type GenomeInitWireOutput,
} from "../init-genome";

const output: GenomeInitWireOutput = {
    productIdentity: {
    statement: "A calm local-first design intelligence environment.",
    confidence: "CONFIRMED",
    evidence: ["ev_doc_readme_01"],
  },
  rules: [
    {
      category: "UX_INVARIANT",
      statement: "Keep human decisions explicit.",
      confidence: "CONFIRMED",
      evidence: ["ev_render_overview_01"],
    },
    {
      category: "VISUAL_INVARIANT",
      statement: "Dense evidence panels may use glowing borders.",
      confidence: "UNCONFIRMED",
      evidence: ["ev_render_overview_01"],
    },
    {
      category: "ACCESSIBILITY_RULE",
      statement: "Maintain visible focus.",
      confidence: "CONFIRMED",
      evidence: ["ev_component_button_01"],
    },
    {
      category: "SCREEN_FAMILY",
      statement: "Project workspaces",
      confidence: "CONFIRMED",
      evidence: ["ev_component_shell_01"],
    },
  ],
  screens: [
    {
      route: "/overview",
      name: "Overview",
      family: "Project workspaces",
      inheritedRules: ["Keep human decisions explicit."],
      exceptions: [],
      requiredStates: ["ready", "needs-configuration"],
    },
  ],
};

function agentWith(structured: unknown) {
  const calls: CodexAgentRunInput[] = [];
  return {
    calls,
    agent: {
      async run<TStructured>(input: CodexAgentRunInput): Promise<CodexAgentResult<TStructured>> {
        calls.push(input);
        return {
          threadId: "genome-thread",
          finalResponse: JSON.stringify(structured),
          structured: structured as TStructured,
          items: [],
        };
      },
    },
  };
}

describe("Design Genome initialization", () => {
  it("starts DRAFT and moves uncertain agent rules into unconfirmedRules", async () => {
    const fake = agentWith(output);
    let nextId = 0;

    const result = await initializeGenome(
      {
        workingDirectory: "/authenticated/project",
        projectContext: {
          projectId: "project-a",
          name: "Studio fixture",
          framework: "nextjs",
          routes: ["/overview", "/learn"],
          componentDirectories: ["components"],
          designDocuments: ["README.md"],
        },
        representativeEvidence: [
          {
            route: "/overview",
            observations: ["Stable project rail and explicit status."],
            evidence: [
              { id: "ev_render_overview_01", kind: "RENDER", excerpt: "Authenticated current overview render." },
              { id: "ev_doc_readme_01", kind: "DOCUMENT", excerpt: "A calm local-first design intelligence environment." },
              { id: "ev_component_button_01", kind: "COMPONENT", excerpt: "Button focus styles are shared." },
              { id: "ev_component_shell_01", kind: "COMPONENT", excerpt: "The project shell is shared." },
            ],
          },
        ],
      },
      {
        agent: fake.agent,
        createId: () => `screen-${++nextId}`,
      },
    );

    expect(result.genome.status).toBe("DRAFT");
    expect(result.genome.uxInvariants).toEqual(["Keep human decisions explicit."]);
    expect(result.genome.visualInvariants).toEqual([]);
    expect(result.genome.unconfirmedRules).toEqual(expect.arrayContaining([
      "Dense evidence panels may use glowing borders.",
      "Representative evidence does not establish whole-product coverage.",
    ]));
    expect(result.screens).toEqual([
      {
        id: "screen-1",
        route: "/overview",
        name: "Overview",
        family: "Project workspaces",
        inheritedRules: ["Keep human decisions explicit."],
        exceptions: [],
        requiredStates: ["ready", "needs-configuration"],
        evidence: [
          "ev_render_overview_01",
          "ev_doc_readme_01",
          "ev_component_button_01",
          "ev_component_shell_01",
        ],
        driftStatus: "NOT_VERIFIED",
      },
    ]);
    expect(result.threadId).toBe("genome-thread");
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.workingDirectory).toBe("/authenticated/project");
    expect(fake.calls[0]?.prompt).toContain("Representative /overview evidence");
    expect(fake.calls[0]?.prompt).toMatch(/do not claim whole-product coverage/i);
    expect(fake.calls[0]?.outputSchema).toBeDefined();
  });

  it("rejects fabricated screen coverage outside representative evidence", async () => {
    const fake = agentWith({
      ...output,
      screens: [{ ...output.screens[0], route: "/uninspected" }],
    });

    await expect(
      initializeGenome(
        {
          workingDirectory: "/authenticated/project",
          projectContext: {
            projectId: "project-a",
            name: "Studio fixture",
            routes: ["/overview", "/uninspected"],
            componentDirectories: [],
            designDocuments: [],
          },
          representativeEvidence: [
            {
              route: "/overview",
              observations: ["Observed."],
              evidence: [{ id: "ev_render_overview_01", kind: "RENDER", excerpt: "Observed." }],
            },
          ],
        },
        { agent: fake.agent, createId: () => "screen-1" },
      ),
    ).rejects.toThrow(/representative evidence/i);
  });

  it("rejects missing representative evidence instead of fabricating coverage", async () => {
    const fake = agentWith(output);

    await expect(
      initializeGenome(
        {
          workingDirectory: "/authenticated/project",
          projectContext: {
            projectId: "project-a",
            name: "Studio fixture",
            routes: ["/overview"],
            componentDirectories: [],
            designDocuments: [],
          },
          representativeEvidence: [],
        },
        { agent: fake.agent, createId: () => "screen-1" },
      ),
    ).rejects.toThrow(/representative evidence/i);
    expect(fake.calls).toHaveLength(0);
  });

  it("downgrades fabricated CONFIRMED citations and scrubs paths and secrets", async () => {
    const malicious = structuredClone(output);
    malicious.rules[0] = {
      ...malicious.rules[0]!,
      statement: "Read /Users/alice/private/.env using sk-secret-1234567890",
      confidence: "CONFIRMED",
      evidence: ["ev_unknown_fabricated"],
    };
    const fake = agentWith(malicious);

    const result = await initializeGenome(
      {
        workingDirectory: "/authenticated/project",
        projectContext: {
          projectId: "project-a",
          name: "Studio fixture",
          routes: ["/overview"],
          componentDirectories: [],
          designDocuments: [],
        },
        representativeEvidence: [{
          route: "/overview",
          observations: ["Observed."],
          evidence: [
            { id: "ev_render_overview_01", kind: "RENDER", excerpt: "Observed." },
            { id: "ev_doc_readme_01", kind: "DOCUMENT", excerpt: "Product." },
            { id: "ev_component_button_01", kind: "COMPONENT", excerpt: "Focus." },
            { id: "ev_component_shell_01", kind: "COMPONENT", excerpt: "Shell." },
          ],
        }],
      },
      { agent: fake.agent, createId: () => "screen-1" },
    );

    expect(result.genome.uxInvariants).toEqual([]);
    expect(result.genome.unconfirmedRules.join(" ")).not.toMatch(/\/Users\/|sk-secret/);
    expect(result.genome.unconfirmedRules.join(" ")).toContain("[REDACTED]");
  });
});
