import { execFile } from "node:child_process";
import { cp, mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import type { ProjectWorkspace } from "@design-sharingan/project-adapters";
import { captureRender, startDevServer } from "../../packages/render-engine/src/index";
import { expect, test } from "@playwright/test";

const execFileAsync = promisify(execFile);

async function reservePort(): Promise<number> {
  const { createServer } = await import("node:net");
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("Could not reserve fixture port"));
        return;
      }
      server.close(() => resolvePort(address.port));
    });
  });
}

test("starts a real web fixture and persists PNG-header-verified screenshot evidence", async () => {
  const fixtureSource = resolve("tests/fixtures/renderable-next");
  const fixtureRoot = await realpath(await mkdtemp(join(tmpdir(), "renderable-next-e2e-")));
  await cp(fixtureSource, fixtureRoot, { recursive: true });
  await execFileAsync("git", ["init"], { cwd: fixtureRoot });
  await execFileAsync("git", ["config", "user.email", "render@example.test"], { cwd: fixtureRoot });
  await execFileAsync("git", ["config", "user.name", "Render Fixture"], { cwd: fixtureRoot });
  await execFileAsync("git", ["add", "."], { cwd: fixtureRoot });
  await execFileAsync("git", ["commit", "-m", "fixture"], { cwd: fixtureRoot });
  const head = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: fixtureRoot })).stdout.trim();
  const port = await reservePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const workspace: ProjectWorkspace = {
    id: "render-e2e-project",
    name: "Renderable fixture",
    sourceType: "LOCAL",
    rootPath: fixtureRoot,
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
    createdAt: "2026-08-25T00:00:00.000Z",
    updatedAt: "2026-08-25T00:00:00.000Z",
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
      sessionId: "safe-session-e2e",
      roundId: "round-1",
    });
    const bytes = await readFile(result.artifact.imagePath);
    expect(bytes.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    expect(bytes.readUInt32BE(16)).toBe(1280);
    expect(bytes.readUInt32BE(20)).toBe(720);
    expect((await stat(result.artifact.imagePath)).size).toBeGreaterThan(1000);
    expect(result.artifact).toMatchObject({
      sessionId: "safe-session-e2e",
      roundId: "round-1",
      route: "/",
      viewport: "desktop",
      viewportWidth: 1280,
      viewportHeight: 720,
      sourceRevision: {
        kind: "GIT",
        available: true,
        head,
        status: "CLEAN",
        entries: [],
        truncated: false,
        worktreeFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
        fileCount: 2,
      },
    });
    expect(JSON.parse(await readFile(result.metadataPath, "utf8"))).toEqual(result.artifact);
    await server.stop();
    server = undefined;
    await expect(execFileAsync("node", ["-e", `fetch(${JSON.stringify(baseUrl)}).then(()=>process.exit(1),()=>process.exit(0))`])).resolves.toBeDefined();
  } finally {
    await server?.stop();
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});
