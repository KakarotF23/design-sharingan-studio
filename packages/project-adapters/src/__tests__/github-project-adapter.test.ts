import { renameSync, symlinkSync } from "node:fs";
import {
  chmod,
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
import { devNull, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GitHubProjectAdapter } from "../github-project-adapter";
import {
  defaultGitRunner,
  type GitCommand,
  type GitRunOptions,
  type GitRunner,
} from "../git";

const temporaryRoots: string[] = [];

function isCloneCommand(command: GitCommand): boolean {
  return command.args.includes("clone");
}

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
    if (!isCloneCommand(command)) {
      return;
    }
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

async function runFixtureGit(cwd: string, args: readonly string[]): Promise<void> {
  await defaultGitRunner.run({ executable: "git", args, cwd });
}

async function createRepositoryFixture(
  parentPath: string,
  files: ReadonlyArray<{
    path: string;
    contents: string;
    executable?: boolean;
  }>,
): Promise<string> {
  const sourcePath = join(parentPath, "source-repository");
  await mkdir(sourcePath);
  await runFixtureGit(sourcePath, ["init", "--initial-branch=main"]);

  for (const file of files) {
    const filePath = join(sourcePath, file.path);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, file.contents);
    if (file.executable === true) {
      await chmod(filePath, 0o755);
    }
  }

  await runFixtureGit(sourcePath, ["add", "--all"]);
  await runFixtureGit(sourcePath, [
    "-c",
    "user.name=Design Sharingan Test",
    "-c",
    "user.email=design-sharingan@example.invalid",
    "commit",
    "-m",
    "fixture",
  ]);
  return sourcePath;
}

class LocalRepositoryGitRunner implements GitRunner {
  readonly calls: Array<{
    command: GitCommand;
    options: GitRunOptions | undefined;
  }> = [];

  constructor(
    private readonly repositoryUrl: string,
    private readonly sourcePath: string,
    private readonly inheritedGlobalConfig: string,
  ) {}

  async run(command: GitCommand, options?: GitRunOptions): Promise<void> {
    this.calls.push({ command, options });
    const args = command.args.map((argument) =>
      argument === this.repositoryUrl ? this.sourcePath : argument,
    );
    await defaultGitRunner.run(
      { ...command, args },
      {
        ...options,
        environment: {
          GIT_CONFIG_GLOBAL: this.inheritedGlobalConfig,
          ...options?.environment,
        },
      },
    );
  }
}

describe("GitHubProjectAdapter", () => {
  // Production break caught: a clone that also checks out can execute a
  // repository-provided hook selected by inherited relative core.hooksPath.
  it("fetches without checkout and materializes with closed Git configuration", async () => {
    const parentPath = await cloneParent();
    const repositoryUrl = "https://github.com/example/design-system.git";
    const gitRunner = new FixtureGitRunner();

    await new GitHubProjectAdapter({ gitRunner }).open({
      repositoryUrl,
      branch: "main",
      destinationPath: join(parentPath, "checkout"),
    });

    expect(gitRunner.calls).toHaveLength(2);
    const [cloneCall, checkoutCall] = gitRunner.calls;
    const cloneTarget = cloneCall?.command.args.at(-1);
    expect(cloneCall?.command.args).toEqual([
      "-c",
      `core.hooksPath=${devNull}`,
      "clone",
      "--no-checkout",
      "--template=",
      "--branch",
      "main",
      "--single-branch",
      "--",
      repositoryUrl,
      cloneTarget,
    ]);
    expect(checkoutCall?.command).toEqual({
      executable: "git",
      args: [
        "-c",
        `core.hooksPath=${devNull}`,
        "-c",
        `core.attributesFile=${devNull}`,
        "checkout",
        "--force",
      ],
      cwd: cloneTarget,
    });
    expect(checkoutCall?.options).toEqual({
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
  });

  // Production break caught: relative hook configuration is resolved from the
  // checked-out worktree, so a remote .githooks/post-checkout becomes code.
  it.skipIf(process.platform === "win32")(
    "does not execute a repository-provided post-checkout hook",
    async () => {
      const parentPath = await cloneParent();
      const markerPath = join(parentPath, "post-checkout-ran.txt");
      const repositoryUrl = "https://github.com/example/hooked.git";
      const sourcePath = await createRepositoryFixture(parentPath, [
        {
          path: ".githooks/post-checkout",
          executable: true,
          contents: `#!/usr/bin/env node\nrequire("node:fs").writeFileSync(${JSON.stringify(markerPath)}, "ran\\n");\n`,
        },
        {
          path: "package.json",
          contents:
            '{"scripts":{"dev":"next dev"},"dependencies":{"next":"latest"}}\n',
        },
      ]);
      const globalConfigPath = join(parentPath, "global.gitconfig");
      await writeFile(globalConfigPath, "[core]\n\thooksPath = .githooks\n");
      const gitRunner = new LocalRepositoryGitRunner(
        repositoryUrl,
        sourcePath,
        globalConfigPath,
      );

      const workspace = await new GitHubProjectAdapter({ gitRunner }).open({
        repositoryUrl,
        branch: "main",
        destinationPath: join(parentPath, "checkout"),
      });

      expect(workspace.status).toBe("READY");
      await expect(lstat(markerPath)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  // Production break caught: suppressing a configured filter command without
  // noticing the repository's filter attribute silently persists pointer data.
  it.skipIf(process.platform === "win32")(
    "rejects filtered repositories without executing worktree filter code",
    async () => {
      const parentPath = await cloneParent();
      const markerPath = join(parentPath, "filter-ran.txt");
      const repositoryUrl = "https://github.com/example/filtered.git";
      const sourcePath = await createRepositoryFixture(parentPath, [
        {
          path: ".gitattributes",
          contents: "zzz-filtered.txt filter=repoexec\n",
        },
        {
          path: "000-filter-driver",
          executable: true,
          contents: `#!/usr/bin/env node\nrequire("node:fs").writeFileSync(${JSON.stringify(markerPath)}, "ran\\n");\nprocess.stdin.pipe(process.stdout);\n`,
        },
        {
          path: "package.json",
          contents:
            '{"scripts":{"dev":"next dev"},"dependencies":{"next":"latest"}}\n',
        },
        { path: "zzz-filtered.txt", contents: "filtered payload\n" },
      ]);
      const globalConfigPath = join(parentPath, "global.gitconfig");
      await writeFile(
        globalConfigPath,
        '[filter "repoexec"]\n\tsmudge = ./000-filter-driver\n\trequired = true\n',
      );
      const gitRunner = new LocalRepositoryGitRunner(
        repositoryUrl,
        sourcePath,
        globalConfigPath,
      );

      const result = await new GitHubProjectAdapter({ gitRunner })
        .open({
          repositoryUrl,
          branch: "main",
          destinationPath: join(parentPath, "checkout"),
        })
        .then(
          () => undefined,
          (error: unknown) => error,
        );

      expect(result).toBeInstanceOf(Error);
      expect((result as Error).message).toMatch(/retained|filter/i);
      await expect(lstat(markerPath)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

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
      join(workspace.rootPath, ".design-sharingan", "project.json"),
      "utf8",
    );
    const [call, checkoutCall] = gitRunner.calls;
    const canonicalParent = await realpath(parentPath);
    const cloneTarget = call?.command.args.at(-1);

    expect(call?.command.executable).toBe("git");
    expect(call?.command.args.slice(0, -1)).toEqual([
      "-c",
      `core.hooksPath=${devNull}`,
      "clone",
      "--no-checkout",
      "--template=",
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
    expect(workspace.rootPath).toBe(cloneTarget);
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
    expect(checkoutCall?.options?.privateEnvironment).toBeUndefined();
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

  // Production break caught: publishing through a requested path that becomes a symlink redirects detection and metadata outside the approved parent.
  it("keeps detection and persistence in the owned workspace when the preferred destination becomes an escape symlink", async () => {
    const parentPath = await cloneParent();
    const destinationPath = join(parentPath, "checkout");
    const outsideSandbox = await cloneParent();
    const outsidePath = join(outsideSandbox, "escape-target");
    const canonicalParent = await realpath(parentPath);
    const canonicalDestination = join(canonicalParent, "checkout");
    const gitRunner: GitRunner = {
      run: async (command) => {
        if (!isCloneCommand(command)) {
          return;
        }
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

    const workspace = await new GitHubProjectAdapter({ gitRunner }).open({
      repositoryUrl: "https://github.com/example/private.git",
      branch: "main",
      destinationPath,
    });

    expect(dirname(workspace.rootPath)).toBe(canonicalParent);
    expect(workspace.rootPath).not.toBe(canonicalDestination);
    expect(workspace.rootPath).not.toBe(outsidePath);
    expect(
      JSON.parse(
        await readFile(
          join(workspace.rootPath, ".design-sharingan", "project.json"),
          "utf8",
        ),
      ),
    ).toMatchObject({ rootPath: workspace.rootPath, sourceType: "GITHUB" });
    await expect(
      readFile(join(outsidePath, ".design-sharingan", "project.json"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  // Production break caught: ordinary rename publication can overwrite an empty destination that appears after initial validation.
  it("does not overwrite a preferred destination that appears during clone", async () => {
    const parentPath = await cloneParent();
    const destinationPath = join(parentPath, "checkout");
    const canonicalParent = await realpath(parentPath);
    const replacementMarker = join(destinationPath, "user-owned.txt");
    const gitRunner: GitRunner = {
      run: async (command) => {
        if (!isCloneCommand(command)) {
          return;
        }
        const cloneTarget = command.args.at(-1);
        if (cloneTarget === undefined) {
          throw new Error("missing fake clone destination");
        }
        await Promise.all([
          mkdir(join(cloneTarget, ".git")),
          writeFile(
            join(cloneTarget, "package.json"),
            '{"scripts":{"dev":"next dev"},"dependencies":{"next":"latest"}}\n',
          ),
          mkdir(destinationPath),
        ]);
        await writeFile(replacementMarker, "user-owned\n");
      },
    };

    const workspace = await new GitHubProjectAdapter({ gitRunner }).open({
      repositoryUrl: "https://github.com/example/private.git",
      branch: "main",
      destinationPath,
    });

    expect(dirname(workspace.rootPath)).toBe(canonicalParent);
    expect(workspace.rootPath).not.toBe(join(canonicalParent, "checkout"));
    expect(await readFile(replacementMarker, "utf8")).toBe("user-owned\n");
    await expect(
      readFile(join(destinationPath, ".design-sharingan", "project.json"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  // Production break caught: cleanup by a previously verified pathname can delete a replacement inode installed by the external boundary.
  it("leaves a replacement staging directory untouched on cleanup", async () => {
    const parentPath = await cloneParent();
    const destinationPath = join(parentPath, "checkout");
    let cloneTarget: string | undefined;
    const gitRunner: GitRunner = {
      run: async (command) => {
        if (!isCloneCommand(command)) {
          return;
        }
        cloneTarget = command.args.at(-1);
        if (cloneTarget === undefined) {
          throw new Error("missing fake clone destination");
        }
        await rm(cloneTarget, { recursive: true });
        await mkdir(cloneTarget);
        await writeFile(join(cloneTarget, "replacement.txt"), "keep me\n");
        throw new Error("simulated clone failure");
      },
    };

    await expect(
      new GitHubProjectAdapter({ gitRunner }).open({
        repositoryUrl: "https://github.com/example/private.git",
        branch: "main",
        destinationPath,
      }),
    ).rejects.toThrow(/unable to clone/i);

    expect(cloneTarget).toBeDefined();
    expect(await readFile(join(cloneTarget as string, "replacement.txt"), "utf8"))
      .toBe("keep me\n");
  });

  // Production break caught: a swap from an injected runtime hook immediately before persistence can redirect Task 3 metadata into an external root.
  it("binds metadata persistence to the owned workspace inode", async () => {
    const parentPath = await cloneParent();
    const outsideSandbox = await cloneParent();
    const outsidePath = join(outsideSandbox, "escape-target");
    await mkdir(outsidePath);
    let cloneTarget: string | undefined;
    const gitRunner: GitRunner = {
      run: async (command) => {
        if (!isCloneCommand(command)) {
          return;
        }
        cloneTarget = command.args.at(-1);
        if (cloneTarget === undefined) {
          throw new Error("missing fake clone destination");
        }
        await Promise.all([
          mkdir(join(cloneTarget, ".git")),
          writeFile(
            join(cloneTarget, "package.json"),
            '{"scripts":{"dev":"next dev"},"dependencies":{"next":"latest"}}\n',
          ),
        ]);
      },
    };
    const runtime = {
      now: () => new Date("2026-08-24T12:00:00.000Z"),
      createId: () => {
        if (cloneTarget === undefined) {
          throw new Error("clone target was not captured");
        }
        renameSync(cloneTarget, `${cloneTarget}-owned-orphan`);
        symlinkSync(outsidePath, cloneTarget, "dir");
        return "project-owned-inode";
      },
    };

    await expect(
      new GitHubProjectAdapter({ gitRunner, runtime }).open({
        repositoryUrl: "https://github.com/example/private.git",
        branch: "main",
        destinationPath: join(parentPath, "checkout"),
      }),
    ).rejects.toThrow(/owned.*workspace|persistence|retained/i);

    await expect(
      readFile(join(outsidePath, ".design-sharingan", "project.json"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  // Production break caught: tidying a failed clone by pathname can delete data that must be retained when ownership cannot be capability-pinned.
  it("retains a failed workspace instead of destructively cleaning it", async () => {
    const parentPath = await cloneParent();
    let cloneTarget: string | undefined;
    const gitRunner: GitRunner = {
      run: async (command) => {
        cloneTarget = command.args.at(-1);
        if (cloneTarget === undefined) {
          throw new Error("missing fake clone destination");
        }
        await writeFile(join(cloneTarget, "retain-on-failure.txt"), "retain me\n");
        throw new Error("simulated clone failure");
      },
    };

    await expect(
      new GitHubProjectAdapter({ gitRunner }).open({
        repositoryUrl: "https://github.com/example/private.git",
        branch: "main",
        destinationPath: join(parentPath, "checkout"),
      }),
    ).rejects.toThrow(/retained|incomplete workspace/i);

    expect(cloneTarget).toBeDefined();
    expect(
      await readFile(join(cloneTarget as string, "retain-on-failure.txt"), "utf8"),
    ).toBe("retain me\n");
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
