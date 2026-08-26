import { EventEmitter } from "node:events";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProjectWorkspace } from "@design-sharingan/project-adapters";
import { describe, expect, it } from "vitest";
import {
  captureRender,
  defaultProcessRunner,
  startDevServer,
  waitForReadiness,
  type BrowserHandle,
  type BrowserLauncher,
  type DevProcess,
  type ProcessRunner,
} from "../index";

const execFileAsync = promisify(execFile);

const PNG = new Uint8Array([
  137, 80, 78, 71, 13, 10, 26, 10,
  0, 0, 0, 13, 73, 72, 68, 82,
  0, 0, 5, 160, 0, 0, 3, 32,
]);

async function workspace(devCommand = "pnpm dev"): Promise<ProjectWorkspace> {
  const rootPath = await realpath(await mkdtemp(join(tmpdir(), "render-engine-")));
  return {
    id: "project-1",
    name: "Fixture",
    sourceType: "LOCAL",
    rootPath,
    framework: "nextjs",
    packageManager: "pnpm",
    devCommand,
    renderTarget: "/",
    scripts: { dev: "next dev" },
    routes: ["/"],
    componentDirectories: [],
    designDocuments: [],
    hasGit: false,
    capabilities: {
      canReadFiles: true,
      canWriteFiles: true,
      canRun: true,
      canRender: true,
      canCapture: true,
      canUseGit: false,
      canAudit: true,
    },
    status: "READY",
    createdAt: "2026-08-24T10:00:00.000Z",
    updatedAt: "2026-08-24T10:00:00.000Z",
  };
}

class FakeProcess extends EventEmitter implements DevProcess {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  private resolveExit!: (code: number | null) => void;
  readonly exited = new Promise<number | null>((resolve) => {
    this.resolveExit = resolve;
  });
  stopCalls = 0;

  exit(code: number | null): void {
    this.resolveExit(code);
  }

  async stop(): Promise<void> {
    this.stopCalls += 1;
    this.exit(0);
  }
}

// Production break caught: launching through a shell or from Studio's cwd can execute a different project/script than the active workspace.
it("starts the detected dev command in the canonical project root and owns cleanup", async () => {
  const active = await workspace();
  const child = new FakeProcess();
  const starts: Parameters<ProcessRunner["start"]>[0][] = [];
  const runner: ProcessRunner = {
    start(command) {
      starts.push(command);
      return child;
    },
  };
  let probes = 0;

  const server = await startDevServer({
    workspace: active,
    baseUrl: "http://127.0.0.1:4310",
    processRunner: runner,
    readinessProbe: async () => ++probes >= 2,
    pollIntervalMs: 1,
    timeoutMs: 100,
  });

  expect(starts).toEqual([
    expect.objectContaining({
      executable: "pnpm",
      args: ["run", "dev"],
      cwd: active.rootPath,
      shell: false,
    }),
  ]);
  expect(probes).toBe(2);
  await server.stop();
  await server.stop();
  expect(child.stopCalls).toBe(1);
});

// Production break caught: persisted process diagnostics can leak repository credentials or grow without bound on noisy dev servers.
it("bounds and redacts captured dev-server output", async () => {
  const active = await workspace();
  const child = new FakeProcess();
  let readinessCalls = 0;
  process.env.RENDER_ENGINE_TEST_SECRET = "render-super-secret-value";
  const starting = startDevServer({
    workspace: active,
    baseUrl: "http://127.0.0.1:4310",
    processRunner: { start: () => child },
    readinessProbe: async () => {
      if (++readinessCalls === 1) return false;
      child.stdout.emit("data", Buffer.from(`token=${process.env.RENDER_ENGINE_TEST_SECRET}\n${"x".repeat(80_000)}`));
      return true;
    },
  });
  const server = await starting;

  expect(server.output).not.toContain("render-super-secret-value");
  expect(Buffer.byteLength(server.output, "utf8")).toBeLessThanOrEqual(65_536);
  expect(server.output).toContain("[REDACTED]");
  await server.stop();
  delete process.env.RENDER_ENGINE_TEST_SECRET;
});

// Production break caught: an explicitly supplied project secret can be echoed by the child even when no host environment was inherited.
it("redacts explicit dev-server environment values from captured output", async () => {
  const active = await workspace();
  const child = new FakeProcess();
  let readinessCalls = 0;
  const server = await startDevServer({
    workspace: active,
    baseUrl: "http://127.0.0.1:4310",
    env: { PUBLIC_API_KEY: "explicit-render-secret" },
    processRunner: { start: () => child },
    readinessProbe: async () => {
      if (++readinessCalls === 1) return false;
      child.stderr.emit("data", "failed with explicit-render-secret");
      return true;
    },
  });

  expect(server.output).toBe("failed with [REDACTED]");
  await server.stop();
});

// Production break caught: per-chunk redaction exposes a secret assembled across adjacent stdout chunks.
it("statefully redacts split exact secrets without exposing an unsafe pending tail", async () => {
  const active = await workspace();
  const child = new FakeProcess();
  let readinessCalls = 0;
  const server = await startDevServer({
    workspace: active,
    baseUrl: "http://127.0.0.1:4310",
    env: { SPLIT_SECRET: "split-secret-value" },
    processRunner: { start: () => child },
    readinessProbe: async () => ++readinessCalls > 1,
  });

  child.stdout.emit("data", Buffer.from("prefix split-sec"));
  expect(server.output).not.toContain("split-sec");
  child.stdout.emit("data", Buffer.from("ret-value suffix"));
  expect(server.output).toContain("[REDACTED]");
  expect(server.output).not.toContain("split-secret-value");
  await server.stop();
  expect(server.output).not.toContain("split-secret-value");
});

// Production break caught: token-pattern redaction misses credentials whose prefix/body cross chunk boundaries.
it("statefully redacts split GitHub and OpenAI-style token patterns", async () => {
  const active = await workspace();
  const child = new FakeProcess();
  let readinessCalls = 0;
  const server = await startDevServer({
    workspace: active,
    baseUrl: "http://127.0.0.1:4310",
    processRunner: { start: () => child },
    readinessProbe: async () => {
      readinessCalls += 1;
      if (readinessCalls === 1) return false;
      child.stdout.emit("data", "ghp_AAAAAAAAAA");
      child.stdout.emit("data", "AAAAAAAAAA sk-BBBBBBBB");
      child.stdout.emit("data", "BBBBBBBB");
      return true;
    },
  });

  expect(server.output).not.toMatch(/ghp_|sk-/);
  expect(server.output.match(/\[REDACTED\]/g)).toHaveLength(2);
  child.stdout.emit("data", `prefixxghp_${"C".repeat(20)}`);
  expect(server.output).not.toContain("ghp_");
  await server.stop();
});

// Production break caught: byte slicing through a multibyte code point can add U+FFFD and exceed the advertised output byte cap.
it("truncates multibyte output on code-point boundaries within 65,536 encoded bytes", async () => {
  const active = await workspace();
  const child = new FakeProcess();
  let readinessCalls = 0;
  const server = await startDevServer({
    workspace: active,
    baseUrl: "http://127.0.0.1:4310",
    processRunner: { start: () => child },
    readinessProbe: async () => ++readinessCalls > 1,
  });
  child.stdout.emit("data", Buffer.from("界".repeat(30_000)));
  expect(Buffer.byteLength(server.output, "utf8")).toBeLessThanOrEqual(65_536);
  expect(server.output).not.toContain("�");
  await server.stop();
});

// Production break caught: inherited host credentials become readable by arbitrary scripts in an imported repository.
it("starts project code with a minimal environment plus explicit caller values", async () => {
  const active = await workspace();
  const child = new FakeProcess();
  let environment: NodeJS.ProcessEnv | undefined;
  let readinessCalls = 0;
  process.env.CODEX_RENDER_TEST_TOKEN = "must-not-reach-project";
  const server = await startDevServer({
    workspace: active,
    baseUrl: "http://127.0.0.1:4310",
    env: { RENDER_FIXTURE_PORT: "4310" },
    processRunner: {
      start(command) {
        environment = command.env;
        return child;
      },
    },
    readinessProbe: async () => ++readinessCalls > 1,
  });

  expect(environment).toMatchObject({
    PATH: expect.any(String),
    HOME: expect.stringContaining("design-sharingan-render-home-"),
    XDG_CONFIG_HOME: expect.any(String),
    RENDER_FIXTURE_PORT: "4310",
  });
  expect(environment).not.toHaveProperty("CODEX_RENDER_TEST_TOKEN");
  const isolatedHome = environment?.HOME as string;
  expect(isolatedHome).not.toBe(process.env.HOME);
  await server.stop();
  await expect(stat(isolatedHome)).rejects.toThrow();
  delete process.env.CODEX_RENDER_TEST_TOKEN;
});

it("rejects oversized explicit environment values before starting untrusted project code", async () => {
  const active = await workspace();
  let started = false;
  await expect(startDevServer({
    workspace: active,
    baseUrl: "http://127.0.0.1:4310",
    env: { OVERSIZED_VALUE: "x".repeat(4_097) },
    processRunner: { start() { started = true; return new FakeProcess(); } },
    readinessProbe: async () => false,
  })).rejects.toThrow(/environment.*value|too large/i);
  expect(started).toBe(false);
});

// Production break caught: aborting a workflow cannot clean its server while an injected/network readiness probe ignores AbortSignal.
it("aborts and terminates the child even when the readiness probe never settles", async () => {
  const active = await workspace();
  const child = new FakeProcess();
  const controller = new AbortController();
  let readinessCalls = 0;
  const starting = startDevServer({
    workspace: active,
    baseUrl: "http://127.0.0.1:4310",
    processRunner: { start: () => child },
    readinessProbe: async () => ++readinessCalls === 1
      ? false
      : new Promise<boolean>(() => undefined),
    signal: controller.signal,
    timeoutMs: 10_000,
  });
  setTimeout(() => controller.abort(), 5);

  await expect(starting).rejects.toThrow(/aborted/i);
  expect(child.stopCalls).toBe(1);
}, 500);

// Production break caught: a probe that ignores both return and signal can defeat the configured readiness deadline.
it("times out and terminates the child when the readiness probe never settles", async () => {
  const active = await workspace();
  const child = new FakeProcess();
  let readinessCalls = 0;
  await expect(startDevServer({
    workspace: active,
    baseUrl: "http://127.0.0.1:4310",
    processRunner: { start: () => child },
    readinessProbe: async () => ++readinessCalls === 1
      ? false
      : new Promise<boolean>(() => undefined),
    timeoutMs: 5,
  })).rejects.toThrow(/not ready.*5 ms/i);
  expect(child.stopCalls).toBe(1);
}, 500);

// Production break caught: a never-ready or early-exiting server can leak a child and leave the workflow hanging without a usable diagnosis.
it("fails explicitly and cleans up when readiness times out or the child exits", async () => {
  const active = await workspace();
  const timeoutChild = new FakeProcess();

  await expect(startDevServer({
    workspace: active,
    baseUrl: "http://127.0.0.1:4310",
    processRunner: { start: () => timeoutChild },
    readinessProbe: async () => false,
    pollIntervalMs: 1,
    timeoutMs: 5,
  })).rejects.toThrow(/not ready.*5 ms/i);
  expect(timeoutChild.stopCalls).toBe(1);

  const exitedChild = new FakeProcess();
  let exitReadinessCalls = 0;
  const result = startDevServer({
    workspace: active,
    baseUrl: "http://127.0.0.1:4310",
    processRunner: { start: () => exitedChild },
    readinessProbe: async () => ++exitReadinessCalls === 1
      ? false
      : new Promise<boolean>(() => undefined),
    timeoutMs: 100,
  });
  exitedChild.exit(2);
  await expect(result).rejects.toThrow(/exited.*2/i);
  expect(exitedChild.stopCalls).toBe(1);
});

// Production break caught: shell metacharacters or an ambiguous detector string could escape the executable/argument boundary.
it.each(["pnpm dev && touch owned", "npm run dev; env", "yarn $(whoami)", "bun dev"])(
  "rejects unsupported or ambiguous dev command %s",
  async (devCommand) => {
    const active = await workspace(devCommand);
    let started = false;
    await expect(startDevServer({
      workspace: active,
      baseUrl: "http://127.0.0.1:4310",
      processRunner: { start: () => { started = true; return new FakeProcess(); } },
      readinessProbe: async () => true,
    })).rejects.toThrow(/supported detected dev command/i);
    expect(started).toBe(false);
  },
);

// Production break caught: an already-listening loopback service can be mistaken for the newly spawned project and mint evidence from the wrong process.
it("refuses to spawn when the configured base URL is already ready", async () => {
  const active = await workspace();
  let started = false;
  await expect(startDevServer({
    workspace: active,
    baseUrl: "http://127.0.0.1:4310",
    processRunner: { start: () => { started = true; return new FakeProcess(); } },
    readinessProbe: async () => true,
  })).rejects.toThrow(/already.*responding/i);
  expect(started).toBe(false);
});

// Production break caught: stale workspace status/capabilities could run or capture a project that the adapter did not authorize.
it("requires a ready, explicitly runnable/renderable workspace before starting", async () => {
  const active = await workspace();
  for (const unauthorized of [
    { ...active, status: "SCANNING" as const },
    { ...active, capabilities: { ...active.capabilities, canRun: false } },
    { ...active, capabilities: { ...active.capabilities, canRender: false } },
  ]) {
    let started = false;
    await expect(startDevServer({
      workspace: unauthorized,
      baseUrl: "http://127.0.0.1:4310",
      processRunner: { start: () => { started = true; return new FakeProcess(); } },
      readinessProbe: async () => false,
      timeoutMs: 5,
    })).rejects.toThrow(/workspace.*authorized|ready/i);
    expect(started).toBe(false);
  }
});

// Production break caught: readiness redirects could pivot the engine from the local project to an external origin.
it("accepts only loopback readiness URLs and contains redirects to their origin", async () => {
  await expect(waitForReadiness({
    url: "https://example.com",
    timeoutMs: 5,
    pollIntervalMs: 1,
  })).rejects.toThrow(/loopback/i);

  await expect(waitForReadiness({
    url: "http://127.0.0.1:4310",
    timeoutMs: 5,
    pollIntervalMs: 1,
    fetchImpl: async () => new Response(null, {
      status: 302,
      headers: { location: "https://example.com/steal" },
    }),
  })).rejects.toThrow(/redirect.*origin/i);
});

// Production break caught: unconsumed readiness bodies retain sockets/resources across polling rounds.
it("cancels every readiness response body, including contained redirects", async () => {
  let cancellations = 0;
  const response = (status: number, location?: string) => new Response(
    new ReadableStream({ cancel() { cancellations += 1; } }),
    { status, ...(location === undefined ? {} : { headers: { location } }) },
  );
  await waitForReadiness({
    url: "http://127.0.0.1:4310",
    timeoutMs: 50,
    pollIntervalMs: 1,
    fetchImpl: async (input) => String(input).endsWith("/ready")
      ? response(200)
      : response(302, "/ready"),
  });
  expect(cancellations).toBe(2);
});

// Production break caught: an injected fetch that ignores AbortSignal can hold readiness beyond its exact deadline.
it("bounds a readiness fetch that never settles to the remaining 5 ms deadline", async () => {
  const startedAt = Date.now();
  await expect(waitForReadiness({
    url: "http://127.0.0.1:4310",
    timeoutMs: 5,
    pollIntervalMs: 1,
    fetchImpl: async () => new Promise<Response>(() => undefined),
  })).rejects.toThrow(/not ready.*5 ms/i);
  expect(Date.now() - startedAt).toBeLessThan(250);
});

// Production break caught: aborting readiness must not wait for an injected fetch that ignores its signal.
it("aborts promptly while the readiness fetch never settles", async () => {
  const controller = new AbortController();
  const startedAt = Date.now();
  const waiting = waitForReadiness({
    url: "http://127.0.0.1:4310",
    timeoutMs: 1_000,
    pollIntervalMs: 1,
    signal: controller.signal,
    fetchImpl: async () => new Promise<Response>(() => undefined),
  });
  setTimeout(() => controller.abort(), 5);
  await expect(waiting).rejects.toThrow(/aborted/i);
  expect(Date.now() - startedAt).toBeLessThan(250);
});

it("cancels a readiness response that arrives after external abort", async () => {
  const controller = new AbortController();
  let resolveFetch!: (response: Response) => void;
  let cancellations = 0;
  const waiting = waitForReadiness({
    url: "http://127.0.0.1:4310",
    timeoutMs: 1_000,
    pollIntervalMs: 1,
    signal: controller.signal,
    fetchImpl: async () => new Promise<Response>((resolve) => { resolveFetch = resolve; }),
  });
  await new Promise((resolve) => setTimeout(resolve, 1));
  controller.abort();
  await expect(waiting).rejects.toThrow(/aborted/i);
  resolveFetch(new Response(new ReadableStream({ cancel() { cancellations += 1; } })));
  await new Promise((resolve) => setTimeout(resolve, 1));
  expect(cancellations).toBe(1);
});

it("removes polling-delay abort listeners after normal timer resolution", async () => {
  const controller = new AbortController();
  const signal = controller.signal;
  const originalAdd = signal.addEventListener.bind(signal);
  const originalRemove = signal.removeEventListener.bind(signal);
  let additions = 0;
  let removals = 0;
  signal.addEventListener = ((...args: Parameters<AbortSignal["addEventListener"]>) => {
    if (args[0] === "abort") additions += 1;
    return originalAdd(...args);
  }) as AbortSignal["addEventListener"];
  signal.removeEventListener = ((...args: Parameters<AbortSignal["removeEventListener"]>) => {
    if (args[0] === "abort") removals += 1;
    return originalRemove(...args);
  }) as AbortSignal["removeEventListener"];
  let calls = 0;
  await waitForReadiness({
    url: "http://127.0.0.1:4310",
    timeoutMs: 100,
    pollIntervalMs: 1,
    signal,
    fetchImpl: async () => new Response(null, { status: ++calls === 1 ? 503 : 200 }),
  });
  expect(additions).toBe(removals);
});

// Production break caught: a response body whose cancel promise ignores cancellation can hang the polling loop forever.
it("bounds non-cooperative readiness body cancellation to the remaining deadline", async () => {
  const body = { cancel: () => new Promise<void>(() => undefined) };
  const startedAt = Date.now();
  await expect(waitForReadiness({
    url: "http://127.0.0.1:4310",
    timeoutMs: 5,
    pollIntervalMs: 1,
    fetchImpl: async () => ({ status: 503, headers: new Headers(), body }) as unknown as Response,
  })).rejects.toThrow(/not ready.*5 ms/i);
  expect(Date.now() - startedAt).toBeLessThan(250);
});

function fakeBrowser(
  finalUrl: string,
  bytes = PNG,
  onScreenshot?: () => void | Promise<void>,
): { launcher: BrowserLauncher; browser: BrowserHandle; calls: string[] } {
  const calls: string[] = [];
  const page = {
    async goto(url: string) { calls.push(`goto:${url}`); },
    url() { return finalUrl; },
    async screenshot() { calls.push("screenshot"); await onScreenshot?.(); return bytes; },
    async close() { calls.push("page-close"); },
  };
  const browser: BrowserHandle = {
    async newPage(options) {
      calls.push(`viewport:${options.viewport.width}x${options.viewport.height}`);
      return page;
    },
    async close() { calls.push("browser-close"); },
  };
  return { launcher: { async launch() { return browser; } }, browser, calls };
}

// Production break caught: capture metadata can otherwise point at a different route/revision than the bytes that were actually persisted.
it("captures a PNG and atomically persists exact session, round, viewport, route, and unversioned source evidence", async () => {
  const active = await workspace();
  const browser = fakeBrowser("http://127.0.0.1:4310/account");

  const result = await captureRender({
    workspace: active,
    baseUrl: "http://127.0.0.1:4310",
    route: "/account",
    viewport: { name: "desktop", width: 1440, height: 800 },
    sessionId: "session-1",
    roundId: "round-1",
    browserLauncher: browser.launcher,
    now: () => new Date("2026-08-25T09:00:00.000Z"),
  });

  expect(result.artifact).toMatchObject({
    sessionId: "session-1",
    roundId: "round-1",
    route: "/account",
    viewport: "desktop",
    viewportWidth: 1440,
    viewportHeight: 800,
    capturedAt: "2026-08-25T09:00:00.000Z",
    sourceRevision: {
      kind: "UNVERSIONED",
      available: false,
      reason: "NOT_A_GIT_WORKSPACE",
    },
  });
  expect(result.artifact.imagePath).toBe(join(
    active.rootPath,
    ".design-sharingan/renders/session-1/round-1/desktop.png",
  ));
  expect(new Uint8Array(await readFile(result.artifact.imagePath))).toEqual(PNG);
  expect(JSON.parse(await readFile(result.metadataPath, "utf8"))).toEqual(result.artifact);
  expect(browser.calls).toEqual([
    "viewport:1440x800",
    "goto:http://127.0.0.1:4310/account",
    "screenshot",
    "page-close",
    "browser-close",
  ]);
});

// Production break caught: a clean-looking HEAD without structured dirty/untracked evidence can falsely bind a render to committed source.
it("binds Git renders to a bounded structured HEAD and dirty status snapshot", async () => {
  const active = await workspace();
  await execFileAsync("git", ["init"], { cwd: active.rootPath });
  await execFileAsync("git", ["config", "user.email", "render@example.test"], { cwd: active.rootPath });
  await execFileAsync("git", ["config", "user.name", "Render Test"], { cwd: active.rootPath });
  await writeFile(join(active.rootPath, "tracked.txt"), "before\n");
  await execFileAsync("git", ["add", "tracked.txt"], { cwd: active.rootPath });
  await execFileAsync("git", ["commit", "-m", "fixture"], { cwd: active.rootPath });
  const head = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: active.rootPath })).stdout.trim();
  const branch = (await execFileAsync("git", ["branch", "--show-current"], { cwd: active.rootPath })).stdout.trim();
  await writeFile(join(active.rootPath, "tracked.txt"), "after\n");
  await writeFile(join(active.rootPath, " leading.txt"), "spaced\n");
  await writeFile(join(active.rootPath, "untracked.txt"), "new\n");
  const gitWorkspace: ProjectWorkspace = {
    ...active,
    hasGit: true,
    capabilities: { ...active.capabilities, canUseGit: true },
  };
  const browser = fakeBrowser("http://127.0.0.1:4310/");

  const result = await captureRender({
    workspace: gitWorkspace,
    baseUrl: "http://127.0.0.1:4310",
    route: "/",
    viewport: { name: "desktop", width: 1440, height: 800 },
    sessionId: "session-1",
    roundId: "round-1",
    browserLauncher: browser.launcher,
  });

  expect(result.artifact.sourceRevision).toEqual({
    kind: "GIT",
    available: true,
    head,
    branch,
    status: "DIRTY",
    entries: [
      { index: " ", workingTree: "M", path: "tracked.txt" },
      { index: "?", workingTree: "?", path: " leading.txt" },
      { index: "?", workingTree: "?", path: "untracked.txt" },
    ],
    truncated: false,
    worktreeFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
    fileCount: 3,
  });
});

// Production break caught: status labels remain ` M` while dirty tracked bytes change during screenshot capture.
it("rejects a render when dirty tracked content changes without changing Git status labels", async () => {
  const active = await workspace();
  await execFileAsync("git", ["init"], { cwd: active.rootPath });
  await execFileAsync("git", ["config", "user.email", "render@example.test"], { cwd: active.rootPath });
  await execFileAsync("git", ["config", "user.name", "Render Test"], { cwd: active.rootPath });
  await writeFile(join(active.rootPath, "tracked.txt"), "committed\n");
  await execFileAsync("git", ["add", "tracked.txt"], { cwd: active.rootPath });
  await execFileAsync("git", ["commit", "-m", "fixture"], { cwd: active.rootPath });
  await writeFile(join(active.rootPath, "tracked.txt"), "dirty-before\n");
  const browser = fakeBrowser(
    "http://127.0.0.1:4310/",
    PNG,
    async () => writeFile(join(active.rootPath, "tracked.txt"), "dirty-after\n"),
  );

  await expect(captureRender({
    workspace: { ...active, hasGit: true, capabilities: { ...active.capabilities, canUseGit: true } },
    baseUrl: "http://127.0.0.1:4310",
    route: "/",
    viewport: { name: "desktop", width: 1440, height: 800 },
    sessionId: "session-1",
    roundId: "round-1",
    browserLauncher: browser.launcher,
  })).rejects.toThrow(/source changed|fingerprint/i);
});

it("rejects a render when ignored .env.local bytes change during screenshot capture", async () => {
  const active = await workspace();
  await execFileAsync("git", ["init"], { cwd: active.rootPath });
  await execFileAsync("git", ["config", "user.email", "render@example.test"], { cwd: active.rootPath });
  await execFileAsync("git", ["config", "user.name", "Render Test"], { cwd: active.rootPath });
  await writeFile(join(active.rootPath, ".gitignore"), ".env*\n");
  await writeFile(join(active.rootPath, "tracked.txt"), "committed\n");
  await execFileAsync("git", ["add", ".gitignore", "tracked.txt"], { cwd: active.rootPath });
  await execFileAsync("git", ["commit", "-m", "fixture"], { cwd: active.rootPath });
  await writeFile(join(active.rootPath, ".env.local"), "SECRET=before\n");
  const browser = fakeBrowser(
    "http://127.0.0.1:4310/",
    PNG,
    async () => writeFile(join(active.rootPath, ".env.local"), "SECRET=after\n"),
  );
  await expect(captureRender({
    workspace: { ...active, hasGit: true, capabilities: { ...active.capabilities, canUseGit: true } },
    baseUrl: "http://127.0.0.1:4310",
    route: "/",
    viewport: { name: "desktop", width: 1440, height: 800 },
    sessionId: "session-1",
    roundId: "round-1",
    browserLauncher: browser.launcher,
  })).rejects.toThrow(/source changed|fingerprint/i);
});

it("includes nested ignored .env files but excludes node_modules .env files from render inputs", async () => {
  const active = await workspace();
  await execFileAsync("git", ["init"], { cwd: active.rootPath });
  await execFileAsync("git", ["config", "user.email", "render@example.test"], { cwd: active.rootPath });
  await execFileAsync("git", ["config", "user.name", "Render Test"], { cwd: active.rootPath });
  await writeFile(join(active.rootPath, ".gitignore"), "ignored/\nnode_modules/\n");
  await writeFile(join(active.rootPath, "tracked.txt"), "committed\n");
  await execFileAsync("git", ["add", ".gitignore", "tracked.txt"], { cwd: active.rootPath });
  await execFileAsync("git", ["commit", "-m", "fixture"], { cwd: active.rootPath });
  await mkdir(join(active.rootPath, "ignored"), { recursive: true });
  await mkdir(join(active.rootPath, "node_modules", "pkg"), { recursive: true });
  await writeFile(join(active.rootPath, "ignored", ".env.local"), "NESTED=before\n");
  await writeFile(join(active.rootPath, "node_modules", "pkg", ".env.local"), "VENDOR=before\n");
  const gitWorkspace = { ...active, hasGit: true, capabilities: { ...active.capabilities, canUseGit: true } };
  await expect(captureRender({
    workspace: gitWorkspace,
    baseUrl: "http://127.0.0.1:4310",
    route: "/",
    viewport: { name: "desktop", width: 1440, height: 800 },
    sessionId: "session-1",
    roundId: "round-1",
    browserLauncher: fakeBrowser("http://127.0.0.1:4310/", PNG, async () => {
      await writeFile(join(active.rootPath, "ignored", ".env.local"), "NESTED=after\n");
      await writeFile(join(active.rootPath, "node_modules", "pkg", ".env.local"), "VENDOR=after\n");
    }).launcher,
  })).rejects.toThrow(/source changed|fingerprint/i);

  const clean = await captureRender({
    workspace: gitWorkspace,
    baseUrl: "http://127.0.0.1:4310",
    route: "/",
    viewport: { name: "desktop", width: 1440, height: 800 },
    sessionId: "session-1",
    roundId: "round-2",
    browserLauncher: fakeBrowser("http://127.0.0.1:4310/", PNG, async () => {
      await writeFile(join(active.rootPath, "node_modules", "pkg", ".env.local"), "VENDOR=again\n");
    }).launcher,
  });
  expect(clean.artifact.sourceRevision).toMatchObject({ fileCount: 3 });
});

it("fails closed on a source symlink whose target is outside the project", async () => {
  const active = await workspace();
  const outside = await mkdtemp(join(tmpdir(), "render-source-outside-"));
  try {
    await execFileAsync("git", ["init"], { cwd: active.rootPath });
    await execFileAsync("git", ["config", "user.email", "render@example.test"], { cwd: active.rootPath });
    await execFileAsync("git", ["config", "user.name", "Render Test"], { cwd: active.rootPath });
    await writeFile(join(active.rootPath, "tracked.txt"), "committed\n");
    await writeFile(join(outside, "secret.env"), "SECRET=outside\n");
    await symlink(join(outside, "secret.env"), join(active.rootPath, "linked.env"));
    await execFileAsync("git", ["add", "tracked.txt", "linked.env"], { cwd: active.rootPath });
    await execFileAsync("git", ["commit", "-m", "fixture"], { cwd: active.rootPath });
    await expect(captureRender({
      workspace: { ...active, hasGit: true, capabilities: { ...active.capabilities, canUseGit: true } },
      baseUrl: "http://127.0.0.1:4310",
      route: "/",
      viewport: { name: "desktop", width: 1440, height: 800 },
      sessionId: "session-1",
      roundId: "round-1",
      browserLauncher: fakeBrowser("http://127.0.0.1:4310/").launcher,
    })).rejects.toThrow(/source.*symlink|symlink.*source/i);
  } finally {
    await rm(outside, { recursive: true, force: true });
  }
});

// Production break caught: assume-unchanged/skip-worktree flags can hide modified tracked content behind a false CLEAN status.
it.each(["--assume-unchanged", "--skip-worktree"])(
  "refuses tracked paths carrying %s index flags",
  async (flag) => {
    const active = await workspace();
    await execFileAsync("git", ["init"], { cwd: active.rootPath });
    await execFileAsync("git", ["config", "user.email", "render@example.test"], { cwd: active.rootPath });
    await execFileAsync("git", ["config", "user.name", "Render Test"], { cwd: active.rootPath });
    await writeFile(join(active.rootPath, "tracked.txt"), "committed\n");
    await execFileAsync("git", ["add", "tracked.txt"], { cwd: active.rootPath });
    await execFileAsync("git", ["commit", "-m", "fixture"], { cwd: active.rootPath });
    await execFileAsync("git", ["update-index", flag, "tracked.txt"], { cwd: active.rootPath });
    await writeFile(join(active.rootPath, "tracked.txt"), "hidden-dirty\n");
    const browser = fakeBrowser("http://127.0.0.1:4310/");

    await expect(captureRender({
      workspace: { ...active, hasGit: true, capabilities: { ...active.capabilities, canUseGit: true } },
      baseUrl: "http://127.0.0.1:4310",
      route: "/",
      viewport: { name: "desktop", width: 1440, height: 800 },
      sessionId: "session-1",
      roundId: "round-1",
      browserLauncher: browser.launcher,
    })).rejects.toThrow(/assume-unchanged|skip-worktree|index flags/i);
  },
);

// Production break caught: a 513-path worktree used to persist only the first 512 status entries and call the evidence truthful.
it("refuses Git source evidence above the complete worktree file bound", async () => {
  const active = await workspace();
  await execFileAsync("git", ["init"], { cwd: active.rootPath });
  await execFileAsync("git", ["config", "user.email", "render@example.test"], { cwd: active.rootPath });
  await execFileAsync("git", ["config", "user.name", "Render Test"], { cwd: active.rootPath });
  await writeFile(join(active.rootPath, "tracked.txt"), "committed\n");
  await execFileAsync("git", ["add", "tracked.txt"], { cwd: active.rootPath });
  await execFileAsync("git", ["commit", "-m", "fixture"], { cwd: active.rootPath });
  for (let index = 0; index < 512; index += 1) {
    await writeFile(join(active.rootPath, `untracked-${String(index).padStart(3, "0")}.txt`), "x");
  }
  const browser = fakeBrowser("http://127.0.0.1:4310/");
  await expect(captureRender({
    workspace: { ...active, hasGit: true, capabilities: { ...active.capabilities, canUseGit: true } },
    baseUrl: "http://127.0.0.1:4310",
    route: "/",
    viewport: { name: "desktop", width: 1440, height: 800 },
    sessionId: "session-1",
    roundId: "round-1",
    browserLauncher: browser.launcher,
  })).rejects.toThrow(/file bound|too many/i);
});

// Production break caught: prior runtime renders can make unchanged product source look dirty and alter its fingerprint.
it("excludes .design-sharingan runtime artifacts from Git status and source fingerprints", async () => {
  const active = await workspace();
  await execFileAsync("git", ["init"], { cwd: active.rootPath });
  await execFileAsync("git", ["config", "user.email", "render@example.test"], { cwd: active.rootPath });
  await execFileAsync("git", ["config", "user.name", "Render Test"], { cwd: active.rootPath });
  await writeFile(join(active.rootPath, "tracked.txt"), "committed\n");
  await execFileAsync("git", ["add", "tracked.txt"], { cwd: active.rootPath });
  await execFileAsync("git", ["commit", "-m", "fixture"], { cwd: active.rootPath });
  const gitWorkspace = { ...active, hasGit: true, capabilities: { ...active.capabilities, canUseGit: true } };
  const first = await captureRender({
    workspace: gitWorkspace,
    baseUrl: "http://127.0.0.1:4310",
    route: "/",
    viewport: { name: "desktop", width: 1440, height: 800 },
    sessionId: "session-1",
    roundId: "round-1",
    browserLauncher: fakeBrowser("http://127.0.0.1:4310/").launcher,
  });
  const second = await captureRender({
    workspace: gitWorkspace,
    baseUrl: "http://127.0.0.1:4310",
    route: "/",
    viewport: { name: "desktop", width: 1440, height: 800 },
    sessionId: "session-1",
    roundId: "round-2",
    browserLauncher: fakeBrowser("http://127.0.0.1:4310/").launcher,
  });
  expect(first.artifact.sourceRevision).toMatchObject({ status: "CLEAN", entries: [] });
  expect(second.artifact.sourceRevision).toMatchObject({
    status: "CLEAN",
    entries: [],
    worktreeFingerprint: first.artifact.sourceRevision.kind === "GIT"
      ? first.artifact.sourceRevision.worktreeFingerprint
      : "unreachable",
  });
});

// Production break caught: parsing a byte-truncated NUL status field can claim a partial filename as truthful source evidence.
it("fails closed when bounded Git status evidence is truncated", async () => {
  const active = await workspace();
  await execFileAsync("git", ["init"], { cwd: active.rootPath });
  await execFileAsync("git", ["config", "user.email", "render@example.test"], { cwd: active.rootPath });
  await execFileAsync("git", ["config", "user.name", "Render Test"], { cwd: active.rootPath });
  await writeFile(join(active.rootPath, "tracked.txt"), "tracked\n");
  await execFileAsync("git", ["add", "tracked.txt"], { cwd: active.rootPath });
  await execFileAsync("git", ["commit", "-m", "fixture"], { cwd: active.rootPath });
  for (let index = 0; index < 300; index += 1) {
    await writeFile(join(active.rootPath, `${String(index).padStart(3, "0")}-${"x".repeat(220)}.txt`), "x");
  }
  const browser = fakeBrowser("http://127.0.0.1:4310/");
  await expect(captureRender({
    workspace: {
      ...active,
      hasGit: true,
      capabilities: { ...active.capabilities, canUseGit: true },
    },
    baseUrl: "http://127.0.0.1:4310",
    route: "/",
    viewport: { name: "desktop", width: 1440, height: 800 },
    sessionId: "session-1",
    roundId: "round-1",
    browserLauncher: browser.launcher,
  })).rejects.toThrow(/truncated|bounded|source evidence/i);
});

// Production break caught: a browser redirect, malformed route/identifier, or non-PNG response could mint false local render evidence.
it("rejects cross-origin navigation, unsafe inputs, and invalid screenshots while always closing browser resources", async () => {
  const active = await workspace();
  const redirected = fakeBrowser("https://example.com/account");
  await expect(captureRender({
    workspace: active,
    baseUrl: "http://127.0.0.1:4310",
    route: "/account",
    viewport: { name: "desktop", width: 1440, height: 800 },
    sessionId: "session-1",
    roundId: "round-1",
    browserLauncher: redirected.launcher,
  })).rejects.toThrow(/same origin/i);
  expect(redirected.calls.slice(-2)).toEqual(["page-close", "browser-close"]);

  const wrongRoute = fakeBrowser("http://127.0.0.1:4310/login?next=%2Faccount");
  await expect(captureRender({
    workspace: active,
    baseUrl: "http://127.0.0.1:4310",
    route: "/account",
    viewport: { name: "desktop", width: 1440, height: 800 },
    sessionId: "session-1",
    roundId: "round-1",
    browserLauncher: wrongRoute.launcher,
  })).rejects.toThrow(/requested route/i);
  expect(wrongRoute.calls.slice(-2)).toEqual(["page-close", "browser-close"]);

  const wrongDimensions = fakeBrowser("http://127.0.0.1:4310/");
  await expect(captureRender({
    workspace: active,
    baseUrl: "http://127.0.0.1:4310",
    route: "/",
    viewport: { name: "desktop", width: 1280, height: 720 },
    sessionId: "dimension-session",
    roundId: "round-1",
    browserLauncher: wrongDimensions.launcher,
  })).rejects.toThrow(/dimensions/i);
  expect(wrongDimensions.calls.slice(-2)).toEqual(["page-close", "browser-close"]);

  const invalidPng = fakeBrowser("http://127.0.0.1:4310/", new Uint8Array([1, 2, 3]));
  await expect(captureRender({
    workspace: active,
    baseUrl: "http://127.0.0.1:4310",
    route: "/",
    viewport: { name: "desktop", width: 1440, height: 800 },
    sessionId: "../escape",
    roundId: "round-1",
    browserLauncher: invalidPng.launcher,
  })).rejects.toThrow(/session id/i);

  await expect(captureRender({
    workspace: active,
    baseUrl: "http://127.0.0.1:4310",
    route: "/",
    viewport: { name: "desktop", width: 1440, height: 800 },
    sessionId: "session-1",
    roundId: "round-1",
    browserLauncher: invalidPng.launcher,
  })).rejects.toThrow(/PNG/i);
  expect(invalidPng.calls.slice(-2)).toEqual(["page-close", "browser-close"]);
});

// Production break caught: capture can bypass adapter authorization if invoked directly with a stale or read-only workspace object.
it("requires ready render, capture, and runtime-write capabilities before opening a browser", async () => {
  const active = await workspace();
  for (const unauthorized of [
    { ...active, status: "NEEDS_CONFIGURATION" as const },
    { ...active, capabilities: { ...active.capabilities, canRender: false } },
    { ...active, capabilities: { ...active.capabilities, canCapture: false } },
    { ...active, capabilities: { ...active.capabilities, canWriteFiles: false } },
  ]) {
    let launched = false;
    await expect(captureRender({
      workspace: unauthorized,
      baseUrl: "http://127.0.0.1:4310",
      route: "/",
      viewport: { name: "desktop", width: 1440, height: 800 },
      sessionId: "session-1",
      roundId: "round-1",
      browserLauncher: { async launch() { launched = true; return fakeBrowser("http://127.0.0.1:4310/").browser; } },
    })).rejects.toThrow(/workspace.*authorized|ready/i);
    expect(launched).toBe(false);
  }
});

it("refuses a declared Git workspace when complete Git evidence is not authorized", async () => {
  const active = await workspace();
  let launched = false;
  await expect(captureRender({
    workspace: { ...active, hasGit: true, capabilities: { ...active.capabilities, canUseGit: false } },
    baseUrl: "http://127.0.0.1:4310",
    route: "/",
    viewport: { name: "desktop", width: 1440, height: 800 },
    sessionId: "session-1",
    roundId: "round-1",
    browserLauncher: { async launch() { launched = true; return fakeBrowser("http://127.0.0.1:4310/").browser; } },
  })).rejects.toThrow(/Git evidence.*authorized|complete Git evidence/i);
  expect(launched).toBe(false);
});

// Production break caught: an artifact directory symlink can redirect screenshot writes outside runtime state.
it("refuses symlink traversal in the exact render artifact hierarchy", async () => {
  const active = await workspace();
  const outside = await mkdtemp(join(tmpdir(), "render-outside-"));
  await mkdir(join(active.rootPath, ".design-sharingan", "renders"), { recursive: true });
  await symlink(outside, join(active.rootPath, ".design-sharingan", "renders", "session-1"));
  const browser = fakeBrowser("http://127.0.0.1:4310/");

  await expect(captureRender({
    workspace: active,
    baseUrl: "http://127.0.0.1:4310",
    route: "/",
    viewport: { name: "desktop", width: 1440, height: 800 },
    sessionId: "session-1",
    roundId: "round-1",
    browserLauncher: browser.launcher,
  })).rejects.toThrow(/outside active project|render artifact hierarchy/i);
  await expect(readFile(join(outside, "round-1", "desktop.png"))).rejects.toThrow();
});

// Production break caught: capture stages that ignore cancellation can outlive the workflow and later mint stale evidence.
it("bounds non-cooperative browser navigation and cleans both resources without persisting", async () => {
  const active = await workspace();
  const calls: string[] = [];
  const page = {
    async goto() { return new Promise<never>(() => undefined); },
    url() { return "http://127.0.0.1:4310/"; },
    async screenshot() { return PNG; },
    async close() { calls.push("page-close"); },
  };
  const browser: BrowserHandle = {
    async newPage() { return page; },
    async close() { calls.push("browser-close"); },
  };
  await expect(Promise.race([
    captureRender({
      workspace: active,
      baseUrl: "http://127.0.0.1:4310",
      route: "/",
      viewport: { name: "desktop", width: 1440, height: 800 },
      sessionId: "session-1",
      roundId: "round-1",
      browserLauncher: { async launch() { return browser; } },
      timeoutMs: 5,
    }),
    new Promise((_, reject) => setTimeout(() => reject(new Error("test guard expired")), 250)),
  ])).rejects.toThrow(/capture.*timeout|timed out/i);
  expect(calls).toEqual(["page-close", "browser-close"]);
  await expect(readFile(join(active.rootPath, ".design-sharingan/renders/session-1/round-1/desktop.png"))).rejects.toThrow();
});

// Production break caught: a browser launched after the deadline can leak unless its late settlement is explicitly closed.
it("closes a browser that resolves after the overall capture deadline", async () => {
  const active = await workspace();
  let closeCalls = 0;
  const browser: BrowserHandle = {
    async newPage() { throw new Error("must not create a page"); },
    async close() { closeCalls += 1; },
  };
  await expect(captureRender({
    workspace: active,
    baseUrl: "http://127.0.0.1:4310",
    route: "/",
    viewport: { name: "desktop", width: 1440, height: 800 },
    sessionId: "session-1",
    roundId: "round-1",
    browserLauncher: { async launch() { await new Promise((resolve) => setTimeout(resolve, 30)); return browser; } },
    timeoutMs: 5,
  })).rejects.toThrow(/capture.*timeout|timed out/i);
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(closeCalls).toBe(1);
});

// Production break caught: successful bytes are not persistable when owned browser cleanup cannot be proven within the deadline.
it("refuses persistence when page cleanup never settles", async () => {
  const active = await workspace();
  let browserCloses = 0;
  const page = {
    async goto() {},
    url() { return "http://127.0.0.1:4310/"; },
    async screenshot() { return PNG; },
    async close() { return new Promise<void>(() => undefined); },
  };
  await expect(Promise.race([
    captureRender({
      workspace: active,
      baseUrl: "http://127.0.0.1:4310",
      route: "/",
      viewport: { name: "desktop", width: 1440, height: 800 },
      sessionId: "session-1",
      roundId: "round-1",
      browserLauncher: { async launch() { return { async newPage() { return page; }, async close() { browserCloses += 1; } }; } },
      timeoutMs: 5,
    }),
    new Promise((_, reject) => setTimeout(() => reject(new Error("test guard expired")), 250)),
  ])).rejects.toThrow(/cleanup|capture.*timeout|timed out/i);
  expect(browserCloses).toBe(1);
  await expect(readFile(join(active.rootPath, ".design-sharingan/renders/session-1/round-1/desktop.png"))).rejects.toThrow();
});

it("uses one bounded cleanup budget across page and browser closure", async () => {
  const active = await workspace();
  const page = {
    async goto() {},
    url() { return "http://127.0.0.1:4310/"; },
    async screenshot() { return PNG; },
    async close() { return new Promise<void>(() => undefined); },
  };
  const startedAt = Date.now();
  await expect(captureRender({
    workspace: active,
    baseUrl: "http://127.0.0.1:4310",
    route: "/",
    viewport: { name: "desktop", width: 1440, height: 800 },
    sessionId: "session-1",
    roundId: "round-1",
    browserLauncher: { async launch() { return { async newPage() { return page; }, async close() { return new Promise<void>(() => undefined); } }; } },
    timeoutMs: 50,
  })).rejects.toThrow(/cleanup.*timed out/i);
  expect(Date.now() - startedAt).toBeLessThan(90);
});

it("does not cross the persistence commit point when aborted by the timestamp provider", async () => {
  const active = await workspace();
  const controller = new AbortController();
  await expect(captureRender({
    workspace: active,
    baseUrl: "http://127.0.0.1:4310",
    route: "/",
    viewport: { name: "desktop", width: 1440, height: 800 },
    sessionId: "session-1",
    roundId: "round-1",
    browserLauncher: fakeBrowser("http://127.0.0.1:4310/").launcher,
    signal: controller.signal,
    now() { controller.abort(); return new Date("2026-08-25T09:00:00.000Z"); },
  })).rejects.toThrow(/aborted.*persistence/i);
  await expect(readFile(join(active.rootPath, ".design-sharingan/renders/session-1/round-1/desktop.png"))).rejects.toThrow();
});

// Production break caught: npm can exit while a server grandchild remains alive in the process group owned by the renderer.
it("terminates the owned process group even after its launcher has already exited", async () => {
  if (process.platform === "win32") return;
  const rootPath = await realpath(await mkdtemp(join(tmpdir(), "render-process-tree-")));
  const script = "const{spawn}=require('node:child_process'),fs=require('node:fs');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});fs.writeFileSync('descendant.pid',String(c.pid));c.unref();";
  await writeFile(join(rootPath, "package.json"), JSON.stringify({ scripts: { start: `node -e \"${script}\"` } }));
  const owned = defaultProcessRunner.start({
    executable: "npm",
    args: ["run", "start"],
    cwd: rootPath,
    env: { PATH: process.env.PATH },
    shell: false,
  });
  let descendantPid = 0;
  try {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        descendantPid = Number(await readFile(join(rootPath, "descendant.pid"), "utf8"));
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    expect(descendantPid).toBeGreaterThan(0);
    await owned.exited;
    expect(() => process.kill(descendantPid, 0)).not.toThrow();
    await owned.stop();
    expect(() => process.kill(descendantPid, 0)).toThrow();
  } finally {
    if (descendantPid > 0) {
      try { process.kill(descendantPid, "SIGKILL"); } catch { /* already stopped */ }
    }
    await rm(rootPath, { recursive: true, force: true });
  }
});
