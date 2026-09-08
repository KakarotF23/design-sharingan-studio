import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";
import {
  governanceRootFingerprint,
  parseGovernanceMetadata,
  readDriftReport,
  readEvidenceCatalog,
  readGenome,
  readScreenRegistry,
} from "@design-sharingan/governance";
import {
  isFeatureEvolveApprovedSession,
  isMangekyoLoopSession,
  isReferenceScanResultSession,
  isSafeExecutionSession,
  listReferences,
  listSessions,
  loadProjectMetadata,
  loadReferenceImage,
} from "@design-sharingan/project-adapters";

const execFile = promisify(execFileCallback);

let sandboxPath: string;
let projectPath: string;
let referenceImagePath: string;

async function snapshotProductTree(rootPath: string): Promise<Record<string, string>> {
  const snapshot: Record<string, string> = {};

  async function visit(directoryPath: string, relativeDirectory = ""): Promise<void> {
    const entries = await readdir(directoryPath, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const relativePath = relativeDirectory
        ? join(relativeDirectory, entry.name)
        : entry.name;
      if (
        relativePath === ".design-sharingan" ||
        relativePath === "design-governance" ||
        relativePath === ".git"
      ) {
        continue;
      }
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

function changedProductPaths(
  before: Readonly<Record<string, string>>,
  after: Readonly<Record<string, string>>,
): string[] {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((path) => before[path] !== after[path])
    .sort();
}

function canonicalJson(value: unknown): string {
  function sort(entry: unknown): unknown {
    if (Array.isArray(entry)) return entry.map(sort);
    if (entry !== null && typeof entry === "object") {
      return Object.fromEntries(
        Object.entries(entry)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, nested]) => [key, sort(nested)]),
      );
    }
    return entry;
  }
  const serialized = JSON.stringify(sort(value));
  if (serialized === undefined) throw new Error("Expected governance artifact is not serializable");
  return serialized;
}

function governanceArtifactFingerprint(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function isInside(parentPath: string, candidatePath: string): boolean {
  const offset = relative(parentPath, candidatePath);
  return offset !== ".." && !offset.startsWith(`..${sep}`) && !isAbsolute(offset);
}

// Production break caught: comparing only paths that survive in the after
// snapshot makes an unauthorized deletion invisible to the Safe Mode check.
test("includes deleted product paths in mutation snapshot differences", () => {
  expect(changedProductPaths(
    { "package.json": "file:before", "src/obsolete.ts": "file:before" },
    { "package.json": "file:after" },
  )).toEqual(["package.json", "src/obsolete.ts"]);
});

test.beforeAll(async () => {
  sandboxPath = await mkdtemp(join(tmpdir(), "design-sharingan-full-loop-"));
  projectPath = join(sandboxPath, "full-loop-fixture");
  referenceImagePath = join(sandboxPath, "reference.png");
  await cp(resolve(process.cwd(), "tests/fixtures/renderable-next"), projectPath, {
    recursive: true,
  });

  const packageRecord = JSON.parse(
    await readFile(join(projectPath, "package.json"), "utf8"),
  ) as Record<string, unknown>;
  await writeFile(
    join(projectPath, "package.json"),
    `${JSON.stringify({
      ...packageRecord,
      scripts: { start: "react-scripts start" },
      dependencies: { react: "latest" },
    }, null, 2)}\n`,
    "utf8",
  );
  const binPath = join(projectPath, "node_modules", ".bin");
  await mkdir(binPath, { recursive: true });
  const reactScriptsPath = join(binPath, "react-scripts");
  await writeFile(
    reactScriptsPath,
    '#!/usr/bin/env node\nawait import(new URL("../../server.mjs", import.meta.url));\n',
    "utf8",
  );
  await chmod(reactScriptsPath, 0o755);
  await writeFile(
    join(projectPath, "package-lock.json"),
    `${JSON.stringify({
      name: packageRecord.name,
      lockfileVersion: 3,
      requires: true,
      packages: {},
    }, null, 2)}\n`,
    "utf8",
  );
  const serverSource = await readFile(join(projectPath, "server.mjs"), "utf8");
  const inlineStyle = serverSource.match(/<style>([\s\S]*?)<\/style>/)?.[1];
  if (inlineStyle === undefined) throw new Error("Renderable fixture style block is missing");
  await writeFile(join(projectPath, "styles.css"), `${inlineStyle.trim()}\n`, "utf8");
  await writeFile(
    join(projectPath, "server.mjs"),
    `import { readFileSync } from "node:fs";\n${serverSource.replace(
      /<style>[\s\S]*?<\/style>/,
      '<style>${readFileSync(new URL("./styles.css", import.meta.url), "utf8")}</style>',
    )}`,
    "utf8",
  );
  await writeFile(
    referenceImagePath,
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    ),
  );
  await execFile("git", ["init", "-b", "full-loop-fixture"], { cwd: projectPath });
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
  projectPath = await realpath(projectPath);
});

test.afterAll(async () => {
  await rm(sandboxPath, { force: true, recursive: true, maxRetries: 5, retryDelay: 50 });
});

test("completes the evidence-backed reference-to-governance loop with authenticated durable relations", async ({
  page,
}) => {
  test.setTimeout(240_000);

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
  const project = await loadProjectMetadata(projectPath, projectId);
  expect(project).toMatchObject({
    id: projectId,
    rootPath: projectPath,
    status: "READY",
  });

  await page.goto((studioPath as string).replace(/\/overview$/, "/references"));
  await page.getByLabel("Reference image").setInputFiles(referenceImagePath);
  await page.getByLabel("Reference title").fill("Acceptance reference");
  await page.getByLabel("Reference tags").fill("calm, evidence");
  await page.getByRole("button", { name: "Add reference" }).click();
  await expect(page.getByRole("heading", { name: "Acceptance reference" })).toBeVisible();
  const [reference] = await listReferences(projectPath, projectId);
  expect(reference).toBeDefined();
  const beforeV1 = await snapshotProductTree(projectPath);

  await page.goto((studioPath as string).replace(/\/overview$/, "/learn"));
  await page.getByLabel("Reference to analyze").selectOption(reference.id);
  await page.getByLabel("What do you like?").fill("Clear hierarchy and calm contrast");
  await page.getByLabel("What should be avoided?").fill("Decorative brand imitation");
  await page.getByRole("button", { name: "Analyze" }).click();
  await expect(page.getByRole("heading", { name: "KEEP" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "INVENT" })).toBeVisible();
  expect(await snapshotProductTree(projectPath)).toEqual(beforeV1);

  await page.getByRole("button", { name: "EVOLVE" }).click();
  await page.getByLabel("Acceptance reference").check();
  await page.getByLabel("Feature name").fill("Acceptance evidence queue");
  await page.getByLabel("Goal").fill("Help reviewers triage unresolved design evidence.");
  await page.getByLabel("Description").fill("Add a bounded evidence queue without changing navigation.");
  await page.getByLabel("Constraints").fill("Keep the existing route and local-first workflow");
  await page.getByLabel("Must keep").fill("Reports remain the durable history");
  await page.getByLabel("Must not change").fill("Do not add navigation destinations");
  await page.getByLabel("Success criteria").fill("A reviewer can identify the next decision quickly");
  await page.getByRole("button", { name: "Run EVOLVE" }).click();
  await expect(page.getByRole("heading", { name: "UX Impact Map" })).toBeVisible();
  await page.getByRole("button", { name: "Approve Guided evidence queue" }).click();
  await expect(page).toHaveURL(/\/execute$/);
  expect(await snapshotProductTree(projectPath)).toEqual(beforeV1);

  await page.getByRole("button", { name: "Prepare change proposal" }).click();
  await expect(page.getByRole("heading", { name: "Safe Mode change proposal" })).toBeVisible();
  expect(await snapshotProductTree(projectPath)).toEqual(beforeV1);
  await page.getByRole("button", { name: "Approve & Execute" }).click();
  await expect(page.getByRole("heading", { name: "Approved mutation applied" })).toBeVisible();
  const afterSafeMode = await snapshotProductTree(projectPath);
  expect(changedProductPaths(beforeV1, afterSafeMode)).toEqual(["package.json"]);

  await page.getByRole("button", { name: "Mangekyō" }).click();
  await page.getByRole("button", { name: "Start Mangekyō loop" }).click();
  await expect(page.getByRole("heading", { name: "Human decision required" })).toBeVisible({
    timeout: 90_000,
  });
  await expect(page.getByText("Round 01", { exact: true })).toBeVisible();
  await expect(page.getByRole("img", { name: "Current render for /" })).toBeVisible();

  await page.goto((studioPath as string).replace(/\/overview$/, "/govern"));
  await page.getByRole("button", { name: "Initialize Draft Genome" }).click();
  await expect(page.getByText("DRAFT", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Approve Genome" }).click();
  await expect(page.getByLabel("Design Genome").getByText("AUTHORITATIVE", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Run drift audit" }).click();
  await expect(page.getByRole("heading", { name: "Drift audit" })).toBeVisible();
  const releaseResponse = page.waitForResponse((response) =>
    response.request().method() === "POST" && response.url().endsWith("/govern/release"),
  );
  await page.getByRole("button", { name: "Evaluate release gate" }).click();
  expect((await releaseResponse).status()).toBe(200);
  await expect(page.locator(".release-gate-view__summary").getByText("NOT_VERIFIED", { exact: true })).toBeVisible();

  const references = await listReferences(projectPath, projectId);
  expect(references).toHaveLength(1);
  expect(references[0]).toMatchObject({
    id: reference.id,
    projectId,
    title: "Acceptance reference",
    analysisStatus: "ANALYZED",
  });
  const storedReference = await loadReferenceImage(projectPath, projectId, reference.id);
  expect(Buffer.from(storedReference.bytes).subarray(0, 8)).toEqual(
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  );

  const sessions = await listSessions(projectPath, projectId);
  const scanSession = sessions.find((session) => session.type === "REFERENCE_SCAN");
  const evolveSession = sessions.find((session) => session.type === "FEATURE_EVOLVE");
  const safeSession = sessions.find((session) => session.type === "SAFE_EXECUTION");
  const mangekyoSession = sessions.find((session) => session.type === "MANGEKYO_LOOP");
  const genomeSession = sessions.find((session) => session.type === "GENOME_INIT" && session.status === "APPROVED");
  const driftSession = sessions.find((session) => session.type === "DRIFT_AUDIT");
  const releaseSession = sessions.find((session) => session.type === "RELEASE_GATE");
  expect(scanSession && isReferenceScanResultSession(scanSession)).toBe(true);
  expect(evolveSession && isFeatureEvolveApprovedSession(evolveSession)).toBe(true);
  expect(safeSession && isSafeExecutionSession(safeSession)).toBe(true);
  expect(mangekyoSession && isMangekyoLoopSession(mangekyoSession)).toBe(true);
  expect(genomeSession).toBeDefined();
  expect(driftSession).toBeDefined();
  expect(releaseSession).toBeDefined();
  if (
    !scanSession || !isReferenceScanResultSession(scanSession) ||
    !evolveSession || !isFeatureEvolveApprovedSession(evolveSession) ||
    !safeSession || !isSafeExecutionSession(safeSession) ||
    !mangekyoSession || !isMangekyoLoopSession(mangekyoSession) ||
    !genomeSession || !driftSession || !releaseSession
  ) {
    throw new Error("The full loop did not retain all authenticated session types");
  }

  expect(scanSession).toMatchObject({
    referenceId: reference.id,
    designDNA: { referenceIds: [reference.id] },
    agentThreadId: "fake-reference-scan-thread",
  });
  expect(evolveSession).toMatchObject({
    referenceIds: [reference.id],
    approval: {
      proposalId: evolveSession.approvedApproachId,
      decision: "APPROVED",
      scope: "DESIGN_APPROACH",
    },
    executeSessionId: safeSession.id,
  });
  expect(safeSession).toMatchObject({
    sourceSessionId: evolveSession.id,
    approvedApproachId: evolveSession.approvedApproachId,
    approvalId: evolveSession.approval.id,
    mutationApproval: {
      proposalId: safeSession.proposal.id,
      decision: "APPROVED",
      scope: "CHANGE_PROPOSAL",
    },
    mutationEvidence: {
      proposalId: safeSession.proposal.id,
      filesChanged: ["package.json"],
    },
  });

  expect(mangekyoSession).toMatchObject({
    status: "HUMAN_GATE",
    sourceExecutionSessionId: safeSession.id,
    sourceDesignSessionId: evolveSession.id,
    approvedApproachId: evolveSession.approvedApproachId,
    directionApprovalId: evolveSession.approval.id,
    referenceIds: [reference.id],
  });
  expect(mangekyoSession.rounds).toHaveLength(1);
  const render = mangekyoSession.rounds[0]?.round.afterRender;
  expect(render).toBeDefined();
  if (render === undefined) throw new Error("Mangekyo round did not retain its render");
  expect(render.sessionId).toBe(mangekyoSession.id);
  expect(render.roundId).toBe("round-1");
  expect(isInside(join(projectPath, ".design-sharingan", "renders"), await realpath(render.imagePath))).toBe(true);
  expect((await stat(render.imagePath)).size).toBeGreaterThan(1_000);
  expect((await readFile(render.imagePath)).subarray(0, 8)).toEqual(
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  );

  const [genome, registry, drift, catalog] = await Promise.all([
    readGenome(projectPath, projectId),
    readScreenRegistry(projectPath, projectId),
    readDriftReport(projectPath, projectId),
    readEvidenceCatalog(projectPath, projectId),
  ]);
  expect(genome.value.status).toBe("APPROVED");
  expect(genome.authority).toBe("AUTHORITATIVE");
  expect(genome.value.unconfirmedRules).toContain(
    "Use restrained contrast to separate primary action from evidence.",
  );
  expect(genome.metadata.authority).toMatchObject({
    projectId,
    genomeEntityId: genome.metadata.entityId,
    genomeVersion: genome.value.version,
    documentRevision: genome.metadata.revision,
    approvedBy: "local-user",
  });
  expect(registry.metadata).toMatchObject({
    projectId,
    genomeEntityId: genome.metadata.entityId,
    genomeVersion: genome.value.version,
  });
  expect(registry.records.length).toBeGreaterThan(0);
  expect(drift.metadata).toMatchObject({
    projectId,
    genomeEntityId: genome.metadata.entityId,
    genomeVersion: genome.value.version,
    genomeRevision: genome.metadata.revision,
    registryEntityId: registry.metadata.entityId,
    registryRevision: registry.metadata.revision,
  });
  expect(drift.value).toMatchObject({
    requestedScope: "WHOLE_APP",
    expectedScope: [{ screen: "/", states: ["default", "loading", "error"] }],
    inspectedScope: [],
    overallStatus: "NOT_VERIFIED",
    findings: [],
  });
  expect(drift.value.unavailableScope).toEqual([
    "/#default: No authenticated fresh rendered evidence exists for this required state.",
    "/#loading: No authenticated fresh rendered evidence exists for this required state.",
    "/#error: No authenticated fresh rendered evidence exists for this required state.",
  ]);
  expect(drift.value.unverifiedScope).toEqual(expect.arrayContaining([
    "Whole-product scope requires more than one distinct canonical screen.",
    "UX_NAVIGATION: Deterministic analysis is unavailable.",
    "ACCESSIBILITY_REQUIRED_STATES: Deterministic analysis is unavailable.",
    "PRODUCT_IDENTITY_SCREEN_FAMILY: Deterministic analysis is unavailable.",
    "COMPONENTS_TOKENS: Deterministic analysis is unavailable.",
    "HIERARCHY: Deterministic analysis is unavailable.",
    "MOTION: Deterministic analysis is unavailable.",
    "POLISH: Deterministic analysis is unavailable.",
  ]));
  expect(drift.value.unverifiedScope.slice(-7)).toEqual([
    "UX_NAVIGATION: Deterministic analysis is unavailable.",
    "ACCESSIBILITY_REQUIRED_STATES: Deterministic analysis is unavailable.",
    "PRODUCT_IDENTITY_SCREEN_FAMILY: Deterministic analysis is unavailable.",
    "COMPONENTS_TOKENS: Deterministic analysis is unavailable.",
    "HIERARCHY: Deterministic analysis is unavailable.",
    "MOTION: Deterministic analysis is unavailable.",
    "POLISH: Deterministic analysis is unavailable.",
  ]);
  expect(drift.value.evidenceIds.length).toBeGreaterThan(0);
  expect(drift.value.evidenceIds.every((id) => catalog.some((entry) => entry.id === id))).toBe(true);
  expect(catalog).toContainEqual(expect.objectContaining({
    kind: "RENDER",
    route: render.route,
    authenticatedRenderId: render.id,
    renderSourceRevisionFingerprint: render.sourceRevision.available
      ? render.sourceRevision.worktreeFingerprint
      : undefined,
  }));
  expect(parseGovernanceMetadata(await readFile(join(projectPath, "design-governance", "DESIGN-GENOME.md"), "utf8"))).toMatchObject({
    kind: "DESIGN_GENOME",
    entityId: genome.metadata.entityId,
    revision: genome.metadata.revision,
  });
  expect(parseGovernanceMetadata(await readFile(join(projectPath, "design-governance", "SCREEN-REGISTRY.md"), "utf8"))).toMatchObject({
    kind: "SCREEN_REGISTRY",
    entityId: registry.metadata.entityId,
    revision: registry.metadata.revision,
  });
  expect(parseGovernanceMetadata(await readFile(join(projectPath, "design-governance", "DRIFT-REPORT.md"), "utf8"))).toMatchObject({
    kind: "DRIFT_REPORT",
    entityId: drift.metadata.entityId,
    revision: drift.metadata.revision,
  });
  const rootFingerprint = await governanceRootFingerprint(projectPath);
  expect(genomeSession).toMatchObject({
    entityId: genome.metadata.entityId,
    revision: genome.metadata.revision,
    artifactFingerprint: governanceArtifactFingerprint({
      metadata: genome.metadata,
      value: genome.value,
      payloadHash: genome.payloadHash,
      authority: genome.authority,
    }),
    rootFingerprint,
  });
  expect(driftSession).toMatchObject({
    entityId: drift.metadata.entityId,
    revision: drift.metadata.revision,
    artifactFingerprint: governanceArtifactFingerprint({
      metadata: drift.metadata,
      value: drift.value,
    }),
    rootFingerprint,
  });
  const projectBasePath = (studioPath as string).replace(/\/overview$/, "");
  const governanceResponse = await page.evaluate(async (path) => {
    const response = await fetch(`${path}/govern/data`, { cache: "no-store" });
    return { status: response.status, payload: await response.json() as unknown };
  }, projectBasePath);
  expect(governanceResponse.status).toBe(200);
  expect(governanceResponse.payload).toMatchObject({
    initialized: true,
    genome: { status: "APPROVED", authority: "AUTHORITATIVE" },
    release: {
      status: "NOT_VERIFIED",
      requiredStates: "FAIL",
      freshRenders: "FAIL",
      navigation: "NOT_VERIFIED",
      accessibility: "NOT_VERIFIED",
      functionalVerification: "NOT_VERIFIED",
    },
  });

  const reportsResponse = await page.evaluate(async (path) => {
    const response = await fetch(`${path}/reports/data?offset=0&limit=25`, {
      cache: "no-store",
    });
    return {
      status: response.status,
      payload: await response.json() as {
        sessions?: Array<{ id: string; type: string; status: string; result: string }>;
      },
    };
  }, projectBasePath);
  expect(reportsResponse.status).toBe(200);
  expect(reportsResponse.payload.sessions).toEqual(expect.arrayContaining([
    expect.objectContaining({
      id: genomeSession.id,
      type: "GENOME_INIT",
      status: "APPROVED",
      result: "APPROVED",
    }),
    expect.objectContaining({
      id: driftSession.id,
      type: "DRIFT_AUDIT",
      status: "NOT_VERIFIED",
      result: "NOT_VERIFIED",
    }),
  ]));
  expect(reportsResponse.payload.sessions).toContainEqual(expect.objectContaining({
    id: releaseSession.id,
    type: "RELEASE_GATE",
    status: "NOT_VERIFIED",
    result: "NOT_VERIFIED",
  }));
});
