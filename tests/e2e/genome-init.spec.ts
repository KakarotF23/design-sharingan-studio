import { createHash } from "node:crypto";
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  readdir,
  readlink,
  rm,
  writeFile,
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
import { listReferences, listSessions } from "@design-sharingan/project-adapters";

let sandboxPath: string;
let projectPath: string;
let referenceImagePath: string;
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
  projectPath = join(sandboxPath, "genome-renderable-fixture");
  referenceImagePath = join(sandboxPath, "genome-reference.png");
  await cp(resolve(process.cwd(), "tests/fixtures/renderable-next"), projectPath, {
    recursive: true,
  });
  const packageRecord = JSON.parse(
    await readFile(join(projectPath, "package.json"), "utf8"),
  ) as Record<string, unknown>;
  await writeFile(join(projectPath, "package.json"), `${JSON.stringify({
    ...packageRecord,
    scripts: { start: "react-scripts start" },
    dependencies: { react: "latest" },
  }, null, 2)}\n`);
  const binPath = join(projectPath, "node_modules", ".bin");
  await mkdir(binPath, { recursive: true });
  const reactScriptsPath = join(binPath, "react-scripts");
  await writeFile(
    reactScriptsPath,
    '#!/usr/bin/env node\nawait import(new URL("../../server.mjs", import.meta.url));\n',
  );
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
  projectPath = await realpath(projectPath);
  sourceBefore = await snapshotSource(projectPath);
});

test.afterAll(async () => {
  await rm(sandboxPath, {
    force: true,
    recursive: true,
    maxRetries: 5,
    retryDelay: 50,
  });
});

// Production break caught: enabling the Mangekyō handoff at Safe EDITING races the still-running Safe renderer and loses the start request.
test("initializes a non-authoritative Genome, registers evidence-backed screens, and records local approval", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await page.goto("/projects?source=local");
  await page.getByLabel("Project folder path").fill(projectPath);
  await page.getByRole("button", { name: "Scan project" }).click();
  const studioPath = await page
    .getByRole("link", { name: "Open Studio" })
    .getAttribute("href");
  expect(studioPath).not.toBeNull();
  const projectId = decodeURIComponent(
    new URL(studioPath as string, "http://studio.invalid").pathname.split("/")[2] ?? "",
  );

  await page.goto((studioPath as string).replace(/\/overview$/, "/references"));
  await page.getByLabel("Reference image").setInputFiles(referenceImagePath);
  await page.getByLabel("Reference title").fill("Genome reference");
  await page.getByLabel("Reference tags").fill("governance, evidence");
  await page.getByRole("button", { name: "Add reference" }).click();
  await expect(page.getByRole("heading", { name: "Genome reference" })).toBeVisible();
  const [reference] = await listReferences(projectPath, projectId);
  expect(reference).toBeDefined();
  await page.goto((studioPath as string).replace(/\/overview$/, "/learn"));
  await page.getByLabel("Reference to analyze").selectOption(reference.id);
  await page.getByRole("button", { name: "Analyze" }).click();
  await expect(page.getByRole("heading", { name: "KEEP" })).toBeVisible();
  await page.getByRole("button", { name: "EVOLVE" }).click();
  await page.getByLabel("Genome reference").check();
  await page.getByLabel("Feature name").fill("Governed evidence view");
  await page.getByLabel("Goal").fill("Preserve evidence-bound product decisions.");
  await page.getByLabel("Description").fill("Refine evidence presentation without changing navigation.");
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
  const safe = (await listSessions(projectPath, projectId)).find((session) => session.type === "SAFE_EXECUTION");
  expect(safe?.status).toBe("COMPLETE");
  await page.getByRole("button", { name: "Start Mangekyō loop" }).click();
  await expect(page.getByRole("heading", { name: "Human decision required" })).toBeVisible({
    timeout: 90_000,
  });
  sourceBefore = await snapshotSource(projectPath);

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

  await page.getByLabel("Preserve the established product hierarchy and component language.").check();
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
