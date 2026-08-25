import {
  lstat,
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
import { basename, dirname, extname, join } from "node:path";
import type {
  DesignDNA,
  DesignSession,
  LearnSessionStatus,
  Project,
  Reference,
  RenderArtifact,
} from "@design-sharingan/core";
import { canTransitionLearnSession } from "@design-sharingan/core";
import { assertPathInsideWorkspace } from "./path-policy";

const MACHINE_DIRECTORY = ".design-sharingan";
const MAX_REFERENCE_BYTES = 10 * 1024 * 1024;
const MAX_RECORD_BYTES = 1024 * 1024;

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
  await atomicWriteJson(workspace.sessionsPath, sessionPath, session);
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
  if (stableJson(session.designDNA) !== finalDesignDNAContents) {
    throw new Error("Reference scan checkpoint evidence does not match");
  }
  const [existingReference, existingSession] = await Promise.all([
    loadReference(rootPath, reference.projectId, reference.id),
    loadSession(rootPath, session.projectId, session.id),
  ]);
  if (
    existingReference.projectId !== session.projectId ||
    session.referenceId !== reference.id ||
    session.referenceTitle !== reference.title ||
    existingSession.type !== "REFERENCE_SCAN" ||
    existingSession.status !== "ANALYZING" ||
    existingSession.createdAt !== session.createdAt ||
    !canTransitionLearnSession("ANALYZING", session.status) ||
    reference.analysisStatus !== "ANALYZED" ||
    reference.imagePath !== existingReference.imagePath ||
    reference.type !== existingReference.type ||
    reference.source !== existingReference.source ||
    reference.createdAt !== existingReference.createdAt ||
    !designDNA.referenceIds.includes(reference.id)
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
  const workspace = await ensureDesignWorkspace(rootPath);
  const artifactPath = assertPathInsideWorkspace(
    workspace.rendersPath,
    metadata.imagePath,
  );
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

  await atomicWrite(workspace.rendersPath, artifactPath, bytes);
  await atomicWriteJson(workspace.rendersPath, metadataPath, {
    ...metadata,
    imagePath: artifactPath,
  });

  return { artifactPath, metadataPath };
}
