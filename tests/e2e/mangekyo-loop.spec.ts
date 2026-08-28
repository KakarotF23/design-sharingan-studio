import { execFile as execFileCallback } from "node:child_process";
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";

const execFile = promisify(execFileCallback);
let sandboxPath: string;
let projectPath: string;
let referenceImagePath: string;

test.beforeAll(async () => {
  sandboxPath = await mkdtemp(join(tmpdir(), "design-sharingan-mangekyo-e2e-"));
  projectPath = join(sandboxPath, "mangekyo-fixture");
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
    `${JSON.stringify({ name: packageRecord.name, lockfileVersion: 3, requires: true, packages: {} }, null, 2)}\n`,
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
  await execFile("git", ["init", "-b", "mangekyo-fixture"], { cwd: projectPath });
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
});

test.afterAll(async () => {
  await rm(sandboxPath, {
    force: true,
    recursive: true,
    maxRetries: 5,
    retryDelay: 50,
  });
});

test("allows a style round then enters a durable HUMAN_GATE before a navigation mutation", async ({
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
  await page.getByLabel("Reference title").fill("Calm evidence reference");
  await page.getByRole("button", { name: "Add reference" }).click();
  await expect(page.getByRole("heading", { name: "Calm evidence reference" })).toBeVisible();

  await page.goto((studioPath as string).replace(/\/overview$/, "/learn"));
  await page.getByRole("button", { name: "EVOLVE" }).click();
  await page.getByLabel("Feature name").fill("Evidence hierarchy");
  await page.getByLabel("Goal").fill("Strengthen the evidence hierarchy.");
  await page.getByLabel("Description").fill("Refine the current rendered hierarchy.");
  await page.getByLabel("Constraints").fill("Keep existing navigation");
  await page.getByLabel("Must keep").fill("The current route and actions");
  await page.getByLabel("Must not change").fill("Do not add navigation");
  await page.getByLabel("Success criteria").fill("The primary heading is visually dominant");
  await page.getByRole("button", { name: "Run EVOLVE" }).click();
  await page.getByRole("button", { name: "Approve Guided evidence queue" }).click();
  await expect(page).toHaveURL(/\/execute$/);

  await page.getByRole("button", { name: "Prepare change proposal" }).click();
  await expect(page.getByRole("heading", { name: "Safe Mode change proposal" })).toBeVisible();
  await page.getByRole("button", { name: "Approve & Execute" }).click();
  await expect(page.getByRole("heading", { name: "Approved mutation applied" })).toBeVisible();

  const sourceBeforeLoop = await readFile(join(projectPath, "server.mjs"), "utf8");
  const stylesBeforeLoop = await readFile(join(projectPath, "styles.css"), "utf8");
  expect(sourceBeforeLoop).not.toContain("data-mangekyo-navigation");
  await rm(join(projectPath, ".git"), { force: true, recursive: true });

  await page.getByRole("button", { name: "Mangekyō" }).click();
  await expect(page.getByRole("heading", { name: "Mangekyō visual loop" })).toBeVisible();
  await expect(
    page.getByRole("complementary", { name: "Workspace context" }).getByText("Mangekyō", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Start Mangekyō loop" }).click();

  await expect(page.getByRole("heading", { name: "Human decision required" })).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByText("Round 01", { exact: true })).toBeVisible();
  await expect(page.getByText("IMPORTANT", { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("img", { name: "Reference: Calm evidence reference" })).toBeVisible();
  await expect(page.getByRole("img", { name: "Current render for /" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Reject" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Approve Once" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Expand Scope" })).toBeVisible();
  await expect(page.locator(".mangekyo-activity")).toContainText("Human decision required");
  await expect(page.locator(".visual-rounds")).toContainText("UX integrity");
  await expect(page.locator(".visual-rounds")).toContainText("Product consistency");
  await expect(page.locator(".visual-rounds")).toContainText("Accessibility");
  await expect(page.locator(".visual-rounds")).toContainText("Genome integrity");
  await expect(page.locator(".visual-rounds")).toContainText("NOT_VERIFIED");

  const sourceAtGate = await readFile(join(projectPath, "server.mjs"), "utf8");
  const stylesAtGate = await readFile(join(projectPath, "styles.css"), "utf8");
  expect(stylesAtGate).not.toBe(stylesBeforeLoop);
  expect(sourceAtGate).toBe(sourceBeforeLoop);
  expect(sourceAtGate).not.toContain("data-mangekyo-navigation");
  const loopRecord = (
    await Promise.all(
      (await readdir(join(projectPath, ".design-sharingan", "sessions")))
        .filter((file) => file.endsWith(".json"))
        .map(async (file) =>
          JSON.parse(
            await readFile(
              join(projectPath, ".design-sharingan", "sessions", file),
              "utf8",
            ),
          ) as Record<string, unknown>,
        ),
    )
  ).find((record) => record.type === "MANGEKYO_LOOP");
  expect(loopRecord).toMatchObject({
    status: "HUMAN_GATE",
    rounds: [{
      mutationSourceRevision: { kind: "UNVERSIONED", available: true, truncated: false },
      round: {
        roundNumber: 1,
        afterRender: {
          sourceRevision: { kind: "UNVERSIONED", available: true, truncated: false },
        },
      },
    }],
    currentGate: {
      requestedChange: { kind: "NAVIGATION_CHANGE", files: ["server.mjs"] },
    },
  });
  const projectedPayload = await page.evaluate(async () => {
    const response = await fetch(`${location.pathname}/mangekyo/data`, { cache: "no-store" });
    return response.json() as Promise<unknown>;
  });
  const serializedPayload = JSON.stringify(projectedPayload);
  expect(Buffer.byteLength(serializedPayload, "utf8")).toBeLessThan(256 * 1024);
  expect(serializedPayload).not.toContain(projectPath);
  expect(serializedPayload).not.toContain("imagePath");
  expect(serializedPayload).not.toContain(".design-sharingan/renders");

  await page.screenshot({
    path: resolve(
      ".superpowers/sdd/2026-08-24-design-sharingan-studio-v0.1-implementation-plan/task-11-mangekyo-desktop.png",
    ),
    fullPage: true,
  });

  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(() => ({
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
    })),
  ).toEqual({ clientWidth: 390, scrollWidth: 390 });
  await page.screenshot({
    path: resolve(
      ".superpowers/sdd/2026-08-24-design-sharingan-studio-v0.1-implementation-plan/task-11-mangekyo-mobile.png",
    ),
    fullPage: true,
  });

  await page.getByRole("button", { name: "Reject" }).click();
  await expect(page.getByText("BLOCKED", { exact: true })).toBeVisible();
  await expect(page.locator(".mangekyo-activity")).toContainText(
    "stopped without a whole-product pass",
  );
  expect(await readFile(join(projectPath, "server.mjs"), "utf8")).toBe(sourceBeforeLoop);

  const startEndpoint = `${new URL(studioPath as string, "http://studio.invalid").pathname.replace(/\/overview$/, "/execute")}/mangekyo/start`;
  const competingStarts = await page.evaluate(
    async ({ endpoint, sourceSessionId }) => Promise.all(
      [0, 1].map(async () => {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ safeSessionId: sourceSessionId }),
        });
        return { status: response.status, payload: await response.json() as unknown };
      }),
    ),
    { endpoint: startEndpoint, sourceSessionId: (loopRecord as { sourceExecutionSessionId: string }).sourceExecutionSessionId },
  );
  expect(competingStarts.map(({ status }) => status).sort()).toEqual([200, 422]);
  const acceptedStart = competingStarts.find(({ status }) => status === 200)?.payload as {
    session?: { id?: string; status?: string };
  };
  expect(acceptedStart.session?.id).not.toBe((loopRecord as { id: string }).id);
  expect(acceptedStart.session?.status).toBe("HUMAN_GATE");
  const retainedLoops = (
    await Promise.all(
      (await readdir(join(projectPath, ".design-sharingan", "sessions")))
        .filter((file) => file.endsWith(".json"))
        .map(async (file) => JSON.parse(
          await readFile(join(projectPath, ".design-sharingan", "sessions", file), "utf8"),
        ) as { type?: string }),
    )
  ).filter(({ type }) => type === "MANGEKYO_LOOP");
  expect(retainedLoops).toHaveLength(2);

  await page.reload();
  await page.getByRole("button", { name: "Mangekyō" }).click();
  await expect(page.getByRole("heading", { name: "Human decision required" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Stop visual loop" })).toBeVisible();
  await page.getByRole("button", { name: "Stop visual loop" }).click();
  await expect(page.getByText("BLOCKED", { exact: true })).toBeVisible();
  await expect(page.locator(".mangekyo-activity")).toContainText(
    "stopped without a whole-product pass",
  );
  await page.reload();
  await page.getByRole("button", { name: "Mangekyō" }).click();
  await expect(page.getByText("BLOCKED", { exact: true })).toBeVisible();
  const stoppedLoop = (
    await Promise.all(
      (await readdir(join(projectPath, ".design-sharingan", "sessions")))
        .filter((file) => file.endsWith(".json"))
        .map(async (file) => JSON.parse(
          await readFile(join(projectPath, ".design-sharingan", "sessions", file), "utf8"),
        ) as Record<string, unknown>),
    )
  ).find((record) => record.id === acceptedStart.session?.id);
  expect(stoppedLoop).toMatchObject({
    status: "BLOCKED",
    stopRequest: {
      loopSessionId: acceptedStart.session?.id,
      requestedBy: "local-user",
    },
  });
  expect(stoppedLoop).not.toHaveProperty("finalRender");
});
