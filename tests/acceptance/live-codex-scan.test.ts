import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexAgent, type CodexAgentRunInput } from "../../packages/agent-runtime/src";
import type { Reference } from "../../packages/core/src/domain";
import { scanReference, type ScanAgent } from "../../packages/sharingan-engine/src/scan";
import { expect, it } from "vitest";

const liveIt = process.env.RUN_CODEX_INTEGRATION === "1" ? it : it.skip;

const samplePng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

async function snapshotTargetTree(rootPath: string): Promise<Record<string, string>> {
  const snapshot: Record<string, string> = {};

  async function visit(directoryPath: string, relativeDirectory = ""): Promise<void> {
    const entries = await readdir(directoryPath, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const relativePath = relativeDirectory
        ? join(relativeDirectory, entry.name)
        : entry.name;
      const absolutePath = join(directoryPath, entry.name);
      if (entry.isDirectory()) {
        snapshot[relativePath] = "directory";
        await visit(absolutePath, relativePath);
      } else if (entry.isFile()) {
        snapshot[relativePath] = `file:${createHash("sha256")
          .update(await readFile(absolutePath))
          .digest("hex")}`;
      }
    }
  }

  await visit(rootPath);
  return snapshot;
}

// Production break caught: V1 SCAN must submit only isolated working/image evidence
// to the live SDK and must not mutate target-project files while producing Design DNA.
liveIt(
  "runs one real image-backed V1 SCAN from isolated state without target mutation",
  async () => {
    const sandboxPath = await mkdtemp(join(tmpdir(), "design-sharingan-live-scan-"));
    const targetPath = join(sandboxPath, "target-project");
    const analysisPath = join(sandboxPath, "isolated-analysis");
    const imagePath = join(analysisPath, "sample-reference.png");
    let observedRun: CodexAgentRunInput | undefined;

    try {
      await Promise.all([
        mkdir(targetPath, { recursive: true }),
        mkdir(analysisPath, { recursive: true }),
      ]);
      await Promise.all([
        writeFile(join(targetPath, "package.json"), '{"name":"v1-target"}\n', "utf8"),
        writeFile(join(targetPath, "ui.txt"), "target files are read-only to V1\n", "utf8"),
        writeFile(imagePath, samplePng),
      ]);
      const before = await snapshotTargetTree(targetPath);
      const realAgent = new CodexAgent({
        secretEnvironmentKeys: ["CODEX_API_KEY", "OPENAI_API_KEY", "GITHUB_TOKEN"],
      });
      const observingAgent: ScanAgent = {
        async run<TStructured>(input: CodexAgentRunInput) {
          observedRun = structuredClone(input);
          return realAgent.run<TStructured>(input);
        },
      };
      const reference: Reference = {
        id: "live-reference-1",
        projectId: "live-project-1",
        title: "Live SDK sample reference",
        type: "image/png",
        source: "acceptance fixture",
        likes: ["clear hierarchy"],
        dislikes: ["brand imitation"],
        tags: ["acceptance", "sample"],
        analysisStatus: "READY",
        createdAt: "2026-09-07T00:00:00.000Z",
      };

      const result = await scanReference(
        {
          reference,
          stagedImagePath: imagePath,
          analysisWorkingDirectory: analysisPath,
          projectContext: {
            name: "Live V1 acceptance target",
            framework: "web",
            routes: ["/"],
            componentDirectories: ["src"],
            designDocuments: [],
          },
          notes: "Evaluate reusable product principles only.",
          analyzeForMe: true,
        },
        {
          agent: observingAgent,
          createId: () => "live-scan-dna",
          persist: async () => undefined,
        },
      );

      expect(observedRun).toMatchObject({
        workingDirectory: analysisPath,
        images: [imagePath],
      });
      expect(observedRun?.workingDirectory).not.toBe(targetPath);
      expect(result.threadId).toMatch(/\S+/);
      expect(result.designDNA).toMatchObject({
        id: "live-scan-dna",
        referenceIds: [reference.id],
      });
      expect(result.designDNA.keep).toBeInstanceOf(Array);
      expect(result.designDNA.reject).toBeInstanceOf(Array);
      expect(result.designDNA.adapt).toBeInstanceOf(Array);
      expect(result.designDNA.invent).toBeInstanceOf(Array);
      expect(await snapshotTargetTree(targetPath)).toEqual(before);
    } finally {
      await rm(sandboxPath, { force: true, recursive: true });
    }
  },
  120_000,
);
