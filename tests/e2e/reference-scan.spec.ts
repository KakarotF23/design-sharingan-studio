import {
  cp,
  lstat,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "@playwright/test";
import {
  readProjectJson,
  readProjectMultipart,
} from "../../apps/studio/features/projects/project-request";
import { createAnalysisStagingDirectory } from "../../apps/studio/features/projects/project-locator";
import { isReferenceScanSession } from "../../apps/studio/features/references/reference-types";

let sandboxPath: string;
let projectPath: string;
let referenceImagePath: string;

test.beforeAll(async () => {
  sandboxPath = await mkdtemp(join(tmpdir(), "design-sharingan-reference-e2e-"));
  projectPath = join(sandboxPath, "next-reference-fixture");
  referenceImagePath = join(sandboxPath, "editorial-reference.png");
  await cp(resolve(process.cwd(), "tests/fixtures/next-basic"), projectPath, {
    recursive: true,
  });
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

test("uploads a visual reference, runs SCAN, and saves a report", async ({
  page,
}) => {
  await page.goto("/projects?source=local");
  await page.getByLabel("Project folder path").fill(projectPath);
  await page.getByRole("button", { name: "Scan project" }).click();
  const studioPath = await page
    .getByRole("link", { name: "Open Studio" })
    .getAttribute("href");
  expect(studioPath).not.toBeNull();

  await page.goto((studioPath as string).replace(/\/overview$/, "/references"));
  await page.getByLabel("Reference image").setInputFiles(referenceImagePath);
  await page.getByLabel("Reference title").fill("Editorial control room");
  await page.getByLabel("Reference tags").fill("editorial, calm");
  await page.getByRole("button", { name: "Add reference" }).click();
  await expect(
    page.getByRole("heading", { name: "Editorial control room" }),
  ).toBeVisible();
  await expect(page.getByText("READY", { exact: true })).toBeVisible();
  const referenceImage = page.getByRole("img", {
    name: "Reference image: Editorial control room",
  });
  await expect(referenceImage).toBeVisible();
  const decodedImage = await referenceImage.evaluate(async (element) => {
    const image = element as HTMLImageElement;
    await image.decode();
    return {
      complete: image.complete,
      naturalHeight: image.naturalHeight,
      naturalWidth: image.naturalWidth,
      path: new URL(image.currentSrc).pathname,
    };
  });
  expect(decodedImage).toMatchObject({
    complete: true,
    naturalHeight: 1,
    naturalWidth: 1,
  });
  expect(decodedImage.path).toMatch(
    /^\/projects\/[^/]+\/references\/image\/[^/]+$/,
  );
  expect(decodedImage.path).not.toContain(projectPath);

  await page.goto((studioPath as string).replace(/\/overview$/, "/learn"));
  await page
    .getByLabel("Reference to analyze")
    .selectOption({ label: "Editorial control room" });
  await page
    .getByLabel("What do you like?")
    .fill("Clear hierarchy and deliberate contrast");
  await page
    .getByLabel("What should be avoided?")
    .fill("Branded artwork and decorative controls");
  await page
    .getByLabel("I don't know — analyze it for me")
    .check();
  await page.getByRole("button", { name: "Analyze" }).click();

  await expect
    .poll(async () => {
      const sessionsPath = join(projectPath, ".design-sharingan", "sessions");
      const files = await readdir(sessionsPath).catch(() => []);
      const [sessionFile] = files.filter((file) => file.endsWith(".json"));
      if (sessionFile === undefined) return undefined;
      const session = JSON.parse(
        await readFile(join(sessionsPath, sessionFile), "utf8"),
      ) as { status?: string };
      return session.status;
    }, { intervals: [10], timeout: 5_000 })
    .toBe("ANALYZING");

  for (const decision of ["KEEP", "REJECT", "ADAPT", "INVENT"]) {
    await expect(page.getByRole("heading", { name: decision })).toBeVisible();
  }
  await expect(page.getByText("Clear hierarchy", { exact: true })).toBeVisible();
  await expect(
    page.getByText("Add an explicit product-fit decision trail", {
      exact: true,
    }),
  ).toBeVisible();

  await page.goto((studioPath as string).replace(/\/overview$/, "/reports"));
  await expect(page.getByText("REFERENCE_SCAN", { exact: true })).toBeVisible();
  await expect(page.getByText("Editorial control room", { exact: true })).toBeVisible();
  await expect(page.getByText("COMPLETE", { exact: true }).first()).toBeVisible();
});

test("project-scoped mutation envelopes stay same-origin, typed, and bounded", async () => {
  const url = "http://127.0.0.1:3000/projects/project-1/learn/scan";
  const accepted = await readProjectJson(
    new Request(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        host: "127.0.0.1:3000",
        origin: "http://127.0.0.1:3000",
      },
      body: JSON.stringify({ referenceId: "reference-1" }),
    }),
  );
  expect(accepted.ok).toBe(true);

  const crossOrigin = await readProjectJson(
    new Request(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        host: "127.0.0.1:3000",
        origin: "https://attacker.example",
      },
      body: "{}",
    }),
  );
  expect(crossOrigin.ok).toBe(false);
  if (!crossOrigin.ok) expect(crossOrigin.response.status).toBe(403);

  const oversized = await readProjectMultipart(
    new Request(url, {
      method: "POST",
      headers: {
        "content-type": "multipart/form-data; boundary=fixture",
        "content-length": String(10 * 1024 * 1024 + 65 * 1024),
        host: "127.0.0.1:3000",
        origin: "http://127.0.0.1:3000",
      },
      body: "--fixture--\r\n",
    }),
  );
  expect(oversized.ok).toBe(false);
  if (!oversized.ok) expect(oversized.response.status).toBe(413);
});

test("analysis staging rejects target overlap and permits only a disjoint canonical root", async () => {
  const originalStateRoot = process.env.DESIGN_SHARINGAN_STATE_ROOT;
  const canonicalTarget = await realpath(projectPath);
  const canonicalSandbox = await realpath(sandboxPath);
  const descendantState = join(canonicalTarget, "unsafe-studio-state");
  const canonicalLink = join(canonicalSandbox, "target-state-link");
  const disjointState = join(canonicalSandbox, "isolated-studio-state");
  await symlink(canonicalTarget, canonicalLink);

  try {
    for (const unsafeState of [
      canonicalTarget,
      descendantState,
      canonicalSandbox,
      canonicalLink,
    ]) {
      process.env.DESIGN_SHARINGAN_STATE_ROOT = unsafeState;
      await expect(
        createAnalysisStagingDirectory(canonicalTarget),
      ).rejects.toThrow(/overlap/i);
    }
    await expect(lstat(descendantState)).rejects.toMatchObject({ code: "ENOENT" });

    process.env.DESIGN_SHARINGAN_STATE_ROOT = disjointState;
    const stagingPath = await createAnalysisStagingDirectory(canonicalTarget);
    expect(stagingPath.startsWith(`${disjointState}/analysis/scan-`)).toBe(true);
    expect((await lstat(stagingPath)).isDirectory()).toBe(true);
  } finally {
    if (originalStateRoot === undefined) {
      delete process.env.DESIGN_SHARINGAN_STATE_ROOT;
    } else {
      process.env.DESIGN_SHARINGAN_STATE_ROOT = originalStateRoot;
    }
  }
});

test("Reports projects only validated REFERENCE_SCAN session shapes", () => {
  expect(
    isReferenceScanSession({
      id: "audit-1",
      projectId: "project-1",
      type: "DRIFT_AUDIT",
      status: "RESULT_READY",
      createdAt: "2026-08-25T00:00:00.000Z",
      updatedAt: "2026-08-25T00:00:00.000Z",
    }),
  ).toBe(false);
  expect(
    isReferenceScanSession({
      id: "scan-malformed",
      projectId: "project-1",
      type: "REFERENCE_SCAN",
      status: "RESULT_READY",
      createdAt: "2026-08-25T00:00:00.000Z",
      updatedAt: "2026-08-25T00:00:00.000Z",
    }),
  ).toBe(false);
});
