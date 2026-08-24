import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  unlink,
} from "node:fs/promises";
import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, extname, join } from "node:path";
import type {
  DesignSession,
  Project,
  Reference,
  RenderArtifact,
} from "@design-sharingan/core";
import { assertPathInsideWorkspace } from "./path-policy";

const MACHINE_DIRECTORY = ".design-sharingan";

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

function extensionForReference(reference: Reference): string {
  switch (reference.type.toLowerCase()) {
    case "image/png":
      return ".png";
    case "image/jpeg":
      return ".jpg";
    case "image/webp":
      return ".webp";
    case "image/gif":
      return ".gif";
    default:
      return ".bin";
  }
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
  const referencePath = assertPathInsideWorkspace(
    workspace.referencesPath,
    join(workspace.referencesPath, reference.id),
  );
  await mkdir(referencePath, { recursive: true });

  const artifactPath = assertPathInsideWorkspace(
    referencePath,
    join(referencePath, `artifact${extensionForReference(reference)}`),
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
