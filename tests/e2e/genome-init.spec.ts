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
import { expect, test } from "@playwright/test";

let sandboxPath: string;
let projectPath: string;
let sourceBefore: Record<string, string>;

async function snapshotSource(rootPath: string): Promise<Record<string, string>> {
  const snapshot: Record<string, string> = {};
  async function visit(directory: string, relativeDirectory = ""): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const relativePath = relativeDirectory
        ? join(relativeDirectory, entry.name)
        : entry.name;
      if (
        relativePath === ".design-sharingan" ||
        relativePath === "design-governance"
      ) {
        continue;
      }
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        snapshot[relativePath] = "directory";
        await visit(path, relativePath);
      } else if (entry.isFile()) {
        snapshot[relativePath] = `file:${createHash("sha256")
          .update(await readFile(path))
          .digest("hex")}`;
      } else if (entry.isSymbolicLink()) {
        snapshot[relativePath] = `symlink:${await readlink(path)}`;
      }
    }
  }
  await visit(rootPath);
  return snapshot;
}

test.beforeAll(async () => {
  sandboxPath = await mkdtemp(join(tmpdir(), "design-sharingan-genome-e2e-"));
  projectPath = join(sandboxPath, "next-genome-fixture");
  await cp(resolve(process.cwd(), "tests/fixtures/next-basic"), projectPath, {
    recursive: true,
  });
  sourceBefore = await snapshotSource(projectPath);
});

test.afterAll(async () => {
  await rm(sandboxPath, { force: true, recursive: true });
});

test("initializes a non-authoritative Genome, registers evidence-backed screens, and records local approval", async ({
  page,
}) => {
  await page.goto("/projects?source=local");
  await page.getByLabel("Project folder path").fill(projectPath);
  await page.getByRole("button", { name: "Scan project" }).click();
  const studioPath = await page
    .getByRole("link", { name: "Open Studio" })
    .getAttribute("href");
  expect(studioPath).not.toBeNull();

  await page.goto((studioPath as string).replace(/\/overview$/, "/govern"));
  await expect(page.getByRole("heading", { name: "Govern" })).toBeVisible();
  await expect(page.getByText("NON-AUTHORITATIVE", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Initialize Draft Genome" }).click();

  await expect(page.getByRole("heading", { name: "Design Genome" })).toBeVisible();
  await expect(page.getByText("DRAFT", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Unconfirmed Rules" })).toBeVisible();
  await expect(
    page.getByText("Representative evidence does not establish whole-product coverage."),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "Screen Registry" })).toBeVisible();
  await expect(page.getByText("Project workspaces", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("NOT_VERIFIED", { exact: true }).first()).toBeVisible();

  const governancePath = join(projectPath, "design-governance");
  for (const fileName of [
    "DESIGN-GENOME.md",
    "SCREEN-REGISTRY.md",
    "DESIGN-DECISIONS.md",
  ]) {
    await expect.poll(() => readFile(join(governancePath, fileName), "utf8")).not.toBe("");
  }
  const draftMarkdown = await readFile(join(governancePath, "DESIGN-GENOME.md"), "utf8");
  expect(draftMarkdown).toContain("\"status\":\"DRAFT\"");
  expect(draftMarkdown).toContain("## Unconfirmed Rules");

  await page.getByRole("button", { name: "Approve Genome" }).click();
  await expect(page.getByText("APPROVED", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("AUTHORITATIVE", { exact: true }).first()).toBeVisible();
  const approvedMarkdown = await readFile(
    join(governancePath, "DESIGN-GENOME.md"),
    "utf8",
  );
  expect(approvedMarkdown).toContain("\"status\":\"APPROVED\"");
  expect(approvedMarkdown).toContain("\"approvedBy\":\"local-user\"");

  // The Next.js development portal is not part of the Studio render and can
  // cover app content in narrow visual-evidence captures.
  await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" });
  await page.screenshot({
    path: "test-results/task-12-govern-desktop.png",
    fullPage: true,
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("heading", { name: "Screen Registry" })).toBeVisible();
  const layout = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
    genomeWidth: document.querySelector<HTMLElement>(".genome-view")?.getBoundingClientRect().width,
    registryWidth: document
      .querySelector<HTMLElement>(".screen-registry")
      ?.getBoundingClientRect().width,
  }));
  expect(layout.scrollWidth).toBe(layout.clientWidth);
  expect(layout.genomeWidth).toBeLessThanOrEqual(layout.clientWidth);
  expect(layout.registryWidth).toBeLessThanOrEqual(layout.clientWidth);
  await page.screenshot({
    path: "test-results/task-12-govern-mobile.png",
    fullPage: true,
  });
  expect(await snapshotSource(projectPath)).toEqual(sourceBefore);
});
