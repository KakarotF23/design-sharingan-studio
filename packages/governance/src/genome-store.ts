import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  rm,
  rmdir,
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
  genomePayloadHash,
  type DesignDecisionsMetadata,
  type DecisionApprovalProof,
  type GenomeAuthorityProof,
  type GenomeMetadata,
  type GovernanceMetadata,
  type ScreenRegistryMetadata,
} from "./templates";

export const GOVERNANCE_DIRECTORY = "design-governance";
export const DESIGN_GENOME_FILE = "DESIGN-GENOME.md";
export const SCREEN_REGISTRY_FILE = "SCREEN-REGISTRY.md";
export const DESIGN_DECISIONS_FILE = "DESIGN-DECISIONS.md";
const LOCK_FILE = "governance.lock";
const MAX_DOCUMENT_BYTES = 256 * 1024;
const MAX_LOCK_ATTEMPTS = 100;
const LOCK_STALE_MILLISECONDS = 30_000;
const STAGING_DIRECTORY = "governance-staging";

export class GovernanceNotInitializedError extends Error {
  constructor() {
    super("Governance has not been initialized");
    this.name = "GovernanceNotInitializedError";
  }
}

export interface GenomeDocument {
  metadata: Omit<GenomeMetadata, "value">;
  value: DesignGenome;
  payloadHash: string;
  authority: "AUTHORITATIVE" | "NON_AUTHORITATIVE";
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
  expectedPayloadHash: string;
}

const authenticatedGenomeDocuments = new WeakMap<GenomeDocument, string>();
const MACHINE_STATE_DIRECTORY = ".design-sharingan";
const AUTHORITY_KEY_FILE = "governance-authority.key";

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

async function canonicalProjectRoot(rootPath: string): Promise<string> {
  const requestedRoot = resolve(rootPath);
  const canonicalRoot = assertPathInsideWorkspace(rootPath, rootPath);
  const rootEntry = await lstat(requestedRoot);
  if (rootEntry.isSymbolicLink() || !rootEntry.isDirectory() || canonicalRoot !== requestedRoot) {
    throw new Error("Governance requires a canonical project root");
  }
  return canonicalRoot;
}

export async function governanceDirectory(
  rootPath: string,
  create: boolean,
): Promise<string> {
  const canonicalRoot = await canonicalProjectRoot(rootPath);
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

function rootFingerprint(canonicalRoot: string): string {
  return createHash("sha256")
    .update(`design-sharingan-root-v1\0${canonicalRoot}`, "utf8")
    .digest("hex");
}

async function machineStateDirectory(rootPath: string, create: boolean): Promise<string> {
  const root = await canonicalProjectRoot(rootPath);
  const directory = assertPathInsideWorkspace(root, join(root, MACHINE_STATE_DIRECTORY));
  if (!(await entryExists(directory))) {
    if (!create) throw new Error("Genome authority machine state is missing");
    await mkdir(directory, { mode: 0o700 });
  }
  const entry = await lstat(directory);
  if (entry.isSymbolicLink() || !entry.isDirectory()) {
    throw new Error("Genome authority machine state directory is unsafe");
  }
  return directory;
}

async function authorityKey(rootPath: string, create: boolean): Promise<Buffer> {
  const directory = await machineStateDirectory(rootPath, create);
  const directoryIdentity = await lstat(directory);
  const keyPath = assertPathInsideWorkspace(directory, join(directory, AUTHORITY_KEY_FILE));
  if (!(await entryExists(keyPath))) {
    if (!create) throw new Error("Genome authority key is missing");
    const temporaryKeyPath = assertPathInsideWorkspace(
      directory,
      join(directory, `.${AUTHORITY_KEY_FILE}.tmp-${process.pid}-${randomUUID()}`),
    );
    const handle = await open(
      temporaryKeyPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    const ownership = await handle.stat();
    try {
      await handle.writeFile(randomBytes(32));
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      const current = await assertRegularDocument(temporaryKeyPath);
      if (current.dev !== ownership.dev || current.ino !== ownership.ino || current.size !== 32) {
        throw new Error("Genome authority key staging identity changed");
      }
      const currentDirectory = await lstat(directory);
      if (
        currentDirectory.dev !== directoryIdentity.dev ||
        currentDirectory.ino !== directoryIdentity.ino ||
        currentDirectory.isSymbolicLink() || !currentDirectory.isDirectory()
      ) throw new Error("Genome authority directory identity changed before promotion");
      if (await entryExists(keyPath)) throw new Error("Genome authority key appeared concurrently");
      await rename(temporaryKeyPath, keyPath);
      await syncDirectory(directory);
    } catch (error) {
      const current = await lstat(temporaryKeyPath).catch(() => undefined);
      if (current !== undefined && current.dev === ownership.dev && current.ino === ownership.ino) {
        await unlink(temporaryKeyPath).catch(() => undefined);
      }
      throw error;
    }
  }
  const pathEntry = await assertRegularDocument(keyPath);
  if (pathEntry.size !== 32) throw new Error("Genome authority key is invalid");
  const handle = await open(keyPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    if (
      opened.dev !== pathEntry.dev || opened.ino !== pathEntry.ino ||
      !opened.isFile() || opened.nlink !== 1 || opened.size !== 32
    ) throw new Error("Genome authority key changed while it was opened");
    const key = await handle.readFile();
    const current = await assertRegularDocument(keyPath);
    if (current.dev !== opened.dev || current.ino !== opened.ino) {
      throw new Error("Genome authority key changed while it was read");
    }
    return key;
  } finally {
    await handle.close();
  }
}

function authorityPayload(proof: Omit<GenomeAuthorityProof, "signature">): string {
  return JSON.stringify(proof);
}

function authoritySignature(
  key: Buffer,
  proof: Omit<GenomeAuthorityProof, "signature">,
): string {
  return createHmac("sha256", key).update(authorityPayload(proof), "utf8").digest("hex");
}

async function verifyAuthority(
  rootPath: string,
  metadata: GenomeMetadata,
): Promise<boolean> {
  const proof = metadata.authority;
  if (metadata.value.status !== "APPROVED" || proof === undefined) return false;
  const canonicalRoot = await canonicalProjectRoot(rootPath);
  if (
    proof.projectId !== metadata.projectId ||
    proof.rootFingerprint !== rootFingerprint(canonicalRoot) ||
    proof.genomeEntityId !== metadata.entityId ||
    proof.genomeVersion !== metadata.value.version ||
    proof.approvedDraftRevision + 1 !== metadata.revision ||
    proof.documentRevision !== metadata.revision ||
    proof.payloadHash !== genomePayloadHash(metadata.value) ||
    proof.approvedBy !== "local-user" ||
    new Date(proof.approvedAt).toISOString() !== proof.approvedAt
  ) return false;
  const key = await authorityKey(rootPath, false);
  const { signature, ...unsigned } = proof;
  const expected = Buffer.from(authoritySignature(key, unsigned), "hex");
  const actual = Buffer.from(signature, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function decisionAuthoritySignature(
  key: Buffer,
  proof: Omit<DecisionApprovalProof, "signature">,
): string {
  return createHmac("sha256", key)
    .update(JSON.stringify(proof), "utf8")
    .digest("hex");
}

export async function assertAuthenticatedDecisionProofs(
  rootPath: string,
  metadata: DesignDecisionsMetadata,
): Promise<void> {
  if (metadata.approvalProofs.length === 0) return;
  const canonicalRoot = await canonicalProjectRoot(rootPath);
  const key = await authorityKey(rootPath, false);
  for (const proof of metadata.approvalProofs) {
    const { signature, ...unsigned } = proof;
    const expected = Buffer.from(decisionAuthoritySignature(key, unsigned), "hex");
    const actual = Buffer.from(signature, "hex");
    if (
      proof.projectId !== metadata.projectId ||
      proof.rootFingerprint !== rootFingerprint(canonicalRoot) ||
      proof.genomeEntityId !== metadata.genomeEntityId ||
      actual.length !== expected.length || !timingSafeEqual(actual, expected)
    ) throw new Error("Design Decision local-user authority proof is not authenticated");
  }
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
  await withMachineGovernanceLock(rootPath, async () => undefined);
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
  const directoryIdentity = await lstat(directory);
  if (directoryIdentity.isSymbolicLink() || !directoryIdentity.isDirectory()) {
    throw new Error("Governance write directory is unsafe");
  }
  const byteLength = Buffer.byteLength(markdown, "utf8");
  if (byteLength > MAX_DOCUMENT_BYTES) {
    throw new Error("Governance document exceeds the 256 KiB limit");
  }
  const destination = assertPathInsideWorkspace(directory, join(directory, fileName));
  const destinationIdentity = await entryExists(destination)
    ? await assertRegularDocument(destination)
    : undefined;
  const temporary = assertPathInsideWorkspace(
    directory,
    join(directory, `.${basename(fileName)}.tmp-${process.pid}-${randomUUID()}`),
  );
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let temporaryOwnership: { dev: number; ino: number } | undefined;
  try {
    handle = await open(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    const openedTemporary = await handle.stat();
    temporaryOwnership = { dev: openedTemporary.dev, ino: openedTemporary.ino };
    await handle.writeFile(markdown, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    const currentDirectory = await lstat(directory);
    if (
      currentDirectory.dev !== directoryIdentity.dev ||
      currentDirectory.ino !== directoryIdentity.ino ||
      currentDirectory.isSymbolicLink() || !currentDirectory.isDirectory()
    ) throw new Error("Governance write directory identity changed before promotion");
    if (destinationIdentity !== undefined) {
      const currentDestination = await assertRegularDocument(destination);
      if (
        currentDestination.dev !== destinationIdentity.dev ||
        currentDestination.ino !== destinationIdentity.ino
      ) throw new Error("Governance destination identity changed before promotion");
    } else if (await entryExists(destination)) {
      throw new Error("Governance destination appeared before promotion");
    }
    await assertRegularDocument(temporary);
    await rename(temporary, destination);
    await syncDirectory(directory);
  } catch (error) {
    if (handle !== undefined) await handle.close().catch(() => undefined);
    const currentTemporary = await lstat(temporary).catch(() => undefined);
    if (
      currentTemporary !== undefined && temporaryOwnership !== undefined &&
      currentTemporary.dev === temporaryOwnership.dev &&
      currentTemporary.ino === temporaryOwnership.ino
    ) await unlink(temporary).catch(() => undefined);
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
  return withMachineGovernanceLock(rootPath, async () => {
    const directory = await governanceDirectory(rootPath, false);
    return operation(directory);
  });
}

interface LockClaim {
  kind: "DESIGN_SHARINGAN_GOVERNANCE_LOCK";
  owner: string;
  pid: number;
  createdAt: string;
}

function processIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}

async function readLockClaim(lockPath: string): Promise<LockClaim | undefined> {
  const entry = await lstat(lockPath);
  if (entry.isSymbolicLink() || !entry.isFile() || entry.nlink !== 1 || entry.size > 1_024) {
    throw new Error("Governance lock is unsafe");
  }
  if (entry.size === 0) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(await readBoundedDocument(lockPath));
  } catch {
    throw new Error("Governance lock claim is malformed");
  }
  if (
    value === null || typeof value !== "object" || Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== "createdAt,kind,owner,pid" ||
    (value as LockClaim).kind !== "DESIGN_SHARINGAN_GOVERNANCE_LOCK" ||
    !/^[a-f0-9-]{36}$/.test((value as LockClaim).owner) ||
    !Number.isSafeInteger((value as LockClaim).pid) ||
    new Date((value as LockClaim).createdAt).toISOString() !== (value as LockClaim).createdAt
  ) throw new Error("Governance lock claim is malformed");
  return value as LockClaim;
}

async function withMachineGovernanceLock<T>(
  rootPath: string,
  operation: (machineDirectory: string) => Promise<T>,
): Promise<T> {
  const directory = await machineStateDirectory(rootPath, true);
  const lockPath = assertPathInsideWorkspace(directory, join(directory, LOCK_FILE));
  const claim: LockClaim = {
    kind: "DESIGN_SHARINGAN_GOVERNANCE_LOCK",
    owner: randomUUID(),
    pid: process.pid,
    createdAt: new Date().toISOString(),
  };
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  for (let attempt = 0; attempt < MAX_LOCK_ATTEMPTS; attempt += 1) {
    try {
      handle = await open(
        lockPath,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
        0o600,
      );
      await handle.writeFile(JSON.stringify(claim), "utf8");
      await handle.sync();
      break;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) {
        throw error;
      }
      const entry = await lstat(lockPath);
      const existing = await readLockClaim(lockPath);
      const age = existing === undefined
        ? Date.now() - entry.mtimeMs
        : Date.now() - Date.parse(existing.createdAt);
      if (
        age > LOCK_STALE_MILLISECONDS &&
        existing !== undefined &&
        !processIsAlive(existing.pid)
      ) {
        const current = await lstat(lockPath);
        if (current.dev === entry.dev && current.ino === entry.ino && current.nlink === 1) {
          await unlink(lockPath);
          continue;
        }
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
    await reconcileOwnedStaging(directory);
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

async function reconcileOwnedStaging(machineDirectory: string): Promise<void> {
  const staging = assertPathInsideWorkspace(
    machineDirectory,
    join(machineDirectory, STAGING_DIRECTORY),
  );
  if (!(await entryExists(staging))) return;
  const stagingEntry = await lstat(staging);
  if (stagingEntry.isSymbolicLink() || !stagingEntry.isDirectory()) {
    throw new Error("Governance staging root is unsafe");
  }
  const entries = await readdir(staging, { withFileTypes: true });
  if (entries.length > 32) throw new Error("Governance staging residue exceeds the recovery bound");
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^[a-f0-9-]{36}$/.test(entry.name)) continue;
    const ownerDirectory = assertPathInsideWorkspace(staging, join(staging, entry.name));
    const ownerIdentity = await lstat(ownerDirectory);
    if (ownerIdentity.isSymbolicLink() || !ownerIdentity.isDirectory()) continue;
    const manifestPath = join(ownerDirectory, "manifest.json");
    if (!(await entryExists(manifestPath))) continue;
    let manifest: Record<string, unknown>;
    try {
      const manifestEntry = await assertRegularDocument(manifestPath);
      if (manifestEntry.size > 4_096) continue;
      const parsed = JSON.parse(await readBoundedDocument(manifestPath));
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      manifest = parsed as Record<string, unknown>;
    } catch {
      continue;
    }
    const expectedFiles = [DESIGN_GENOME_FILE, SCREEN_REGISTRY_FILE, DESIGN_DECISIONS_FILE];
    const exact = Object.keys(manifest).sort().join(",") === "createdAt,files,kind,owner,pid,projectId";
    const createdAt = typeof manifest.createdAt === "string" ? manifest.createdAt : "";
    const files = manifest.files;
    if (
      !exact || manifest.kind !== "DESIGN_SHARINGAN_GOVERNANCE_INIT" ||
      manifest.owner !== entry.name || !Number.isSafeInteger(manifest.pid) ||
      typeof manifest.projectId !== "string" ||
      !Array.isArray(files) || files.length !== expectedFiles.length ||
      files.some((file, index) => file !== expectedFiles[index])
    ) continue;
    let age: number;
    try {
      if (new Date(createdAt).toISOString() !== createdAt) continue;
      age = Date.now() - Date.parse(createdAt);
    } catch {
      continue;
    }
    if (age <= LOCK_STALE_MILLISECONDS || processIsAlive(manifest.pid as number)) continue;
    const current = await lstat(ownerDirectory);
    if (current.dev !== ownerIdentity.dev || current.ino !== ownerIdentity.ino || current.isSymbolicLink()) {
      continue;
    }
    await rm(ownerDirectory, { recursive: true, force: false });
  }
}

function genomeDocument(metadata: GenomeMetadata, authenticated = false): GenomeDocument {
  const { value, ...identity } = metadata;
  const document: GenomeDocument = {
    metadata: identity,
    value,
    payloadHash: genomePayloadHash(value),
    authority: authenticated ? "AUTHORITATIVE" : "NON_AUTHORITATIVE",
  };
  if (authenticated) authenticatedGenomeDocuments.set(document, authenticatedDocumentDigest(document));
  return document;
}

function authenticatedDocumentDigest(document: GenomeDocument): string {
  return createHash("sha256").update(JSON.stringify({
    metadata: document.metadata,
    value: document.value,
    payloadHash: document.payloadHash,
    authority: document.authority,
  }), "utf8").digest("hex");
}

export function isAuthenticatedGenomeDocument(
  value: DesignGenome | GenomeDocument,
): value is GenomeDocument {
  return (
    typeof value === "object" && value !== null &&
    authenticatedGenomeDocuments.get(value as GenomeDocument) ===
      authenticatedDocumentDigest(value as GenomeDocument) &&
    (value as GenomeDocument).authority === "AUTHORITATIVE" &&
    (value as GenomeDocument).value.status === "APPROVED" &&
    (value as GenomeDocument).payloadHash === genomePayloadHash((value as GenomeDocument).value) &&
    (value as GenomeDocument).metadata.authority?.payloadHash === (value as GenomeDocument).payloadHash
  );
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    await handle.sync();
  } catch (error) {
    if (!(error instanceof Error && "code" in error && ["EINVAL", "ENOTSUP", "EBADF"].includes(error.code as string))) {
      throw error;
    }
  } finally {
    await handle.close();
  }
}

function assertRenderedDocument(markdown: string, expectedKind: GovernanceMetadata["kind"]): void {
  if (Buffer.byteLength(markdown, "utf8") > MAX_DOCUMENT_BYTES) {
    throw new Error("Governance document exceeds the 256 KiB limit");
  }
  const parsed = parseGovernanceMetadata(markdown);
  if (parsed.kind !== expectedKind) throw new Error("Governance pre-render kind is invalid");
}

async function ensurePrivateDirectory(parent: string, name: string): Promise<string> {
  const path = assertPathInsideWorkspace(parent, join(parent, name));
  if (!(await entryExists(path))) await mkdir(path, { mode: 0o700 });
  const entry = await lstat(path);
  if (entry.isSymbolicLink() || !entry.isDirectory()) {
    throw new Error("Governance staging directory is unsafe");
  }
  return path;
}

export async function initializeGovernance(
  input: InitializeGovernanceInput,
): Promise<InitializedGovernance> {
  const projectId = safeProjectId(input.projectId);
  const genome = assertGenome(input.genome);
  if (genome.status !== "DRAFT") {
    throw new Error("A newly initialized Design Genome must start DRAFT");
  }
  const evidenceIds = [...new Set(input.screens.flatMap((screen) => screen.evidence))];
  const screens = assertScreenRecords(input.screens, { genome, evidenceIds });
  const decisions = assertDesignDecisions(input.decisions);
  const canonicalRoot = await canonicalProjectRoot(input.rootPath);
  const rootIdentity = await lstat(canonicalRoot);
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
    genomeEntityId: genomeMetadata.entityId,
    genomeVersion: genome.version,
    genomeRevision: genomeMetadata.revision,
    evidenceIds,
    records: screens,
  };
  const decisionsMetadata: DesignDecisionsMetadata = {
    schemaVersion: GOVERNANCE_SCHEMA_VERSION,
    kind: "DESIGN_DECISIONS",
    projectId,
    entityId: randomUUID(),
    revision: 1,
    genomeEntityId: genomeMetadata.entityId,
    genomeVersion: genome.version,
    genomeRevision: genomeMetadata.revision,
    approvalProofs: [],
    decisions,
  };
  const documents = [
    [DESIGN_GENOME_FILE, renderGenome(genomeMetadata), "DESIGN_GENOME"],
    [SCREEN_REGISTRY_FILE, renderScreenRegistry(screensMetadata), "SCREEN_REGISTRY"],
    [DESIGN_DECISIONS_FILE, renderDesignDecisions(decisionsMetadata), "DESIGN_DECISIONS"],
  ] as const;
  for (const [, markdown, kind] of documents) assertRenderedDocument(markdown, kind);

  return withMachineGovernanceLock(input.rootPath, async (machineDirectory) => {
    const targetCandidate = join(canonicalRoot, GOVERNANCE_DIRECTORY);
    if (await entryExists(targetCandidate)) {
      const existingTarget = await lstat(targetCandidate);
      if (existingTarget.isSymbolicLink()) {
        throw new Error("Governance directory must not be a symbolic link");
      }
    }
    const target = assertPathInsideWorkspace(canonicalRoot, targetCandidate);
    if (await entryExists(target)) throw new Error("Governance is already initialized");
    const stagingRoot = await ensurePrivateDirectory(machineDirectory, STAGING_DIRECTORY);
    const owner = randomUUID();
    const ownerDirectory = assertPathInsideWorkspace(stagingRoot, join(stagingRoot, owner));
    const payloadDirectory = join(ownerDirectory, "payload");
    const manifestPath = join(ownerDirectory, "manifest.json");
    await mkdir(ownerDirectory, { mode: 0o700 });
    const ownerIdentity = await lstat(ownerDirectory);
    if (ownerIdentity.isSymbolicLink() || !ownerIdentity.isDirectory()) {
      throw new Error("Governance transaction owner directory is unsafe");
    }
    await mkdir(payloadDirectory, { mode: 0o700 });
    const manifestHandle = await open(
      manifestPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    const manifestOwnership = await manifestHandle.stat();
    try {
      await manifestHandle.writeFile(JSON.stringify({
        kind: "DESIGN_SHARINGAN_GOVERNANCE_INIT",
        owner,
        pid: process.pid,
        projectId,
        createdAt: new Date().toISOString(),
        files: documents.map(([fileName]) => fileName),
      }), "utf8");
      await manifestHandle.sync();
    } finally {
      await manifestHandle.close();
    }
    let promoted = false;
    try {
      for (const [fileName, markdown] of documents) {
        await atomicWriteDocument(payloadDirectory, fileName, markdown);
      }
      await Promise.all(documents.map(async ([fileName, , kind]) => {
        const parsed = parseGovernanceMetadata(
          await readBoundedDocument(join(payloadDirectory, fileName)),
        );
        if (parsed.kind !== kind) throw new Error("Staged governance document kind changed");
      }));
      await syncDirectory(payloadDirectory);
      await syncDirectory(ownerDirectory);
      const currentRootPath = await canonicalProjectRoot(input.rootPath);
      const currentRoot = await lstat(currentRootPath);
      if (
        currentRootPath !== canonicalRoot || currentRoot.dev !== rootIdentity.dev ||
        currentRoot.ino !== rootIdentity.ino || await entryExists(target)
      ) throw new Error("Canonical project identity changed before governance promotion");
      const payloadEntry = await lstat(payloadDirectory);
      if (payloadEntry.isSymbolicLink() || !payloadEntry.isDirectory()) {
        throw new Error("Governance payload identity changed before promotion");
      }
      await rename(payloadDirectory, target);
      promoted = true;
      await syncDirectory(canonicalRoot);
      await Promise.all(documents.map(([fileName]) => assertRegularDocument(
        join(/* turbopackIgnore: true */ target, fileName),
      )));
    } finally {
      const currentOwner = await lstat(ownerDirectory).catch(() => undefined);
      const ownerUnchanged = currentOwner !== undefined &&
        currentOwner.dev === ownerIdentity.dev && currentOwner.ino === ownerIdentity.ino &&
        currentOwner.isDirectory() && !currentOwner.isSymbolicLink();
      if (ownerUnchanged && !promoted) {
        await rm(ownerDirectory, { recursive: true, force: false }).catch(() => undefined);
      } else if (ownerUnchanged) {
        const currentManifest = await lstat(manifestPath).catch(() => undefined);
        if (
          currentManifest?.isFile() && !currentManifest.isSymbolicLink() &&
          currentManifest.nlink === 1 && currentManifest.dev === manifestOwnership.dev &&
          currentManifest.ino === manifestOwnership.ino
        ) {
          await unlink(manifestPath).catch(() => undefined);
        }
        await rmdir(ownerDirectory).catch(() => undefined);
      }
    }
    return {
      genome: genomeDocument(genomeMetadata),
      screens: {
        metadata: {
          schemaVersion: screensMetadata.schemaVersion,
          kind: screensMetadata.kind,
          projectId: screensMetadata.projectId,
          entityId: screensMetadata.entityId,
          revision: screensMetadata.revision,
          genomeEntityId: screensMetadata.genomeEntityId,
          genomeVersion: screensMetadata.genomeVersion,
          genomeRevision: screensMetadata.genomeRevision,
          evidenceIds: screensMetadata.evidenceIds,
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
          genomeEntityId: decisionsMetadata.genomeEntityId,
          genomeVersion: decisionsMetadata.genomeVersion,
          genomeRevision: decisionsMetadata.genomeRevision,
          approvalProofs: decisionsMetadata.approvalProofs,
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
  const authenticated = await verifyAuthority(rootPath, metadata);
  if (metadata.value.status === "APPROVED" && !authenticated) {
    throw new Error("Approved Genome authority proof could not be authenticated");
  }
  return genomeDocument(metadata, authenticated);
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
  if (!/^[a-f0-9]{64}$/.test(input.expectedPayloadHash)) {
    throw new Error("Expected Genome payload hash is invalid");
  }
  return withGovernanceLock(rootPath, async (directory) => {
    const current = await readGenome(rootPath, projectId);
    if (current.metadata.revision !== input.expectedRevision) {
      throw new Error("Genome approval revision is stale");
    }
    if (current.value.status !== "DRAFT") {
      throw new Error("Only a DRAFT Genome can be approved");
    }
    if (current.payloadHash !== input.expectedPayloadHash) {
      throw new Error("Genome approval payload hash is stale");
    }
    const approvedAt = new Date().toISOString();
    const value: DesignGenome = { ...current.value, status: "APPROVED" };
    const canonicalRoot = await canonicalProjectRoot(rootPath);
    const key = await authorityKey(rootPath, true);
    const unsignedAuthority: Omit<GenomeAuthorityProof, "signature"> = {
      kind: "GENOME_AUTHORITY",
      projectId,
      rootFingerprint: rootFingerprint(canonicalRoot),
      genomeEntityId: current.metadata.entityId,
      genomeVersion: value.version,
      approvedDraftRevision: current.metadata.revision,
      documentRevision: current.metadata.revision + 1,
      payloadHash: genomePayloadHash(value),
      approvedBy: "local-user",
      approvedAt,
    };
    const metadata: GenomeMetadata = {
      ...current.metadata,
      revision: current.metadata.revision + 1,
      status: "APPROVED",
      authority: {
        ...unsignedAuthority,
        signature: authoritySignature(key, unsignedAuthority),
      },
      value,
    };
    await atomicWriteDocument(directory, DESIGN_GENOME_FILE, renderGenome(metadata));
    return genomeDocument(metadata, true);
  });
}

export { atomicWriteDocument, safeProjectId };
