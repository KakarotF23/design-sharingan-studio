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
import { tmpdir } from "node:os";
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
import type { Approval, ChangeProposal } from "@design-sharingan/core";

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
  note?: string;
}

export interface MutationResult {
  proposalId: string;
  threadId: string;
  filesChanged: string[];
  git: GitMutationEvidence;
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

interface GitBefore {
  available: boolean;
  branch?: string;
  statusBefore: string;
  note?: string;
}

export interface MutationExecutorOptions {
  workspaceRoot: string;
  proposalThreadId: string;
  agent: MutationAgent;
  mutationDriver?: MutationDriver;
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
    path.length <= 512 &&
    !path.includes("\0") &&
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
    fileName === ".env" ||
    fileName.startsWith(".env.") ||
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
        record.originalContents as Uint8Array,
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
  if (!equalBytes(current.contents, record.originalContents as Uint8Array)) {
    throw new Error(`Approved target became stale: ${record.relativePath}`);
  }
}

async function applyTransaction(
  rootPath: string,
  deltas: DeltaRecord[],
  driver: MutationDriver,
): Promise<void> {
  const applied: DeltaRecord[] = [];
  const createdDirectories: string[] = [];
  try {
    for (const delta of deltas) {
      await assertSafeAncestors(rootPath, delta.relativePath);
      await assertTargetStillMatches(delta);
      if (delta.operation !== "delete") {
        await ensureSafeParentDirectories(
          rootPath,
          delta.relativePath,
          createdDirectories,
        );
        await driver.write(
          delta.absolutePath,
          delta.nextContents as Uint8Array,
          delta.operation === "modify"
            ? (delta.originalMode as number)
            : 0o644,
        );
      } else {
        await driver.remove(delta.absolutePath);
      }
      applied.push(delta);
    }
    await validateAppliedDelta(deltas);
  } catch (commitError) {
    let rollbackError: unknown;
    for (const delta of [...applied].reverse()) {
      try {
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
      } catch (error) {
        rollbackError ??= error;
      }
    }
    for (const directoryPath of [...createdDirectories].reverse()) {
      await rmdir(directoryPath).catch(() => undefined);
    }
    if (rollbackError !== undefined) {
      throw new Error("Safe Mode mutation and rollback both failed", {
        cause: { commitError, rollbackError },
      });
    }
    throw commitError;
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

async function runGit(
  cwd: string,
  args: readonly string[],
): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolvePromise) => {
    const chunks: Buffer[] = [];
    let outputBytes = 0;
    let finished = false;
    const environment = Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) => !key.toUpperCase().startsWith("GIT_"),
      ),
    ) as NodeJS.ProcessEnv;
    const child = spawn("git", [...args], {
      cwd,
      env: environment,
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
      const raw = Buffer.concat(chunks).toString("utf8");
      resolvePromise({
        ok: ok && outputBytes <= MAX_GIT_OUTPUT_BYTES,
        output: raw.trimEnd(),
      });
    };
    child.once("error", () => finish(false));
    child.once("close", (code) => finish(code === 0));
  });
}

async function captureGitBefore(rootPath: string): Promise<GitBefore> {
  const repository = await runGit(rootPath, [
    "rev-parse",
    "--is-inside-work-tree",
  ]);
  if (!repository.ok || repository.output !== "true") {
    return {
      available: false,
      statusBefore: "",
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
    ...(!status.ok ? { note: "Some Git before-state evidence was unavailable." } : {}),
  };
}

async function captureGitAfter(
  rootPath: string,
  before: GitBefore,
): Promise<GitMutationEvidence> {
  if (!before.available) {
    return {
      available: false,
      statusBefore: before.statusBefore,
      statusAfter: "",
      diffAfter: "",
      note: before.note,
    };
  }
  const [status, diff] = await Promise.all([
    runGit(rootPath, ["status", "--porcelain=v1", "--untracked-files=all", "--", "."]),
    runGit(rootPath, ["diff", "--no-ext-diff", "--", "."]),
  ]);
  return {
    available: true,
    branch: before.branch,
    statusBefore: before.statusBefore,
    statusAfter: status.ok ? status.output : "Git status after was unavailable.",
    diffAfter: diff.ok ? diff.output : "Git diff after was unavailable.",
    ...(!status.ok || !diff.ok
      ? { note: "Some Git after-state evidence was unavailable or exceeded bounds." }
      : before.note === undefined
        ? {}
        : { note: before.note }),
  };
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
    .update(`${rootPath}\0${proposalId}`)
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
    validateGate(input.proposal, input.approval);
    if (
      this.options.proposalThreadId.length === 0 ||
      this.options.proposalThreadId.length > 256
    ) {
      throw new Error("Safe Mode proposal thread id is invalid");
    }
    const requestedRecords = validateProposalPaths(input.proposal);
    const rootPath = await canonicalWorkspaceRoot(this.options.workspaceRoot);
    const claim = await acquireExecutionClaim(rootPath, input.proposal.id);
    let mirrorRoot: string | undefined;
    try {
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
        prompt: mutationPrompt(input.proposal),
        threadId: this.options.proposalThreadId,
      });
      if (result.threadId !== this.options.proposalThreadId) {
        throw new Error("Mutation turn did not continue the same proposal thread");
      }
      const mirrorAfter = await snapshotMirror(canonicalMirror);
      const deltas = validateMirrorDelta(targetRecords, mirrorAfter);
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
      const git = await captureGitAfter(rootPath, gitBefore);
      return {
        proposalId: input.proposal.id,
        threadId: result.threadId,
        filesChanged: deltas.map((delta) => delta.relativePath),
        git,
      };
    } finally {
      if (mirrorRoot !== undefined) {
        await rm(mirrorRoot, { force: true, recursive: true }).catch(() => undefined);
      }
      await claim.handle.close().catch(() => undefined);
      await rm(claim.path, { force: true }).catch(() => undefined);
    }
  }
}
