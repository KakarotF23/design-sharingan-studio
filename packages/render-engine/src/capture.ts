import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { devNull } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { chromium } from "@playwright/test";
import type {
  GitStatusEntry,
  RenderArtifact,
  RenderSourcePathEvidence,
  RenderSourceRevision,
} from "@design-sharingan/core";
import {
  saveRenderArtifact,
  type ProjectWorkspace,
} from "@design-sharingan/project-adapters";
import { assertLoopbackBaseUrl } from "./readiness";

const MAX_GIT_OUTPUT_BYTES = 65_536;
const MAX_GIT_ENTRIES = 512;
const MAX_SOURCE_FILE_BYTES = 16 * 1024 * 1024;
const MAX_SOURCE_TOTAL_BYTES = 64 * 1024 * 1024;
const GIT_TIMEOUT_MS = 5_000;
const PNG_SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const UNVERSIONED_EXCLUDED_DIRECTORIES = new Set([
  ".design-sharingan",
  ".git",
  ".next",
  ".turbo",
  ".cache",
  "node_modules",
  "dist",
  "build",
  "coverage",
]);
// Audit publication is an output of render verification, not an input to it.
// The Genome and Design Decisions remain source inputs and still invalidate evidence.
const GENERATED_AUDIT_OUTPUTS = new Set(["design-governance/DRIFT-REPORT.md", "design-governance/SCREEN-REGISTRY.md"]);

export interface RenderViewport {
  name: string;
  width: number;
  height: number;
}

export interface PageHandle {
  goto(url: string): Promise<unknown>;
  url(): string;
  screenshot(): Promise<Uint8Array>;
  evaluate?(fn: () => string | null): Promise<string | null>;
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
  timeoutMs?: number;
  signal?: AbortSignal;
  requiredSourcePaths?: readonly string[];
  expectedState?: string;
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
    const environment: Record<string, string | undefined> = {
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
      env: environment as NodeJS.ProcessEnv,
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
  if (output.length > 0 && output.at(-1) !== 0) {
    throw new Error("Git status evidence was truncated or malformed");
  }
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

function parseNulPaths(output: Buffer, label: string): string[] {
  if (output.length > 0 && output.at(-1) !== 0) {
    throw new Error(`${label} was truncated or malformed`);
  }
  if (!output.equals(Buffer.from(output.toString("utf8"), "utf8"))) {
    throw new Error(`${label} contained invalid UTF-8`);
  }
  const fields = output.toString("utf8").split("\0");
  if (fields.at(-1) === "") fields.pop();
  if (fields.length > MAX_GIT_ENTRIES) {
    throw new Error("Git source evidence exceeded the complete worktree file bound");
  }
  return fields.map((field) => safeEvidenceText(field, 1024, false));
}

function assertSafeSourcePath(rootPath: string, path: string): string {
  if (
    isAbsolute(path) || path === "" || path === "." || path === ".." ||
    path.startsWith("../") || path.includes("\0") || path.includes("\r") || path.includes("\n") ||
    path === ".git" || path.startsWith(".git/") ||
    path === ".design-sharingan" || path.startsWith(".design-sharingan/")
  ) {
    throw new Error("Git source evidence contained an unsafe path");
  }
  const absolute = resolve(rootPath, path);
  const fromRoot = relative(rootPath, absolute);
  if (fromRoot.startsWith("..") || isAbsolute(fromRoot)) {
    throw new Error("Git source evidence escaped the project root");
  }
  return absolute;
}

function requiredSourcePaths(rootPath: string, paths: readonly string[]): string[] {
  if (
    paths.length > 128 ||
    new Set(paths).size !== paths.length
  ) {
    throw new Error("Required source-path evidence is duplicate or exceeds its bound");
  }
  return paths.map((path) => {
    safeEvidenceText(path, 1024, false);
    assertSafeSourcePath(rootPath, path);
    return path;
  });
}

async function assertSafeSourceAncestors(rootPath: string, path: string): Promise<void> {
  let current = rootPath;
  for (const segment of path.split("/").slice(0, -1)) {
    current = join(current, segment);
    const entry = await lstat(current).catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
      throw error;
    });
    if (entry === undefined) return;
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      throw new Error("Required source-path evidence has an unsafe ancestor");
    }
  }
}

async function captureRequiredPathEvidence(
  rootPath: string,
  requiredPaths: readonly string[],
): Promise<RenderSourcePathEvidence[]> {
  const evidence: RenderSourcePathEvidence[] = [];
  let totalBytes = 0;
  for (const path of requiredPaths) {
    await assertSafeSourceAncestors(rootPath, path);
    const absolute = assertSafeSourcePath(rootPath, path);
    const before = await lstat(absolute).catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
      throw error;
    });
    if (before === undefined) {
      evidence.push({ path, state: "MISSING" });
      continue;
    }
    if (before.isSymbolicLink()) {
      throw new Error("Required source-path evidence refused a source symlink");
    }
    if (!before.isFile() || before.nlink !== 1) {
      throw new Error("Required source-path evidence refused a non-file or hard-linked path");
    }
    if (
      !Number.isSafeInteger(before.size) ||
      before.size < 0 ||
      before.size > MAX_SOURCE_FILE_BYTES ||
      totalBytes + before.size > MAX_SOURCE_TOTAL_BYTES
    ) {
      throw new Error("Required source-path evidence exceeded its content byte bound");
    }
    const handle = await open(absolute, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    try {
      const opened = await handle.stat();
      if (
        opened.dev !== before.dev ||
        opened.ino !== before.ino ||
        opened.size !== before.size ||
        opened.mode !== before.mode ||
        opened.nlink !== 1 ||
        !opened.isFile()
      ) {
        throw new Error("Required source path changed while evidence was captured");
      }
      const contents = Buffer.alloc(opened.size);
      let offset = 0;
      while (offset < contents.length) {
        const read = await handle.read(contents, offset, contents.length - offset, offset);
        if (read.bytesRead === 0) {
          throw new Error("Required source content changed while evidence was captured");
        }
        offset += read.bytesRead;
      }
      const overflow = Buffer.alloc(1);
      if ((await handle.read(overflow, 0, 1, contents.length)).bytesRead !== 0) {
        throw new Error("Required source content exceeded its authenticated byte bound");
      }
      const after = await handle.stat();
      if (
        after.dev !== opened.dev ||
        after.ino !== opened.ino ||
        after.size !== opened.size ||
        after.mode !== opened.mode ||
        after.mtimeMs !== opened.mtimeMs
      ) {
        throw new Error("Required source content changed while evidence was captured");
      }
      totalBytes += contents.length;
      evidence.push({
        path,
        state: "FILE",
        mode: opened.mode & 0o777,
        size: opened.size,
        contentHash: createHash("sha256").update(contents).digest("hex"),
      });
    } finally {
      await handle.close();
    }
  }
  return evidence;
}

function hashField(hash: ReturnType<typeof createHash>, label: string, value: string | Buffer): void {
  const bytes = typeof value === "string" ? Buffer.from(value, "utf8") : value;
  hash.update(`${label}:${bytes.length}:`, "utf8");
  hash.update(bytes);
  hash.update("\0", "utf8");
}

async function fingerprintWorktree(rootPath: string, paths: readonly string[]): Promise<string> {
  const hash = createHash("sha256");
  let totalBytes = 0;
  for (const path of [...paths].sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)))) {
    const absolute = assertSafeSourcePath(rootPath, path);
    hashField(hash, "path", path);
    let before;
    try {
      before = await lstat(absolute);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        hashField(hash, "type", "missing");
        continue;
      }
      throw error;
    }
    if (before.nlink > 1) throw new Error("Git source evidence refused a hard-linked path");
    hashField(hash, "mode", String(before.mode));
    if (before.isSymbolicLink()) throw new Error("Git render source evidence refused a source symlink");
    if (!before.isFile()) throw new Error("Git source evidence contained an unsupported file type");
    if (before.size > MAX_SOURCE_FILE_BYTES || totalBytes + before.size > MAX_SOURCE_TOTAL_BYTES) {
      throw new Error("Git source evidence exceeded its content byte bound");
    }
    const handle = await open(absolute, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    try {
      const opened = await handle.stat();
      if (opened.dev !== before.dev || opened.ino !== before.ino || opened.nlink > 1 || !opened.isFile()) {
        throw new Error("Git source path changed while evidence was captured");
      }
      if (
        !Number.isSafeInteger(opened.size) || opened.size < 0 ||
        opened.size > MAX_SOURCE_FILE_BYTES || totalBytes + opened.size > MAX_SOURCE_TOTAL_BYTES
      ) {
        throw new Error("Git source evidence exceeded its content byte bound");
      }
      const content = Buffer.alloc(opened.size);
      let offset = 0;
      while (offset < content.length) {
        const read = await handle.read(content, offset, content.length - offset, offset);
        if (read.bytesRead === 0) throw new Error("Git source content changed while evidence was captured");
        offset += read.bytesRead;
      }
      const overflow = Buffer.alloc(1);
      if ((await handle.read(overflow, 0, 1, content.length)).bytesRead !== 0) {
        throw new Error("Git source content exceeded its bounded snapshot while evidence was captured");
      }
      const after = await handle.stat();
      if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ino !== opened.ino || content.length !== opened.size) {
        throw new Error("Git source content changed while evidence was captured");
      }
      totalBytes += content.length;
      hashField(hash, "file", content);
    } finally {
      await handle.close();
    }
  }
  return hash.digest("hex");
}

async function requireGit(cwd: string, args: readonly string[], label: string): Promise<Buffer> {
  const result = await runGit(cwd, args);
  if (!result.ok || result.truncated) {
    throw new Error(`${label} was unavailable, truncated, or exceeded its bounded source evidence`);
  }
  return result.output;
}

const SOURCE_PATHSPECS = [
  ".",
  ":(exclude).design-sharingan",
  ":(exclude).design-sharingan/**",
  ":(exclude)design-governance/DRIFT-REPORT.md",
  ":(exclude)design-governance/SCREEN-REGISTRY.md",
] as const;
const IGNORED_RENDER_INPUT_PATHSPECS = [
  ".env*",
  ":(glob)**/.env*",
  ":(exclude,glob)**/node_modules/**",
  ":(exclude,glob)**/.next/**",
  ":(exclude,glob)**/dist/**",
  ":(exclude,glob)**/build/**",
  ":(exclude,glob)**/coverage/**",
  ":(exclude,glob)**/.turbo/**",
  ":(exclude,glob)**/.cache/**",
  ":(exclude,glob).design-sharingan/**",
] as const;

async function captureGitSnapshot(
  workspace: ProjectWorkspace,
  requiredPaths: readonly string[],
): Promise<RenderSourceRevision> {
  const inside = await requireGit(workspace.rootPath, ["rev-parse", "--is-inside-work-tree"], "Git worktree evidence");
  if (safeEvidenceText(inside.toString("utf8"), 8) !== "true") throw new Error("Project root is not a Git worktree");
  const topLevel = safeEvidenceText(
    (await requireGit(workspace.rootPath, ["rev-parse", "--show-toplevel"], "Git top-level evidence")).toString("utf8"),
    4096,
  );
  if (await realpath(topLevel) !== await realpath(workspace.rootPath)) {
    throw new Error("Git top-level does not match the canonical project root");
  }
  const headBefore = safeEvidenceText(
    (await requireGit(workspace.rootPath, ["rev-parse", "--verify", "HEAD"], "Git HEAD evidence")).toString("utf8"),
    64,
  );
  if (!/^[0-9a-f]{40,64}$/i.test(headBefore)) throw new Error("Git HEAD evidence was malformed");
  const branchResult = await runGit(workspace.rootPath, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (branchResult.truncated) throw new Error("Git branch evidence exceeded its bound");
  const branch = branchResult.ok ? safeEvidenceText(branchResult.output.toString("utf8"), 255) : "DETACHED";

  const flags = parseNulPaths(
    await requireGit(workspace.rootPath, ["ls-files", "-v", "-z", "--", ...SOURCE_PATHSPECS], "Git index flag evidence"),
    "Git index flag evidence",
  );
  for (const field of flags) {
    if (field.length < 3 || field[1] !== " ") throw new Error("Git index flag evidence was malformed");
    const tag = field[0] ?? "";
    if (tag === "S" || tag.toLowerCase() === tag) {
      throw new Error("Git source evidence refused assume-unchanged or skip-worktree index flags");
    }
    assertSafeSourcePath(workspace.rootPath, field.slice(2));
  }

  const ordinaryPaths = parseNulPaths(
    await requireGit(
      workspace.rootPath,
      ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ...SOURCE_PATHSPECS],
      "Git worktree path evidence",
    ),
    "Git worktree path evidence",
  );
  const ignoredRenderInputs = parseNulPaths(
    await requireGit(
      workspace.rootPath,
      ["ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--", ...IGNORED_RENDER_INPUT_PATHSPECS],
      "Ignored render-input evidence",
    ),
    "Ignored render-input evidence",
  );
  const paths = [...new Set([...ordinaryPaths, ...ignoredRenderInputs, ...requiredPaths])];
  if (paths.length > MAX_GIT_ENTRIES) {
    throw new Error("Git source evidence exceeded the complete render-input file bound");
  }
  const statusOutput = await requireGit(
    workspace.rootPath,
    ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", ...SOURCE_PATHSPECS],
    "Git status evidence",
  );
  const parsed = parseGitStatus(statusOutput);
  if (parsed.truncated) throw new Error("Git status evidence exceeded its complete entry bound");
  const worktreeFingerprint = await fingerprintWorktree(workspace.rootPath, paths);
  const requiredPathEvidence = await captureRequiredPathEvidence(
    workspace.rootPath,
    requiredPaths,
  );
  const headAfter = safeEvidenceText(
    (await requireGit(workspace.rootPath, ["rev-parse", "--verify", "HEAD"], "Git HEAD recheck")).toString("utf8"),
    64,
  );
  if (headBefore !== headAfter) throw new Error("Git HEAD changed while source evidence was captured");
  return {
    kind: "GIT",
    available: true,
    head: headAfter,
    branch,
    status: parsed.entries.length === 0 ? "CLEAN" : "DIRTY",
    entries: parsed.entries,
    truncated: false,
    worktreeFingerprint,
    fileCount: paths.length,
    requiredPathEvidence,
  };
}

async function unversionedSourcePaths(rootPath: string): Promise<string[]> {
  const paths: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(join(rootPath, directory), { withFileTypes: true });
    entries.sort((left, right) => Buffer.compare(Buffer.from(left.name), Buffer.from(right.name)));
    for (const entry of entries) {
      if (entry.name.includes("\0") || entry.name.includes("\n") || entry.name.includes("\r")) {
        throw new Error("Unversioned source evidence contained an unsafe path");
      }
      const path = directory === "" ? entry.name : `${directory}/${entry.name}`;
      if (GENERATED_AUDIT_OUTPUTS.has(path)) continue;
      safeEvidenceText(path, 1024, false);
      if (entry.isDirectory() && UNVERSIONED_EXCLUDED_DIRECTORIES.has(entry.name)) {
        continue;
      }
      const absolute = assertSafeSourcePath(rootPath, path);
      const metadata = await lstat(absolute);
      if (metadata.isSymbolicLink()) {
        throw new Error("Unversioned render source evidence refused a source symlink");
      }
      if (metadata.isDirectory()) {
        await visit(path);
        continue;
      }
      if (!metadata.isFile()) {
        throw new Error("Unversioned source evidence contained an unsupported file type");
      }
      paths.push(path);
      if (paths.length > MAX_GIT_ENTRIES) {
        throw new Error("Unversioned source evidence exceeded the complete render-input file bound");
      }
    }
  };
  await visit("");
  return paths;
}

async function captureUnversionedSnapshot(
  workspace: ProjectWorkspace,
  requiredPaths: readonly string[],
): Promise<RenderSourceRevision> {
  const paths = [...new Set([
    ...await unversionedSourcePaths(workspace.rootPath),
    ...requiredPaths,
  ])];
  if (paths.length > MAX_GIT_ENTRIES) {
    throw new Error("Unversioned source evidence exceeded the complete render-input file bound");
  }
  return {
    kind: "UNVERSIONED",
    available: true,
    truncated: false,
    worktreeFingerprint: await fingerprintWorktree(workspace.rootPath, paths),
    fileCount: paths.length,
    requiredPathEvidence: await captureRequiredPathEvidence(
      workspace.rootPath,
      requiredPaths,
    ),
  };
}

export async function captureWorkspaceSourceRevision(
  workspace: ProjectWorkspace,
  requiredPathsInput: readonly string[] = [],
): Promise<RenderSourceRevision> {
  const requiredPaths = requiredSourcePaths(workspace.rootPath, requiredPathsInput);
  if (!workspace.hasGit) {
    const first = await captureUnversionedSnapshot(workspace, requiredPaths);
    const second = await captureUnversionedSnapshot(workspace, requiredPaths);
    if (JSON.stringify(first) !== JSON.stringify(second)) {
      throw new Error("Unversioned source evidence changed while its coherent snapshot was captured");
    }
    return second;
  }
  if (!workspace.capabilities.canUseGit) {
    throw new Error("Complete Git evidence is not authorized for this declared Git workspace");
  }
  const first = await captureGitSnapshot(workspace, requiredPaths);
  const second = await captureGitSnapshot(workspace, requiredPaths);
  if (JSON.stringify(first) !== JSON.stringify(second)) {
    throw new Error("Git source evidence changed while its coherent snapshot was captured");
  }
  return second;
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
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 120_000) {
    throw new Error("Capture timeout is outside the supported range");
  }
  if (options.signal?.aborted) throw new Error("Render capture was aborted");
  const deadline = Date.now() + timeoutMs;
  const stage = async <T>(
    promise: Promise<T>,
    label: string,
    onLateResolve?: (value: T) => void | Promise<void>,
  ): Promise<T> => {
    if (options.signal?.aborted) {
      if (onLateResolve !== undefined) void promise.then(onLateResolve, () => undefined);
      throw new Error(`Render capture was aborted during ${label}`);
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      if (onLateResolve !== undefined) void promise.then(onLateResolve, () => undefined);
      throw new Error(`Render capture timed out during ${label}`);
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abortListener: (() => void) | undefined;
    const interruption = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`Render capture timed out during ${label}`)), remaining);
      abortListener = () => reject(new Error(`Render capture was aborted during ${label}`));
      options.signal?.addEventListener("abort", abortListener, { once: true });
    });
    try {
      return await Promise.race([promise, interruption]);
    } catch (error) {
      if (onLateResolve !== undefined) void promise.then(onLateResolve, () => undefined);
      throw error;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (abortListener !== undefined) options.signal?.removeEventListener("abort", abortListener);
    }
  };
  const cleanupBoundMs = Math.max(1, Math.min(1_000, timeoutMs));
  const cleanup = async (
    operation: Promise<void>,
    label: string,
    cleanupDeadline = Date.now() + cleanupBoundMs,
  ): Promise<void> => {
    const remaining = cleanupDeadline - Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      if (remaining <= 0) throw new Error(`Render capture cleanup timed out while closing ${label}`);
      await Promise.race([
        operation,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error(`Render capture cleanup timed out while closing ${label}`)), remaining);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      void operation.catch(() => undefined);
    }
  };
  const target = captureUrl(options.baseUrl, options.route);
  const beforeRevision = await stage(
    captureWorkspaceSourceRevision(options.workspace, options.requiredSourcePaths),
    "source revision",
  );
  const browserPromise = (options.browserLauncher ?? defaultBrowserLauncher).launch();
  const browser = await stage(browserPromise, "browser launch", async (lateBrowser) => {
    await cleanup(lateBrowser.close(), "late browser").catch(() => undefined);
  });
  let page: PageHandle | undefined;
  let screenshot: Uint8Array | undefined;
  let captureError: unknown;
  let cleanupError: unknown;
  try {
    const pagePromise = browser.newPage({
      viewport: { width: options.viewport.width, height: options.viewport.height },
    });
    page = await stage(pagePromise, "page creation", async (latePage) => {
      await cleanup(latePage.close(), "late page").catch(() => undefined);
    });
    await stage(page.goto(target.href), "page navigation");
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
    const assertCapturedState = async () => {
      if (options.expectedState === undefined) return;
      if (page?.evaluate === undefined) throw new Error("Captured state cannot be authenticated");
      const state = await stage(page.evaluate(() => document.querySelector("[data-design-state]")?.getAttribute("data-design-state") ?? null), "rendered state");
      if ((options.expectedState === "default" && state !== null && state !== "default") || (options.expectedState !== "default" && state !== options.expectedState)) throw new Error("Captured page does not attest the requested state");
    };
    await assertCapturedState();
    screenshot = await stage(page.screenshot(), "screenshot");
    await assertCapturedState();
    assertPng(screenshot, options.viewport);
  } catch (error) {
    captureError = error;
  } finally {
    const ownedCleanupDeadline = Date.now() + cleanupBoundMs;
    if (page !== undefined) {
      try { await cleanup(page.close(), "page", ownedCleanupDeadline); } catch (error) { cleanupError ??= error; }
    }
    try { await cleanup(browser.close(), "browser", ownedCleanupDeadline); } catch (error) { cleanupError ??= error; }
  }
  if (cleanupError !== undefined) throw cleanupError;
  if (captureError !== undefined) throw captureError;
  if (screenshot === undefined) throw new Error("Render capture did not produce screenshot bytes");
  const afterRevision = await stage(
    captureWorkspaceSourceRevision(options.workspace, options.requiredSourcePaths),
    "source revision recheck",
  );
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
  if (options.signal?.aborted) throw new Error("Render capture was aborted before evidence persistence");
  if (Date.now() >= deadline) throw new Error("Render capture timed out before evidence persistence");
  const saved = await saveRenderArtifact(options.workspace.rootPath, artifact, screenshot);
  return {
    artifact: { ...artifact, imagePath: saved.artifactPath },
    metadataPath: saved.metadataPath,
  };
}
