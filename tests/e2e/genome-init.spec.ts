import { createHash } from "node:crypto";
import {
  cp,
  mkdtemp,
  readFile,
  realpath,
  readdir,
  readlink,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "@playwright/test";
import {
  parseGovernanceMetadata,
  readEvidenceCatalog,
  readGenome,
  renderDesignDecisions,
  renderGenome,
  renderScreenRegistry,
} from "@design-sharingan/governance";

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
  projectPath = await realpath(projectPath);
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
  await expect(page.getByText("UNCONFIRMED", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("NOT_VERIFIED", { exact: true }).first()).toBeVisible();
  await expect(page.locator(".ds-sidebar__health dd").first()).toContainText(
    "DRAFT · v0.1.0 · Non-authoritative",
  );
  await expect(page.locator(".ds-sidebar").getByText("Not initialized", { exact: true })).toHaveCount(0);

  const governancePath = join(projectPath, "design-governance");
  for (const fileName of [
    "DESIGN-GENOME.md",
    "SCREEN-REGISTRY.md",
    "DESIGN-DECISIONS.md",
  ]) {
    await expect.poll(() => readFile(join(governancePath, fileName), "utf8")).not.toBe("");
  }
  const draftMarkdown = await readFile(join(governancePath, "DESIGN-GENOME.md"), "utf8");
  const registryMarkdown = await readFile(join(governancePath, "SCREEN-REGISTRY.md"), "utf8");
  const decisionsMarkdown = await readFile(join(governancePath, "DESIGN-DECISIONS.md"), "utf8");
  const draft = parseGovernanceMetadata(draftMarkdown);
  const registry = parseGovernanceMetadata(registryMarkdown);
  const decisions = parseGovernanceMetadata(decisionsMarkdown);
  expect(draft.kind).toBe("DESIGN_GENOME");
  expect(registry.kind).toBe("SCREEN_REGISTRY");
  expect(decisions.kind).toBe("DESIGN_DECISIONS");
  if (draft.kind !== "DESIGN_GENOME" || registry.kind !== "SCREEN_REGISTRY" || decisions.kind !== "DESIGN_DECISIONS") {
    throw new Error("Governance E2E documents have unexpected kinds");
  }
  expect(renderGenome(draft)).toBe(draftMarkdown);
  expect(renderScreenRegistry(registry)).toBe(registryMarkdown);
  expect(renderDesignDecisions(decisions)).toBe(decisionsMarkdown);
  expect(draft.inspectedScope).toMatchObject({ representative: true });
  expect(draft.inspectedScope.routes.length).toBeGreaterThan(0);
  expect(draft.claimCitations.length).toBeGreaterThan(0);
  expect(draft.claimCitations.every(({ confidence }) => confidence === "UNCONFIRMED")).toBe(true);
  const evidenceCatalog = await readEvidenceCatalog(projectPath, draft.projectId);
  expect(evidenceCatalog.map(({ id }) => id).sort()).toEqual(
    [...draft.inspectedScope.evidenceIds].sort(),
  );
  expect(registry.genomeEntityId).toBe(draft.entityId);
  expect(registry.genomeVersion).toBe(draft.value.version);
  expect(registry.genomeRevision).toBe(draft.revision);
  expect(registry.records.length).toBeGreaterThan(0);
  expect(new Set(registry.records.map(({ route }) => route)).size).toBe(registry.records.length);
  expect(registry.records.every(({ driftStatus, lastVerified }) => driftStatus === "NOT_VERIFIED" && lastVerified === undefined)).toBe(true);
  expect(registry.records.flatMap(({ evidence }) => evidence).every((id) => registry.evidenceIds.includes(id) && /^ev_/.test(id))).toBe(true);
  expect(decisions.genomeEntityId).toBe(draft.entityId);
  expect(decisions.genomeVersion).toBe(draft.value.version);
  expect(decisions.decisions).toEqual([]);
  expect(decisions.approvalProofs).toEqual([]);
  expect(draftMarkdown).toContain("\"status\":\"DRAFT\"");
  expect(draftMarkdown).toContain("## Unconfirmed Rules");

  const dataPath = `${(studioPath as string).replace(/\/overview$/, "")}/govern/data`;
  await expect(page.evaluate(async (path) => (await fetch(path, { cache: "no-store" })).status, dataPath)).resolves.toBe(200);
  const rejectedGet = await page.request.get(new URL(dataPath, page.url()).href, {
    headers: { origin: "https://evil.example" },
  });
  expect(rejectedGet.status()).toBe(403);

  await page.getByRole("button", { name: "Approve Genome" }).click();
  await expect(page.getByText("APPROVED", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("AUTHORITATIVE", { exact: true }).first()).toBeVisible();
  await expect(page.locator(".ds-sidebar__health dd").first()).toContainText(
    "APPROVED · v0.1.0 · Authoritative",
  );
  await expect(page.getByText("GENOME / VERSION 0.1.0", { exact: true })).toBeVisible();
  const approvedMarkdown = await readFile(
    join(governancePath, "DESIGN-GENOME.md"),
    "utf8",
  );
  expect(approvedMarkdown).toContain("\"status\":\"APPROVED\"");
  expect(approvedMarkdown).toContain("\"approvedBy\":\"local-user\"");
  const approved = parseGovernanceMetadata(approvedMarkdown);
  expect(approved.kind).toBe("DESIGN_GENOME");
  if (approved.kind !== "DESIGN_GENOME") throw new Error("Approved Genome kind changed");
  expect(approved.authority).toMatchObject({
    kind: "GENOME_AUTHORITY",
    projectId: draft.projectId,
    genomeEntityId: draft.entityId,
    genomeVersion: draft.value.version,
    approvedDraftRevision: draft.revision,
    documentRevision: draft.revision + 1,
    approvedBy: "local-user",
  });
  expect(approved.authority?.rootFingerprint).toMatch(/^[a-f0-9]{64}$/);
  expect(approved.authority?.rootFingerprint).not.toContain(projectPath);
  await expect(readGenome(projectPath, draft.projectId)).resolves.toMatchObject({
    authority: "AUTHORITATIVE",
    payloadHash: approved.authority?.payloadHash,
  });

  await page.reload();
  await expect(page.getByRole("heading", { name: "Design Genome" })).toBeVisible();
  await expect(page.locator(".ds-sidebar__health dd").first()).toContainText(
    "APPROVED · v0.1.0 · Authoritative",
  );
  await expect(page.locator(".ds-sidebar").getByText("Not initialized", { exact: true })).toHaveCount(0);

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
