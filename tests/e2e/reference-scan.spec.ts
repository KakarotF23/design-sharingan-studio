import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "@playwright/test";
import {
  readProjectJson,
  readProjectMultipart,
} from "../../apps/studio/features/projects/project-request";

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
  await expect(page.getByText("RESULT_READY", { exact: true })).toBeVisible();
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
