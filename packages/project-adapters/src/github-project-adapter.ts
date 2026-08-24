import { randomUUID } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { Project } from "@design-sharingan/core";
import { detectProject } from "./detect-project";
import { defaultGitRunner, type GitRunner } from "./git";
import { assertPathInsideWorkspace } from "./path-policy";
import type { AdapterRuntime, ProjectWorkspace } from "./types";
import { saveProjectMetadata } from "./workspace-store";

export interface GitHubProjectInput {
  repositoryUrl: string;
  branch: string;
  token?: string;
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

  try {
    await lstat(canonicalDestination);
    throw new Error("Git clone destination must not already exist");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return { parentPath, destinationPath: canonicalDestination };
    }
    throw error;
  }
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
    const command = {
      executable: "git" as const,
      args: [
        "clone",
        "--branch",
        input.branch,
        "--single-branch",
        "--",
        input.repositoryUrl,
        location.destinationPath,
      ],
      cwd: location.parentPath,
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
      await this.gitRunner.run(command, {
        environment: { GIT_TERMINAL_PROMPT: "0" },
        privateEnvironment,
      });
    } catch {
      throw new Error("Unable to clone GitHub repository");
    }

    const detection = await detectProject(location.destinationPath);
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
        detection.devCommand !== undefined && detection.renderTarget !== undefined
          ? "READY"
          : "NEEDS_CONFIGURATION",
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    await saveProjectMetadata(project);

    return {
      ...detection,
      ...project,
      framework: detection.framework,
      packageManager: detection.packageManager,
    };
  }
}
