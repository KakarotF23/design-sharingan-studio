import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "@playwright/test";

let sandboxPath: string;
let projectPath: string;
let referenceImagePath: string;

test.beforeAll(async () => {
  sandboxPath = await mkdtemp(join(tmpdir(), "design-sharingan-reports-e2e-"));
  projectPath = join(sandboxPath, "next-reports-fixture");
  referenceImagePath = join(sandboxPath, "reports-reference.png");
  await cp(resolve(process.cwd(), "tests/fixtures/next-basic"), projectPath, { recursive: true });
  await writeFile(
    referenceImagePath,
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    ),
  );
});

test.afterAll(async () => {
  await rm(sandboxPath, { force: true, recursive: true });
});

// Production break caught: Reports can appear to pass by observing only intermediate execution, rather than the fixture's honest terminal render failure and retained mutation evidence.
test("projects fake SCAN and Safe Mode evidence without inventing a verified result", async ({ page }) => {
  await page.goto("/projects?source=local");
  await page.getByLabel("Project folder path").fill(projectPath);
  await page.getByRole("button", { name: "Scan project" }).click();
  const studioPath = await page.getByRole("link", { name: "Open Studio" }).getAttribute("href");
  expect(studioPath).not.toBeNull();

  await page.goto((studioPath as string).replace(/\/overview$/, "/references"));
  await page.getByLabel("Reference image").setInputFiles(referenceImagePath);
  await page.getByLabel("Reference title").fill("Report reference");
  await page.getByRole("button", { name: "Add reference" }).click();
  await expect(page.getByRole("heading", { name: "Report reference" })).toBeVisible();

  await page.goto((studioPath as string).replace(/\/overview$/, "/learn"));
  await page.getByLabel("Reference to analyze").selectOption({ label: "Report reference" });
  await page.getByRole("button", { name: "Analyze" }).click();
  await expect(page.getByRole("heading", { name: "KEEP" })).toBeVisible();

  await page.getByRole("button", { name: "EVOLVE" }).click();
  await page.getByLabel("Feature name").fill("Report evidence");
  await page.getByLabel("Goal").fill("Show session evidence clearly.");
  await page.getByLabel("Description").fill("Add no new navigation destinations.");
  await page.getByLabel("Constraints").fill("Keep approvals explicit");
  await page.getByLabel("Must keep").fill("Reports stay read-only");
  await page.getByLabel("Must not change").fill("Do not alter navigation");
  await page.getByLabel("Success criteria").fill("Evidence is inspectable");
  await page.getByRole("button", { name: "Run EVOLVE" }).click();
  await expect(page.getByRole("heading", { name: "Guided evidence queue" })).toBeVisible();
  await page.getByRole("button", { name: "Approve Guided evidence queue" }).click();
  await expect(page).toHaveURL(/\/execute$/);
  await page.getByRole("button", { name: "Prepare change proposal" }).click();
  await expect(page.getByRole("heading", { name: "Safe Mode change proposal" })).toBeVisible();
  const executionResponse = page.waitForResponse((response) =>
    response.request().method() === "POST" && response.url().endsWith("/execute/proposal/approve"),
  );
  await page.getByRole("button", { name: "Approve & Execute" }).click();
  const executed = await executionResponse;
  expect({ status: executed.status(), payload: await executed.json() }).toMatchObject({
    status: 200,
    payload: { session: { status: "FAILED" } },
  });
  await expect(page.getByRole("heading", { name: "Approved mutation applied" })).toBeVisible();

  await page.goto((studioPath as string).replace(/\/overview$/, "/reports"));
  await expect(page.getByRole("heading", { name: "Reports" })).toBeVisible();
  await expect(page.getByText("REFERENCE_SCAN", { exact: true })).toBeVisible();
  await expect(page.getByText("SAFE_EXECUTION", { exact: true })).toBeVisible();
  await expect(page.getByText("FAILED", { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("link", { name: "Change proposal" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Authenticated captures" })).toBeVisible();
  await expect(page.getByText("Render evidence is unavailable for this session.")).toBeVisible();
  await expect(page.getByText("Thinking…", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: /REFERENCE_SCAN/ }).click();
  const scanEvidenceLink = page.getByRole("link", { name: "Report reference" });
  const scanEvidenceTarget = await scanEvidenceLink.getAttribute("href");
  expect(scanEvidenceTarget).toMatch(/\/references#reference-/);
  await scanEvidenceLink.click();
  await expect(page).toHaveURL(/\/references#reference-/);
  await expect(page.locator(`[id="${(scanEvidenceTarget as string).split("#")[1]}"]`)).toBeVisible();
  await page.goto((studioPath as string).replace(/\/overview$/, "/reports"));
  await expect(page.getByText("Reference analysis evidence saved")).toBeVisible();
  await page.getByRole("button", { name: /FEATURE_EVOLVE/ }).click();
  const linkedSafeEvidence = page.getByRole("link", { name: "Authenticated Safe execution" });
  const linkedSafeTarget = await linkedSafeEvidence.getAttribute("href");
  expect(linkedSafeTarget).toMatch(/\?session=[^#]+#report-session-/);
  await linkedSafeEvidence.click();
  await expect(page).toHaveURL(/\/reports\?session=[^#]+#report-session-/);
  await expect(page.getByRole("heading", { name: "SAFE EXECUTION" })).toBeVisible();
  await page.getByRole("button", { name: /SAFE_EXECUTION/ }).click();
  const safeEvidenceLink = page.getByRole("link", { name: "Mutation evidence" });
  const safeEvidenceTarget = await safeEvidenceLink.getAttribute("href");
  expect(safeEvidenceTarget).toMatch(/^#report-git-/);
  await safeEvidenceLink.click();
  await expect(page.locator(safeEvidenceTarget as string)).toBeVisible();

  await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" });
  await page.screenshot({ path: "test-results/task-14-reports-desktop.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }))).toEqual({ clientWidth: 390, scrollWidth: 390 });
  await page.screenshot({ path: "test-results/task-14-reports-mobile.png", fullPage: true });
});
