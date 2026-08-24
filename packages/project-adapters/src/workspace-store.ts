import {
  lstat,
  mkdir,
  open,
  rename,
  unlink,
} from "node:fs/promises";
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

function workspacePaths(rootPath: string): DesignWorkspace {
  const canonicalRoot = assertPathInsideWorkspace(rootPath, rootPath);
  const machinePath = assertPathInsideWorkspace(
    canonicalRoot,
    join(canonicalRoot, MACHINE_DIRECTORY),
  );

  return {
    rootPath: canonicalRoot,
    machinePath,
    projectMetadataPath: assertPathInsideWorkspace(
      canonicalRoot,
      join(machinePath, "project.json"),
    ),
    referencesPath: assertPathInsideWorkspace(
      canonicalRoot,
      join(machinePath, "references"),
    ),
    sessionsPath: assertPathInsideWorkspace(
      canonicalRoot,
      join(machinePath, "sessions"),
    ),
    rendersPath: assertPathInsideWorkspace(
      canonicalRoot,
      join(machinePath, "renders"),
    ),
    cachePath: assertPathInsideWorkspace(
      canonicalRoot,
      join(machinePath, "cache"),
    ),
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

export async function ensureDesignWorkspace(
  rootPath: string,
): Promise<DesignWorkspace> {
  const workspace = workspacePaths(rootPath);

  for (const directory of [
    workspace.machinePath,
    workspace.referencesPath,
    workspace.sessionsPath,
    workspace.rendersPath,
    workspace.cachePath,
  ]) {
    const safeDirectory = assertPathInsideWorkspace(workspace.rootPath, directory);
    await mkdir(safeDirectory, { recursive: true });
  }

  if (!(await pathExists(workspace.projectMetadataPath))) {
    await atomicWriteJson(
      workspace.machinePath,
      workspace.projectMetadataPath,
      {},
    );
  } else if (!(await lstat(workspace.projectMetadataPath)).isFile()) {
    throw new Error("Workspace project metadata must be a regular file");
  }

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
  const workspace = await ensureDesignWorkspace(rootPath);
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
  const workspace = await ensureDesignWorkspace(rootPath);
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
