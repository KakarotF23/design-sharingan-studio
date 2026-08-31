import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "@playwright/test";

let sandboxPath: string;
let projectPath: string;

test.beforeAll(async () => {
  sandboxPath = await mkdtemp(join(tmpdir(), "design-sharingan-drift-audit-"));
  projectPath = join(sandboxPath, "next-drift-fixture");
  await cp(resolve(process.cwd(), "tests/fixtures/next-basic"), projectPath, { recursive: true });
});

test.afterAll(async () => {
  await rm(sandboxPath, { force: true, recursive: true });
});

test("records partial audit coverage as NOT_VERIFIED and preserves human-readable drift evidence", async ({ page }) => {
  await page.goto("/projects?source=local");
  await page.getByLabel("Project folder path").fill(projectPath);
  await page.getByRole("button", { name: "Scan project" }).click();
  const studioPath = await page.getByRole("link", { name: "Open Studio" }).getAttribute("href");
  expect(studioPath).not.toBeNull();

  await page.goto((studioPath as string).replace(/\/overview$/, "/govern"));
  await page.getByRole("button", { name: "Initialize Draft Genome" }).click();
  await page.getByRole("button", { name: "Approve Genome" }).click();
  await expect(page.getByLabel("Design Genome").getByText("AUTHORITATIVE", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Run drift audit" }).click();

  await expect(page.getByRole("heading", { name: "Drift audit" })).toBeVisible();
  await expect(page.getByText("NOT_VERIFIED", { exact: true }).last()).toBeVisible();
  await expect(page.getByText(/unavailable scope/i)).toBeVisible();
  await expect(readFile(join(projectPath, "design-governance", "DRIFT-REPORT.md"), "utf8"))
    .resolves.toContain("# Drift Report");

  await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" });
  await page.screenshot({
    path: "test-results/task-13-drift-desktop.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }))).toEqual({ clientWidth: 390, scrollWidth: 390 });
  await page.screenshot({
    path: "test-results/task-13-drift-mobile.png",
    fullPage: true,
  });
});
