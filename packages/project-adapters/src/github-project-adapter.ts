import { randomUUID } from "node:crypto";
import { lstat, mkdtemp, readFile, readdir, realpath } from "node:fs/promises";
import { devNull } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { Project } from "@design-sharingan/core";
import { detectProject } from "./detect-project";
import { defaultGitRunner, type GitRunner } from "./git";
import { assertPathInsideWorkspace } from "./path-policy";
import type { AdapterRuntime, ProjectWorkspace } from "./types";
import {
  saveGuardedProjectMetadata,
  type WorkspaceOwnership,
} from "./workspace-store";

export interface GitHubProjectInput {
  repositoryUrl: string;
  branch: string;
  token?: string;
  /**
   * Preferred clone path. Its canonical parent bounds allocation, while the
   * returned ProjectWorkspace.rootPath is the authoritative unique workspace.
   */
  destinationPath: string;
}

export interface GitHubProjectAdapterOptions {
  gitRunner?: GitRunner;
  runtime?: AdapterRuntime;
}

const defaultRuntime: AdapterRuntime = {
  createId: randomUUID,
  now: () => new Date(),
};

function validateRepositoryUrl(repositoryUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(repositoryUrl);
  } catch {
    throw new Error("A valid GitHub repository URL is required");
  }

  if (
    parsed.protocol !== "https:" ||
    parsed.hostname.toLowerCase() !== "github.com"
  ) {
    throw new Error("A valid GitHub HTTPS repository URL is required");
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw new Error("Repository URL must not include credentials");
  }
  if (parsed.search !== "" || parsed.hash !== "") {
    throw new Error("Repository URL must not include query parameters or fragments");
  }
}

function validateBranch(branch: string): void {
  if (branch.trim() === "" || /[\0\r\n]/.test(branch)) {
    throw new Error("A valid Git branch is required");
  }
}

async function cloneLocation(destinationPath: string): Promise<{
  parentPath: string;
  destinationPath: string;
}> {
  const absoluteDestination = resolve(destinationPath);
  const parentPath = await realpath(dirname(absoluteDestination));
  const canonicalDestination = assertPathInsideWorkspace(
    parentPath,
    join(parentPath, basename(absoluteDestination)),
  );

  await assertDestinationAbsent(canonicalDestination);
  return { parentPath, destinationPath: canonicalDestination };
}

async function assertDestinationAbsent(destinationPath: string): Promise<void> {
  try {
    await lstat(destinationPath);
    throw new Error("Git clone destination must not already exist");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return;
    }
    throw error;
  }
}

interface DirectoryIdentity {
  dev: number;
  ino: number;
}

interface CloneStaging {
  path: string;
  identity: DirectoryIdentity;
}

async function verifyOwnedDirectory(
  allowedRoot: string,
  directoryPath: string,
  identity: DirectoryIdentity,
  label: string,
): Promise<void> {
  const entry = await lstat(directoryPath);
  if (entry.isSymbolicLink() || !entry.isDirectory()) {
    throw new Error(`${label} must remain a real directory`);
  }
  if (entry.dev !== identity.dev || entry.ino !== identity.ino) {
    throw new Error(`${label} identity changed during Git import`);
  }

  const canonicalPath = await realpath(directoryPath);
  const containedPath = assertPathInsideWorkspace(allowedRoot, canonicalPath);
  if (containedPath !== directoryPath || canonicalPath !== directoryPath) {
    throw new Error(`${label} escaped its canonical parent`);
  }
}

async function reserveCloneStaging(parentPath: string): Promise<CloneStaging> {
  const stagingPath = await mkdtemp(
    join(parentPath, ".design-sharingan-clone-"),
  );
  const entry = await lstat(stagingPath);
  const staging = {
    path: stagingPath,
    identity: { dev: entry.dev, ino: entry.ino },
  };
  await verifyOwnedDirectory(
    parentPath,
    staging.path,
    staging.identity,
    "Git clone staging directory",
  );
  return staging;
}

function declaresCheckoutFilter(contents: string): boolean {
  return contents.split(/\r?\n/).some((line) => {
    const trimmed = line.trimStart();
    if (trimmed === "" || trimmed.startsWith("#")) {
      return false;
    }
    return /(?:^|[\t ])(?:[!-])?filter(?:=|[\t ]|$)/.test(line);
  });
}

async function assertNoRepositoryCheckoutFilters(rootPath: string): Promise<void> {
  async function visit(directoryPath: string): Promise<void> {
    const entries = await readdir(directoryPath, { withFileTypes: true });
    for (const entry of entries) {
      if (directoryPath === rootPath && entry.name === ".git") {
        continue;
      }

      const entryPath = join(directoryPath, entry.name);
      if (entry.isDirectory()) {
        await visit(entryPath);
        continue;
      }

      if (entry.name !== ".gitattributes") {
        continue;
      }
      if (!entry.isFile()) {
        throw new Error(
          "Repository checkout attributes must be regular files",
        );
      }

      const contents = await readFile(entryPath, "utf8");
      if (contents.includes("\0") || declaresCheckoutFilter(contents)) {
        throw new Error(
          "Repository checkout filters are unavailable during safe import",
        );
      }
    }
  }

  await visit(rootPath);
}

function retainedWorkspaceError(error: unknown): Error {
  const reason =
    error instanceof Error && /unable to clone github repository/i.test(error.message)
      ? "Unable to clone GitHub repository"
      : "GitHub import failed";
  return new Error(
    `${reason}; incomplete workspace retained at its allocated local path`,
  );
}

export class GitHubProjectAdapter {
  private readonly gitRunner: GitRunner;
  private readonly runtime: AdapterRuntime;

  constructor(options: GitHubProjectAdapterOptions = {}) {
    this.gitRunner = options.gitRunner ?? defaultGitRunner;
    this.runtime = options.runtime ?? defaultRuntime;
  }

  async open(input: GitHubProjectInput): Promise<ProjectWorkspace> {
    validateRepositoryUrl(input.repositoryUrl);
    validateBranch(input.branch);
    const location = await cloneLocation(input.destinationPath);
    const staging = await reserveCloneStaging(location.parentPath);
    const ownership: WorkspaceOwnership = {
      rootPath: staging.path,
      parentPath: location.parentPath,
      dev: staging.identity.dev,
      ino: staging.identity.ino,
    };
    const command = {
      executable: "git" as const,
      args: [
        "-c",
        `core.hooksPath=${devNull}`,
        "clone",
        "--no-checkout",
        "--template=",
        "--branch",
        input.branch,
        "--single-branch",
        "--",
        input.repositoryUrl,
        staging.path,
      ],
      cwd: location.parentPath,
    };
    const checkoutCommand = {
      executable: "git" as const,
      args: [
        "-c",
        `core.hooksPath=${devNull}`,
        "-c",
        `core.attributesFile=${devNull}`,
        "checkout",
        "--force",
      ],
      cwd: staging.path,
    };
    const privateEnvironment =
      input.token === undefined || input.token === ""
        ? undefined
        : {
            GIT_CONFIG_COUNT: "1",
            GIT_CONFIG_KEY_0: "http.https://github.com/.extraHeader",
            GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(
              `x-access-token:${input.token}`,
              "utf8",
            ).toString("base64")}`,
          };

    try {
      try {
        await this.gitRunner.run(command, {
          environment: { GIT_TERMINAL_PROMPT: "0" },
          privateEnvironment,
        });
      } catch {
        throw new Error("Unable to clone GitHub repository");
      }

      await verifyOwnedDirectory(
        location.parentPath,
        staging.path,
        staging.identity,
        "Git clone staging directory",
      );

      try {
        await this.gitRunner.run(checkoutCommand, {
          environment: {
            GIT_ATTR_NOSYSTEM: "1",
            GIT_CONFIG_COUNT: "0",
            GIT_CONFIG_GLOBAL: devNull,
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_CONFIG_PARAMETERS: "",
            GIT_CONFIG_SYSTEM: devNull,
            GIT_TERMINAL_PROMPT: "0",
          },
          isolateInheritedGitEnvironment: true,
        });
      } catch {
        throw new Error("Unable to materialize GitHub repository");
      }

      await verifyOwnedDirectory(
        location.parentPath,
        staging.path,
        staging.identity,
        "Git clone staging directory",
      );
      await assertNoRepositoryCheckoutFilters(staging.path);

      // Detection and persistence complete before the unique workspace path is
      // exposed to the caller. The preferred destination is never overwritten.
      const detection = await detectProject(staging.path);
      if (detection.rootPath !== staging.path) {
        throw new Error("Owned GitHub workspace escaped its allocation");
      }
      await verifyOwnedDirectory(
        location.parentPath,
        staging.path,
        staging.identity,
        "Owned GitHub workspace",
      );

      const timestamp = this.runtime.now().toISOString();
      const project: Project = {
        id: this.runtime.createId(),
        name: detection.name ?? basename(detection.rootPath),
        sourceType: "GITHUB",
        rootPath: detection.rootPath,
        repositoryUrl: input.repositoryUrl,
        branch: input.branch,
        framework: detection.framework,
        packageManager: detection.packageManager,
        devCommand: detection.devCommand,
        status:
          detection.devCommand !== undefined &&
          detection.renderTarget !== undefined
            ? "READY"
            : "NEEDS_CONFIGURATION",
        createdAt: timestamp,
        updatedAt: timestamp,
      };

      await saveGuardedProjectMetadata(project, ownership);
      await verifyOwnedDirectory(
        location.parentPath,
        staging.path,
        staging.identity,
        "Owned GitHub workspace",
      );
      return {
        ...detection,
        ...project,
        framework: detection.framework,
        packageManager: detection.packageManager,
      };
    } catch (error) {
      // Destructive failure cleanup is intentionally forbidden without an
      // inode-bound deletion capability. The unique workspace is orphaned.
      throw retainedWorkspaceError(error);
    }
  }
}
