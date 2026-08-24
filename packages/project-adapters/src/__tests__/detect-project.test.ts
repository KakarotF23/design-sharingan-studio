import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { detectProject } from "../detect-project";

const temporaryRoots: string[] = [];

async function temporaryProject(
  packageJson?: Record<string, unknown>,
): Promise<string> {
  const rootPath = await mkdtemp(join(tmpdir(), "design-sharingan-detect-"));
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

function fixturePath(name: string): string {
  return fileURLToPath(
    new URL(`../../../../tests/fixtures/${name}`, import.meta.url),
  );
}

describe("detectProject", () => {
  // Production break caught: missing the known Next.js dev-script signature leaves a safely runnable project unrenderable.
  it("detects a runnable Next.js project", async () => {
    const result = await detectProject(fixturePath("next-basic"));

    expect(result.framework).toBe("nextjs");
    expect(result.devCommand).toBe("pnpm dev");
    expect(result.capabilities.canRun).toBe(true);
    expect(result.capabilities.canRender).toBe(true);
  });

  // Production break caught: checking generic React before Vite misclassifies Vite React projects and chooses the wrong runtime contract.
  it("uses lockfiles and ordered framework signatures for Vite React", async () => {
    const rootPath = await temporaryProject({
      name: "vite-react",
      scripts: { dev: "vite" },
      dependencies: { react: "latest" },
      devDependencies: { vite: "latest" },
    });
    await writeFile(join(rootPath, "yarn.lock"), "");

    const result = await detectProject(rootPath);

    expect(result.framework).toBe("vite");
    expect(result.packageManager).toBe("yarn");
    expect(result.devCommand).toBe("yarn dev");
  });

  // Production break caught: ignoring the React start signature leaves a standard Create React App project unavailable.
  it("detects the safe start command for a React project", async () => {
    const rootPath = await temporaryProject({
      scripts: { start: "react-scripts start" },
      dependencies: { react: "latest", "react-scripts": "latest" },
    });
    await writeFile(join(rootPath, "package-lock.json"), "{}\n");

    const result = await detectProject(rootPath);

    expect(result.framework).toBe("react");
    expect(result.packageManager).toBe("npm");
    expect(result.devCommand).toBe("npm start");
  });

  // Production break caught: treating an arbitrary script name as executable configuration violates fail-closed intake.
  it("does not guess a command or render target for an unknown project", async () => {
    const rootPath = await temporaryProject({
      scripts: { dev: "unknown-tool serve" },
    });

    const result = await detectProject(rootPath);

    expect(result.devCommand).toBeUndefined();
    expect(result.renderTarget).toBeUndefined();
    expect(result.capabilities.canRun).toBe(false);
    expect(result.capabilities.canRender).toBe(false);
  });

  // Production break caught: failing to inspect route directories or repository state hides render and Git capabilities from Studio.
  it("discovers route directories and Git availability after scripts", async () => {
    const rootPath = await temporaryProject({
      scripts: { dev: "next dev" },
      dependencies: { next: "latest", react: "latest" },
    });
    await Promise.all([
      mkdir(join(rootPath, "app", "dashboard"), { recursive: true }),
      mkdir(join(rootPath, "components")),
      mkdir(join(rootPath, ".git")),
    ]);
    await writeFile(join(rootPath, "app", "dashboard", "page.tsx"), "");

    const result = await detectProject(rootPath);

    expect(result.routes).toEqual(["/dashboard"]);
    expect(result.componentDirectories).toEqual(["components"]);
    expect(result.hasGit).toBe(true);
    expect(result.capabilities.canUseGit).toBe(true);
  });

  // Production break caught: requiring package.json makes a valid selected folder crash instead of reaching configuration review.
  it("returns non-runnable detection for a folder without package metadata", async () => {
    const rootPath = await temporaryProject();

    const result = await detectProject(rootPath);

    expect(result.rootPath).toBe(await realpath(rootPath));
    expect(result.framework).toBeUndefined();
    expect(result.devCommand).toBeUndefined();
    expect(result.capabilities.canRun).toBe(false);
  });
});
