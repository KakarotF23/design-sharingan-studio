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
  link,
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
  GovernanceClaimCitation,
  GovernanceEvidenceCatalogEntry,
  GovernanceInspectedScope,
  ScreenRecord,
} from "@design-sharingan/core";
import { normalizeGovernanceRoute } from "@design-sharingan/core";
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
const EVIDENCE_CATALOG_FILE = "governance-evidence.json";

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
  evidenceCatalog?: GovernanceEvidenceCatalogEntry[];
  inspectedScope?: GovernanceInspectedScope;
  claimCitations?: GovernanceClaimCitation[];
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

export function incrementGovernanceRevision(revision: number): number {
  if (!Number.isSafeInteger(revision) || revision < 1 || revision >= Number.MAX_SAFE_INTEGER) {
    throw new Error("Governance revision cannot be incremented beyond the safe maximum");
  }
  return revision + 1;
}

const authenticatedGenomeDocuments = new WeakMap<GenomeDocument, string>();
const MACHINE_STATE_DIRECTORY = ".design-sharingan";
const AUTHORITY_KEY_FILE = "governance-authority.key";
const EVIDENCE_ID_PATTERN = /^ev_[a-zA-Z0-9_-]{8,125}$/;
const SAFE_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const SECRET_OR_PATH_PATTERN = /(?:sk-[a-zA-Z0-9_-]{8,}|gh[pousr]_[a-zA-Z0-9]{12,}|AKIA[A-Z0-9]{12,}|Bearer\s+[a-zA-Z0-9._-]{8,}|(?:api[_-]?key|token|secret|password)\s*[:=]\s*[^\s,;]+|\/(?:[a-zA-Z0-9._-]+\/)+[a-zA-Z0-9._-]+)/i;

interface StoredEvidenceCatalog {
  schemaVersion: 1;
  kind: "DESIGN_SHARINGAN_EVIDENCE_CATALOG";
  projectId: string;
  rootFingerprint: string;
  createdAt: string;
  entries: GovernanceEvidenceCatalogEntry[];
  signature: string;
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

function exactObjectKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  if (Object.keys(value).sort().join(",") !== [...keys].sort().join(",")) {
    throw new Error(`${label} does not match the exact schema`);
  }
}

function normalizeEvidenceCatalog(
  value: unknown,
): GovernanceEvidenceCatalogEntry[] {
  if (!Array.isArray(value) || value.length > 32) {
    throw new Error("Governance evidence catalog must be bounded");
  }
  const entries = value.map((raw, index) => {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error(`Governance evidence catalog entry ${index} is invalid`);
    }
    const entry = raw as Record<string, unknown>;
    exactObjectKeys(
      entry,
      entry.authenticatedRenderId === undefined
        ? ["id", "kind", "route", "excerpt", "verifiedClaims"]
        : ["id", "kind", "route", "excerpt", "verifiedClaims", "authenticatedRenderId"],
      `Governance evidence catalog entry ${index}`,
    );
    if (typeof entry.id !== "string" || !EVIDENCE_ID_PATTERN.test(entry.id)) {
      throw new Error("Governance evidence catalog identity is invalid");
    }
    const kinds = new Set(["RENDER", "ROUTE", "NAVIGATION", "COMPONENT", "TOKEN", "DOCUMENT"]);
    if (typeof entry.kind !== "string" || !kinds.has(entry.kind)) {
      throw new Error("Governance evidence catalog kind is invalid");
    }
    const route = normalizeGovernanceRoute(String(entry.route));
    if (
      typeof entry.excerpt !== "string" || entry.excerpt.trim().length === 0 ||
      entry.excerpt.length > 1_000 || SECRET_OR_PATH_PATTERN.test(entry.excerpt)
    ) throw new Error("Governance evidence catalog excerpt is unsafe");
    if (!Array.isArray(entry.verifiedClaims) || entry.verifiedClaims.length > 64) {
      throw new Error("Governance verified claims must be bounded");
    }
    const verifiedClaims = entry.verifiedClaims.map((rawClaim, claimIndex) => {
      if (rawClaim === null || typeof rawClaim !== "object" || Array.isArray(rawClaim)) {
        throw new Error("Governance verified claim is invalid");
      }
      const claim = rawClaim as Record<string, unknown>;
      exactObjectKeys(claim, ["claimType", "category", "statement", "scope"], `Governance verified claim ${claimIndex}`);
      const categories = new Set([
        "PRODUCT_IDENTITY", "UX_INVARIANT", "VISUAL_INVARIANT", "MOTION_RULE",
        "ACCESSIBILITY_RULE", "COMPONENT_DNA", "SCREEN_FAMILY", "CONTENT_VOICE",
      ]);
      if (
        (claim.claimType !== "PRODUCT_IDENTITY" && claim.claimType !== "RULE") ||
        typeof claim.category !== "string" || !categories.has(claim.category) ||
        ((claim.claimType === "PRODUCT_IDENTITY") !== (claim.category === "PRODUCT_IDENTITY")) ||
        typeof claim.statement !== "string" || claim.statement.trim().length === 0 ||
        claim.statement.length > 1_000 || SECRET_OR_PATH_PATTERN.test(claim.statement) ||
        claim.scope === null || typeof claim.scope !== "object" || Array.isArray(claim.scope)
      ) throw new Error("Governance verified claim is invalid");
      const scope = claim.scope as Record<string, unknown>;
      exactObjectKeys(scope, ["routes"], "Governance verified claim scope");
      if (!Array.isArray(scope.routes) || scope.routes.length !== 1) {
        throw new Error("Governance verified claim cannot exceed one inspected route");
      }
      const claimRoute = normalizeGovernanceRoute(String(scope.routes[0]));
      if (claimRoute !== route) throw new Error("Governance verified claim exceeds its evidence route");
      return {
        claimType: claim.claimType,
        category: claim.category,
        statement: claim.statement,
        scope: { routes: [claimRoute] },
      } as GovernanceEvidenceCatalogEntry["verifiedClaims"][number];
    });
    const authenticatedRenderId = entry.authenticatedRenderId;
    if (
      authenticatedRenderId !== undefined &&
      (typeof authenticatedRenderId !== "string" || !SAFE_ID_PATTERN.test(authenticatedRenderId))
    ) throw new Error("Authenticated render identity is invalid");
    return {
      id: entry.id,
      kind: entry.kind as GovernanceEvidenceCatalogEntry["kind"],
      route,
      excerpt: entry.excerpt,
      verifiedClaims,
      ...(authenticatedRenderId === undefined ? {} : { authenticatedRenderId }),
    };
  });
  if (new Set(entries.map(({ id }) => id)).size !== entries.length) {
    throw new Error("Governance evidence catalog identities must be unique");
  }
  return entries;
}

function evidenceCatalogSignature(
  key: Buffer,
  value: Omit<StoredEvidenceCatalog, "signature">,
): string {
  return createHmac("sha256", key).update(JSON.stringify(value), "utf8").digest("hex");
}

async function writeEvidenceCatalog(
  rootPath: string,
  projectId: string,
  machineDirectory: string,
  entriesInput: unknown,
): Promise<{ path: string; dev: number; ino: number }> {
  const entries = normalizeEvidenceCatalog(entriesInput);
  const key = await authorityKey(rootPath, true);
  const canonicalRoot = await canonicalProjectRoot(rootPath);
  const unsigned: Omit<StoredEvidenceCatalog, "signature"> = {
    schemaVersion: 1,
    kind: "DESIGN_SHARINGAN_EVIDENCE_CATALOG",
    projectId,
    rootFingerprint: rootFingerprint(canonicalRoot),
    createdAt: new Date().toISOString(),
    entries,
  };
  const stored: StoredEvidenceCatalog = {
    ...unsigned,
    signature: evidenceCatalogSignature(key, unsigned),
  };
  await atomicWriteDocument(
    machineDirectory,
    EVIDENCE_CATALOG_FILE,
    `${JSON.stringify(stored)}\n`,
  );
  const path = join(machineDirectory, EVIDENCE_CATALOG_FILE);
  const identity = await assertRegularDocument(path);
  return { path, dev: Number(identity.dev), ino: Number(identity.ino) };
}

export async function readEvidenceCatalog(
  rootPath: string,
  projectId: string,
): Promise<GovernanceEvidenceCatalogEntry[]> {
  safeProjectId(projectId);
  const canonicalRoot = await canonicalProjectRoot(rootPath);
  const machineDirectory = await machineStateDirectory(rootPath, false);
  const path = assertPathInsideWorkspace(machineDirectory, join(machineDirectory, EVIDENCE_CATALOG_FILE));
  const raw = await readBoundedDocument(path);
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error("Governance evidence catalog is malformed"); }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Governance evidence catalog is malformed");
  }
  const stored = parsed as Record<string, unknown>;
  exactObjectKeys(stored, ["schemaVersion", "kind", "projectId", "rootFingerprint", "createdAt", "entries", "signature"], "Governance evidence catalog");
  if (
    stored.schemaVersion !== 1 || stored.kind !== "DESIGN_SHARINGAN_EVIDENCE_CATALOG" ||
    stored.projectId !== projectId || stored.rootFingerprint !== rootFingerprint(canonicalRoot) ||
    typeof stored.createdAt !== "string" || new Date(stored.createdAt).toISOString() !== stored.createdAt ||
    typeof stored.signature !== "string" || !/^[a-f0-9]{64}$/.test(stored.signature)
  ) throw new Error("Governance evidence catalog identity is invalid");
  const entries = normalizeEvidenceCatalog(stored.entries);
  const unsigned: Omit<StoredEvidenceCatalog, "signature"> = {
    schemaVersion: 1,
    kind: "DESIGN_SHARINGAN_EVIDENCE_CATALOG",
    projectId,
    rootFingerprint: stored.rootFingerprint,
    createdAt: stored.createdAt,
    entries,
  };
  const key = await authorityKey(rootPath, false);
  const expected = Buffer.from(evidenceCatalogSignature(key, unsigned), "hex");
  const actual = Buffer.from(stored.signature, "hex");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new Error("Governance evidence catalog signature is not authenticated");
  }
  const normalized: StoredEvidenceCatalog = { ...unsigned, signature: stored.signature };
  if (`${JSON.stringify(normalized)}\n` !== raw) {
    throw new Error("Governance evidence catalog is not canonical");
  }
  return entries;
}

function assertGenomeEvidenceRelationships(
  inspectedScope: GovernanceInspectedScope,
  claimCitations: GovernanceClaimCitation[],
  catalog: GovernanceEvidenceCatalogEntry[],
): void {
  const catalogById = new Map(catalog.map((entry) => [entry.id, entry]));
  const catalogRoutes = [...new Set(catalog.map(({ route }) => route))];
  if (
    inspectedScope.representative !== true ||
    new Set(inspectedScope.routes).size !== inspectedScope.routes.length ||
    new Set(inspectedScope.evidenceIds).size !== inspectedScope.evidenceIds.length ||
    inspectedScope.routes.some((route) => !catalogRoutes.includes(normalizeGovernanceRoute(route))) ||
    inspectedScope.evidenceIds.some((id) => !catalogById.has(id))
  ) throw new Error("Genome inspected scope is not authenticated by the evidence catalog");
  for (const citation of claimCitations) {
    const entries = citation.evidenceIds.map((id) => catalogById.get(id));
    if (entries.some((entry) => entry === undefined)) {
      throw new Error("Genome claim citation is not authenticated by the evidence catalog");
    }
    const routes = [...new Set(entries.flatMap((entry) => entry === undefined ? [] : [entry.route]))];
    if (
      citation.scope.routes.length !== routes.length ||
      citation.scope.routes.some((route) => !routes.includes(normalizeGovernanceRoute(route)))
    ) throw new Error("Genome claim scope does not match its evidence citations");
    if (citation.confidence === "CONFIRMED" && entries.some((entry) =>
      entry === undefined || !entry.verifiedClaims.some((claim) =>
        claim.claimType === citation.claimType && claim.category === citation.category &&
        claim.statement === citation.statement && claim.scope.routes[0] === entry.route,
      ))) throw new Error("Confirmed Genome claim lacks exact server-owned verification");
  }
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
    incrementGovernanceRevision(proof.approvedDraftRevision) !== metadata.revision ||
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
  const genomeMetadata = parseGovernanceMetadata(await readBoundedDocument(paths[0]!));
  if (genomeMetadata.kind !== "DESIGN_GENOME") {
    throw new Error("Governance initialization has the wrong Genome document kind");
  }
  await readEvidenceCatalog(rootPath, genomeMetadata.projectId);
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
  let ownership: { dev: number; ino: number } | undefined;
  for (let attempt = 0; attempt < MAX_LOCK_ATTEMPTS; attempt += 1) {
    const temporaryLock = assertPathInsideWorkspace(
      directory,
      join(directory, `.governance.lock.tmp-${process.pid}-${randomUUID()}`),
    );
    let temporaryHandle: Awaited<ReturnType<typeof open>> | undefined;
    let temporaryOwnership: { dev: number; ino: number } | undefined;
    let publishedOwnership: { dev: number; ino: number } | undefined;
    try {
      temporaryHandle = await open(
        temporaryLock,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
        0o600,
      );
      const opened = await temporaryHandle.stat();
      temporaryOwnership = { dev: opened.dev, ino: opened.ino };
      await temporaryHandle.writeFile(JSON.stringify(claim), "utf8");
      await temporaryHandle.sync();
      await temporaryHandle.close();
      temporaryHandle = undefined;
      await link(temporaryLock, lockPath);
      const linked = await lstat(lockPath);
      publishedOwnership = { dev: Number(linked.dev), ino: Number(linked.ino) };
      await unlink(temporaryLock);
      const published = await lstat(lockPath);
      if (!published.isFile() || published.isSymbolicLink() || published.nlink !== 1) {
        throw new Error("Governance lock publication is unsafe");
      }
      ownership = { dev: published.dev, ino: published.ino };
      await syncDirectory(directory);
      break;
    } catch (error) {
      if (temporaryHandle !== undefined) await temporaryHandle.close().catch(() => undefined);
      const temporaryEntry = await lstat(temporaryLock).catch(() => undefined);
      if (
        temporaryEntry !== undefined && temporaryOwnership !== undefined &&
        temporaryEntry.dev === temporaryOwnership.dev && temporaryEntry.ino === temporaryOwnership.ino
      ) await unlink(temporaryLock).catch(() => undefined);
      if (publishedOwnership !== undefined) {
        const publishedEntry = await lstat(lockPath).catch(() => undefined);
        if (
          publishedEntry !== undefined && Number(publishedEntry.dev) === publishedOwnership.dev &&
          Number(publishedEntry.ino) === publishedOwnership.ino
        ) await unlink(lockPath).catch(() => undefined);
      }
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) {
        throw error;
      }
      const entry = await lstat(lockPath);
      let existing: LockClaim | undefined;
      let incomplete = false;
      try {
        existing = await readLockClaim(lockPath);
        incomplete = existing === undefined;
      } catch {
        incomplete = true;
      }
      const age = existing === undefined ? Date.now() - entry.mtimeMs : Date.now() - Date.parse(existing.createdAt);
      if (
        age > LOCK_STALE_MILLISECONDS &&
        (incomplete || (existing !== undefined && !processIsAlive(existing.pid)))
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
  if (ownership === undefined) {
    throw new Error("Governance is busy; refusing an unsynchronized write");
  }
  let result: T | undefined;
  let operationError: unknown;
  try {
    await reconcileOwnedStaging(directory);
    result = await operation(directory);
  } catch (error) {
    operationError = error;
  }
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
  const catalog = normalizeEvidenceCatalog(input.evidenceCatalog ?? []);
  const inspectedScope: GovernanceInspectedScope = input.inspectedScope ?? {
    representative: true,
    routes: [...new Set(input.screens.map(({ route }) => normalizeGovernanceRoute(route)))],
    evidenceIds: catalog.map(({ id }) => id),
  };
  const claimCitations = input.claimCitations ?? [];
  assertGenomeEvidenceRelationships(inspectedScope, claimCitations, catalog);
  const evidenceIds = [...new Set(input.screens.flatMap((screen) => screen.evidence))];
  const screens = assertScreenRecords(input.screens, {
    genome,
    evidenceIds: catalog.map(({ id }) => id),
    evidenceRoutes: Object.fromEntries(catalog.map(({ id, route }) => [id, route])),
  });
  if (evidenceIds.some((id) => !catalog.some((entry) => entry.id === id))) {
    throw new Error("Screen evidence is missing from the durable evidence catalog");
  }
  const decisions = assertDesignDecisions(input.decisions, [], screens);
  const canonicalRoot = await canonicalProjectRoot(input.rootPath);
  const rootIdentity = await lstat(canonicalRoot);
  const genomeMetadata: GenomeMetadata = {
    schemaVersion: GOVERNANCE_SCHEMA_VERSION,
    kind: "DESIGN_GENOME",
    projectId,
    entityId: randomUUID(),
    revision: 1,
    status: "DRAFT",
    inspectedScope,
    claimCitations,
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
    const catalogPath = assertPathInsideWorkspace(
      machineDirectory,
      join(machineDirectory, EVIDENCE_CATALOG_FILE),
    );
    if (await entryExists(catalogPath)) {
      await readEvidenceCatalog(input.rootPath, projectId);
      const staleCatalog = await assertRegularDocument(catalogPath);
      const currentTarget = await entryExists(target);
      if (currentTarget) throw new Error("Governance is already initialized");
      const currentCatalog = await assertRegularDocument(catalogPath);
      if (currentCatalog.dev !== staleCatalog.dev || currentCatalog.ino !== staleCatalog.ino) {
        throw new Error("Governance evidence catalog identity changed during reconciliation");
      }
      await unlink(catalogPath);
      await syncDirectory(machineDirectory);
    }
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
    let catalogOwnership: { path: string; dev: number; ino: number } | undefined;
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
      catalogOwnership = await writeEvidenceCatalog(
        input.rootPath,
        projectId,
        machineDirectory,
        catalog,
      );
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
      if (!promoted && catalogOwnership !== undefined) {
        const currentCatalog = await lstat(catalogOwnership.path).catch(() => undefined);
        if (
          currentCatalog !== undefined && currentCatalog.isFile() &&
          !currentCatalog.isSymbolicLink() && currentCatalog.nlink === 1 &&
          currentCatalog.dev === catalogOwnership.dev && currentCatalog.ino === catalogOwnership.ino
        ) {
          await unlink(catalogOwnership.path).catch(() => undefined);
          await syncDirectory(machineDirectory).catch(() => undefined);
        }
      }
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
  const evidenceCatalog = await readEvidenceCatalog(rootPath, projectId);
  assertGenomeEvidenceRelationships(
    metadata.inspectedScope,
    metadata.claimCitations,
    evidenceCatalog,
  );
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
    const nextRevision = incrementGovernanceRevision(current.metadata.revision);
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
      documentRevision: nextRevision,
      payloadHash: genomePayloadHash(value),
      approvedBy: "local-user",
      approvedAt,
    };
    const metadata: GenomeMetadata = {
      ...current.metadata,
      revision: nextRevision,
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
