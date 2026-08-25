import {
  cp,
  lstat,
  mkdtemp,
  readFile,
  readdir,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { readIntakeJson } from "../../apps/studio/app/api/projects/intake-request";

let sandboxPath: string;
let localProjectPath: string;
let guardedProjectPath: string;
let refreshProjectPath: string;

const stateRoot = "/private/tmp/design-sharingan-studio-e2e-state";

test.beforeAll(async () => {
  sandboxPath = await mkdtemp(join(tmpdir(), "design-sharingan-intake-e2e-"));
  localProjectPath = join(sandboxPath, "next-basic");
  guardedProjectPath = join(sandboxPath, "guarded-next-basic");
  refreshProjectPath = join(sandboxPath, "refresh-next-basic");
  await rm(stateRoot, { force: true, recursive: true });
  await cp(
    resolve(process.cwd(), "tests/fixtures/next-basic"),
    localProjectPath,
    { recursive: true },
  );
  await cp(
    resolve(process.cwd(), "tests/fixtures/next-basic"),
    guardedProjectPath,
    { recursive: true },
  );
  await cp(
    resolve(process.cwd(), "tests/fixtures/next-basic"),
    refreshProjectPath,
    { recursive: true },
  );
});

test.afterAll(async () => {
  await rm(sandboxPath, { force: true, recursive: true });
  await rm(stateRoot, { force: true, recursive: true });
});

test("landing routes both project sources into one intake workspace", async ({
  page,
}) => {
  await page.goto("/");

  await page.getByRole("button", { name: "Open Local Project" }).click();
  await expect(page).toHaveURL(/\/projects\?source=local$/);
  await expect(
    page.getByRole("heading", { name: "Connect a local project" }),
  ).toBeVisible();

  await page.goto("/");
  await page.getByRole("button", { name: "Import GitHub Repo" }).click();
  await expect(page).toHaveURL(/\/projects\?source=github$/);
  await expect(
    page.getByRole("heading", { name: "Import a GitHub repository" }),
  ).toBeVisible();
});

test("local intake scans a copied fixture and opens its Studio overview", async ({
  page,
}) => {
  await page.goto("/projects?source=local");
  await page.getByLabel("Project folder path").fill(localProjectPath);
  const [intakeResponse] = await Promise.all([
    page.waitForResponse("**/api/projects/local"),
    page.getByRole("button", { name: "Scan project" }).click(),
  ]);
  expect(
    intakeResponse.status(),
    JSON.stringify({
      body: await intakeResponse.text(),
      requestUrl: intakeResponse.request().url(),
    }),
  ).toBe(200);

  const detection = page.getByRole("region", {
    name: "Detected configuration",
  });
  await expect(detection).toBeVisible();
  await expect(detection.getByText("Next.js", { exact: true })).toBeVisible();
  await expect(detection.getByText("pnpm", { exact: true })).toBeVisible();
  await expect(detection.getByText("pnpm dev", { exact: true })).toBeVisible();
  await expect(
    detection.locator("dd").filter({ hasText: /^Ready$/ }),
  ).toBeVisible();
  await expect(
    detection.getByText("Render ready", { exact: true }),
  ).toBeVisible();

  const studioPath = await detection
    .getByRole("link", { name: "Open Studio" })
    .getAttribute("href");
  expect(studioPath).toMatch(/^\/projects\/[a-f0-9-]+\/overview$/);

  const projectId = (studioPath as string).split("/")[2] as string;
  const locatorCookie = (await page.context().cookies()).find(
    (cookie) => cookie.name === "design-sharingan-project",
  );
  expect(locatorCookie).toBeDefined();
  expect(locatorCookie?.httpOnly).toBe(true);
  expect(locatorCookie?.sameSite).toBe("Strict");
  expect(locatorCookie?.path).toBe(`/projects/${projectId}`);
  expect(locatorCookie?.value).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(
    Buffer.from(locatorCookie?.value ?? "", "base64url").toString("utf8"),
  ).not.toContain(localProjectPath);

  const stateRootEntry = await lstat(stateRoot);
  expect(stateRootEntry.isDirectory()).toBe(true);
  expect(stateRootEntry.mode & 0o077).toBe(0);
  const locatorFiles = await readdir(stateRoot);
  expect(locatorFiles).toContain(`${locatorCookie?.value}.json`);
  const locatorPath = join(stateRoot, `${locatorCookie?.value}.json`);
  const locatorEntry = await lstat(locatorPath);
  expect(locatorEntry.isFile()).toBe(true);
  expect(locatorEntry.isSymbolicLink()).toBe(false);
  expect(locatorEntry.mode & 0o077).toBe(0);
  const locatorRecord = await readFile(locatorPath, "utf8");
  expect(locatorRecord).toContain(`\"projectId\":\"${projectId}\"`);
  expect(locatorRecord).toContain(localProjectPath);

  const directPage = await page.context().newPage();
  const directResponse = await directPage.goto(studioPath as string);
  expect(directResponse?.status()).toBe(200);
  await expect(directPage.getByRole("heading", { name: "Overview" })).toBeVisible();
  await expect(
    directPage.locator(".ds-sidebar__project strong"),
  ).toHaveText("next-basic");
  expect(await directPage.evaluate(() => window.sessionStorage.length)).toBe(0);
  expect(await directPage.evaluate(() => document.cookie)).not.toContain(
    "design-sharingan",
  );
  await expect(directPage.locator("body")).not.toContainText(localProjectPath);
  await directPage.close();

  await detection.getByRole("link", { name: "Open Studio" }).click();
  await expect(page).toHaveURL(/\/projects\/[a-f0-9-]+\/overview$/);
  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();

  const unknownResponse = await page.goto(
    "/projects/unknown-project-id/overview",
  );
  expect(unknownResponse?.status()).toBe(404);

  const cookiePath = `/projects/${projectId}`;
  const locator = locatorCookie?.value as string;
  const tamperedLocator = `${locator.slice(0, -1)}${
    locator.endsWith("A") ? "B" : "A"
  }`;
  await page.context().addCookies([
    {
      name: "design-sharingan-project",
      value: tamperedLocator,
      domain: "127.0.0.1",
      path: cookiePath,
      httpOnly: true,
      sameSite: "Strict",
    },
  ]);
  const tamperedResponse = await page.goto(studioPath as string);
  expect(tamperedResponse?.status()).toBe(404);

  await page.context().addCookies([
    {
      name: "design-sharingan-project",
      value: "A".repeat(43),
      domain: "127.0.0.1",
      path: cookiePath,
      httpOnly: true,
      sameSite: "Strict",
    },
  ]);
  const unknownLocatorResponse = await page.goto(studioPath as string);
  expect(unknownLocatorResponse?.status()).toBe(404);
});

test("Studio derives readiness and execution capabilities from a fresh scan", async ({
  page,
}) => {
  await page.goto("/projects?source=local");
  await page.getByLabel("Project folder path").fill(refreshProjectPath);
  await page.getByRole("button", { name: "Scan project" }).click();
  const studioPath = await page
    .getByRole("link", { name: "Open Studio" })
    .getAttribute("href");
  expect(studioPath).not.toBeNull();

  await rm(join(refreshProjectPath, "package.json"));
  const response = await page.goto(studioPath as string);
  expect(response?.status()).toBe(200);
  await expect(
    page.locator(".ds-sidebar__project").getByText("Needs configuration"),
  ).toBeVisible();
  await expect(
    page.locator(".ds-context").getByText("Unknown", { exact: true }),
  ).toBeVisible();
  await expect(
    page.locator(".ds-context").getByText("Runtime unavailable", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.locator(".ds-context").getByText("Render unavailable", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByText("Project configuration required before execution", {
      exact: true,
    }),
  ).toBeVisible();
});

test("intake routes reject untrusted request envelopes before project work", async ({
  request,
}) => {
  const sameOrigin = "http://127.0.0.1:3000";
  const localBody = JSON.stringify({ rootPath: guardedProjectPath });
  const githubBody = JSON.stringify({
    repositoryUrl: "https://github.com/example/project.git",
    branch: "main",
  });

  for (const endpoint of ["local", "github"] as const) {
    const body = endpoint === "local" ? localBody : githubBody;
    const crossOrigin = await request.post(`/api/projects/${endpoint}`, {
      data: body,
      headers: {
        "content-type": "application/json",
        origin: "https://attacker.example",
      },
    });
    expect(crossOrigin.status()).toBe(403);

    const forgedAuthority = await request.post(`/api/projects/${endpoint}`, {
      data: body,
      headers: {
        "content-type": "application/json",
        host: "attacker.example",
        origin: "http://attacker.example",
      },
    });
    expect(forgedAuthority.status()).toBe(403);

    const forwardedAuthority = await request.post(`/api/projects/${endpoint}`, {
      data: body,
      headers: {
        "content-type": "application/json",
        origin: sameOrigin,
        "x-forwarded-host": "attacker.example",
      },
    });
    expect(forwardedAuthority.status()).toBe(403);

    const wrongMedia = await request.post(`/api/projects/${endpoint}`, {
      data: body,
      headers: {
        "content-type": "text/plain",
        origin: sameOrigin,
        referer: `${sameOrigin}/projects`,
      },
    });
    expect(wrongMedia.status()).toBe(415);

    const oversized = await request.post(`/api/projects/${endpoint}`, {
      data: `${body}${" ".repeat(20_000)}`,
      headers: {
        "content-type": "application/json",
        origin: sameOrigin,
        referer: `${sameOrigin}/projects`,
      },
    });
    expect(oversized.status()).toBe(413);
  }

  await expect(
    lstat(join(guardedProjectPath, ".design-sharingan")),
  ).rejects.toMatchObject({ code: "ENOENT" });
  await expect(
    lstat("/private/tmp/design-sharingan-studio-e2e-imports"),
  ).rejects.toMatchObject({ code: "ENOENT" });

  const parameterizedJson = await request.post("/api/projects/local", {
    data: localBody,
    headers: {
      "content-type": "application/json; charset=utf-8",
      origin: sameOrigin,
      referer: `${sameOrigin}/projects`,
    },
  });
  expect(parameterizedJson.status()).toBe(200);
});

test("intake guard rejects malformed authority and bounds a chunked body", async () => {
  const headers = {
    "content-type": "application/json",
    host: "localhost:3000, attacker.example",
    origin: "http://localhost:3000",
  };
  const malformedAuthority = await readIntakeJson(
    new Request("http://localhost:3000/api/projects/local", {
      method: "POST",
      headers,
      body: JSON.stringify({ rootPath: guardedProjectPath }),
    }),
  );
  expect(malformedAuthority.ok).toBe(false);
  if (!malformedAuthority.ok) {
    expect(malformedAuthority.response.status).toBe(403);
  }

  const nonLoopbackAuthority = await readIntakeJson(
    new Request("http://workspace.example/api/projects/local", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        host: "workspace.example",
        origin: "http://workspace.example",
      },
      body: JSON.stringify({ rootPath: guardedProjectPath }),
    }),
  );
  expect(nonLoopbackAuthority.ok).toBe(false);
  if (!nonLoopbackAuthority.ok) {
    expect(nonLoopbackAuthority.response.status).toBe(403);
  }

  const forwardedAuthority = await readIntakeJson(
    new Request("http://localhost:3000/api/projects/local", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        host: "localhost:3000",
        origin: "http://localhost:3000",
        forwarded: "host=attacker.example;proto=https",
      },
      body: JSON.stringify({ rootPath: guardedProjectPath }),
    }),
  );
  expect(forwardedAuthority.ok).toBe(false);
  if (!forwardedAuthority.ok) {
    expect(forwardedAuthority.response.status).toBe(403);
  }

  const refererFallback = await readIntakeJson(
    new Request("http://localhost:3000/api/projects/local", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        host: "localhost:3000",
        referer: "http://localhost:3000/projects?source=local",
      },
      body: JSON.stringify({ rootPath: guardedProjectPath }),
    }),
  );
  expect(refererFallback.ok).toBe(true);

  const credentialedReferer = await readIntakeJson(
    new Request("http://localhost:3000/api/projects/local", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        host: "localhost:3000",
        referer: "http://attacker@localhost:3000/projects",
      },
      body: JSON.stringify({ rootPath: guardedProjectPath }),
    }),
  );
  expect(credentialedReferer.ok).toBe(false);
  if (!credentialedReferer.ok) {
    expect(credentialedReferer.response.status).toBe(403);
  }

  const chunk = new TextEncoder().encode("x".repeat(4096));
  let emitted = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (emitted === 5) {
        controller.close();
        return;
      }
      emitted += 1;
      controller.enqueue(chunk);
    },
  });
  const streamedRequest = new Request(
    "http://localhost:3000/api/projects/local",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        host: "localhost:3000",
        origin: "http://localhost:3000",
      },
      body,
      duplex: "half",
    } as RequestInit & { duplex: "half" },
  );
  expect(streamedRequest.headers.has("content-length")).toBe(false);
  const streamedResult = await readIntakeJson(streamedRequest);
  expect(streamedResult.ok).toBe(false);
  if (!streamedResult.ok) {
    expect(streamedResult.response.status).toBe(413);
  }
});

test("GitHub intake keeps authentication explicitly ephemeral", async ({
  page,
}) => {
  await page.route("**/api/projects/github", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        project: {
          id: "github-intake-fixture",
          name: "github-fixture",
          sourceType: "GITHUB",
          status: "READY",
          framework: "nextjs",
          packageManager: "pnpm",
          devCommand: "pnpm dev",
          capabilities: {
            canReadFiles: true,
            canWriteFiles: true,
            canRun: true,
            canRender: true,
            canCapture: true,
            canUseGit: true,
            canAudit: true,
          },
        },
      }),
    });
  });
  await page.goto("/projects?source=github");

  await expect(page.getByLabel("Repository URL")).toBeVisible();
  await expect(page.getByLabel("Branch")).toHaveValue("main");
  const token = page.getByLabel("Personal access token (optional)");
  await expect(token).toHaveAttribute("type", "password");
  await expect(token).toHaveAttribute("autocomplete", "off");
  await expect(
    page.getByText("Used only for this clone and never returned to the browser."),
  ).toBeVisible();

  await page
    .getByLabel("Repository URL")
    .fill("https://github.com/example/project.git");
  await token.fill("ghp_not_a_real_token");
  await page.getByRole("button", { name: "Import repository" }).click();
  await expect(
    page.getByRole("region", { name: "Detected configuration" }),
  ).toBeVisible();
  await expect(token).toHaveValue("");
  await expect(page.getByText("ghp_not_a_real_token")).toHaveCount(0);
});

test("GitHub intake clears authentication before a failed request settles", async ({
  page,
}) => {
  const secret = "ghp_failure_secret";
  await page.route("**/api/projects/github", async (route) => {
    await route.fulfill({
      status: 422,
      contentType: "application/json",
      body: JSON.stringify({ error: `Clone rejected ${secret}` }),
    });
  });
  await page.goto("/projects?source=github");
  await page
    .getByLabel("Repository URL")
    .fill("https://github.com/example/project.git");
  const token = page.getByLabel("Personal access token (optional)");
  await token.fill(secret);
  await page.getByRole("button", { name: "Import repository" }).click();

  await expect(token).toHaveValue("");
  await expect(page.locator(".form-error")).toBeVisible();
  await expect(page.locator("body")).not.toContainText(secret);
});

test("foundation controls expose only available behavior with complete semantics", async ({
  page,
}) => {
  await page.goto("/projects?source=local");
  const localSource = page.getByRole("button", { name: "Local folder" });
  const githubSource = page.getByRole("button", {
    name: "GitHub repository",
  });
  await expect(localSource).toHaveAttribute("aria-pressed", "true");
  await githubSource.click();
  await expect(githubSource).toHaveAttribute("aria-pressed", "true");

  const contrast = await page.locator(".project-intake__back").evaluate((node) => {
    const parse = (value: string) =>
      value.match(/[\d.]+/g)?.slice(0, 3).map(Number) ?? [0, 0, 0];
    const luminance = (rgb: number[]) => {
      const channels = rgb.map((value) => {
        const normalized = value / 255;
        return normalized <= 0.04045
          ? normalized / 12.92
          : ((normalized + 0.055) / 1.055) ** 2.4;
      });
      return (
        0.2126 * (channels[0] ?? 0) +
        0.7152 * (channels[1] ?? 0) +
        0.0722 * (channels[2] ?? 0)
      );
    };
    const foreground = luminance(parse(getComputedStyle(node).color));
    const background = luminance(
      parse(getComputedStyle(node.parentElement as Element).backgroundColor),
    );
    return (Math.max(foreground, background) + 0.05) /
      (Math.min(foreground, background) + 0.05);
  });
  expect(contrast).toBeGreaterThanOrEqual(4.5);

  await localSource.click();
  await page.getByLabel("Project folder path").fill(localProjectPath);
  await page.getByRole("button", { name: "Scan project" }).click();
  const studioPath = await page
    .getByRole("link", { name: "Open Studio" })
    .getAttribute("href");
  await page.goto((studioPath as string).replace(/\/overview$/, "/execute"));

  await expect(page.getByRole("button", { name: "Safe" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  const mangekyo = page.getByRole("button", { name: "Mangekyō" });
  await expect(mangekyo).toBeDisabled();
  await expect(
    page.getByText(/Mangekyō becomes available after its policy engine/i),
  ).toBeVisible();

  const agentChannel = page.getByRole("button", { name: "AGENT" });
  await agentChannel.click();
  await expect(agentChannel).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByText("AGENT channel ready", { exact: true })).toBeVisible();
});
