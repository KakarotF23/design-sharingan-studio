import {
  cp,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rm,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "@playwright/test";

let sandboxPath: string;
let projectPath: string;
let targetTreeBefore: Record<string, string>;

async function snapshotTargetTree(
  rootPath: string,
): Promise<Record<string, string>> {
  const snapshot: Record<string, string> = {};

  async function visit(directoryPath: string, relativeDirectory = ""): Promise<void> {
    const entries = await readdir(directoryPath, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const relativePath = relativeDirectory
        ? join(relativeDirectory, entry.name)
        : entry.name;
      if (relativePath === ".design-sharingan") continue;

      const absolutePath = join(directoryPath, entry.name);
      if (entry.isDirectory()) {
        snapshot[relativePath] = "directory";
        await visit(absolutePath, relativePath);
      } else if (entry.isFile()) {
        snapshot[relativePath] = `file:${createHash("sha256")
          .update(await readFile(absolutePath))
          .digest("hex")}`;
      } else if (entry.isSymbolicLink()) {
        snapshot[relativePath] = `symlink:${await readlink(absolutePath)}`;
      } else {
        snapshot[relativePath] = "other";
      }
    }
  }

  await visit(rootPath);
  return snapshot;
}

test.beforeAll(async () => {
  sandboxPath = await mkdtemp(join(tmpdir(), "design-sharingan-evolve-e2e-"));
  projectPath = join(sandboxPath, "next-evolve-fixture");
  await cp(resolve(process.cwd(), "tests/fixtures/next-basic"), projectPath, {
    recursive: true,
  });
  targetTreeBefore = await snapshotTargetTree(projectPath);
});

test.afterAll(async () => {
  await rm(sandboxPath, { force: true, recursive: true });
});

test("creates a Feature Brief, approves one EVOLVE approach, and hands it to Execute without source mutation", async ({
  page,
}) => {
  await page.goto("/projects?source=local");
  await page.getByLabel("Project folder path").fill(projectPath);
  await page.getByRole("button", { name: "Scan project" }).click();
  const studioPath = await page
    .getByRole("link", { name: "Open Studio" })
    .getAttribute("href");
  expect(studioPath).not.toBeNull();

  await page.goto((studioPath as string).replace(/\/overview$/, "/learn"));
  await page.getByRole("button", { name: "EVOLVE" }).click();
  await page.getByLabel("Feature name").fill("Evidence inbox");
  await page
    .getByLabel("Goal")
    .fill("Help reviewers triage unresolved design evidence.");
  await page
    .getByLabel("Description")
    .fill("Add a bounded evidence inbox without changing navigation.");
  await page
    .getByLabel("Constraints")
    .fill("Use the existing project rail\nKeep the workflow local-first");
  await page
    .getByLabel("Must keep")
    .fill("Reports remain the durable history");
  await page
    .getByLabel("Must not change")
    .fill("Do not add navigation destinations");
  await page
    .getByLabel("Success criteria")
    .fill("A reviewer can triage one item in under a minute");
  await page.getByRole("button", { name: "Run EVOLVE" }).click();

  await expect
    .poll(async () => {
      const sessionsPath = join(projectPath, ".design-sharingan", "sessions");
      const files = await readdir(sessionsPath).catch(() => []);
      for (const file of files.filter((entry) => entry.endsWith(".json"))) {
        const record = JSON.parse(
          await readFile(join(sessionsPath, file), "utf8"),
        ) as { type?: string; status?: string };
        if (record.type === "FEATURE_EVOLVE") return record.status;
      }
      return undefined;
    }, { intervals: [10], timeout: 5_000 })
    .toBe("ANALYZING");

  await expect(
    page.getByRole("heading", { name: "UX Impact Map" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Reference review" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Guided evidence queue" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Inline review markers" }),
  ).toBeVisible();
  await expect(page.getByText("RECOMMENDED", { exact: true })).toBeVisible();

  await page
    .getByRole("button", { name: "Approve Guided evidence queue" })
    .click();
  await expect(page).toHaveURL(/\/execute$/);
  await expect(
    page.getByRole("heading", { name: "Approved direction" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Guided evidence queue" }),
  ).toBeVisible();
  await expect(
    page.getByText("Ready for change proposal", { exact: true }),
  ).toBeVisible();

  expect(await snapshotTargetTree(projectPath)).toEqual(targetTreeBefore);

  const records = await Promise.all(
    (await readdir(join(projectPath, ".design-sharingan", "sessions")))
      .filter((file) => file.endsWith(".json"))
      .map(async (file) =>
        JSON.parse(
          await readFile(
            join(projectPath, ".design-sharingan", "sessions", file),
            "utf8",
          ),
        ) as Record<string, unknown>,
      ),
  );
  const evolve = records.find((record) => record.type === "FEATURE_EVOLVE");
  const execute = records.find((record) => record.type === "SAFE_EXECUTION");
  expect(evolve).toMatchObject({
    status: "APPROVED",
    approvedApproachId: "approach-guided-queue",
    approval: {
      proposalId: "approach-guided-queue",
      decision: "APPROVED",
      scope: "DESIGN_APPROACH",
    },
  });
  expect(execute).toMatchObject({
    status: "IDLE",
    sourceSessionId: evolve?.id,
    approvedApproachId: "approach-guided-queue",
    approvalId: (evolve?.approval as { id?: string } | undefined)?.id,
  });
});
