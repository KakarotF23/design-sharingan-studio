import {
  lstat,
  link,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  unlink,
} from "node:fs/promises";
import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, extname, join, posix } from "node:path";
import type {
  Approval,
  DesignApproach,
  DesignDNA,
  DesignSession,
  FeatureBrief,
  LearnSessionStatus,
  Project,
  Reference,
  RenderArtifact,
  UXImpact,
} from "@design-sharingan/core";
import { canTransitionLearnSession } from "@design-sharingan/core";
import { assertPathInsideWorkspace } from "./path-policy";

const MACHINE_DIRECTORY = ".design-sharingan";
const MAX_REFERENCE_BYTES = 10 * 1024 * 1024;
const MAX_RECORD_BYTES = 1024 * 1024;
const MAX_RENDER_BYTES = 25 * 1024 * 1024;

export interface DesignWorkspace {
  rootPath: string;
  machinePath: string;
  projectMetadataPath: string;
  referencesPath: string;
  sessionsPath: string;
  rendersPath: string;
  cachePath: string;
}

export interface SavedArtifact {
  artifactPath: string;
  metadataPath: string;
}

export interface WorkspaceOwnership {
  rootPath: string;
  parentPath: string;
  dev: number;
  ino: number;
}

function expectedWorkspacePaths(rootPath: string): DesignWorkspace {
  const canonicalRoot = assertPathInsideWorkspace(rootPath, rootPath);
  const machinePath = join(canonicalRoot, MACHINE_DIRECTORY);

  return {
    rootPath: canonicalRoot,
    machinePath,
    projectMetadataPath: join(machinePath, "project.json"),
    referencesPath: join(machinePath, "references"),
    sessionsPath: join(machinePath, "sessions"),
    rendersPath: join(machinePath, "renders"),
    cachePath: join(machinePath, "cache"),
  };
}

function assertSafePathSegment(value: string, label: string): void {
  if (
    value.length === 0 ||
    value === "." ||
    value === ".." ||
    value.includes("/") ||
    value.includes("\\") ||
    value.includes("\0")
  ) {
    throw new Error(`${label} must be a safe path segment`);
  }
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJsonValue);
  }

  if (value !== null && typeof value === "object") {
    const maybeSerializable = value as { toJSON?: () => unknown };
    if (typeof maybeSerializable.toJSON === "function") {
      return sortJsonValue(maybeSerializable.toJSON());
    }

    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, nestedValue]) => [key, sortJsonValue(nestedValue)]),
    );
  }

  return value;
}

function stableJson(value: unknown): string {
  const serialized = JSON.stringify(sortJsonValue(value), null, 2);
  if (serialized === undefined) {
    throw new TypeError("Value cannot be serialized as JSON");
  }
  return `${serialized}\n`;
}

async function atomicWrite(
  allowedRoot: string,
  destinationPath: string,
  contents: string | Uint8Array,
): Promise<void> {
  const canonicalDestination = assertPathInsideWorkspace(
    allowedRoot,
    destinationPath,
  );
  const temporaryPath = assertPathInsideWorkspace(
    allowedRoot,
    join(
      dirname(canonicalDestination),
      `.${basename(canonicalDestination)}.tmp-${process.pid}-${randomUUID()}`,
    ),
  );
  let temporaryFile: Awaited<ReturnType<typeof open>> | undefined;

  try {
    temporaryFile = await open(temporaryPath, "wx", 0o600);
    await temporaryFile.writeFile(contents);
    await temporaryFile.sync();
    await temporaryFile.close();
    temporaryFile = undefined;
    await rename(temporaryPath, canonicalDestination);
  } catch (error) {
    if (temporaryFile !== undefined) {
      await temporaryFile.close().catch(() => undefined);
    }
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

async function atomicWriteJson(
  allowedRoot: string,
  destinationPath: string,
  value: unknown,
): Promise<void> {
  await atomicWrite(allowedRoot, destinationPath, stableJson(value));
}

async function atomicCreate(
  allowedRoot: string,
  destinationPath: string,
  contents: string | Uint8Array,
): Promise<{ dev: number; ino: number }> {
  const canonicalDestination = assertPathInsideWorkspace(
    allowedRoot,
    destinationPath,
  );
  const temporaryPath = assertPathInsideWorkspace(
    allowedRoot,
    join(
      dirname(canonicalDestination),
      `.${basename(canonicalDestination)}.tmp-${process.pid}-${randomUUID()}`,
    ),
  );
  let temporaryFile: Awaited<ReturnType<typeof open>> | undefined;
  let ownership: { dev: number; ino: number } | undefined;

  try {
    temporaryFile = await open(temporaryPath, "wx", 0o600);
    await temporaryFile.writeFile(contents);
    await temporaryFile.sync();
    const entry = await temporaryFile.stat();
    ownership = { dev: entry.dev, ino: entry.ino };
    await temporaryFile.close();
    temporaryFile = undefined;
    await link(temporaryPath, canonicalDestination);
    await unlink(temporaryPath).catch(() => undefined);
    return ownership;
  } catch (error) {
    if (temporaryFile !== undefined) {
      await temporaryFile.close().catch(() => undefined);
    }
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

async function unlinkCreatedFileIfOwned(
  path: string,
  ownership: { dev: number; ino: number },
): Promise<void> {
  let entry: Awaited<ReturnType<typeof lstat>>;
  try {
    entry = await lstat(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
  if (entry.dev !== ownership.dev || entry.ino !== ownership.ino) {
    throw new Error("Render artifact ownership changed during rollback; replacement was preserved");
  }
  await unlink(path);
}

function boundedSessionContents(session: DesignSession): string {
  const contents = stableJson(session);
  if (new TextEncoder().encode(contents).byteLength > MAX_RECORD_BYTES) {
    throw new Error("Session record is too large; maximum size is 1 MiB");
  }
  return contents;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function validateFixedDirectory(
  containingRoot: string,
  directoryPath: string,
  label: string,
): Promise<string> {
  if (await pathExists(directoryPath)) {
    const entry = await lstat(directoryPath);
    if (entry.isSymbolicLink()) {
      throw new Error(`${label} must not be a symbolic link`);
    }
    if (!entry.isDirectory()) {
      throw new Error(`${label} must be a real directory`);
    }
  } else {
    await mkdir(directoryPath);
  }

  const createdEntry = await lstat(directoryPath);
  if (createdEntry.isSymbolicLink()) {
    throw new Error(`${label} must not be a symbolic link`);
  }
  if (!createdEntry.isDirectory()) {
    throw new Error(`${label} must be a real directory`);
  }

  return assertPathInsideWorkspace(containingRoot, directoryPath);
}

async function validateProjectMetadataFile(
  workspace: DesignWorkspace,
): Promise<string> {
  const metadataPath = workspace.projectMetadataPath;
  if (await pathExists(metadataPath)) {
    const entry = await lstat(metadataPath);
    if (entry.isSymbolicLink()) {
      throw new Error("Workspace project metadata must not be a symbolic link");
    }
    if (!entry.isFile()) {
      throw new Error("Workspace project metadata must be a regular file");
    }
  } else {
    await atomicWriteJson(workspace.machinePath, metadataPath, {});
  }

  const createdEntry = await lstat(metadataPath);
  if (createdEntry.isSymbolicLink()) {
    throw new Error("Workspace project metadata must not be a symbolic link");
  }
  if (!createdEntry.isFile()) {
    throw new Error("Workspace project metadata must be a regular file");
  }

  return assertPathInsideWorkspace(workspace.machinePath, metadataPath);
}

export async function ensureDesignWorkspace(
  rootPath: string,
): Promise<DesignWorkspace> {
  const expected = expectedWorkspacePaths(rootPath);
  const machinePath = await validateFixedDirectory(
    expected.rootPath,
    expected.machinePath,
    "Machine workspace directory",
  );
  const referencesPath = await validateFixedDirectory(
    machinePath,
    join(machinePath, "references"),
    "References directory",
  );
  const sessionsPath = await validateFixedDirectory(
    machinePath,
    join(machinePath, "sessions"),
    "Sessions directory",
  );
  const rendersPath = await validateFixedDirectory(
    machinePath,
    join(machinePath, "renders"),
    "Renders directory",
  );
  const cachePath = await validateFixedDirectory(
    machinePath,
    join(machinePath, "cache"),
    "Cache directory",
  );
  const workspace: DesignWorkspace = {
    rootPath: expected.rootPath,
    machinePath,
    projectMetadataPath: join(machinePath, "project.json"),
    referencesPath,
    sessionsPath,
    rendersPath,
    cachePath,
  };
  workspace.projectMetadataPath = await validateProjectMetadataFile(workspace);

  return workspace;
}

export async function saveProjectMetadata(project: Project): Promise<string> {
  const workspace = await ensureDesignWorkspace(project.rootPath);
  await atomicWriteJson(
    workspace.machinePath,
    workspace.projectMetadataPath,
    project,
  );
  return workspace.projectMetadataPath;
}

function invalidWorkspaceOwnership(): Error {
  return new Error(
    "Owned workspace identity changed; refusing guarded persistence",
  );
}

async function assertOpenWorkspaceOwnership(
  rootHandle: Awaited<ReturnType<typeof open>>,
  ownership: WorkspaceOwnership,
): Promise<void> {
  let pathEntry: Awaited<ReturnType<typeof lstat>>;
  let handleEntry: Awaited<ReturnType<typeof rootHandle.stat>>;
  try {
    [pathEntry, handleEntry] = await Promise.all([
      lstat(ownership.rootPath),
      rootHandle.stat(),
    ]);
  } catch {
    throw invalidWorkspaceOwnership();
  }

  if (
    pathEntry.isSymbolicLink() ||
    !pathEntry.isDirectory() ||
    !handleEntry.isDirectory() ||
    pathEntry.dev !== ownership.dev ||
    pathEntry.ino !== ownership.ino ||
    handleEntry.dev !== ownership.dev ||
    handleEntry.ino !== ownership.ino
  ) {
    throw invalidWorkspaceOwnership();
  }
}

async function openOwnedWorkspaceRoot(
  project: Project,
  ownership: WorkspaceOwnership,
): Promise<Awaited<ReturnType<typeof open>>> {
  if (
    project.rootPath !== ownership.rootPath ||
    dirname(ownership.rootPath) !== ownership.parentPath ||
    assertPathInsideWorkspace(ownership.parentPath, ownership.rootPath) !==
      ownership.rootPath
  ) {
    throw invalidWorkspaceOwnership();
  }

  let rootHandle: Awaited<ReturnType<typeof open>>;
  try {
    rootHandle = await open(
      ownership.rootPath,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
  } catch {
    throw invalidWorkspaceOwnership();
  }

  try {
    const canonicalParent = await realpath(ownership.parentPath);
    const canonicalRoot = await realpath(ownership.rootPath);
    if (
      canonicalParent !== ownership.parentPath ||
      canonicalRoot !== ownership.rootPath
    ) {
      throw invalidWorkspaceOwnership();
    }
    await assertOpenWorkspaceOwnership(rootHandle, ownership);
    return rootHandle;
  } catch (error) {
    await rootHandle.close().catch(() => undefined);
    throw error;
  }
}

/**
 * Persist project metadata only while the canonical workspace path still
 * resolves to the exact directory inode captured by its adapter.
 */
export async function saveGuardedProjectMetadata(
  project: Project,
  ownership: WorkspaceOwnership,
): Promise<string> {
  const rootHandle = await openOwnedWorkspaceRoot(project, ownership);
  try {
    // No caller-provided JavaScript executes between the guarded open and the
    // fixed runtime hierarchy mutation below.
    const workspace = await ensureDesignWorkspace(project.rootPath);
    await assertOpenWorkspaceOwnership(rootHandle, ownership);
    await atomicWriteJson(
      workspace.machinePath,
      workspace.projectMetadataPath,
      project,
    );
    await assertOpenWorkspaceOwnership(rootHandle, ownership);
    return workspace.projectMetadataPath;
  } finally {
    await rootHandle.close().catch(() => undefined);
  }
}

function invalidProjectIdentity(cause?: unknown): Error {
  const error = new Error(
    "Cannot validate active project identity; refusing artifact persistence",
  );
  if (cause !== undefined) {
    error.cause = cause;
  }
  return error;
}

function isPersistedProject(value: unknown): value is Project {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const project = value as Partial<Project>;
  const optionalStrings = [
    project.repositoryUrl,
    project.branch,
    project.framework,
    project.packageManager,
    project.devCommand,
  ];
  return (
    typeof project.id === "string" &&
    project.id.length > 0 &&
    typeof project.name === "string" &&
    project.name.length > 0 &&
    (project.sourceType === "LOCAL" || project.sourceType === "GITHUB") &&
    typeof project.rootPath === "string" &&
    (project.status === "UNINITIALIZED" ||
      project.status === "SCANNING" ||
      project.status === "NEEDS_CONFIGURATION" ||
      project.status === "READY") &&
    typeof project.createdAt === "string" &&
    typeof project.updatedAt === "string" &&
    optionalStrings.every(
      (field) => field === undefined || typeof field === "string",
    )
  );
}

/**
 * Reads an existing project identity without creating or repairing runtime
 * state. A locator is accepted only when the canonical root, fixed metadata
 * inode, persisted root, and requested project id all agree.
 */
export async function loadProjectMetadata(
  rootPath: string,
  expectedProjectId: string,
): Promise<Project> {
  let metadataHandle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    assertSafePathSegment(expectedProjectId, "Project id");
    const canonicalRoot = await realpath(rootPath);
    if (canonicalRoot !== rootPath) throw invalidProjectIdentity();

    const rootEntry = await lstat(rootPath);
    if (rootEntry.isSymbolicLink() || !rootEntry.isDirectory()) {
      throw invalidProjectIdentity();
    }

    const workspace = expectedWorkspacePaths(canonicalRoot);
    const machineEntry = await lstat(workspace.machinePath);
    if (machineEntry.isSymbolicLink() || !machineEntry.isDirectory()) {
      throw invalidProjectIdentity();
    }
    if (
      (await realpath(/* turbopackIgnore: true */ workspace.machinePath)) !==
      workspace.machinePath
    ) {
      throw invalidProjectIdentity();
    }

    const pathEntry = await lstat(workspace.projectMetadataPath);
    if (pathEntry.isSymbolicLink() || !pathEntry.isFile()) {
      throw invalidProjectIdentity();
    }
    metadataHandle = await open(
      /* turbopackIgnore: true */ workspace.projectMetadataPath,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    const handleEntry = await metadataHandle.stat();
    if (
      !handleEntry.isFile() ||
      handleEntry.dev !== pathEntry.dev ||
      handleEntry.ino !== pathEntry.ino
    ) {
      throw invalidProjectIdentity();
    }

    const persisted: unknown = JSON.parse(
      await metadataHandle.readFile({ encoding: "utf8" }),
    );
    if (
      !isPersistedProject(persisted) ||
      persisted.id !== expectedProjectId ||
      persisted.rootPath !== canonicalRoot
    ) {
      throw invalidProjectIdentity();
    }
    return persisted;
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.startsWith("Cannot validate active project identity")
    ) {
      throw error;
    }
    throw invalidProjectIdentity(error);
  } finally {
    await metadataHandle?.close().catch(() => undefined);
  }
}

async function loadValidatedProjectContext(
  rootPath: string,
  expectedProjectId: string,
): Promise<DesignWorkspace> {
  const workspace = await ensureDesignWorkspace(rootPath);

  try {
    const persisted = JSON.parse(
      await readFile(workspace.projectMetadataPath, "utf8"),
    ) as unknown;
    if (
      persisted === null ||
      typeof persisted !== "object" ||
      !("id" in persisted) ||
      typeof persisted.id !== "string" ||
      persisted.id !== expectedProjectId ||
      !("rootPath" in persisted) ||
      typeof persisted.rootPath !== "string"
    ) {
      throw invalidProjectIdentity();
    }

    const persistedRoot = assertPathInsideWorkspace(
      workspace.rootPath,
      persisted.rootPath,
    );
    if (persistedRoot !== workspace.rootPath) {
      throw invalidProjectIdentity();
    }
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.startsWith("Cannot validate active project identity")
    ) {
      throw error;
    }
    throw invalidProjectIdentity(error);
  }

  return workspace;
}

export function validateReferenceImage(
  declaredMime: string,
  bytes: Uint8Array,
): ".png" | ".jpg" | ".webp" | ".gif" {
  if (bytes.byteLength === 0) {
    throw new Error("Reference image must not be empty");
  }
  if (bytes.byteLength > MAX_REFERENCE_BYTES) {
    throw new Error("Reference image must be no larger than 10 MiB");
  }

  let extension: ".png" | ".jpg" | ".webp" | ".gif";
  let signatureMatches: boolean;
  switch (declaredMime) {
    case "image/png":
      extension = ".png";
      signatureMatches =
        bytes.byteLength >= 8 &&
        [137, 80, 78, 71, 13, 10, 26, 10].every(
          (value, index) => bytes[index] === value,
        );
      break;
    case "image/jpeg":
      extension = ".jpg";
      signatureMatches =
        bytes.byteLength >= 3 &&
        bytes[0] === 0xff &&
        bytes[1] === 0xd8 &&
        bytes[2] === 0xff;
      break;
    case "image/webp":
      extension = ".webp";
      signatureMatches =
        bytes.byteLength >= 12 &&
        new TextDecoder("ascii").decode(bytes.subarray(0, 4)) === "RIFF" &&
        new TextDecoder("ascii").decode(bytes.subarray(8, 12)) === "WEBP";
      break;
    case "image/gif":
      extension = ".gif";
      signatureMatches =
        bytes.byteLength >= 6 &&
        ["GIF87a", "GIF89a"].includes(
          new TextDecoder("ascii").decode(bytes.subarray(0, 6)),
        );
      break;
    default:
      throw new Error("Reference image must be PNG, JPEG, WebP, or GIF");
  }

  if (!signatureMatches) {
    throw new Error("Reference image signature does not match its declared MIME");
  }
  return extension;
}

export async function saveReferenceArtifact(
  rootPath: string,
  reference: Reference,
  bytes: Uint8Array,
): Promise<SavedArtifact> {
  assertSafePathSegment(reference.id, "Reference id");
  const workspace = await loadValidatedProjectContext(
    rootPath,
    reference.projectId,
  );
  const artifactExtension = validateReferenceImage(reference.type, bytes);
  const referencePath = assertPathInsideWorkspace(
    workspace.referencesPath,
    join(workspace.referencesPath, reference.id),
  );
  await validateFixedDirectory(
    workspace.referencesPath,
    referencePath,
    "Reference directory",
  );

  const artifactPath = assertPathInsideWorkspace(
    referencePath,
    join(referencePath, `artifact${artifactExtension}`),
  );
  const metadataPath = assertPathInsideWorkspace(
    referencePath,
    join(referencePath, "reference.json"),
  );

  await atomicWrite(referencePath, artifactPath, bytes);
  await atomicWriteJson(referencePath, metadataPath, {
    ...reference,
    imagePath: artifactPath,
  });

  return { artifactPath, metadataPath };
}

async function readBoundedJsonFile(path: string, label: string): Promise<unknown> {
  const pathEntry = await lstat(path);
  if (
    pathEntry.isSymbolicLink() ||
    !pathEntry.isFile() ||
    pathEntry.size > MAX_RECORD_BYTES
  ) {
    throw new Error(`${label} is invalid`);
  }
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const handleEntry = await handle.stat();
    if (
      !handleEntry.isFile() ||
      handleEntry.dev !== pathEntry.dev ||
      handleEntry.ino !== pathEntry.ino ||
      handleEntry.size > MAX_RECORD_BYTES
    ) {
      throw new Error(`${label} changed while reading`);
    }
    return JSON.parse(await handle.readFile({ encoding: "utf8" })) as unknown;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isPersistedReference(value: unknown): value is Reference {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const reference = value as Partial<Reference>;
  return (
    typeof reference.id === "string" &&
    typeof reference.projectId === "string" &&
    typeof reference.title === "string" &&
    typeof reference.type === "string" &&
    typeof reference.source === "string" &&
    (reference.imagePath === undefined || typeof reference.imagePath === "string") &&
    (reference.notes === undefined || typeof reference.notes === "string") &&
    isStringArray(reference.likes) &&
    isStringArray(reference.dislikes) &&
    isStringArray(reference.tags) &&
    ["UPLOADED", "PROCESSING", "READY", "ANALYZED", "ASSIMILATED"].includes(
      reference.analysisStatus ?? "",
    ) &&
    (reference.compatibility === undefined ||
      typeof reference.compatibility === "string") &&
    typeof reference.createdAt === "string"
  );
}

function isPersistedSession(value: unknown): value is DesignSession {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const session = value as Partial<DesignSession>;
  return (
    typeof session.id === "string" &&
    typeof session.projectId === "string" &&
    typeof session.type === "string" &&
    typeof session.status === "string" &&
    typeof session.createdAt === "string" &&
    typeof session.updatedAt === "string"
  );
}

function isPersistedDesignDNA(value: unknown): value is DesignDNA {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const designDNA = value as Partial<DesignDNA>;
  return (
    typeof designDNA.id === "string" &&
    [
      designDNA.referenceIds,
      designDNA.hierarchy,
      designDNA.layout,
      designDNA.spacing,
      designDNA.typography,
      designDNA.colorLogic,
      designDNA.componentGeometry,
      designDNA.navigation,
      designDNA.interaction,
      designDNA.motion,
      designDNA.density,
      designDNA.emotionalTone,
      designDNA.visualWeight,
      designDNA.keep,
      designDNA.reject,
      designDNA.adapt,
      designDNA.invent,
    ].every(isStringArray)
  );
}

function isObjectWithOnlyKeys(
  value: unknown,
  allowedKeys: readonly string[],
): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).every((key) => allowedKeys.includes(key))
  );
}

function hasNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isFeatureBrief(value: unknown): value is FeatureBrief {
  if (
    !isObjectWithOnlyKeys(value, [
      "name",
      "goal",
      "description",
      "constraints",
      "mustKeep",
      "mustNotChange",
      "successCriteria",
    ])
  ) {
    return false;
  }
  return (
    hasNonEmptyString(value.name) &&
    hasNonEmptyString(value.goal) &&
    hasNonEmptyString(value.description) &&
    isStringArray(value.constraints) &&
    isStringArray(value.mustKeep) &&
    isStringArray(value.mustNotChange) &&
    isStringArray(value.successCriteria)
  );
}

function isUXImpact(value: unknown): value is UXImpact {
  if (
    !isObjectWithOnlyKeys(value, [
      "area",
      "severity",
      "reason",
      "affectedRoutes",
      "affectedComponents",
      "decisionRequired",
    ])
  ) {
    return false;
  }
  return (
    hasNonEmptyString(value.area) &&
    ["CRITICAL", "IMPORTANT", "POLISH", "IGNORE"].includes(
      value.severity as string,
    ) &&
    hasNonEmptyString(value.reason) &&
    isStringArray(value.affectedRoutes) &&
    isStringArray(value.affectedComponents) &&
    typeof value.decisionRequired === "boolean"
  );
}

function isDesignApproach(value: unknown): value is DesignApproach {
  if (
    !isObjectWithOnlyKeys(value, [
      "id",
      "title",
      "summary",
      "recommended",
      "pros",
      "cons",
      "uxImpact",
      "estimatedComplexity",
      "genomeFit",
      "likelyFiles",
      "status",
    ])
  ) {
    return false;
  }
  return (
    hasNonEmptyString(value.id) &&
    /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value.id) &&
    hasNonEmptyString(value.title) &&
    hasNonEmptyString(value.summary) &&
    typeof value.recommended === "boolean" &&
    isStringArray(value.pros) &&
    value.pros.length > 0 &&
    isStringArray(value.cons) &&
    value.cons.length > 0 &&
    Array.isArray(value.uxImpact) &&
    value.uxImpact.length > 0 &&
    value.uxImpact.every(isUXImpact) &&
    hasNonEmptyString(value.estimatedComplexity) &&
    hasNonEmptyString(value.genomeFit) &&
    isStringArray(value.likelyFiles) &&
    value.likelyFiles.length > 0 &&
    value.status === "PROPOSED"
  );
}

function isApproval(value: unknown): value is Approval {
  if (
    !isObjectWithOnlyKeys(value, [
      "id",
      "proposalId",
      "decision",
      "scope",
      "approvedBy",
      "comment",
      "createdAt",
    ])
  ) {
    return false;
  }
  return (
    hasNonEmptyString(value.id) &&
    hasNonEmptyString(value.proposalId) &&
    ["APPROVED", "REJECTED", "REVISION_REQUESTED"].includes(
      value.decision as string,
    ) &&
    hasNonEmptyString(value.scope) &&
    hasNonEmptyString(value.approvedBy) &&
    (value.comment === undefined || typeof value.comment === "string") &&
    hasNonEmptyString(value.createdAt)
  );
}

function isApproachSet(value: unknown): value is DesignApproach[] {
  return (
    Array.isArray(value) &&
    value.length >= 2 &&
    value.length <= 3 &&
    value.every(isDesignApproach) &&
    value.filter((approach) => approach.recommended).length === 1 &&
    new Set(value.map((approach) => approach.id)).size === value.length
  );
}

export async function loadReference(
  rootPath: string,
  projectId: string,
  referenceId: string,
): Promise<Reference> {
  assertSafePathSegment(referenceId, "Reference id");
  const workspace = await loadValidatedProjectContext(rootPath, projectId);
  const referencePath = assertPathInsideWorkspace(
    workspace.referencesPath,
    join(workspace.referencesPath, referenceId),
  );
  const directoryEntry = await lstat(referencePath);
  if (directoryEntry.isSymbolicLink() || !directoryEntry.isDirectory()) {
    throw new Error("Reference directory is invalid");
  }
  const metadataPath = assertPathInsideWorkspace(
    referencePath,
    join(referencePath, "reference.json"),
  );
  const persisted = await readBoundedJsonFile(metadataPath, "Reference record");
  if (
    !isPersistedReference(persisted) ||
    persisted.projectId !== projectId ||
    persisted.id !== referenceId ||
    persisted.imagePath === undefined ||
    assertPathInsideWorkspace(referencePath, persisted.imagePath) !==
      persisted.imagePath
  ) {
    throw new Error("Reference record is invalid");
  }
  return persisted;
}

export async function loadReferenceImage(
  rootPath: string,
  projectId: string,
  referenceId: string,
): Promise<{ bytes: Uint8Array; type: Reference["type"] }> {
  const reference = await loadReference(rootPath, projectId, referenceId);
  const imagePath = reference.imagePath as string;
  const pathEntry = await lstat(imagePath);
  if (
    pathEntry.isSymbolicLink() ||
    !pathEntry.isFile() ||
    pathEntry.size === 0 ||
    pathEntry.size > MAX_REFERENCE_BYTES
  ) {
    throw new Error("Reference image artifact is invalid");
  }
  const handle = await open(
    imagePath,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const handleEntry = await handle.stat();
    if (
      !handleEntry.isFile() ||
      handleEntry.dev !== pathEntry.dev ||
      handleEntry.ino !== pathEntry.ino ||
      handleEntry.size !== pathEntry.size
    ) {
      throw new Error("Reference image artifact changed while reading");
    }
    const bytes = new Uint8Array(await handle.readFile());
    validateReferenceImage(reference.type, bytes);
    return { bytes, type: reference.type };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

export async function listReferences(
  rootPath: string,
  projectId: string,
): Promise<Reference[]> {
  const workspace = await loadValidatedProjectContext(rootPath, projectId);
  const entries = await readdir(workspace.referencesPath, {
    withFileTypes: true,
  });
  const references = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
      .map((entry) => loadReference(rootPath, projectId, entry.name)),
  );
  return references.sort((left, right) =>
    right.createdAt.localeCompare(left.createdAt),
  );
}

export async function updateReference(
  rootPath: string,
  reference: Reference,
): Promise<string> {
  const existing = await loadReference(rootPath, reference.projectId, reference.id);
  if (
    reference.imagePath !== existing.imagePath ||
    reference.type !== existing.type ||
    reference.source !== existing.source ||
    reference.createdAt !== existing.createdAt
  ) {
    throw new Error("Reference artifact identity cannot be changed");
  }
  const referencePath = dirname(existing.imagePath as string);
  const metadataPath = assertPathInsideWorkspace(
    referencePath,
    join(referencePath, "reference.json"),
  );
  await atomicWriteJson(referencePath, metadataPath, reference);
  return metadataPath;
}

export async function saveReferenceDesignDNA(
  rootPath: string,
  projectId: string,
  referenceId: string,
  designDNA: DesignDNA,
): Promise<string> {
  const reference = await loadReference(rootPath, projectId, referenceId);
  if (!designDNA.referenceIds.includes(reference.id)) {
    throw new Error("DesignDNA does not include the active reference");
  }
  const referencePath = dirname(reference.imagePath as string);
  const designDNAPath = assertPathInsideWorkspace(
    referencePath,
    join(referencePath, "design-dna.json"),
  );
  await atomicWriteJson(referencePath, designDNAPath, designDNA);
  return designDNAPath;
}

export async function loadReferenceDesignDNA(
  rootPath: string,
  projectId: string,
  referenceId: string,
): Promise<DesignDNA> {
  const reference = await loadReference(rootPath, projectId, referenceId);
  const referencePath = dirname(reference.imagePath as string);
  const designDNAPath = assertPathInsideWorkspace(
    referencePath,
    join(referencePath, "design-dna.json"),
  );
  const persisted = await readBoundedJsonFile(designDNAPath, "DesignDNA record");
  if (
    !isPersistedDesignDNA(persisted) ||
    !persisted.referenceIds.includes(referenceId)
  ) {
    throw new Error("DesignDNA record is invalid");
  }
  return persisted;
}

export async function saveSession(
  rootPath: string,
  session: DesignSession,
): Promise<string> {
  assertSafePathSegment(session.id, "Session id");
  const workspace = await loadValidatedProjectContext(
    rootPath,
    session.projectId,
  );
  const sessionPath = assertPathInsideWorkspace(
    workspace.sessionsPath,
    join(workspace.sessionsPath, `${session.id}.json`),
  );
  const contents = boundedSessionContents(session);
  await atomicWrite(workspace.sessionsPath, sessionPath, contents);
  return sessionPath;
}

export async function loadSession(
  rootPath: string,
  projectId: string,
  sessionId: string,
): Promise<DesignSession> {
  assertSafePathSegment(sessionId, "Session id");
  const workspace = await loadValidatedProjectContext(rootPath, projectId);
  const sessionPath = assertPathInsideWorkspace(
    workspace.sessionsPath,
    join(workspace.sessionsPath, `${sessionId}.json`),
  );
  const persisted = await readBoundedJsonFile(sessionPath, "Session record");
  if (
    !isPersistedSession(persisted) ||
    persisted.projectId !== projectId ||
    persisted.id !== sessionId
  ) {
    throw new Error("Session record is invalid");
  }
  return persisted;
}

export async function transitionLearnSession(
  rootPath: string,
  expectedStatus: LearnSessionStatus,
  session: DesignSession & { status: LearnSessionStatus },
): Promise<string> {
  const existing = await loadSession(rootPath, session.projectId, session.id);
  if (
    existing.type !== session.type ||
    existing.status !== expectedStatus ||
    existing.createdAt !== session.createdAt ||
    !canTransitionLearnSession(expectedStatus, session.status)
  ) {
    throw new Error(
      `Learn session identity or transition from ${existing.status} to ${session.status} is invalid`,
    );
  }
  return saveSession(rootPath, session);
}

interface FeatureEvolveSessionBase extends DesignSession {
  type: "FEATURE_EVOLVE";
  featureBrief: FeatureBrief;
  referenceIds: string[];
}

export interface FeatureEvolvePendingSession
  extends FeatureEvolveSessionBase {
  status: "DRAFT" | "ANALYZING";
  error?: string;
}

export interface FeatureEvolveResultSession extends FeatureEvolveSessionBase {
  status: "RESULT_READY" | "AWAITING_DECISION";
  uxImpact: UXImpact[];
  approaches: DesignApproach[];
  agentThreadId: string;
}

export interface FeatureEvolveApprovedSession
  extends FeatureEvolveSessionBase {
  status: "APPROVED";
  uxImpact: UXImpact[];
  approaches: DesignApproach[];
  agentThreadId: string;
  approvedApproachId: string;
  approval: Approval;
  executeSessionId: string;
}

export interface SafeExecutionDraftSession extends DesignSession {
  type: "SAFE_EXECUTION";
  status: "IDLE";
  sourceSessionId: string;
  approvedApproachId: string;
  approvalId: string;
  featureBrief: FeatureBrief;
  designApproach: DesignApproach;
}

export function isFeatureEvolvePendingSession(
  value: unknown,
): value is FeatureEvolvePendingSession {
  if (!isPersistedSession(value)) return false;
  const session = value as Partial<FeatureEvolvePendingSession>;
  return (
    isObjectWithOnlyKeys(value, [
      "id",
      "projectId",
      "type",
      "status",
      "createdAt",
      "updatedAt",
      "featureBrief",
      "referenceIds",
      "error",
    ]) &&
    session.type === "FEATURE_EVOLVE" &&
    (session.status === "DRAFT" || session.status === "ANALYZING") &&
    isFeatureBrief(session.featureBrief) &&
    isStringArray(session.referenceIds) &&
    new Set(session.referenceIds).size === session.referenceIds.length &&
    (session.error === undefined || typeof session.error === "string")
  );
}

export function isFeatureEvolveResultSession(
  value: unknown,
): value is FeatureEvolveResultSession {
  if (!isPersistedSession(value)) return false;
  const session = value as Partial<FeatureEvolveResultSession>;
  return (
    isObjectWithOnlyKeys(value, [
      "id",
      "projectId",
      "type",
      "status",
      "createdAt",
      "updatedAt",
      "featureBrief",
      "referenceIds",
      "uxImpact",
      "approaches",
      "agentThreadId",
    ]) &&
    session.type === "FEATURE_EVOLVE" &&
    (session.status === "RESULT_READY" ||
      session.status === "AWAITING_DECISION") &&
    isFeatureBrief(session.featureBrief) &&
    isStringArray(session.referenceIds) &&
    new Set(session.referenceIds).size === session.referenceIds.length &&
    Array.isArray(session.uxImpact) &&
    session.uxImpact.length > 0 &&
    session.uxImpact.every(isUXImpact) &&
    isApproachSet(session.approaches) &&
    hasNonEmptyString(session.agentThreadId)
  );
}

export function isFeatureEvolveApprovedSession(
  value: unknown,
): value is FeatureEvolveApprovedSession {
  if (!isPersistedSession(value)) return false;
  const session = value as Partial<FeatureEvolveApprovedSession>;
  return (
    isObjectWithOnlyKeys(value, [
      "id",
      "projectId",
      "type",
      "status",
      "createdAt",
      "updatedAt",
      "featureBrief",
      "referenceIds",
      "uxImpact",
      "approaches",
      "agentThreadId",
      "approvedApproachId",
      "approval",
      "executeSessionId",
    ]) &&
    session.type === "FEATURE_EVOLVE" &&
    session.status === "APPROVED" &&
    isFeatureBrief(session.featureBrief) &&
    isStringArray(session.referenceIds) &&
    new Set(session.referenceIds).size === session.referenceIds.length &&
    Array.isArray(session.uxImpact) &&
    session.uxImpact.length > 0 &&
    session.uxImpact.every(isUXImpact) &&
    isApproachSet(session.approaches) &&
    hasNonEmptyString(session.agentThreadId) &&
    hasNonEmptyString(session.approvedApproachId) &&
    isApproval(session.approval) &&
    hasNonEmptyString(session.executeSessionId)
  );
}

export function isSafeExecutionDraftSession(
  value: unknown,
): value is SafeExecutionDraftSession {
  if (!isPersistedSession(value)) return false;
  const session = value as Partial<SafeExecutionDraftSession>;
  return (
    isObjectWithOnlyKeys(value, [
      "id",
      "projectId",
      "type",
      "status",
      "createdAt",
      "updatedAt",
      "sourceSessionId",
      "approvedApproachId",
      "approvalId",
      "featureBrief",
      "designApproach",
    ]) &&
    session.type === "SAFE_EXECUTION" &&
    session.status === "IDLE" &&
    hasNonEmptyString(session.sourceSessionId) &&
    hasNonEmptyString(session.approvedApproachId) &&
    hasNonEmptyString(session.approvalId) &&
    isFeatureBrief(session.featureBrief) &&
    isDesignApproach(session.designApproach)
  );
}

export async function commitFeatureEvolveResult(
  rootPath: string,
  session: FeatureEvolveResultSession,
): Promise<void> {
  if (
    !isFeatureEvolveResultSession(session) ||
    session.status !== "RESULT_READY"
  ) {
    throw new Error("Feature EVOLVE result evidence is incomplete");
  }
  const existing = await loadSession(rootPath, session.projectId, session.id);
  if (
    !isFeatureEvolvePendingSession(existing) ||
    existing.status !== "ANALYZING" ||
    existing.type !== session.type ||
    existing.createdAt !== session.createdAt ||
    stableJson(existing.featureBrief) !== stableJson(session.featureBrief) ||
    stableJson(existing.referenceIds) !== stableJson(session.referenceIds) ||
    !canTransitionLearnSession("ANALYZING", session.status)
  ) {
    throw new Error(
      "Feature EVOLVE result requires a matching ANALYZING session",
    );
  }
  await saveSession(rootPath, session);
}

export async function approveFeatureEvolveApproach(
  rootPath: string,
  checkpoint: {
    session: FeatureEvolveApprovedSession;
    approval: Approval;
    executeSession: SafeExecutionDraftSession;
  },
): Promise<void> {
  const { session, approval, executeSession } = checkpoint;
  if (
    !isFeatureEvolveApprovedSession(session) ||
    !isApproval(approval) ||
    !isSafeExecutionDraftSession(executeSession)
  ) {
    throw new Error("Feature EVOLVE approval checkpoint is incomplete");
  }
  if (
    session.updatedAt !== approval.createdAt ||
    executeSession.createdAt !== approval.createdAt ||
    executeSession.updatedAt !== approval.createdAt
  ) {
    throw new Error(
      "Feature EVOLVE approval checkpoint timestamps must match approval.createdAt",
    );
  }
  assertSafePathSegment(session.id, "Session id");
  assertSafePathSegment(executeSession.id, "Session id");
  const workspace = await loadValidatedProjectContext(rootPath, session.projectId);
  // Bound both halves before claiming or replacing any durable record. This
  // keeps rejection side-effect free and ensures every committed session can
  // pass the matching bounded read path.
  const approvalSessionContents = boundedSessionContents(session);
  const executeSessionContents = boundedSessionContents(executeSession);
  const approvalClaimPath = assertPathInsideWorkspace(
    workspace.sessionsPath,
    join(workspace.sessionsPath, `.${session.id}.approval.claim`),
  );
  let approvalClaim: Awaited<ReturnType<typeof open>> | undefined;

  try {
    approvalClaim = await open(approvalClaimPath, "wx", 0o600);
    await approvalClaim.writeFile(
      stableJson({ approvalId: approval.id, sessionId: session.id }),
    );
    await approvalClaim.sync();

    // Re-read after the exclusive claim. A request queued behind another
    // completed approval sees APPROVED here and fails closed.
    const existing = await loadSession(rootPath, session.projectId, session.id);
    if (!isFeatureEvolveResultSession(existing)) {
      throw new Error("Feature EVOLVE approval requires matching result evidence");
    }
    const selectedApproach = existing.approaches.find(
      (approach) => approach.id === session.approvedApproachId,
    );
    if (
      existing.status !== "AWAITING_DECISION" ||
      !canTransitionLearnSession("AWAITING_DECISION", session.status) ||
      existing.createdAt !== session.createdAt ||
      stableJson(existing.featureBrief) !== stableJson(session.featureBrief) ||
      stableJson(existing.referenceIds) !== stableJson(session.referenceIds) ||
      stableJson(existing.uxImpact) !== stableJson(session.uxImpact) ||
      stableJson(existing.approaches) !== stableJson(session.approaches) ||
      existing.agentThreadId !== session.agentThreadId ||
      selectedApproach === undefined ||
      approval.decision !== "APPROVED" ||
      approval.scope !== "DESIGN_APPROACH" ||
      approval.proposalId !== selectedApproach.id ||
      session.approvedApproachId !== selectedApproach.id ||
      stableJson(session.approval) !== stableJson(approval) ||
      session.executeSessionId !== executeSession.id ||
      executeSession.projectId !== session.projectId ||
      executeSession.sourceSessionId !== session.id ||
      executeSession.approvedApproachId !== selectedApproach.id ||
      executeSession.approvalId !== approval.id ||
      stableJson(executeSession.featureBrief) !== stableJson(session.featureBrief) ||
      stableJson(executeSession.designApproach) !== stableJson(selectedApproach)
    ) {
      throw new Error(
        "Feature EVOLVE approval, approach, and execution evidence must match",
      );
    }

    const approvalSessionPath = assertPathInsideWorkspace(
      workspace.sessionsPath,
      join(workspace.sessionsPath, `${session.id}.json`),
    );
    const executeSessionPath = assertPathInsideWorkspace(
      workspace.sessionsPath,
      join(workspace.sessionsPath, `${executeSession.id}.json`),
    );
    const originalSessionContents = stableJson(existing);

    try {
      // The approved Feature EVOLVE record embeds the first-class Approval and
      // is made durable before the linked execution draft becomes visible.
      await atomicWrite(
        workspace.sessionsPath,
        approvalSessionPath,
        approvalSessionContents,
      );
      await atomicCreate(
        workspace.sessionsPath,
        executeSessionPath,
        executeSessionContents,
      );
    } catch (error) {
      try {
        await atomicWrite(
          workspace.sessionsPath,
          approvalSessionPath,
          originalSessionContents,
        );
      } catch (rollbackError) {
        throw new Error("Feature EVOLVE approval and rollback both failed", {
          cause: { commitError: error, rollbackError },
        });
      }
      throw error;
    }
  } finally {
    if (approvalClaim !== undefined) {
      await approvalClaim.close().catch(() => undefined);
      await unlink(approvalClaimPath).catch(() => undefined);
    }
  }
}

export async function loadApprovedExecutionDirection(
  rootPath: string,
  projectId: string,
): Promise<SafeExecutionDraftSession> {
  const sessions = await listSessions(rootPath, projectId);
  const executionRecords = sessions.filter(
    (session) => session.type === "SAFE_EXECUTION",
  );
  if (executionRecords.length === 0) {
    throw new Error("Approved execution source evidence is missing");
  }
  if (executionRecords.length > 1) {
    throw new Error("Multiple SAFE_EXECUTION drafts are ambiguous");
  }
  const [executionRecord] = executionRecords;
  if (!isSafeExecutionDraftSession(executionRecord)) {
    throw new Error("SAFE_EXECUTION draft evidence is invalid");
  }

  let sourceRecord: DesignSession;
  try {
    sourceRecord = await loadSession(
      rootPath,
      projectId,
      executionRecord.sourceSessionId,
    );
  } catch {
    throw new Error("Approved execution source evidence is missing");
  }
  if (!isFeatureEvolveApprovedSession(sourceRecord)) {
    throw new Error("Approved Feature EVOLVE source evidence is invalid");
  }
  const approval = sourceRecord.approval;
  const selectedApproach = sourceRecord.approaches.find(
    (approach) => approach.id === sourceRecord.approvedApproachId,
  );
  if (
    selectedApproach === undefined ||
    sourceRecord.projectId !== projectId ||
    executionRecord.projectId !== projectId ||
    sourceRecord.id !== executionRecord.sourceSessionId ||
    sourceRecord.executeSessionId !== executionRecord.id ||
    sourceRecord.approvedApproachId !== executionRecord.approvedApproachId ||
    approval.id !== executionRecord.approvalId ||
    approval.decision !== "APPROVED" ||
    approval.scope !== "DESIGN_APPROACH" ||
    approval.proposalId !== sourceRecord.approvedApproachId ||
    executionRecord.createdAt !== approval.createdAt ||
    executionRecord.updatedAt !== approval.createdAt ||
    sourceRecord.updatedAt !== approval.createdAt ||
    stableJson(executionRecord.designApproach) !== stableJson(selectedApproach) ||
    stableJson(executionRecord.featureBrief) !== stableJson(sourceRecord.featureBrief)
  ) {
    throw new Error(
      "Approval, approach, Feature Brief, and Execute evidence do not match",
    );
  }
  return executionRecord;
}

export interface ReferenceScanPendingSession extends DesignSession {
  type: "REFERENCE_SCAN";
  status: "DRAFT" | "ANALYZING";
  referenceId: string;
  referenceTitle: string;
  error?: string;
}

export function isReferenceScanPendingSession(
  value: unknown,
): value is ReferenceScanPendingSession {
  if (!isPersistedSession(value)) return false;
  const session = value as Partial<ReferenceScanPendingSession>;
  return (
    session.type === "REFERENCE_SCAN" &&
    (session.status === "DRAFT" || session.status === "ANALYZING") &&
    typeof session.referenceId === "string" &&
    session.referenceId.length > 0 &&
    typeof session.referenceTitle === "string" &&
    session.referenceTitle.length > 0 &&
    (session.error === undefined || typeof session.error === "string")
  );
}

export interface ReferenceScanResultSession extends DesignSession {
  type: "REFERENCE_SCAN";
  status: "RESULT_READY";
  referenceId: string;
  referenceTitle: string;
  designDNA: DesignDNA;
  agentThreadId: string;
}

export function isReferenceScanResultSession(
  value: unknown,
): value is ReferenceScanResultSession {
  if (!isPersistedSession(value)) return false;
  const session = value as Partial<ReferenceScanResultSession>;
  return (
    session.type === "REFERENCE_SCAN" &&
    session.status === "RESULT_READY" &&
    typeof session.referenceId === "string" &&
    session.referenceId.length > 0 &&
    typeof session.referenceTitle === "string" &&
    session.referenceTitle.length > 0 &&
    isPersistedDesignDNA(session.designDNA) &&
    typeof session.agentThreadId === "string" &&
    session.agentThreadId.trim().length > 0
  );
}

export interface ReferenceScanCheckpoint {
  reference: Reference;
  designDNA: DesignDNA;
  session: ReferenceScanResultSession;
}

async function readOptionalJsonContents(path: string): Promise<string | undefined> {
  try {
    return stableJson(await readBoundedJsonFile(path, "DesignDNA record"));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

export async function commitReferenceScan(
  rootPath: string,
  checkpoint: ReferenceScanCheckpoint,
): Promise<void> {
  const { reference, designDNA, session } = checkpoint;
  if (
    !isPersistedReference(reference) ||
    !isPersistedDesignDNA(designDNA) ||
    !isReferenceScanResultSession(session)
  ) {
    throw new Error("Reference scan checkpoint evidence is incomplete");
  }
  const finalDesignDNAContents = stableJson(designDNA);
  if (
    stableJson(session.designDNA) !== finalDesignDNAContents ||
    designDNA.referenceIds.length !== 1 ||
    designDNA.referenceIds[0] !== reference.id
  ) {
    throw new Error("Reference scan checkpoint evidence does not match");
  }
  const [existingReference, existingSession] = await Promise.all([
    loadReference(rootPath, reference.projectId, reference.id),
    loadSession(rootPath, session.projectId, session.id),
  ]);
  if (
    !isReferenceScanPendingSession(existingSession) ||
    existingSession.status !== "ANALYZING" ||
    existingSession.id !== session.id ||
    existingSession.projectId !== session.projectId ||
    existingSession.referenceId !== session.referenceId ||
    existingSession.referenceTitle !== session.referenceTitle ||
    existingReference.projectId !== session.projectId ||
    session.referenceId !== reference.id ||
    session.referenceTitle !== reference.title ||
    existingSession.createdAt !== session.createdAt ||
    !canTransitionLearnSession("ANALYZING", session.status) ||
    reference.analysisStatus !== "ANALYZED" ||
    reference.imagePath !== existingReference.imagePath ||
    reference.type !== existingReference.type ||
    reference.source !== existingReference.source ||
    reference.createdAt !== existingReference.createdAt
  ) {
    throw new Error(
      "Reference scan checkpoint requires an ANALYZING session and matching artifacts",
    );
  }

  const workspace = await loadValidatedProjectContext(
    rootPath,
    reference.projectId,
  );
  const referencePath = dirname(existingReference.imagePath as string);
  const referenceMetadataPath = assertPathInsideWorkspace(
    referencePath,
    join(referencePath, "reference.json"),
  );
  const designDNAPath = assertPathInsideWorkspace(
    referencePath,
    join(referencePath, "design-dna.json"),
  );
  const sessionPath = assertPathInsideWorkspace(
    workspace.sessionsPath,
    join(workspace.sessionsPath, `${session.id}.json`),
  );
  const originalReferenceContents = stableJson(existingReference);
  const originalDesignDNAContents = await readOptionalJsonContents(designDNAPath);
  const finalReferenceContents = stableJson(reference);
  const finalSessionContents = stableJson(session);

  try {
    await atomicWrite(referencePath, designDNAPath, finalDesignDNAContents);
    await atomicWrite(
      referencePath,
      referenceMetadataPath,
      finalReferenceContents,
    );
    await atomicWrite(workspace.sessionsPath, sessionPath, finalSessionContents);
  } catch (error) {
    const rollbackErrors: unknown[] = [];
    await (originalDesignDNAContents === undefined
      ? unlink(designDNAPath).catch((rollbackError: unknown) => {
          if (
            !(
              rollbackError instanceof Error &&
              "code" in rollbackError &&
              rollbackError.code === "ENOENT"
            )
          ) {
            rollbackErrors.push(rollbackError);
          }
        })
      : atomicWrite(
          referencePath,
          designDNAPath,
          originalDesignDNAContents,
        ).catch((rollbackError: unknown) => rollbackErrors.push(rollbackError)));
    await atomicWrite(
      referencePath,
      referenceMetadataPath,
      originalReferenceContents,
    ).catch((rollbackError: unknown) => rollbackErrors.push(rollbackError));
    if (rollbackErrors.length > 0) {
      throw new Error("Reference scan checkpoint and rollback both failed", {
        cause: { commitError: error, rollbackErrors },
      });
    }
    throw error;
  }
}

export async function listSessions(
  rootPath: string,
  projectId: string,
): Promise<DesignSession[]> {
  const workspace = await loadValidatedProjectContext(rootPath, projectId);
  const entries = await readdir(workspace.sessionsPath, { withFileTypes: true });
  const sessions = await Promise.all(
    entries
      .filter(
        (entry) =>
          entry.isFile() && !entry.isSymbolicLink() && entry.name.endsWith(".json"),
      )
      .map(async (entry) => {
        const sessionPath = assertPathInsideWorkspace(
          workspace.sessionsPath,
          join(workspace.sessionsPath, entry.name),
        );
        const persisted = await readBoundedJsonFile(sessionPath, "Session record");
        if (!isPersistedSession(persisted) || persisted.projectId !== projectId) {
          throw new Error("Session record is invalid");
        }
        return persisted;
      }),
  );
  return sessions.sort((left, right) =>
    right.createdAt.localeCompare(left.createdAt),
  );
}

export async function saveRenderArtifact(
  rootPath: string,
  metadata: RenderArtifact,
  bytes: Uint8Array,
): Promise<SavedArtifact> {
  const hasExactKeys = (value: object, expected: readonly string[]): boolean => {
    const actual = Object.keys(value).sort();
    const wanted = [...expected].sort();
    return actual.length === wanted.length &&
      actual.every((key, index) => key === wanted[index]);
  };
  if (!hasExactKeys(metadata, [
    "id",
    "sessionId",
    "roundId",
    "route",
    "viewport",
    "viewportWidth",
    "viewportHeight",
    "imagePath",
    "capturedAt",
    "sourceRevision",
  ])) {
    throw new Error("Render artifact metadata contains missing or undeclared fields");
  }
  const isIsoTimestamp = (value: string): boolean => {
    const milliseconds = Date.parse(value);
    return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
  };
  const isCanonicalRoute = (value: string): boolean => {
    try {
      if (
        !value.startsWith("/") ||
        value.startsWith("//") ||
        value.length > 2048 ||
        value.includes("\\") ||
        /[\u0000-\u001f\u007f]/.test(value) ||
        /[\u0000-\u001f\u007f]/.test(decodeURIComponent(value))
      ) {
        return false;
      }
      const parsed = new URL(value, "http://render.invalid");
      return `${parsed.pathname}${parsed.search}${parsed.hash}` === value;
    } catch {
      return false;
    }
  };
  const isSafeGitPath = (value: unknown): value is string =>
    typeof value === "string" &&
    Buffer.byteLength(value, "utf8") > 0 &&
    Buffer.byteLength(value, "utf8") <= 1024 &&
    !value.startsWith("/") &&
    value !== ".." &&
    !value.startsWith("../") &&
    !value.includes("\\") &&
    posix.normalize(value) === value &&
    value !== ".git" &&
    !value.startsWith(".git/") &&
    value !== ".design-sharingan" &&
    !value.startsWith(".design-sharingan/") &&
    !value.includes("\0") &&
    !value.includes("\n") &&
    !value.includes("\r");
  const source = metadata.sourceRevision;
  const allowedIndexStatusCodes = new Set([" ", "M", "T", "A", "D", "R", "C", "U"]);
  const allowedWorktreeStatusCodes = new Set([" ", "M", "T", "D", "R", "C", "U"]);
  const validSourceRevision = source.kind === "UNVERSIONED"
    ? source.available === false
      ? hasExactKeys(source, ["kind", "available", "reason"]) &&
        (source.reason === "NOT_A_GIT_WORKSPACE" || source.reason === "GIT_EVIDENCE_UNAVAILABLE")
      : hasExactKeys(source, ["kind", "available", "truncated", "worktreeFingerprint", "fileCount"]) &&
        source.available === true &&
        source.truncated === false &&
        /^[0-9a-f]{64}$/.test(source.worktreeFingerprint) &&
        Number.isSafeInteger(source.fileCount) &&
        source.fileCount >= 0 &&
        source.fileCount <= 512
    : source.kind === "GIT" &&
      hasExactKeys(source, ["kind", "available", "head", "branch", "status", "entries", "truncated", "worktreeFingerprint", "fileCount"]) &&
      source.available === true &&
      /^[0-9a-f]{40,64}$/i.test(source.head) &&
      Buffer.byteLength(source.branch, "utf8") > 0 &&
      Buffer.byteLength(source.branch, "utf8") <= 255 &&
      !/[\0\r\n]/.test(source.branch) &&
      (source.status === "CLEAN" || source.status === "DIRTY") &&
      source.truncated === false &&
      /^[0-9a-f]{64}$/.test(source.worktreeFingerprint) &&
      Number.isSafeInteger(source.fileCount) &&
      source.fileCount >= 1 &&
      source.fileCount <= 512 &&
      Array.isArray(source.entries) &&
      source.entries.length <= 512 &&
      source.fileCount >= source.entries.length &&
      new Set(source.entries.map((entry) => entry.path)).size === source.entries.length &&
      source.entries.every((entry) => {
        const renamed = entry.index === "R" || entry.index === "C" ||
          entry.workingTree === "R" || entry.workingTree === "C";
        return (
        (entry.originalPath === undefined
          ? hasExactKeys(entry, ["index", "workingTree", "path"])
          : hasExactKeys(entry, ["index", "workingTree", "path", "originalPath"])) &&
        typeof entry.index === "string" && entry.index.length === 1 &&
        typeof entry.workingTree === "string" && entry.workingTree.length === 1 &&
        (((entry.index === "?" && entry.workingTree === "?") ||
          (entry.index === "!" && entry.workingTree === "!")) ||
          (allowedIndexStatusCodes.has(entry.index) &&
            allowedWorktreeStatusCodes.has(entry.workingTree) &&
            !(entry.index === " " && entry.workingTree === " "))) &&
        renamed === (entry.originalPath !== undefined) &&
        isSafeGitPath(entry.path) &&
        (entry.originalPath === undefined || isSafeGitPath(entry.originalPath)));
      }) &&
      (source.status === "CLEAN"
        ? source.entries.length === 0 && source.truncated === false
        : source.entries.length > 0);
  if (
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(metadata.id) ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(metadata.sessionId) ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(metadata.roundId) ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(metadata.viewport) ||
    !isCanonicalRoute(metadata.route) ||
    !Number.isSafeInteger(metadata.viewportWidth) ||
    metadata.viewportWidth < 240 ||
    metadata.viewportWidth > 7680 ||
    !Number.isSafeInteger(metadata.viewportHeight) ||
    metadata.viewportHeight < 240 ||
    metadata.viewportHeight > 7680 ||
    !isIsoTimestamp(metadata.capturedAt) ||
    !validSourceRevision
  ) {
    throw new Error("Render artifact metadata, timestamp, route, or source revision is invalid");
  }
  if (
    bytes.byteLength < 24 ||
    ![137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => bytes[index] === byte) ||
    bytes[12] !== 73 || bytes[13] !== 72 || bytes[14] !== 68 || bytes[15] !== 82
  ) {
    throw new Error("Render artifact bytes must be a non-empty PNG");
  }
  if (bytes.byteLength > MAX_RENDER_BYTES) {
    throw new Error("Render artifact PNG is too large; maximum size is 25 MiB");
  }
  const pngHeader = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (
    pngHeader.getUint32(16) !== metadata.viewportWidth ||
    pngHeader.getUint32(20) !== metadata.viewportHeight
  ) {
    throw new Error("Render artifact PNG dimensions do not match metadata dimensions");
  }
  const workspace = await ensureDesignWorkspace(rootPath);
  assertSafePathSegment(metadata.sessionId, "Render session id");
  assertSafePathSegment(metadata.roundId, "Render round id");
  assertSafePathSegment(metadata.viewport, "Render viewport");
  const expectedArtifactPath = assertPathInsideWorkspace(workspace.rendersPath, join(
    workspace.rendersPath,
    metadata.sessionId,
    metadata.roundId,
    `${metadata.viewport}.png`,
  ));
  const artifactPath = assertPathInsideWorkspace(
    workspace.rendersPath,
    metadata.imagePath,
  );
  if (artifactPath !== expectedArtifactPath) {
    throw new Error("Render artifact must use the exact render artifact path");
  }
  const artifactDirectory = dirname(artifactPath);
  await mkdir(artifactDirectory, { recursive: true });

  const artifactExtension = extname(artifactPath);
  const metadataPath = assertPathInsideWorkspace(
    workspace.rendersPath,
    join(
      artifactDirectory,
      `${basename(artifactPath, artifactExtension)}${
        artifactExtension === ".json" ? ".metadata" : ""
      }.json`,
    ),
  );

  const persistedMetadata = {
    ...metadata,
    imagePath: artifactPath,
  };
  const metadataContents = stableJson(persistedMetadata);
  if (Buffer.byteLength(metadataContents, "utf8") > MAX_RECORD_BYTES) {
    throw new Error("Render artifact metadata is too large; maximum size is 1 MiB");
  }

  let artifactOwnership: { dev: number; ino: number } | undefined;
  try {
    artifactOwnership = await atomicCreate(workspace.rendersPath, artifactPath, bytes);
    await atomicCreate(workspace.rendersPath, metadataPath, metadataContents);
  } catch (error) {
    if (artifactOwnership !== undefined) {
      try {
        await unlinkCreatedFileIfOwned(artifactPath, artifactOwnership);
      } catch (rollbackError) {
        throw new Error("Render artifact metadata creation failed and owned-image rollback could not safely complete", {
          cause: { persistenceError: error, rollbackError },
        });
      }
    }
    if (
      error instanceof Error &&
      "code" in error &&
      (error.code === "EEXIST" || error.code === "EISDIR")
    ) {
      throw new Error("Render artifact already exists; evidence is immutable", { cause: error });
    }
    throw error;
  }

  return { artifactPath, metadataPath };
}
