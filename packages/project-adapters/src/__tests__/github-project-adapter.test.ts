import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GitHubProjectAdapter } from "../github-project-adapter";
import type { GitCommand, GitRunOptions, GitRunner } from "../git";

const temporaryRoots: string[] = [];

async function cloneParent(): Promise<string> {
  const rootPath = await mkdtemp(join(tmpdir(), "design-sharingan-github-"));
  temporaryRoots.push(rootPath);
  return rootPath;
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((rootPath) =>
      rm(rootPath, { force: true, recursive: true }),
    ),
  );
});

class FixtureGitRunner implements GitRunner {
  readonly calls: Array<{
    command: GitCommand;
    options: GitRunOptions | undefined;
  }> = [];

  async run(command: GitCommand, options?: GitRunOptions): Promise<void> {
    this.calls.push({ command, options });
    const destinationPath = command.args.at(-1);
    if (destinationPath === undefined) {
      throw new Error("missing fake clone destination");
    }
    const destinationEntry = await lstat(destinationPath);
    if (!destinationEntry.isDirectory() || (await readdir(destinationPath)).length > 0) {
      throw new Error("fake clone destination was not a reserved empty directory");
    }
    await Promise.all([
      mkdir(join(destinationPath, ".git")),
      writeFile(
        join(destinationPath, "package.json"),
        `${JSON.stringify(
          {
            name: "github-next",
            scripts: { dev: "next dev" },
            dependencies: { next: "latest", react: "latest" },
          },
          null,
          2,
        )}\n`,
      ),
    ]);
  }
}

describe("GitHubProjectAdapter", () => {
  // Production break caught: bypassing the shared detector or leaking auth into clone args/project metadata makes GitHub intake inconsistent and exposes credentials.
  it("clones a branch, detects the workspace, and keeps credentials private", async () => {
    const parentPath = await cloneParent();
    const destinationPath = join(parentPath, "checkout");
    const repositoryUrl = "https://github.com/example/design-system.git";
    const branch = "feature/studio";
    const token = "ghp_private-token-value";
    const gitRunner = new FixtureGitRunner();

    const workspace = await new GitHubProjectAdapter({ gitRunner }).open({
      repositoryUrl,
      branch,
      token,
      destinationPath,
    });
    const persistedText = await readFile(
      join(destinationPath, ".design-sharingan", "project.json"),
      "utf8",
    );
    const [call] = gitRunner.calls;
    const canonicalParent = await realpath(parentPath);
    const cloneTarget = call?.command.args.at(-1);

    expect(call?.command.executable).toBe("git");
    expect(call?.command.args.slice(0, -1)).toEqual([
      "clone",
      "--branch",
      branch,
      "--single-branch",
      "--",
      repositoryUrl,
    ]);
    expect(cloneTarget).toBeDefined();
    expect(dirname(cloneTarget as string)).toBe(canonicalParent);
    expect(basename(cloneTarget as string)).toMatch(
      /^\.design-sharingan-clone-/,
    );
    expect(call?.command.cwd).toBe(canonicalParent);
    expect(JSON.stringify(call?.command)).not.toContain(token);
    expect(call?.options?.privateEnvironment).toEqual(
      expect.objectContaining({
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "http.https://github.com/.extraHeader",
      }),
    );
    expect(Object.values(call?.options?.privateEnvironment ?? {})).not.toContain(
      token,
    );
    expect(persistedText).not.toContain(token);
    expect(JSON.parse(persistedText)).toMatchObject({
      sourceType: "GITHUB",
      repositoryUrl,
      branch,
    });
    expect(workspace.framework).toBe("nextjs");
    expect(workspace.capabilities.canRender).toBe(true);
    expect(workspace.capabilities.canUseGit).toBe(true);
  });

  // Production break caught: cloning directly into the requested path lets a runner-time symlink swap redirect detection and metadata outside the selected parent.
  it("fails closed when the requested destination becomes an escape symlink", async () => {
    const parentPath = await cloneParent();
    const destinationPath = join(parentPath, "checkout");
    const outsideSandbox = await cloneParent();
    const outsidePath = join(outsideSandbox, "escape-target");
    const canonicalParent = await realpath(parentPath);
    const canonicalDestination = join(canonicalParent, "checkout");
    const gitRunner: GitRunner = {
      run: async (command) => {
        const cloneTarget = command.args.at(-1);
        if (cloneTarget === undefined) {
          throw new Error("missing fake clone destination");
        }

        if (cloneTarget !== canonicalDestination) {
          const stagingEntry = await lstat(cloneTarget);
          if (
            !stagingEntry.isDirectory() ||
            (await readdir(cloneTarget)).length > 0
          ) {
            throw new Error("fake clone staging was not exclusively reserved");
          }
          await Promise.all([
            mkdir(join(cloneTarget, ".git")),
            writeFile(
              join(cloneTarget, "package.json"),
              '{"scripts":{"dev":"next dev"},"dependencies":{"next":"latest"}}\n',
            ),
          ]);
        }

        await mkdir(outsidePath);
        await writeFile(
          join(outsidePath, "package.json"),
          '{"scripts":{"dev":"next dev"},"dependencies":{"next":"latest"}}\n',
        );
        await symlink(outsidePath, canonicalDestination);
      },
    };

    const error = await new GitHubProjectAdapter({ gitRunner })
      .open({
        repositoryUrl: "https://github.com/example/private.git",
        branch: "main",
        destinationPath,
      })
      .then(
        () => undefined,
        (caught: unknown) => caught,
      );

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/destination|workspace safely/i);
    await expect(
      readFile(join(outsidePath, ".design-sharingan", "project.json"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
    const parentEntries = await readdir(parentPath);
    expect(parentEntries.some((entry) => entry.startsWith(".design-sharingan-clone-"))).toBe(false);
  });

  // Production break caught: propagating an external process error can surface a private token in UI/logging error messages.
  it("redacts credentials from clone failures", async () => {
    const parentPath = await cloneParent();
    const token = "ghp_failure-secret";
    const gitRunner: GitRunner = {
      run: async () => {
        throw new Error(`remote rejected ${token}`);
      },
    };

    const error = await new GitHubProjectAdapter({ gitRunner })
      .open({
        repositoryUrl: "https://github.com/example/private.git",
        branch: "main",
        token,
        destinationPath: join(parentPath, "checkout"),
      })
      .then(
        () => undefined,
        (caught: unknown) => caught,
      );

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/unable to clone/i);
    expect((error as Error).message).not.toContain(token);
  });

  // Production break caught: accepting URL query credentials copies secrets into loggable clone args and persisted repository metadata.
  it("rejects credential-bearing repository URLs before invoking Git", async () => {
    const parentPath = await cloneParent();
    const secret = "ghp_query-secret";
    let gitCalls = 0;
    const gitRunner: GitRunner = {
      run: async () => {
        gitCalls += 1;
      },
    };

    const error = await new GitHubProjectAdapter({ gitRunner })
      .open({
        repositoryUrl: `https://github.com/example/private.git?token=${secret}`,
        branch: "main",
        destinationPath: join(parentPath, "checkout"),
      })
      .then(
        () => undefined,
        (caught: unknown) => caught,
      );

    expect(gitCalls).toBe(0);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/repository url/i);
    expect((error as Error).message).not.toContain(secret);
  });

  // Production break caught: sending private authentication through plain HTTP exposes it before GitHub can redirect the request.
  it("rejects insecure GitHub URLs before private credentials are attached", async () => {
    const parentPath = await cloneParent();
    let gitCalls = 0;
    const gitRunner: GitRunner = {
      run: async () => {
        gitCalls += 1;
      },
    };

    const error = await new GitHubProjectAdapter({ gitRunner })
      .open({
        repositoryUrl: "http://github.com/example/private.git",
        branch: "main",
        token: "ghp_http-secret",
        destinationPath: join(parentPath, "checkout"),
      })
      .then(
        () => undefined,
        (caught: unknown) => caught,
      );

    expect(gitCalls).toBe(0);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/https/i);
  });
});
