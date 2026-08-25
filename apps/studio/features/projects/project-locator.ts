import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, normalize } from "node:path";
import type { Project } from "@design-sharingan/core";
import { loadProjectMetadata } from "@design-sharingan/project-adapters";

export const PROJECT_LOCATOR_COOKIE = "design-sharingan-project";

const LOCATOR_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const MAX_LOCATOR_RECORD_BYTES = 4096;

interface ProjectLocatorRecord {
  version: 1;
  projectId: string;
  canonicalRootPath: string;
}

function validProjectId(projectId: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9-]{0,127}$/.test(projectId);
}

function stateRootPath(): string {
  const configured = process.env.DESIGN_SHARINGAN_STATE_ROOT;
  const rootPath =
    configured ??
    join(
      isAbsolute(process.env.XDG_STATE_HOME ?? "")
        ? (process.env.XDG_STATE_HOME as string)
        : join(homedir(), ".local", "state"),
      "design-sharingan-studio",
    );
  if (
    rootPath.length === 0 ||
    rootPath.length > 4096 ||
    rootPath.includes("\0") ||
    !isAbsolute(rootPath) ||
    normalize(rootPath) !== rootPath
  ) {
    throw new Error("Project locator state root must be a normalized absolute path");
  }
  return rootPath;
}

async function validateStateDirectory(create: boolean): Promise<string> {
  const rootPath = stateRootPath();
  if (create) {
    await mkdir(/* turbopackIgnore: true */ rootPath, {
      recursive: true,
      mode: 0o700,
    });
  }

  const entry = await lstat(/* turbopackIgnore: true */ rootPath);
  if (
    entry.isSymbolicLink() ||
    !entry.isDirectory() ||
    (entry.mode & 0o077) !== 0 ||
    (await realpath(/* turbopackIgnore: true */ rootPath)) !== rootPath
  ) {
    throw new Error("Project locator state directory is not private");
  }
  return rootPath;
}

async function canonicalProjectRoot(rootPath: string): Promise<string> {
  if (
    rootPath.length === 0 ||
    rootPath.length > 2048 ||
    rootPath.includes("\0") ||
    !isAbsolute(rootPath)
  ) {
    throw new Error("Project root must be an absolute canonical path");
  }
  const [canonicalRoot, entry] = await Promise.all([
    realpath(rootPath),
    lstat(rootPath),
  ]);
  if (
    canonicalRoot !== rootPath ||
    entry.isSymbolicLink() ||
    !entry.isDirectory()
  ) {
    throw new Error("Project root must be an absolute canonical path");
  }
  return canonicalRoot;
}

export async function createProjectLocator(
  projectId: string,
  rootPath: string,
): Promise<string> {
  if (!validProjectId(projectId)) {
    throw new Error("Project id is invalid");
  }
  const [stateRoot, canonicalRootPath] = await Promise.all([
    validateStateDirectory(true),
    canonicalProjectRoot(rootPath),
  ]);
  const contents = `${JSON.stringify({
    version: 1,
    projectId,
    canonicalRootPath,
  } satisfies ProjectLocatorRecord)}\n`;
  if (Buffer.byteLength(contents, "utf8") > MAX_LOCATOR_RECORD_BYTES) {
    throw new Error("Project locator record is too large");
  }

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const locator = randomBytes(32).toString("base64url");
    const locatorPath = join(stateRoot, `${locator}.json`);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(
        /* turbopackIgnore: true */ locatorPath,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        0o600,
      );
      await handle.writeFile(contents, "utf8");
      await handle.sync();
      const entry = await handle.stat();
      if (!entry.isFile() || (entry.mode & 0o077) !== 0) {
        throw new Error("Project locator state file is not private");
      }
      return locator;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "EEXIST") {
        continue;
      }
      throw error;
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }
  throw new Error("Could not allocate a unique project locator");
}

async function readBoundedLocatorRecord(
  handle: Awaited<ReturnType<typeof open>>,
): Promise<string> {
  const buffer = Buffer.alloc(MAX_LOCATOR_RECORD_BYTES + 1);
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
  if (total > MAX_LOCATOR_RECORD_BYTES) {
    throw new Error("Project locator record is too large");
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(
    buffer.subarray(0, total),
  );
}

function parseLocatorRecord(
  contents: string,
  expectedProjectId: string,
): ProjectLocatorRecord {
  const parsed: unknown = JSON.parse(contents);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Project locator record is invalid");
  }
  const record = parsed as Partial<ProjectLocatorRecord>;
  if (
    record.version !== 1 ||
    record.projectId !== expectedProjectId ||
    typeof record.canonicalRootPath !== "string" ||
    record.canonicalRootPath.length === 0 ||
    record.canonicalRootPath.length > 2048 ||
    record.canonicalRootPath.includes("\0") ||
    !isAbsolute(record.canonicalRootPath)
  ) {
    throw new Error("Project locator record is invalid");
  }
  return record as ProjectLocatorRecord;
}

export async function resolveProjectLocator(
  locator: string,
  expectedProjectId: string,
): Promise<Project> {
  try {
    if (!LOCATOR_PATTERN.test(locator) || !validProjectId(expectedProjectId)) {
      throw new Error("Project locator is invalid");
    }
    const stateRoot = await validateStateDirectory(false);
    const locatorPath = join(stateRoot, `${locator}.json`);
    const pathEntry = await lstat(/* turbopackIgnore: true */ locatorPath);
    if (
      pathEntry.isSymbolicLink() ||
      !pathEntry.isFile() ||
      (pathEntry.mode & 0o077) !== 0 ||
      pathEntry.size > MAX_LOCATOR_RECORD_BYTES
    ) {
      throw new Error("Project locator state file is invalid");
    }

    const handle = await open(
      /* turbopackIgnore: true */ locatorPath,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const handleEntry = await handle.stat();
      if (
        !handleEntry.isFile() ||
        (handleEntry.mode & 0o077) !== 0 ||
        handleEntry.dev !== pathEntry.dev ||
        handleEntry.ino !== pathEntry.ino
      ) {
        throw new Error("Project locator state file changed");
      }
      const record = parseLocatorRecord(
        await readBoundedLocatorRecord(handle),
        expectedProjectId,
      );
      return await loadProjectMetadata(
        record.canonicalRootPath,
        expectedProjectId,
      );
    } finally {
      await handle.close().catch(() => undefined);
    }
  } catch {
    throw new Error("Project locator could not be validated");
  }
}
