import { createHash } from "node:crypto";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { CodexAgent, type CodexAgentRunInput } from "../../packages/agent-runtime/src";
import type { Reference } from "../../packages/core/src/domain";
import type { ProjectWorkspace } from "../../packages/project-adapters/src";
import { captureRender, startDevServer } from "../../packages/render-engine/src";
import { scanReference, type ScanAgent } from "../../packages/sharingan-engine/src/scan";
import { expect, it } from "vitest";

const liveIt = process.env.RUN_CODEX_INTEGRATION === "1" ? it : it.skip;
const execFile = promisify(execFileCallback);

function pngDimensions(bytes: Buffer): { width: number; height: number } {
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

async function reservePort(): Promise<number> {
  const { createServer } = await import("node:net");
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("Could not reserve the live SCAN fixture port"));
        return;
      }
      server.close(() => resolvePort(address.port));
    });
  });
}

async function captureProductScreenshot(targetPath: string, imagePath: string): Promise<string> {
  await cp(resolve(process.cwd(), "tests/fixtures/renderable-next"), targetPath, {
    recursive: true,
  });
  await execFile("git", ["init", "-b", "live-scan-fixture"], { cwd: targetPath });
  await execFile("git", ["add", "."], { cwd: targetPath });
  await execFile(
    "git",
    [
      "-c",
      "user.name=Design Sharingan live smoke",
      "-c",
      "user.email=live-scan@example.invalid",
      "commit",
      "-m",
      "fixture",
    ],
    { cwd: targetPath },
  );
  const canonicalTargetPath = await realpath(targetPath);
  const port = await reservePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const workspace: ProjectWorkspace = {
    id: "live-scan-target",
    name: "Live V1 screenshot fixture",
    sourceType: "LOCAL",
    rootPath: canonicalTargetPath,
    packageManager: "npm",
    devCommand: "npm start",
    renderTarget: "/",
    scripts: { start: "node server.mjs" },
    routes: ["/"],
    componentDirectories: [],
    designDocuments: [],
    hasGit: true,
    capabilities: {
      canReadFiles: true,
      canWriteFiles: true,
      canRun: true,
      canRender: true,
      canCapture: true,
      canUseGit: true,
      canAudit: true,
    },
    status: "READY",
    createdAt: "2026-09-07T00:00:00.000Z",
    updatedAt: "2026-09-07T00:00:00.000Z",
  };
  let server: Awaited<ReturnType<typeof startDevServer>> | undefined;
  try {
    server = await startDevServer({
      workspace,
      baseUrl,
      env: { RENDER_FIXTURE_PORT: String(port) },
      timeoutMs: 15_000,
    });
    const result = await captureRender({
      workspace,
      baseUrl,
      route: "/",
      viewport: { name: "desktop", width: 1280, height: 720 },
      sessionId: "live-scan-screenshot",
      roundId: "reference-1",
    });
    await writeFile(imagePath, await readFile(result.artifact.imagePath));
  } finally {
    await server?.stop();
  }
  return canonicalTargetPath;
}

// Production break caught: a one-pixel placeholder cannot establish that the
// live vision path received meaningful product evidence.
it("captures a desktop product screenshot rather than a placeholder PNG", async () => {
  const sandboxPath = await mkdtemp(join(tmpdir(), "design-sharingan-live-screenshot-"));
  const targetPath = join(sandboxPath, "product");
  const imagePath = join(sandboxPath, "sample-reference.png");
  try {
    await captureProductScreenshot(targetPath, imagePath);
    const screenshot = await readFile(imagePath);
    expect(screenshot.length).toBeGreaterThan(1_000);
    expect(pngDimensions(screenshot)).toEqual({ width: 1280, height: 720 });
  } finally {
    await rm(sandboxPath, { force: true, recursive: true });
  }
}, 30_000);

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
      await mkdir(analysisPath, { recursive: true });
      const canonicalTargetPath = await captureProductScreenshot(targetPath, imagePath);
      const screenshot = await readFile(imagePath);
      expect(screenshot.length).toBeGreaterThan(1_000);
      expect(pngDimensions(screenshot)).toEqual({ width: 1280, height: 720 });
      const before = await snapshotTargetTree(canonicalTargetPath);
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
      expect(observedRun?.workingDirectory).not.toBe(canonicalTargetPath);
      expect(result.threadId).toMatch(/\S+/);
      expect(result.designDNA).toMatchObject({
        id: "live-scan-dna",
        referenceIds: [reference.id],
      });
      expect(result.designDNA.keep).toBeInstanceOf(Array);
      expect(result.designDNA.reject).toBeInstanceOf(Array);
      expect(result.designDNA.adapt).toBeInstanceOf(Array);
      expect(result.designDNA.invent).toBeInstanceOf(Array);
      const krai = [
        ...result.designDNA.keep,
        ...result.designDNA.reject,
        ...result.designDNA.adapt,
        ...result.designDNA.invent,
      ];
      expect(krai.length).toBeGreaterThan(0);
      expect(krai.every((decision) => decision.trim().length > 0)).toBe(true);
      const groundedFields = [
        result.designDNA.hierarchy[0],
        result.designDNA.layout[0],
        result.designDNA.colorLogic[0],
        result.designDNA.componentGeometry[0],
      ];
      expect(groundedFields.every((field) => field?.trim().split(/\s+/).length >= 3)).toBe(true);
      expect(await snapshotTargetTree(canonicalTargetPath)).toEqual(before);
    } finally {
      await rm(sandboxPath, { force: true, recursive: true });
    }
  },
  120_000,
);
