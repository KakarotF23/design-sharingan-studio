import { execFile, spawn, type ChildProcess } from "node:child_process";
import {
  chmod,
  cp,
  access,
  lstat,
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const sourceRoot = join(repositoryRoot, "skills");
const installScript = join(repositoryRoot, "scripts", "install-skills.sh");
const verifyScript = join(repositoryRoot, "scripts", "verify-skills.sh");
const temporaryRoots: string[] = [];
const runningProcesses = new Map<ChildProcess, Promise<SpawnResult>>();

type SpawnResult = {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
};

const skillContracts = {
  "design-sharingan": {
    modes: ["scan", "assimilate", "evolve", "verify"],
    invocationHeading: "Invocation Modes",
    directories: ["agents", "references", "scripts"],
    files: [
      "README.txt",
      "SKILL.md",
      "agents/openai.yaml",
      "references/design-dna-schema.md",
      "references/design-md-template.md",
      "references/verification-cases.md",
      "scripts/install.sh",
    ],
  },
  "mangekyo-sharingan": {
    modes: ["loop", "amaterasu", "tsukuyomi", "susanoo", "kamui"],
    invocationHeading: "Invocation",
    directories: ["agents", "references", "scripts"],
    files: [
      "README.txt",
      "SKILL.md",
      "agents/openai.yaml",
      "references/pressure-tests.md",
      "references/score-rubric.md",
      "references/visual-loop-contract.md",
      "scripts/install.sh",
    ],
  },
  "eternal-sharingan": {
    modes: ["init", "guard", "audit", "reference-gate", "evolve", "release"],
    invocationHeading: "Invocation",
    directories: ["agents", "references", "scripts", "templates"],
    files: [
      "README.txt",
      "SKILL.md",
      "agents/openai.yaml",
      "references/audit-protocol.md",
      "references/governance-model.md",
      "references/pressure-tests.md",
      "references/reference-gate.md",
      "references/release-gate.md",
      "scripts/init-governance.sh",
      "scripts/install.sh",
      "templates/DESIGN-DECISIONS.md",
      "templates/DESIGN-GENOME.md",
      "templates/DRIFT-REPORT.md",
      "templates/SCREEN-REGISTRY.md",
    ],
  },
} as const;

type CommandFailure = Error & {
  code?: number;
  stdout?: string;
  stderr?: string;
};

async function temporaryDirectory(label: string): Promise<string> {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), `design-sharingan-${label}-`)),
  );
  temporaryRoots.push(directory);
  return directory;
}

function markdownSection(markdown: string, heading: string): string {
  const match = markdown.match(
    new RegExp(`^## ${heading}\\r?\\n([\\s\\S]*?)(?=^## |\\Z)`, "m"),
  );
  if (!match) {
    throw new Error(`Missing Markdown section: ${heading}`);
  }
  return match[1];
}

function invocationModes(markdown: string, heading: string): string[] {
  return [...markdownSection(markdown, heading).matchAll(/^\| `([^`]+)` \|/gm)]
    .map((match) => match[1]);
}

function manifestDefaultPrompt(manifest: string): string | undefined {
  return manifest.match(
    /^interface:\r?\n(?:(?: {2}[^\r\n]*)\r?\n)*? {2}default_prompt:\s*"([^"]+)"\s*$/m,
  )?.[1];
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function waitForPath(path: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await pathExists(path))) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${path}`);
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
}

function spawnInstaller(
  args: string[],
  env: Record<string, string> = {},
): { child: ChildProcess; result: Promise<SpawnResult> } {
  const child = spawn("bash", [installScript, ...args], {
    cwd: repositoryRoot,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => { stdout += chunk; });
  child.stderr?.on("data", (chunk: string) => { stderr += chunk; });
  const result = new Promise<SpawnResult>((resolvePromise, rejectPromise) => {
    child.once("error", rejectPromise);
    child.once("close", (code, signal) => {
      runningProcesses.delete(child);
      resolvePromise({ code, signal, stdout, stderr });
    });
  });
  runningProcesses.set(child, result);
  return { child, result };
}

async function run(
  script: string,
  args: string[],
  env: Record<string, string> = {},
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync("bash", [script, ...args], {
    cwd: repositoryRoot,
    env: { ...process.env, ...env },
  });
}

async function expectCommandFailure(
  script: string,
  args: string[],
  env: Record<string, string> = {},
): Promise<CommandFailure> {
  try {
    await run(script, args, env);
  } catch (error) {
    return error as CommandFailure;
  }
  throw new Error(`Expected ${script} to reject`);
}

async function treeSnapshot(root: string): Promise<Record<string, string>> {
  const snapshot: Record<string, string> = {};
  async function visit(directory: string): Promise<void> {
    for (const entry of (await readdir(directory, { withFileTypes: true }))
      .sort((left, right) => left.name.localeCompare(right.name))) {
      const path = join(directory, entry.name);
      const name = relative(root, path);
      if (entry.isDirectory()) {
        snapshot[`${name}/`] = "directory";
        await visit(path);
      } else if (entry.isFile()) {
        snapshot[name] = Buffer.from(await readFile(path)).toString("base64");
      } else if (entry.isSymbolicLink()) {
        snapshot[name] = "symbolic-link";
      } else {
        snapshot[name] = "unsupported";
      }
    }
  }
  await visit(root);
  return snapshot;
}

async function ownedSkillSnapshot(root: string): Promise<Record<string, Record<string, string>>> {
  return Object.fromEntries(
    await Promise.all(
      Object.keys(skillContracts).map(async (skillName) => [
        skillName,
        await treeSnapshot(join(root, skillName)),
      ]),
    ),
  );
}

afterEach(async () => {
  for (const child of runningProcesses.keys()) {
    child.kill("SIGKILL");
  }
  await Promise.allSettled(runningProcesses.values());
  runningProcesses.clear();
  await Promise.all(
    temporaryRoots.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("Design Sharingan skill pack", () => {
  it("contains the exact named skills, invocation modes, and supporting resources", async () => {
    for (const [skillName, contract] of Object.entries(skillContracts)) {
      const skillRoot = join(sourceRoot, skillName);
      const skill = await readFile(join(skillRoot, "SKILL.md"), "utf8");
      const frontmatter = skill.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
      expect(frontmatter, `${skillName} frontmatter`).toBeDefined();
      expect(frontmatter?.match(/^name:\s*([^\r\n]+)\s*$/gm)).toEqual([
        `name: ${skillName}`,
      ]);
      expect(markdownSection(skill, contract.invocationHeading))
        .toContain(`$${skillName}`);
      expect(invocationModes(skill, contract.invocationHeading))
        .toEqual([...contract.modes]);

      const manifest = await readFile(join(skillRoot, "agents", "openai.yaml"), "utf8");
      expect(manifestDefaultPrompt(manifest)).toContain(`$${skillName}`);
      const tree = await treeSnapshot(skillRoot);
      const actualFiles = Object.keys(tree)
        .filter((name) => !name.endsWith("/"))
        .sort();
      expect(actualFiles).toEqual([...contract.files].sort());
      const actualDirectories = Object.keys(tree)
        .filter((name) => name.endsWith("/"))
        .map((name) => name.slice(0, -1))
        .sort();
      expect(actualDirectories).toEqual([...contract.directories].sort());
    }
  });

  it("rejects empty-directory drift and misplaced structural contracts", async () => {
    const sandbox = await temporaryDirectory("structural-contracts");

    const extraDirectorySource = join(sandbox, "extra-directory");
    await cp(sourceRoot, extraDirectorySource, { recursive: true });
    await mkdir(join(extraDirectorySource, "design-sharingan", "empty-extra"));
    await expectCommandFailure(verifyScript, ["--source", extraDirectorySource]);

    const openFrontmatterSource = join(sandbox, "open-frontmatter");
    await cp(sourceRoot, openFrontmatterSource, { recursive: true });
    const openFrontmatterPath = join(openFrontmatterSource, "design-sharingan", "SKILL.md");
    const openFrontmatter = await readFile(openFrontmatterPath, "utf8");
    await writeFile(
      openFrontmatterPath,
      openFrontmatter.replace("\n---\n\n# Design Sharingan", "\n\n# Design Sharingan"),
    );
    await expectCommandFailure(verifyScript, ["--source", openFrontmatterSource]);

    const displacedModeSource = join(sandbox, "displaced-mode");
    await cp(sourceRoot, displacedModeSource, { recursive: true });
    const displacedModePath = join(displacedModeSource, "design-sharingan", "SKILL.md");
    const displacedMode = await readFile(displacedModePath, "utf8");
    await writeFile(
      displacedModePath,
      displacedMode
        .replace(/^\| `scan` \|.*\r?\n/m, "")
        .concat("\nUnrelated example token: `scan`.\n"),
    );
    await expectCommandFailure(verifyScript, ["--source", displacedModeSource]);

    const displacedInvocationSource = join(sandbox, "displaced-invocation");
    await cp(sourceRoot, displacedInvocationSource, { recursive: true });
    const manifestPath = join(
      displacedInvocationSource,
      "design-sharingan",
      "agents",
      "openai.yaml",
    );
    const manifest = await readFile(manifestPath, "utf8");
    await writeFile(
      manifestPath,
      manifest
        .replace("Use $design-sharingan", "Use the bundled visual analysis skill")
        .concat("\n# unrelated token: $design-sharingan\n"),
    );
    await expectCommandFailure(verifyScript, ["--source", displacedInvocationSource]);
  });

  it("installs exact trees idempotently while preserving unrelated skills", async () => {
    expect((await stat(installScript)).mode & 0o111).not.toBe(0);
    expect((await stat(verifyScript)).mode & 0o111).not.toBe(0);
    const sandbox = await temporaryDirectory("install");
    const target = join(sandbox, "skills");
    await mkdir(join(target, "unrelated-skill"), { recursive: true });
    await writeFile(join(target, "unrelated-skill", "SKILL.md"), "keep me\n");
    await symlink(
      "SKILL.md",
      join(target, "unrelated-skill", "current-skill.md"),
    );

    await run(verifyScript, ["--source", sourceRoot]);
    await run(installScript, ["--source", sourceRoot, "--target", target]);
    await run(verifyScript, ["--source", sourceRoot, "--target", target]);
    const first = await treeSnapshot(target);
    await run(installScript, ["--source", sourceRoot, "--target", target]);

    expect(await treeSnapshot(target)).toEqual(first);
    expect(await readFile(join(target, "unrelated-skill", "SKILL.md"), "utf8"))
      .toBe("keep me\n");
    expect((await lstat(join(target, "unrelated-skill", "current-skill.md"))).isSymbolicLink())
      .toBe(true);
    for (const skillName of Object.keys(skillContracts)) {
      expect(await treeSnapshot(join(target, skillName)))
        .toEqual(await treeSnapshot(join(sourceRoot, skillName)));
    }
    expect(Object.keys(first).some((name) => name.includes(".design-sharingan-")))
      .toBe(false);
  }, 30_000);

  it("supports an isolated target through the environment", async () => {
    const sandbox = await temporaryDirectory("environment");
    const target = join(sandbox, "skills");

    await run(installScript, ["--source", sourceRoot], {
      DESIGN_SHARINGAN_SKILLS_DIR: target,
    });
    await run(verifyScript, ["--source", sourceRoot, "--target", target]);
  });

  it("validates a complete source before mutating any installed skill", async () => {
    const sandbox = await temporaryDirectory("partial");
    const target = join(sandbox, "target");
    const incompleteSource = join(sandbox, "source");
    await run(installScript, ["--source", sourceRoot, "--target", target]);
    const before = await treeSnapshot(target);
    await cp(sourceRoot, incompleteSource, { recursive: true });
    await rm(join(incompleteSource, "eternal-sharingan", "references", "release-gate.md"));

    const failure = await expectCommandFailure(installScript, [
      "--source", incompleteSource,
      "--target", target,
    ]);
    expect(`${failure.stderr ?? ""}${failure.stdout ?? ""}`).toMatch(/missing|required|invalid/i);
    expect(await treeSnapshot(target)).toEqual(before);
  });

  it("rejects source symlinks and hard links", async () => {
    const sandbox = await temporaryDirectory("links");
    const symlinkSource = join(sandbox, "symlink-source");
    await cp(sourceRoot, symlinkSource, { recursive: true });
    const symlinked = join(symlinkSource, "design-sharingan", "README.txt");
    await rm(symlinked);
    await symlink(join(sourceRoot, "design-sharingan", "README.txt"), symlinked);

    const symlinkFailure = await expectCommandFailure(verifyScript, [
      "--source", symlinkSource,
    ]);
    expect(`${symlinkFailure.stderr ?? ""}${symlinkFailure.stdout ?? ""}`)
      .toMatch(/symbolic|symlink|regular/i);

    const hardlinkSource = join(sandbox, "hardlink-source");
    await cp(sourceRoot, hardlinkSource, { recursive: true });
    const outside = join(sandbox, "outside.txt");
    await writeFile(outside, "hard-linked skill evidence\n");
    const hardlinked = join(hardlinkSource, "mangekyo-sharingan", "README.txt");
    await rm(hardlinked);
    await link(outside, hardlinked);

    const hardlinkFailure = await expectCommandFailure(verifyScript, [
      "--source", hardlinkSource,
    ]);
    expect(`${hardlinkFailure.stderr ?? ""}${hardlinkFailure.stdout ?? ""}`)
      .toMatch(/hard link|link count|regular/i);
  });

  it("rejects target aliases, source overlap, and changed installed files", async () => {
    const sandbox = await temporaryDirectory("target-integrity");
    const target = join(sandbox, "target");
    await run(installScript, ["--source", sourceRoot, "--target", target]);
    await writeFile(join(target, "design-sharingan", "unexpected.txt"), "extra\n");
    const extraFailure = await expectCommandFailure(verifyScript, [
      "--source", sourceRoot,
      "--target", target,
    ]);
    expect(`${extraFailure.stderr ?? ""}${extraFailure.stdout ?? ""}`)
      .toMatch(/differ|unexpected|exact|verification/i);

    const alias = join(sandbox, "target-alias");
    await symlink(target, alias);
    const before = await treeSnapshot(target);
    const aliasFailure = await expectCommandFailure(installScript, [
      "--source", sourceRoot,
      "--target", alias,
    ]);
    expect(`${aliasFailure.stderr ?? ""}${aliasFailure.stdout ?? ""}`)
      .toMatch(/symbolic|symlink|alias/i);
    expect(await treeSnapshot(target)).toEqual(before);

    const sourceBefore = await treeSnapshot(sourceRoot);
    const overlapFailure = await expectCommandFailure(installScript, [
      "--source", sourceRoot,
      "--target", sourceRoot,
    ]);
    expect(`${overlapFailure.stderr ?? ""}${overlapFailure.stdout ?? ""}`)
      .toMatch(/overlap|source|target/i);
    expect(await treeSnapshot(sourceRoot)).toEqual(sourceBefore);
  });

  it("rejects every source and target ancestor alias before mutation", async () => {
    const sandbox = await temporaryDirectory("ancestor-aliases");
    const copiedSource = join(sandbox, "source");
    await cp(sourceRoot, copiedSource, { recursive: true });
    const sourceBefore = await treeSnapshot(copiedSource);
    const sourceAlias = join(sandbox, "source-alias");
    await symlink(copiedSource, sourceAlias);
    const redirectedTarget = join(sourceAlias, "nested-target");

    const overlapFailure = await expectCommandFailure(installScript, [
      "--source", copiedSource,
      "--target", redirectedTarget,
    ]);
    expect(`${overlapFailure.stderr ?? ""}${overlapFailure.stdout ?? ""}`)
      .toMatch(/ancestor|symbolic|symlink|alias|overlap/i);
    expect(await treeSnapshot(copiedSource)).toEqual(sourceBefore);
    expect(await pathExists(redirectedTarget)).toBe(false);

    const harmlessParent = join(sandbox, "harmless-real-parent");
    await mkdir(harmlessParent);
    const harmlessAlias = join(sandbox, "harmless-alias");
    await symlink(harmlessParent, harmlessAlias);
    const harmlessTarget = join(harmlessAlias, "skills");
    const harmlessFailure = await expectCommandFailure(installScript, [
      "--source", copiedSource,
      "--target", harmlessTarget,
    ]);
    expect(`${harmlessFailure.stderr ?? ""}${harmlessFailure.stdout ?? ""}`)
      .toMatch(/ancestor|symbolic|symlink|alias/i);
    expect(await pathExists(harmlessTarget)).toBe(false);

    const sourceViaAncestorAlias = join(sourceAlias, "design-sharingan", "..");
    const verifyFailure = await expectCommandFailure(verifyScript, [
      "--source", sourceViaAncestorAlias,
    ]);
    expect(`${verifyFailure.stderr ?? ""}${verifyFailure.stdout ?? ""}`)
      .toMatch(/ancestor|symbolic|symlink|alias|traversal/i);
  });

  it("rolls back exactly when terminated at every promotion boundary", async () => {
    const boundaries = [
      "after-prepare-backup:design-sharingan",
      "after-backup-move:design-sharingan",
      "after-backed-up:design-sharingan",
      "after-prepare-promote:design-sharingan",
      "after-promote-move:design-sharingan",
      "after-promoted:design-sharingan",
      "after-promote-move:mangekyo-sharingan",
    ];
    for (const [index, boundary] of boundaries.entries()) {
      const sandbox = await temporaryDirectory(`term-${index}`);
      const target = join(sandbox, "target");
      await run(installScript, ["--source", sourceRoot, "--target", target]);
      const changedSkill = boundary.endsWith(":mangekyo-sharingan")
        ? "mangekyo-sharingan"
        : "design-sharingan";
      await writeFile(
        join(target, changedSkill, "README.txt"),
        `prior tree for ${boundary}\n`,
      );
      const before = await treeSnapshot(target);
      const hookDirectory = join(sandbox, "hook");
      await mkdir(hookDirectory);
      const operation = spawnInstaller(
        ["--source", sourceRoot, "--target", target],
        {
          DESIGN_SHARINGAN_INSTALL_TEST_HOOK: boundary,
          DESIGN_SHARINGAN_INSTALL_TEST_HOOK_DIR: hookDirectory,
        },
      );
      await waitForPath(join(hookDirectory, "reached"));
      operation.child.kill("SIGTERM");
      const result = await operation.result;
      expect(result.code === 143 || result.signal === "SIGTERM").toBe(true);
      expect(await treeSnapshot(target)).toEqual(before);
      expect((await readdir(target)).some((name) => name.startsWith(".design-sharingan-")))
        .toBe(false);
    }
  }, 60_000);

  it("recovers a killed transaction durably before starting the next install", async () => {
    const sandbox = await temporaryDirectory("killed-recovery");
    const target = join(sandbox, "target");
    await run(installScript, ["--source", sourceRoot, "--target", target]);
    await writeFile(join(target, "design-sharingan", "README.txt"), "prior durable tree\n");
    const before = await treeSnapshot(target);
    const ownedBefore = await ownedSkillSnapshot(target);
    const killHook = join(sandbox, "kill-hook");
    await mkdir(killHook);
    const interrupted = spawnInstaller(
      ["--source", sourceRoot, "--target", target],
      {
        DESIGN_SHARINGAN_INSTALL_TEST_HOOK: "after-promote-move:design-sharingan",
        DESIGN_SHARINGAN_INSTALL_TEST_HOOK_DIR: killHook,
      },
    );
    await waitForPath(join(killHook, "reached"));
    interrupted.child.kill("SIGKILL");
    const killed = await interrupted.result;
    expect(killed.signal).toBe("SIGKILL");
    expect(await treeSnapshot(target)).not.toEqual(before);

    const recoveryHook = join(sandbox, "recovery-hook");
    await mkdir(recoveryHook);
    const recovery = spawnInstaller(
      ["--source", sourceRoot, "--target", target],
      {
        DESIGN_SHARINGAN_INSTALL_TEST_HOOK: "after-stale-recovery",
        DESIGN_SHARINGAN_INSTALL_TEST_HOOK_DIR: recoveryHook,
      },
    );
    await waitForPath(join(recoveryHook, "reached"));
    expect(await ownedSkillSnapshot(target)).toEqual(ownedBefore);
    await writeFile(join(recoveryHook, "release"), "continue\n");
    expect((await recovery.result).code).toBe(0);
    await run(verifyScript, ["--source", sourceRoot, "--target", target]);
    expect((await readdir(target)).some((name) => name.startsWith(".design-sharingan-")))
      .toBe(false);
  }, 30_000);

  it("keeps a durably committed pack when killed before transaction cleanup", async () => {
    const sandbox = await temporaryDirectory("committed-recovery");
    const target = join(sandbox, "target");
    await run(installScript, ["--source", sourceRoot, "--target", target]);
    await writeFile(join(target, "design-sharingan", "README.txt"), "replace before commit\n");
    const hookDirectory = join(sandbox, "commit-hook");
    await mkdir(hookDirectory);
    const interrupted = spawnInstaller(
      ["--source", sourceRoot, "--target", target],
      {
        DESIGN_SHARINGAN_INSTALL_TEST_HOOK: "after-committed",
        DESIGN_SHARINGAN_INSTALL_TEST_HOOK_DIR: hookDirectory,
      },
    );
    await waitForPath(join(hookDirectory, "reached"));
    interrupted.child.kill("SIGKILL");
    expect((await interrupted.result).signal).toBe("SIGKILL");
    await run(installScript, ["--source", sourceRoot, "--target", target]);
    await run(verifyScript, ["--source", sourceRoot, "--target", target]);
    expect((await readdir(target)).some((name) => name.startsWith(".design-sharingan-")))
      .toBe(false);
  }, 30_000);

  it("does not take over a live lock but safely recovers an expired ownerless lock", async () => {
    const sandbox = await temporaryDirectory("lock-recovery");
    const target = join(sandbox, "target");
    await mkdir(target);
    const hookDirectory = join(sandbox, "live-hook");
    await mkdir(hookDirectory);
    const live = spawnInstaller(
      ["--source", sourceRoot, "--target", target],
      {
        DESIGN_SHARINGAN_INSTALL_TEST_HOOK: "lock-acquired",
        DESIGN_SHARINGAN_INSTALL_TEST_HOOK_DIR: hookDirectory,
      },
    );
    await waitForPath(join(hookDirectory, "reached"));
    const concurrentFailure = await expectCommandFailure(installScript, [
      "--source", sourceRoot,
      "--target", target,
    ]);
    expect(`${concurrentFailure.stderr ?? ""}${concurrentFailure.stdout ?? ""}`)
      .toMatch(/in progress|live|lock/i);
    await writeFile(join(hookDirectory, "release"), "continue\n");
    expect((await live.result).code).toBe(0);

    const staleTarget = join(sandbox, "stale-target");
    const staleLock = join(staleTarget, ".design-sharingan-install.lock");
    await mkdir(staleLock, { recursive: true });
    await writeFile(join(staleLock, ".owner.tmp-999-deadbeef"), "partial owner\n");
    const expired = new Date(Date.now() - 120_000);
    await utimes(staleLock, expired, expired);
    await run(installScript, ["--source", sourceRoot, "--target", staleTarget], {
      DESIGN_SHARINGAN_LOCK_LEASE_SECONDS: "1",
    });
    await run(verifyScript, ["--source", sourceRoot, "--target", staleTarget]);

    const staleClaimTarget = join(sandbox, "stale-claim-target");
    const staleClaimLock = join(staleClaimTarget, ".design-sharingan-install.lock");
    const staleClaim = join(staleClaimLock, "recovery-claim");
    await mkdir(staleClaim, { recursive: true });
    await writeFile(join(staleClaim, ".owner.tmp-999-deadbeef"), "partial claim owner\n");
    await utimes(staleClaim, expired, expired);
    await utimes(staleClaimLock, expired, expired);
    await run(installScript, ["--source", sourceRoot, "--target", staleClaimTarget], {
      DESIGN_SHARINGAN_LOCK_LEASE_SECONDS: "1",
    });
    await run(verifyScript, ["--source", sourceRoot, "--target", staleClaimTarget]);
  }, 30_000);

  it("rolls every replaced skill back if a staged promotion fails", async () => {
    const sandbox = await temporaryDirectory("rollback");
    const target = join(sandbox, "target");
    await run(installScript, ["--source", sourceRoot, "--target", target]);
    for (const skillName of Object.keys(skillContracts)) {
      await writeFile(join(target, skillName, "README.txt"), `prior ${skillName}\n`);
    }
    const before = await treeSnapshot(target);
    const fakeBin = join(sandbox, "bin");
    const failureMarker = join(sandbox, "promotion-failed");
    await mkdir(fakeBin);
    const fakeMove = join(fakeBin, "mv");
    await writeFile(fakeMove, `#!/usr/bin/env bash
set -euo pipefail
destination="\${!#}"
if [[ "\$destination" == "\$FAIL_DESTINATION" && ! -e "\$FAILURE_MARKER" && "\$1" == *design-sharingan-stage* ]]; then
  : > "\$FAILURE_MARKER"
  exit 73
fi
exec /bin/mv "\$@"
`);
    await chmod(fakeMove, 0o755);

    const failure = await expectCommandFailure(
      installScript,
      ["--source", sourceRoot, "--target", target],
      {
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
        FAIL_DESTINATION: join(await realpath(target), "eternal-sharingan"),
        FAILURE_MARKER: failureMarker,
      },
    );
    expect(failure.code).toBe(73);
    expect(await treeSnapshot(target)).toEqual(before);
    expect((await readdir(target)).some((name) => name.startsWith(".design-sharingan-")))
      .toBe(false);
  }, 30_000);
});
