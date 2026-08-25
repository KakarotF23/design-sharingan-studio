import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "@playwright/test";

let sandboxPath: string;
let localProjectPath: string;

test.beforeAll(async () => {
  sandboxPath = await mkdtemp(join(tmpdir(), "design-sharingan-intake-e2e-"));
  localProjectPath = join(sandboxPath, "next-basic");
  await cp(
    resolve(process.cwd(), "tests/fixtures/next-basic"),
    localProjectPath,
    { recursive: true },
  );
});

test.afterAll(async () => {
  await rm(sandboxPath, { force: true, recursive: true });
});

test("landing routes both project sources into one intake workspace", async ({
  page,
}) => {
  await page.goto("/");

  await page.getByRole("button", { name: "Open Local Project" }).click();
  await expect(page).toHaveURL(/\/projects\?source=local$/);
  await expect(
    page.getByRole("heading", { name: "Connect a local project" }),
  ).toBeVisible();

  await page.goto("/");
  await page.getByRole("button", { name: "Import GitHub Repo" }).click();
  await expect(page).toHaveURL(/\/projects\?source=github$/);
  await expect(
    page.getByRole("heading", { name: "Import a GitHub repository" }),
  ).toBeVisible();
});

test("local intake scans a copied fixture and opens its Studio overview", async ({
  page,
}) => {
  await page.goto("/projects?source=local");
  await page.getByLabel("Project folder path").fill(localProjectPath);
  await page.getByRole("button", { name: "Scan project" }).click();

  const detection = page.getByRole("region", {
    name: "Detected configuration",
  });
  await expect(detection).toBeVisible();
  await expect(detection.getByText("Next.js", { exact: true })).toBeVisible();
  await expect(detection.getByText("pnpm", { exact: true })).toBeVisible();
  await expect(detection.getByText("pnpm dev", { exact: true })).toBeVisible();
  await expect(
    detection.locator("dd").filter({ hasText: /^Ready$/ }),
  ).toBeVisible();
  await expect(
    detection.getByText("Render ready", { exact: true }),
  ).toBeVisible();

  await detection.getByRole("link", { name: "Open Studio" }).click();
  await expect(page).toHaveURL(/\/projects\/[a-f0-9-]+\/overview$/);
  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
});

test("GitHub intake keeps authentication explicitly ephemeral", async ({
  page,
}) => {
  await page.route("**/api/projects/github", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        project: {
          id: "github-intake-fixture",
          name: "github-fixture",
          sourceType: "GITHUB",
          status: "READY",
          framework: "nextjs",
          packageManager: "pnpm",
          devCommand: "pnpm dev",
          capabilities: {
            canReadFiles: true,
            canWriteFiles: true,
            canRun: true,
            canRender: true,
            canCapture: true,
            canUseGit: true,
            canAudit: true,
          },
        },
      }),
    });
  });
  await page.goto("/projects?source=github");

  await expect(page.getByLabel("Repository URL")).toBeVisible();
  await expect(page.getByLabel("Branch")).toHaveValue("main");
  const token = page.getByLabel("Personal access token (optional)");
  await expect(token).toHaveAttribute("type", "password");
  await expect(token).toHaveAttribute("autocomplete", "off");
  await expect(
    page.getByText("Used only for this clone and never returned to the browser."),
  ).toBeVisible();

  await page
    .getByLabel("Repository URL")
    .fill("https://github.com/example/project.git");
  await token.fill("ghp_not_a_real_token");
  await page.getByRole("button", { name: "Import repository" }).click();
  await expect(
    page.getByRole("region", { name: "Detected configuration" }),
  ).toBeVisible();
  await expect(token).toHaveValue("");
  await expect(page.getByText("ghp_not_a_real_token")).toHaveCount(0);
});
