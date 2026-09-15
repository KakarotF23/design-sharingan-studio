import { mkdtemp, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CodexAgentResult, CodexAgentRunInput } from "@design-sharingan/agent-runtime";
import type { RenderArtifact } from "@design-sharingan/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { analyzeRender, type VisualAnalysisWireOutput } from "../analyze-render";

const wireOutput: VisualAnalysisWireOutput = {
  verification: {
    uxIntegrity: { status: "PASS", evidence: ["Primary task and navigation remain usable."] },
    productConsistency: { status: "PASS", evidence: ["Existing component language is preserved."] },
    accessibility: { status: "PASS", evidence: ["No observable contrast or interaction regression."] },
    genomeIntegrity: { status: "PASS", evidence: ["Approved Genome v1 invariant remains visible."] }
  },
  findings: [
    {
      severity: "IMPORTANT",
      category: "HIERARCHY",
      screen: "/",
      description: "The primary heading and secondary evidence have equal visual weight.",
      evidence: ["Current render: the heading and evidence rail use the same scale."],
      reason: "The approved direction requires one dominant decision point.",
      recommendedAction: "Increase heading scale while preserving the existing route and actions."
    }
  ]
};

describe("analyzeRender", () => {
  let sandboxPath: string;
  let projectRoot: string;
  let analysisWorkingDirectory: string;
  let referencePath: string;
  let renderPath: string;

  beforeEach(async () => {
    sandboxPath = await realpath(await mkdtemp(join(tmpdir(), "visual-engine-test-")));
    projectRoot = join(sandboxPath, "project");
    analysisWorkingDirectory = join(sandboxPath, "analysis");
    referencePath = join(projectRoot, ".design-sharingan", "references", "reference-1", "artifact.png");
    renderPath = join(projectRoot, ".design-sharingan", "renders", "round-1.png");
    await mkdir(join(projectRoot, ".design-sharingan", "references", "reference-1"), { recursive: true });
    await mkdir(join(projectRoot, ".design-sharingan", "renders"), { recursive: true });
    await mkdir(analysisWorkingDirectory);
    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
    await writeFile(referencePath, png);
    await writeFile(renderPath, png);
  });

  afterEach(async () => {
    await rm(sandboxPath, { force: true, recursive: true });
  });

  function artifact(): RenderArtifact {
    return {
      id: "render-1",
      sessionId: "mangekyo-1",
      roundId: "round-1",
      route: "/",
      viewport: "desktop",
      viewportWidth: 1280,
      viewportHeight: 720,
      imagePath: renderPath,
      capturedAt: "2026-08-27T01:00:01.000Z",
      sourceRevision: {
        kind: "GIT",
        available: true,
        head: "a".repeat(40),
        branch: "fixture",
        status: "DIRTY",
        entries: [{ index: " ", workingTree: "M", path: "server.mjs" }],
        truncated: false,
        worktreeFingerprint: "b".repeat(64),
        fileCount: 2,
        requiredPathEvidence: [],
      }
    };
  }

  // Production break: Safe execution without an uploaded reference cannot inspect its fresh render against the approved direction.
  it("allows direction-only render verification only through the explicit approved-direction contract", async () => {
    const input = { projectId: "project-1", projectRoot, analysisWorkingDirectory, screen: "/", referenceImages: [], currentRender: artifact(), productContext: { name: "Product", approvedDirection: "Keep stable navigation", uxInvariants: ["Keep navigation"], designSystem: [] } };
    const output = { ...wireOutput, verification: { ...wireOutput.verification, genomeIntegrity: { status: "NOT_VERIFIED" as const, evidence: ["No approved Genome"] } } };
    let images: readonly string[] | undefined;
    const dependencies = { createId: () => "finding-safe", agent: { async run<T>(request: CodexAgentRunInput) { images = request.images; return { threadId: "visual-safe", finalResponse: JSON.stringify(output), structured: output as T, items: [] }; } } };
    await expect(analyzeRender(input, dependencies)).rejects.toThrow(/invalid/);
    const result = await analyzeRender({ ...input, comparisonMode: "APPROVED_DIRECTION" }, dependencies);
    expect(images).toHaveLength(1);
    expect(result.verification.genomeIntegrity.status).toBe("NOT_VERIFIED");
  });

  // Production break caught: replacing render inspection with source inspection or omitting actual images leaves visual findings unsupported by rendered evidence.
  it("sends the actual project-scoped reference and render images through a bounded structured analysis", async () => {
    let runInput: CodexAgentRunInput | undefined;
    const result = await analyzeRender(
      {
        projectId: "project-1",
        projectRoot,
        analysisWorkingDirectory,
        screen: "/",
        referenceImages: [{ referenceId: "reference-1", imagePath: referencePath }],
        currentRender: artifact(),
        productContext: {
          name: "Fixture product",
          approvedDirection: "Calm evidence-first hierarchy",
          uxInvariants: ["Preserve navigation"],
          designSystem: ["Use the existing crimson token"]
        },
        genome: {
          version: "1",
          status: "APPROVED",
          productIdentity: "Local design intelligence",
          uxInvariants: ["Preserve navigation"],
          visualInvariants: ["One dominant action"],
          motionRules: [],
          accessibilityRules: ["WCAG AA contrast"],
          componentDNA: [],
          screenFamilies: [],
          contentVoice: [],
          intentionalExceptions: [],
          unconfirmedRules: []
        }
      },
      {
        createId: () => "finding-1",
        agent: {
          async run<TStructured>(input: CodexAgentRunInput) {
            runInput = input;
            return {
              threadId: "visual-thread-1",
              finalResponse: JSON.stringify(wireOutput),
              structured: wireOutput as TStructured,
              items: []
            } satisfies CodexAgentResult<TStructured>;
          }
        }
      }
    );

    expect(runInput?.workingDirectory).toBe(analysisWorkingDirectory);
    expect(runInput?.images).toHaveLength(2);
    expect(runInput?.images?.every((path) => path.startsWith(`${analysisWorkingDirectory}/`))).toBe(true);
    expect(runInput?.images).not.toContain(referencePath);
    expect(runInput?.images).not.toContain(renderPath);
    expect(runInput?.outputSchema).toMatchObject({
      type: "object",
      required: ["verification", "findings"],
      additionalProperties: false,
      properties: {
        findings: {
          maxItems: 64,
          items: {
            required: [
              "severity",
              "category",
              "screen",
              "description",
              "evidence",
              "reason",
              "recommendedAction"
            ],
            additionalProperties: false
          }
        }
      }
    });
    expect(runInput?.prompt).toContain("Inspect the rendered image output");
    expect(runInput?.prompt).toContain("not source code as a substitute");
    expect(runInput?.prompt).toContain(
      "UX integrity > product consistency > accessibility > visual hierarchy > reference intent > pixel similarity"
    );
    expect(result).toEqual({
      threadId: "visual-thread-1",
      genomeEvidenceVersion: "1",
      verification: wireOutput.verification,
      findings: [{ id: "finding-1", ...wireOutput.findings[0], status: "OPEN" }]
    });
  });

  it("requires Genome integrity to be NOT_VERIFIED when no authenticated Genome evidence is supplied", async () => {
    await expect(analyzeRender(
      {
        projectId: "project-1",
        projectRoot,
        analysisWorkingDirectory,
        screen: "/",
        referenceImages: [{ referenceId: "reference-1", imagePath: referencePath }],
        currentRender: artifact(),
        productContext: {
          name: "Fixture product",
          approvedDirection: "Calm evidence-first hierarchy",
          uxInvariants: ["Preserve navigation"],
          designSystem: ["Use the existing crimson token"]
        }
      },
      {
        createId: () => "finding-1",
        agent: {
          async run<TStructured>() {
            return {
              threadId: "visual-thread-unverified",
              finalResponse: JSON.stringify(wireOutput),
              structured: wireOutput as TStructured,
              items: []
            };
          }
        }
      }
    )).rejects.toThrow(/Genome.*NOT_VERIFIED|authenticated Genome/i);
  });

  it("analyzes exclusive private image snapshots even if authenticated paths are replaced before agent reads", async () => {
    const originalReference = await readFile(referencePath);
    const output: VisualAnalysisWireOutput = structuredClone(wireOutput);
    output.verification.genomeIntegrity = {
      status: "NOT_VERIFIED",
      evidence: ["No authenticated approved Genome was supplied."]
    };
    let imageInputs: string[] = [];

    await analyzeRender(
      {
        projectId: "project-1",
        projectRoot,
        analysisWorkingDirectory,
        screen: "/",
        referenceImages: [{ referenceId: "reference-1", imagePath: referencePath }],
        currentRender: artifact(),
        productContext: {
          name: "Fixture product",
          approvedDirection: "Calm evidence-first hierarchy",
          uxInvariants: ["Preserve navigation"],
          designSystem: ["Use the existing crimson token"]
        }
      },
      {
        createId: () => "finding-1",
        agent: {
          async run<TStructured>(input: CodexAgentRunInput) {
            imageInputs = [...(input.images ?? [])];
            await rename(referencePath, `${referencePath}.authenticated`);
            await writeFile(
              referencePath,
              Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 9, 9, 9, 9])
            );
            expect(imageInputs[0]).not.toBe(referencePath);
            expect(await readFile(imageInputs[0] as string)).toEqual(originalReference);
            return {
              threadId: "visual-thread-snapshot",
              finalResponse: JSON.stringify(output),
              structured: output as TStructured,
              items: []
            };
          }
        }
      }
    );

    expect(imageInputs.every((path) => path.startsWith(`${analysisWorkingDirectory}/`))).toBe(true);
    await Promise.all(imageInputs.map((path) => expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" })));
  });

  it.each([
    ["undeclared output", { findings: [{ ...wireOutput.findings[0], confidence: 1 }] }],
    ["wrong screen", { findings: [{ ...wireOutput.findings[0], screen: "/settings" }] }],
    ["oversized evidence", { findings: [{ ...wireOutput.findings[0], evidence: ["x".repeat(2_001)] }] }]
  ] as const)("rejects %s instead of persisting unbounded agent claims", async (_label, malformed) => {
    await expect(
      analyzeRender(
        {
          projectId: "project-1",
          projectRoot,
          analysisWorkingDirectory,
          screen: "/",
          referenceImages: [{ referenceId: "reference-1", imagePath: referencePath }],
          currentRender: artifact(),
          productContext: {
            name: "Fixture product",
            approvedDirection: "Calm evidence-first hierarchy",
            uxInvariants: [],
            designSystem: []
          }
        },
        {
          createId: () => "unused",
          agent: {
            async run<TStructured>() {
              return {
                threadId: "visual-thread-invalid",
                finalResponse: JSON.stringify(malformed),
                structured: malformed as TStructured,
                items: []
              };
            }
          }
        }
      )
    ).rejects.toThrow(/structured visual findings/i);
  });

  it("rejects a reference image outside the authenticated project before invoking the agent", async () => {
    const outsidePath = join(sandboxPath, "outside.png");
    await writeFile(outsidePath, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    let called = false;
    await expect(
      analyzeRender(
        {
          projectId: "project-1",
          projectRoot,
          analysisWorkingDirectory,
          screen: "/",
          referenceImages: [{ referenceId: "reference-1", imagePath: outsidePath }],
          currentRender: artifact(),
          productContext: {
            name: "Fixture product",
            approvedDirection: "Calm evidence-first hierarchy",
            uxInvariants: [],
            designSystem: []
          }
        },
        {
          createId: () => "unused",
          agent: {
            async run<TStructured>() {
              called = true;
              throw new Error("must not run") as TStructured;
            }
          }
        }
      )
    ).rejects.toThrow(/project-scoped/i);
    expect(called).toBe(false);
  });
});
