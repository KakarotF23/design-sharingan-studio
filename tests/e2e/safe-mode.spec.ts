import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cp,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";

const execFile = promisify(execFileCallback);
let sandboxPath: string;
let projectPath: string;
let targetTreeBefore: Record<string, string>;
let headBefore: string;

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
  sandboxPath = await mkdtemp(join(tmpdir(), "design-sharingan-safe-mode-e2e-"));
  projectPath = join(sandboxPath, "next-safe-mode-fixture");
  await cp(resolve(process.cwd(), "tests/fixtures/next-basic"), projectPath, {
    recursive: true,
  });
  await execFile("git", ["init", "-b", "safe-mode-fixture"], { cwd: projectPath });
  await execFile("git", ["add", "."], { cwd: projectPath });
  await execFile(
    "git",
    [
      "-c",
      "user.name=Design Sharingan E2E",
      "-c",
      "user.email=e2e@example.invalid",
      "commit",
      "-m",
      "fixture",
    ],
    { cwd: projectPath },
  );
  headBefore = (
    await execFile("git", ["rev-parse", "HEAD"], { cwd: projectPath })
  ).stdout.trim();
  targetTreeBefore = await snapshotTargetTree(projectPath);
});

test.afterAll(async () => {
  await rm(sandboxPath, { force: true, recursive: true });
});

test("keeps the target unchanged until proposal approval, then applies one bounded Safe Mode mutation with evidence", async ({
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
  await page.getByLabel("Goal").fill("Triage unresolved design evidence.");
  await page.getByLabel("Description").fill("Add a bounded evidence inbox.");
  await page.getByLabel("Constraints").fill("Keep existing navigation");
  await page.getByLabel("Must keep").fill("Reports remain durable");
  await page.getByLabel("Must not change").fill("Do not add routes");
  await page.getByLabel("Success criteria").fill("One item is triaged quickly");
  await page.getByRole("button", { name: "Run EVOLVE" }).click();
  await expect(page.getByRole("heading", { name: "Guided evidence queue" })).toBeVisible();
  await page.getByRole("button", { name: "Approve Guided evidence queue" }).click();
  await expect(page).toHaveURL(/\/execute$/);

  await page.getByRole("button", { name: "Prepare change proposal" }).click();
  await expect
    .poll(async () => {
      const records = await Promise.all(
        (await readdir(join(projectPath, ".design-sharingan", "sessions")))
          .filter((file) => file.endsWith(".json"))
          .map(async (file) =>
            JSON.parse(
              await readFile(
                join(projectPath, ".design-sharingan", "sessions", file),
                "utf8",
              ),
            ) as { type?: string; status?: string },
          ),
      );
      return records.find((record) => record.type === "SAFE_EXECUTION")?.status;
    }, { intervals: [10], timeout: 5_000 })
    .toBe("PROPOSING");

  await page.reload();
  await expect(page.locator(".safe-activity")).toContainText(/read-only/i);
  await expect(page.locator(".safe-activity")).not.toContainText(/applying|running/i);

  await expect(page.getByRole("heading", { name: "Safe Mode change proposal" })).toBeVisible();
  await expect(page.getByText("package.json", { exact: true })).toBeVisible();
  await expect(page.getByText("LOW RISK", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "View Diff Plan" }).click();
  await expect(page.getByText("Modify package.json", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Reject" })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(() => ({
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
    })),
  ).toEqual({ clientWidth: 390, scrollWidth: 390 });
  expect(await snapshotTargetTree(projectPath)).toEqual(targetTreeBefore);

  let releaseRejectedRequest: (() => void) | undefined;
  const holdRejectedRequest = new Promise<void>((resolve) => {
    releaseRejectedRequest = resolve;
  });
  await page.route("**/execute/proposal/decision", async (route) => {
    await holdRejectedRequest;
    await route.abort("failed");
  });
  await page.getByRole("button", { name: "Reject" }).click();
  await expect(page.locator(".safe-activity")).toContainText(
    "Recording proposal rejection",
  );
  await expect(page.locator(".approval-actions .primary-button")).toHaveText(
    "Approve & Execute",
  );
  await expect(page.locator(".safe-activity")).not.toContainText(/applying|running/i);
  releaseRejectedRequest?.();
  await expect(page.getByRole("alert")).toBeVisible();
  await page.unroute("**/execute/proposal/decision");

  const revisionInstruction =
    "Keep the fixture change metadata-only and preserve every existing script.";
  await expect(page.getByRole("button", { name: "Request Revision" })).toBeDisabled();
  await page.getByLabel("Revision instruction").fill(revisionInstruction);
  let releaseRevisionRequest: (() => void) | undefined;
  const holdRevisionRequest = new Promise<void>((resolve) => {
    releaseRevisionRequest = resolve;
  });
  await page.route("**/execute/proposal/decision", async (route) => {
    await holdRevisionRequest;
    const response = await route.fetch();
    await route.fulfill({ response });
  });
  await page.getByRole("button", { name: "Request Revision" }).click();
  await expect(page.locator(".safe-activity")).toContainText(
    "Recording your revision instruction",
  );
  await expect(page.locator(".approval-actions .primary-button")).toHaveText(
    "Approve & Execute",
  );
  await expect(page.locator(".safe-activity")).not.toContainText(/applying|running/i);
  releaseRevisionRequest?.();
  await expect(
    page.getByRole("heading", { name: "Revision requested" }),
  ).toBeVisible();
  await page.unroute("**/execute/proposal/decision");
  expect(await snapshotTargetTree(projectPath)).toEqual(targetTreeBefore);
  await page.getByRole("button", { name: "Prepare revised proposal" }).click();
  await expect(page.locator(".safe-activity")).toContainText(/read-only/i);
  await expect(page.locator(".safe-activity")).not.toContainText(/applying|running/i);
  await expect(page.getByRole("heading", { name: "Safe Mode change proposal" })).toBeVisible();
  await page.getByRole("button", { name: "Approve & Execute" }).click();
  await expect(page.locator(".safe-activity")).toContainText(
    "Approval persisted; controlled mutation is running",
  );
  await page.reload();

  await expect(
    page.getByRole("heading", { name: "Approved mutation applied" }),
  ).toBeVisible();
  await expect(page.getByText("safe-mode-fixture", { exact: true })).toBeVisible();
  await expect(page.getByText("M package.json", { exact: false })).toBeVisible();
  await expect(page.getByText("No auto-commit was created.", { exact: true })).toBeVisible();

  const packageRecord = JSON.parse(
    await readFile(join(projectPath, "package.json"), "utf8"),
  ) as { description?: string };
  expect(packageRecord.description).toBe("Design Sharingan Safe Mode fixture");
  const targetTreeAfter = await snapshotTargetTree(projectPath);
  const changedPaths = [...new Set([
    ...Object.keys(targetTreeBefore),
    ...Object.keys(targetTreeAfter),
  ])].filter((path) => targetTreeBefore[path] !== targetTreeAfter[path]);
  expect(changedPaths).toEqual(["package.json"]);

  const headAfter = (
    await execFile("git", ["rev-parse", "HEAD"], { cwd: projectPath })
  ).stdout.trim();
  expect(headAfter).toBe(headBefore);

  const safeRecord = (
    await Promise.all(
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
    )
  ).find((record) => record.type === "SAFE_EXECUTION");
  expect(safeRecord).toMatchObject({
    status: "EDITING",
    proposal: {
      sessionId: safeRecord?.id,
      filesToModify: ["package.json"],
      status: "PROPOSED",
    },
    proposalThreadId: "fake-safe-mode-proposal-thread",
    mutationApproval: {
      proposalId: (safeRecord?.proposal as { id?: string } | undefined)?.id,
      decision: "APPROVED",
      scope: "CHANGE_PROPOSAL",
    },
    mutationEvidence: {
      proposalId: (safeRecord?.proposal as { id?: string } | undefined)?.id,
      threadId: "fake-safe-mode-proposal-thread",
      filesChanged: ["package.json"],
      git: { available: true, branch: "safe-mode-fixture" },
    },
    proposalHistory: [
      {
        proposal: { status: "PROPOSED" },
        proposalThreadId: "fake-safe-mode-proposal-thread",
        decisionApproval: {
          decision: "REVISION_REQUESTED",
          comment: revisionInstruction,
          scope: "CHANGE_PROPOSAL",
        },
      },
      {
        proposal: {
          id: (safeRecord?.proposal as { id?: string } | undefined)?.id,
          status: "PROPOSED",
        },
        proposalThreadId: "fake-safe-mode-proposal-thread",
        decisionApproval: {
          decision: "APPROVED",
          scope: "CHANGE_PROPOSAL",
        },
      },
    ],
  });
});
