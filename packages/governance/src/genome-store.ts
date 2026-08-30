import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  rename,
  unlink,
} from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import type {
  DesignDecision,
  DesignGenome,
  ScreenRecord,
} from "@design-sharingan/core";
import { assertPathInsideWorkspace } from "@design-sharingan/project-adapters";
import {
  GOVERNANCE_SCHEMA_VERSION,
  assertDesignDecisions,
  assertGenome,
  assertScreenRecords,
  parseGovernanceMetadata,
  renderDesignDecisions,
  renderGenome,
  renderScreenRegistry,
  type DesignDecisionsMetadata,
  type GenomeMetadata,
  type GovernanceMetadata,
  type ScreenRegistryMetadata,
} from "./templates";

export const GOVERNANCE_DIRECTORY = "design-governance";
export const DESIGN_GENOME_FILE = "DESIGN-GENOME.md";
export const SCREEN_REGISTRY_FILE = "SCREEN-REGISTRY.md";
export const DESIGN_DECISIONS_FILE = "DESIGN-DECISIONS.md";
const LOCK_FILE = ".governance.lock";
const MAX_DOCUMENT_BYTES = 256 * 1024;
const MAX_LOCK_ATTEMPTS = 100;

export class GovernanceNotInitializedError extends Error {
  constructor() {
    super("Governance has not been initialized");
    this.name = "GovernanceNotInitializedError";
  }
}

export interface GenomeDocument {
  metadata: Omit<GenomeMetadata, "value">;
  value: DesignGenome;
}

export interface InitializeGovernanceInput {
  rootPath: string;
  projectId: string;
  genome: DesignGenome;
  screens: ScreenRecord[];
  decisions: DesignDecision[];
}

export interface InitializedGovernance {
  genome: GenomeDocument;
  screens: { metadata: Omit<ScreenRegistryMetadata, "records">; records: ScreenRecord[] };
  decisions: {
    metadata: Omit<DesignDecisionsMetadata, "decisions">;
    decisions: DesignDecision[];
  };
}

export interface ApproveGenomeInput {
  approvedBy: "local-user";
  expectedRevision: number;
}

function safeProjectId(projectId: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(projectId)) {
    throw new Error("Governance project identity is invalid");
  }
  return projectId;
}

async function entryExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

export async function governanceDirectory(
  rootPath: string,
  create: boolean,
): Promise<string> {
  const requestedRoot = resolve(rootPath);
  const canonicalRoot = assertPathInsideWorkspace(rootPath, rootPath);
  const rootEntry = await lstat(requestedRoot);
  if (
    rootEntry.isSymbolicLink() ||
    !rootEntry.isDirectory() ||
    canonicalRoot !== requestedRoot
  ) {
    throw new Error("Governance requires a canonical project root");
  }
  const directory = join(canonicalRoot, GOVERNANCE_DIRECTORY);
  if (!(await entryExists(directory))) {
    if (!create) throw new GovernanceNotInitializedError();
    try {
      await mkdir(directory, { mode: 0o700 });
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) {
        throw error;
      }
    }
  }
  const entry = await lstat(directory);
  if (entry.isSymbolicLink()) {
    throw new Error("Governance directory must not be a symbolic link");
  }
  if (!entry.isDirectory()) {
    throw new Error("Governance directory must be a real directory");
  }
  return assertPathInsideWorkspace(canonicalRoot, directory);
}

export async function governanceIsInitialized(rootPath: string): Promise<boolean> {
  let directory: string;
  try {
    directory = await governanceDirectory(rootPath, false);
  } catch (error) {
    if (error instanceof GovernanceNotInitializedError) return false;
    throw error;
  }
  const paths = [DESIGN_GENOME_FILE, SCREEN_REGISTRY_FILE, DESIGN_DECISIONS_FILE].map(
    (fileName) => join(/* turbopackIgnore: true */ directory, fileName),
  );
  const existing = await Promise.all(paths.map(entryExists));
  if (existing.every((value) => !value)) return false;
  if (existing.some((value) => !value)) {
    throw new Error("Governance initialization is incomplete");
  }
  await Promise.all(paths.map(assertRegularDocument));
  return true;
}

async function assertRegularDocument(path: string): Promise<Awaited<ReturnType<typeof lstat>>> {
  const entry = await lstat(path);
  if (entry.isSymbolicLink()) {
    throw new Error("Governance document must not be a symbolic link");
  }
  if (!entry.isFile()) {
    throw new Error("Governance document must be a regular file");
  }
  if (entry.nlink !== 1) {
    throw new Error("Governance document must not be a hard link");
  }
  if (entry.size > MAX_DOCUMENT_BYTES) {
    throw new Error("Governance document exceeds the 256 KiB limit");
  }
  return entry;
}

function assertOpenDocument(
  entry: Awaited<ReturnType<Awaited<ReturnType<typeof open>>["stat"]>>,
): void {
  if (!entry.isFile() || entry.nlink !== 1) {
    throw new Error("Governance document handle is not a private regular file");
  }
  if (entry.size > MAX_DOCUMENT_BYTES) {
    throw new Error("Governance document exceeds the 256 KiB limit");
  }
}

async function readBoundedDocument(path: string): Promise<string> {
  const pathEntry = await assertRegularDocument(path);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const handleEntry = await handle.stat();
    assertOpenDocument(handleEntry);
    if (handleEntry.dev !== pathEntry.dev || handleEntry.ino !== pathEntry.ino) {
      throw new Error("Governance document changed while it was opened");
    }
    const buffer = Buffer.alloc(MAX_DOCUMENT_BYTES + 1);
    let total = 0;
    while (total < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        total,
        buffer.length - total,
        total,
      );
      if (bytesRead === 0) break;
      total += bytesRead;
    }
    if (total > MAX_DOCUMENT_BYTES) {
      throw new Error("Governance document exceeds the 256 KiB limit");
    }
    const current = await assertRegularDocument(path);
    if (current.dev !== handleEntry.dev || current.ino !== handleEntry.ino) {
      throw new Error("Governance document changed while it was read");
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(
      buffer.subarray(0, total),
    );
  } finally {
    await handle.close();
  }
}

export async function readGovernanceDocument(
  rootPath: string,
  projectId: string,
  fileName: string,
): Promise<GovernanceMetadata> {
  safeProjectId(projectId);
  const directory = await governanceDirectory(rootPath, false);
  const path = assertPathInsideWorkspace(directory, join(directory, fileName));
  const metadata = parseGovernanceMetadata(await readBoundedDocument(path));
  if (metadata.projectId !== projectId) {
    throw new Error("Governance project identity does not match the active project");
  }
  return metadata;
}

async function atomicWriteDocument(
  directory: string,
  fileName: string,
  markdown: string,
): Promise<void> {
  const byteLength = Buffer.byteLength(markdown, "utf8");
  if (byteLength > MAX_DOCUMENT_BYTES) {
    throw new Error("Governance document exceeds the 256 KiB limit");
  }
  const destination = assertPathInsideWorkspace(directory, join(directory, fileName));
  if (await entryExists(destination)) await assertRegularDocument(destination);
  const temporary = assertPathInsideWorkspace(
    directory,
    join(directory, `.${basename(fileName)}.tmp-${process.pid}-${randomUUID()}`),
  );
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    await handle.writeFile(markdown, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, destination);
  } catch (error) {
    if (handle !== undefined) await handle.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function withGovernanceLock<T>(
  rootPath: string,
  operation: (directory: string) => Promise<T>,
): Promise<T> {
  const directory = await governanceDirectory(rootPath, true);
  const lockPath = assertPathInsideWorkspace(directory, join(directory, LOCK_FILE));
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  for (let attempt = 0; attempt < MAX_LOCK_ATTEMPTS; attempt += 1) {
    try {
      handle = await open(
        lockPath,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
        0o600,
      );
      break;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) {
        throw error;
      }
      const entry = await lstat(lockPath);
      if (entry.isSymbolicLink() || !entry.isFile() || entry.nlink !== 1) {
        throw new Error("Governance lock is unsafe");
      }
      await delay(10);
    }
  }
  if (handle === undefined) {
    throw new Error("Governance is busy; refusing an unsynchronized write");
  }
  const ownership = await handle.stat();
  let result: T | undefined;
  let operationError: unknown;
  try {
    result = await operation(directory);
  } catch (error) {
    operationError = error;
  }
  await handle.close().catch(() => undefined);
  const current = await lstat(lockPath).catch(() => undefined);
  if (
    current === undefined ||
    current.dev !== ownership.dev ||
    current.ino !== ownership.ino ||
    current.nlink !== 1 ||
    !current.isFile() ||
    current.isSymbolicLink()
  ) {
    throw new Error("Governance lock ownership changed during the operation");
  }
  await unlink(lockPath);
  if (operationError !== undefined) {
    throw operationError;
  }
  return result as T;
}

function genomeDocument(metadata: GenomeMetadata): GenomeDocument {
  const { value, ...identity } = metadata;
  return { metadata: identity, value };
}

export async function initializeGovernance(
  input: InitializeGovernanceInput,
): Promise<InitializedGovernance> {
  const projectId = safeProjectId(input.projectId);
  const genome = assertGenome(input.genome);
  if (genome.status !== "DRAFT") {
    throw new Error("A newly initialized Design Genome must start DRAFT");
  }
  const screens = assertScreenRecords(input.screens);
  const decisions = assertDesignDecisions(input.decisions);
  return withGovernanceLock(input.rootPath, async (directory) => {
    const fileNames = [DESIGN_GENOME_FILE, SCREEN_REGISTRY_FILE, DESIGN_DECISIONS_FILE];
    if (
      (
        await Promise.all(
          fileNames.map((file) =>
            entryExists(join(/* turbopackIgnore: true */ directory, file)),
          ),
        )
      ).some(Boolean)
    ) {
      throw new Error("Governance is already initialized");
    }
    const genomeMetadata: GenomeMetadata = {
      schemaVersion: GOVERNANCE_SCHEMA_VERSION,
      kind: "DESIGN_GENOME",
      projectId,
      entityId: randomUUID(),
      revision: 1,
      status: "DRAFT",
      value: genome,
    };
    const screensMetadata: ScreenRegistryMetadata = {
      schemaVersion: GOVERNANCE_SCHEMA_VERSION,
      kind: "SCREEN_REGISTRY",
      projectId,
      entityId: randomUUID(),
      revision: 1,
      records: screens,
    };
    const decisionsMetadata: DesignDecisionsMetadata = {
      schemaVersion: GOVERNANCE_SCHEMA_VERSION,
      kind: "DESIGN_DECISIONS",
      projectId,
      entityId: randomUUID(),
      revision: 1,
      decisions,
    };
    await atomicWriteDocument(directory, DESIGN_GENOME_FILE, renderGenome(genomeMetadata));
    await atomicWriteDocument(
      directory,
      SCREEN_REGISTRY_FILE,
      renderScreenRegistry(screensMetadata),
    );
    await atomicWriteDocument(
      directory,
      DESIGN_DECISIONS_FILE,
      renderDesignDecisions(decisionsMetadata),
    );
    return {
      genome: genomeDocument(genomeMetadata),
      screens: {
        metadata: {
          schemaVersion: screensMetadata.schemaVersion,
          kind: screensMetadata.kind,
          projectId: screensMetadata.projectId,
          entityId: screensMetadata.entityId,
          revision: screensMetadata.revision,
        },
        records: screensMetadata.records,
      },
      decisions: {
        metadata: {
          schemaVersion: decisionsMetadata.schemaVersion,
          kind: decisionsMetadata.kind,
          projectId: decisionsMetadata.projectId,
          entityId: decisionsMetadata.entityId,
          revision: decisionsMetadata.revision,
        },
        decisions: decisionsMetadata.decisions,
      },
    };
  });
}

export async function readGenome(
  rootPath: string,
  projectId: string,
): Promise<GenomeDocument> {
  const metadata = await readGovernanceDocument(
    rootPath,
    projectId,
    DESIGN_GENOME_FILE,
  );
  if (metadata.kind !== "DESIGN_GENOME") {
    throw new Error("DESIGN-GENOME.md contains the wrong governance document kind");
  }
  return genomeDocument(metadata);
}

export async function approveGenome(
  rootPath: string,
  projectId: string,
  input: ApproveGenomeInput,
): Promise<GenomeDocument> {
  safeProjectId(projectId);
  if (input.approvedBy !== "local-user") {
    throw new Error("Genome approval requires an explicit local-user decision");
  }
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) {
    throw new Error("Expected Genome revision is invalid");
  }
  return withGovernanceLock(rootPath, async (directory) => {
    const current = await readGenome(rootPath, projectId);
    if (current.metadata.revision !== input.expectedRevision) {
      throw new Error("Genome approval revision is stale");
    }
    if (current.value.status !== "DRAFT") {
      throw new Error("Only a DRAFT Genome can be approved");
    }
    const approvedAt = new Date().toISOString();
    const value: DesignGenome = { ...current.value, status: "APPROVED" };
    const metadata: GenomeMetadata = {
      ...current.metadata,
      revision: current.metadata.revision + 1,
      status: "APPROVED",
      approvedBy: "local-user",
      approvedAt,
      value,
    };
    await atomicWriteDocument(directory, DESIGN_GENOME_FILE, renderGenome(metadata));
    return genomeDocument(metadata);
  });
}

export { atomicWriteDocument, safeProjectId };
