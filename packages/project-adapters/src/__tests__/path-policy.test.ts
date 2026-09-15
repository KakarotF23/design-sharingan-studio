import { mkdir, mkdtemp, realpath, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertPathInsideWorkspace } from "../path-policy";

const temporaryRoots: string[] = [];

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryRoots.push(directory);
  return directory;
}

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    temporaryRoots.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
});

describe("assertPathInsideWorkspace", () => {
  // Production break caught: removing the workspace containment check permits arbitrary writes.
  it("rejects writes outside the active project", async () => {
    const sandbox = await temporaryDirectory("design-sharingan-path-");
    const project = join(sandbox, "project");
    const other = join(sandbox, "other");
    await Promise.all([mkdir(project), mkdir(other)]);

    expect(() =>
      assertPathInsideWorkspace(project, join(other, "secret.txt")),
    ).toThrow(/outside active project/i);
  });

  // Production break caught: lexical prefix checks accept sibling paths with the same prefix.
  it("rejects traversal into a sibling whose name shares the project prefix", async () => {
    const sandbox = await temporaryDirectory("design-sharingan-traversal-");
    const project = join(sandbox, "project");
    const sibling = join(sandbox, "project-secrets");
    await Promise.all([mkdir(project), mkdir(sibling)]);

    expect(() =>
      assertPathInsideWorkspace(project, join(project, "..", "project-secrets", "token")),
    ).toThrow(/outside active project/i);
  });

  // Production break caught: resolving only lexical segments lets an in-workspace symlink escape.
  it("rejects a candidate routed through a symlink outside the project", async () => {
    const sandbox = await temporaryDirectory("design-sharingan-symlink-");
    const project = join(sandbox, "project");
    const outside = join(sandbox, "outside");
    await Promise.all([mkdir(project), mkdir(outside)]);
    await symlink(outside, join(project, "escape"));

    expect(() =>
      assertPathInsideWorkspace(project, join(project, "escape", "secret.txt")),
    ).toThrow(/outside active project/i);
  });

  // Production break caught: treating an unresolved dangling symlink as a normal missing path fails open.
  it("rejects an ambiguous candidate beneath a dangling symlink", async () => {
    const sandbox = await temporaryDirectory("design-sharingan-dangling-");
    const project = join(sandbox, "project");
    await mkdir(project);
    await symlink(join(sandbox, "not-created"), join(project, "ambiguous"));

    expect(() =>
      assertPathInsideWorkspace(project, join(project, "ambiguous", "secret.txt")),
    ).toThrow(/cannot resolve.*active project/i);
  });

  // Production break caught: requiring the final file to exist prevents safe validation before creation.
  it("returns a canonical path for a not-yet-created file inside the project", async () => {
    const sandbox = await temporaryDirectory("design-sharingan-inside-");
    const project = join(sandbox, "project");
    const directory = join(project, "nested");
    await mkdir(directory, { recursive: true });

    expect(assertPathInsideWorkspace(project, join(directory, "new.json"))).toBe(
      join(await realpath(directory), "new.json"),
    );
  });

  // Production break caught: using a symlink root lexically rejects valid files in the canonical workspace.
  it("canonicalizes the active project root before comparing candidates", async () => {
    const sandbox = await temporaryDirectory("design-sharingan-root-link-");
    const project = join(sandbox, "real-project");
    const projectLink = join(sandbox, "project-link");
    await mkdir(project);
    await symlink(project, projectLink);

    expect(assertPathInsideWorkspace(projectLink, join(projectLink, "new.json"))).toBe(
      join(await realpath(project), "new.json"),
    );
  });
});
