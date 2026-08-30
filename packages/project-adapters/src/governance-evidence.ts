import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { extname, isAbsolute, join, posix } from "node:path";
import type { RenderArtifact } from "@design-sharingan/core";
import { loadMangekyoLoopSession } from "./mangekyo-loop-store";
import { assertPathInsideWorkspace } from "./path-policy";
import { listSessions } from "./workspace-store";

export interface AdapterGovernanceEvidence {
  id: string;
  kind: "RENDER" | "ROUTE" | "NAVIGATION" | "COMPONENT" | "TOKEN" | "DOCUMENT";
  excerpt: string;
  route: string;
  authenticatedRenderId?: string;
}

export interface CollectGovernanceEvidenceInput {
  rootPath: string;
  projectId: string;
  routes: readonly string[];
  designDocuments: readonly string[];
  componentDirectories: readonly string[];
  createId?(): string;
}

const MAX_EVIDENCE = 32;
const MAX_FILE_BYTES = 64 * 1024;
const MAX_EXCERPT_BYTES = 4_096;
const SECRET_PATTERN = /(?:sk-[a-zA-Z0-9_-]{8,}|gh[pousr]_[a-zA-Z0-9]{12,}|AKIA[A-Z0-9]{12,}|Bearer\s+[a-zA-Z0-9._-]{8,}|(?:api[_-]?key|token|secret|password)\s*[:=]\s*[^\s,;]+)/gi;
const PATH_PATTERN = /(?:\/(?:[a-zA-Z0-9._-]+\/)+[a-zA-Z0-9._-]+|[A-Za-z]:\\[^\s,;]+)/g;

function scrub(value: string): string {
  return value
    .replace(SECRET_PATTERN, "[REDACTED]")
    .replace(PATH_PATTERN, "[REDACTED]")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1_000);
}

function safeRelativePath(value: string, label: string): string {
  if (
    value.length === 0 || value.length > 512 || isAbsolute(value) ||
    value.includes("\\") || value.includes("\0") || value === ".." ||
    value.startsWith("../") || posix.normalize(value) !== value
  ) throw new Error(`${label} is not a safe project-relative path`);
  return value;
}

function safeRoute(value: string): string {
  let decoded: string;
  try { decoded = decodeURIComponent(value); } catch { throw new Error("Governance evidence route is invalid"); }
  if (
    !value.startsWith("/") || value.length > 512 || decoded.includes("\\") ||
    /[\u0000-\u001f\u007f]/.test(decoded) || decoded.includes("//") ||
    posix.normalize(decoded) !== decoded || /(^|\/)\.\.?($|\/)/.test(decoded)
  ) throw new Error("Governance evidence route is invalid");
  return value;
}

async function pathExists(path: string): Promise<boolean> {
  try { await lstat(path); return true; } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

async function readSafeExcerpt(
  root: string,
  relativePath: string,
  allowDirectory = false,
): Promise<string | undefined> {
  const relative = safeRelativePath(relativePath, "Governance evidence path");
  const candidate = join(root, relative);
  if (!(await pathExists(candidate))) return undefined;
  const before = await lstat(candidate);
  if (before.isSymbolicLink()) throw new Error("Governance evidence file must not be a symbolic link");
  if (before.isDirectory() && allowDirectory) return undefined;
  if (!before.isFile() || before.nlink !== 1) throw new Error("Governance evidence file must be a private regular file");
  if (before.size > MAX_FILE_BYTES) return undefined;
  const path = assertPathInsideWorkspace(root, candidate);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    if (opened.dev !== before.dev || opened.ino !== before.ino || !opened.isFile() || opened.nlink !== 1) {
      throw new Error("Governance evidence identity changed while it was opened");
    }
    const buffer = Buffer.alloc(Math.min(MAX_EXCERPT_BYTES, opened.size));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const current = await lstat(path);
    if (current.dev !== opened.dev || current.ino !== opened.ino || current.nlink !== 1) {
      throw new Error("Governance evidence identity changed while it was read");
    }
    const excerpt = scrub(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, bytesRead)));
    return excerpt.length === 0 ? undefined : excerpt;
  } finally {
    await handle.close();
  }
}

function evidenceId(factory: () => string): string {
  const id = factory();
  if (!/^ev_[a-zA-Z0-9_-]{8,125}$/.test(id)) {
    throw new Error("Governance evidence factory returned an unsafe identity");
  }
  return id;
}

function renderArtifacts(session: Awaited<ReturnType<typeof loadMangekyoLoopSession>>): RenderArtifact[] {
  return [
    session.initialRender,
    session.finalRender,
    ...session.rounds.flatMap(({ round }) => [round.beforeRender, round.afterRender]),
  ].filter((artifact): artifact is RenderArtifact => artifact !== undefined);
}

export async function collectGovernanceEvidence(
  input: CollectGovernanceEvidenceInput,
): Promise<AdapterGovernanceEvidence[]> {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(input.projectId)) {
    throw new Error("Governance evidence project identity is invalid");
  }
  const root = await realpath(input.rootPath);
  if (root !== input.rootPath) throw new Error("Governance evidence requires a canonical project root");
  const rootEntry = await lstat(root);
  if (rootEntry.isSymbolicLink() || !rootEntry.isDirectory()) {
    throw new Error("Governance evidence project root is unsafe");
  }
  if (input.routes.length === 0 || input.routes.length > 16) {
    throw new Error("Governance evidence routes must be representative and bounded");
  }
  const routes = input.routes.map(safeRoute);
  if (new Set(routes).size !== routes.length) throw new Error("Governance evidence routes must be unique");
  const createId = input.createId ?? (() => `ev_${randomUUID().replaceAll("-", "")}`);
  const evidence: AdapterGovernanceEvidence[] = routes.map((route) => ({
    id: evidenceId(createId),
    kind: "ROUTE",
    excerpt: `Authenticated project inspection detected this current route.`,
    route,
  }));
  const representativeRoute = routes[0]!;

  for (const document of input.designDocuments.slice(0, 4)) {
    const excerpt = await readSafeExcerpt(root, document, true);
    if (excerpt !== undefined) evidence.push({
      id: evidenceId(createId), kind: "DOCUMENT", excerpt, route: representativeRoute,
    });
  }
  for (const directoryRelative of input.componentDirectories.slice(0, 4)) {
    const relative = safeRelativePath(directoryRelative, "Component evidence directory");
    const directory = join(root, relative);
    const directoryEntry = await lstat(directory);
    if (directoryEntry.isSymbolicLink() || !directoryEntry.isDirectory()) {
      throw new Error("Component evidence directory must not be a symbolic link");
    }
    const entries = (await readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && !entry.isSymbolicLink() && [".js", ".jsx", ".ts", ".tsx", ".css"].includes(extname(entry.name)))
      .sort((left, right) => left.name.localeCompare(right.name))
      .slice(0, 3);
    for (const entry of entries) {
      const excerpt = await readSafeExcerpt(root, posix.join(relative, entry.name));
      if (excerpt === undefined) continue;
      const lower = entry.name.toLowerCase();
      const kind = /nav|sidebar|header|rail/.test(lower)
        ? "NAVIGATION" as const
        : /token|theme|\.css$/.test(lower) ? "TOKEN" as const : "COMPONENT" as const;
      evidence.push({ id: evidenceId(createId), kind, excerpt, route: representativeRoute });
    }
  }

  const sessionsDirectory = join(root, ".design-sharingan", "sessions");
  if (await pathExists(sessionsDirectory)) {
    const sessionRecords = (await listSessions(root, input.projectId))
      .filter(({ type }) => type === "MANGEKYO_LOOP")
      .slice(0, 3);
    for (const record of sessionRecords) {
      const session = await loadMangekyoLoopSession(root, input.projectId, record.id);
      for (const artifact of renderArtifacts(session).slice(-4)) {
        if (!routes.includes(artifact.route)) continue;
        evidence.push({
          id: evidenceId(createId),
          kind: "RENDER",
          excerpt: `Authenticated current render ${scrub(artifact.id)} captured for this route.`,
          route: artifact.route,
          authenticatedRenderId: artifact.id,
        });
      }
    }
  }
  if (evidence.length > MAX_EVIDENCE) throw new Error("Governance evidence exceeds the bounded catalog");
  if (new Set(evidence.map(({ id }) => id)).size !== evidence.length) {
    throw new Error("Governance evidence identities must be unique");
  }
  return evidence;
}
