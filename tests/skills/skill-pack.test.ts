import { execFile } from "node:child_process";
import {
  chmod,
  cp,
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

const skillContracts = {
  "design-sharingan": {
    modes: ["scan", "assimilate", "evolve", "verify"],
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
  const directory = await mkdtemp(join(tmpdir(), `design-sharingan-${label}-`));
  temporaryRoots.push(directory);
  return directory;
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

afterEach(async () => {
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
      expect(skill).toContain(`$${skillName}`);
      for (const mode of contract.modes) {
        expect(skill, `${skillName} supports ${mode}`).toContain(`\`${mode}\``);
      }

      const manifest = await readFile(join(skillRoot, "agents", "openai.yaml"), "utf8");
      expect(manifest).toContain(`$${skillName}`);
      const actualFiles = Object.keys(await treeSnapshot(skillRoot))
        .filter((name) => !name.endsWith("/"))
        .sort();
      expect(actualFiles).toEqual([...contract.files].sort());
    }
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
  });

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
  });
});
