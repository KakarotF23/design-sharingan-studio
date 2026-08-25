import type {
  CodexAgentResult,
  CodexAgentRunInput,
} from "@design-sharingan/agent-runtime";
import type { DesignDNA } from "@design-sharingan/core";
import { describe, expect, it } from "vitest";
import {
  assimilateReferences,
  type AssimilateWireOutput,
} from "../assimilate";

function analysis(id: string, referenceId: string): DesignDNA {
  return {
    id,
    referenceIds: [referenceId],
    hierarchy: [`Hierarchy from ${referenceId}`],
    layout: ["Split evidence layout"],
    spacing: ["Large section rhythm"],
    typography: ["Condensed display with neutral body"],
    colorLogic: ["Restrained crimson on graphite"],
    componentGeometry: ["Square evidence panels"],
    navigation: ["Stable project rail"],
    interaction: ["Explicit primary action"],
    motion: ["Motion only for progress"],
    density: ["Dense evidence, calm summary"],
    emotionalTone: ["Technical and deliberate"],
    visualWeight: ["Evidence leads, decisions support"],
    keep: ["Clear hierarchy"],
    reject: ["Decorative controls"],
    adapt: ["Translate accent into product tokens"],
    invent: ["Add product-fit explanation"],
  };
}

const analyses = [analysis("dna-1", "reference-1"), analysis("dna-2", "reference-2")];

const wireOutput: AssimilateWireOutput = {
  summary: "A unified evidence-led direction with restrained visual emphasis.",
  sourceMap: [
    {
      referenceIds: ["reference-1"],
      role: "Hierarchy",
      principles: ["Clear evidence-first hierarchy"],
    },
    {
      referenceIds: ["reference-2"],
      role: "Interaction",
      principles: ["Explicit review actions"],
    },
  ],
  direction: {
    hierarchy: "Evidence leads into a single decision summary.",
    layout: "Use a coherent split frame across the workspace.",
    spacing: "Keep generous sections and compact evidence groups.",
    typography: "Pair condensed display labels with neutral body text.",
    colorLogic: "Reserve crimson for decisions and state changes.",
    componentGeometry: "Use square panels and fine dividers.",
    navigation: "Retain the stable project rail.",
    interaction: "Make review actions explicit and reversible.",
    motion: "Reserve motion for processing and result arrival.",
    density: "Balance dense evidence with calm summaries.",
    emotionalTone: "Technical, calm, and deliberate.",
    visualWeight: "Evidence anchors the frame; decisions form the counterweight.",
    keep: ["Evidence-first hierarchy"],
    reject: ["Decorative controls"],
    adapt: ["Translate source accents into product tokens"],
    invent: ["Add a unified source decision map"],
  },
};

describe("assimilateReferences", () => {
  // Production break caught: treating two analyses as a collage or persisting
  // them as Genome authority would violate the proposal-only ASSIMILATE gate.
  it("returns a source-mapped proposed direction without a Genome write boundary", async () => {
    let runInput: CodexAgentRunInput | undefined;
    const fakeAgent = {
      async run<TStructured>(input: CodexAgentRunInput) {
        runInput = input;
        return {
          threadId: "thread-assimilate-1",
          finalResponse: JSON.stringify(wireOutput),
          structured: wireOutput as TStructured,
          items: [],
        } satisfies CodexAgentResult<TStructured>;
      },
    };

    const result = await assimilateReferences(
      {
        analyses,
        analysisWorkingDirectory: "/app-state/assimilate-1",
        projectContext: { name: "Fixture product", routes: ["/references"] },
        learningIntent: "Unify hierarchy and interaction without adding navigation.",
      },
      { agent: fakeAgent, createId: () => "dna-assimilated-1" },
    );

    expect(runInput?.workingDirectory).toBe("/app-state/assimilate-1");
    expect(runInput?.prompt).toContain("one coherent proposed design direction");
    expect(runInput?.prompt).toContain("must not update or adopt the Design Genome");
    expect(runInput?.prompt).toContain("never mutate project code");
    expect(result.proposedDirection.referenceIds).toEqual([
      "reference-1",
      "reference-2",
    ]);
    expect(result.proposedDirection.id).toBe("dna-assimilated-1");
    expect(result.summary).toBe(wireOutput.summary);
    expect(result.sourceMap).toEqual(wireOutput.sourceMap);
    expect(result.threadId).toBe("thread-assimilate-1");
    expect("genome" in result).toBe(false);
  });

  // Production break caught: a single analysis is SCAN, not ASSIMILATE, and
  // must not be mislabeled as cross-reference synthesis.
  it("requires at least two reference analyses", async () => {
    await expect(
      assimilateReferences(
        {
          analyses: analyses.slice(0, 1),
          analysisWorkingDirectory: "/app-state/assimilate-1",
          projectContext: { name: "Fixture product", routes: [] },
        },
        {
          agent: { async run() { throw new Error("must not run"); } },
          createId: () => "unused",
        },
      ),
    ).rejects.toThrow(/at least two/i);
  });
});
