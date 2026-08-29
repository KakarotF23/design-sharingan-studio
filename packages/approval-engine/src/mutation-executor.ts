import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  rmdir,
} from "node:fs/promises";
import { devNull, tmpdir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  posix,
  relative,
  resolve,
  sep,
} from "node:path";
import type { CodexAgentRunInput } from "@design-sharingan/agent-runtime";
import type {
  Approval,
  AutonomyChange,
  AutonomyPolicy,
  AutonomyPolicyEvaluation,
  ChangeProposal,
  MangekyoHumanGate,
  MangekyoHumanGateDecision,
  MangekyoPolicyEvaluationEvidence,
  RenderSourcePathEvidence,
  RenderSourceRevision,
  SafeMutationFailureEvidence,
  SafeMutationTargetDisposition,
} from "@design-sharingan/core";
import { evaluateAutonomyPolicy } from "@design-sharingan/core";

const MAX_APPROVED_PATHS = 128;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_DELTA_BYTES = 8 * 1024 * 1024;
const MAX_MIRROR_ENTRIES = 512;
const MAX_GIT_OUTPUT_BYTES = 128 * 1024;
const GIT_TIMEOUT_MS = 5_000;

export interface MutationAgent {
  run<TStructured = unknown>(input: CodexAgentRunInput): Promise<{
    threadId: string;
    structured: TStructured | null;
  }>;
}

export interface MutationDriver {
  write(path: string, contents: Uint8Array, mode: number): Promise<void>;
  remove(path: string): Promise<void>;
}

export interface GitMutationEvidence {
  available: boolean;
  branch?: string;
  statusBefore: string;
  statusAfter: string;
  diffAfter: string;
  truncation: {
    branch: GitEvidenceTruncation;
    statusBefore: GitEvidenceTruncation;
    statusAfter: GitEvidenceTruncation;
    diffAfter: GitEvidenceTruncation;
  };
  note?: string;
}

export interface GitEvidenceTruncation {
  truncated: boolean;
  limitBytes: number;
  originalBytes: number;
  retainedBytes: number;
}

export interface MutationResult {
  proposalId: string;
  threadId: string;
  filesChanged: string[];
  git: GitMutationEvidence;
  sourceRevision?: RenderSourceRevision;
}

interface TargetRecord {
  relativePath: string;
  absolutePath: string;
  operation: "create" | "modify" | "delete";
  originalContents?: Uint8Array;
  originalMode?: number;
}

interface DeltaRecord extends TargetRecord {
  nextContents?: Uint8Array;
}

interface AppliedDeltaRecord extends DeltaRecord {
  expectedAppliedContents?: Uint8Array;
  expectedAppliedMode?: number;
}

interface GitBefore {
  available: boolean;
  branch?: string;
  statusBefore: string;
  branchTruncation: GitEvidenceTruncation;
  statusBeforeTruncation: GitEvidenceTruncation;
  note?: string;
}

export interface MutationExecutorOptions {
  workspaceRoot: string;
  proposalThreadId: string;
  agent: MutationAgent;
  mutationDriver?: MutationDriver;
  captureSourceRevision?(input: {
    workspaceRoot: string;
    requiredPaths: string[];
  }): Promise<RenderSourceRevision>;
  assertWorkerOwnership?(): Promise<void>;
}

export type MangekyoWorkerOwnershipBoundary = "AUTHORIZATION" | "MUTATION_EXECUTION";

export interface AutonomousMutationAuthorization {
  kind: "AUTONOMOUS_POLICY_ALLOW";
  id: string;
  loopSessionId: string;
  proposalId: string;
  proposalThreadId: string;
  change: AutonomyChange;
  policy: AutonomyPolicy;
  evaluation: AutonomyPolicyEvaluation & { decision: "ALLOW" };
  evaluatedAt: string;
  expiresAt: string;
}

export interface ExecutePolicyAuthorizedMutationInput {
  workspaceRoot: string;
  loopSessionId: string;
  proposal: ChangeProposal;
  proposalThreadId: string;
  policy: AutonomyPolicy;
  change: AutonomyChange;
  agent: MutationAgent;
  mutationDriver?: MutationDriver;
  captureSourceRevision?: MutationExecutorOptions["captureSourceRevision"];
  assertWorkerOwnership?(boundary: MangekyoWorkerOwnershipBoundary): Promise<void>;
}

export interface ExecuteApproveOnceMutationInput {
  workspaceRoot: string;
  loopSessionId: string;
  sessionVersion: string;
  proposal: ChangeProposal;
  proposalThreadId: string;
  change: AutonomyChange;
  gate: MangekyoHumanGate;
  policyEvaluation: MangekyoPolicyEvaluationEvidence;
  decision: MangekyoHumanGateDecision & { decision: "APPROVE_ONCE" };
  now: Date;
  consumeAuthorization(claim: {
    loopSessionId: string;
    sessionVersion: string;
    gateId: string;
    decisionId: string;
    proposalId: string;
  }): Promise<void>;
  agent: MutationAgent;
  mutationDriver?: MutationDriver;
  captureSourceRevision?: MutationExecutorOptions["captureSourceRevision"];
  assertWorkerOwnership?(boundary: MangekyoWorkerOwnershipBoundary): Promise<void>;
}

export interface PolicyAuthorizationStore {
  createId(): string;
  now(): Date;
  persistAuthorization(authorization: AutonomousMutationAuthorization): Promise<void>;
  loadAuthorization(id: string): Promise<unknown>;
}

export type PolicyAuthorizedMutationResult =
  | {
      decision: "HUMAN_GATE";
      evaluation: AutonomyPolicyEvaluation & { decision: "HUMAN_GATE" };
    }
  | {
      decision: "APPLIED";
      authorization: AutonomousMutationAuthorization;
      mutation: MutationResult;
    };

export class SafeMutationExecutionError extends Error {
  readonly failure: SafeMutationFailureEvidence;

  constructor(
    targetDisposition: SafeMutationTargetDisposition,
    affectedPaths: string[],
    cause: unknown,
  ) {
    super(
      cause instanceof Error
        ? cause.message
        : "Safe Mode mutation failed without trustworthy completion evidence",
      { cause },
    );
    this.name = "SafeMutationExecutionError";
    this.failure = {
      kind: "SAFE_MUTATION_FAILURE",
      targetDisposition,
      reason: boundedUtf8(this.message, 2_000).value,
      affectedPaths,
      occurredAt: new Date().toISOString(),
    };
  }
}

class MutationTransactionError extends Error {
  readonly targetDisposition:
    | "FULLY_ROLLED_BACK"
    | "RECONCILIATION_REQUIRED";

  constructor(
    targetDisposition: "FULLY_ROLLED_BACK" | "RECONCILIATION_REQUIRED",
    message: string,
    cause: unknown,
  ) {
    super(message, { cause });
    this.name = "MutationTransactionError";
    this.targetDisposition = targetDisposition;
  }
}

const defaultMutationDriver: MutationDriver = {
  async write(path, contents, mode) {
    const temporaryPath = join(
      dirname(path),
      `.${basename(path)}.safe-write-${process.pid}-${randomUUID()}`,
    );
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(
        temporaryPath,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        mode,
      );
      await handle.writeFile(contents);
      await handle.chmod(mode);
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporaryPath, path);
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }
  },
  async remove(path) {
    await rm(path);
  },
};

function safeIdentifier(value: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value);
}

function safeRelativePath(path: string): boolean {
  return (
    path.length > 0 &&
    Buffer.byteLength(path, "utf8") <= 512 &&
    !/[\u0000-\u001f\u007f]/.test(path) &&
    !path.includes("\\") &&
    !path.startsWith("/") &&
    !isAbsolute(path) &&
    path !== "." &&
    path !== ".." &&
    !path
      .split("/")
      .some((segment) => segment === "" || segment === "." || segment === "..") &&
    posix.normalize(path) === path
  );
}

function protectedPath(path: string): boolean {
  const segments = path.toLowerCase().split("/");
  const first = segments[0];
  const fileName = segments.at(-1) ?? "";
  return (
    first === ".git" ||
    first === ".design-sharingan" ||
    first === "design-governance" ||
    segments.includes(".direnv") ||
    fileName === ".env" ||
    fileName.startsWith(".env.") ||
    fileName.startsWith(".envrc") ||
    fileName.endsWith(".env")
  );
}

function validateGate(proposal: ChangeProposal, approval: Approval | undefined): void {
  if (approval === undefined) {
    throw new Error("Safe Mode requires explicit approval before mutation");
  }
  if (approval.decision !== "APPROVED") {
    throw new Error("Safe Mode mutation requires an APPROVED decision");
  }
  if (approval.scope !== "CHANGE_PROPOSAL") {
    throw new Error("Safe Mode approval requires CHANGE_PROPOSAL scope");
  }
  if (approval.proposalId !== proposal.id) {
    throw new Error("Safe Mode approval must reference the same proposal");
  }
  if (
    proposal.status !== "PROPOSED" ||
    proposal.requiresHumanApproval !== true
  ) {
    throw new Error("Safe Mode proposal status is not executable");
  }
  if (!safeIdentifier(proposal.id) || !safeIdentifier(proposal.sessionId)) {
    throw new Error("Safe Mode proposal identity is invalid");
  }
}

function stableJson(value: unknown): string {
  function sort(entry: unknown): unknown {
    if (Array.isArray(entry)) return entry.map(sort);
    if (entry !== null && typeof entry === "object") {
      return Object.fromEntries(
        Object.entries(entry)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, nested]) => [key, sort(nested)]),
      );
    }
    return entry;
  }
  return JSON.stringify(sort(value));
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function validAutonomyPolicy(value: AutonomyPolicy): boolean {
  return (
    typeof value.allowStyleChanges === "boolean" &&
    typeof value.allowSmallComponentRefactors === "boolean" &&
    Number.isSafeInteger(value.maxFilesForComponentRefactor) &&
    value.maxFilesForComponentRefactor >= 0 &&
    value.maxFilesForComponentRefactor <= MAX_APPROVED_PATHS &&
    typeof value.allowNewPresentationalComponents === "boolean" &&
    typeof value.allowDependencyInstall === "boolean" &&
    typeof value.allowNavigationChanges === "boolean" &&
    typeof value.allowDataModelChanges === "boolean" &&
    typeof value.allowFileDeletion === "boolean" &&
    Array.isArray(value.protectedPaths) &&
    value.protectedPaths.length > 0 &&
    value.protectedPaths.length <= MAX_APPROVED_PATHS &&
    value.protectedPaths.every(
      (path) =>
        typeof path === "string" &&
        path.length > 0 &&
        Buffer.byteLength(path, "utf8") <= 512 &&
        !path.includes("\0"),
    )
  );
}

function validateAutonomousGate(
  proposal: ChangeProposal,
  authorization: AutonomousMutationAuthorization,
  now: Date,
): void {
  const proposalFiles = [
    ...proposal.filesToCreate,
    ...proposal.filesToModify,
    ...proposal.filesToDelete,
  ];
  const reevaluated = evaluateAutonomyPolicy(authorization.policy, authorization.change);
  if (
    authorization.kind !== "AUTONOMOUS_POLICY_ALLOW" ||
    !safeIdentifier(authorization.id) ||
    !safeIdentifier(authorization.loopSessionId) ||
    authorization.loopSessionId !== proposal.sessionId ||
    authorization.proposalId !== proposal.id ||
    authorization.proposalThreadId.length === 0 ||
    Buffer.byteLength(authorization.proposalThreadId, "utf8") > 256 ||
    authorization.evaluation.decision !== "ALLOW" ||
    authorization.evaluation.reasons.length !== 0 ||
    reevaluated.decision !== "ALLOW" ||
    reevaluated.reasons.length !== 0 ||
    !validAutonomyPolicy(authorization.policy) ||
    stableJson(authorization.change.files) !== stableJson(proposalFiles) ||
    !isIsoTimestamp(authorization.evaluatedAt) ||
    !isIsoTimestamp(authorization.expiresAt) ||
    Date.parse(authorization.expiresAt) - Date.parse(authorization.evaluatedAt) !== 5 * 60_000 ||
    now.getTime() < Date.parse(authorization.evaluatedAt) ||
    now.getTime() > Date.parse(authorization.expiresAt) ||
    proposal.status !== "PROPOSED"
  ) {
    throw new Error("Persisted autonomy authorization is missing, stale, ambiguous, or invalid");
  }
}

function exactObject(value: unknown, keys: readonly string[]): boolean {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function validateApproveOnceGate(input: ExecuteApproveOnceMutationInput): void {
  const files = [
    ...input.proposal.filesToCreate,
    ...input.proposal.filesToModify,
    ...input.proposal.filesToDelete,
  ];
  const gate = input.gate;
  const evidence = input.policyEvaluation;
  const decision = input.decision;
  const decisionKeys = [
    "id", "gateId", "decision", "decidedBy", "createdAt",
    ...(decision.comment === undefined ? [] : ["comment"]),
  ];
  if (
    !Number.isFinite(input.now.getTime()) ||
    !safeIdentifier(input.loopSessionId) ||
    !isIsoTimestamp(input.sessionVersion) ||
    Date.parse(input.sessionVersion) < Date.parse(input.decision.createdAt) ||
    Date.parse(input.sessionVersion) > input.now.getTime() ||
    input.proposal.sessionId !== input.loopSessionId ||
    input.proposal.status !== "PROPOSED" ||
    input.proposalThreadId.length === 0 ||
    Buffer.byteLength(input.proposalThreadId, "utf8") > 256 ||
    !exactObject(gate, [
      "id", "roundNumber", "requestedChange", "proposal", "proposalThreadId",
      "policyEvaluationId", "requestedAt", "reasons", "affectedScope", "impact",
    ]) ||
    !safeIdentifier(gate.id) ||
    !Number.isSafeInteger(gate.roundNumber) ||
    gate.roundNumber < 1 ||
    gate.roundNumber > 5 ||
    !isIsoTimestamp(gate.requestedAt) ||
    gate.reasons.length === 0 ||
    gate.proposalThreadId !== input.proposalThreadId ||
    stableJson(gate.proposal) !== stableJson(input.proposal) ||
    stableJson(gate.requestedChange) !== stableJson(input.change) ||
    !exactObject(evidence, [
      "id", "roundNumber", "proposalId", "change", "policy", "evaluation", "evaluatedAt",
    ]) ||
    !safeIdentifier(evidence.id) ||
    gate.policyEvaluationId !== evidence.id ||
    evidence.roundNumber !== gate.roundNumber ||
    evidence.proposalId !== input.proposal.id ||
    evidence.evaluation.decision !== "HUMAN_GATE" ||
    evidence.evaluation.reasons.length === 0 ||
    !validAutonomyPolicy(evidence.policy) ||
    stableJson(evidence.change) !== stableJson(input.change) ||
    stableJson(input.change.files) !== stableJson(files) ||
    !isIsoTimestamp(evidence.evaluatedAt) ||
    !exactObject(decision, decisionKeys) ||
    !safeIdentifier(decision.id) ||
    decision.decision !== "APPROVE_ONCE" ||
    decision.gateId !== gate.id ||
    decision.decidedBy.trim().length === 0 ||
    Buffer.byteLength(decision.decidedBy, "utf8") > 256 ||
    (decision.comment !== undefined && Buffer.byteLength(decision.comment, "utf8") > 2_000) ||
    !isIsoTimestamp(decision.createdAt) ||
    Date.parse(decision.createdAt) < Date.parse(gate.requestedAt) ||
    input.now.getTime() < Date.parse(decision.createdAt) ||
    input.now.getTime() > Date.parse(decision.createdAt) + 5 * 60_000
  ) {
    throw new Error("Persisted Approve Once authorization is missing, stale, ambiguous, or invalid");
  }
}

function validateProposalPaths(proposal: ChangeProposal): TargetRecord[] {
  const operations = [
    ...proposal.filesToCreate.map((relativePath) => ({
      relativePath,
      operation: "create" as const,
    })),
    ...proposal.filesToModify.map((relativePath) => ({
      relativePath,
      operation: "modify" as const,
    })),
    ...proposal.filesToDelete.map((relativePath) => ({
      relativePath,
      operation: "delete" as const,
    })),
  ];
  if (operations.length === 0 || operations.length > MAX_APPROVED_PATHS) {
    throw new Error("Approved mutation path count is invalid");
  }
  for (const { relativePath } of operations) {
    if (!safeRelativePath(relativePath)) {
      throw new Error(`Approved mutation path is outside the workspace: ${relativePath}`);
    }
    if (protectedPath(relativePath)) {
      throw new Error(`Approved mutation path is protected: ${relativePath}`);
    }
  }
  const allPaths = operations.map(({ relativePath }) => relativePath);
  if (new Set(allPaths).size !== allPaths.length) {
    throw new Error("Approved mutation paths contain a duplicate or overlap");
  }
  return operations.map(({ relativePath, operation }) => ({
    relativePath,
    absolutePath: "",
    operation,
  }));
}

function pathIsContained(rootPath: string, candidatePath: string): boolean {
  const fromRoot = relative(rootPath, candidatePath);
  return (
    fromRoot === "" ||
    (!isAbsolute(fromRoot) &&
      fromRoot !== ".." &&
      !fromRoot.startsWith(`..${sep}`))
  );
}

async function canonicalWorkspaceRoot(workspaceRoot: string): Promise<string> {
  const resolved = resolve(workspaceRoot);
  const [canonical, entry] = await Promise.all([realpath(resolved), lstat(resolved)]);
  if (
    canonical !== resolved ||
    entry.isSymbolicLink() ||
    !entry.isDirectory()
  ) {
    throw new Error("Active workspace must be a canonical real directory");
  }
  return canonical;
}

async function lstatIfPresent(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

async function assertSafeAncestors(
  rootPath: string,
  relativePath: string,
): Promise<string> {
  const absolutePath = resolve(rootPath, relativePath);
  if (!pathIsContained(rootPath, absolutePath) || absolutePath === rootPath) {
    throw new Error(`Mutation path is outside the active workspace: ${relativePath}`);
  }
  let current = rootPath;
  for (const segment of relativePath.split("/").slice(0, -1)) {
    current = join(current, segment);
    const entry = await lstatIfPresent(current);
    if (entry?.isSymbolicLink()) {
      throw new Error(`Mutation path has a symbolic link ancestor: ${relativePath}`);
    }
    if (entry !== undefined && !entry.isDirectory()) {
      throw new Error(`Mutation path ancestor is not a directory: ${relativePath}`);
    }
  }
  return absolutePath;
}

async function securelyReadRegularFile(path: string): Promise<{
  contents: Uint8Array;
  mode: number;
}> {
  const pathEntry = await lstat(path);
  if (pathEntry.nlink !== 1) {
    throw new Error("Approved target has an unsafe hard link count");
  }
  if (
    pathEntry.isSymbolicLink() ||
    !pathEntry.isFile() ||
    pathEntry.size > MAX_FILE_BYTES
  ) {
    throw new Error("Approved target must be an existing regular file within bounds");
  }
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const handleEntry = await handle.stat();
    if (
      !handleEntry.isFile() ||
      handleEntry.nlink !== 1 ||
      handleEntry.dev !== pathEntry.dev ||
      handleEntry.ino !== pathEntry.ino ||
      handleEntry.size !== pathEntry.size ||
      handleEntry.size > MAX_FILE_BYTES
    ) {
      throw new Error("Approved target changed while reading");
    }
    return {
      contents: new Uint8Array(await handle.readFile()),
      mode: pathEntry.mode & 0o777,
    };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function captureTargetRecords(
  rootPath: string,
  records: TargetRecord[],
): Promise<TargetRecord[]> {
  let totalBytes = 0;
  const captured: TargetRecord[] = [];
  for (const record of records) {
    const absolutePath = await assertSafeAncestors(rootPath, record.relativePath);
    const entry = await lstatIfPresent(absolutePath);
    if (record.operation === "create") {
      if (entry !== undefined) {
        throw new Error(`Create target must not exist: ${record.relativePath}`);
      }
      captured.push({ ...record, absolutePath });
      continue;
    }
    if (entry === undefined || entry.isSymbolicLink() || !entry.isFile()) {
      throw new Error(
        `${record.operation === "modify" ? "Modify" : "Delete"} target must be an existing regular file: ${record.relativePath}`,
      );
    }
    const original = await securelyReadRegularFile(absolutePath);
    totalBytes += original.contents.byteLength;
    if (totalBytes > MAX_DELTA_BYTES) {
      throw new Error("Approved mutation source exceeds the total byte bound");
    }
    captured.push({
      ...record,
      absolutePath,
      originalContents: original.contents,
      originalMode: original.mode,
    });
  }
  return captured;
}

async function seedMirror(mirrorRoot: string, records: TargetRecord[]): Promise<void> {
  for (const record of records) {
    const mirrorPath = join(mirrorRoot, record.relativePath);
    await mkdir(dirname(mirrorPath), { recursive: true, mode: 0o700 });
    if (record.operation !== "create") {
      await defaultMutationDriver.write(
        mirrorPath,
        record.operation === "delete"
          ? new Uint8Array()
          : (record.originalContents as Uint8Array),
        record.originalMode as number,
      );
    }
  }
}

async function snapshotMirror(rootPath: string): Promise<Map<string, Uint8Array>> {
  const files = new Map<string, Uint8Array>();
  let entriesSeen = 0;
  let totalBytes = 0;
  async function visit(directoryPath: string, relativeDirectory = ""): Promise<void> {
    const entries = await readdir(directoryPath, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      entriesSeen += 1;
      if (entriesSeen > MAX_MIRROR_ENTRIES) {
        throw new Error("Mutation mirror contains too many entries");
      }
      const relativePath = relativeDirectory
        ? `${relativeDirectory}/${entry.name}`
        : entry.name;
      const absolutePath = join(directoryPath, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`Mutation mirror contains a symbolic link: ${relativePath}`);
      }
      if (entry.isDirectory()) {
        await visit(absolutePath, relativePath);
      } else if (entry.isFile()) {
        const details = await securelyReadRegularFile(absolutePath);
        totalBytes += details.contents.byteLength;
        if (totalBytes > MAX_DELTA_BYTES) {
          throw new Error("Mutation mirror exceeds the total byte bound");
        }
        files.set(relativePath, details.contents);
      } else {
        throw new Error(`Mutation mirror contains an unsupported entry: ${relativePath}`);
      }
    }
  }
  await visit(rootPath);
  return files;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return Buffer.from(left).equals(Buffer.from(right));
}

function validateMirrorDelta(
  records: TargetRecord[],
  mirrorAfter: Map<string, Uint8Array>,
): DeltaRecord[] {
  const approvedPaths = new Set(records.map((record) => record.relativePath));
  for (const path of mirrorAfter.keys()) {
    if (!approvedPaths.has(path)) {
      throw new Error(`Mutation turn produced an unapproved mirror change: ${path}`);
    }
  }
  return records.map((record) => {
    const nextContents = mirrorAfter.get(record.relativePath);
    if (record.operation === "delete") {
      if (nextContents !== undefined) {
        throw new Error(`Approved delete was not produced: ${record.relativePath}`);
      }
      return { ...record };
    }
    if (nextContents === undefined) {
      throw new Error(`Approved ${record.operation} was not produced: ${record.relativePath}`);
    }
    if (
      record.operation === "modify" &&
      equalBytes(nextContents, record.originalContents as Uint8Array)
    ) {
      throw new Error(`Approved modify did not change content: ${record.relativePath}`);
    }
    return { ...record, nextContents };
  });
}

async function ensureSafeParentDirectories(
  rootPath: string,
  relativePath: string,
  createdDirectories: string[],
): Promise<void> {
  let current = rootPath;
  for (const segment of relativePath.split("/").slice(0, -1)) {
    current = join(current, segment);
    const entry = await lstatIfPresent(current);
    if (entry === undefined) {
      try {
        await mkdir(current, { mode: 0o755 });
        createdDirectories.push(current);
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) {
          throw error;
        }
      }
    }
    const verified = await lstat(current);
    if (verified.isSymbolicLink()) {
      throw new Error(`Mutation path has a symbolic link ancestor: ${relativePath}`);
    }
    if (!verified.isDirectory()) {
      throw new Error(`Mutation path ancestor is not a directory: ${relativePath}`);
    }
  }
}

async function assertTargetStillMatches(record: TargetRecord): Promise<void> {
  const entry = await lstatIfPresent(record.absolutePath);
  if (record.operation === "create") {
    if (entry !== undefined) {
      throw new Error(`Create target became stale: ${record.relativePath}`);
    }
    return;
  }
  if (entry === undefined || entry.isSymbolicLink() || !entry.isFile()) {
    throw new Error(`Approved target became stale: ${record.relativePath}`);
  }
  const current = await securelyReadRegularFile(record.absolutePath);
  if (
    !equalBytes(current.contents, record.originalContents as Uint8Array) ||
    current.mode !== record.originalMode
  ) {
    throw new Error(`Approved target became stale: ${record.relativePath}`);
  }
}

async function applyTransaction(
  rootPath: string,
  deltas: DeltaRecord[],
  driver: MutationDriver,
): Promise<void> {
  const applied: AppliedDeltaRecord[] = [];
  const createdDirectories: string[] = [];
  let uncertainOperationError: unknown;
  try {
    for (const delta of deltas) {
      await assertSafeAncestors(rootPath, delta.relativePath);
      await assertTargetStillMatches(delta);
      const expected = expectedAppliedTarget(delta);
      try {
        if (delta.operation !== "delete") {
          await ensureSafeParentDirectories(
            rootPath,
            delta.relativePath,
            createdDirectories,
          );
          await driver.write(
            delta.absolutePath,
            delta.nextContents as Uint8Array,
            expected.expectedAppliedMode as number,
          );
        } else {
          await driver.remove(delta.absolutePath);
        }
      } catch (operationError) {
        if (await targetMatchesApplied(expected)) {
          applied.push(expected);
        } else if (!(await targetMatchesOriginal(delta))) {
          uncertainOperationError = new Error(
            `Mutation outcome is indeterminate for ${delta.relativePath}`,
          );
        }
        throw operationError;
      }
      applied.push(expected);
      await assertTargetMatchesApplied(expected);
    }
    await validateAppliedDelta(deltas);
  } catch (commitError) {
    let rollbackError: unknown = uncertainOperationError;
    for (const delta of [...applied].reverse()) {
      try {
        await assertRollbackStillOwnsTarget(delta);
        if (delta.operation === "create") {
          await driver.remove(delta.absolutePath);
        } else {
          await ensureSafeParentDirectories(
            rootPath,
            delta.relativePath,
            createdDirectories,
          );
          await driver.write(
            delta.absolutePath,
            delta.originalContents as Uint8Array,
            delta.originalMode as number,
          );
        }
        await assertTargetMatchesOriginal(delta);
      } catch (error) {
        rollbackError ??= error;
      }
    }
    for (const directoryPath of [...createdDirectories].reverse()) {
      try {
        await rmdir(directoryPath);
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
          rollbackError ??= error;
        }
      }
    }
    for (const delta of deltas) {
      if (!(await targetMatchesOriginal(delta))) {
        rollbackError ??= new Error(
          `Rollback could not prove the original target: ${delta.relativePath}`,
        );
      }
    }
    if (rollbackError !== undefined) {
      throw new MutationTransactionError(
        "RECONCILIATION_REQUIRED",
        "Safe Mode mutation and rollback both failed",
        { commitError, rollbackError },
      );
    }
    throw new MutationTransactionError(
      "FULLY_ROLLED_BACK",
      commitError instanceof Error
        ? commitError.message
        : "Safe Mode mutation failed and was fully rolled back",
      commitError,
    );
  }
}

function expectedAppliedTarget(
  delta: DeltaRecord,
): AppliedDeltaRecord {
  if (delta.operation === "delete") return delta;
  return {
    ...delta,
    expectedAppliedContents: delta.nextContents,
    expectedAppliedMode:
      delta.operation === "modify" ? delta.originalMode : 0o644,
  };
}

function expectedSourcePathEvidence(deltas: readonly DeltaRecord[]): RenderSourcePathEvidence[] {
  return deltas.map((delta) => {
    if (delta.operation === "delete") {
      return { path: delta.relativePath, state: "MISSING" as const };
    }
    const contents = delta.nextContents as Uint8Array;
    return {
      path: delta.relativePath,
      state: "FILE" as const,
      mode: delta.operation === "modify" ? delta.originalMode as number : 0o644,
      size: contents.byteLength,
      contentHash: createHash("sha256").update(contents).digest("hex"),
    };
  });
}

async function targetMatchesApplied(
  delta: AppliedDeltaRecord,
): Promise<boolean> {
  const entry = await lstatIfPresent(delta.absolutePath);
  if (delta.operation === "delete") return entry === undefined;
  if (entry === undefined || entry.isSymbolicLink() || !entry.isFile()) {
    return false;
  }
  try {
    const current = await securelyReadRegularFile(delta.absolutePath);
    return (
      equalBytes(
        current.contents,
        delta.expectedAppliedContents as Uint8Array,
      ) && current.mode === delta.expectedAppliedMode
    );
  } catch {
    return false;
  }
}

async function assertTargetMatchesApplied(
  delta: AppliedDeltaRecord,
): Promise<void> {
  if (!(await targetMatchesApplied(delta))) {
    throw new Error(
      `Approved ${delta.operation} content or mode mismatch: ${delta.relativePath}`,
    );
  }
}

async function targetMatchesOriginal(delta: DeltaRecord): Promise<boolean> {
  const entry = await lstatIfPresent(delta.absolutePath);
  if (delta.operation === "create") return entry === undefined;
  if (entry === undefined || entry.isSymbolicLink() || !entry.isFile()) {
    return false;
  }
  try {
    const current = await securelyReadRegularFile(delta.absolutePath);
    return (
      equalBytes(current.contents, delta.originalContents as Uint8Array) &&
      current.mode === delta.originalMode
    );
  } catch {
    return false;
  }
}

async function assertTargetMatchesOriginal(delta: DeltaRecord): Promise<void> {
  if (!(await targetMatchesOriginal(delta))) {
    throw new Error(
      `Rollback could not restore the original target: ${delta.relativePath}`,
    );
  }
}

async function assertRollbackStillOwnsTarget(
  delta: AppliedDeltaRecord,
): Promise<void> {
  const entry = await lstatIfPresent(delta.absolutePath);
  if (delta.operation === "delete") {
    if (entry !== undefined) {
      throw new Error(
        `Rollback refused to overwrite a recreated target: ${delta.relativePath}`,
      );
    }
    return;
  }
  if (entry === undefined || entry.isSymbolicLink() || !entry.isFile()) {
    throw new Error(
      `Rollback refused because the applied target changed: ${delta.relativePath}`,
    );
  }
  if (!(await targetMatchesApplied(delta))) {
    throw new Error(
      `Rollback refused because another writer changed: ${delta.relativePath}`,
    );
  }
}

async function validateAppliedDelta(deltas: DeltaRecord[]): Promise<void> {
  for (const delta of deltas) {
    const entry = await lstatIfPresent(delta.absolutePath);
    if (delta.operation === "delete") {
      if (entry !== undefined) {
        throw new Error(`Approved delete did not apply: ${delta.relativePath}`);
      }
      continue;
    }
    if (entry === undefined || entry.isSymbolicLink() || !entry.isFile()) {
      throw new Error(`Approved ${delta.operation} did not apply: ${delta.relativePath}`);
    }
    const current = await securelyReadRegularFile(delta.absolutePath);
    if (!equalBytes(current.contents, delta.nextContents as Uint8Array)) {
      throw new Error(`Approved ${delta.operation} content mismatch: ${delta.relativePath}`);
    }
  }
}

function boundedAppend(
  chunks: Buffer[],
  chunk: Buffer,
  currentBytes: number,
): number {
  const remaining = MAX_GIT_OUTPUT_BYTES - currentBytes;
  if (remaining > 0) chunks.push(chunk.subarray(0, remaining));
  return currentBytes + chunk.byteLength;
}

function decodeUtf8Prefix(value: Uint8Array): string {
  for (let end = value.byteLength; end >= Math.max(0, value.byteLength - 3); end -= 1) {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(
        value.subarray(0, end),
      );
    } catch {
      // A UTF-8 code point can span at most four bytes. Trim only the
      // incomplete trailing sequence; never rewrite literal evidence.
    }
  }
  return "";
}

function boundedUtf8(
  value: string,
  maximumBytes: number,
): { value: string; truncation: GitEvidenceTruncation } {
  const encoded = Buffer.from(value, "utf8");
  if (encoded.byteLength <= maximumBytes) {
    return {
      value,
      truncation: {
        truncated: false,
        limitBytes: maximumBytes,
        originalBytes: encoded.byteLength,
        retainedBytes: encoded.byteLength,
      },
    };
  }
  const retained = decodeUtf8Prefix(encoded.subarray(0, maximumBytes));
  return {
    value: retained,
    truncation: {
      truncated: true,
      limitBytes: maximumBytes,
      originalBytes: encoded.byteLength,
      retainedBytes: Buffer.byteLength(retained, "utf8"),
    },
  };
}

function mergeTruncation(
  source: GitEvidenceTruncation,
  retained: GitEvidenceTruncation,
  sourceOriginalBytes = source.originalBytes,
): GitEvidenceTruncation {
  const truncated = source.truncated || retained.truncated;
  return {
    truncated,
    limitBytes: retained.limitBytes,
    originalBytes: truncated
      ? Math.max(sourceOriginalBytes, retained.originalBytes)
      : retained.originalBytes,
    retainedBytes: retained.retainedBytes,
  };
}

function redactSensitiveGitOutput(value: string): string {
  const secrets = Object.entries(process.env)
    .filter(
      ([key, secret]) =>
        /(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|CREDENTIAL|PRIVATE_KEY|AUTH)/i.test(
          key,
        ) &&
        typeof secret === "string" &&
        secret.length >= 8,
    )
    .map(([, secret]) => secret as string)
    .sort((left, right) => right.length - left.length);
  let redacted = value;
  for (const secret of secrets) {
    redacted = redacted.split(secret).join("[REDACTED]");
  }
  return redacted.replace(
    /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{16,})\b/g,
    "[REDACTED]",
  );
}

const hardenedGitConfig = [
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.untrackedCache=false",
  "-c",
  `core.hooksPath=${devNull}`,
  "-c",
  "diff.external=",
  "-c",
  "pager.diff=false",
] as const;

async function runGit(
  cwd: string,
  args: readonly string[],
): Promise<{
  ok: boolean;
  output: string;
  truncation: GitEvidenceTruncation;
}> {
  return new Promise((resolvePromise) => {
    const chunks: Buffer[] = [];
    let outputBytes = 0;
    let finished = false;
    const gitEnvironment: NodeJS.ProcessEnv = {
      NODE_ENV: process.env.NODE_ENV,
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: devNull,
      GIT_ATTR_NOSYSTEM: "1",
      GIT_OPTIONAL_LOCKS: "0",
      GIT_PAGER: "cat",
      GIT_TERMINAL_PROMPT: "0",
      LC_ALL: "C",
      LANG: "C",
    };
    const child = spawn("git", [...hardenedGitConfig, ...args], {
      cwd,
      env: gitEnvironment,
      shell: false,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, GIT_TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => {
      outputBytes = boundedAppend(chunks, chunk, outputBytes);
    });
    const finish = (ok: boolean) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      const truncated = outputBytes > MAX_GIT_OUTPUT_BYTES;
      const raw = decodeUtf8Prefix(Buffer.concat(chunks));
      const output = truncated ? raw : raw.trimEnd();
      resolvePromise({
        ok,
        output,
        truncation: {
          truncated,
          limitBytes: MAX_GIT_OUTPUT_BYTES,
          originalBytes: truncated
            ? outputBytes
            : Buffer.byteLength(output, "utf8"),
          retainedBytes: Buffer.byteLength(output, "utf8"),
        },
      });
    };
    child.once("error", () => finish(false));
    child.once("close", (code) => finish(code === 0));
  });
}

async function captureGitBefore(
  rootPath: string,
): Promise<GitBefore> {
  const repository = await runGit(rootPath, [
    "rev-parse",
    "--is-inside-work-tree",
  ]);
  if (!repository.ok || repository.output !== "true") {
    return {
      available: false,
      statusBefore: "",
      branchTruncation: {
        truncated: false,
        limitBytes: MAX_GIT_OUTPUT_BYTES,
        originalBytes: 0,
        retainedBytes: 0,
      },
      statusBeforeTruncation: {
        truncated: false,
        limitBytes: MAX_GIT_OUTPUT_BYTES,
        originalBytes: 0,
        retainedBytes: 0,
      },
      note: "Git metadata is unavailable for this project.",
    };
  }
  const [branch, status] = await Promise.all([
    runGit(rootPath, ["symbolic-ref", "--quiet", "--short", "HEAD"]),
    runGit(rootPath, ["status", "--porcelain=v1", "--untracked-files=all", "--", "."]),
  ]);
  return {
    available: true,
    branch: branch.ok ? branch.output : "DETACHED",
    statusBefore: status.ok ? status.output : "Git status before was unavailable.",
    branchTruncation: branch.truncation,
    statusBeforeTruncation: status.truncation,
    ...(!status.ok ||
    status.truncation.truncated
      ? { note: "Some Git before-state evidence was unavailable." }
      : {}),
  };
}

async function captureGitAfter(
  rootPath: string,
  before: GitBefore,
  deltas: readonly DeltaRecord[],
): Promise<GitMutationEvidence> {
  const authoritativeDelta = deltas.map(renderApprovedFileDiff).join("\n");
  const diffAfter = boundedUtf8(
    redactSensitiveGitOutput(authoritativeDelta),
    MAX_GIT_OUTPUT_BYTES,
  );
  const authorityNote =
    "Git status is observational filename evidence; diff evidence is the authoritative executor-captured approved delta.";
  if (!before.available) {
    return {
      available: false,
      statusBefore: before.statusBefore,
      statusAfter: "",
      diffAfter: diffAfter.value,
      truncation: {
        branch: { truncated: false, limitBytes: MAX_GIT_OUTPUT_BYTES, originalBytes: 0, retainedBytes: 0 },
        statusBefore: { truncated: false, limitBytes: MAX_GIT_OUTPUT_BYTES, originalBytes: 0, retainedBytes: 0 },
        statusAfter: { truncated: false, limitBytes: MAX_GIT_OUTPUT_BYTES, originalBytes: 0, retainedBytes: 0 },
        diffAfter: diffAfter.truncation,
      },
      note: `${authorityNote} ${before.note ?? "Git metadata is unavailable for this project."}`,
    };
  }
  const status = await runGit(rootPath, [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
    "--",
    ".",
  ]);
  const branch =
    before.branch === undefined
      ? undefined
      : boundedUtf8(redactSensitiveGitOutput(before.branch), MAX_GIT_OUTPUT_BYTES);
  const statusBefore = boundedUtf8(
    redactSensitiveGitOutput(before.statusBefore),
    MAX_GIT_OUTPUT_BYTES,
  );
  const statusAfter = status.ok
    ? boundedUtf8(redactSensitiveGitOutput(status.output), MAX_GIT_OUTPUT_BYTES)
    : boundedUtf8("Git status after was unavailable.", MAX_GIT_OUTPUT_BYTES);
  return {
    available: true,
    branch: branch?.value,
    statusBefore: statusBefore.value,
    statusAfter: statusAfter.value,
    diffAfter: diffAfter.value,
    truncation: {
      branch:
        branch === undefined
          ? { truncated: false, limitBytes: MAX_GIT_OUTPUT_BYTES, originalBytes: 0, retainedBytes: 0 }
          : mergeTruncation(
              before.branchTruncation,
              branch.truncation,
            ),
      statusBefore: mergeTruncation(
        before.statusBeforeTruncation,
        statusBefore.truncation,
      ),
      statusAfter: mergeTruncation(
        status.truncation,
        statusAfter.truncation,
      ),
      diffAfter: diffAfter.truncation,
    },
    ...(!status.ok ||
    status.truncation.truncated
      ? {
          note: `${authorityNote} Some Git status evidence was unavailable or exceeded bounds.`,
        }
      : before.note === undefined
        ? { note: authorityNote }
        : { note: `${authorityNote} ${before.note}` }),
  };
}

function decodeText(contents: Uint8Array): string | undefined {
  try {
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(contents);
    return decoded.includes("\0") ? undefined : decoded;
  } catch {
    return undefined;
  }
}

function linesForEvidence(contents: string): string[] {
  if (contents.length === 0) return [];
  return contents.endsWith("\n")
    ? contents.slice(0, -1).split("\n")
    : contents.split("\n");
}

function gitFileMode(mode: number): string {
  return `100${(mode & 0o777).toString(8).padStart(3, "0")}`;
}

function renderApprovedFileDiff(delta: DeltaRecord): string {
  const before =
    delta.operation === "create"
      ? undefined
      : decodeText(delta.originalContents as Uint8Array);
  const after =
    delta.operation === "delete"
      ? undefined
      : decodeText(delta.nextContents as Uint8Array);
  const beforeMode =
    delta.operation === "create"
      ? undefined
      : gitFileMode(delta.originalMode as number);
  const afterMode =
    delta.operation === "delete"
      ? undefined
      : gitFileMode(delta.operation === "create" ? 0o644 : delta.originalMode as number);
  const modeEvidence = [
    ...(delta.operation === "create" ? [`new file mode ${afterMode}`] : []),
    ...(delta.operation === "delete" ? [`deleted file mode ${beforeMode}`] : []),
    ...(delta.operation === "modify"
      ? [`old mode ${beforeMode}`, `new mode ${afterMode}`]
      : []),
  ];
  if (
    (delta.operation !== "create" && before === undefined) ||
    (delta.operation !== "delete" && after === undefined)
  ) {
    return [
      `diff --git a/${delta.relativePath} b/${delta.relativePath}`,
      ...modeEvidence,
      `Binary files ${
        delta.operation === "create" ? "/dev/null" : `a/${delta.relativePath}`
      } and ${
        delta.operation === "delete" ? "/dev/null" : `b/${delta.relativePath}`
      } differ`,
    ].join("\n");
  }
  const beforeLines = before === undefined ? [] : linesForEvidence(before);
  const afterLines = after === undefined ? [] : linesForEvidence(after);
  return [
    `diff --git a/${delta.relativePath} b/${delta.relativePath}`,
    ...modeEvidence,
    delta.operation === "create" ? "--- /dev/null" : `--- a/${delta.relativePath}`,
    delta.operation === "delete" ? "+++ /dev/null" : `+++ b/${delta.relativePath}`,
    `@@ -${beforeLines.length === 0 ? "0,0" : `1,${beforeLines.length}`} +${
      afterLines.length === 0 ? "0,0" : `1,${afterLines.length}`
    } @@`,
    ...beforeLines.map((line) => `-${line}`),
    ...(before !== undefined && before.length > 0 && !before.endsWith("\n")
      ? ["\\ No newline at end of file"]
      : []),
    ...afterLines.map((line) => `+${line}`),
    ...(after !== undefined && after.length > 0 && !after.endsWith("\n")
      ? ["\\ No newline at end of file"]
      : []),
  ].join("\n");
}

async function acquireExecutionClaim(
  rootPath: string,
  proposalId: string,
): Promise<{ handle: Awaited<ReturnType<typeof open>>; path: string }> {
  const claimRoot = join(
    await realpath(tmpdir()),
    "design-sharingan-safe-mode-claims",
  );
  await mkdir(claimRoot, { mode: 0o700 }).catch(async (error: unknown) => {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) {
      throw error;
    }
  });
  const [entry, canonical] = await Promise.all([lstat(claimRoot), realpath(claimRoot)]);
  if (
    entry.isSymbolicLink() ||
    !entry.isDirectory() ||
    (entry.mode & 0o077) !== 0 ||
    canonical !== claimRoot
  ) {
    throw new Error("Safe Mode execution claim directory is not private");
  }
  const digest = createHash("sha256")
    .update(rootPath)
    .digest("hex");
  const path = join(claimRoot, `${digest}.claim`);
  try {
    const handle = await open(
      path,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    await handle.writeFile(`${proposalId}\n`, "utf8");
    await handle.sync();
    return { handle, path };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      throw new Error("This approved proposal is already being executed");
    }
    throw error;
  }
}

function mutationPrompt(proposal: ChangeProposal): string {
  return [
    "Continue the exact approved Safe Mode proposal thread and implement the approved delta in this executor-owned mutation mirror.",
    "Mutate only the exact create/modify/delete paths listed below. Do not touch any other path, install dependencies, run project commands, commit Git changes, or access another workspace.",
    "The executor will reject any missing operation, extra operation, symlink, protected path, oversized output, or scope mismatch before applying anything to the active target.",
    `Approved proposal:\n${JSON.stringify(proposal, null, 2)}`,
  ].join("\n\n");
}

export class MutationExecutor {
  private readonly options: MutationExecutorOptions;

  constructor(options: MutationExecutorOptions) {
    this.options = options;
  }

  async apply(input: {
    proposal: ChangeProposal;
    approval: Approval | undefined;
  }): Promise<MutationResult> {
    return this.applyAuthorized(input.proposal, () =>
      validateGate(input.proposal, input.approval),
    );
  }

  async applyAutonomous(input: {
    proposal: ChangeProposal;
    authorization: AutonomousMutationAuthorization;
    now: Date;
  }): Promise<MutationResult> {
    return this.applyAuthorized(input.proposal, () =>
      validateAutonomousGate(input.proposal, input.authorization, input.now),
    );
  }

  async applyApproveOnce(input: ExecuteApproveOnceMutationInput): Promise<MutationResult> {
    return this.applyAuthorized(input.proposal, () => validateApproveOnceGate(input));
  }

  private async applyAuthorized(
    proposal: ChangeProposal,
    validateAuthorization: () => void,
  ): Promise<MutationResult> {
    let claim:
      | { handle: Awaited<ReturnType<typeof open>>; path: string }
      | undefined;
    let mirrorRoot: string | undefined;
    let targetMutationApplied = false;
    try {
      validateAuthorization();
      if (
        this.options.proposalThreadId.length === 0 ||
        Buffer.byteLength(this.options.proposalThreadId, "utf8") > 256
      ) {
        throw new Error("Safe Mode proposal thread id is invalid");
      }
      const requestedRecords = validateProposalPaths(proposal);
      const rootPath = await canonicalWorkspaceRoot(this.options.workspaceRoot);
      claim = await acquireExecutionClaim(rootPath, proposal.id);
      const targetRecords = await captureTargetRecords(rootPath, requestedRecords);
      const gitBefore = await captureGitBefore(rootPath);
      mirrorRoot = await mkdtemp(
        join(await realpath(tmpdir()), "design-sharingan-mutation-"),
      );
      const canonicalMirror = await realpath(mirrorRoot);
      if (
        canonicalMirror !== mirrorRoot ||
        pathIsContained(rootPath, canonicalMirror) ||
        pathIsContained(canonicalMirror, rootPath)
      ) {
        throw new Error("Mutation mirror and target workspace must be disjoint");
      }
      await seedMirror(canonicalMirror, targetRecords);
      const result = await this.options.agent.run({
        workingDirectory: canonicalMirror,
        prompt: mutationPrompt(proposal),
        threadId: this.options.proposalThreadId,
      });
      if (result.threadId !== this.options.proposalThreadId) {
        throw new Error("Mutation turn did not continue the same proposal thread");
      }
      const mirrorAfter = await snapshotMirror(canonicalMirror);
      const deltas = validateMirrorDelta(targetRecords, mirrorAfter);
      await this.options.assertWorkerOwnership?.();
      // Reject a stale target only after the isolated mutation turn has
      // completed, immediately before the first active-workspace write.
      for (const record of targetRecords) {
        await assertSafeAncestors(rootPath, record.relativePath);
        await assertTargetStillMatches(record);
      }
      await applyTransaction(
        rootPath,
        deltas,
        this.options.mutationDriver ?? defaultMutationDriver,
      );
      targetMutationApplied = true;
      // Git is observational evidence and may await an external process. Gather
      // it before the transaction's final authenticated source snapshot and
      // applied-byte verification so no asynchronous interval remains after
      // the exact mutation evidence is established.
      const git = await captureGitAfter(rootPath, gitBefore, deltas);
      let sourceRevision: RenderSourceRevision | undefined;
      if (this.options.captureSourceRevision !== undefined) {
        await validateAppliedDelta(deltas);
        sourceRevision = await this.options.captureSourceRevision({
          workspaceRoot: rootPath,
          requiredPaths: deltas.map(({ relativePath }) => relativePath),
        });
        await validateAppliedDelta(deltas);
        if (
          sourceRevision.available !== true ||
          sourceRevision.truncated ||
          !/^[0-9a-f]{64}$/.test(sourceRevision.worktreeFingerprint) ||
          !Number.isSafeInteger(sourceRevision.fileCount) ||
          sourceRevision.fileCount < sourceRevision.requiredPathEvidence.length ||
          sourceRevision.fileCount > 512 ||
          stableJson(sourceRevision.requiredPathEvidence) !==
            stableJson(expectedSourcePathEvidence(deltas))
        ) {
          throw new Error("Post-mutation source evidence does not match the exact applied bytes and modes");
        }
      }
      return {
        proposalId: proposal.id,
        threadId: result.threadId,
        filesChanged: deltas.map((delta) => delta.relativePath),
        git,
        ...(sourceRevision === undefined ? {} : { sourceRevision }),
      };
    } catch (error) {
      if (error instanceof SafeMutationExecutionError) throw error;
      const targetDisposition =
        error instanceof MutationTransactionError
          ? error.targetDisposition
          : targetMutationApplied
            ? "RECONCILIATION_REQUIRED"
            : "NO_TARGET_CHANGE";
      throw new SafeMutationExecutionError(
        targetDisposition,
        [
          ...proposal.filesToCreate,
          ...proposal.filesToModify,
          ...proposal.filesToDelete,
        ],
        error,
      );
    } finally {
      if (mirrorRoot !== undefined) {
        await rm(mirrorRoot, { force: true, recursive: true }).catch(() => undefined);
      }
      await claim?.handle.close().catch(() => undefined);
      if (claim !== undefined) {
        await rm(claim.path, { force: true }).catch(() => undefined);
      }
    }
  }
}

export async function executePolicyAuthorizedMutation(
  input: ExecutePolicyAuthorizedMutationInput,
  store: PolicyAuthorizationStore,
): Promise<PolicyAuthorizedMutationResult> {
  if (
    !safeIdentifier(input.loopSessionId) ||
    input.proposal.sessionId !== input.loopSessionId ||
    input.proposalThreadId.length === 0 ||
    Buffer.byteLength(input.proposalThreadId, "utf8") > 256 ||
    !validAutonomyPolicy(input.policy)
  ) {
    throw new Error("Autonomous mutation request is invalid or ambiguous");
  }
  const evaluation = evaluateAutonomyPolicy(input.policy, input.change);
  if (evaluation.decision === "HUMAN_GATE") {
    return {
      decision: "HUMAN_GATE",
      evaluation: { decision: "HUMAN_GATE", reasons: [...evaluation.reasons] },
    };
  }
  const evaluatedAt = store.now();
  if (!Number.isFinite(evaluatedAt.getTime())) {
    throw new Error("Autonomy policy evaluation time is invalid");
  }
  const authorization: AutonomousMutationAuthorization = {
    kind: "AUTONOMOUS_POLICY_ALLOW",
    id: store.createId(),
    loopSessionId: input.loopSessionId,
    proposalId: input.proposal.id,
    proposalThreadId: input.proposalThreadId,
    change: { kind: input.change.kind, files: [...input.change.files] },
    policy: {
      ...input.policy,
      protectedPaths: [...input.policy.protectedPaths],
    },
    evaluation: { decision: "ALLOW", reasons: [] },
    evaluatedAt: evaluatedAt.toISOString(),
    expiresAt: new Date(evaluatedAt.getTime() + 5 * 60_000).toISOString(),
  };
  validateAutonomousGate(input.proposal, authorization, evaluatedAt);
  await input.assertWorkerOwnership?.("AUTHORIZATION");
  await store.persistAuthorization(authorization);
  const persisted = await store.loadAuthorization(authorization.id);
  if (stableJson(persisted) !== stableJson(authorization)) {
    throw new Error("Persisted autonomy authorization is missing, stale, ambiguous, or invalid");
  }
  const executionTime = store.now();
  validateAutonomousGate(
    input.proposal,
    persisted as AutonomousMutationAuthorization,
    executionTime,
  );
  const mutation = await new MutationExecutor({
    workspaceRoot: input.workspaceRoot,
    proposalThreadId: input.proposalThreadId,
    agent: input.agent,
    ...(input.mutationDriver === undefined
      ? {}
      : { mutationDriver: input.mutationDriver }),
    ...(input.captureSourceRevision === undefined
      ? {}
      : { captureSourceRevision: input.captureSourceRevision }),
    ...(input.assertWorkerOwnership === undefined
      ? {}
      : {
          assertWorkerOwnership: () =>
            input.assertWorkerOwnership?.("MUTATION_EXECUTION") ?? Promise.resolve(),
        }),
  }).applyAutonomous({
    proposal: input.proposal,
    authorization: persisted as AutonomousMutationAuthorization,
    now: executionTime,
  });
  return { decision: "APPLIED", authorization, mutation };
}

export async function executeApproveOnceMutation(
  input: ExecuteApproveOnceMutationInput,
): Promise<MutationResult> {
  validateApproveOnceGate(input);
  await input.assertWorkerOwnership?.("AUTHORIZATION");
  await input.consumeAuthorization({
    loopSessionId: input.loopSessionId,
    sessionVersion: input.sessionVersion,
    gateId: input.gate.id,
    decisionId: input.decision.id,
    proposalId: input.proposal.id,
  });
  return new MutationExecutor({
    workspaceRoot: input.workspaceRoot,
    proposalThreadId: input.proposalThreadId,
    agent: input.agent,
    ...(input.mutationDriver === undefined ? {} : { mutationDriver: input.mutationDriver }),
    ...(input.captureSourceRevision === undefined
      ? {}
      : { captureSourceRevision: input.captureSourceRevision }),
    ...(input.assertWorkerOwnership === undefined
      ? {}
      : {
          assertWorkerOwnership: () =>
            input.assertWorkerOwnership?.("MUTATION_EXECUTION") ?? Promise.resolve(),
        }),
  }).applyApproveOnce(input);
}
