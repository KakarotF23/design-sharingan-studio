import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { devNull } from "node:os";
import { join } from "node:path";
import { chromium } from "@playwright/test";
import type {
  GitStatusEntry,
  RenderArtifact,
  RenderSourceRevision,
} from "@design-sharingan/core";
import {
  saveRenderArtifact,
  type ProjectWorkspace,
} from "@design-sharingan/project-adapters";
import { assertLoopbackBaseUrl } from "./readiness";

const MAX_GIT_OUTPUT_BYTES = 65_536;
const MAX_GIT_ENTRIES = 512;
const GIT_TIMEOUT_MS = 5_000;
const PNG_SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

export interface RenderViewport {
  name: string;
  width: number;
  height: number;
}

export interface PageHandle {
  goto(url: string): Promise<unknown>;
  url(): string;
  screenshot(): Promise<Uint8Array>;
  close(): Promise<void>;
}

export interface BrowserHandle {
  newPage(options: { viewport: { width: number; height: number } }): Promise<PageHandle>;
  close(): Promise<void>;
}

export interface BrowserLauncher {
  launch(): Promise<BrowserHandle>;
}

export interface CaptureRenderOptions {
  workspace: ProjectWorkspace;
  baseUrl: string;
  route: string;
  viewport: RenderViewport;
  sessionId: string;
  roundId: string;
  browserLauncher?: BrowserLauncher;
  now?: () => Date;
  createId?: () => string;
}

export interface CaptureRenderResult {
  artifact: RenderArtifact;
  metadataPath: string;
}

const defaultBrowserLauncher: BrowserLauncher = {
  async launch(): Promise<BrowserHandle> {
    return chromium.launch() as unknown as BrowserHandle;
  },
};

function assertSafeIdentifier(value: string, label: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value)) {
    throw new Error(`${label} must be a safe identifier`);
  }
}

function assertViewport(viewport: RenderViewport): void {
  assertSafeIdentifier(viewport.name, "Viewport name");
  if (
    !Number.isSafeInteger(viewport.width) ||
    !Number.isSafeInteger(viewport.height) ||
    viewport.width < 240 ||
    viewport.width > 7680 ||
    viewport.height < 240 ||
    viewport.height > 7680
  ) {
    throw new Error("Viewport dimensions are outside the supported range");
  }
}

function captureUrl(baseUrl: string, route: string): URL {
  const base = assertLoopbackBaseUrl(baseUrl);
  let decodedRoute: string;
  try {
    decodedRoute = decodeURIComponent(route);
  } catch {
    throw new Error("Capture route must be a canonical same-origin relative route");
  }
  if (
    !route.startsWith("/") ||
    route.startsWith("//") ||
    route.includes("\\") ||
    /[\u0000-\u001f\u007f]/.test(route) ||
    /[\u0000-\u001f\u007f]/.test(decodedRoute)
  ) {
    throw new Error("Capture route must be a same-origin relative route");
  }
  const target = new URL(route, base);
  if (
    target.origin !== base.origin ||
    target.username !== "" ||
    target.password !== "" ||
    `${target.pathname}${target.search}${target.hash}` !== route
  ) {
    throw new Error("Capture route must remain on the same origin");
  }
  return target;
}

function assertPng(bytes: Uint8Array, viewport: RenderViewport): void {
  if (
    bytes.byteLength < 24 ||
    PNG_SIGNATURE.some((byte, index) => bytes[index] !== byte) ||
    bytes[12] !== 73 || bytes[13] !== 72 || bytes[14] !== 68 || bytes[15] !== 82
  ) {
    throw new Error("Browser capture did not return a non-empty PNG screenshot");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(16) !== viewport.width || view.getUint32(20) !== viewport.height) {
    throw new Error("PNG dimensions do not match the requested viewport dimensions");
  }
}

interface GitResult {
  ok: boolean;
  output: Buffer;
  truncated: boolean;
}

async function runGit(cwd: string, args: readonly string[]): Promise<GitResult> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let retainedBytes = 0;
    let originalBytes = 0;
    let finished = false;
    const environment: NodeJS.ProcessEnv = {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: undefined,
      XDG_CONFIG_HOME: undefined,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: devNull,
      GIT_CONFIG_SYSTEM: devNull,
      GIT_CONFIG_PARAMETERS: "",
      GIT_ATTR_NOSYSTEM: "1",
      GIT_OPTIONAL_LOCKS: "0",
      GIT_PAGER: "cat",
      GIT_TERMINAL_PROMPT: "0",
      LC_ALL: "C",
      LANG: "C",
    };
    const child = spawn("git", [
      "-c", "core.fsmonitor=false",
      "-c", "core.untrackedCache=false",
      "-c", `core.hooksPath=${devNull}`,
      "-c", "diff.external=",
      ...args,
    ], {
      cwd,
      env: environment,
      shell: false,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), GIT_TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => {
      originalBytes += chunk.length;
      if (retainedBytes < MAX_GIT_OUTPUT_BYTES) {
        const slice = chunk.subarray(0, MAX_GIT_OUTPUT_BYTES - retainedBytes);
        chunks.push(slice);
        retainedBytes += slice.length;
      }
    });
    const finish = (ok: boolean) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve({
        ok,
        output: Buffer.concat(chunks),
        truncated: originalBytes > MAX_GIT_OUTPUT_BYTES,
      });
    };
    child.once("error", () => finish(false));
    child.once("close", (code) => finish(code === 0));
  });
}

function safeEvidenceText(value: string, maxBytes: number, trimWhitespace = true): string {
  const candidate = trimWhitespace ? value.trim() : value;
  if (
    Buffer.byteLength(candidate, "utf8") > maxBytes ||
    candidate.includes("\0") ||
    candidate.includes("\n") ||
    candidate.includes("\r")
  ) {
    throw new Error("Git source evidence was malformed or exceeded its bound");
  }
  return candidate;
}

function parseGitStatus(output: Buffer): { entries: GitStatusEntry[]; truncated: boolean } {
  const fields = output.toString("utf8").split("\0");
  if (fields.at(-1) === "") fields.pop();
  const entries: GitStatusEntry[] = [];
  let truncated = false;
  for (let index = 0; index < fields.length; index += 1) {
    if (entries.length >= MAX_GIT_ENTRIES) {
      truncated = true;
      break;
    }
    const field = fields[index] ?? "";
    if (field.length < 4 || field[2] !== " ") {
      throw new Error("Git status evidence was malformed");
    }
    const entry: GitStatusEntry = {
      index: field[0] as string,
      workingTree: field[1] as string,
      path: safeEvidenceText(field.slice(3), 1024, false),
    };
    if (entry.index === "R" || entry.index === "C" || entry.workingTree === "R" || entry.workingTree === "C") {
      const originalPath = fields[index + 1];
      if (originalPath === undefined) throw new Error("Git rename evidence was malformed");
      entry.originalPath = safeEvidenceText(originalPath, 1024, false);
      index += 1;
    }
    entries.push(entry);
  }
  return { entries, truncated };
}

async function captureSourceRevision(workspace: ProjectWorkspace): Promise<RenderSourceRevision> {
  if (!workspace.hasGit || !workspace.capabilities.canUseGit) {
    return { kind: "UNVERSIONED", available: false, reason: "NOT_A_GIT_WORKSPACE" };
  }
  const [inside, head, branch, status] = await Promise.all([
    runGit(workspace.rootPath, ["rev-parse", "--is-inside-work-tree"]),
    runGit(workspace.rootPath, ["rev-parse", "--verify", "HEAD"]),
    runGit(workspace.rootPath, ["symbolic-ref", "--quiet", "--short", "HEAD"]),
    runGit(workspace.rootPath, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", "."]),
  ]);
  if (
    !inside.ok || inside.output.toString("utf8").trim() !== "true" ||
    !head.ok || head.truncated || !status.ok || status.truncated
  ) {
    return { kind: "UNVERSIONED", available: false, reason: "GIT_EVIDENCE_UNAVAILABLE" };
  }
  const headValue = safeEvidenceText(head.output.toString("utf8"), 64);
  if (!/^[0-9a-f]{40,64}$/i.test(headValue)) {
    return { kind: "UNVERSIONED", available: false, reason: "GIT_EVIDENCE_UNAVAILABLE" };
  }
  const parsed = parseGitStatus(status.output);
  return {
    kind: "GIT",
    available: true,
    head: headValue,
    branch: branch.ok && !branch.truncated
      ? safeEvidenceText(branch.output.toString("utf8"), 255)
      : "DETACHED",
    status: parsed.entries.length === 0 && !status.truncated ? "CLEAN" : "DIRTY",
    entries: parsed.entries,
    truncated: status.truncated || parsed.truncated,
  };
}

export async function captureRender(options: CaptureRenderOptions): Promise<CaptureRenderResult> {
  if (
    options.workspace.status !== "READY" ||
    !options.workspace.capabilities.canRender ||
    !options.workspace.capabilities.canCapture ||
    !options.workspace.capabilities.canWriteFiles
  ) {
    throw new Error("Workspace is not ready or authorized to render, capture, and persist evidence");
  }
  assertSafeIdentifier(options.sessionId, "Session id");
  assertSafeIdentifier(options.roundId, "Round id");
  assertViewport(options.viewport);
  const target = captureUrl(options.baseUrl, options.route);
  const beforeRevision = await captureSourceRevision(options.workspace);
  const browser = await (options.browserLauncher ?? defaultBrowserLauncher).launch();
  let page: PageHandle | undefined;
  let screenshot: Uint8Array;
  try {
    page = await browser.newPage({
      viewport: { width: options.viewport.width, height: options.viewport.height },
    });
    await page.goto(target.href);
    const finalUrl = new URL(page.url());
    if (finalUrl.origin !== target.origin) {
      throw new Error("Captured page did not remain on the same origin");
    }
    if (
      finalUrl.pathname !== target.pathname ||
      finalUrl.search !== target.search ||
      finalUrl.hash !== target.hash
    ) {
      throw new Error("Captured page did not remain on the requested route");
    }
    screenshot = await page.screenshot();
    assertPng(screenshot, options.viewport);
  } finally {
    await page?.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
  }
  const afterRevision = await captureSourceRevision(options.workspace);
  if (JSON.stringify(beforeRevision) !== JSON.stringify(afterRevision)) {
    throw new Error("Project source changed during capture; refusing stale render evidence");
  }
  const capturedAt = (options.now ?? (() => new Date()))().toISOString();
  const imagePath = join(
    options.workspace.rootPath,
    ".design-sharingan",
    "renders",
    options.sessionId,
    options.roundId,
    `${options.viewport.name}.png`,
  );
  const artifact: RenderArtifact = {
    id: (options.createId ?? randomUUID)(),
    sessionId: options.sessionId,
    roundId: options.roundId,
    route: options.route,
    viewport: options.viewport.name,
    viewportWidth: options.viewport.width,
    viewportHeight: options.viewport.height,
    imagePath,
    capturedAt,
    sourceRevision: afterRevision,
  };
  const saved = await saveRenderArtifact(options.workspace.rootPath, artifact, screenshot);
  return {
    artifact: { ...artifact, imagePath: saved.artifactPath },
    metadataPath: saved.metadataPath,
  };
}
