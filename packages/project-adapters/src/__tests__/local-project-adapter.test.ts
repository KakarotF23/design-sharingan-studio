import {
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalProjectAdapter } from "../local-project-adapter";

const temporaryRoots: string[] = [];

async function temporaryProject(
  packageJson?: Record<string, unknown>,
): Promise<string> {
  const rootPath = await mkdtemp(join(tmpdir(), "design-sharingan-local-"));
  temporaryRoots.push(rootPath);
  if (packageJson !== undefined) {
    await writeFile(
      join(rootPath, "package.json"),
      `${JSON.stringify(packageJson, null, 2)}\n`,
    );
  }
  return rootPath;
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((rootPath) =>
      rm(rootPath, { force: true, recursive: true }),
    ),
  );
});

describe("LocalProjectAdapter", () => {
  // Production break caught: adapting a folder without persisting canonical LOCAL identity disconnects later artifact writes from the active project.
  it("returns and persists a LOCAL workspace for the selected root", async () => {
    const selectedRoot = await temporaryProject({
      name: "local-next",
      scripts: { dev: "next dev" },
      dependencies: { next: "latest", react: "latest" },
    });

    const workspace = await new LocalProjectAdapter().open(selectedRoot);
    const canonicalRoot = await realpath(selectedRoot);
    const persisted = JSON.parse(
      await readFile(
        join(canonicalRoot, ".design-sharingan", "project.json"),
        "utf8",
      ),
    ) as Record<string, unknown>;

    expect(workspace.rootPath).toBe(canonicalRoot);
    expect(workspace.sourceType).toBe("LOCAL");
    expect(workspace.status).toBe("READY");
    expect(persisted).toMatchObject({
      id: workspace.id,
      rootPath: canonicalRoot,
      sourceType: "LOCAL",
      status: "READY",
    });
    expect(persisted).not.toHaveProperty("capabilities");
  });

  // Production break caught: guessing readiness for an unrecognized folder permits later code execution without reviewed configuration.
  it("returns NEEDS_CONFIGURATION when no safe runtime is detected", async () => {
    const selectedRoot = await temporaryProject({
      name: "unknown",
      scripts: { dev: "unknown-tool serve" },
    });

    const workspace = await new LocalProjectAdapter().open(selectedRoot);

    expect(workspace.status).toBe("NEEDS_CONFIGURATION");
    expect(workspace.capabilities.canRun).toBe(false);
    expect(workspace.capabilities.canRender).toBe(false);
  });

  // Production break caught: package-manager ambiguity must reach Studio intake as configuration-required, never as runnable.
  it.each([
    {
      name: "an unsupported declaration",
      packageManager: "bun@1.2.0",
      lockfiles: [] as string[],
    },
    {
      name: "conflicting lockfiles",
      packageManager: undefined,
      lockfiles: ["pnpm-lock.yaml", "yarn.lock"],
    },
  ])("returns NEEDS_CONFIGURATION for $name", async ({
    packageManager,
    lockfiles,
  }) => {
    const selectedRoot = await temporaryProject({
      name: "ambiguous-next",
      ...(packageManager === undefined ? {} : { packageManager }),
      scripts: { dev: "next dev" },
      dependencies: { next: "latest", react: "latest" },
    });
    await Promise.all(
      lockfiles.map((lockfile) => writeFile(join(selectedRoot, lockfile), "")),
    );

    const workspace = await new LocalProjectAdapter().open(selectedRoot);

    expect(workspace.packageManager).toBeUndefined();
    expect(workspace.devCommand).toBeUndefined();
    expect(workspace.capabilities.canRun).toBe(false);
    expect(workspace.status).toBe("NEEDS_CONFIGURATION");
  });
});
