import {
  lstat,
  link,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  unlink,
} from "node:fs/promises";
import { constants } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, extname, join, posix } from "node:path";
import type {
  ActivityEvent,
  Approval,
  DesignApproach,
  DesignDNA,
  DesignSession,
  FeatureBrief,
  LearnSessionStatus,
  Project,
  Reference,
  RenderArtifact,
  RenderSourcePathEvidence,
  UXImpact,
} from "@design-sharingan/core";
import {
  canTransitionLearnSession,
  createActivityEvent,
  isCanonicalIdentifier,
  isCanonicalIsoDateTime,
  isDesignSessionEnvelope,
  orderActivityEvents,
  validateActivityEvent,
} from "@design-sharingan/core";
import { assertPathInsideWorkspace } from "./path-policy";

const MACHINE_DIRECTORY = ".design-sharingan";
const MAX_REFERENCE_BYTES = 10 * 1024 * 1024;
const MAX_RECORD_BYTES = 1024 * 1024;
const MAX_RENDER_BYTES = 25 * 1024 * 1024;
const MAX_SESSION_HISTORY_ENTRIES = 512;
const MAX_ACTIVITY_HISTORY_ENTRIES = 1_024;
const MAX_HISTORY_BYTES = 8 * 1024 * 1024;
const CHECKPOINT_SUFFIX = ".checkpoint.json";
const ACTIVITY_ID_PATTERN = /^act_[a-f0-9]{64}$/;

interface SessionCheckpoint {
  eventId: string;
  sessionId: string;
  projectId: string;
  version: number;
  sessionHash: string;
  session: DesignSession;
}

export interface DesignWorkspace {
  rootPath: string;
  machinePath: string;
  projectMetadataPath: string;
  referencesPath: string;
  sessionsPath: string;
  activityPath: string;
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
    activityPath: join(machinePath, "activity"),
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
  const destinationBefore = await lstat(canonicalDestination).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  });
  if (destinationBefore !== undefined &&
    (!destinationBefore.isFile() || destinationBefore.isSymbolicLink() || destinationBefore.nlink !== 1)) {
    throw new Error("Runtime record destination is not a private regular file");
  }

  try {
    temporaryFile = await open(temporaryPath, "wx", 0o600);
    await temporaryFile.writeFile(contents);
    await temporaryFile.sync();
    await temporaryFile.close();
    temporaryFile = undefined;
    const destinationAtCommit = await lstat(canonicalDestination).catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
      throw error;
    });
    if (
      destinationBefore === undefined
        ? destinationAtCommit !== undefined
        : destinationAtCommit === undefined ||
          destinationAtCommit.dev !== destinationBefore.dev ||
          destinationAtCommit.ino !== destinationBefore.ino ||
          destinationAtCommit.nlink !== 1
    ) {
      throw new Error("Runtime record destination changed before atomic commit");
    }
    await rename(temporaryPath, canonicalDestination);
    const destinationAfter = await lstat(canonicalDestination);
    if (
      destinationAfter.isSymbolicLink() ||
      !destinationAfter.isFile() ||
      destinationAfter.nlink !== 1
    ) {
      throw new Error("Runtime record destination is not a private regular file after commit");
    }
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
    const destination = await lstat(canonicalDestination);
    if (
      destination.isSymbolicLink() ||
      !destination.isFile() ||
      destination.nlink !== 1 ||
      destination.dev !== ownership.dev ||
      destination.ino !== ownership.ino
    ) {
      throw new Error("Runtime record could not be committed as a private regular file");
    }
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
  // Give an interleaved writer that observed the newly-created inode a chance
  // to publish its replacement before ownership is checked for rollback.
  await new Promise<void>((resolve) => setImmediate(resolve));
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
    if (entry.isSymbolicLink() || entry.nlink !== 1) {
      throw new Error("Workspace project metadata must be a private regular file, not a symbolic link or hard link");
    }
    if (!entry.isFile()) {
      throw new Error("Workspace project metadata must be a regular file");
    }
  } else {
    await atomicWriteJson(workspace.machinePath, metadataPath, {});
  }

  const createdEntry = await lstat(metadataPath);
  if (createdEntry.isSymbolicLink() || createdEntry.nlink !== 1) {
    throw new Error("Workspace project metadata must be a private regular file, not a symbolic link or hard link");
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
  const activityPath = await validateFixedDirectory(
    machinePath,
    join(machinePath, "activity"),
    "Activity directory",
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
    activityPath,
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
    if (pathEntry.isSymbolicLink() || !pathEntry.isFile() || pathEntry.nlink !== 1) {
      throw invalidProjectIdentity();
    }
    metadataHandle = await open(
      /* turbopackIgnore: true */ workspace.projectMetadataPath,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    const handleEntry = await metadataHandle.stat();
    if (
      !handleEntry.isFile() ||
      handleEntry.nlink !== 1 ||
      handleEntry.dev !== pathEntry.dev ||
      handleEntry.ino !== pathEntry.ino
    ) {
      throw invalidProjectIdentity();
    }

    const persisted: unknown = JSON.parse(
      await metadataHandle.readFile({ encoding: "utf8" }),
    );
    const currentEntry = await lstat(workspace.projectMetadataPath);
    if (
      currentEntry.isSymbolicLink() ||
      !currentEntry.isFile() ||
      currentEntry.nlink !== 1 ||
      currentEntry.dev !== handleEntry.dev ||
      currentEntry.ino !== handleEntry.ino ||
      currentEntry.size !== handleEntry.size
    ) {
      throw invalidProjectIdentity();
    }
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
    const persisted = await readBoundedJsonFile(
      workspace.projectMetadataPath,
      "Workspace project metadata",
    );
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
    pathEntry.nlink !== 1 ||
    pathEntry.size > MAX_RECORD_BYTES
  ) {
    throw new Error(`${label} is invalid`);
  }
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const handleEntry = await handle.stat();
    if (
      !handleEntry.isFile() ||
      handleEntry.nlink !== 1 ||
      handleEntry.dev !== pathEntry.dev ||
      handleEntry.ino !== pathEntry.ino ||
      handleEntry.size > MAX_RECORD_BYTES
    ) {
      throw new Error(`${label} changed while reading`);
    }
    const contents = await handle.readFile({ encoding: "utf8" });
    let current: Awaited<ReturnType<typeof lstat>>;
    try {
      current = await lstat(path);
    } catch {
      throw new Error(`${label} changed while reading`);
    }
    if (
      current.isSymbolicLink() ||
      !current.isFile() ||
      current.nlink !== 1 ||
      current.dev !== handleEntry.dev ||
      current.ino !== handleEntry.ino ||
      current.size !== handleEntry.size
    ) {
      throw new Error(`${label} changed while reading`);
    }
    return JSON.parse(contents) as unknown;
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
  return isDesignSessionEnvelope(value);
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
    pathEntry.nlink !== 1 ||
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
      handleEntry.nlink !== 1 ||
      handleEntry.dev !== pathEntry.dev ||
      handleEntry.ino !== pathEntry.ino ||
      handleEntry.size !== pathEntry.size
    ) {
      throw new Error("Reference image artifact changed while reading");
    }
    const bytes = new Uint8Array(await handle.readFile());
    const current = await lstat(imagePath);
    if (
      current.isSymbolicLink() ||
      !current.isFile() ||
      current.nlink !== 1 ||
      current.dev !== handleEntry.dev ||
      current.ino !== handleEntry.ino ||
      current.size !== handleEntry.size
    ) {
      throw new Error("Reference image artifact changed while reading");
    }
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

function activityDescriptor(session: DesignSession): {
  category: ActivityEvent["category"];
  message: string;
} {
  const error = (session as DesignSession & { error?: unknown }).error;
  const hasSafeExecutionFailure = session.type === "SAFE_EXECUTION" &&
    Object.hasOwn(session as object, "executionFailure");
  if (
    (typeof error === "string" && error.trim().length > 0) ||
    session.status === "FAILED" ||
    hasSafeExecutionFailure
  ) {
    return {
      category: "SYSTEM",
      message: `${session.type.replaceAll("_", " ")} failed`,
    };
  }
  if (session.status === "NOT_VERIFIED") {
    return {
      category: "SYSTEM",
      message: `${session.type.replaceAll("_", " ")} not verified`,
    };
  }
  switch (session.type) {
    case "REFERENCE_SCAN":
      if (session.status === "ANALYZING") {
        return { category: "AGENT", message: "Analyzing reference" };
      }
      if (session.status === "RESULT_READY") {
        return { category: "AGENT", message: "Reference analysis evidence saved" };
      }
      return { category: "SYSTEM", message: "Reference scan created" };
    case "ASSIMILATION":
      return { category: "AGENT", message: "Assimilation not verified" };
    case "FEATURE_EVOLVE":
      if (session.status === "AWAITING_DECISION") {
        return { category: "APPROVAL", message: "Waiting for approach approval" };
      }
      if (session.status === "APPROVED") {
        return { category: "APPROVAL", message: "Design approach approved" };
      }
      if (session.status === "ANALYZING") {
        return { category: "AGENT", message: "Analyzing feature impact" };
      }
      if (session.status === "REVISE") {
        return { category: "APPROVAL", message: "Feature direction needs revision" };
      }
      if (session.status === "REJECT") {
        return { category: "APPROVAL", message: "Feature direction rejected" };
      }
      return { category: "AGENT", message: "Feature EVOLVE evidence saved" };
    case "SAFE_EXECUTION":
      if (session.status === "WAITING_APPROVAL") {
        return { category: "APPROVAL", message: "Waiting for approval" };
      }
      if (session.status === "APPROVED") {
        return { category: "APPROVAL", message: "Mutation approval recorded" };
      }
      if (session.status === "REJECTED") {
        return { category: "APPROVAL", message: "Mutation proposal rejected" };
      }
      if (session.status === "PREPARING") {
        return { category: "AGENT", message: "Preparing change proposal" };
      }
      if (session.status === "PROPOSING") {
        return { category: "AGENT", message: "Change proposal ready" };
      }
      if (session.status === "REVISING") {
        return { category: "AGENT", message: "Revising change proposal" };
      }
      if (session.status === "EDITING") {
        return { category: "GIT", message: "Safe mutation evidence saved" };
      }
      if (session.status === "RUNNING") {
        return { category: "RENDER", message: "Running project" };
      }
      if (session.status === "CAPTURING") {
        return { category: "RENDER", message: "Capturing configured route" };
      }
      if (session.status === "VERIFYING") {
        return { category: "RENDER", message: "Verifying mutation evidence" };
      }
      if (session.status === "COMPLETE") {
        return { category: "SYSTEM", message: "Safe execution verified" };
      }
      return { category: "SYSTEM", message: "Safe execution initialized" };
    case "MANGEKYO_LOOP":
      if (session.status === "CAPTURING") {
        return { category: "RENDER", message: "Capturing configured route" };
      }
      if (session.status === "RUNNING") {
        return { category: "RENDER", message: "Running project" };
      }
      if (session.status === "HUMAN_GATE") {
        return { category: "APPROVAL", message: "Human decision required" };
      }
      if (session.status === "COMPARING") {
        return { category: "AGENT", message: "Comparing render evidence" };
      }
      if (session.status === "POLICY_CHECK") {
        return { category: "APPROVAL", message: "Checking autonomy policy" };
      }
      if (session.status === "EDITING") {
        return { category: "GIT", message: "Applying approved visual change" };
      }
      if (session.status === "PREPARING") {
        return { category: "AGENT", message: "Preparing visual round" };
      }
      if (session.status === "DECIDING") {
        return { category: "AGENT", message: "Evaluating visual findings" };
      }
      if (session.status === "FIXING") {
        return { category: "AGENT", message: "Preparing next visual refinement" };
      }
      if (session.status === "COMPLETE") {
        return { category: "SYSTEM", message: "Visual round verified" };
      }
      if (session.status === "BLOCKED") {
        return { category: "APPROVAL", message: "Mangekyō loop blocked" };
      }
      if (session.status === "FAILED") {
        return { category: "SYSTEM", message: "Mangekyō loop failed" };
      }
      return { category: "AGENT", message: "Mangekyō loop initialized" };
    case "GENOME_INIT":
      return { category: "GOVERNANCE", message: "Design Genome evidence saved" };
    case "DRIFT_AUDIT":
      return { category: "GOVERNANCE", message: "Drift audit evidence saved" };
    case "RELEASE_GATE":
      return { category: "GOVERNANCE", message: "Release evidence evaluated" };
  }
}

function sessionCheckpointHash(session: DesignSession): string {
  return createHash("sha256").update(stableJson(session), "utf8").digest("hex");
}

function activityEventForSession(
  session: DesignSession,
  checkpointHash: string,
  checkpointVersion: number,
): ActivityEvent {
  const descriptor = activityDescriptor(session);
  const digest = createHash("sha256")
    .update(`${checkpointHash}\u0000${checkpointVersion}`)
    .digest("hex");
  return createActivityEvent({
    id: `act_${digest}`,
    projectId: session.projectId,
    sessionId: session.id,
    occurredAt: session.updatedAt,
    category: descriptor.category,
    message: descriptor.message,
    evidence: [{ kind: "SESSION", id: session.id }],
  });
}

function isSessionCheckpoint(value: unknown): value is SessionCheckpoint {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Partial<SessionCheckpoint>;
  const keys = Object.keys(value).sort();
  return keys.length === 6 &&
    keys.join("\u0000") === [
      "eventId",
      "projectId",
      "session",
      "sessionHash",
      "sessionId",
      "version",
    ].join("\u0000") &&
    typeof record.eventId === "string" && ACTIVITY_ID_PATTERN.test(record.eventId) &&
    typeof record.projectId === "string" && isDesignSessionEnvelope(record.session) &&
    typeof record.sessionId === "string" && isDesignSessionEnvelope(record.session) &&
    record.session.id === record.sessionId && record.session.projectId === record.projectId &&
    typeof record.version === "number" && Number.isSafeInteger(record.version) &&
    record.version > 0 && record.version <= MAX_SESSION_HISTORY_ENTRIES &&
    typeof record.sessionHash === "string" && /^[a-f0-9]{64}$/.test(record.sessionHash) &&
    record.sessionHash === sessionCheckpointHash(record.session);
}

interface BoundedFileEntry {
  name: string;
  path: string;
  size: number;
}

async function boundedJsonDirectory(
  directory: string,
  label: string,
  maximumEntries: number,
): Promise<BoundedFileEntry[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  if (entries.length > maximumEntries) {
    throw new Error(`${label} exceeds the bounded history entry budget`);
  }
  const candidates = entries.filter((entry) => entry.name.endsWith(".json"));
  if (candidates.length > maximumEntries) {
    throw new Error(`${label} exceeds the bounded history entry budget`);
  }
  const files: BoundedFileEntry[] = [];
  let aggregateBytes = 0;
  for (const entry of candidates) {
    const path = assertPathInsideWorkspace(directory, join(directory, entry.name));
    const identity = await lstat(path);
    if (identity.isSymbolicLink() || !identity.isFile() || identity.nlink !== 1) {
      throw new Error(`${label} contains an unsafe runtime record`);
    }
    if (identity.size > MAX_RECORD_BYTES) {
      throw new Error(`${label} contains an oversized runtime record`);
    }
    aggregateBytes += identity.size;
    if (aggregateBytes > MAX_HISTORY_BYTES) {
      throw new Error(`${label} exceeds the bounded history byte budget`);
    }
    files.push({ name: entry.name, path, size: identity.size });
  }
  return files;
}

async function readSessionCheckpoints(
  workspace: DesignWorkspace,
  projectId?: string,
): Promise<SessionCheckpoint[]> {
  const files = await boundedJsonDirectory(
    workspace.activityPath,
    "Activity history",
    MAX_ACTIVITY_HISTORY_ENTRIES,
  );
  const checkpoints: SessionCheckpoint[] = [];
  for (const file of files.filter(({ name }) => name.endsWith(CHECKPOINT_SUFFIX))) {
    const value = await readBoundedJsonFile(file.path, "Session checkpoint");
    if (!isSessionCheckpoint(value)) throw new Error("Session checkpoint is invalid");
    const expectedFileName = `${value.eventId}${CHECKPOINT_SUFFIX}`;
    if (file.name !== expectedFileName) throw new Error("Session checkpoint filename is invalid");
    if (projectId !== undefined && value.projectId !== projectId) {
      throw new Error("Session checkpoint project identity is invalid");
    }
    checkpoints.push(value);
  }
  return checkpoints;
}

/**
 * Check the two-file activity journal before any caller consumes it. A
 * checkpoint and event are deliberately separate immutable records, so an
 * interrupted write must be either fully present or rejected as an orphan.
 */
async function assertActivityJournalPairing(
  projectId: string,
  files: BoundedFileEntry[],
  checkpoints: readonly SessionCheckpoint[],
): Promise<void> {
  const events = new Set<string>();
  const checkpointsByEvent = new Map(
    checkpoints.map((checkpoint) => [checkpoint.eventId, checkpoint]),
  );
  for (const file of files.filter(({ name }) => !name.endsWith(CHECKPOINT_SUFFIX))) {
    const id = file.name.slice(0, -".json".length);
    if (!ACTIVITY_ID_PATTERN.test(id)) throw new Error("Activity event identity is invalid");
    const value = await readBoundedJsonFile(file.path, "Activity record");
    if (!validateActivityEvent(value) || value.projectId !== projectId || value.id !== id) {
      throw new Error("Activity record is invalid");
    }
    if (!checkpointsByEvent.has(id)) {
      throw new Error("Activity record checkpoint is missing");
    }
    events.add(id);
  }
  for (const checkpoint of checkpoints) {
    if (checkpoint.projectId !== projectId || !events.has(checkpoint.eventId)) {
      throw new Error("Activity checkpoint is orphaned or belongs to another project");
    }
  }
}

async function persistSessionActivity(
  workspace: DesignWorkspace,
  session: DesignSession,
): Promise<{
  path: string;
  ownership?: { dev: number; ino: number };
  checkpointPath: string;
  checkpointOwnership?: { dev: number; ino: number };
}> {
  const checkpointHash = sessionCheckpointHash(session);
  const files = await boundedJsonDirectory(
    workspace.activityPath,
    "Activity history",
    MAX_ACTIVITY_HISTORY_ENTRIES,
  );
  const checkpoints = await readSessionCheckpoints(workspace, session.projectId);
  await assertActivityJournalPairing(session.projectId, files, checkpoints);
  const sessionCheckpoints = checkpoints.filter(
    (checkpoint) => checkpoint.sessionId === session.id && checkpoint.projectId === session.projectId,
  );
  const latestVersion = Math.max(0, ...sessionCheckpoints.map((checkpoint) => checkpoint.version));
  const matchingCheckpoint = sessionCheckpoints.find(
    (checkpoint) => checkpoint.sessionId === session.id &&
      checkpoint.projectId === session.projectId &&
      checkpoint.sessionHash === checkpointHash &&
      stableJson(checkpoint.session) === stableJson(session),
  );
  // A retry of the current head is idempotent. A deliberate rollback to an
  // earlier immutable checkpoint receives a new version so the head remains
  // monotonic and its event remains auditable.
  const existingCheckpoint = matchingCheckpoint !== undefined &&
    matchingCheckpoint.version === latestVersion ? matchingCheckpoint : undefined;
  const checkpointVersion = existingCheckpoint?.version ?? latestVersion + 1;
  if (checkpointVersion > MAX_SESSION_HISTORY_ENTRIES) {
    throw new Error("Session checkpoint history exceeds its bounded entry budget");
  }
  const event = activityEventForSession(session, checkpointHash, checkpointVersion);
  const path = assertPathInsideWorkspace(
    workspace.activityPath,
    join(workspace.activityPath, `${event.id}.json`),
  );
  const checkpointPath = assertPathInsideWorkspace(
    workspace.activityPath,
    join(workspace.activityPath, `${event.id}${CHECKPOINT_SUFFIX}`),
  );
  const contents = stableJson(event);
  const checkpointContents = stableJson({
    eventId: event.id,
    sessionId: session.id,
    projectId: session.projectId,
    version: checkpointVersion,
    sessionHash: checkpointHash,
    session,
  } satisfies SessionCheckpoint);
  if (existingCheckpoint !== undefined && existingCheckpoint.eventId !== event.id) {
    throw new Error("Session checkpoint identity could not be reproduced");
  }
  let checkpointOwnership: { dev: number; ino: number } | undefined;
  try {
    if (existingCheckpoint === undefined) {
      checkpointOwnership = await atomicCreate(
        workspace.activityPath,
        checkpointPath,
        checkpointContents,
      );
    }
    try {
      const ownership = await atomicCreate(workspace.activityPath, path, contents);
      return { path, ownership, checkpointPath, checkpointOwnership };
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
      const existing = await readBoundedJsonFile(path, "Activity record");
      const existingCheckpointValue = await readBoundedJsonFile(checkpointPath, "Session checkpoint");
      if (
        !validateActivityEvent(existing) || stableJson(existing) !== contents ||
        !isSessionCheckpoint(existingCheckpointValue) ||
        stableJson(existingCheckpointValue) !== checkpointContents
      ) {
        throw new Error("Activity event identity conflicts with durable evidence");
      }
      return { path, checkpointPath, checkpointOwnership };
    }
  } catch (error) {
    if (checkpointOwnership !== undefined) {
      await unlinkCreatedFileIfOwned(checkpointPath, checkpointOwnership).catch(() => undefined);
    }
    throw error;
  }
}

/**
 * Returns a project-scoped, validated, deterministically ordered activity
 * stream. It never reads caller-supplied paths or exposes artifact contents.
 */
export async function listActivityEvents(
  rootPath: string,
  projectId: string,
): Promise<readonly ActivityEvent[]> {
  const workspace = await loadValidatedProjectContext(rootPath, projectId);
  const files = await boundedJsonDirectory(
    workspace.activityPath,
    "Activity history",
    MAX_ACTIVITY_HISTORY_ENTRIES,
  );
  const checkpoints = await readSessionCheckpoints(workspace, projectId);
  await assertActivityJournalPairing(projectId, files, checkpoints);
  const checkpointsByEvent = new Map(checkpoints.map((checkpoint) => [checkpoint.eventId, checkpoint]));
  const latestBySession = new Map<string, SessionCheckpoint>();
  for (const checkpoint of checkpoints) {
    const previous = latestBySession.get(checkpoint.sessionId);
    if (previous !== undefined && previous.version === checkpoint.version && previous.eventId !== checkpoint.eventId) {
      throw new Error("Session checkpoint versions are ambiguous");
    }
    if (previous === undefined || checkpoint.version > previous.version) latestBySession.set(checkpoint.sessionId, checkpoint);
  }
  const events: ActivityEvent[] = [];
  for (const file of files.filter(({ name }) => !name.endsWith(CHECKPOINT_SUFFIX))) {
    const id = file.name.slice(0, -".json".length);
    if (!ACTIVITY_ID_PATTERN.test(id)) throw new Error("Activity event identity is invalid");
    const event = await readBoundedJsonFile(file.path, "Activity record");
    if (!validateActivityEvent(event) || event.projectId !== projectId || event.id !== id) {
      throw new Error("Activity record is invalid");
    }
    const checkpoint = checkpointsByEvent.get(id);
    if (checkpoint === undefined) throw new Error("Activity record checkpoint is missing");
    const expected = activityEventForSession(checkpoint.session, checkpoint.sessionHash, checkpoint.version);
    if (stableJson(expected) !== stableJson(event)) {
      throw new Error("Activity record is stale or does not match its session checkpoint");
    }
    events.push(createActivityEvent(event));
  }
  // Every historical event is authenticated by its own immutable checkpoint;
  // only the current session head must match the newest checkpoint. This keeps
  // durable history readable after legitimate later transitions while still
  // rejecting orphaned or directly replaced session records.
  const sessions = await listSessions(rootPath, projectId, false);
  const sessionsById = new Map(sessions.map((session) => [session.id, session]));
  for (const [sessionId, latest] of latestBySession) {
    const session = sessionsById.get(sessionId);
    if (session === undefined || latest.sessionHash !== sessionCheckpointHash(session)) {
      throw new Error("Session record does not match its latest immutable checkpoint");
    }
  }
  for (const session of sessions) {
    if (!latestBySession.has(session.id)) {
      throw new Error("Session record checkpoint is missing");
    }
  }
  return orderActivityEvents(events);
}

export async function saveSession(
  rootPath: string,
  session: DesignSession,
): Promise<string> {
  assertSafePathSegment(session.id, "Session id");
  if (!isDesignSessionEnvelope(session)) {
    throw new Error("Session record envelope is invalid (including canonical timestamps)");
  }
  const workspace = await loadValidatedProjectContext(
    rootPath,
    session.projectId,
  );
  const sessionPath = assertPathInsideWorkspace(
    workspace.sessionsPath,
    join(workspace.sessionsPath, `${session.id}.json`),
  );
  const contents = boundedSessionContents(session);
  const activity = await persistSessionActivity(workspace, session);
  try {
    await atomicWrite(workspace.sessionsPath, sessionPath, contents);
  } catch (error) {
    if (activity.ownership !== undefined) {
      await unlinkCreatedFileIfOwned(activity.path, activity.ownership).catch(() => undefined);
    }
    if (activity.checkpointOwnership !== undefined) {
      await unlinkCreatedFileIfOwned(activity.checkpointPath, activity.checkpointOwnership).catch(() => undefined);
    }
    throw error;
  }
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

async function withLearnTransitionClaim<T>(
  rootPath: string,
  projectId: string,
  sessionId: string,
  action: () => Promise<T>,
): Promise<T> {
  const workspace = await ensureDesignWorkspace(rootPath);
  const claimPath = assertPathInsideWorkspace(
    workspace.sessionsPath,
    join(workspace.sessionsPath, `.${sessionId}.learn.claim`),
  );
  let claim: Awaited<ReturnType<typeof open>> | undefined;
  try {
    claim = await open(claimPath, "wx", 0o600);
    await claim.writeFile(`${projectId}\n`, "utf8");
    await claim.sync();
    return await action();
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      throw new Error("Learn session transition is already in progress", { cause: error });
    }
    throw error;
  } finally {
    await claim?.close().catch(() => undefined);
    await unlink(claimPath).catch(() => undefined);
  }
}

export async function transitionLearnSession(
  rootPath: string,
  expectedStatus: LearnSessionStatus,
  session: DesignSession & { status: LearnSessionStatus },
): Promise<string> {
  return withLearnTransitionClaim(rootPath, session.projectId, session.id, async () => {
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
  });
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
  await withLearnTransitionClaim(rootPath, session.projectId, session.id, async () => {
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
  });
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
    throw new Error("Feature EVOLVE approval checkpoint is incomplete or has invalid timestamps");
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
    const approvalActivity = await persistSessionActivity(workspace, session);
    let executionActivity: Awaited<ReturnType<typeof persistSessionActivity>>;
    try {
      executionActivity = await persistSessionActivity(workspace, executeSession);
    } catch (error) {
      if (approvalActivity.ownership !== undefined) {
        await unlinkCreatedFileIfOwned(approvalActivity.path, approvalActivity.ownership)
          .catch(() => undefined);
      }
      if (approvalActivity.checkpointOwnership !== undefined) {
        await unlinkCreatedFileIfOwned(
          approvalActivity.checkpointPath,
          approvalActivity.checkpointOwnership,
        ).catch(() => undefined);
      }
      throw error;
    }

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
      if (executionActivity.ownership !== undefined) {
        await unlinkCreatedFileIfOwned(executionActivity.path, executionActivity.ownership)
          .catch(() => undefined);
      }
      if (executionActivity.checkpointOwnership !== undefined) {
        await unlinkCreatedFileIfOwned(
          executionActivity.checkpointPath,
          executionActivity.checkpointOwnership,
        ).catch(() => undefined);
      }
      if (approvalActivity.ownership !== undefined) {
        await unlinkCreatedFileIfOwned(approvalActivity.path, approvalActivity.ownership)
          .catch(() => undefined);
      }
      if (approvalActivity.checkpointOwnership !== undefined) {
        await unlinkCreatedFileIfOwned(
          approvalActivity.checkpointPath,
          approvalActivity.checkpointOwnership,
        ).catch(() => undefined);
      }
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
  const keys = Object.keys(value);
  const allowed = [
    "id", "projectId", "type", "status", "createdAt", "updatedAt",
    "referenceId", "referenceTitle", "error",
  ];
  const required = allowed.filter((key) => key !== "error");
  return (
    keys.length >= 8 &&
    keys.length <= 9 &&
    required.every((key) => keys.includes(key)) &&
    keys.every((key) => allowed.includes(key)) &&
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
  const keys = Object.keys(value);
  return (
    keys.length === 10 &&
    [
      "id", "projectId", "type", "status", "createdAt", "updatedAt",
      "referenceId", "referenceTitle", "designDNA", "agentThreadId",
    ].every((key) => keys.includes(key)) &&
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
  const activity = await persistSessionActivity(workspace, session);

  try {
    await atomicWrite(referencePath, designDNAPath, finalDesignDNAContents);
    await atomicWrite(
      referencePath,
      referenceMetadataPath,
      finalReferenceContents,
    );
    await atomicWrite(workspace.sessionsPath, sessionPath, finalSessionContents);
  } catch (error) {
    if (activity.ownership !== undefined) {
      await unlinkCreatedFileIfOwned(activity.path, activity.ownership).catch(
        () => undefined,
      );
    }
    if (activity.checkpointOwnership !== undefined) {
      await unlinkCreatedFileIfOwned(
        activity.checkpointPath,
        activity.checkpointOwnership,
      ).catch(() => undefined);
    }
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
  verifyActivity = true,
): Promise<DesignSession[]> {
  const workspace = await loadValidatedProjectContext(rootPath, projectId);
  const files = await boundedJsonDirectory(
    workspace.sessionsPath,
    "Session history",
    MAX_SESSION_HISTORY_ENTRIES,
  );
  const sessions: DesignSession[] = [];
  for (const file of files) {
    const sessionId = file.name.slice(0, -".json".length);
    assertSafePathSegment(sessionId, "Session id");
    const persisted = await readBoundedJsonFile(file.path, "Session record");
    if (
      !isPersistedSession(persisted) ||
      persisted.projectId !== projectId ||
      persisted.id !== sessionId
    ) {
      throw new Error("Session record is invalid");
    }
    sessions.push(persisted);
  }
  if (verifyActivity) {
    const activityFiles = await boundedJsonDirectory(
      workspace.activityPath,
      "Activity history",
      MAX_ACTIVITY_HISTORY_ENTRIES,
    );
    const checkpoints = await readSessionCheckpoints(workspace, projectId);
    await assertActivityJournalPairing(projectId, activityFiles, checkpoints);
    const latestBySession = new Map<string, SessionCheckpoint>();
    for (const checkpoint of checkpoints) {
      if (checkpoint.projectId !== projectId) continue;
      const previous = latestBySession.get(checkpoint.sessionId);
      if (previous !== undefined && previous.version === checkpoint.version && previous.eventId !== checkpoint.eventId) {
        throw new Error("Session checkpoint versions are ambiguous");
      }
      if (previous === undefined || checkpoint.version > previous.version) {
        latestBySession.set(checkpoint.sessionId, checkpoint);
      }
    }
    for (const session of sessions) {
      const latest = latestBySession.get(session.id);
      if (latest === undefined || latest.sessionHash !== sessionCheckpointHash(session)) {
        throw new Error("Session record does not match its latest immutable checkpoint");
      }
    }
  }
  return sessions.sort((left, right) =>
    right.createdAt.localeCompare(left.createdAt) || left.id.localeCompare(right.id),
  );
}

const RENDER_INTEGRITY_SUFFIX = ".integrity.json";

interface RenderIntegrityRecord {
  artifactId: string;
  sessionId: string;
  roundId: string;
  route: string;
  state: "default";
  viewport: string;
  viewportWidth: number;
  viewportHeight: number;
  imagePath: string;
  capturedAt: string;
  sourceRevisionFingerprint: string | null;
  contentHash: string;
  byteLength: number;
}

function renderMetadataPath(imagePath: string): string {
  const extension = extname(imagePath);
  return join(
    dirname(imagePath),
    `${basename(imagePath, extension)}${extension === ".json" ? ".metadata" : ""}.json`,
  );
}

function renderIntegrityPath(imagePath: string): string {
  const extension = extname(imagePath);
  return join(
    dirname(imagePath),
    `${basename(imagePath, extension)}${extension === ".json" ? ".metadata" : ""}${RENDER_INTEGRITY_SUFFIX}`,
  );
}

function renderIntegrityFor(
  metadata: RenderArtifact,
  bytes: Uint8Array,
): RenderIntegrityRecord {
  return {
    artifactId: metadata.id,
    sessionId: metadata.sessionId,
    roundId: metadata.roundId,
    route: metadata.route,
    state: "default",
    viewport: metadata.viewport,
    viewportWidth: metadata.viewportWidth,
    viewportHeight: metadata.viewportHeight,
    imagePath: metadata.imagePath,
    capturedAt: metadata.capturedAt,
    sourceRevisionFingerprint: metadata.sourceRevision.available === true
      ? metadata.sourceRevision.worktreeFingerprint
      : null,
    contentHash: createHash("sha256").update(bytes).digest("hex"),
    byteLength: bytes.byteLength,
  };
}

function isRenderIntegrity(value: unknown): value is RenderIntegrityRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Partial<RenderIntegrityRecord>;
  const keys = Object.keys(value).sort();
  return keys.join("\u0000") === [
    "artifactId",
    "byteLength",
    "capturedAt",
    "contentHash",
    "imagePath",
    "roundId",
    "route",
    "sessionId",
    "sourceRevisionFingerprint",
    "state",
    "viewport",
    "viewportHeight",
    "viewportWidth",
  ].join("\u0000") &&
    typeof record.artifactId === "string" && isCanonicalIdentifier(record.artifactId) &&
    typeof record.sessionId === "string" && isCanonicalIdentifier(record.sessionId) &&
    typeof record.roundId === "string" && isCanonicalIdentifier(record.roundId) &&
    typeof record.route === "string" && record.route.startsWith("/") &&
    record.state === "default" &&
    typeof record.viewport === "string" && isCanonicalIdentifier(record.viewport) &&
    Number.isSafeInteger(record.viewportWidth) && Number.isSafeInteger(record.viewportHeight) &&
    typeof record.imagePath === "string" &&
    typeof record.capturedAt === "string" &&
    (record.sourceRevisionFingerprint === null || /^[a-f0-9]{64}$/.test(record.sourceRevisionFingerprint ?? "")) &&
    typeof record.contentHash === "string" && /^[a-f0-9]{64}$/.test(record.contentHash) &&
    typeof record.byteLength === "number" && Number.isSafeInteger(record.byteLength) &&
    record.byteLength >= 24 && record.byteLength <= MAX_RENDER_BYTES;
}

async function readBoundedBinaryFile(
  path: string,
  label: string,
  maximumBytes: number,
): Promise<Uint8Array> {
  const pathEntry = await lstat(path);
  if (
    pathEntry.isSymbolicLink() || !pathEntry.isFile() || pathEntry.nlink !== 1 ||
    pathEntry.size > maximumBytes
  ) throw new Error(`${label} is invalid`);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    if (
      opened.isSymbolicLink?.() || !opened.isFile() || opened.nlink !== 1 ||
      opened.dev !== pathEntry.dev || opened.ino !== pathEntry.ino || opened.size !== pathEntry.size
    ) throw new Error(`${label} changed while reading`);
    const bytes = new Uint8Array(await handle.readFile());
    const current = await lstat(path);
    if (
      current.isSymbolicLink() || !current.isFile() || current.nlink !== 1 ||
      current.dev !== opened.dev || current.ino !== opened.ino || current.size !== opened.size
    ) throw new Error(`${label} changed while reading`);
    return bytes;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function assertPngBytesAndDimensions(
  bytes: Uint8Array,
  width: number,
  height: number,
): void {
  if (
    bytes.byteLength < 24 ||
    ![137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => bytes[index] === byte) ||
    bytes[12] !== 73 || bytes[13] !== 72 || bytes[14] !== 68 || bytes[15] !== 82
  ) throw new Error("Render artifact bytes must be a non-empty PNG");
  const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (header.getUint32(16) !== width || header.getUint32(20) !== height) {
    throw new Error("Render artifact PNG dimensions do not match metadata dimensions");
  }
}

/** Revalidate the immutable image, metadata sidecar, and digest sidecar. */
export async function assertRenderArtifactIntegrity(
  rootPath: string,
  metadata: RenderArtifact,
): Promise<void> {
  if (!isRenderArtifactMetadata(metadata)) {
    throw new Error("Render metadata sidecar identity is invalid");
  }
  const workspace = await ensureDesignWorkspace(rootPath);
  assertSafePathSegment(metadata.sessionId, "Render session id");
  assertSafePathSegment(metadata.roundId, "Render round id");
  assertSafePathSegment(metadata.viewport, "Render viewport");
  const expectedPath = assertPathInsideWorkspace(
    workspace.rendersPath,
    join(workspace.rendersPath, metadata.sessionId, metadata.roundId, `${metadata.viewport}.png`),
  );
  const imagePath = assertPathInsideWorkspace(workspace.rendersPath, metadata.imagePath);
  if (imagePath !== expectedPath) throw new Error("Render artifact path identity is invalid");
  const canonical = await realpath(imagePath);
  if (canonical !== imagePath) throw new Error("Render artifact path is not canonical");
  const imageEntry = await lstat(imagePath);
  if (
    imageEntry.isSymbolicLink() || !imageEntry.isFile() || imageEntry.nlink !== 1 ||
    imageEntry.size < 24 || imageEntry.size > MAX_RENDER_BYTES
  ) throw new Error("Render artifact is not an authenticated project-scoped file");
  const persistedMetadata = await readBoundedJsonFile(
    renderMetadataPath(imagePath),
    "Render metadata",
  );
  if (
    !isRenderArtifactMetadata(persistedMetadata) ||
    stableJson(persistedMetadata) !== stableJson({ ...metadata, imagePath })
  ) throw new Error("Render metadata sidecar identity does not match the session artifact");
  const integrityPath = renderIntegrityPath(imagePath);
  const integrityValue = await readBoundedJsonFile(integrityPath, "Render integrity sidecar");
  if (!isRenderIntegrity(integrityValue)) throw new Error("Render integrity sidecar is invalid");
  const bytes = await readBoundedBinaryFile(imagePath, "Render artifact", MAX_RENDER_BYTES);
  assertPngBytesAndDimensions(bytes, metadata.viewportWidth, metadata.viewportHeight);
  const expectedIntegrity = renderIntegrityFor({ ...metadata, imagePath }, bytes);
  if (stableJson(integrityValue) !== stableJson(expectedIntegrity)) {
    throw new Error("Render artifact bytes or sidecar integrity does not match authenticated evidence");
  }
}

function isRenderArtifactMetadata(value: unknown): value is RenderArtifact {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Partial<RenderArtifact>;
  const keys = Object.keys(value).sort();
  return keys.join("\u0000") === [
    "capturedAt",
    "id",
    "imagePath",
    "roundId",
    "route",
    "sessionId",
    "sourceRevision",
    "viewport",
    "viewportHeight",
    "viewportWidth",
  ].join("\u0000") &&
    typeof record.id === "string" && isCanonicalIdentifier(record.id) &&
    typeof record.sessionId === "string" && isCanonicalIdentifier(record.sessionId) &&
    typeof record.roundId === "string" && isCanonicalIdentifier(record.roundId) &&
    typeof record.route === "string" && record.route.startsWith("/") &&
    typeof record.viewport === "string" && isCanonicalIdentifier(record.viewport) &&
    Number.isSafeInteger(record.viewportWidth) && Number.isSafeInteger(record.viewportHeight) &&
    typeof record.imagePath === "string" && typeof record.capturedAt === "string" &&
    isCanonicalIsoDateTime(record.capturedAt) && record.sourceRevision !== undefined;
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
  const validRequiredPathEvidence = (value: RenderSourcePathEvidence[]): boolean => Array.isArray(value) &&
    value.length <= 128 &&
    new Set(value.map((entry) => entry.path)).size === value.length &&
    value.every((entry) => {
      if (!isSafeGitPath(entry.path)) return false;
      if (entry.state === "MISSING") return hasExactKeys(entry, ["path", "state"]);
      return (
        entry.state === "FILE" &&
        hasExactKeys(entry, ["path", "state", "mode", "size", "contentHash"]) &&
        Number.isSafeInteger(entry.mode) &&
        entry.mode >= 0 &&
        entry.mode <= 0o777 &&
        Number.isSafeInteger(entry.size) &&
        entry.size >= 0 &&
        entry.size <= 16 * 1024 * 1024 &&
        /^[0-9a-f]{64}$/.test(entry.contentHash)
      );
    });
  const allowedIndexStatusCodes = new Set([" ", "M", "T", "A", "D", "R", "C", "U"]);
  const allowedWorktreeStatusCodes = new Set([" ", "M", "T", "D", "R", "C", "U"]);
  const validSourceRevision = source.kind === "UNVERSIONED"
    ? source.available === false
      ? hasExactKeys(source, ["kind", "available", "reason"]) &&
        (source.reason === "NOT_A_GIT_WORKSPACE" || source.reason === "GIT_EVIDENCE_UNAVAILABLE")
      : hasExactKeys(source, ["kind", "available", "truncated", "worktreeFingerprint", "fileCount", "requiredPathEvidence"]) &&
        source.available === true &&
        source.truncated === false &&
        /^[0-9a-f]{64}$/.test(source.worktreeFingerprint) &&
        Number.isSafeInteger(source.fileCount) &&
        source.fileCount >= 0 &&
        source.fileCount <= 512 &&
        validRequiredPathEvidence(source.requiredPathEvidence)
    : source.kind === "GIT" &&
      hasExactKeys(source, ["kind", "available", "head", "branch", "status", "entries", "truncated", "worktreeFingerprint", "fileCount", "requiredPathEvidence"]) &&
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
      validRequiredPathEvidence(source.requiredPathEvidence) &&
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
  const sessionDirectory = assertPathInsideWorkspace(
    workspace.rendersPath,
    join(workspace.rendersPath, metadata.sessionId),
  );
  await validateFixedDirectory(
    workspace.rendersPath,
    sessionDirectory,
    "Render session directory",
  );
  await validateFixedDirectory(
    sessionDirectory,
    artifactDirectory,
    "Render round directory",
  );

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
  const integrityPath = assertPathInsideWorkspace(
    workspace.rendersPath,
    renderIntegrityPath(artifactPath),
  );

  const persistedMetadata = {
    ...metadata,
    imagePath: artifactPath,
  };
  const metadataContents = stableJson(persistedMetadata);
  const integrityContents = stableJson(renderIntegrityFor(persistedMetadata, bytes));
  if (Buffer.byteLength(metadataContents, "utf8") > MAX_RECORD_BYTES) {
    throw new Error("Render artifact metadata is too large; maximum size is 1 MiB");
  }

  let artifactOwnership: { dev: number; ino: number } | undefined;
  let metadataOwnership: { dev: number; ino: number } | undefined;
  let integrityOwnership: { dev: number; ino: number } | undefined;
  try {
    artifactOwnership = await atomicCreate(workspace.rendersPath, artifactPath, bytes);
    metadataOwnership = await atomicCreate(workspace.rendersPath, metadataPath, metadataContents);
    integrityOwnership = await atomicCreate(workspace.rendersPath, integrityPath, integrityContents);
  } catch (error) {
    if (integrityOwnership !== undefined) {
      await unlinkCreatedFileIfOwned(integrityPath, integrityOwnership).catch(() => undefined);
    }
    if (metadataOwnership !== undefined) {
      await unlinkCreatedFileIfOwned(metadataPath, metadataOwnership).catch(() => undefined);
    }
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
