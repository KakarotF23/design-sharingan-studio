import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { listReferences } from "@design-sharingan/project-adapters";

let sandboxPath: string;
let projectPath: string;
let referenceImagePath: string;

test.beforeAll(async () => {
  sandboxPath = await mkdtemp(join(tmpdir(), "design-sharingan-drift-audit-"));
  projectPath = join(sandboxPath, "drift-renderable-fixture");
  referenceImagePath = join(sandboxPath, "drift-reference.png");
  await cp(resolve(process.cwd(), "tests/fixtures/renderable-next"), projectPath, { recursive: true });
  const packageRecord = JSON.parse(await readFile(join(projectPath, "package.json"), "utf8")) as Record<string, unknown>;
  await writeFile(join(projectPath, "package.json"), `${JSON.stringify({
    ...packageRecord,
    scripts: { start: "react-scripts start" },
    dependencies: { react: "latest" },
  }, null, 2)}\n`);
  const binPath = join(projectPath, "node_modules", ".bin");
  await mkdir(binPath, { recursive: true });
  const reactScriptsPath = join(binPath, "react-scripts");
  await writeFile(reactScriptsPath, '#!/usr/bin/env node\nawait import(new URL("../../server.mjs", import.meta.url));\n');
  await chmod(reactScriptsPath, 0o755);
  await writeFile(join(projectPath, "package-lock.json"), `${JSON.stringify({
    name: packageRecord.name,
    lockfileVersion: 3,
    requires: true,
    packages: {},
  }, null, 2)}\n`);
  await writeFile(join(projectPath, "styles.css"), "body { color: #e8edf4; }\n");
  await writeFile(referenceImagePath, Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  ));
});

test.afterAll(async () => {
  await rm(sandboxPath, { force: true, recursive: true });
});

test("records partial audit coverage as NOT_VERIFIED and preserves human-readable drift evidence", async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto("/projects?source=local");
  await page.getByLabel("Project folder path").fill(projectPath);
  await page.getByRole("button", { name: "Scan project" }).click();
  const studioPath = await page.getByRole("link", { name: "Open Studio" }).getAttribute("href");
  expect(studioPath).not.toBeNull();
  const projectId = decodeURIComponent(
    new URL(studioPath as string, "http://studio.invalid").pathname.split("/")[2] ?? "",
  );

  await page.goto((studioPath as string).replace(/\/overview$/, "/references"));
  await page.getByLabel("Reference image").setInputFiles(referenceImagePath);
  await page.getByLabel("Reference title").fill("Drift reference");
  await page.getByLabel("Reference tags").fill("drift, evidence");
  await page.getByRole("button", { name: "Add reference" }).click();
  await expect(page.getByRole("heading", { name: "Drift reference" })).toBeVisible();
  const [reference] = await listReferences(projectPath, projectId);
  expect(reference).toBeDefined();
  await page.goto((studioPath as string).replace(/\/overview$/, "/learn"));
  await page.getByLabel("Reference to analyze").selectOption(reference.id);
  await page.getByRole("button", { name: "Analyze" }).click();
  await expect(page.getByRole("heading", { name: "KEEP" })).toBeVisible();
  await page.getByRole("button", { name: "EVOLVE" }).click();
  await page.getByLabel("Drift reference").check();
  await page.getByLabel("Feature name").fill("Governed drift view");
  await page.getByLabel("Goal").fill("Keep drift decisions evidence-bound.");
  await page.getByLabel("Description").fill("Refine drift presentation without changing navigation.");
  await page.getByLabel("Constraints").fill("Keep the existing route");
  await page.getByLabel("Must keep").fill("Human approval remains explicit");
  await page.getByLabel("Must not change").fill("Do not add navigation destinations");
  await page.getByLabel("Success criteria").fill("A fresh render supports the governance decision");
  await page.getByRole("button", { name: "Run EVOLVE" }).click();
  await page.getByRole("button", { name: "Approve Guided evidence queue" }).click();
  await page.getByRole("button", { name: "Prepare change proposal" }).click();
  await expect(page.getByRole("heading", { name: "Safe Mode change proposal" })).toBeVisible();
  await page.getByRole("button", { name: "Approve & Execute" }).click();
  await expect(page.getByRole("heading", { name: "Approved mutation applied" })).toBeVisible();
  await page.getByRole("button", { name: "Mangekyō" }).click();
  await page.getByRole("button", { name: "Start Mangekyō loop" }).click();
  await expect(page.getByRole("heading", { name: "Human decision required" })).toBeVisible({ timeout: 90_000 });

  await page.goto((studioPath as string).replace(/\/overview$/, "/govern"));
  await page.getByRole("button", { name: "Initialize Draft Genome" }).click();
  await page.getByLabel("Preserve the established product hierarchy and component language.").check();
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
