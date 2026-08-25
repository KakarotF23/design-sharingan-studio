import type {
  CodexAgentResult,
  CodexAgentRunInput,
} from "@design-sharingan/agent-runtime";
import type { DesignDNA, Reference } from "@design-sharingan/core";
import { describe, expect, it } from "vitest";
import { scanReference, type ScanWireOutput } from "../scan";

const wireOutput: ScanWireOutput = {
  hierarchy: "One dominant heading leads into a compact evidence rail.",
  layout: "A restrained two-column frame separates source and interpretation.",
  spacing: "Large sectional intervals surround tightly grouped evidence.",
  typography: "Condensed display type contrasts with neutral body copy.",
  colorLogic: "Near-black surfaces use bone text and one restrained red accent.",
  componentGeometry: "Square panels and fine rules create technical precision.",
  navigation: "A stable project rail keeps the analysis workflow oriented.",
  interaction: "Primary actions are explicit and secondary choices remain quiet.",
  motion: "Motion is reserved for analysis progress and result arrival.",
  density: "Dense evidence is balanced by a spacious decision summary.",
  emotionalTone: "Calm, technical, and deliberate rather than theatrical.",
  visualWeight: "The reference image anchors the view while decisions form the counterweight.",
  keep: ["Clear hierarchy", "Deliberate contrast"],
  reject: ["Branded artwork", "Decorative controls"],
  adapt: ["Translate the accent into the product crimson token"],
  invent: ["Add an explicit product-fit decision trail"],
};

const reference: Reference = {
  id: "reference-1",
  projectId: "project-1",
  title: "Editorial control room",
  type: "image/png",
  source: "upload",
  imagePath: "/target/.design-sharingan/references/reference-1/artifact.png",
  likes: ["hierarchy"],
  dislikes: ["ornament"],
  tags: ["editorial"],
  analysisStatus: "READY",
  createdAt: "2026-08-25T00:00:00.000Z",
};

describe("scanReference", () => {
  // Production break caught: passing raw scalar output through, analyzing in the target workspace, or omitting the persistence boundary corrupts durable DesignDNA or permits V1 target access.
  it("normalizes the structured Codex result into persisted DesignDNA from isolated analysis state", async () => {
    let runInput: CodexAgentRunInput | undefined;
    let persisted: DesignDNA | undefined;
    const fakeAgent = {
      async run<TStructured>(input: CodexAgentRunInput) {
        runInput = input;
        return {
          threadId: "thread-scan-1",
          finalResponse: JSON.stringify(wireOutput),
          structured: wireOutput as TStructured,
          items: [],
        } satisfies CodexAgentResult<TStructured>;
      },
    };

    const result = await scanReference(
      {
        reference,
        stagedImagePath: "/app-state/scan-1/reference.png",
        analysisWorkingDirectory: "/app-state/scan-1",
        projectContext: {
          name: "Fixture product",
          framework: "nextjs",
          routes: ["/", "/settings"],
          componentDirectories: ["components"],
          designDocuments: ["DESIGN.md"],
        },
        notes: "Preserve the calm hierarchy.",
        analyzeForMe: true,
      },
      {
        agent: fakeAgent,
        createId: () => "dna-1",
        persist: async (designDNA) => {
          persisted = designDNA;
        },
      },
    );

    expect(runInput?.workingDirectory).toBe("/app-state/scan-1");
    expect(runInput?.workingDirectory).not.toContain("/target");
    expect(runInput?.images).toEqual(["/app-state/scan-1/reference.png"]);
    expect(runInput?.outputSchema).toMatchObject({
      type: "object",
      required: expect.arrayContaining([
        "hierarchy",
        "visualWeight",
        "keep",
        "reject",
        "adapt",
        "invent",
      ]),
      additionalProperties: false,
    });
    expect(runInput?.prompt).toContain("analyze principles, not identity");
    expect(runInput?.prompt).toContain("never mutate project code");
    expect(runInput?.prompt).toContain("Fixture product");
    expect(runInput?.prompt).not.toContain(reference.imagePath as string);

    const expected: DesignDNA = {
      id: "dna-1",
      referenceIds: ["reference-1"],
      hierarchy: [wireOutput.hierarchy],
      layout: [wireOutput.layout],
      spacing: [wireOutput.spacing],
      typography: [wireOutput.typography],
      colorLogic: [wireOutput.colorLogic],
      componentGeometry: [wireOutput.componentGeometry],
      navigation: [wireOutput.navigation],
      interaction: [wireOutput.interaction],
      motion: [wireOutput.motion],
      density: [wireOutput.density],
      emotionalTone: [wireOutput.emotionalTone],
      visualWeight: [wireOutput.visualWeight],
      keep: wireOutput.keep,
      reject: wireOutput.reject,
      adapt: wireOutput.adapt,
      invent: wireOutput.invent,
    };
    expect(persisted).toEqual(expected);
    expect(result).toEqual({ designDNA: expected, threadId: "thread-scan-1" });
  });

  it.each([
    ["an oversized analysis field", { ...wireOutput, hierarchy: "x".repeat(2_001) }],
    [
      "too many KRAI decisions",
      {
        ...wireOutput,
        keep: Array.from({ length: 13 }, (_, index) => `Keep ${index}`),
      },
    ],
  ] as const)("rejects %s at the shared SCAN boundary", async (_label, malformed) => {
    await expect(
      scanReference(
        {
          reference,
          stagedImagePath: "/app-state/scan-1/reference.png",
          analysisWorkingDirectory: "/app-state/scan-1",
          projectContext: {
            name: "Fixture product",
            routes: [],
            componentDirectories: [],
            designDocuments: [],
          },
          analyzeForMe: true,
        },
        {
          agent: {
            async run<TStructured>() {
              return {
                threadId: "thread-scan-invalid",
                finalResponse: JSON.stringify(malformed),
                structured: malformed as TStructured,
                items: [],
              };
            },
          },
          createId: () => "unused",
          persist: async () => undefined,
        },
      ),
    ).rejects.toThrow(/structured/i);
  });
});
